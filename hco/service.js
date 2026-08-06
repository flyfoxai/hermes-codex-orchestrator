import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createAcl } from "./acl.js";
import {
  composeArtifactPromptSection,
  validateArtifactManifestShape
} from "./artifacts.js";
import { verifyContext } from "./contracts/envelope.js";
import { reconcileCodexCall } from "./coordination-recovery.js";
import { normalizeNaturalAlias } from "./interactions.js";
import {
  composeProjectLocalPrompt,
  prepareProjectLocalExchange
} from "./project-local-exchange.js";
import { createRouteResolver, publishRouteSnapshot } from "./routes.js";
import { stateError } from "./state/reducer.js";

const MAX_INSTRUCTION_BYTES = 16 * 1024;
const MAX_LIST_ENTRY_BYTES = 2 * 1024;
const MAX_MODEL_LIST_LIMIT = 500;
const MAX_MODEL_LIST_LENGTH = 1000;
const MAX_SEMANTIC_BYTES = 32 * 1024;
const DEFAULT_MODEL_CATALOG_TTL_MS = 300_000;
const RETRY_DELAY_MS = 1_000;
const APP_SERVER_REVERSE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);
const KNOWN_SIMPLE_DECISIONS = Object.freeze(
  new Set(["accept", "acceptForSession", "decline", "cancel"])
);
const MODEL_LIST_OPTION_KEYS = new Set(["cursor", "limit", "includeHidden"]);
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

// Align with plugin.py's _is_safe_question_id and renderer CLI-token rules.
// Explicitly reject U+0085 (NEL) which Python isspace() rejects but ECMAScript \s accepts.
function isSafeQuestionId(id) {
  return typeof id === "string" && id.trim() !== "" &&
    Buffer.byteLength(id, "utf8") <= 256 &&
    !/[\s\x00-\x1F\x7F\x85`"'<>[\]{}()|;\\/]/u.test(id);
}

function approvalChoiceKey(decision) {
  if (typeof decision === "string") return decision;
  if (isPlainObject(decision)) {
    const keys = Object.keys(decision);
    if (keys.length === 1 && typeof keys[0] === "string") return keys[0];
  }
  return null;
}

function validateQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const ids = [];
  for (const question of rawQuestions) {
    if (!isPlainObject(question)) {
      return "One or more questions are malformed. Use App Server UI to answer.";
    }
    const id = question.id;
    if (!isSafeQuestionId(id)) {
      return `Question ID '${String(id).slice(0, 40)}' is invalid (empty, contains whitespace/control chars, or exceeds 256 bytes). Use App Server UI.`;
    }
    if (ids.includes(id)) {
      return `Duplicate question ID '${id.slice(0, 40)}'. Use App Server UI to answer.`;
    }
    ids.push(id);
  }
  return null;
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

function singleToken(value, maximum = 512) {
  return boundedText(value, maximum) && !/\s/u.test(value);
}

function safeCliToken(value, maximum = 512) {
  return singleToken(value, maximum) && !/[\x00-\x1F\x7F\x85`"'<>[\]{}()|;\\/]/u.test(value);
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

function validateCoordinationCaller(caller) {
  if (caller === undefined) return null;
  if (!exact(caller, ["invocationOrigin", "callerPrincipalId", "codexCallId"], [
    "agentSessionId", "agentActivationId", "parentCodexCallId",
    "authorizationContextId", "newConversation", "originalRequest",
    "callerHermesSessionId", "agentHermesSessionId", "parentHermesSessionId",
    "agentRole", "agentGoal"
  ]) || !["JARVIS", "AGENT"].includes(caller.invocationOrigin) ||
      !boundedText(caller.callerPrincipalId, 512) || !safeCliToken(caller.codexCallId, 512) ||
      (caller.invocationOrigin === "AGENT" &&
        !(safeCliToken(caller.agentHermesSessionId, 512) ||
          (safeCliToken(caller.agentSessionId, 512) && safeCliToken(caller.agentActivationId, 512)))) ||
      (caller.invocationOrigin === "JARVIS" &&
        (!safeCliToken(caller.callerHermesSessionId, 512) ||
          caller.agentSessionId !== undefined || caller.agentActivationId !== undefined)) ||
      (caller.parentCodexCallId !== undefined && !safeCliToken(caller.parentCodexCallId, 512)) ||
      (caller.authorizationContextId !== undefined && !safeCliToken(caller.authorizationContextId, 512)) ||
      (caller.callerHermesSessionId !== undefined && !safeCliToken(caller.callerHermesSessionId, 512)) ||
      (caller.agentHermesSessionId !== undefined && !safeCliToken(caller.agentHermesSessionId, 512)) ||
      (caller.parentHermesSessionId !== undefined && !safeCliToken(caller.parentHermesSessionId, 512)) ||
      (caller.agentRole !== undefined && !boundedText(caller.agentRole, 256)) ||
      (caller.agentGoal !== undefined && !boundedText(caller.agentGoal)) ||
      (caller.newConversation !== undefined && typeof caller.newConversation !== "boolean") ||
      (caller.originalRequest !== undefined && !boundedText(caller.originalRequest))) {
    invalidBridge();
  }
  return caller;
}

function invalidBridge() {
  throw serviceError("BRIDGE_EVENT_INVALID", "Bridge event is invalid.");
}

function invalidModel() {
  throw serviceError("MODEL_PROTOCOL_ERROR", "Model protocol payload is invalid.");
}

function modelCatalogUnavailable() {
  return serviceError("MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable.");
}

function invalidModelListOptions() {
  return serviceError("MODEL_LIST_OPTIONS_INVALID", "Model list options are invalid.");
}

function validateCommand(command) {
  if (!isPlainObject(command) || typeof command.type !== "string") invalidBridge();
  switch (command.type) {
    case "RUN":
      if (!exact(command, ["type", "instruction"]) || !boundedText(command.instruction)) invalidBridge();
      break;
    case "STATUS":
    case "CANCEL":
      if (!exact(command, ["type"], ["objectiveId", "supplementalText"]) ||
          (command.objectiveId !== undefined && !boundedText(command.objectiveId, 512)) ||
          (command.supplementalText !== undefined && !boundedText(command.supplementalText))) invalidBridge();
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
    case "THREAD_BIND":
      if (!exact(command, ["type", "objectiveId", "threadId"]) ||
          !singleToken(command.objectiveId) || !singleToken(command.threadId)) invalidBridge();
      break;
    case "APPROVE":
      if (!exact(command, ["type", "replyToken", "choice"]) || !boundedText(command.replyToken, 512) ||
          !boundedText(command.choice, 4096)) invalidBridge();
      break;
    case "INTERACT":
      if (!exact(command, ["type", "replyToken", "actionId"]) ||
          !safeCliToken(command.replyToken) || !safeCliToken(command.actionId)) invalidBridge();
      break;
    case "NATURAL_INTERACTION_REPLY": {
      if (!exact(command, ["type", "normalizedAlias"]) || !boundedText(command.normalizedAlias, 64)) invalidBridge();
      const normalized = normalizeNaturalAlias(command.normalizedAlias);
      if (!normalized || normalized.alias !== command.normalizedAlias) invalidBridge();
      break;
    }
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

function validateModelListOptions(options = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !MODEL_LIST_OPTION_KEYS.has(key))) {
    throw invalidModelListOptions();
  }
  const result = {};
  if (Object.hasOwn(options, "includeHidden")) {
    if (typeof options.includeHidden !== "boolean") throw invalidModelListOptions();
    result.includeHidden = options.includeHidden;
  }
  if (Object.hasOwn(options, "limit")) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_MODEL_LIST_LIMIT) {
      throw invalidModelListOptions();
    }
    result.limit = options.limit;
  }
  if (Object.hasOwn(options, "cursor")) {
    if (!boundedText(options.cursor, 4096)) throw invalidModelListOptions();
    result.cursor = options.cursor;
  }
  return result;
}

