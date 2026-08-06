import { createHash, randomUUID } from "node:crypto";

import { renderFinal } from "./delivery/renderer.js";
import { requestMayHaveBeenWritten, validateExecutionBackend } from "./execution/backend.js";
import { findTurnByClientId, findTurnById, isTerminalTurn, reduceTerminalOutput } from "./recovery.js";
import { isStateError, stateError } from "./state/reducer.js";

const OWNED_ERRORS = new WeakSet();
const INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);
const MAX_CONTENT_UTF8_BYTES = 60_000;
const INTERACTION_DETAIL_CHUNK_BYTES = 44 * 1024;
const MAX_INTERACTION_DETAIL_CHUNKS = 16;
const MAX_INTERACTION_DETAIL_BYTES = 8 * 1024 * 1024;
const MAX_CLI_TOKEN_UTF8_BYTES = 256;
const MAX_COMPACT_LABEL_UTF8_BYTES = 100;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value);
  let output = "";
  let length = 0;
  for (const character of text) {
    const next = byteLength(character);
    if (length + next > maximumBytes) break;
    output += character;
    length += next;
  }
  return output;
}

function escapeMarkdownInline(value) {
  return String(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/`/gu, "\\`")
    .replace(/\*/gu, "\\*")
    .replace(/_/gu, "\\_")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]")
    .replace(/\(/gu, "\\(")
    .replace(/\)/gu, "\\)")
    .replace(/</gu, "\\<")
    .replace(/>/gu, "\\>");
}

// Returns [openFence, content, closeFence] so the command is displayed verbatim.
// The fence length is extended past the longest backtick run in the content to
// prevent the code fence from closing prematurely.
function fencedCodeBlock(content) {
  const str = String(content);
  const maxRun = (str.match(/`+/gu) || []).reduce((max, s) => Math.max(max, s.length), 0);
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return [fence, str, fence];
}

// Wraps an arbitrary value in a Markdown inline code span without backslash-
// escaping its contents (backslash is not a code-span escape in CommonMark).
// The fence length is extended past the longest backtick run, and spaces are
// added when the content starts or ends with a backtick to avoid mis-parsing.
function codeSpan(value) {
  const str = String(value);
  const maxRun = (str.match(/`+/gu) || []).reduce((max, s) => Math.max(max, s.length), 0);
  const fence = "`".repeat(maxRun + 1);
  const inner = (str.startsWith("`") || str.endsWith("`")) ? ` ${str} ` : str;
  return `${fence}${inner}${fence}`;
}

