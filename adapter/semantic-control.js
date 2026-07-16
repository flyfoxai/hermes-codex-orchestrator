import { adapterError, permissionDenied } from "./errors.js";
import { checkPermission } from "./permissions.js";
import { resolveProjectId, targetKeyFromMessage } from "./router.js";
import { loadState, saveState } from "./state-store.js";
import { setTopicMode, TOPIC_MODES } from "./topic-mode.js";

const CONTROL_MODES = new Set([TOPIC_MODES.AUTO, TOPIC_MODES.HERMES_ONLY]);

function validateControl(control) {
  if (
    control?.type !== "CONTROL"
    || control?.action !== "SET_TOPIC_MODE"
    || !CONTROL_MODES.has(control?.mode)
  ) {
    throw adapterError(
      "model_protocol_error",
      "Hermes CONTROL output must be SET_TOPIC_MODE with mode AUTO or HERMES_ONLY."
    );
  }
}

function resultText(result) {
  if (!result.changed) return `当前话题已经是 ${result.newMode}，无需重复设置。`;
  if (result.newMode === TOPIC_MODES.AUTO) {
    return "已将当前话题设为 AUTO；Hermes 可在需要项目执行时再次派发 Codex。";
  }
  const lines = ["已将当前话题设为 HERMES_ONLY；后续消息不会自动派发 Codex。"];
  if (result.previousTaskId) {
    lines.push(`任务 ${result.previousTaskId} 没有取消；如需停止，请使用 /codex cancel ${result.previousTaskId}。`);
  }
  return lines.join("\n");
}

export async function applySemanticControl({ control, message, config = {}, statePath, now }) {
  validateControl(control);
  const state = await loadState(statePath);
  const projectId = resolveProjectId({ command: {}, message, config, state });
  const permission = checkPermission({ command: { verb: "topic", action: control.mode }, user: message.user });
  if (!permission.allowed) throw permissionDenied(permission.reason);

  const transition = setTopicMode(state, {
    message,
    projectId,
    mode: control.mode,
    actor: {
      userId: message.user?.id ?? null,
      source: message.platform,
      messageId: message.messageId ?? null
    },
    now
  });
  if (transition.changed) await saveState(statePath, state);

  return {
    ok: true,
    targetKey: targetKeyFromMessage(message),
    projectId,
    previousMode: transition.previousMode,
    newMode: transition.newMode,
    changed: transition.changed,
    previousTaskId: transition.previousTaskId,
    record: transition.record,
    text: resultText(transition)
  };
}