function cloneCatalogModel(model) {
  if (!isPlainObject(model)) throw modelCatalogUnavailable();
  const cloned = {};
  for (const [key, value] of Object.entries(model)) {
    if (Array.isArray(value)) cloned[key] = [...value];
    else cloned[key] = value;
  }
  return cloned;
}

function normalizeModelCatalogResponse(response) {
  if (!isPlainObject(response) ||
      !Array.isArray(response.data) ||
      Object.keys(response.data).length !== response.data.length ||
      response.data.length > MAX_MODEL_LIST_LENGTH ||
      !Object.hasOwn(response, "nextCursor") ||
      (response.nextCursor !== null && !boundedText(response.nextCursor, 4096))) {
    throw modelCatalogUnavailable();
  }
  return {
    models: response.data.map(cloneCatalogModel),
    nextCursor: response.nextCursor
  };
}

function modelListCacheKey(options) {
  return JSON.stringify({
    includeHidden: Object.hasOwn(options, "includeHidden") ? options.includeHidden : null,
    limit: Object.hasOwn(options, "limit") ? options.limit : null,
    cursor: Object.hasOwn(options, "cursor") ? options.cursor : null
  });
}

function catalogView(entry, { cached, stale, sourceStatus }) {
  return deepFreeze({
    ...entry.payload,
    sourceStatus,
    cached,
    stale
  });
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
      !exact(semantic, ["type", "instruction", "constraints", "acceptanceCriteria", "reminders", "objective", "topicModeAction"], ["artifacts"]) ||
      !boundedText(semantic.instruction) || !validateList(semantic.constraints, 16) ||
      !validateList(semantic.acceptanceCriteria, 16) || !validateList(semantic.reminders, 8) ||
      ![null, "AUTO"].includes(semantic.topicModeAction)) invalidModel();
  if (semantic.objective !== null &&
      (!isPlainObject(semantic.objective) ||
       (semantic.objective.mode === "NEW"
         ? !exact(semantic.objective, ["mode"])
         : !exact(semantic.objective, ["mode", "objectiveId"]) || semantic.objective.mode !== "CONTINUE" ||
           !boundedText(semantic.objective.objectiveId, 512)))) invalidModel();
  if (semantic.artifacts !== undefined) validateArtifactManifestShape(semantic.artifacts);
  return semantic;
}

function composeSemanticInput(semantic, { includeArtifacts = true } = {}) {
  const sections = [["Instruction", [semantic.instruction]]];
  if (semantic.constraints.length > 0) sections.push(["Constraints", semantic.constraints]);
  if (semantic.acceptanceCriteria.length > 0) sections.push(["Acceptance criteria", semantic.acceptanceCriteria]);
  if (semantic.reminders.length > 0) sections.push(["Reminders", semantic.reminders]);
  if (includeArtifacts) {
    const artifacts = composeArtifactPromptSection(semantic.artifacts);
    if (artifacts.length > 0) sections.push(["Artifacts", artifacts]);
  }
  return sections.map(([title, entries], index) =>
    index === 0 ? `${title}:\n${entries[0]}` : `${title}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`
  ).join("\n\n");
}

function strictReadOnlyTask({ invocationOrigin, text, taskContract }) {
  if (invocationOrigin !== "JARVIS") return false;
  const contract = isPlainObject(taskContract) ? taskContract : {};
  const fields = [
    text,
    contract.instruction,
    ...(Array.isArray(contract.constraints) ? contract.constraints : []),
    ...(Array.isArray(contract.acceptanceCriteria) ? contract.acceptanceCriteria : []),
    ...(Array.isArray(contract.reminders) ? contract.reminders : [])
  ];
  const normalized = fields.filter((value) => typeof value === "string").join("\n").toLowerCase();
  return /只读|read[- ]only|no[ -]write(?:s|ing)?|without[ -]writes?/u.test(normalized);
}