function splitUtf8(value, maximumBytes) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const character of String(value)) {
    const characterBytes = byteLength(character);
    if (current && currentBytes + characterBytes > maximumBytes) {
      const newline = current.lastIndexOf("\n");
      if (newline >= Math.floor(current.length / 2)) {
        chunks.push(current.slice(0, newline + 1));
        current = current.slice(newline + 1) + character;
        currentBytes = byteLength(current);
      } else {
        chunks.push(current);
        current = character;
        currentBytes = characterBytes;
      }
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function approvalDetail(interaction) {
  const request = isPlainObject(interaction.request) ? interaction.request : {};
  const parts = [
    `交互 ID: ${interaction.interactionId}`,
    `类型: ${interaction.method}`,
    `过期时间(ms): ${interaction.expiresAt}`
  ];
  if (interaction.approvalId) parts.push(`审批 ID: ${interaction.approvalId}`);
  if (interaction.itemId) parts.push(`项目项 ID: ${interaction.itemId}`);
  if (typeof request.reason === "string" && request.reason) parts.push(`原因:\n${request.reason}`);
  if (typeof request.cwd === "string" && request.cwd) parts.push(`工作目录:\n${request.cwd}`);
  if (typeof request.command === "string" && request.command) parts.push(`待审批命令:\n${request.command}`);
  if (request.proposedExecpolicyAmendment !== undefined) {
    parts.push(`命令策略变更建议:\n${JSON.stringify(request.proposedExecpolicyAmendment, null, 2)}`);
  }
  if (request.proposedNetworkPolicyAmendments !== undefined || request.networkApprovalContext !== undefined) {
    parts.push(`网络权限上下文:\n${JSON.stringify({
      networkApprovalContext: request.networkApprovalContext,
      proposedNetworkPolicyAmendments: request.proposedNetworkPolicyAmendments
    }, null, 2)}`);
  }
  const complexDecisions = interaction.actions
    .filter((action) => ["policy_change", "network_policy_change"].includes(action.actionClass))
    .map((action) => ({ label: action.label, sourceKey: action.sourceKey, answer: action.answer }));
  if (complexDecisions.length > 0) parts.push(`策略类选项完整内容:\n${JSON.stringify(complexDecisions, null, 2)}`);
  return parts.join("\n\n");
}

function structuredApprovalRender(interaction) {
  const detailContent = approvalDetail(interaction);
  const detailBytes = byteLength(detailContent);
  if (detailBytes > MAX_INTERACTION_DETAIL_BYTES) {
    throw controllerError("INTERACTION_DETAIL_TOO_LARGE", "Interaction detail exceeds the configured hard limit.");
  }
  const detailSha256 = createHash("sha256").update(detailContent, "utf8").digest("hex");
  const chunks = splitUtf8(detailContent, INTERACTION_DETAIL_CHUNK_BYTES);
  const shortId = truncateUtf8(interaction.interactionId, 48);
  const documentMode = chunks.length > MAX_INTERACTION_DETAIL_CHUNKS;
  const detailMode = documentMode ? "document" : (chunks.length === 1 ? "inline" : "chunks");
  const deliveries = documentMode
    ? [{
        semanticKey: `interaction:${interaction.interactionId}:document:${detailSha256.slice(0, 12)}`,
        role: "detail",
        chunkIndex: 0,
        payload: {
          schemaVersion: 2,
          kind: "interaction_document",
          content: [
            `[interaction ${shortId} detail document sha256:${detailSha256.slice(0, 16)}]`,
            "",
            "完整审批详情见随附 Markdown 文档。"
          ].join("\n"),
          document: {
            schemaVersion: 1,
            kind: "interaction_detail",
            displayName: `interaction-${detailSha256.slice(0, 12)}-approval.md`,
            mimeType: "text/markdown",
            bytes: detailBytes,
            sha256: detailSha256,
            textContent: detailContent
          }
        }
      }]
    : chunks.map((chunk, index) => ({
        semanticKey: `interaction:${interaction.interactionId}:detail:${index}:${detailSha256.slice(0, 12)}`,
        role: "detail",
        chunkIndex: index,
        payload: {
          schemaVersion: 2,
          kind: "interaction_detail",
          content: [
            `[interaction ${shortId} detail ${index + 1}/${chunks.length} sha256:${detailSha256.slice(0, 16)}]`,
            "",
            ...fencedCodeBlock(chunk)
          ].join("\n")
        }
      }));
  const safeInteractionId = isSafeCliToken(interaction.interactionId);
  const visibleActions = safeInteractionId
    ? interaction.actions.filter((action) => isSafeCliToken(action.actionId))
    : [];
  const lines = [
    "⚠️ **审批请求**",
    "",
    `交互: ${codeSpan(interaction.interactionId)}`,
    `详情 SHA-256: ${codeSpan(detailSha256)}`,
    `过期时间(ms): ${interaction.expiresAt}`,
    "",
    "**可选操作**（在本话题回复）:"
  ];
  for (const action of visibleActions) {
    lines.push(`- ${escapeMarkdownInline(action.label)}: \`/codex interact ${interaction.interactionId} ${action.actionId}\``);
    if (isSafeCliToken(action.sourceKey) &&
        !["policy_change", "network_policy_change"].includes(action.actionClass)) {
      lines.push(`  兼容命令: \`/codex approve ${interaction.interactionId} ${action.sourceKey}\``);
    }
  }
  if (visibleActions.length === 0) lines.push("- 请通过 App Server UI 操作。");
  const actionPayload = {
    schemaVersion: 2,
    kind: "interaction_request",
    content: lines.join("\n"),
    interaction: {
      interactionId: interaction.interactionId,
      interactionType: interaction.method === "item/fileChange/requestApproval"
        ? "file_change_approval"
        : "command_approval",
      objectiveId: interaction.objectiveId,
      expiresAt: interaction.expiresAt,
      detail: {
        mode: detailMode,
        bytes: detailBytes,
        sha256: detailSha256,
        state: "delivered"
      },
      actions: visibleActions.map((action) => ({
        actionId: action.actionId,
        label: action.label,
        style: action.style,
        class: action.actionClass,
        naturalAliasEligible: action.naturalAliasEligible
      }))
    }
  };
  if (visibleActions.length > 0) {
    actionPayload.ui = {
      type: "choices",
      heading: "请选择本次操作",
      actionIds: visibleActions.map((action) => action.actionId)
    };
  }
  deliveries.push({
    semanticKey: `interaction:${interaction.interactionId}:prompt:${detailSha256.slice(0, 12)}`,
    role: "action_prompt",
    chunkIndex: null,
    payload: actionPayload
  });
  return {
    detail: {
      mode: detailMode,
      contentSha256: detailSha256,
      contentBytes: detailBytes
    },
    deliveries
  };
}

function isSafeCliToken(value) {
  return typeof value === "string" && value.length > 0 &&
    byteLength(value) <= MAX_CLI_TOKEN_UTF8_BYTES &&
    !/[\s\x00-\x1F\x7F\x85`"'<>[\]{}()|;\\/]/u.test(value);
}

function hasSecretQuestion(questions) {
  return questions.some((question) => isPlainObject(question) && question.isSecret === true);
}

function safeQuestionId(id) {
  return isSafeCliToken(id);
}

function analyzeQuestions(rawQuestions) {
  const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
  const seen = new Set();
  let allAddressable = questions.length > 0;
  for (const question of questions) {
    if (!isPlainObject(question) || !safeQuestionId(question.id) || seen.has(question.id) || question.isSecret === true) {
      allAddressable = false;
      break;
    }
    seen.add(question.id);
  }
  return { questions, allAddressable, hasSecret: hasSecretQuestion(questions) };
}

function compactLabel(question, index) {
  const label = typeof question?.header === "string" && question.header
    ? question.header
    : (typeof question?.question === "string" && question.question ? question.question : question?.id ?? `问题 ${index + 1}`);
  return escapeMarkdownInline(truncateUtf8(label, MAX_COMPACT_LABEL_UTF8_BYTES));
}

function hardFallbackContent(interactionId, method, { hasSecret = false } = {}) {
  const parts = [
    "⚠️ **交互通知过大，已生成极简版**",
    "",
    `_reply token_: ${codeSpan(interactionId)}`
  ];
  if (hasSecret) parts.push("⚠️ 此交互含敏感输入；请通过 App Server UI 查看并操作。");
  if (APPROVAL_METHODS.has(method)) {
    parts.push("请通过 App Server UI 查看审批详情并操作。");
  } else if (method === "item/tool/requestUserInput") {
    parts.push("请通过 App Server UI 查看输入请求并操作。");
  } else {
    parts.push("请通过 App Server UI 查看交互详情并操作。");
  }
  return parts.join("\n");
}

function toCompactContent(interactionId, method, context = {}) {
  const { questions = [], allAddressable = false, hasSecret = false } = context;
  const safeId = isSafeCliToken(interactionId);
  const parts = [
    "⚠️ **交互通知过大，已生成精简版**",
    "",
    `_reply token_: ${codeSpan(interactionId)}`
  ];

  if (method === "item/tool/requestUserInput") {
    if (hasSecret) parts.push("⚠️ 此交互含敏感输入；桥接仅提示敏感性，不加密持久化内容。");
    if (!allAddressable || !safeId) {
      parts.push("⚠️ 此请求无法通过命令行完整回答，请使用 App Server UI。");
    } else if (questions.length <= 1) {
      parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
    } else {
      for (const [index, question] of questions.slice(0, 5).entries()) {
        parts.push(`回答「${compactLabel(question, index)}」: \`/codex answer ${interactionId} ${question.id} <答案>\``);
      }
      if (questions.length > 5) parts.push(`...还有 ${questions.length - 5} 个问题`);
    }
  } else {
    parts.push("请通过 App Server UI 查看交互详情并操作。");
  }
  parts.push("", "_完整详情请通过 App Server UI 查看。_");
  const compact = parts.join("\n");
  return byteLength(compact) <= MAX_CONTENT_UTF8_BYTES
    ? compact
    : hardFallbackContent(interactionId, method, { hasSecret });
}

