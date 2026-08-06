import { chmodSync, lstatSync } from "node:fs";
import http from "node:http";

import { negotiateBridge } from "../contracts/protocol.js";
import {
  PROJECT_LOCAL_EXCHANGE_CAPABILITY,
  PROJECT_LOCAL_EXCHANGE_PROFILE,
  PROJECT_LOCAL_MAXIMUM_BYTES_PER_EXCHANGE,
  PROJECT_LOCAL_MAXIMUM_FILES_PER_EXCHANGE
} from "../project-local-exchange.js";
import { isStateError } from "../state/reducer.js";
import { bridgeError, createBearerAuthenticator, isBridgeError } from "./auth.js";

const BODY_LIMIT = 1024 * 1024;
const MAX_MODEL_CURSOR_BYTES = 4096;
const MAX_MODEL_LIST_LIMIT = 500;
export const SERVER_CAPABILITIES = Object.freeze([
  "interaction_exchange_v2",
  "zulip_zform_v1",
  "natural_interaction_reply_v1",
  "coordination_mailbox_v1",
  "coordination_recovery_v1",
  "agent_restart_recovery_v1",
  "agent_reports_v1",
  PROJECT_LOCAL_EXCHANGE_CAPABILITY
]);
const COMMON_FIELDS = Object.freeze(["protocolVersion", "pluginVersion", "capabilities"]);
const PROTOCOL_ERRORS = Object.freeze({
  BRIDGE_VERSION_UNSUPPORTED: "Bridge protocol major version is unsupported.",
  BRIDGE_PLUGIN_VERSION_INVALID: "Bridge pluginVersion is invalid.",
  BRIDGE_CAPABILITIES_INVALID: "Bridge capabilities are invalid."
});
const INPUT_STATE_CODES = new Set([
  "FACT_INVALID",
  "OUTBOX_CLAIM_INVALID",
  "OUTBOX_ACK_INVALID",
  "OUTBOX_NACK_INVALID",
  "MAILBOX_CLAIM_INVALID",
  "MAILBOX_ACK_INVALID",
  "MAILBOX_RECOVERY_INVALID",
  "AGENT_RECOVERY_INVALID",
  "OBJECTIVE_TOPIC_RELINK_INVALID",
  "AGENT_STOP_REPORT_INVALID",
  "ARTIFACT_MANIFEST_INVALID",
  "ARTIFACT_INPUT_MISSING",
  "ARTIFACT_INPUT_INVALID",
  "ARTIFACT_INPUT_HASH_MISMATCH",
  "PROJECT_LOCAL_INPUT_INVALID",
  "PROJECT_LOCAL_OUTPUT_INVALID",
  "INTERACTION_DECISION_INVALID",
  "INTERACTION_COMMAND_MISMATCH",
  "INTERACTION_QUESTION_ID_INVALID",
  "INTERACTION_SECRET_ANSWER_FORBIDDEN",
  "INTERACTION_NOT_FOUND",
  "INTERACTION_TARGET_MISMATCH",
  "OBJECTIVE_REQUIRED",
  "INTERACTION_ORPHANED",
  "INTERACTION_EXPIRED",
  "INTERACTION_UNAUTHORIZED",
  "INTERACTION_ANSWER_CONFLICT",
  "INTERACTION_ANSWER_INVALID",
  "INTERACTION_APPROVAL_RESTRICTED",
  "INTERACTION_ACTION_INVALID",
  "INTERACTION_ACTION_EXPLICIT_REQUIRED",
  "INTERACTION_DETAIL_NOT_DELIVERED",
  "INTERACTION_NATURAL_REPLY_INVALID",
  "INTERACTION_REPLY_SOURCE_CONFLICT",
  "ROUTE_HERMES_OWNED",
  "PROJECT_NOT_FOUND",
  "TOPIC_HERMES_ONLY"
]);
const CONFLICT_STATE_CODES = new Set([
  "OBJECTIVE_ALREADY_EXISTS",
  "OBJECTIVE_NOT_FOUND",
  "OBJECTIVE_PROJECT_MISMATCH",
  "OBJECTIVE_TOPIC_MISMATCH",
  "WORK_REQUEST_SOURCE_CONFLICT",
  "OBJECTIVE_TOPIC_MIGRATION_REQUIRED",
  "WORK_REQUEST_TOPIC_MISMATCH",
  "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE",
  "PROJECT_LOCAL_INPUT_CHANGED",
  "PROJECT_LOCAL_OUTPUT_CHANGED",
  "PROJECT_LOCAL_OUTPUT_MISSING",
  "DOCUMENT_CONFLICT",
  "OBJECTIVE_TOPIC_RELINK_UNPROVEN",
  "OBJECTIVE_TRANSITION_INVALID",
  "OBJECTIVE_THREAD_RESOLUTION_INVALID",
  "TURN_SUBMISSION_NOT_FOUND",
  "TURN_CANCELLATION_INVALID",
  "OUTBOX_SEMANTIC_CONFLICT",
  "OUTBOX_DELIVERY_UNKNOWN",
  "OUTBOX_LEASE_STALE",
  "OUTBOX_LEASE_EXPIRED",
  "OUTBOX_ACK_CONFLICT",
  "MAILBOX_RECOVERY_CONFLICT",
  "AGENT_RECOVERY_CONFLICT",
  "MAILBOX_ITEM_NOT_FOUND",
  "MAILBOX_LEASE_MISMATCH",
  "AGENT_PARENT_HERMES_MISMATCH",
  "AGENT_PARENT_SCOPE_MISMATCH",
  "AGENT_PARENT_WORK_MISMATCH",
  "AGENT_SCOPE_MISMATCH",
  "AGENT_REPORT_SCOPE_INVALID",
  "AGENT_REPORT_SOURCE_CONFLICT",
  "ACL_FORBIDDEN"
]);
const MODEL_LIST_QUERY_KEYS = new Set(["includeHidden", "limit", "cursor"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerValues(request, name) {
  const lowerName = name.toLowerCase();
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === lowerName) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function jsonResponse(response, status, body, extraHeaders = {}) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded, "utf8"),
    ...extraHeaders
  });
  response.end(encoded);
}

