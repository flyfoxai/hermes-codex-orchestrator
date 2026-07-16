import { parseCommand } from "./commands.js";
import { formatErrorForUser, permissionDenied } from "./errors.js";
import { checkPermission } from "./permissions.js";
import { normalizeZulipStreamName, resolveProjectId, targetKeyFromMessage } from "./router.js";
import { applySemanticControl } from "./semantic-control.js";
import { checkWriteGate, releaseActiveWriter, reserveActiveWriter } from "./write-gate.js";
import { loadState, saveState } from "./state-store.js";
import { bindTopicTask, clearTopicModesForStream, getTopicMode, TOPIC_MODES } from "./topic-mode.js";

function replyText(text, targetKey) {
  return [{ targetKey, text }];
}

function taskRecordFromMessage(message, command, projectId) {
  return {
    targetKey: targetKeyFromMessage(message),
    source: message.platform,
    userId: message.user?.id ?? null,
    projectId,
    requestedByUserId: message.user?.id ?? null,
    requestedBySource: message.platform,
    requestedByMessageId: message.messageId ?? null,
    allowCodeChanges: command.verb === "run",
    pollState: "polling",
    createdAt: message.receivedAt,
    updatedAt: message.receivedAt,
    taskId: null
  };
}

async function persistTask(statePath, taskId, record, { message, projectId, command, now }) {
  const state = await loadState(statePath);
  state.tasks[taskId] = {
    ...record,
    taskId
  };
  if (message.platform === "zulip") {
    bindTopicTask(state, {
      message,
      projectId,
      taskId,
      actor: {
        userId: message.user?.id ?? null,
        source: message.platform,
        messageId: message.messageId ?? null
      },
      now
    });
  }
  if (command.verb === "run") {
    reserveActiveWriter(state, projectId, taskId, { userId: message.user?.id ?? null });
  }
  await saveState(statePath, state);
}

function projectsFromResult(result) {
  return result?.projects ?? [];
}

function projectExists(projects, projectId) {
  return projects.some((project) => project.projectId === projectId);
}

function formatHermesOwnedStream(error) {
  const stream = error.details?.stream ?? "当前频道";
  return `Zulip 频道“${stream}”没有 projectId，由 Hermes 直接管理，不会创建 Codex Runner 任务。如需改为项目频道，请由 maintainer 使用 /codex route set <projectId>。`;
}

function formatProjectMismatch(error) {
  return `请求的 projectId=${error.details?.requestedProjectId} 与当前频道绑定的 projectId=${error.details?.mappedProjectId} 不匹配，不能临时跨项目。请先由 maintainer 修改频道映射。`;
}

async function handleRouteCommand(command, message, context, state, targetKey) {
  if (message.platform !== "zulip") {
    return replyText("route 命令仅用于 Zulip 频道到 projectId 的映射；飞书/Hermes 请使用 /codex bind <projectId>。", targetKey);
  }

  const stream = normalizeZulipStreamName(message.stream);
  if (command.action === "show") {
    if (state.zulipGenericStreams?.[stream]) {
      return replyText(`当前 Zulip 频道“${stream}”已标记为通用对话，不关联项目。`, targetKey);
    }
    const runtimeProjectId = state.zulipStreamProjectRoutes?.[stream];
    const configuredProjectId = context.config.zulipStreamProjectRoutes?.[stream];
    const projectId = runtimeProjectId ?? configuredProjectId;
    return replyText(projectId ? `当前 Zulip 频道“${stream}”关联到 projectId=${projectId}。` : `当前 Zulip 频道“${stream}”尚未关联项目。`, targetKey);
  }

  if (command.action === "unset") {
    clearTopicModesForStream(state, stream);
    delete state.zulipStreamProjectRoutes[stream];
    delete state.zulipGenericStreams[stream];
    await saveState(context.statePath, state);
    return replyText(`已清除 Zulip 频道“${stream}”的运行时路由设置。`, targetKey);
  }

  if (command.action === "none") {
    clearTopicModesForStream(state, stream);
    delete state.zulipStreamProjectRoutes[stream];
    state.zulipGenericStreams[stream] = true;
    await saveState(context.statePath, state);
    return replyText(`已将 Zulip 频道“${stream}”标记为通用对话/不关联项目。`, targetKey);
  }

  const projects = projectsFromResult(await context.client.projects());
  if (!projectExists(projects, command.projectId)) {
    return replyText(`找不到项目 ${command.projectId}。请先用 /codex projects 查看已注册项目。`, targetKey);
  }

  clearTopicModesForStream(state, stream);
  state.zulipStreamProjectRoutes[stream] = command.projectId;
  delete state.zulipGenericStreams[stream];
  await saveState(context.statePath, state);
  return replyText(`已将 Zulip 频道“${stream}”关联到 projectId=${command.projectId}。`, targetKey);
}

