import { adapterError } from "./errors.js";

export function normalizeZulipStreamName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function foldedRouteKey(value) {
  return normalizeZulipStreamName(value).toLowerCase();
}

function compactRouteKey(value) {
  return foldedRouteKey(value).replace(/[\s_-]+/g, "");
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

function projectList(projects) {
  if (Array.isArray(projects)) return projects;
  if (Array.isArray(projects?.projects)) return projects.projects;
  return [];
}

function suggestProjects(stream, projects) {
  const streamCompact = compactRouteKey(stream);
  if (!streamCompact) return [];
  return projectList(projects)
    .map((project) => project.projectId)
    .filter(Boolean)
    .filter((projectId) => compactRouteKey(projectId) === streamCompact)
    .slice(0, 5);
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

export function resolveProjectId({ command = {}, message = {}, config = {}, state = {}, projects = [] }) {
  if (command.projectId) return command.projectId;

  if (message.platform === "zulip" && message.stream) {
    const stream = normalizeZulipStreamName(message.stream);
    if (isGenericStream(state, stream)) {
      throw adapterError("route_generic", "This Zulip stream is marked as generic and is not associated with a project.", {
        stream
      });
    }

    const runtimeProjectId = lookupRoute(state.zulipStreamProjectRoutes, stream);
    if (runtimeProjectId) return runtimeProjectId;

    const configuredProjectId = lookupRoute(config.zulipStreamProjectRoutes, stream);
    if (configuredProjectId) return configuredProjectId;

    const knownProjects = projectList(projects);
    const exactProject = knownProjects.find((project) => project.projectId === stream);
    if (exactProject) return exactProject.projectId;

    if (knownProjects.length > 0) {
      throw adapterError("route_confirmation_required", "Zulip stream is not associated with a registered project.", {
        stream,
        suggestions: suggestProjects(stream, knownProjects),
        projectIds: knownProjects.map((project) => project.projectId).filter(Boolean).slice(0, 20)
      });
    }

    throw adapterError("route_confirmation_required", "Zulip stream is not associated with a registered project.", {
      stream,
      suggestions: [],
      projectIds: []
    });
  }

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