function errorResponse(response, status, code, message, extraHeaders) {
  jsonResponse(response, status, { error: { code, message } }, extraHeaders);
}

function normalizeError(error) {
  if (isBridgeError(error)) {
    const statuses = {
      BRIDGE_AUTH_FAILED: 401,
      BRIDGE_ROUTE_NOT_FOUND: 404,
      BRIDGE_METHOD_NOT_ALLOWED: 405,
      BRIDGE_BODY_TOO_LARGE: 413,
      BRIDGE_CONTENT_TYPE_INVALID: 415,
      MODEL_CATALOG_UNAVAILABLE: 503
    };
    return { status: statuses[error.code] ?? 400, code: error.code, message: error.message };
  }
  if (isStateError(error) && INPUT_STATE_CODES.has(error.code)) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (isStateError(error) && CONFLICT_STATE_CODES.has(error.code)) {
    return { status: 409, code: error.code, message: error.message };
  }
  return { status: 500, code: "BRIDGE_INTERNAL", message: "Bridge request failed." };
}

function parseModelOptions(searchParams) {
  const options = {};
  for (const [key, value] of searchParams) {
    if (!MODEL_LIST_QUERY_KEYS.has(key) || Object.hasOwn(options, key)) {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (key === "includeHidden") {
      if (!["true", "false"].includes(value)) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
      options.includeHidden = value === "true";
    } else if (key === "limit") {
      if (!/^[1-9][0-9]*$/u.test(value)) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MODEL_LIST_LIMIT) {
        throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
      }
      options.limit = limit;
    } else {
      if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_MODEL_CURSOR_BYTES) {
        throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
      }
      options.cursor = value;
    }
  }
  return options;
}