async function handleTopicCommand(command, message, context, state, targetKey) {
  if (message.platform !== "zulip") {
    return replyText("topic 命令仅用于 Zulip 项目频道的当前话题。", targetKey);
  }

  let projectId;
  try {
    projectId = resolveProjectId({ command: {}, message, config: context.config, state });
  } catch (error) {
    if (error.code === "route_hermes_owned") return replyText(formatHermesOwnedStream(error), targetKey);
    throw error;
  }

  const permission = checkPermission({ command, user: message.user });
  if (!permission.allowed) {
    return replyText(formatErrorForUser(permissionDenied(permission.reason)), targetKey);
  }
  if (command.action === "show") {
    const mode = getTopicMode(state, { message, projectId });
    return replyText(`当前话题模式为 ${mode}，projectId=${projectId}。`, targetKey);
  }

  const control = {
    type: "CONTROL",
    action: "SET_TOPIC_MODE",
    mode: command.action === "auto" ? TOPIC_MODES.AUTO : TOPIC_MODES.HERMES_ONLY
  };
  const result = await applySemanticControl({
    control,
    message,
    config: context.config,
    statePath: context.statePath,
    now: context.now
  });
  return replyText(result.text, targetKey);
}

export async function handleMessage(message, context) {
  const command = parseCommand(message.text, { inferProjectForRun: message.platform === "zulip" });
  if (!command) return [];

  const state = await loadState(context.statePath);
  const targetKey = targetKeyFromMessage(message);

  if (command.verb === "projects") {
    const projects = await context.client.projects();
    const lines = (projects.projects ?? []).map((project) => `- ${project.projectId}${project.name ? ` (${project.name})` : ""}`);
    return replyText(lines.join("\n") || "暂无项目。", targetKey);
  }

  if (command.verb === "sessions") {
    const sessions = await context.client.sessions();
    const lines = (sessions.sessions ?? []).map(
      (session) => `- ${session.projectId}: ${session.tmuxSession ?? "unknown"}${session.exists ? " (exists)" : ""}`
    );
    return replyText(lines.join("\n") || "暂无 session。", targetKey);
  }

  if (command.verb === "bind") {
    if (message.platform === "zulip") {
      return replyText("Zulip 消息使用频道映射项目、话题作为会话目标；无需在话题里 bind。跨项目工作必须先由 maintainer 修改频道映射。", targetKey);
    }
    const projects = await context.client.projects();
    const exists = (projects.projects ?? []).some((project) => project.projectId === command.projectId);
    if (!exists) return replyText(`找不到项目 ${command.projectId}。`, targetKey);
    state.bindings[targetKey] = command.projectId;
    await saveState(context.statePath, state);
    return replyText(`已绑定到 ${command.projectId}。`, targetKey);
  }

  if (command.verb === "route") {
    const routePermission = checkPermission({ command, user: message.user });
    if (!routePermission.allowed) {
      return replyText(formatErrorForUser(permissionDenied(routePermission.reason)), targetKey);
    }
    return handleRouteCommand(command, message, context, state, targetKey);
  }

  if (command.verb === "topic") {
    return handleTopicCommand(command, message, context, state, targetKey);
  }

  if (command.verb === "cancel") {
    const taskRecord = state.tasks[command.taskId];
    const cancelPermission = checkPermission({ command, user: message.user, taskRecord });
    if (!cancelPermission.allowed) {
      return replyText(formatErrorForUser(permissionDenied(cancelPermission.reason)), targetKey);
    }
    const result = await context.client.cancel(command.taskId, {});
    if (taskRecord?.projectId) {
      const nextState = await loadState(context.statePath);
      releaseActiveWriter(nextState, taskRecord.projectId, command.taskId);
      await saveState(context.statePath, nextState);
    }
    return replyText(`任务 ${result.taskId} cancelled.`, targetKey);
  }

  let projectId;
  try {
    projectId = resolveProjectId({ command, message, config: context.config, state });
  } catch (error) {
    if (error.code === "route_hermes_owned") return replyText(formatHermesOwnedStream(error), targetKey);
    if (error.code === "route_project_mismatch") return replyText(formatProjectMismatch(error), targetKey);
    throw error;
  }

  let projects;
  if (command.verb === "ask" || command.verb === "run") {
    if (message.platform === "zulip" && getTopicMode(state, { message, projectId }) === TOPIC_MODES.HERMES_ONLY) {
      return replyText("当前话题模式为 HERMES_ONLY，不会派发 Codex。使用 /codex topic auto 可恢复自动派发。", targetKey);
    }
    projects = projectsFromResult(await context.client.projects());
    const knownProjects = projects ?? [];
    if (knownProjects.length === 0) {
      return replyText("当前无法验证项目列表，暂时不能创建任务。", targetKey);
    }
    if (!knownProjects.some((project) => project?.projectId === projectId)) {
      return replyText(`找不到项目 ${projectId}。请先用 /codex projects 查看已注册项目。`, targetKey);
    }
  }

  const permission = checkPermission({ command, user: message.user });
  if (!permission.allowed) {
    return replyText(formatErrorForUser(permissionDenied(permission.reason)), targetKey);
  }

  if (command.verb === "ask" || command.verb === "run") {
    if (command.verb === "run") {
      const gate = checkWriteGate(state, projectId);
      if (gate.blocked) {
        return replyText(`当前项目已有活跃写任务 ${gate.activeTaskId}。`, targetKey);
      }
    }

    const record = taskRecordFromMessage(message, command, projectId);
    const body = {
      projectId,
      goal: command.goal,
      constraints: [],
      acceptanceCriteria: [],
      allowCodeChanges: command.verb === "run",
      allowNetwork: false,
      dispatch: true,
      requestedBy: {
        source: message.platform,
        userId: message.user?.id ?? null,
        stream: message.stream ?? null,
        topic: message.topic ?? null,
        conversationId: message.conversationId ?? null,
        messageId: message.messageId ?? null
      }
    };

    const task = await context.client.createTask(body);
    record.taskId = task.taskId;
    record.updatedAt = context.now?.() ?? new Date().toISOString();
    await persistTask(context.statePath, task.taskId, record, {
      message,
      projectId,
      command,
      now: context.now
    });

    if (context.poller?.pollTask) {
      queueMicrotask(() => {
        context.poller.pollTask(task.taskId).catch(() => {});
      });
    }

    return replyText(`已创建任务 ${task.taskId}。`, targetKey);
  }

  if (command.verb === "status") {
    const task = await context.client.getTask(command.taskId);
    return replyText(`任务 ${task.taskId}: ${task.status}`, targetKey);
  }

  if (command.verb === "logs") {
    const result = await context.client.getLogs(command.taskId, { limit: 20 });
    const last = result.logs?.[result.logs.length - 1];
    return replyText(`任务 ${command.taskId} 日志: ${last?.message ?? "无日志"}`, targetKey);
  }

  if (command.verb === "raw") {
    const raw = await context.client.getRaw(command.taskId);
    return replyText(String(raw.content ?? ""), targetKey);
  }

  if (command.verb === "dispatch") {
    const result = await context.client.dispatch(command.taskId);
    return replyText(`任务 ${result.taskId} queued.`, targetKey);
  }

  return replyText("未处理的命令。", targetKey);
}
