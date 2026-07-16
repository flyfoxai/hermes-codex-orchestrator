import { adapterError } from "./errors.js";

export function normalizeZulipStreamName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function foldedRouteKey(value) {
  return normalizeZulipStreamName(value).toLowerCase();
}

function lookupRoute(map = {}, stream) {
  const normalized = normalizeZulipStreamName(stream);
  if (Object.hasOwn(map, stream)) return map[stream];
  if (Object.hasOwn(map, normalized)) return map[normalized];
  const folded = foldedRouteKey(normalized);
  for (const [key, projectId] of Object.entries(map)) {
    if (foldedRouteKey(key) === folded) return projectId;
  }
  return undefined;
}

function isGenericStream(state = {}, stream) {
  const map = state.zulipGenericStreams ?? {};
  const normalized = normalizeZulipStreamName(stream);
  if (map[stream] || map[normalized]) return true;
  const folded = foldedRouteKey(normalized);
  return Object.entries(map).some(([key, value]) => Boolean(value) && foldedRouteKey(key) === folded);
}

export function targetKeyFromMessage(message) {
  if (message?.platform === "zulip") {
    if (!message.stream || !message.topic) throw adapterError("invalid_message_target", "Zulip messages require stream and topic.");
    return `zulip:${message.stream}/${message.topic}`;
  }
  if (message?.platform === "hermes") {
    if (!message.conversationId) throw adapterError("invalid_message_target", "Hermes messages require conversationId.");
    return `hermes:${message.conversationId}`;
  }
  if (message?.platform === "feishu") {
    if (!message.conversationId) throw adapterError("invalid_message_target", "Feishu messages require conversationId.");
    return `feishu:${message.conversationId}`;
  }
  if (message?.platform === "harness") {
    if (!message.conversationId) throw adapterError("invalid_message_target", "Harness messages require conversationId.");
    return `harness:${message.conversationId}`;
  }
  throw adapterError("invalid_message_target", "Unsupported message platform.");
}

export function resolveZulipStreamProjectId({ stream, config = {}, state = {} }) {
  const normalized = normalizeZulipStreamName(stream);
  if (!normalized || isGenericStream(state, normalized)) return null;
  return lookupRoute(state.zulipStreamProjectRoutes, normalized)
    ?? lookupRoute(config.zulipStreamProjectRoutes, normalized)
    ?? null;
}

export function resolveProjectId({ command = {}, message = {}, config = {}, state = {} }) {
  if (message.platform === "zulip" && message.stream) {
    const stream = normalizeZulipStreamName(message.stream);
    const mappedProjectId = resolveZulipStreamProjectId({ stream, config, state });
    if (!mappedProjectId) {
      throw adapterError("route_hermes_owned", "This Zulip stream is owned by Hermes and is not associated with a project.", { stream });
    }
    if (command.projectId && command.projectId !== mappedProjectId) {
      throw adapterError("route_project_mismatch", "The requested project does not match this Zulip stream's project mapping.", {
        stream,
        mappedProjectId,
        requestedProjectId: command.projectId
      });
    }
    return mappedProjectId;
  }

  if (command.projectId) return command.projectId;

  if (message.platform) {
    try {
      const bound = state.bindings?.[targetKeyFromMessage(message)];
      if (bound) return bound;
    } catch (error) {
      if (error.code !== "invalid_message_target") throw error;
    }
  }

  if (config.defaultProjectId) return config.defaultProjectId;
  throw adapterError("route_unbound", "No project is bound to this target.");
}
