import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createAcl } from "./acl.js";
import { verifyContext } from "./contracts/envelope.js";
import { createRouteResolver, publishRouteSnapshot } from "./routes.js";

const MAX_INSTRUCTION_BYTES = 16 * 1024;
const MAX_LIST_ENTRY_BYTES = 2 * 1024;
const MAX_SEMANTIC_BYTES = 32 * 1024;
const RETRY_DELAY_MS = 1_000;
const APP_SERVER_REVERSE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = (2n ** 63n) - 1n;

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field));
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedText(value, maximum = MAX_INSTRUCTION_BYTES) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function appServerRequestId(value) {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "bigint" && value >= MIN_INT64 && value <= MAX_INT64);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateBinding(binding) {
  return exact(binding, ["streamId", "topic", "sourceMessageId", "senderId"]) &&
    positive(binding.streamId) && typeof binding.topic === "string" && binding.topic.length > 0 &&
    Buffer.byteLength(binding.topic, "utf8") <= 256 && positive(binding.sourceMessageId) && positive(binding.senderId);
}

function invalidBridge() {
  throw serviceError("BRIDGE_EVENT_INVALID", "Bridge event is invalid.");
}

function invalidModel() {
  throw serviceError("MODEL_PROTOCOL_ERROR", "Model protocol payload is invalid.");
}

function validateCommand(command) {
  if (!isPlainObject(command) || typeof command.type !== "string") invalidBridge();
  switch (command.type) {
    case "RUN":
      if (!exact(command, ["type", "instruction"]) || !boundedText(command.instruction)) invalidBridge();
      break;
    case "STATUS":
    case "CANCEL":
      if (!exact(command, ["type"], ["objectiveId"]) ||
          (command.objectiveId !== undefined && !boundedText(command.objectiveId, 512))) invalidBridge();
      break;
    case "TOPIC":
      if (!exact(command, ["type", "action"]) || !["SHOW", "AUTO", "HERMES"].includes(command.action)) invalidBridge();
      break;
    case "ROUTE":
      if (!exact(command, ["type", "action"], ["projectId"]) || !["SHOW", "SET", "NONE", "UNSET"].includes(command.action) ||
          (command.action === "SET" ? !boundedText(command.projectId, 64) : command.projectId !== undefined)) invalidBridge();
      break;
    case "OBJECTIVE_NEW":
      if (!exact(command, ["type", "instruction"]) || !boundedText(command.instruction)) invalidBridge();
      break;
    case "OBJECTIVE_CONTINUE":
      if (!exact(command, ["type", "objectiveId", "instruction"]) || !boundedText(command.objectiveId, 512) ||
          !boundedText(command.instruction)) invalidBridge();
      break;
    case "APPROVE":
      if (!exact(command, ["type", "replyToken", "choice"]) || !boundedText(command.replyToken, 512) ||
          !boundedText(command.choice, 4096)) invalidBridge();
      break;
    case "ANSWER":
      if (!exact(command, ["type", "replyToken", "text"]) || !boundedText(command.replyToken, 512) ||
          !boundedText(command.text, MAX_INSTRUCTION_BYTES)) invalidBridge();
      break;
    default:
      invalidBridge();
  }
  return command;
}

function validateList(value, maximumEntries) {
  return Array.isArray(value) && value.length <= maximumEntries &&
    Object.keys(value).length === value.length &&
    value.every((entry) => boundedText(entry, MAX_LIST_ENTRY_BYTES));
}

function validateSemantic(semantic) {
  if (!isPlainObject(semantic) || typeof semantic.type !== "string") invalidModel();
  if (Buffer.byteLength(JSON.stringify(semantic), "utf8") > MAX_SEMANTIC_BYTES) invalidModel();
  if (semantic.type === "CONTROL") {
    if (!exact(semantic, ["type", "action", "mode"]) || semantic.action !== "SET_TOPIC_MODE" ||
        !["AUTO", "HERMES_ONLY"].includes(semantic.mode)) invalidModel();
    return semantic;
  }
  if (semantic.type !== "DISPATCH" ||
      !exact(semantic, ["type", "instruction", "constraints", "acceptanceCriteria", "reminders", "objective", "topicModeAction"]) ||
      !boundedText(semantic.instruction) || !validateList(semantic.constraints, 16) ||
      !validateList(semantic.acceptanceCriteria, 16) || !validateList(semantic.reminders, 8) ||
      ![null, "AUTO"].includes(semantic.topicModeAction)) invalidModel();
  if (semantic.objective !== null &&
      (!isPlainObject(semantic.objective) ||
       (semantic.objective.mode === "NEW"
         ? !exact(semantic.objective, ["mode"])
         : !exact(semantic.objective, ["mode", "objectiveId"]) || semantic.objective.mode !== "CONTINUE" ||
           !boundedText(semantic.objective.objectiveId, 512)))) invalidModel();
  return semantic;
}