function publicDispatch(projectId, result, coordination = null) {
  const output = {
    schemaVersion: 1,
    status: result.status === "started" ? "accepted" : result.status,
    action: "dispatch",
    projectId,
    objectiveId: result.objectiveId
  };
  if (coordination) {
    output.topicContextId = coordination.topicContext.topicContextId;
    output.workRequestId = coordination.workRequest.workRequestId;
    output.codexConversationId = coordination.conversation.codexConversationId;
    output.codexCallId = coordination.codexCall.codexCallId;
    output.invocationOrigin = coordination.codexCall.invocationOrigin;
    if (coordination.codexCall.reportTarget.kind !== "ZULIP") {
      output.mailboxTarget = coordination.codexCall.reportTarget;
    }
  }
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
  modelCatalog,
  modelCatalogTtlMs = DEFAULT_MODEL_CATALOG_TTL_MS,
  now = Date.now,
  idFactory = () => randomUUID(),
  snapshotPublisher = publishRouteSnapshot
} = {}) {
  const storeMethods = [
    "consume", "getRuntimeRoute", "listRuntimeRoutes", "applyRouteCommand", "readTopicState",
    "setUserTopicMode", "listSnapshotTopicModes", "readObjectiveProject", "readCurrentTopicObjective",
    "readControlGeneration", "syncStaticRegistry", "readObjectiveExecution", "readInteraction",
    "readAppServerTurnContext", "prepareCoordinationDispatch", "recordCodexCallSubmission",
    "relinkLegacyObjectiveTopic",
    "ensureTopicContext", "ensureCoordinationWorkRequest", "createAgentSession", "readAgentScopeByHermesSession",
    "readTopicContext", "readObjectiveScope", "readLegacyObjectiveTopicBinding",
    "readCodexCall", "readCallForTurn", "readWorkStatus"
  ];
  const controllerMethods = [
    "acceptIntent", "continueObjective", "resolveObjectiveThread", "cancelObjective", "answerInteraction",
    "handleInteractionRequest", "handleTurnCompleted"
  ];
  if (!isPlainObject(config) || !Array.isArray(config.projects) || !Array.isArray(config.admins) ||
      !isPlainObject(config.bridge) || !isPlainObject(config.snapshot) ||
      !storeMethods.every((method) => typeof store?.[method] === "function") ||
      !controllerMethods.every((method) => typeof turnController?.[method] === "function") ||
      !(Buffer.isBuffer(contextKey) || contextKey instanceof Uint8Array || typeof contextKey === "string") ||
      (modelCatalog !== undefined && (!isPlainObject(modelCatalog) || typeof modelCatalog.listModels !== "function")) ||
      !Number.isSafeInteger(modelCatalogTtlMs) || modelCatalogTtlMs <= 0 ||
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
  const modelCatalogCache = new Map();
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

  async function fetchModelCatalog(options, key) {
    const cached = modelCatalogCache.get(key);
    const current = now();
    if (cached && current < cached.expiresAt) {
      return catalogView(cached, { cached: true, stale: false, sourceStatus: "ok" });
    }

    try {
      if (!modelCatalog) throw modelCatalogUnavailable();
      const response = await modelCatalog.listModels(options);
      const normalized = normalizeModelCatalogResponse(response);
      const fetchedAt = now();
      const expiresAt = fetchedAt + modelCatalogTtlMs;
      const entry = deepFreeze({
        fetchedAt,
        expiresAt,
        payload: {
          schemaVersion: 1,
          status: "ok",
          action: "models.list",
          fetchedAt,
          expiresAt,
          models: normalized.models,
          nextCursor: normalized.nextCursor
        }
      });
      modelCatalogCache.set(key, entry);
      return catalogView(entry, { cached: false, stale: false, sourceStatus: "ok" });
    } catch {
      if (cached) return catalogView(cached, { cached: true, stale: true, sourceStatus: "unavailable" });
      throw modelCatalogUnavailable();
    }
  }

  function listModels(options = {}) {
    try {
      requireOpen();
      const normalizedOptions = validateModelListOptions(options);
      return track(fetchModelCatalog(normalizedOptions, modelListCacheKey(normalizedOptions)));
    } catch (error) {
      return Promise.reject(error);
    }
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
    if (route.owner !== "PROJECT") throw stateError("ROUTE_HERMES_OWNED", "Numeric stream is Hermes-owned.");
    const project = projectById.get(route.projectId);
    if (!project) throw stateError("PROJECT_NOT_FOUND", "Project does not exist.");
    return { route, project };
  }

  function requireObjectiveProject(objectiveId, projectId) {
    const ownedProjectId = store.readObjectiveProject(objectiveId);
    if (ownedProjectId === null) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (ownedProjectId !== projectId) throw stateError("OBJECTIVE_PROJECT_MISMATCH", "Objective belongs to another project.");
  }

  function requireObjectiveTopic(objectiveId, projectId, binding) {
    requireObjectiveProject(objectiveId, projectId);
    const topicContext = store.ensureTopicContext({
      streamId: binding.streamId,
      topic: binding.topic,
      projectId,
      sourceType: "verified-topic-address",
      sourceId: createHash("sha256")
        .update(String(binding.streamId))
        .update("\0")
        .update(binding.topic)
        .digest("hex")
    }).topicContext;
    const objectiveScope = store.readObjectiveScope(objectiveId);
    if (!objectiveScope) {
      const legacy = store.readLegacyObjectiveTopicBinding(objectiveId);
      if (legacy) {
        throw stateError(
          "OBJECTIVE_TOPIC_MIGRATION_REQUIRED",
          "Legacy objective has no immutable topic scope; an authorized relink is required."
        );
      }
    }
    if (!objectiveScope || objectiveScope.projectId !== projectId || objectiveScope.topicContextId !== topicContext.topicContextId) {
      throw stateError("OBJECTIVE_TOPIC_MISMATCH", "Objective belongs to another topic context.");
    }
    return { topicContext, objectiveScope };
  }

  function executionOptions({
    binding,
    project,
    objectiveId,
    text,
    artifactMode,
    artifacts,
    codexCallId,
    coordinatedSource,
    readOnly = false
  }) {
    const threadOptions = {
      ...project.threadOptions,
      ...(readOnly ? { approvalPolicy: "never", sandbox: "read-only" } : {}),
      cwd: project.cwd
    };
    return {
      sourceType: coordinatedSource ? "coordination-call" : "zulip-message",
      sourceId: coordinatedSource ? codexCallId : String(binding.sourceMessageId),
      objectiveId,
      projectId: project.projectId,
      backend: project.backend,
      text,
      targetSnapshot: {
        platform: "zulip", streamId: binding.streamId, topic: binding.topic, sourceMessageId: binding.sourceMessageId
      },
      threadOptions,
      topicBinding: { streamId: binding.streamId, topic: binding.topic, actorUserId: binding.senderId },
      ...(artifactMode === undefined ? {} : { artifactMode }),
      ...(artifacts === undefined ? {} : { artifacts, artifactBaseDir: project.cwd })
    };
  }

  async function dispatch({
    binding,
    text,
    selection,
    allowTopicAuto = false,
    artifacts,
    taskContract = null,
    invocationOrigin = "DIRECT_ZULIP",
    caller = null,
    request = null
  }) {
    let beforeGeneration;
    let project;
    let resultPromise;
    let coordination;
    await enqueue(() => {
      ({ project } = requireProjectRoute(binding));
      const topic = readTopic({ streamId: binding.streamId, topic: binding.topic });
      let objectiveId;
      let continuing = false;
      if (selection?.mode === "CONTINUE") {
        objectiveId = selection.objectiveId;
        requireObjectiveTopic(objectiveId, project.projectId, binding);
        continuing = true;
      } else if (selection?.mode === "NEW") {
        objectiveId = idFactory("objective");
      } else {
        objectiveId = store.readCurrentTopicObjective({
          streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
        });
        continuing = objectiveId !== null;
        if (continuing) requireObjectiveTopic(objectiveId, project.projectId, binding);
        if (!objectiveId) objectiveId = idFactory("objective");
      }
      const permission = continuing ? "objective.continue" : "objective.create";
      acl.require({ userId: binding.senderId, projectId: project.projectId, permission });
      if (topic.mode === "HERMES_ONLY" && !allowTopicAuto) {
        throw stateError("TOPIC_HERMES_ONLY", "Topic is Hermes-only.");
      }
      if (allowTopicAuto) {
        acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "topic.manage" });
      }

      let executionText = text;
      let executionArtifacts = artifacts;
      let artifactMode;
      if (artifacts !== undefined) {
        const exchange = prepareProjectLocalExchange({
          canonicalRoot: project.cwd,
          projectId: project.projectId,
          workId: objectiveId,
          exchangeIdFactory: () => idFactory("exchange"),
          sourceManifest: artifacts,
          contextText: text,
          taskContract: taskContract ?? { instruction: text },
          now
        });
        executionText = composeProjectLocalPrompt(exchange);
        executionArtifacts = exchange.artifacts;
        artifactMode = "project_local";
      }

      beforeGeneration = store.readControlGeneration().generation;
      let callerPrincipalId = caller?.callerPrincipalId ?? (
        invocationOrigin === "DIRECT_ZULIP" ? `zulip-user:${binding.senderId}` : `jarvis-topic:${binding.streamId}:${binding.topic}`
      );
      const workBrief = {
        schemaVersion: 1,
        originalText: caller?.originalRequest ?? text
      };
      let agentSessionId = caller?.agentSessionId ?? null;
      let agentActivationId = caller?.agentActivationId ?? null;
      if (invocationOrigin === "AGENT") {
        const existingTopic = store.readTopicContext({
          streamId: binding.streamId,
          topic: binding.topic
        });
        const trustedParentScope = caller?.parentHermesSessionId
          ? store.readAgentScopeByHermesSession(caller.parentHermesSessionId)
          : null;
        const trustedJarvisParent = !trustedParentScope &&
          typeof existingTopic?.jarvisSessionId === "string" &&
          existingTopic.jarvisSessionId === caller?.parentHermesSessionId;
        if (!trustedParentScope && !trustedJarvisParent) {
          throw stateError("AGENT_PARENT_SCOPE_MISMATCH", "Agent parent does not match the trusted topic scope.");
        }
        const work = store.ensureCoordinationWorkRequest({
          streamId: binding.streamId,
          topic: binding.topic,
          projectId: project.projectId,
          requesterUserId: binding.senderId,
          originalZulipMessageId: binding.sourceMessageId,
          sourceType: "zulip-work-request",
          sourceId: String(binding.sourceMessageId),
          workBrief
        });
        let scope = caller?.agentHermesSessionId
          ? store.readAgentScopeByHermesSession(caller.agentHermesSessionId)
          : null;
        const parentScope = trustedParentScope;
        const parentIsAgent = parentScope?.agentSession.workRequestId === work.workRequest.workRequestId;
        const parentIsJarvis = !parentScope &&
          typeof work.topicContext.jarvisSessionId === "string" &&
          work.topicContext.jarvisSessionId === caller?.parentHermesSessionId;
        if (!parentIsAgent && !parentIsJarvis) {
          throw stateError("AGENT_PARENT_SCOPE_MISMATCH", "Agent parent does not match the trusted topic scope.");
        }
        if (!scope) {
          scope = store.createAgentSession({
            hermesSessionId: caller.agentHermesSessionId,
            workRequestId: work.workRequest.workRequestId,
            parentAgentSessionId: parentScope?.agentSession.agentSessionId ?? null,
            role: caller.agentRole ?? "worker",
            triggerPrincipalId: parentScope
              ? `agent:${parentScope.agentSession.agentSessionId}`
              : `jarvis:${work.topicContext.topicContextId}`,
            reason: caller.agentGoal ?? "Delegated project work",
            budget: { source: "hermes", bounded: true },
            maxReactivations: 3
          });
        } else if (
          scope.agentSession.workRequestId !== work.workRequest.workRequestId ||
          (scope.agentSession.parentAgentSessionId !== null &&
            scope.agentSession.parentAgentSessionId !== parentScope?.agentSession.agentSessionId) ||
          (scope.agentSession.parentAgentSessionId === null && !parentIsJarvis)
        ) {
          throw stateError("AGENT_PARENT_SCOPE_MISMATCH", "Agent scope does not match its trusted parent.");
        }
        agentSessionId = scope.agentSession.agentSessionId;
        agentActivationId = scope.activation.agentActivationId;
        callerPrincipalId = `agent:${agentSessionId}`;
      }
      coordination = store.prepareCoordinationDispatch({
        streamId: binding.streamId,
        topic: binding.topic,
        projectId: project.projectId,
        requesterUserId: binding.senderId,
        originalZulipMessageId: binding.sourceMessageId,
        sourceType: "zulip-work-request",
        sourceId: String(binding.sourceMessageId),
        callSourceId: caller?.codexCallId ?? `${binding.sourceMessageId}:${invocationOrigin}:1`,
        objectiveId,
        invocationOrigin,
        callerPrincipalId,
        jarvisSessionId: invocationOrigin === "JARVIS" ? caller?.callerHermesSessionId : null,
        agentSessionId,
        agentActivationId,
        parentCodexCallId: caller?.parentCodexCallId ?? null,
        authorizationContextId: caller?.authorizationContextId ?? null,
        forceNewConversation: selection?.mode === "NEW" || caller?.newConversation === true,
        maxTopicConversations: 8,
        workBrief,
        request: request ?? { instruction: text }
      });
      const options = executionOptions({
        binding, project, objectiveId, text: executionText, artifactMode, artifacts: executionArtifacts,
        codexCallId: coordination.codexCall.codexCallId,
        coordinatedSource: caller !== null,
        readOnly: strictReadOnlyTask({ invocationOrigin, text, taskContract })
      });
      if (allowTopicAuto) options.topicModeAction = "AUTO";
      resultPromise = continuing
        ? turnController.continueObjective(options)
        : turnController.acceptIntent(options);
    });
    let result;
    try {
      result = await resultPromise;
    } catch (error) {
      store.recordCodexCallSubmission({
        codexCallId: coordination.codexCall.codexCallId,
        objectiveId: coordination.codexCall.objectiveId,
        status: "terminal_error",
        turnId: null,
        threadId: null
      });
      throw error;
    }
    store.recordCodexCallSubmission({
      codexCallId: coordination.codexCall.codexCallId,
      objectiveId: result.objectiveId,
      status: result.status === "started" ? "accepted" : result.status,
      turnId: result.turnId ?? null,
      threadId: result.threadId ?? null
    });
    await enqueue(() => publishIfGenerationChanged(beforeGeneration));
    return publicDispatch(project.projectId, result, coordination);
  }

  async function routeCommand(command, binding) {
    if (command.action === "SHOW") {
      const route = resolveRoute(binding.streamId);
      if (route.owner === "PROJECT") {
        acl.require({ userId: binding.senderId, projectId: route.projectId, permission: "project.read" });
      }
      const visibleRoute = route.owner === "PROJECT"
        ? { ...route, cwd: projectById.get(route.projectId).cwd }
        : route;
      return deepFreeze({ schemaVersion: 1, status: "ok", action: "route.show", route: visibleRoute });
    }
    return enqueue(async () => {
      const before = resolveRoute(binding.streamId);
      const target = command.action === "SET" ? projectById.get(command.projectId) : null;
      const fallback = command.action === "UNSET" ? createRouteResolver({
        projects,
        runtimeRoutes: store.listRuntimeRoutes().filter((row) => row.streamId !== binding.streamId)
      }).resolve(binding.streamId) : null;
      if (command.action === "SET" && !target) throw stateError("PROJECT_NOT_FOUND", "Project does not exist.");
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
    if (command.objectiveId) {
      let work = store.readWorkStatus(command.objectiveId);
      if (work) {
        acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "objective.status" });
        const topicContext = store.ensureTopicContext({
          streamId: binding.streamId,
          topic: binding.topic,
          projectId: project.projectId,
          sourceType: "verified-topic-address",
          sourceId: createHash("sha256")
            .update(String(binding.streamId)).update("\0").update(binding.topic).digest("hex")
        }).topicContext;
        if (work.workRequest.projectId !== project.projectId ||
            work.workRequest.topicContextId !== topicContext.topicContextId) {
          throw stateError("WORK_REQUEST_TOPIC_MISMATCH", "Work request belongs to another topic context.");
        }
        const activeBefore = work.codexCalls.filter((call) =>
          !["COMPLETED", "CANCELLED", "FAILED"].includes(call.state));
        const objectiveCounts = new Map();
        for (const call of activeBefore) {
          objectiveCounts.set(call.objectiveId, (objectiveCounts.get(call.objectiveId) ?? 0) + 1);
        }
        for (const call of activeBefore) {
          await reconcileCodexCall({
            store,
            turnController,
            call,
            activeForObjective: objectiveCounts.get(call.objectiveId),
            sourceId: `zulip-work-status-${binding.sourceMessageId}-${call.codexCallId}`
          });
        }
        work = store.readWorkStatus(command.objectiveId);
        const activeCalls = work.codexCalls.filter((call) => !["COMPLETED", "CANCELLED", "FAILED"].includes(call.state));
        const activeAgents = work.agents.filter((agent) => !["REPORTED", "CANCELLED", "FAILED", "FAILED_ORPHANED"].includes(agent.state));
        return deepFreeze({
          schemaVersion: 1,
          status: "ok",
          action: "work.status",
          projectId: project.projectId,
          topicContextId: topicContext.topicContextId,
          workRequestId: work.workRequest.workRequestId,
          workState: work.workRequest.state,
          statusReason: work.workRequest.statusReason,
          codexCalls: { total: work.codexCalls.length, active: activeCalls.length },
          agents: { total: work.agents.length, active: activeAgents.length },
          pendingMailbox: work.pendingMailbox,
          nextAction: work.workRequest.state === "WAITING_HUMAN"
            ? "wait_for_human"
            : work.workRequest.state === "STATUS_UNVERIFIED"
              ? "verify_backend"
              : work.workRequest.state === "DEGRADED_PENDING_OPERATOR"
                ? "operator_recovery"
                : activeCalls.length > 0
                  ? "wait_for_codex"
                  : activeAgents.length > 0
                    ? "wait_for_agent"
                    : work.pendingMailbox > 0
                      ? "caller_review"
                      : work.workRequest.statusReason === "direct_delivery_pending"
                        ? "wait_for_delivery"
                        : "jarvis_finalize"
        });
      }
    }
    const objectiveId = command.objectiveId ?? store.readCurrentTopicObjective({
      streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
    });
    if (!objectiveId) throw stateError("OBJECTIVE_REQUIRED", "An objective is required.");
    requireObjectiveTopic(objectiveId, project.projectId, binding);
    acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "objective.status" });
    let statusVerified = false;
    let verificationStatus = "unavailable";
    try {
      if (typeof turnController.reconcileObjective !== "function") throw new Error("reconciliation unavailable");
      const reconciled = await turnController.reconcileObjective({
        objectiveId,
        sourceId: `zulip-status-${binding.sourceMessageId}`
      });
      verificationStatus = reconciled.status;
      statusVerified = !["backend_unavailable", "reconciliation_needed", "submission_unknown"].includes(reconciled.status);
    } catch {
      // A status query must remain available when the backend cannot be reached,
      // but the cached state is explicitly marked unverified below.
    }
    const execution = store.readObjectiveExecution(objectiveId);
    if (!execution) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    return deepFreeze({
      schemaVersion: 1, status: "ok", action: "objective.status", projectId: project.projectId,
      objectiveId, executionStatus: execution.executionStatus, backend: execution.backend,
      threadId: execution.threadId, statusVerified, verificationStatus
    });
  }

  async function threadBindCommand(command, binding) {
    const { project } = requireProjectRoute(binding);
    acl.require({
      userId: binding.senderId,
      projectId: project.projectId,
      permission: "backend.recover"
    });
    requireObjectiveProject(command.objectiveId, project.projectId);
    if (!store.readObjectiveScope(command.objectiveId)) {
      store.relinkLegacyObjectiveTopic({
        objectiveId: command.objectiveId,
        streamId: binding.streamId,
        topic: binding.topic,
        projectId: project.projectId,
        requesterUserId: binding.senderId,
        originalZulipMessageId: binding.sourceMessageId,
        sourceType: "zulip-objective-topic-relink",
        sourceId: String(binding.sourceMessageId)
      });
    }
    requireObjectiveTopic(command.objectiveId, project.projectId, binding);
    const result = await turnController.resolveObjectiveThread({
      objectiveId: command.objectiveId,
      threadId: command.threadId,
      sourceType: "zulip-message",
      sourceId: String(binding.sourceMessageId)
    });
    return deepFreeze({
      schemaVersion: 1,
      action: "objective.thread.bind",
      projectId: project.projectId,
      ...result
    });
  }

  async function cancelCommand(command, binding) {
    const { project } = requireProjectRoute(binding);
    const objectiveId = command.objectiveId ?? store.readCurrentTopicObjective({
      streamId: binding.streamId, topic: binding.topic, projectId: project.projectId
    });
    if (!objectiveId) throw stateError("OBJECTIVE_REQUIRED", "An objective is required.");
    requireObjectiveTopic(objectiveId, project.projectId, binding);
    acl.require({ userId: binding.senderId, projectId: project.projectId, permission: "objective.cancel" });
    const result = await turnController.cancelObjective({
      sourceType: "zulip-message", sourceId: String(binding.sourceMessageId), objectiveId
    });
    return deepFreeze({ schemaVersion: 1, action: "objective.cancel", projectId: project.projectId, ...result });
  }

  function resolveApprovalDecision(interaction, choiceKey) {
    const available = interaction?.request?.availableDecisions;
    if (Array.isArray(available) && available.length > 0) {
      for (const decision of available) {
        const key = approvalChoiceKey(decision);
        if (key === choiceKey) return { key, decision };
      }
      const valid = available.map(approvalChoiceKey).filter(Boolean);
      throw stateError(
        "INTERACTION_DECISION_INVALID",
        `Invalid decision '${choiceKey}'. Valid choices: ${valid.join(", ")}.`
      );
    }
    if (KNOWN_SIMPLE_DECISIONS.has(choiceKey)) return { key: choiceKey, decision: choiceKey };
    throw stateError(
      "INTERACTION_DECISION_INVALID",
      `Invalid decision '${choiceKey}'. Without available decisions, valid choices are: ${[
        ...KNOWN_SIMPLE_DECISIONS
      ].join(", ")}.`
    );
  }

  function userInputQuestions(interaction) {
    const questions = interaction?.request?.questions;
    return Array.isArray(questions)
      ? questions.filter(
          (question) =>
            isPlainObject(question) &&
            typeof question.id === "string" &&
            question.id.trim() &&
            !/\s/.test(question.id)
        )
      : [];
  }

  function requireInteractionAction(interaction, command) {
    const actions = Array.isArray(interaction.actions) ? interaction.actions : [];
    if (command.type === "INTERACT") {
      const action = actions.find((candidate) => candidate.actionId === command.actionId);
      if (!action) throw stateError("INTERACTION_ACTION_INVALID", "Interaction action does not exist.");
      return action;
    }
    const action = actions.find((candidate) => candidate.sourceKey === command.choice);
    if (action) {
      if (["policy_change", "network_policy_change"].includes(action.actionClass)) {
        throw stateError(
          "INTERACTION_ACTION_EXPLICIT_REQUIRED",
          "Policy-changing actions require an explicit opaque action ID."
        );
      }
      return action;
    }
    const legacy = resolveApprovalDecision(interaction, command.choice);
    return {
      actionId: null,
      sourceKey: legacy.key,
      actionClass: ["decline", "cancel"].includes(legacy.key) ? "deny" : "one_time_allow",
      answer: { decision: legacy.decision }
    };
  }

  async function settleInteractionAction(interaction, action, binding, resolutionSource) {
    const detail = store.readInteractionDetail(interaction.interactionId);
    if (detail?.chunkCount > 0 && detail.state !== "delivered") {
      throw stateError(
        "INTERACTION_DETAIL_NOT_DELIVERED",
        "Interaction details have not been delivered completely. Approval is not yet available."
      );
    }
    const result = await turnController.answerInteraction({
      interactionId: interaction.interactionId,
      responderId: binding.senderId,
      targetSnapshot: interaction.targetSnapshot,
      answer: action.answer,
      audit: {
        actionId: action.actionId,
        actionClass: action.actionClass,
        resolutionSource,
        sourceType: "zulip-message",
        sourceMessageId: String(binding.sourceMessageId)
      }
    });
    const projectId = store.readObjectiveProject(interaction.objectiveId);
    return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
  }

  function answerCommandAudit(binding) {
    return {
      actionId: null,
      actionClass: null,
      resolutionSource: "answer_command",
      sourceType: "zulip-message",
      sourceMessageId: String(binding.sourceMessageId)
    };
  }

  async function interactionCommand(command, binding) {
    const interaction = store.readInteraction(command.replyToken);
    if (!interaction) throw stateError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
    const projectId = store.readObjectiveProject(interaction.objectiveId);
    if (!projectId) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (interaction.targetSnapshot?.platform !== "zulip" || interaction.targetSnapshot.streamId !== binding.streamId ||
        interaction.targetSnapshot.topic !== binding.topic) {
      throw stateError("INTERACTION_TARGET_MISMATCH", "Interaction target does not match.");
    }
    acl.require({
      userId: binding.senderId, projectId, permission: "interaction.answer", responderIds: interaction.allowedResponderIds
    });
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval"
    ]);
    const isApprovalInteraction = approvalMethods.has(interaction.method);
    const isUserInputInteraction = interaction.method === "item/tool/requestUserInput";
    if (command.type === "APPROVE" && !isApprovalInteraction) {
      throw stateError(
        "INTERACTION_COMMAND_MISMATCH",
        `Cannot use /codex approve on a '${interaction.method}' interaction.`
      );
    }
    if (command.type === "ANSWER" && !isUserInputInteraction) {
      throw stateError(
        "INTERACTION_COMMAND_MISMATCH",
        `Cannot use /codex answer on a '${interaction.method}' interaction.`
      );
    }
    if (command.type === "INTERACT" && !interaction.actions.some((action) => action.actionId === command.actionId)) {
      throw stateError("INTERACTION_ACTION_INVALID", "Interaction action does not exist.");
    }
    if (command.type === "ANSWER") {
      const rawQuestions = Array.isArray(interaction?.request?.questions)
        ? interaction.request.questions
        : [];
      const validationError = validateQuestions(rawQuestions);
      if (validationError) {
        throw stateError("INTERACTION_QUESTION_ID_INVALID", validationError);
      }
      const questions = userInputQuestions(interaction);
      // Reject answer commands for any interaction containing isSecret questions
      const hasSecretQuestion = rawQuestions.some(
        (question) => isPlainObject(question) && question.isSecret === true
      );
      if (hasSecretQuestion) {
        throw stateError(
          "INTERACTION_SECRET_ANSWER_FORBIDDEN",
          "Cannot answer interactions containing secret questions via Zulip commands. Use App Server UI."
        );
      }
      if (questions.length === 1) {
        const answer = { answers: { [questions[0].id]: { answers: [command.text] } } };
        const result = await turnController.answerInteraction({
          interactionId: interaction.interactionId,
          responderId: binding.senderId,
          targetSnapshot: interaction.targetSnapshot,
          answer,
          audit: answerCommandAudit(binding)
        });
        return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
      }
      if (questions.length > 1) {
        const match = /^(\S+)\s+([\s\S]+)$/.exec(command.text);
        const questionId = match?.[1];
        const questionAnswer = match?.[2];
        const questionIds = questions.map((question) => question.id);
        if (!questionId || !questionIds.includes(questionId) || !questionAnswer) {
          throw stateError(
            "INTERACTION_QUESTION_ID_INVALID",
            `Answer must start with one of these question IDs: ${questionIds.join(", ")}.`
          );
        }
        const partialAnswers = {
          ...(isPlainObject(interaction.partialAnswers) ? interaction.partialAnswers : {}),
          [questionId]: { answers: [questionAnswer] }
        };
        const missingQuestionIds = questionIds.filter((id) => !Object.hasOwn(partialAnswers, id));
        if (missingQuestionIds.length > 0) {
          store.persistInteractionPartialAnswers({
            interactionId: interaction.interactionId,
            partialAnswers
          });
          return deepFreeze({
            schemaVersion: 1,
            action: "interaction.answer",
            status: "partial",
            projectId,
            objectiveId: interaction.objectiveId,
            interactionId: interaction.interactionId,
            missingQuestionIds
          });
        }
        const answer = { answers: partialAnswers };
        const result = await turnController.answerInteraction({
          interactionId: interaction.interactionId,
          responderId: binding.senderId,
          targetSnapshot: interaction.targetSnapshot,
          answer,
          audit: answerCommandAudit(binding)
        });
        return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
      }
    }
    if (command.type === "APPROVE" || command.type === "INTERACT") {
      const action = requireInteractionAction(interaction, command);
      return settleInteractionAction(
        interaction,
        action,
        binding,
        command.type === "INTERACT" ? "explicit_action" : "legacy_command"
      );
    }
    const answer = { text: command.text };
    const result = await turnController.answerInteraction({
      interactionId: interaction.interactionId,
      responderId: binding.senderId,
      targetSnapshot: interaction.targetSnapshot,
      answer,
      audit: answerCommandAudit(binding)
    });
    return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
  }

  async function naturalInteractionCommand(command, binding) {
    const normalized = normalizeNaturalAlias(command.normalizedAlias);
    if (!normalized || normalized.alias !== command.normalizedAlias) invalidBridge();
    const resolved = store.resolveNaturalInteraction({
      binding,
      intent: normalized.intent,
      normalizedAlias: normalized.alias
    });
    if (resolved.status === "not_applicable") {
      return deepFreeze({
        schemaVersion: 1,
        action: "interaction.natural_reply",
        status: "not_applicable"
      });
    }
    if (resolved.status === "ambiguous") {
      return deepFreeze({
        schemaVersion: 1,
        action: "interaction.natural_reply",
        status: "ambiguous",
        candidateInteractionIds: resolved.candidateInteractionIds
      });
    }
    const interaction = store.readInteraction(resolved.interactionId);
    if (!interaction) throw stateError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
    const projectId = store.readObjectiveProject(interaction.objectiveId);
    if (!projectId) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const action = interaction.actions.find((candidate) => candidate.actionId === resolved.actionId);
    const eligibleClasses = normalized.intent === "allow"
      ? ["one_time_allow", "file_change_allow"]
      : ["deny"];
    if (!action || !action.naturalAliasEligible || !eligibleClasses.includes(action.actionClass)) {
      throw stateError("INTERACTION_ACTION_INVALID", "Interaction action is not eligible for a natural reply.");
    }
    const result = await turnController.answerInteraction({
      interactionId: interaction.interactionId,
      responderId: binding.senderId,
      targetSnapshot: interaction.targetSnapshot,
      answer: action.answer,
      audit: {
        actionId: action.actionId,
        actionClass: action.actionClass,
        resolutionSource: "natural_alias",
        sourceType: "zulip-interaction-reply",
        sourceMessageId: String(binding.sourceMessageId)
      }
    });
    return deepFreeze({ schemaVersion: 1, action: "interaction.answer", projectId, ...result });
  }

  async function handleCommand(command, binding) {
    switch (command.type) {
      case "ROUTE": return routeCommand(command, binding);
      case "TOPIC": return topicCommand(command, binding);
      case "RUN": return dispatch({ binding, text: command.instruction, selection: null, request: command });
      case "OBJECTIVE_NEW": return dispatch({
        binding, text: command.instruction, selection: { mode: "NEW" }, request: command
      });
      case "OBJECTIVE_CONTINUE": return dispatch({
        binding, text: command.instruction, selection: { mode: "CONTINUE", objectiveId: command.objectiveId }, request: command
      });
      case "THREAD_BIND": return threadBindCommand(command, binding);
      case "STATUS": return statusCommand(command, binding);
      case "CANCEL": return cancelCommand(command, binding);
      case "NATURAL_INTERACTION_REPLY": return naturalInteractionCommand(command, binding);
      case "APPROVE":
      case "INTERACT":
      case "ANSWER": return interactionCommand(command, binding);
      default: invalidBridge();
    }
  }

  async function handleSemantic(semantic, binding, caller = null) {
    if (semantic.type === "CONTROL") {
      return topicCommand({ action: semantic.mode === "AUTO" ? "AUTO" : "HERMES" }, binding, true);
    }
    return dispatch({
      binding,
      text: composeSemanticInput(semantic, { includeArtifacts: semantic.artifacts === undefined }),
      selection: semantic.objective,
      allowTopicAuto: semantic.topicModeAction === "AUTO",
      artifacts: semantic.artifacts,
      taskContract: {
        instruction: semantic.instruction,
        constraints: semantic.constraints,
        acceptanceCriteria: semantic.acceptanceCriteria,
        reminders: semantic.reminders
      },
      invocationOrigin: caller?.invocationOrigin ?? "JARVIS",
      caller,
      request: semantic
    });
  }

  async function handleBridgeEvent(event) {
    requireOpen();
    if (!isPlainObject(event) || event.schemaVersion !== 1 || !["COMMAND", "SEMANTIC"].includes(event.kind) ||
        typeof event.contextToken !== "string" || !validateBinding(event.binding) ||
        (event.kind === "COMMAND"
          ? !exact(event, ["schemaVersion", "kind", "contextToken", "binding", "command"])
          : !exact(event, ["schemaVersion", "kind", "contextToken", "binding", "semantic"], ["caller"]))) invalidBridge();
    const body = event.kind === "COMMAND" ? validateCommand(event.command) : validateSemantic(event.semantic);
    const caller = event.kind === "SEMANTIC" ? validateCoordinationCaller(event.caller) : null;
    const context = verifyContext(event.contextToken, signingKey, {
      expectedBinding: event.binding,
      replayStore: store,
      now: () => Math.floor(now() / 1_000)
    });
    if (caller &&
        (context.purpose !== "codex-coordination-dispatch" || context.codexCallId !== caller.codexCallId)) {
      invalidBridge();
    }
    const binding = context.binding;
    return track(event.kind === "COMMAND" ? handleCommand(body, binding) : handleSemantic(body, binding, caller));
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
    const completed = await turnController.handleTurnCompleted({
      objectiveId: context.objectiveId,
      turn,
      sourceType: "app-server",
      sourceId
    });
    const call = store.readCallForTurn({ objectiveId: context.objectiveId, turnId: turn.id });
    if (call && !["COMPLETED", "CANCELLED", "FAILED"].includes(call.state)) {
      store.recordCodexCallSubmission({
        codexCallId: call.codexCallId,
        objectiveId: context.objectiveId,
        status: completed.status === "completed" ? "completed" : "reconciliation_needed",
        turnId: turn.id,
        threadId: context.threadId
      });
    }
    return completed;
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
    listModels,
    resolveRoute,
    readTopic,
    publishSnapshot,
    start,
    close
  });
}