function controllerError(code, message) {
  const error = new Error(message);
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isTurnControllerError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

function requireText(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096;
}

function validateIntent(input) {
  const hasArtifacts = input !== null && typeof input === "object" && input.artifacts !== undefined;
  const hasArtifactBaseDir = input !== null && typeof input === "object" && input.artifactBaseDir !== undefined;
  if (
    input === null || typeof input !== "object" ||
    !requireText(input.sourceType) || !requireText(input.sourceId) ||
    !requireText(input.objectiveId) || !["app-server", "tmux"].includes(input.backend) ||
    typeof input.text !== "string" ||
    input.targetSnapshot === null || typeof input.targetSnapshot !== "object" || Array.isArray(input.targetSnapshot) ||
    (input.threadOptions !== undefined && (input.threadOptions === null || typeof input.threadOptions !== "object" || Array.isArray(input.threadOptions))) ||
    (input.artifactMode !== undefined && !["legacy", "project_local", "managed"].includes(input.artifactMode)) ||
    (input.artifactMode === "managed" && hasArtifacts) ||
    (input.artifactMode === "project_local" && !hasArtifacts) ||
    hasArtifacts !== hasArtifactBaseDir ||
    (hasArtifactBaseDir && !requireText(input.artifactBaseDir))
  ) {
    throw controllerError("TURN_INTENT_INVALID", "Turn intent is invalid.");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defaultInteractionRenderer({ interaction }) {
  const {
    interactionId,
    method,
    request,
    approvalId,
    itemId,
    allowedResponderIds
  } = interaction;
  let content;
  const requestObject = isPlainObject(request) ? request : {};
  let questions = [];
  let allAddressable = false;
  let hasSecret = false;
  try {
    const textFields = ["reason", "prompt", "question", "message"];
    const responderLine = Array.isArray(allowedResponderIds) && allowedResponderIds.length > 0
      ? `允许响应者 ID: ${allowedResponderIds.map((id) => escapeMarkdownInline(id)).join(", ")}`
      : null;

    if (APPROVAL_METHODS.has(method)) {
      return structuredApprovalRender(interaction);
    } else if (method === "item/tool/requestUserInput") {
      const parts = ["💬 **输入请求**", ""];
      ({ questions, allAddressable, hasSecret } = analyzeQuestions(requestObject.questions));
      if (hasSecret) {
        parts.push("此请求包含敏感输入。问题正文和答案不会发送到 Zulip；请通过 App Server UI 完成。");
      } else if (questions.length > 0) {
        questions.forEach((question, index) => {
          if (!isPlainObject(question)) return;
          const header = typeof question.header === "string" && question.header ? question.header : `问题 ${index + 1}`;
          parts.push(`**${escapeMarkdownInline(header)}**`);
          if (typeof question.question === "string" && question.question) parts.push(escapeMarkdownInline(question.question));
          if (typeof question.id === "string" && question.id) parts.push(`(ID: ${codeSpan(question.id)})`);
          if (Array.isArray(question.options) && question.options.length > 0) {
            parts.push("选项:");
            for (const option of question.options) {
              if (!isPlainObject(option) || typeof option.label !== "string") continue;
              const description = typeof option.description === "string" && option.description
                ? ` - ${escapeMarkdownInline(option.description)}`
                : "";
              parts.push(`- ${codeSpan(option.label)}${description}`);
            }
          }
          const isAddressable = safeQuestionId(question.id) && question.isSecret !== true;
          if (!allAddressable && !isAddressable) {
            parts.push(`回答「${escapeMarkdownInline(header)}」: _此问题 ID 无法通过命令回答。_`);
          } else if (allAddressable && isSafeCliToken(interactionId) && questions.length > 1) {
            parts.push(`回答「${escapeMarkdownInline(header)}」: \`/codex answer ${interactionId} ${question.id} <你的回答>\``);
          }
          parts.push("");
        });
      } else {
        for (const field of textFields) {
          if (typeof requestObject[field] === "string" && requestObject[field]) {
            parts.push(`${field}: ${escapeMarkdownInline(requestObject[field])}`);
          }
        }
      }
      if (typeof requestObject.toolName === "string" && requestObject.toolName) {
        parts.push(`工具: ${escapeMarkdownInline(requestObject.toolName)}`);
      } else if (itemId) {
        parts.push(`项目项 ID: ${escapeMarkdownInline(itemId)}`);
      }
      if (responderLine) parts.push(responderLine);
      parts.push("", `_reply token_: ${codeSpan(interactionId)}`);
      if (hasSecret) {
        parts.push("请通过 App Server UI 完成敏感输入。");
      } else if (questions.length > 0 && !allAddressable) {
        parts.push("⚠️ 此交互包含不可寻址的 question ID，无法通过命令行回答，请使用 App Server UI 完成。");
      } else if (questions.length > 1) {
        parts.push("每题一条命令，全部回答后自动提交。");
      } else if (isSafeCliToken(interactionId)) {
        parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
      } else {
        parts.push("请通过 App Server UI 查看输入请求并操作。");
      }
      content = parts.join("\n");
    } else {
      content = [
        "Interaction requested.",
        "",
        `_reply token_: ${codeSpan(interactionId)}`,
        "请通过 App Server UI 查看并操作。"
      ].join("\n");
    }
  } catch (error) {
    if (isTurnControllerError(error)) throw error;
    content = hardFallbackContent(interactionId, method, { hasSecret });
  }
  if (byteLength(content) > MAX_CONTENT_UTF8_BYTES) {
    content = toCompactContent(interactionId, method, {
      requestObject,
      questions,
      allAddressable,
      hasSecret
    });
  }
  const payload = { content, kind: "interaction_request" };
  const visibleActions = isSafeCliToken(interactionId)
    ? (interaction.actions ?? []).filter((action) => isSafeCliToken(action.actionId)).slice(0, 10)
    : [];
  if (visibleActions.length > 0) {
    payload.schemaVersion = 2;
    payload.content += visibleActions.map((action) =>
      `\n- ${escapeMarkdownInline(action.label)}: \`/codex interact ${interactionId} ${action.actionId}\``
    ).join("");
    payload.interaction = {
      interactionId,
      interactionType: "choice_input",
      objectiveId: interaction.objectiveId,
      expiresAt: interaction.expiresAt,
      actions: visibleActions.map((action) => ({
        actionId: action.actionId,
        label: action.label,
        style: action.style,
        class: action.actionClass,
        naturalAliasEligible: false
      }))
    };
    payload.ui = {
      type: "choices",
      heading: "请选择",
      actionIds: visibleActions.map((action) => action.actionId)
    };
  }
  return {
    semanticKey: `interaction:${interactionId}:prompt`,
    payload
  };
}

function validateInteractionRequest(input) {
  if (!isPlainObject(input) || !requireText(input.connectionId) ||
      !["string", "number", "bigint"].includes(typeof input.wireRequestId) ||
      !requireText(input.objectiveId) || !requireText(input.threadId) || !requireText(input.turnId) ||
      (input.itemId !== null && input.itemId !== undefined && !requireText(input.itemId)) ||
      (input.approvalId !== null && input.approvalId !== undefined && !requireText(input.approvalId)) ||
      !isPlainObject(input.request) || !Array.isArray(input.allowedResponderIds) ||
      !isPlainObject(input.targetSnapshot)) {
    throw controllerError("INTERACTION_REQUEST_INVALID", "Interaction request is invalid.");
  }
  if (!INTERACTION_METHODS.has(input.method)) {
    throw controllerError("INTERACTION_REQUEST_UNSUPPORTED", "Interaction request method is unsupported.");
  }
}

function validateInteractionAnswer(input) {
  if (!isPlainObject(input) || !requireText(input.interactionId) ||
      !Number.isSafeInteger(input.responderId) || input.responderId <= 0 ||
      !isPlainObject(input.targetSnapshot) || !isPlainObject(input.answer) ||
      (input.audit !== undefined && input.audit !== null && !isPlainObject(input.audit))) {
    throw controllerError("INTERACTION_ANSWER_INVALID", "Interaction answer is invalid.");
  }
}

export class TurnController {
  #appServerBackend;
  #legacyArtifactsEnabled;
  #leaseOwner;
  #interactionRenderer;
  #renderer;
  #store;
  #tmuxBackend;

  constructor({
    store,
    appServerBackend,
    tmuxBackend,
    legacyArtifactsEnabled = false,
    leaseOwner = `controller-${randomUUID()}`,
    renderer = renderFinal,
    interactionRenderer = defaultInteractionRenderer
  } = {}) {
    if (
      store === null || typeof store !== "object" ||
      typeof store.registerExecutionIntent !== "function" ||
      typeof store.bindBackendObjective !== "function" ||
      typeof store.replaceMissingObjectiveThread !== "function" ||
      typeof store.markReplacementThreadStartUncertain !== "function" ||
      typeof store.prepareTurnSubmission !== "function" ||
      typeof store.acknowledgeTurnSubmission !== "function" ||
      typeof store.markSubmissionUnknown !== "function" ||
      typeof store.resolveObjectiveThread !== "function" ||
      typeof store.markTurnReconciliationNeeded !== "function" ||
      typeof store.markBackendFailure !== "function" ||
      typeof store.markConnectionLost !== "function" ||
      typeof store.reconcileTerminalTurn !== "function" ||
      typeof store.reconcileTurnSubmission !== "function" ||
      typeof store.completeTurn !== "function" ||
      typeof store.readTurnOutput !== "function" ||
      typeof store.requestCancellation !== "function" ||
      typeof store.confirmCancellation !== "function" ||
      typeof store.recordTurnAuditFact !== "function" ||
      typeof store.createInteraction !== "function" ||
      typeof store.commitInteractionAnswer !== "function" ||
      typeof store.claimInteractionResponse !== "function" ||
      typeof store.recordInteractionResponseDelivery !== "function" ||
      typeof store.orphanInteractions !== "function" ||
      typeof store.readInteraction !== "function" ||
      typeof store.readTurnSubmission !== "function" ||
      typeof store.readObjectiveExecution !== "function" ||
      typeof legacyArtifactsEnabled !== "boolean" ||
      !requireText(leaseOwner) || typeof renderer !== "function" || typeof interactionRenderer !== "function"
    ) {
      throw controllerError("TURN_CONTROLLER_OPTIONS_INVALID", "Turn controller options are invalid.");
    }
    this.#store = store;
    this.#appServerBackend = validateExecutionBackend(appServerBackend);
    this.#tmuxBackend = tmuxBackend === undefined ? null : validateExecutionBackend(tmuxBackend);
    this.#legacyArtifactsEnabled = legacyArtifactsEnabled;
    if (this.#appServerBackend.getCapabilities().backend !== "app-server" ||
        (this.#tmuxBackend && this.#tmuxBackend.getCapabilities().backend !== "tmux")) {
      throw controllerError("TURN_CONTROLLER_OPTIONS_INVALID", "Turn controller options are invalid.");
    }
    this.#leaseOwner = leaseOwner;
    this.#renderer = renderer;
    this.#interactionRenderer = interactionRenderer;
  }

  async acceptIntent(input) {
    validateIntent(input);
    if (input.artifactMode === "managed") {
      throw controllerError(
        "FILE_EXCHANGE_UNSUPPORTED",
        "Execution transport does not expose the managed file exchange capability."
      );
    }
    if (input.artifacts !== undefined && input.artifactMode !== "project_local" && !this.#legacyArtifactsEnabled) {
      throw controllerError(
        "FILE_EXCHANGE_UNSUPPORTED",
        "This execution transport does not provide managed file exchange; legacy project artifacts are disabled."
      );
    }
    const registered = this.#store.registerExecutionIntent(input);
    if (registered.duplicate) {
      return Object.freeze({
        status: "duplicate",
        objectiveId: registered.objectiveId,
        submissionId: registered.submissionId,
        clientUserMessageId: registered.clientUserMessageId,
        turnId: registered.turnId,
        threadId: registered.execution?.threadId ?? null
      });
    }
    if (registered.terminal) {
      return Object.freeze({
        status: registered.execution.executionStatus,
        objectiveId: registered.objectiveId
      });
    }
    if (registered.busy) return Object.freeze({ status: "busy", objectiveId: input.objectiveId });

    const backend = this.#selectedBackend(input.backend);
    if (!backend) {
      this.#store.markBackendFailure({ objectiveId: input.objectiveId, uncertain: false });
      return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
    }

    let execution = registered.execution;
    if (registered.needsObjectiveStart) {
      try {
        const started = input.backend === "app-server"
          ? await backend.startObjective({ objectiveId: input.objectiveId, threadOptions: input.threadOptions ?? {} })
          : await backend.startObjective({ objectiveId: input.objectiveId });
        execution = this.#store.bindBackendObjective({
          objectiveId: input.objectiveId,
          backend: input.backend,
          threadId: input.backend === "app-server" ? started.threadId : null
        });
      } catch (error) {
        const uncertain = requestMayHaveBeenWritten(error);
        this.#store.markBackendFailure({ objectiveId: input.objectiveId, uncertain });
        return Object.freeze({
          status: uncertain ? "reconciliation_needed" : "backend_unavailable",
          objectiveId: input.objectiveId
        });
      }
    }

    const prepared = this.#store.prepareTurnSubmission({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      objectiveId: input.objectiveId,
      text: input.text,
      targetSnapshot: input.targetSnapshot,
      leaseOwner: this.#leaseOwner,
      artifacts: input.artifacts,
      artifactBaseDir: input.artifactBaseDir
    });
    if (prepared.duplicate) {
      return Object.freeze({
        status: "duplicate",
        objectiveId: input.objectiveId,
        submissionId: prepared.submission.submissionId,
        clientUserMessageId: prepared.submission.clientUserMessageId,
        turnId: prepared.submission.turnId,
        threadId: execution.threadId
      });
    }
    if (prepared.busy) return Object.freeze({ status: "busy", objectiveId: input.objectiveId });
    const submission = prepared.submission;

    try {
      const started = input.backend === "app-server"
        ? await backend.startTurn({
            threadId: execution.threadId,
            text: submission.text,
            clientUserMessageId: submission.clientUserMessageId
          })
        : await backend.startTurn({
            objectiveId: input.objectiveId,
            text: submission.text,
            clientUserMessageId: submission.clientUserMessageId
          });
      const acknowledged = this.#store.acknowledgeTurnSubmission({
        submissionId: submission.submissionId,
        turnId: started.turnId
      }).submission;
      return Object.freeze({
        status: "started",
        objectiveId: input.objectiveId,
        backend: input.backend,
        submissionId: acknowledged.submissionId,
        clientUserMessageId: acknowledged.clientUserMessageId,
        threadId: execution.threadId,
        turnId: acknowledged.turnId
      });
    } catch (error) {
      if (input.backend === "app-server" && error?.code === "EXECUTION_BACKEND_OBJECTIVE_MISSING") {
        const oldThreadId = execution.threadId;
        let replacement;
        try {
          replacement = await backend.startObjective({
            objectiveId: input.objectiveId,
            threadOptions: input.threadOptions ?? {}
          });
        } catch (replacementError) {
          const uncertain = requestMayHaveBeenWritten(replacementError);
          if (uncertain) {
            this.#store.markReplacementThreadStartUncertain({
              objectiveId: input.objectiveId,
              submissionId: submission.submissionId,
              expectedOldThreadId: oldThreadId
            });
          } else {
            this.#store.markBackendFailure({
              objectiveId: input.objectiveId,
              submissionId: submission.submissionId,
              uncertain: false
            });
          }
          return Object.freeze({
            status: uncertain ? "manual_thread_binding_required" : "backend_unavailable",
            objectiveId: input.objectiveId,
            submissionId: submission.submissionId,
            clientUserMessageId: submission.clientUserMessageId,
            threadId: oldThreadId
          });
        }

        execution = this.#store.replaceMissingObjectiveThread({
          objectiveId: input.objectiveId,
          submissionId: submission.submissionId,
          expectedOldThreadId: oldThreadId,
          newThreadId: replacement.threadId
        }).execution;
        try {
          const restarted = await backend.startTurn({
            threadId: execution.threadId,
            text: submission.text,
            clientUserMessageId: submission.clientUserMessageId
          });
          const acknowledged = this.#store.acknowledgeTurnSubmission({
            submissionId: submission.submissionId,
            turnId: restarted.turnId
          }).submission;
          return Object.freeze({
            status: "started",
            objectiveId: input.objectiveId,
            backend: input.backend,
            submissionId: acknowledged.submissionId,
            clientUserMessageId: acknowledged.clientUserMessageId,
            threadId: execution.threadId,
            turnId: acknowledged.turnId
          });
        } catch (replacementTurnError) {
          const uncertain = requestMayHaveBeenWritten(replacementTurnError);
          if (uncertain) {
            this.#store.markSubmissionUnknown({ submissionId: submission.submissionId });
          } else {
            this.#store.markBackendFailure({
              objectiveId: input.objectiveId,
              submissionId: submission.submissionId,
              uncertain: false
            });
          }
          return Object.freeze({
            status: uncertain ? "submission_unknown" : "backend_unavailable",
            objectiveId: input.objectiveId,
            submissionId: submission.submissionId,
            clientUserMessageId: submission.clientUserMessageId,
            threadId: execution.threadId
          });
        }
      }
      const uncertain = requestMayHaveBeenWritten(error);
      if (uncertain) {
        this.#store.markSubmissionUnknown({ submissionId: submission.submissionId });
      } else {
        this.#store.markBackendFailure({
          objectiveId: input.objectiveId,
          submissionId: submission.submissionId,
          uncertain: false
        });
      }
      return Object.freeze({
        status: uncertain ? "submission_unknown" : "backend_unavailable",
        objectiveId: input.objectiveId,
        submissionId: submission.submissionId,
        clientUserMessageId: submission.clientUserMessageId,
        threadId: execution.threadId
      });
    }
  }

  async continueObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        typeof input.text !== "string" || input.targetSnapshot === null ||
        typeof input.targetSnapshot !== "object" || Array.isArray(input.targetSnapshot)) {
      throw controllerError("TURN_INTENT_INVALID", "Turn intent is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    return this.acceptIntent({
      sourceType: input.sourceType ?? "controller",
      sourceId: input.sourceId ?? `continuation-${randomUUID()}`,
      objectiveId: input.objectiveId,
      backend: execution.backend,
      text: input.text,
      targetSnapshot: input.targetSnapshot,
      threadOptions: input.threadOptions,
      projectId: input.projectId,
      topicBinding: input.topicBinding,
      artifactMode: input.artifactMode,
      artifacts: input.artifacts,
      artifactBaseDir: input.artifactBaseDir
    });
  }

  async reconcileObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId)) {
      throw controllerError("RECONCILIATION_INVALID", "Objective reconciliation is invalid.");
    }
    let execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (execution.backend === "app-server" && execution.threadStartUncertain) {
      return Object.freeze({
        status: "manual_thread_binding_required",
        objectiveId: input.objectiveId
      });
    }
    if (execution.backend === "app-server" && !requireText(execution.threadId)) {
      return Object.freeze({
        status: "reconciliation_needed",
        objectiveId: input.objectiveId
      });
    }
    const backend = this.#selectedBackend(execution.backend);
    if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });

    const read = execution.backend === "app-server"
      ? await backend.reconcileObjective({ threadId: execution.threadId })
      : await backend.reconcileObjective({ objectiveId: input.objectiveId });
    const turns = read?.thread?.turns ?? read?.turns ?? [];
    let submission = execution.activeSubmission;
    if (!submission) {
      const completedTurn = turns.find((turn) =>
        requireText(turn?.id) && this.#store.readTurnOutput(input.objectiveId, turn.id)
      );
      if (completedTurn) {
        return Object.freeze({
          status: "completed",
          objectiveId: input.objectiveId,
          turnId: completedTurn.id,
          duplicate: true
        });
      }
      return Object.freeze({ status: execution.executionStatus, objectiveId: input.objectiveId });
    }

    let turn = submission.turnId
      ? findTurnById(turns, submission.turnId)
      : findTurnByClientId(turns, submission.clientUserMessageId);
    if (!turn) {
      return Object.freeze({
        status: submission.turnId ? "reconciliation_needed" : "submission_unknown",
        objectiveId: input.objectiveId,
        turnId: submission.turnId
      });
    }
    if (!submission.turnId) {
      submission = this.#store.reconcileTurnSubmission({
        submissionId: submission.submissionId,
        turnId: turn.id
      }).submission;
      execution = this.#store.readObjectiveExecution(input.objectiveId);
    }
    if (isTerminalTurn(turn)) {
      if (turn.status !== "completed") {
        const reconciled = this.#store.reconcileTerminalTurn({
          objectiveId: input.objectiveId,
          submissionId: submission.submissionId,
          turnId: turn.id,
          remoteStatus: turn.status,
          sourceType: "reconciliation",
          sourceId: input.sourceId ?? `turn-${turn.id}-${turn.status}`
        });
        return Object.freeze({
          status: reconciled.status,
          objectiveId: input.objectiveId,
          turnId: turn.id,
          duplicate: reconciled.duplicate
        });
      }
      return this.handleTurnCompleted({
        objectiveId: input.objectiveId,
        turn,
        sourceType: "reconciliation",
        sourceId: input.sourceId ?? `turn-${turn.id}-completed`
      });
    }
    return Object.freeze({ status: "running", objectiveId: input.objectiveId, turnId: submission.turnId });
  }

  async reconcile(input) {
    return this.reconcileObjective(input);
  }

  async resolveObjectiveThread(input) {
    if (!isPlainObject(input) || !requireText(input.objectiveId) || !requireText(input.threadId) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
    }
    const resolved = this.#store.resolveObjectiveThread(input);
    if (resolved.submission) {
      const submission = resolved.submission;
      this.#store.markSubmissionUnknown({ submissionId: submission.submissionId });
      try {
        const started = await this.#appServerBackend.startTurn({
          threadId: resolved.execution.threadId,
          text: submission.text,
          clientUserMessageId: submission.clientUserMessageId
        });
        const acknowledged = this.#store.acknowledgeTurnSubmission({
          submissionId: submission.submissionId,
          turnId: started.turnId
        }).submission;
        return Object.freeze({
          status: "started",
          objectiveId: resolved.execution.objectiveId,
          submissionId: acknowledged.submissionId,
          clientUserMessageId: acknowledged.clientUserMessageId,
          threadId: resolved.execution.threadId,
          turnId: acknowledged.turnId,
          duplicate: resolved.duplicate
        });
      } catch (error) {
        // Only mark uncertain if the request may have been written
        if (requestMayHaveBeenWritten(error)) {
          return Object.freeze({
            status: "submission_unknown",
            objectiveId: resolved.execution.objectiveId,
            submissionId: submission.submissionId,
            clientUserMessageId: submission.clientUserMessageId,
            threadId: resolved.execution.threadId,
            duplicate: resolved.duplicate
          });
        }
        // Prewrite failure: roll back the uncertain mark
        this.#store.rollbackSubmissionUnknown({ submissionId: submission.submissionId });
        throw error;
      }
    }
    return Object.freeze({
      status: resolved.execution.executionStatus,
      objectiveId: resolved.execution.objectiveId,
      threadId: resolved.execution.threadId,
      duplicate: resolved.duplicate
    });
  }

  async handleTurnCompleted(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        input.turn === null || typeof input.turn !== "object" || !requireText(input.turn.id) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("TURN_COMPLETION_INVALID", "Turn completion is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const durableSubmission = this.#store.readTurnSubmission(input.objectiveId, input.turn.id);
    if (durableSubmission?.cancellationRequested && durableSubmission.state === "cancelled") {
      this.#store.recordTurnAuditFact({
        objectiveId: input.objectiveId,
        turnId: input.turn.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        fact: { kind: "late_completion", turn: input.turn }
      });
      return Object.freeze({
        status: "cancelled",
        objectiveId: input.objectiveId,
        turnId: input.turn.id,
        suppressed: true
      });
    }
    if (this.#store.readTurnOutput(input.objectiveId, input.turn.id)) {
      return Object.freeze({ status: "completed", objectiveId: input.objectiveId, turnId: input.turn.id, duplicate: true });
    }

    let turn = input.turn;
    if (turn.itemsView !== "full") {
      const backend = this.#selectedBackend(execution.backend);
      if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
      const read = execution.backend === "app-server"
        ? await backend.readObjective({ threadId: execution.threadId })
        : await backend.readObjective({ objectiveId: input.objectiveId });
      turn = findTurnById(read?.thread?.turns ?? read?.turns ?? [], input.turn.id);
    }
    const output = reduceTerminalOutput(turn);
    if (!output || output.text.length === 0) {
      this.#store.markTurnReconciliationNeeded({ objectiveId: input.objectiveId, turnId: input.turn.id });
      return Object.freeze({ status: "reconciliation_needed", objectiveId: input.objectiveId, turnId: input.turn.id });
    }
    const completed = this.#store.completeTurn({
      objectiveId: input.objectiveId,
      turnId: input.turn.id,
      rawText: output.text,
      itemIds: output.itemIds,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      renderer: this.#renderer
    });
    return Object.freeze({
      status: completed.status,
      objectiveId: input.objectiveId,
      turnId: input.turn.id,
      duplicate: completed.duplicate,
      ...(completed.errorCode ? { errorCode: completed.errorCode } : {})
    });
  }

  async cancelObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("TURN_CANCELLATION_INVALID", "Turn cancellation request is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const requested = this.#store.requestCancellation(input);
    if (requested.duplicate) {
      return Object.freeze({
        status: requested.confirmed ? "cancelled" : "reconciliation_needed",
        objectiveId: input.objectiveId,
        turnId: requested.submission.turnId,
        duplicate: true
      });
    }
    const backend = this.#selectedBackend(execution.backend);
    if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
    try {
      if (execution.backend === "app-server") {
        await backend.interruptTurn({ threadId: execution.threadId, turnId: requested.submission.turnId });
      } else {
        await backend.interruptTurn({ objectiveId: input.objectiveId, turnId: requested.submission.turnId });
      }
    } catch (error) {
      return Object.freeze({
        status: requestMayHaveBeenWritten(error) ? "reconciliation_needed" : "backend_unavailable",
        objectiveId: input.objectiveId,
        turnId: requested.submission.turnId
      });
    }
    const confirmed = this.#store.confirmCancellation({
      objectiveId: input.objectiveId,
      submissionId: requested.submission.submissionId,
      sourceType: input.sourceType,
      sourceId: input.sourceId
    });
    return Object.freeze({
      status: "cancelled",
      objectiveId: input.objectiveId,
      turnId: requested.submission.turnId,
      duplicate: confirmed.duplicate
    });
  }

  async handleInteractionRequest(input) {
    validateInteractionRequest(input);
    const created = this.#store.createInteraction({ ...input, renderer: this.#interactionRenderer });
    return Object.freeze({
      status: created.interaction.state,
      objectiveId: created.interaction.objectiveId,
      interactionId: created.interaction.interactionId,
      expiresAt: created.interaction.expiresAt,
      duplicate: created.duplicate
    });
  }

  async answerInteraction(input) {
    validateInteractionAnswer(input);
    const committed = this.#store.commitInteractionAnswer(input);
    if (!committed.accepted) {
      const failures = {
        not_found: ["INTERACTION_NOT_FOUND", "Interaction does not exist."],
        orphaned: ["INTERACTION_ORPHANED", "Interaction is orphaned."],
        expired: ["INTERACTION_EXPIRED", "Interaction has expired."],
        unauthorized: ["INTERACTION_UNAUTHORIZED", "Interaction responder is not authorized."],
        target_mismatch: ["INTERACTION_TARGET_MISMATCH", "Interaction target does not match."],
        conflict: ["INTERACTION_ANSWER_CONFLICT", "Interaction already has a different answer."]
      };
      const [code, message] = failures[committed.reason] ?? ["INTERACTION_ANSWER_INVALID", "Interaction answer is invalid."];
      throw stateError(code, message);
    }
    const interaction = committed.interaction;
    const responseClaim = this.#store.claimInteractionResponse({
      interactionId: interaction.interactionId,
      leaseOwner: this.#leaseOwner
    });
    if (!responseClaim.acquired) {
      return Object.freeze({
        status: responseClaim.state === "delivered"
          ? (committed.duplicate ? "already_answered" : "answered")
          : "response_uncertain",
        objectiveId: interaction.objectiveId,
        interactionId: interaction.interactionId,
        duplicate: committed.duplicate
      });
    }
    const execution = this.#store.readObjectiveExecution(interaction.objectiveId);
    const backend = execution ? this.#selectedBackend(execution.backend) : null;
    if (!backend) {
      const status = this.#completeInteractionResponse({
        interactionId: interaction.interactionId,
        leaseToken: responseClaim.leaseToken,
        state: "retryable"
      });
      if (status !== "response_retryable") {
        return Object.freeze({
          status,
          objectiveId: interaction.objectiveId,
          interactionId: interaction.interactionId,
          duplicate: committed.duplicate
        });
      }
      throw controllerError("INTERACTION_BACKEND_UNAVAILABLE", "Interaction backend is unavailable.");
    }
    try {
      await backend.respondToInteraction({
        interactionId: interaction.interactionId,
        wireRequestId: interaction.wireRequestId,
        result: interaction.answer
      });
    } catch (error) {
      const uncertain = requestMayHaveBeenWritten(error);
      const status = this.#completeInteractionResponse({
        interactionId: interaction.interactionId,
        leaseToken: responseClaim.leaseToken,
        state: uncertain ? "uncertain" : "retryable"
      });
      return Object.freeze({
        status,
        objectiveId: interaction.objectiveId,
        interactionId: interaction.interactionId,
        duplicate: committed.duplicate
      });
    }
    const status = this.#completeInteractionResponse({
      interactionId: interaction.interactionId,
      leaseToken: responseClaim.leaseToken,
      state: "delivered"
    });
    return Object.freeze({
      status,
      objectiveId: interaction.objectiveId,
      interactionId: interaction.interactionId,
      duplicate: committed.duplicate
    });
  }

  orphanInteractions(input) {
    if (!isPlainObject(input) || !requireText(input.connectionId)) {
      throw controllerError("INTERACTION_ORPHAN_INVALID", "Interaction orphan request is invalid.");
    }
    return Object.freeze(this.#store.orphanInteractions(input));
  }

  handleConnectionLost(input) {
    if (!isPlainObject(input) || !requireText(input.connectionId)) {
      throw controllerError("CONNECTION_LOSS_INVALID", "Connection loss record is invalid.");
    }
    const lost = this.#store.markConnectionLost(input);
    return Object.freeze({ status: "reconciliation_needed", ...lost });
  }

  #completeInteractionResponse({ interactionId, leaseToken, state }) {
    try {
      this.#store.recordInteractionResponseDelivery({ interactionId, leaseToken, state });
    } catch (error) {
      if (!isStateError(error) || ![
        "INTERACTION_RESPONSE_STATE_INVALID",
        "INTERACTION_RESPONSE_LEASE_STALE"
      ].includes(error.code)) {
        throw error;
      }
      const durable = this.#store.readInteraction(interactionId);
      if (durable?.responseDeliveryState === "delivered") return "answered";
      if (durable?.state === "orphaned" || durable?.responseDeliveryState === "uncertain") {
        return "response_uncertain";
      }
      throw error;
    }
    if (state === "delivered") return "answered";
    return state === "uncertain" ? "response_uncertain" : "response_retryable";
  }

  #selectedBackend(selection) {
    if (selection === "app-server") return this.#appServerBackend;
    if (selection === "tmux") return this.#tmuxBackend;
    return null;
  }
}
