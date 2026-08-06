const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);

const DEFAULT_APPROVAL_DECISIONS = Object.freeze(["accept", "cancel"]);
const ACTION_CLASSES = new Set([
  "one_time_allow",
  "file_change_allow",
  "deny",
  "policy_change",
  "network_policy_change",
  "choice_input"
]);

export const NATURAL_ALLOW_ALIASES = Object.freeze(new Set([
  "同意", "可以", "批准", "确认执行", "ok", "okay", "yes"
]));

export const NATURAL_DENY_ALIASES = Object.freeze(new Set([
  "不同意", "拒绝", "取消", "no", "cancel"
]));

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compactLabel(value, maximumBytes = 100) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  let output = "";
  for (const character of text) {
    if (Buffer.byteLength(`${output}${character}...`, "utf8") > maximumBytes) break;
    output += character;
  }
  return `${output}...`;
}

export function approvalDecisionKey(decision) {
  if (typeof decision === "string" && decision) return decision;
  if (!isPlainObject(decision)) return null;
  const keys = Object.keys(decision);
  return keys.length === 1 && keys[0] ? keys[0] : null;
}

function actionStyle(actionClass) {
  if (actionClass === "deny") return "danger";
  if (actionClass === "policy_change" || actionClass === "network_policy_change") return "warning";
  return "primary";
}

function approvalActionClass(method, key) {
  const normalized = key.toLowerCase();
  if (normalized === "decline" || normalized === "cancel" || normalized === "deny") return "deny";
  if (normalized.includes("network") && normalized.includes("amendment")) return "network_policy_change";
  if (normalized.includes("execpolicy") || normalized.includes("amendment") || normalized.includes("forsession")) {
    return "policy_change";
  }
  if (normalized === "accept" && method === "item/fileChange/requestApproval") return "file_change_allow";
  if (normalized === "accept") return "one_time_allow";
  return normalized.startsWith("accept") ? "policy_change" : null;
}

function approvalActionLabel(actionClass, key) {
  if (actionClass === "one_time_allow") return "仅本次允许";
  if (actionClass === "file_change_allow") return "仅本次应用变更";
  if (actionClass === "deny") return key.toLowerCase() === "cancel" ? "取消" : "拒绝";
  if (actionClass === "network_policy_change") return "允许并更新网络策略";
  if (actionClass === "policy_change") {
    return key.toLowerCase().includes("forsession") ? "允许本会话" : "允许并更新命令策略";
  }
  return key;
}

function approvalSpecs(method, request) {
  const decisions = Array.isArray(request.availableDecisions) && request.availableDecisions.length > 0
    ? request.availableDecisions
    : DEFAULT_APPROVAL_DECISIONS;
  const seen = new Set();
  const specs = [];
  for (const decision of decisions) {
    const sourceKey = approvalDecisionKey(decision);
    if (!sourceKey || seen.has(sourceKey)) continue;
    const actionClass = approvalActionClass(method, sourceKey);
    if (!actionClass) continue;
    seen.add(sourceKey);
    specs.push({
      sourceKey,
      actionClass,
      label: approvalActionLabel(actionClass, sourceKey),
      style: actionStyle(actionClass),
      answer: { decision },
      naturalAliasEligible: ["one_time_allow", "file_change_allow", "deny"].includes(actionClass)
    });
  }
  return specs;
}

function choiceInputSpecs(request) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length !== 1 || !isPlainObject(questions[0]) || questions[0].isSecret === true) return [];
  const question = questions[0];
  if (typeof question.id !== "string" || !question.id || !Array.isArray(question.options)) return [];
  const specs = [];
  const seen = new Set();
  for (const option of question.options) {
    if (!isPlainObject(option) || typeof option.label !== "string" || !option.label || seen.has(option.label)) continue;
    seen.add(option.label);
    specs.push({
      sourceKey: option.label,
      actionClass: "choice_input",
      label: compactLabel(option.label),
      style: "primary",
      answer: { answers: { [question.id]: { answers: [option.label] } } },
      naturalAliasEligible: false
    });
  }
  return specs;
}

export function interactionActionSpecs(method, request) {
  const requestObject = isPlainObject(request) ? request : {};
  if (APPROVAL_METHODS.has(method)) return approvalSpecs(method, requestObject);
  if (method === "item/tool/requestUserInput") return choiceInputSpecs(requestObject);
  return [];
}

export function isInteractionActionClass(value) {
  return ACTION_CLASSES.has(value);
}

export function normalizeNaturalAlias(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFKC");
  if (!normalized) return null;
  const folded = /^[\x00-\x7F]+$/u.test(normalized) ? normalized.toLowerCase() : normalized;
  if (NATURAL_ALLOW_ALIASES.has(folded)) return { alias: folded, intent: "allow" };
  if (NATURAL_DENY_ALIASES.has(folded)) return { alias: folded, intent: "deny" };
  return null;
}
