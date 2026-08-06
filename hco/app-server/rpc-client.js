const DIAGNOSTIC_MESSAGES = Object.freeze({
  APP_SERVER_RPC_DUPLICATE_REQUEST: "App Server sent a duplicate reverse request ID.",
  APP_SERVER_RPC_HANDLER_FAILED: "An App Server reverse request handler failed.",
  APP_SERVER_RPC_LATE_RESPONSE: "App Server sent a response after its request timed out.",
  APP_SERVER_RPC_PROTOCOL_INVALID: "App Server sent an invalid protocol message.",
  APP_SERVER_RPC_UNKNOWN_RESPONSE: "App Server sent a response for an unknown request."
});

const ERROR_MESSAGES = Object.freeze({
  APP_SERVER_RPC_ALREADY_SETTLED: "App Server reverse request is already settled.",
  APP_SERVER_RPC_ARGUMENT_INVALID: "App Server RPC arguments are invalid.",
  APP_SERVER_RPC_PROTOCOL_INVALID: "App Server sent an invalid protocol message.",
  APP_SERVER_RPC_REMOTE_ERROR: "App Server request failed.",
  APP_SERVER_RPC_REQUEST_UNKNOWN: "App Server reverse request is unknown.",
  APP_SERVER_RPC_TIMEOUT: "App Server request timed out."
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOMBSTONES = 1024;
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = (2n ** 63n) - 1n;

export const DEFER_SERVER_REQUEST = Symbol("DEFER_SERVER_REQUEST");

function ownedError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function remoteError(payload) {
  const error = ownedError("APP_SERVER_RPC_REMOTE_ERROR");
  Object.defineProperties(error, {
    rpcCode: {
      configurable: false,
      enumerable: false,
      value: payload.code,
      writable: false
    },
    rpcMessage: {
      configurable: false,
      enumerable: false,
      value: payload.message,
      writable: false
    },
    rpcData: {
      configurable: false,
      enumerable: false,
      value: payload.data,
      writable: false
    }
  });
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSignedInt64(value) {
  return (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "bigint" && value >= MIN_INT64 && value <= MAX_INT64);
}

function isRequestId(value) {
  return typeof value === "string" || isSignedInt64(value);
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validMethod(method) {
  return typeof method === "string" && method.length > 0 && method.length <= 512;
}

function validErrorPayload(error) {
  return isPlainObject(error) &&
    hasOnlyKeys(error, new Set(["code", "message", "data"])) &&
    isSignedInt64(error.code) &&
    typeof error.message === "string";
}

function classifyMessage(message) {
  if (!isPlainObject(message)) return null;
  const hasId = Object.hasOwn(message, "id");
  const hasMethod = Object.hasOwn(message, "method");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");

  if (hasId && !isRequestId(message.id)) return null;
  if (hasId && !hasMethod && hasResult !== hasError &&
      hasOnlyKeys(message, new Set(["id", hasResult ? "result" : "error"]))) {
    if (hasError && !validErrorPayload(message.error)) return { invalidResponseId: message.id };
    return { kind: hasResult ? "result" : "error" };
  }
  if (hasId && hasMethod && !hasResult && !hasError && validMethod(message.method) &&
      hasOnlyKeys(message, new Set(["id", "method", "params", "trace"]))) {
    return { kind: "request" };
  }
  if (!hasId && hasMethod && !hasResult && !hasError && validMethod(message.method) &&
      hasOnlyKeys(message, new Set(["method", "params", "emittedAtMs"])) &&
      (!Object.hasOwn(message, "emittedAtMs") || isSignedInt64(message.emittedAtMs))) {
    return { kind: "notification" };
  }
  return null;
}

function normalizeHandlers(handlers) {
  if (handlers === undefined) return new Map();
  if (handlers instanceof Map) return new Map(handlers);
  if (!isPlainObject(handlers)) throw ownedError("APP_SERVER_RPC_ARGUMENT_INVALID");
  return new Map(Object.entries(handlers));
}

export class AppServerRpcClient {
  #diagnosticCallback;
  #inbound = new Map();
  #inboundSettled = new Set();
  #inboundSettling = new Set();
  #nextId = 1;
  #notificationCallback;
  #pending = new Map();
  #requestHandlers;
  #serverRequestCallback;
  #timedOut = new Set();
  #transport;

  constructor({
    transport,
    requestHandlers,
    onDiagnostic = () => undefined,
    onNotification = () => undefined,
    onServerRequest = () => undefined
  } = {}) {
    if (!transport || typeof transport.send !== "function" || typeof transport.on !== "function" ||
        typeof onDiagnostic !== "function" || typeof onNotification !== "function" ||
        typeof onServerRequest !== "function") {
      throw ownedError("APP_SERVER_RPC_ARGUMENT_INVALID");
    }
    this.#transport = transport;
    this.#requestHandlers = normalizeHandlers(requestHandlers);
    for (const [method, handler] of this.#requestHandlers) {
      if (!validMethod(method) || typeof handler !== "function") {
        throw ownedError("APP_SERVER_RPC_ARGUMENT_INVALID");
      }
    }
    this.#diagnosticCallback = onDiagnostic;
    this.#notificationCallback = onNotification;
    this.#serverRequestCallback = onServerRequest;
    transport.on("message", this.#onMessage);
    transport.on("terminal", this.#onTerminal);
  }

  request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!validMethod(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
        this.#nextId > Number.MAX_SAFE_INTEGER) {
      return Promise.reject(ownedError("APP_SERVER_RPC_ARGUMENT_INVALID"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const key = requestKey(id);
    const message = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        const entry = this.#pending.get(key);
        if (!entry) return;
        this.#pending.delete(key);
        this.#rememberTimedOut(key);
        entry.controller.abort();
        entry.reject(ownedError("APP_SERVER_RPC_TIMEOUT"));
      }, timeoutMs);
      timeout.unref?.();
      this.#pending.set(key, { controller, reject, resolve, timeout });
      this.#transport.send(message, { signal: controller.signal })
        .catch((error) => this.#rejectPending(key, error));
    });
  }

  notify(method, params) {
    if (!validMethod(method)) return Promise.reject(ownedError("APP_SERVER_RPC_ARGUMENT_INVALID"));
    const message = { method };
    if (params !== undefined) message.params = params;
    return this.#transport.send(message);
  }

  respond(id, result) {
    return this.#settleInbound(id, { id, result });
  }

  respondError(id, { code, message, data } = {}) {
    if (!isSignedInt64(code) || typeof message !== "string") {
      return Promise.reject(ownedError("APP_SERVER_RPC_ARGUMENT_INVALID"));
    }
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return this.#settleInbound(id, { id, error });
  }

  setRequestHandler(method, handler) {
    if (!validMethod(method) || typeof handler !== "function") {
      throw ownedError("APP_SERVER_RPC_ARGUMENT_INVALID");
    }
    this.#requestHandlers.set(method, handler);
    return () => {
      if (this.#requestHandlers.get(method) === handler) this.#requestHandlers.delete(method);
    };
  }

  close() {
    this.#transport.close();
  }

  terminate(error) {
    if (!(error instanceof Error) || typeof error.code !== "string") {
      throw ownedError("APP_SERVER_RPC_ARGUMENT_INVALID");
    }
    this.#onTerminal(error);
  }

  #onMessage = (message) => {
    const classification = classifyMessage(message);
    if (classification?.invalidResponseId !== undefined) {
      const key = requestKey(classification.invalidResponseId);
      this.#diagnose("APP_SERVER_RPC_PROTOCOL_INVALID");
      this.#rejectPending(key, ownedError("APP_SERVER_RPC_PROTOCOL_INVALID"));
      return;
    }
    if (!classification) {
      this.#diagnose("APP_SERVER_RPC_PROTOCOL_INVALID");
      return;
    }
    if (classification.kind === "result" || classification.kind === "error") {
      this.#handleResponse(message, classification.kind);
      return;
    }
    if (classification.kind === "notification") {
      this.#invokeCallback(this.#notificationCallback, message, "APP_SERVER_RPC_HANDLER_FAILED");
      return;
    }
    this.#handleServerRequest(message);
  };

  #handleResponse(message, kind) {
    const key = requestKey(message.id);
    const pending = this.#pending.get(key);
    if (!pending) {
      this.#diagnose(this.#timedOut.has(key)
        ? "APP_SERVER_RPC_LATE_RESPONSE"
        : "APP_SERVER_RPC_UNKNOWN_RESPONSE");
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timeout);
    pending.controller.abort();
    if (kind === "result") pending.resolve(message.result);
    else pending.reject(remoteError(message.error));
  }

  #handleServerRequest(message) {
    const key = requestKey(message.id);
    if (this.#inbound.has(key) || this.#inboundSettled.has(key)) {
      this.#diagnose("APP_SERVER_RPC_DUPLICATE_REQUEST");
      return;
    }
    this.#inbound.set(key, message);
    this.#invokeCallback(this.#serverRequestCallback, message, "APP_SERVER_RPC_HANDLER_FAILED");
    const handler = this.#requestHandlers.get(message.method);
    if (!handler) {
      queueMicrotask(() => {
        this.respondError(message.id, { code: -32601, message: "Method not supported." })
          .catch(() => undefined);
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then((result) => result === DEFER_SERVER_REQUEST ? undefined : this.respond(message.id, result))
      .catch((error) => {
        if (error?.code === "APP_SERVER_RPC_ALREADY_SETTLED") return;
        this.#diagnose("APP_SERVER_RPC_HANDLER_FAILED");
        this.respondError(message.id, { code: -32603, message: "Server request handler failed." })
          .catch(() => undefined);
      });
  }

  #settleInbound(id, message) {
    if (!isRequestId(id)) return Promise.reject(ownedError("APP_SERVER_RPC_ARGUMENT_INVALID"));
    const key = requestKey(id);
    if (this.#inboundSettled.has(key) || this.#inboundSettling.has(key)) {
      return Promise.reject(ownedError("APP_SERVER_RPC_ALREADY_SETTLED"));
    }
    if (!this.#inbound.has(key)) return Promise.reject(ownedError("APP_SERVER_RPC_REQUEST_UNKNOWN"));
    this.#inboundSettling.add(key);
    return this.#transport.send(message).then(() => {
      this.#inboundSettling.delete(key);
      this.#inbound.delete(key);
      this.#rememberInboundSettled(key);
    }, (error) => {
      this.#inboundSettling.delete(key);
      throw error;
    });
  }

  #rejectPending(key, error) {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    clearTimeout(pending.timeout);
    pending.controller.abort();
    pending.reject(error);
  }

  #onTerminal = (error) => {
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key);
      clearTimeout(pending.timeout);
      pending.controller.abort();
      pending.reject(error);
    }
    this.#inbound.clear();
    this.#inboundSettling.clear();
  };

  #rememberTimedOut(key) {
    this.#timedOut.add(key);
    if (this.#timedOut.size > MAX_TOMBSTONES) this.#timedOut.delete(this.#timedOut.values().next().value);
  }

  #rememberInboundSettled(key) {
    this.#inboundSettled.add(key);
    if (this.#inboundSettled.size > MAX_TOMBSTONES) {
      this.#inboundSettled.delete(this.#inboundSettled.values().next().value);
    }
  }

  #diagnose(code) {
    this.#invokeCallback(this.#diagnosticCallback, { code, message: DIAGNOSTIC_MESSAGES[code] }, null);
  }

  #invokeCallback(callback, value, failureCode) {
    queueMicrotask(() => {
      try {
        Promise.resolve(callback(value)).catch(() => {
          if (failureCode) this.#diagnose(failureCode);
        });
      } catch {
        if (failureCode) this.#diagnose(failureCode);
      }
    });
  }
}
