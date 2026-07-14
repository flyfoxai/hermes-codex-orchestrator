import { adapterError } from "./errors.js";

export function targetKeyFromMessage(message) {
  if (message?.platform === "zulip") {
    if (!message.stream || !message.topic) throw adapterError("invalid_message_target", "Zulip messages require stream and topic.");
    return `zulip:${message.stream}/${message.topic}`;
  }
  if (message?.platform === "hermes") {
    if (!message.conversationId) throw adapterError("invalid_message_target", "Hermes messages require conversationId.");
    return `hermes:${message.conversationId}`;
  }
  if (message?.platform === "harness") {
    if (!message.conversationId) throw adapterError("invalid_message_target", "Harness messages require conversationId.");
    return `harness:${message.conversationId}`;
  }
  throw adapterError("invalid_message_target", "Unsupported message platform.");
}

export function resolveProjectId({ command = {}, message = {}, config = {}, state = {} }) {
  if (command.projectId) return command.projectId;

  if (message.platform === "zulip" && message.stream && message.topic) {
    const routed = config.zulipProjectRoutes?.[`${message.stream}/${message.topic}`];
    if (routed) return routed;
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