function composeSemanticInput(semantic) {
  const sections = [["Instruction", [semantic.instruction]]];
  if (semantic.constraints.length > 0) sections.push(["Constraints", semantic.constraints]);
  if (semantic.acceptanceCriteria.length > 0) sections.push(["Acceptance criteria", semantic.acceptanceCriteria]);
  if (semantic.reminders.length > 0) sections.push(["Reminders", semantic.reminders]);
  return sections.map(([title, entries], index) =>
    index === 0 ? `${title}:\n${entries[0]}` : `${title}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`
  ).join("\n\n");
}

function publicDispatch(projectId, result) {
  const output = {
    schemaVersion: 1,
    status: result.status === "started" ? "accepted" : result.status,
    action: "dispatch",
    projectId,
    objectiveId: result.objectiveId
  };
  for (const field of ["submissionId", "clientUserMessageId", "threadId", "turnId", "duplicate"]) {
    if (result[field] !== undefined) output[field] = result[field];
  }
  return deepFreeze(output);
}

export function createHcoService({
  config,
  store,
  turnController,
  contextKey,
  now = Date.now,
  idFactory = () => randomUUID(),
  snapshotPublisher = publishRouteSnapshot
} = {}) {
  const storeMethods = [
    "consume", "getRuntimeRoute", "listRuntimeRoutes", "applyRouteCommand", "readTopicState",
    "setUserTopicMode", "listSnapshotTopicModes", "readObjectiveProject", "readCurrentTopicObjective",
    "readControlGeneration", "syncStaticRegistry", "readObjectiveExecution", "readInteraction",
    "readAppServerTurnContext"
  ];
  const controllerMethods = [
    "acceptIntent", "continueObjective", "cancelObjective", "answerInteraction",
    "handleInteractionRequest", "handleTurnCompleted"
  ];
  if (!isPlainObject(config) || !Array.isArray(config.projects) || !Array.isArray(config.admins) ||
      !isPlainObject(config.bridge) || !isPlainObject(config.snapshot) ||
      !storeMethods.every((method) => typeof store?.[method] === "function") ||
      !controllerMethods.every((method) => typeof turnController?.[method] === "function") ||
      !(Buffer.isBuffer(contextKey) || contextKey instanceof Uint8Array || typeof contextKey === "string") ||
      typeof now !== "function" || typeof idFactory !== "function" || typeof snapshotPublisher !== "function") {
    throw serviceError("HCO_SERVICE_OPTIONS_INVALID", "HCO service options are invalid.");
  }

  const projects = config.projects.map((project) => deepFreeze({
    projectId: project.projectId,
    cwd: project.cwd,
    backend: project.backend,
    staticStreamIds: [...project.staticStreamIds],
    acl: {
      viewers: [...project.acl.viewers], contributors: [...project.acl.contributors], maintainers: [...project.acl.maintainers]
    },
    threadOptions: { ...project.threadOptions }
  }));
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const acl = createAcl({ admins: [...config.admins], projects });
  const signingKey = typeof contextKey === "string" ? contextKey : Buffer.from(contextKey);
  const snapshotOptions = {
    snapshotPath: config.bridge.routeSnapshotPath,
    ttlMs: config.snapshot.ttlMs,
    maxBytes: config.snapshot.maxBytes
  };
  let controlQueue = Promise.resolve();
  const activeOperations = new Set();
  let closePromise = null;
  let retryTimer = null;
  let closed = false;
  let dirty = true;
  let publishedGeneration = -1;
  let lastPublishedElapsedMs = null;
  const snapshotRenewAfterMs = config.snapshot.ttlMs - Math.max(RETRY_DELAY_MS, Math.floor(config.snapshot.ttlMs / 5));

  function resolver() {
    return createRouteResolver({ projects, runtimeRoutes: store.listRuntimeRoutes() });
  }

  function resolveRoute(streamId) {
    return resolver().resolve(streamId);
  }

  function readTopic({ streamId, topic } = {}) {
    return store.readTopicState({ streamId, topic });
  }

  function enqueue(operation) {
    const result = controlQueue.then(operation, operation);
    controlQueue = result.catch(() => {});
    return result;
  }

  function requireOpen() {
    if (closed) throw serviceError("HCO_SERVICE_CLOSED", "HCO service is closed.");
  }

  function track(operation) {
    const active = Promise.resolve(operation);
    activeOperations.add(active);
    active.then(
      () => activeOperations.delete(active),
      () => activeOperations.delete(active)
    );
    return active;
  }

  async function publishCurrentSnapshot() {
    const generation = store.readControlGeneration().generation;
    const streamIds = new Set(store.listRuntimeRoutes().map((row) => row.streamId));
    for (const project of projects) for (const streamId of project.staticStreamIds) streamIds.add(streamId);
    const routes = [...streamIds].map((streamId) => resolveRoute(streamId));
    try {
      const published = await snapshotPublisher({
        ...snapshotOptions,
        generation,
        routes,
        topicModes: store.listSnapshotTopicModes(),
        now
      });
      publishedGeneration = generation;
      lastPublishedElapsedMs = performance.now();
      dirty = store.readControlGeneration().generation !== generation;
      return published;
    } catch {
      dirty = true;
      throw serviceError("ROUTE_SNAPSHOT_PUBLISH_FAILED", "Route snapshot publication failed.");
    }
  }

  function publishSnapshot() {
    try {
      requireOpen();
      return track(enqueue(publishCurrentSnapshot));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function publishIfGenerationChanged(previousGeneration) {
    const current = store.readControlGeneration().generation;
    if (current !== previousGeneration || current !== publishedGeneration || dirty) await publishCurrentSnapshot();
  }

  function requireProjectRoute(binding) {
    const route = resolveRoute(binding.streamId);
    if (route.owner !== "PROJECT") throw serviceError("ROUTE_HERMES_OWNED", "Numeric stream is Hermes-owned.");
    const project = projectById.get(route.projectId);
    if (!project) throw serviceError("PROJECT_NOT_FOUND", "Project does not exist.");
    return { route, project };
  }

  function requireObjectiveProject(objectiveId, projectId) {
    const ownedProjectId = store.readObjectiveProject(objectiveId);
    if (ownedProjectId === null) throw serviceError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (ownedProjectId !== projectId) throw serviceError("OBJECTIVE_PROJECT_MISMATCH", "Objective belongs to another project.");
  }

  function executionOptions({ binding, project, objectiveId, text }) {
    return {
      sourceType: "zulip-message",
      sourceId: String(binding.sourceMessageId),
      objectiveId,
      projectId: project.projectId,
      backend: project.backend,
      text,
      targetSnapshot: {
        platform: "zulip", streamId: binding.streamId, topic: binding.topic, sourceMessageId: binding.sourceMessageId
      },
      threadOptions: { ...project.threadOptions, cwd: project.cwd },
      topicBinding: { streamId: binding.streamId, topic: binding.topic, actorUserId: binding.senderId }
    };
  }

  async function dispatch({ binding, text, selection, allowTopicAuto = false }) {
    let beforeGeneration;
    let project;
    let resultPromise;
    await enqueue(() => {
      ({ project } = requireProjectRoute(binding));
      const topic = readTopic({ streamId: binding.streamId, topic: binding.topic });
      let objectiveId;
      let continuing = false;
      if (selection?.mode === "CONTINUE") {
        objectiveId = selection.objectiveId;
        requireObjectiveProject(objectiveId, project.projectId);
        continuing = true;
      } else if (selection?.mode === "NEW") {
        objectiveId = idFactory("objective");
      } else {
        objectiveId = store.readCurrentTopicObjective({
          streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
        });
        continuing = objectiveId !== null;
        if (!objectiveId) objectiveId = idFactory("objective");
      }
      const permission = continuing ? "objective.continue" : "objective.create";
      acl.require({ userId: binding.senderId, projectId: project.projectId, permission });
      if (topic.mode === "HERMES_ONLY" && !allowTopicAuto) {
        throw serviceError("TOPIC_HERMES_ONLY", "Topic is Hermes-only.");
      }
      if (allowTopicAuto) {
        acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "topic.manage" });
      }

      beforeGeneration = store.readControlGeneration().generation;
      const options = executionOptions({ binding, project, objectiveId, text });
      if (allowTopicAuto) options.topicModeAction = "AUTO";
      resultPromise = continuing
        ? turnController.continueObjective(options)
        : turnController.acceptIntent(options);
    });
    const result = await resultPromise;
    await enqueue(() => publishIfGenerationChanged(beforeGeneration));
    return publicDispatch(project.projectId, result);
  }

  async function routeCommand(command, binding) {
    if (command.action === "SHOW") {
      const route = resolveRoute(binding.streamId);
      if (route.owner === "PROJECT") {
        acl.require({ userId: binding.senderId, projectId: route.projectId, permission: "project.read" });
      }
      return deepFreeze({ schemaVersion: 1, status: "ok", action: "route.show", route });
    }
    return enqueue(async () => {
      const before = resolveRoute(binding.streamId);
      const target = command.action === "SET" ? projectById.get(command.projectId) : null;
      const fallback = command.action === "UNSET" ? createRouteResolver({
        projects,
        runtimeRoutes: store.listRuntimeRoutes().filter((row) => row.streamId !== binding.streamId)
      }).resolve(binding.streamId) : null;
      if (command.action === "SET" && !target) throw serviceError("PROJECT_NOT_FOUND", "Project does not exist.");
      if (before.owner === "PROJECT") {
        acl.require({ userId: binding.senderId, projectId: before.projectId, permission: "route.manage" });
      }
      if (target && target.projectId !== before.projectId) {
        acl.require({ userId: binding.senderId, projectId: target.projectId, permission: "route.manage" });
      }
      if (command.action === "UNSET") {
        if (fallback.owner === "PROJECT" && fallback.projectId !== before.projectId) {
          acl.require({ userId: binding.senderId, projectId: fallback.projectId, permission: "route.manage" });
        }
      }
      if (before.owner === "HERMES" && !target && fallback?.owner !== "PROJECT") {
        acl.require({ userId: binding.senderId, projectId: null, permission: "route.manage" });
      }
      const clearTopics = command.action !== "UNSET" || before.owner !== fallback.owner || before.projectId !== fallback.projectId;
      const mutation = store.applyRouteCommand({
        sourceType: "zulip-message", sourceId: String(binding.sourceMessageId), streamId: binding.streamId,
        action: command.action, ...(target ? { projectId: target.projectId } : {}), actorUserId: binding.senderId,
        clearTopics
      });
      if (mutation.changed) await publishCurrentSnapshot();
      const route = resolveRoute(binding.streamId);
      const output = {
        schemaVersion: 1, status: "ok", action: `route.${command.action.toLowerCase()}`, route,
        ...(mutation.duplicate ? { duplicate: true } : {})
      };
      return deepFreeze(output);
    });
  }

  async function topicCommand(command, binding, semantic = false) {
    const { project } = requireProjectRoute(binding);
    if (command.action === "SHOW") {
      acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "topic.read" });
      const topic = readTopic({ streamId: binding.streamId, topic: binding.topic });
      return deepFreeze({
        schemaVersion: 1, status: "ok", action: "topic.show", projectId: project.projectId,
        mode: topic.mode, objectiveId: topic.objectiveId
      });
    }
    return enqueue(async () => {
      acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "topic.manage" });
      const mode = command.action === "AUTO" ? "AUTO" : "HERMES_ONLY";
      const mutation = store.setUserTopicMode({
        sourceType: "zulip-message", sourceId: String(binding.sourceMessageId), streamId: binding.streamId,
        topic: binding.topic, projectId: project.projectId, mode, actorUserId: binding.senderId
      });
      if (mutation.changed) await publishCurrentSnapshot();
      return deepFreeze({
        schemaVersion: 1, status: "ok", action: "topic.set", mode,
        ...(mutation.duplicate ? { duplicate: true } : {})
      });
    });
  }

  async function statusCommand(command, binding) {
    const { project } = requireProjectRoute(binding);
    const objectiveId = command.objectiveId ?? store.readCurrentTopicObjective({
      streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
    });
    if (!objectiveId) throw serviceError("OBJECTIVE_REQUIRED", "An objective is required.");
    requireObjectiveProject(objectiveId, project.projectId);
    acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "objective.status" });
    const execution = store.readObjectiveExecution(objectiveId);
    if (!execution) throw serviceError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    return deepFreeze({
      schemaVersion: 1, status: "ok", action: "objective.status", projectId: project.projectId,
      objectiveId, executionStatus: execution.executionStatus, backend: execution.backend, threadId: execution.threadId
    });
  }

  async function cancelCommand(command, binding) {
    const { project } = requireProjectRoute(binding);
    const objectiveId = command.objectiveId ?? store.readCurrentTopicObjective({
      streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
    });
    if (!objectiveId) throw serviceError("OBJECTIVE_REQUIRED", "An objective is required.");
    requireObjectiveProject(objectiveId, project.projectId);
    acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "objective.cancel" });
    const result = await turnController.cancelObjective({
      sourceType: "zulip-message", sourceId: String(binding.sourceMessageId), objectiveId
    });
    return deepFreeze({ schemaVersion: 1, action: "objective.cancel", projectId: project.projectId, ...result });
  }

  async function interactionCommand(command, binding) {
    const interaction = store.readInteraction(command.replyToken);
    if (!interaction) throw serviceError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
    const projectId = store.readObjectiveProject(interaction.objectiveId);
    if (!projectId) throw serviceError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (interaction.targetSnapshot?.platform !== "zulip" || interaction.targetSnapshot.streamId !== binding.streamId ||
        interaction.targetSnapshot.topic !== binding.topic) {
      throw serviceError("INTERACTION_TARGET_MISMATCH", "Interaction target does not match.");
    }
    acl.require({
      userId: binding.senderId, projectId, permission: "interaction.answer", responderIds: interaction.allowedResponderIds
    });
    const answer = command.type === "APPROVE" ? { choice: command.choice } : { text: command.text };
    const result = await turnController.answerInteraction({
      interactionId: interaction.interactionId,
      responderId: binding.senderId,
      targetSnapshot: interaction.targetSnapshot,
      answer
    });
    return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
  }

  async function handleCommand(command, binding) {
    switch (command.type) {
      case "ROUTE": return routeCommand(command, binding);
      case "TOPIC": return topicCommand(command, binding);
      case "RUN": return dispatch({ binding, text: command.instruction, selection: null });
      case "OBJECTIVE_NEW": return dispatch({ binding, text: command.instruction, selection: { mode: "NEW" } });
      case "OBJECTIVE_CONTINUE": return dispatch({
        binding, text: command.instruction, selection: { mode: "CONTINUE", objectiveId: command.objectiveId }
      });
      case "STATUS": return statusCommand(command, binding);
      case "CANCEL": return cancelCommand(command, binding);
      case "APPROVE":
      case "ANSWER": return interactionCommand(command, binding);
      default: invalidBridge();
    }
  }

  async function handleSemantic(semantic, binding) {
    if (semantic.type === "CONTROL") {
      return topicCommand({ action: semantic.mode === "AUTO" ? "AUTO" : "HERMES" }, binding, true);
    }
    return dispatch({
      binding,
      text: composeSemanticInput(semantic),
      selection: semantic.objective,
      allowTopicAuto: semantic.topicModeAction === "AUTO"
    });
  }

  async function handleBridgeEvent(event) {
    requireOpen();
    if (!isPlainObject(event) || event.schemaVersion !== 1 || !["COMMAND", "SEMANTIC"].includes(event.kind) ||
        typeof event.contextToken !== "string" || !validateBinding(event.binding) ||
        (event.kind === "COMMAND"
          ? !exact(event, ["schemaVersion", "kind", "contextToken", "binding", "command"])
          : !exact(event, ["schemaVersion", "kind", "contextToken", "binding", "semantic"]))) invalidBridge();
    const body = event.kind === "COMMAND" ? validateCommand(event.command) : validateSemantic(event.semantic);
    const context = verifyContext(event.contextToken, signingKey, {
      expectedBinding: event.binding,
      replayStore: store,
      now: () => Math.floor(now() / 1_000)
    });
    const binding = context.binding;
    return track(event.kind === "COMMAND" ? handleCommand(body, binding) : handleSemantic(body, binding));
  }

  function requireAppServerContext(threadId, turnId) {
    const context = store.readAppServerTurnContext({ threadId, turnId });
    if (!context || !projectById.has(context.projectId)) {
      throw serviceError("APP_SERVER_TURN_CONTEXT_UNKNOWN", "App Server turn context is unknown.");
    }
    return context;
  }

  async function handleAppServerRequest(input) {
    requireOpen();
    const message = input?.message;
    const params = message?.params;
    if (!exact(input, ["connectionId", "message"]) || !boundedText(input.connectionId, 4096) ||
        !isPlainObject(message) || !appServerRequestId(message.id) ||
        !APP_SERVER_REVERSE_METHODS.has(message.method) || !isPlainObject(params) ||
        !boundedText(params.threadId, 4096) || !boundedText(params.turnId, 4096) ||
        (params.itemId !== undefined && params.itemId !== null && !boundedText(params.itemId, 4096)) ||
        (params.approvalId !== undefined && params.approvalId !== null && !boundedText(params.approvalId, 4096))) {
      throw serviceError("APP_SERVER_REQUEST_INVALID", "App Server request is invalid.");
    }
    const context = requireAppServerContext(params.threadId, params.turnId);
    const project = projectById.get(context.projectId);
    const allowedResponderIds = [...new Set([
      ...project.acl.contributors,
      ...project.acl.maintainers,
      ...config.admins
    ])];
    return turnController.handleInteractionRequest({
      connectionId: input.connectionId,
      wireRequestId: message.id,
      method: message.method,
      objectiveId: context.objectiveId,
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: params.itemId ?? null,
      approvalId: params.approvalId ?? null,
      request: params,
      allowedResponderIds,
      targetSnapshot: context.targetSnapshot
    });
  }

  async function handleAppServerNotification(input) {
    requireOpen();
    const message = input?.message;
    const params = message?.params;
    const turn = params?.turn;
    if (!exact(input, ["message"]) || !isPlainObject(message) || message.method !== "turn/completed" ||
        !isPlainObject(params) || !boundedText(params.threadId, 4096) ||
        !isPlainObject(turn) || !boundedText(turn.id, 4096)) {
      throw serviceError("APP_SERVER_NOTIFICATION_INVALID", "App Server notification is invalid.");
    }
    const context = requireAppServerContext(params.threadId, turn.id);
    const sourceId = `app-server-turn-sha256:${createHash("sha256")
      .update(context.threadId)
      .update("\0")
      .update(context.turnId)
      .digest("hex")}`;
    return turnController.handleTurnCompleted({
      objectiveId: context.objectiveId,
      turn,
      sourceType: "app-server",
      sourceId
    });
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      const renewalDue = lastPublishedElapsedMs !== null &&
        performance.now() - lastPublishedElapsedMs >= snapshotRenewAfterMs;
      if ((dirty || renewalDue) && !closed) {
        try { await publishSnapshot(); } catch {}
      }
      scheduleRetry();
    }, RETRY_DELAY_MS);
    retryTimer.unref?.();
  }

  async function start() {
    requireOpen();
    const routes = projects.flatMap((project) => project.staticStreamIds.map((streamId) => ({
      streamId,
      projectId: project.projectId
    }))).sort((left, right) => left.streamId - right.streamId);
    store.syncStaticRegistry({ routes });
    scheduleRetry();
    return publishSnapshot();
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    closePromise = (async () => {
      while (activeOperations.size > 0) await Promise.allSettled([...activeOperations]);
      await controlQueue;
    })();
    return closePromise;
  }

  return Object.freeze({
    handleBridgeEvent,
    handleAppServerRequest,
    handleAppServerNotification,
    resolveRoute,
    readTopic,
    publishSnapshot,
    start,
    close
  });
}
