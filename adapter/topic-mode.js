import { adapterError } from "./errors.js";
import { normalizeZulipStreamName, targetKeyFromMessage } from "./router.js";

export const TOPIC_MODES = Object.freeze({
  AUTO: "AUTO",
  CODEX_BOUND: "CODEX_BOUND",
  HERMES_ONLY: "HERMES_ONLY"
});

const VALID_STORED_MODES = new Set(Object.values(TOPIC_MODES));
const USER_SETTABLE_MODES = new Set([TOPIC_MODES.AUTO, TOPIC_MODES.HERMES_ONLY]);

function requireProjectId(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw adapterError("invalid_project_id", "A topic mode requires a projectId.");
  }
  return projectId.trim();
}

function auditActor(actor = {}) {
  return {
    userId: actor.userId ?? null,
    source: actor.source ?? null,
    messageId: actor.messageId ?? null
  };
}

function isoTimestamp(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return new Date().toISOString();
}

function topicIdentity(message) {
  if (message?.platform !== "zulip") {
    throw adapterError("invalid_topic_target", "Topic modes are only available for Zulip messages.");
  }
  return {
    targetKey: targetKeyFromMessage(message),
    stream: normalizeZulipStreamName(message.stream),
    topic: String(message.topic)
  };
}

export function getTopicRecord(state, { message, projectId }) {
  const project = requireProjectId(projectId);
  const { targetKey } = topicIdentity(message);
  const record = state?.zulipTopicModes?.[targetKey];
  if (!record || record.projectId !== project || !VALID_STORED_MODES.has(record.mode)) return null;
  return record;
}

export function getTopicMode(state, input) {
  return getTopicRecord(state, input)?.mode ?? TOPIC_MODES.AUTO;
}

export function setTopicMode(state, { message, projectId, mode, actor, now }) {
  if (!USER_SETTABLE_MODES.has(mode)) {
    throw adapterError("invalid_topic_mode", "User controls may set a topic only to AUTO or HERMES_ONLY.");
  }
  const project = requireProjectId(projectId);
  const identity = topicIdentity(message);
  const existing = getTopicRecord(state, { message, projectId: project });
  const previousMode = existing?.mode ?? TOPIC_MODES.AUTO;
  const previousTaskId = existing?.taskId ?? existing?.lastTaskId ?? null;

  if (previousMode === mode) {
    return { changed: false, previousMode, newMode: mode, previousTaskId, record: existing };
  }

  const record = {
    mode,
    projectId: project,
    stream: identity.stream,
    topic: identity.topic,
    ...(previousTaskId ? { lastTaskId: previousTaskId } : {}),
    updatedBy: auditActor(actor),
    updatedAt: isoTimestamp(now)
  };
  state.zulipTopicModes ??= {};
  state.zulipTopicModes[identity.targetKey] = record;
  return { changed: true, previousMode, newMode: mode, previousTaskId, record };
}

export function bindTopicTask(state, { message, projectId, taskId, actor, now }) {
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw adapterError("invalid_task_reference", "A topic can bind only a real non-empty taskId.");
  }
  const project = requireProjectId(projectId);
  const identity = topicIdentity(message);
  const existing = getTopicRecord(state, { message, projectId: project });
  const previousMode = existing?.mode ?? TOPIC_MODES.AUTO;
  if (previousMode === TOPIC_MODES.HERMES_ONLY) {
    throw adapterError("topic_hermes_only", "This topic is owned by Hermes and cannot bind a Codex task.");
  }

  const normalizedTaskId = taskId.trim();
  if (previousMode === TOPIC_MODES.CODEX_BOUND && existing.taskId === normalizedTaskId) {
    return {
      changed: false,
      previousMode,
      newMode: TOPIC_MODES.CODEX_BOUND,
      previousTaskId: normalizedTaskId,
      record: existing
    };
  }

  const record = {
    mode: TOPIC_MODES.CODEX_BOUND,
    projectId: project,
    stream: identity.stream,
    topic: identity.topic,
    taskId: normalizedTaskId,
    lastTaskId: normalizedTaskId,
    updatedBy: auditActor(actor),
    updatedAt: isoTimestamp(now)
  };
  state.zulipTopicModes ??= {};
  state.zulipTopicModes[identity.targetKey] = record;
  return {
    changed: true,
    previousMode,
    newMode: TOPIC_MODES.CODEX_BOUND,
    previousTaskId: existing?.taskId ?? existing?.lastTaskId ?? null,
    record
  };
}

export function clearTopicModesForStream(state, stream) {
  const normalized = normalizeZulipStreamName(stream).toLowerCase();
  let removed = 0;
  for (const [targetKey, record] of Object.entries(state?.zulipTopicModes ?? {})) {
    if (normalizeZulipStreamName(record?.stream).toLowerCase() !== normalized) continue;
    delete state.zulipTopicModes[targetKey];
    removed += 1;
  }
  return removed;
}
