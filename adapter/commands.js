import { adapterError } from "./errors.js";

const TASK_ID_VERBS = new Set(["status", "logs", "raw", "cancel", "dispatch"]);
const NO_ARG_VERBS = new Set(["projects", "sessions"]);

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function invalidCommand(message) {
  throw adapterError("invalid_command", message);
}

export function parseCommand(text, options = {}) {
  const normalized = cleanText(text);
  if (!/^\/codex(?:\s|$)/i.test(normalized)) return null;
  const rest = normalized.replace(/^\/codex/i, "").trim();
  if (!rest) invalidCommand("Missing /codex command verb.");
  const [rawVerb, ...parts] = rest.split(" ");
  const verb = rawVerb.toLowerCase();
  const raw = text;

  if (NO_ARG_VERBS.has(verb)) {
    if (parts.length > 0) invalidCommand(`${verb} does not accept arguments.`);
    return { verb, raw };
  }

  if (verb === "bind") {
    if (parts.length !== 1) invalidCommand("Usage: /codex bind <projectId>.");
    return { verb, projectId: parts[0], raw };
  }

  if (verb === "route") {
    const [action, projectId, ...extra] = parts;
    if (extra.length > 0) invalidCommand("Usage: /codex route show|set <projectId>|confirm <projectId>|unset|none.");
    if (action === "show" || action === "unset" || action === "none") {
      if (projectId) invalidCommand(`Usage: /codex route ${action}.`);
      return { verb, action, raw };
    }
    if (action === "set" || action === "confirm") {
      if (!projectId) invalidCommand(`Usage: /codex route ${action} <projectId>.`);
      return { verb, action, projectId, raw };
    }
    invalidCommand("Usage: /codex route show|set <projectId>|confirm <projectId>|unset|none.");
  }

  if (verb === "topic") {
    const [action, ...extra] = parts;
    if (!new Set(["show", "auto", "hermes"]).has(action) || extra.length > 0) {
      invalidCommand("Usage: /codex topic show|auto|hermes.");
    }
    return { verb, action, raw };
  }

  if (verb === "ask") {
    const goal = cleanText(parts.join(" ")).slice(0, 2000);
    if (!goal) invalidCommand("Usage: /codex ask <task>.");
    return { verb, goal, raw };
  }

  if (verb === "run") {
    if (options.inferProjectForRun) {
      if (parts[0] === "--project") {
        const [, projectId, ...goalParts] = parts;
        const goal = cleanText(goalParts.join(" ")).slice(0, 2000);
        if (!projectId || !goal) invalidCommand("Usage: /codex run --project <projectId> <task>.");
        return { verb, projectId, goal, raw };
      }

      const goal = cleanText(parts.join(" ")).slice(0, 2000);
      if (!goal) invalidCommand("Usage: /codex run <task>.");
      return { verb, goal, raw };
    }

    const [projectId, ...goalParts] = parts;
    const goal = cleanText(goalParts.join(" ")).slice(0, 2000);
    if (!projectId || !goal) invalidCommand("Usage: /codex run <projectId> <task>.");
    return { verb, projectId, goal, raw };
  }

  if (TASK_ID_VERBS.has(verb)) {
    if (parts.length !== 1) invalidCommand(`Usage: /codex ${verb} <taskId>.`);
    return { verb, taskId: parts[0], raw };
  }

  invalidCommand(`Unknown /codex command: ${verb}.`);
}
