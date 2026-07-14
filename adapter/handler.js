import { parseCommand } from "./commands.js";
import { formatErrorForUser, permissionDenied } from "./errors.js";
import { checkPermission } from "./permissions.js";
import { resolveProjectId, targetKeyFromMessage } from "./router.js";
import { checkWriteGate, releaseActiveWriter, reserveActiveWriter } from "./write-gate.js";
import { loadState, saveState } from "./state-store.js";

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

async function persistTask(statePath, taskId, record) {
  const state = await loadState(statePath);
  state.tasks[taskId] = {
    ...record,
    taskId
  };
  await saveState(statePath, state);
}

export async function handleMessage(message, context) {
  const command = parseCommand(message.text);
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
    const projects = await context.client.projects();
    const exists = (projects.projects ?? []).some((project) => project.projectId === command.projectId);
    if (!exists) return replyText(`找不到项目 ${command.projectId}。`, targetKey);
    state.bindings[targetKey] = command.projectId;
    await saveState(context.statePath, state);
    return replyText(`已绑定到 ${command.projectId}。`, targetKey);
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

  const projectId = resolveProjectId({ command, message, config: context.config, state });
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
    await persistTask(context.statePath, task.taskId, record);

    if (command.verb === "run") {
      const nextState = await loadState(context.statePath);
      reserveActiveWriter(nextState, projectId, task.taskId, { userId: message.user?.id ?? null });
      await saveState(context.statePath, nextState);
    }

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