function parseRoute(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl, "http://bridge.local");
  } catch {
    throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
  }
  if (parsed.hash) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
  const pathname = parsed.pathname;
  if (pathname === "/v1/models") return { kind: "models", method: "GET", options: parseModelOptions(parsed.searchParams) };
  if (parsed.search) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
  if (pathname === "/v1/compatibility") return { kind: "compatibility", method: "GET" };
  if (pathname === "/v1/health") return { kind: "health", method: "GET" };
  if (pathname === "/v1/events") return { kind: "events", method: "POST" };
  if (pathname === "/v1/outbox/claim") return { kind: "claim", method: "POST" };
  if (pathname === "/v1/mailbox/claim") return { kind: "mailboxClaim", method: "POST" };
  if (pathname === "/v1/mailbox/recovery") return { kind: "mailboxRecovery", method: "POST" };
  if (pathname === "/v1/agents/recovery") return { kind: "agentRecovery", method: "POST" };
  if (pathname === "/v1/agents/report") return { kind: "agentReport", method: "POST" };
  const agentOrphan = pathname.match(/^\/v1\/agents\/([^/]+)\/orphan$/u);
  if (agentOrphan) {
    let agentSessionId;
    try {
      agentSessionId = decodeURIComponent(agentOrphan[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (agentSessionId.length === 0) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    return { kind: "agentOrphan", method: "POST", agentSessionId };
  }
  const delivery = pathname.match(/^\/v1\/outbox\/([^/]+)\/(ack|nack)$/u);
  if (delivery) {
    let deliveryId;
    try {
      deliveryId = decodeURIComponent(delivery[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (deliveryId.length === 0) {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    return { kind: delivery[2], method: "POST", deliveryId };
  }
  if (pathname.startsWith("/v1/outbox/")) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
  const mailbox = pathname.match(/^\/v1\/mailbox\/([^/]+)\/ack$/u);
  if (mailbox) {
    let mailboxItemId;
    try {
      mailboxItemId = decodeURIComponent(mailbox[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (mailboxItemId.length === 0) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    return { kind: "mailboxAck", method: "POST", mailboxItemId };
  }
  const mailboxRenew = pathname.match(/^\/v1\/mailbox\/([^/]+)\/renew$/u);
  if (mailboxRenew) {
    let mailboxItemId;
    try {
      mailboxItemId = decodeURIComponent(mailboxRenew[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (mailboxItemId.length === 0) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    return { kind: "mailboxRenew", method: "POST", mailboxItemId };
  }
  const mailboxNack = pathname.match(/^\/v1\/mailbox\/([^/]+)\/nack$/u);
  if (mailboxNack) {
    let mailboxItemId;
    try {
      mailboxItemId = decodeURIComponent(mailboxNack[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (mailboxItemId.length === 0) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    return { kind: "mailboxNack", method: "POST", mailboxItemId };
  }
  const mailboxAbandon = pathname.match(/^\/v1\/mailbox\/([^/]+)\/abandon$/u);
  if (mailboxAbandon) {
    let mailboxItemId;
    try {
      mailboxItemId = decodeURIComponent(mailboxAbandon[1]);
    } catch {
      throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    }
    if (mailboxItemId.length === 0) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
    return { kind: "mailboxAbandon", method: "POST", mailboxItemId };
  }
  if (pathname.startsWith("/v1/mailbox/")) throw bridgeError("BRIDGE_PATH_INVALID", "Request path is invalid.");
  throw bridgeError("BRIDGE_ROUTE_NOT_FOUND", "Route was not found.");
}

function assertExpectedFields(body, routeKind) {
  const routeFields = {
    events: ["event"],
    claim: ["workerId", "limit", "leaseMs"],
    ack: ["leaseToken", "zulipMessageId"],
    nack: ["leaseToken", "error", "retryable"],
    mailboxClaim: ["targetKind", "targetId", "codexCallId", "mailboxItemId", "workerId", "limit", "leaseMs"],
    mailboxRecovery: ["workerId", "limit"],
    mailboxAck: ["leaseToken", "finalDelivery"],
    mailboxRenew: ["leaseToken", "leaseMs"],
    mailboxNack: ["leaseToken", "error", "retryable"],
    mailboxAbandon: ["expectedState", "expectedAttemptCount", "reason"],
    agentRecovery: ["startedBefore", "limit"],
    agentOrphan: ["agentActivationId", "expectedState", "startedBefore", "reason"],
    agentReport: [
      "sourceId", "childHermesSessionId", "parentHermesSessionId",
      "childStatus", "summary", "durationMs"
    ]
  }[routeKind];
  const expected = new Set([...COMMON_FIELDS, ...routeFields]);
  if (!isPlainObject(body) || Object.keys(body).some((field) => !expected.has(field))) {
    throw bridgeError("BRIDGE_FIELDS_INVALID", "Request fields are invalid.");
  }
  for (const field of expected) {
    if (!Object.hasOwn(body, field)) throw bridgeError("BRIDGE_FIELDS_INVALID", "Request fields are invalid.");
  }
}

function readJsonBody(request) {
  const contentTypes = headerValues(request, "content-type");
  if (
    contentTypes.length !== 1 ||
    contentTypes[0].split(";", 1)[0].trim().toLowerCase() !== "application/json"
  ) {
    throw bridgeError("BRIDGE_CONTENT_TYPE_INVALID", "Content type must be application/json.");
  }

  const contentLengths = headerValues(request, "content-length");
  if (contentLengths.length > 1) throw bridgeError("BRIDGE_REQUEST_INVALID", "HTTP request framing is invalid.");
  if (contentLengths.length === 1) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLengths[0])) {
      throw bridgeError("BRIDGE_REQUEST_INVALID", "HTTP request framing is invalid.");
    }
    if (contentLengths[0].length > 15 || Number(contentLengths[0]) > BODY_LIMIT) {
      throw bridgeError("BRIDGE_BODY_TOO_LARGE", "Request body exceeds the size limit.");
    }
  }
  if (contentLengths.length === 1 && headerValues(request, "transfer-encoding").length > 0) {
    throw bridgeError("BRIDGE_REQUEST_INVALID", "HTTP request framing is invalid.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > BODY_LIMIT) {
        settled = true;
        request.resume();
        reject(bridgeError("BRIDGE_BODY_TOO_LARGE", "Request body exceeds the size limit."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
      } catch {
        reject(bridgeError("BRIDGE_JSON_INVALID", "Request body is not valid JSON."));
        return;
      }
      resolve(body);
    });
    request.on("error", () => {
      if (!settled) {
        settled = true;
        reject(bridgeError("BRIDGE_REQUEST_INVALID", "HTTP request is invalid."));
      }
    });
  });
}

function compatibilityMetadata(request) {
  const versionHeaders = headerValues(request, "x-hco-protocol-version");
  const protocolVersion = versionHeaders.length === 1 && /^(0|[1-9][0-9]*)$/u.test(versionHeaders[0])
    ? Number(versionHeaders[0])
    : undefined;
  if (protocolVersion !== 1) return safeNegotiate({ protocolVersion });

  const pluginHeaders = headerValues(request, "x-hco-plugin-version");
  const capabilityHeaders = headerValues(request, "x-hco-capabilities");
  let capabilities;
  if (capabilityHeaders.length === 1) {
    try {
      capabilities = JSON.parse(capabilityHeaders[0]);
    } catch {
      throw bridgeError("BRIDGE_CAPABILITIES_INVALID", "Bridge capabilities are invalid.");
    }
  }
  return safeNegotiate({
    protocolVersion,
    pluginVersion: pluginHeaders.length === 1 ? pluginHeaders[0] : undefined,
    capabilities
  });
}

function postMetadata(body) {
  const protocolVersion = isPlainObject(body) ? body.protocolVersion : undefined;
  if (protocolVersion !== 1) return safeNegotiate({ protocolVersion });
  return safeNegotiate(body);
}

function safeNegotiate(metadata) {
  try {
    return negotiateBridge(metadata);
  } catch (error) {
    const message = PROTOCOL_ERRORS[error?.code];
    if (message) throw bridgeError(error.code, message);
    throw bridgeError("BRIDGE_PROTOCOL_INVALID", "Bridge metadata is invalid.");
  }
}

async function callModelProvider(modelProvider, options) {
  try {
    return await modelProvider(options);
  } catch {
    throw bridgeError("MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable.");
  }
}

function unavailableModelProvider() {
  throw bridgeError("MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable.");
}

function createHandler({ authenticator, eventHandler, healthProvider, hcoVersion, modelProvider, store }) {
  return async function handle(request, response) {
    try {
      const authorization = headerValues(request, "authorization");
      if (authorization.length !== 1 || !authenticator.authenticate(authorization[0])) {
        throw bridgeError("BRIDGE_AUTH_FAILED", "Authentication failed.");
      }

      const route = parseRoute(request.url);
      if (request.method !== route.method) {
        const error = bridgeError("BRIDGE_METHOD_NOT_ALLOWED", "Method is not allowed for this route.");
        error.allow = route.method;
        throw error;
      }

      if (route.kind === "compatibility") {
        const compatibility = compatibilityMetadata(request);
        jsonResponse(response, 200, {
          compatibility,
          serverCapabilities: SERVER_CAPABILITIES,
          hco: {
            version: hcoVersion,
            projectLocalExchange: {
              profile: PROJECT_LOCAL_EXCHANGE_PROFILE,
              supported: true,
              maximumBytesPerExchange: PROJECT_LOCAL_MAXIMUM_BYTES_PER_EXCHANGE,
              maximumFilesPerExchange: PROJECT_LOCAL_MAXIMUM_FILES_PER_EXCHANGE
            }
          }
        });
        return;
      }
      if (route.kind === "health") {
        const health = healthProvider();
        if (!isPlainObject(health) || typeof health.appServerAvailable !== "boolean") {
          throw new TypeError("invalid health state");
        }
        jsonResponse(response, 200, {
          status: health.appServerAvailable ? "ok" : "degraded",
          appServer: { available: health.appServerAvailable }
        });
        return;
      }
      if (route.kind === "models") {
        jsonResponse(response, 200, { result: await callModelProvider(modelProvider, route.options) });
        return;
      }

      const body = await readJsonBody(request);
      postMetadata(body);
      assertExpectedFields(body, route.kind);
      if (route.kind === "events") {
        jsonResponse(response, 200, { result: await eventHandler(body.event) });
      } else if (route.kind === "mailboxClaim") {
        jsonResponse(response, 200, {
          result: {
            items: store.claimCoordinationMailbox({
              targetKind: body.targetKind,
              targetId: body.targetId,
              codexCallId: body.codexCallId,
              mailboxItemId: body.mailboxItemId,
              workerId: body.workerId,
              limit: body.limit,
              leaseMs: body.leaseMs
            })
          }
        });
      } else if (route.kind === "mailboxRecovery") {
        jsonResponse(response, 200, {
          result: {
            items: store.listCoordinationMailboxRecovery({
              workerId: body.workerId,
              limit: body.limit
            })
          }
        });
      } else if (route.kind === "agentRecovery") {
        jsonResponse(response, 200, {
          result: {
            items: store.listCoordinationAgentRestartRecovery({
              startedBefore: body.startedBefore,
              limit: body.limit
            })
          }
        });
      } else if (route.kind === "mailboxAck") {
        jsonResponse(response, 200, {
          result: store.ackCoordinationMailbox({
            mailboxItemId: route.mailboxItemId,
            leaseToken: body.leaseToken,
            finalDelivery: body.finalDelivery
          })
        });
      } else if (route.kind === "mailboxRenew") {
        jsonResponse(response, 200, {
          result: store.renewCoordinationMailbox({
            mailboxItemId: route.mailboxItemId,
            leaseToken: body.leaseToken,
            leaseMs: body.leaseMs
          })
        });
      } else if (route.kind === "mailboxNack") {
        jsonResponse(response, 200, {
          result: store.nackCoordinationMailbox({
            mailboxItemId: route.mailboxItemId,
            leaseToken: body.leaseToken,
            error: body.error,
            retryable: body.retryable
          })
        });
      } else if (route.kind === "mailboxAbandon") {
        jsonResponse(response, 200, {
          result: store.abandonCoordinationMailboxRecovery({
            mailboxItemId: route.mailboxItemId,
            expectedState: body.expectedState,
            expectedAttemptCount: body.expectedAttemptCount,
            reason: body.reason
          })
        });
      } else if (route.kind === "agentOrphan") {
        jsonResponse(response, 200, {
          result: store.orphanCoordinationAgentRestart({
            agentSessionId: route.agentSessionId,
            agentActivationId: body.agentActivationId,
            expectedState: body.expectedState,
            startedBefore: body.startedBefore,
            reason: body.reason
          })
        });
      } else if (route.kind === "agentReport") {
        jsonResponse(response, 200, {
          result: store.reportHermesAgentStop({
            sourceId: body.sourceId,
            childHermesSessionId: body.childHermesSessionId,
            parentHermesSessionId: body.parentHermesSessionId,
            childStatus: body.childStatus,
            summary: body.summary,
            durationMs: body.durationMs
          })
        });
      } else if (route.kind === "claim") {
        jsonResponse(response, 200, {
          deliveries: store.claimOutbox({ workerId: body.workerId, limit: body.limit, leaseMs: body.leaseMs })
        });
      } else if (route.kind === "ack") {
        jsonResponse(response, 200, {
          result: store.ackOutbox({
            deliveryId: route.deliveryId,
            leaseToken: body.leaseToken,
            zulipMessageId: body.zulipMessageId
          })
        });
      } else {
        jsonResponse(response, 200, {
          result: store.nackOutbox({
            deliveryId: route.deliveryId,
            leaseToken: body.leaseToken,
            error: body.error,
            retryable: body.retryable
          })
        });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      const extraHeaders = error?.code === "BRIDGE_METHOD_NOT_ALLOWED" && error.allow ? { allow: error.allow } : undefined;
      errorResponse(response, normalized.status, normalized.code, normalized.message, extraHeaders);
    }
  };
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = () => {
      server.close();
      reject(bridgeError("BRIDGE_LISTEN_FAILED", "Bridge listener could not be started."));
    };
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(bridgeError("BRIDGE_CLOSE_FAILED", "Bridge listener could not be closed.")) : resolve());
  });
}

export function createBridge({
  store,
  tokenPath,
  authenticator,
  eventHandler,
  healthProvider = () => ({ appServerAvailable: true }),
  modelProvider = unavailableModelProvider,
  hcoVersion = "0.1.0"
} = {}) {
  const hasTokenPath = typeof tokenPath === "string" && tokenPath.length > 0;
  const hasAuthenticator = authenticator !== null && typeof authenticator === "object" &&
    typeof authenticator.authenticate === "function";
  if (
    !isPlainObject(store) ||
    [
      "claimOutbox", "ackOutbox", "nackOutbox", "claimCoordinationMailbox",
      "ackCoordinationMailbox", "reportHermesAgentStop"
    ]
      .some((method) => typeof store[method] !== "function") ||
    (eventHandler === undefined ? typeof store.ingest !== "function" : typeof eventHandler !== "function") ||
    hasTokenPath === hasAuthenticator ||
    typeof healthProvider !== "function" ||
    typeof modelProvider !== "function" ||
    typeof hcoVersion !== "string" || hcoVersion.trim().length === 0 || Buffer.byteLength(hcoVersion, "utf8") > 64
  ) {
    throw bridgeError("BRIDGE_OPTIONS_INVALID", "Bridge options are invalid.");
  }
  const requestAuthenticator = authenticator ?? createBearerAuthenticator(tokenPath);
  const handleEvent = eventHandler ?? ((event) => store.ingest(event));

  return Object.freeze({
    async start(options = {}) {
      if (!isPlainObject(options)) throw bridgeError("BRIDGE_BIND_INVALID", "Bridge bind options are invalid.");
      const hasSocket = Object.hasOwn(options, "socketPath");
      if (hasSocket && (Object.hasOwn(options, "host") || Object.hasOwn(options, "port"))) {
        throw bridgeError("BRIDGE_BIND_INVALID", "Bridge bind options are invalid.");
      }

      let listenOptions;
      let publicAddress;
      if (hasSocket) {
        if (typeof options.socketPath !== "string" || options.socketPath.length === 0) {
          throw bridgeError("BRIDGE_BIND_INVALID", "Bridge bind options are invalid.");
        }
        try {
          lstatSync(options.socketPath);
          throw bridgeError("BRIDGE_SOCKET_INVALID", "Bridge socket path is unsafe.");
        } catch (error) {
          if (isBridgeError(error)) throw error;
          if (error?.code !== "ENOENT") throw bridgeError("BRIDGE_SOCKET_INVALID", "Bridge socket path is unsafe.");
        }
        listenOptions = { path: options.socketPath };
        publicAddress = Object.freeze({ transport: "unix", path: options.socketPath });
      } else {
        const host = options.host ?? "127.0.0.1";
        const port = options.port ?? 0;
        if (!["127.0.0.1", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw bridgeError("BRIDGE_BIND_INVALID", "Bridge bind options are invalid.");
        }
        listenOptions = { host, port };
      }

      const server = http.createServer(createHandler({
        authenticator: requestAuthenticator,
        eventHandler: handleEvent,
        healthProvider,
        hcoVersion,
        modelProvider,
        store
      }));
      server.on("clientError", (_error, socket) => {
        if (!socket.writable) return;
        const body = JSON.stringify({ error: { code: "BRIDGE_REQUEST_INVALID", message: "HTTP request is invalid." } });
        socket.end(
          `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\nConnection: close\r\n\r\n${body}`
        );
      });
      await listen(server, listenOptions);

      if (hasSocket) {
        try {
          const status = lstatSync(options.socketPath);
          if (status.isSymbolicLink() || !status.isSocket()) throw new Error("unsafe socket");
          chmodSync(options.socketPath, 0o600);
        } catch {
          await closeServer(server);
          throw bridgeError("BRIDGE_SOCKET_INVALID", "Bridge socket path is unsafe.");
        }
      } else {
        const address = server.address();
        publicAddress = Object.freeze({
          transport: "tcp",
          host: address.address,
          port: address.port,
          family: address.family
        });
      }

      let closed = false;
      return Object.freeze({
        address: publicAddress,
        close() {
          if (closed) return Promise.resolve();
          closed = true;
          return closeServer(server);
        }
      });
    }
  });
}
