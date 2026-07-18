import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";

import { AppServerRpcClient } from "./rpc-client.js";
import { NdjsonTransport } from "./transport.js";

const ERROR_MESSAGES = Object.freeze({
  APP_SERVER_CLIENT_ARGUMENT_INVALID: "Codex App Server client arguments are invalid.",
  APP_SERVER_CLIENT_CHILD_EXITED: "Codex App Server process exited.",
  APP_SERVER_CLIENT_CHILD_FAILED: "Codex App Server process failed.",
  APP_SERVER_CLIENT_CLOSED: "Codex App Server client is closed.",
  APP_SERVER_CLIENT_INITIALIZE_FAILED: "Codex App Server initialization failed.",
  APP_SERVER_CLIENT_NOT_INITIALIZED: "Codex App Server client is not initialized.",
  APP_SERVER_CLIENT_PROCESS_INVALID: "Codex App Server process streams are invalid.",
  APP_SERVER_CLIENT_RESPONSE_INVALID: "Codex App Server returned an invalid response."
});

const DIAGNOSTIC_MESSAGES = Object.freeze({
  APP_SERVER_CLIENT_CHILD_EXITED: "Codex App Server process exited.",
  APP_SERVER_CLIENT_CHILD_FAILED: "Codex App Server process failed.",
  APP_SERVER_CLIENT_STDERR: "Codex App Server wrote diagnostic output."
});

const MAX_METADATA_LENGTH = 4096;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_STDERR_EVENTS = 32;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const THREAD_OPTION_KEYS = new Set([
  "approvalPolicy",
  "baseInstructions",
  "cwd",
  "developerInstructions",
  "model",
  "sandbox"
]);

function ownedError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStream(value, method) {
  return value && typeof value.on === "function" && typeof value[method] === "function";
}

function validBoundedString(value, { allowEmpty = false } = {}) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= MAX_METADATA_LENGTH;
}

function validContentString(value, { allowEmpty = false } = {}) {
  return typeof value === "string" && (allowEmpty || value.length > 0);
}

function validateClientInfo(clientInfo) {
  if (!isPlainObject(clientInfo) || !validBoundedString(clientInfo.name) || !validBoundedString(clientInfo.version) ||
      !Object.keys(clientInfo).every((key) => key === "name" || key === "version")) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
  return { name: clientInfo.name, version: clientInfo.version };
}

function validateMetadata(result) {
  if (!isPlainObject(result) || !validBoundedString(result.userAgent) ||
      !validBoundedString(result.codexHome) || !path.isAbsolute(result.codexHome) ||
      !validBoundedString(result.platformFamily) || !validBoundedString(result.platformOs)) {
    throw ownedError("APP_SERVER_CLIENT_INITIALIZE_FAILED");
  }
  return {
    userAgent: result.userAgent,
    codexHome: result.codexHome,
    platformFamily: result.platformFamily,
    platformOs: result.platformOs
  };
}

function validateExactObject(value, allowedKeys) {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => allowedKeys.has(key))) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
}

function validateThreadId(value) {
  if (!validBoundedString(value)) throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
}

function validateThreadOptions(options, { requireThreadId = false } = {}) {
  const allowed = requireThreadId ? new Set([...THREAD_OPTION_KEYS, "threadId"]) : THREAD_OPTION_KEYS;
  validateExactObject(options, allowed);
  if (requireThreadId) validateThreadId(options.threadId);
  if (Object.hasOwn(options, "cwd") && (!validBoundedString(options.cwd) || !path.isAbsolute(options.cwd))) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
  if (Object.hasOwn(options, "model") && !validBoundedString(options.model)) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
  for (const key of ["baseInstructions", "developerInstructions"]) {
    if (Object.hasOwn(options, key) && !validContentString(options[key], { allowEmpty: true })) {
      throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
    }
  }
  if (Object.hasOwn(options, "approvalPolicy") &&
      !["untrusted", "on-failure", "on-request", "never"].includes(options.approvalPolicy)) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
  if (Object.hasOwn(options, "sandbox") &&
      !["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) {
    throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
  }
}

function copyThreadOptions(options) {
  const result = {};
  for (const key of ["cwd", "model", "approvalPolicy", "sandbox", "baseInstructions", "developerInstructions"]) {
    if (Object.hasOwn(options, key)) result[key] = options[key];
  }
  return result;
}

export class CodexAppServerClient {
  #child;
  #clientInfo;
  #diagnosticCallback;
  #explicitClose = false;
  #initializePromise = null;
  #initializeTimeoutMs;
  #metadata = null;
  #ownedChild;
  #rpc;
  #state = "created";
  #stderrBytes = 0;
  #stderrEvents = 0;
  #terminalCallback;
  #terminalError = null;
  #transport;

  constructor({
    childProcess,
    executablePath = process.env.CODEX_EXECUTABLE || "codex",
    spawn = spawnProcess,
    clientInfo = { name: "hermes-codex-orchestrator", version: "0.1.0" },
    initializeTimeoutMs = DEFAULT_INITIALIZE_TIMEOUT_MS,
    requestHandlers,
    onDiagnostic = () => undefined,
    onNotification = () => undefined,
    onServerRequest = () => undefined,
    onTerminal = () => undefined
  } = {}) {
    if (!validBoundedString(executablePath) || typeof spawn !== "function" ||
        !Number.isSafeInteger(initializeTimeoutMs) || initializeTimeoutMs <= 0 ||
        typeof onDiagnostic !== "function" || typeof onNotification !== "function" ||
        typeof onServerRequest !== "function" || typeof onTerminal !== "function") {
      throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
    }
    this.#clientInfo = validateClientInfo(clientInfo);
    this.#initializeTimeoutMs = initializeTimeoutMs;
    this.#diagnosticCallback = onDiagnostic;
    this.#terminalCallback = onTerminal;
    this.#ownedChild = childProcess === undefined;

    try {
      this.#child = childProcess ?? spawn(executablePath, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      throw ownedError("APP_SERVER_CLIENT_PROCESS_INVALID");
    }
    if (!this.#validChild(this.#child)) {
      if (this.#ownedChild && typeof this.#child?.kill === "function") {
        try { this.#child.kill(); } catch { /* owned invalid child is already unusable */ }
      }
      throw ownedError("APP_SERVER_CLIENT_PROCESS_INVALID");
    }

    this.#transport = new NdjsonTransport({ readable: this.#child.stdout, writable: this.#child.stdin });
    this.#rpc = new AppServerRpcClient({
      transport: this.#transport,
      requestHandlers,
      onDiagnostic,
      onNotification,
      onServerRequest
    });
    this.#transport.on("terminal", this.#onTransportTerminal);
    this.#child.stderr.on("data", this.#onStderr);
    this.#child.on("error", this.#onChildError);
    this.#child.on("exit", this.#onChildExit);
  }

  initialize() {
    if (this.#state === "ready") return Promise.resolve(this.#metadata);
    if (this.#state === "initializing") return this.#initializePromise;
    if (this.#state === "closed") return Promise.reject(ownedError("APP_SERVER_CLIENT_CLOSED"));

    this.#state = "initializing";
    let deadline;
    const deadlinePromise = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(ownedError("APP_SERVER_CLIENT_INITIALIZE_FAILED")),
        this.#initializeTimeoutMs);
      deadline.unref?.();
    });
    const handshake = this.#rpc.request("initialize", {
      clientInfo: this.#clientInfo,
      capabilities: { experimentalApi: false }
    }, { timeoutMs: this.#initializeTimeoutMs }).then(async (result) => {
      const metadata = validateMetadata(result);
      await this.#rpc.notify("initialized");
      if (this.#state === "closed") throw this.#terminalError ?? ownedError("APP_SERVER_CLIENT_CLOSED");
      this.#metadata = metadata;
      this.#state = "ready";
      return metadata;
    });
    this.#initializePromise = Promise.race([handshake, deadlinePromise]).catch(() => {
      const error = ownedError("APP_SERVER_CLIENT_INITIALIZE_FAILED");
      this.#fail(error, true);
      throw error;
    }).finally(() => {
      clearTimeout(deadline);
    });
    return this.#initializePromise;
  }

  startThread(options = {}) {
    return this.#business(() => {
      validateThreadOptions(options);
      return this.#requestBusiness("thread/start", { ...copyThreadOptions(options), ephemeral: false });
    });
  }

  resumeThread(options) {
    return this.#business(() => {
      validateThreadOptions(options, { requireThreadId: true });
      return this.#requestBusiness("thread/resume", { threadId: options.threadId, ...copyThreadOptions(options) });
    });
  }

  readThread(options) {
    return this.#business(() => {
      validateExactObject(options, new Set(["threadId", "includeTurns"]));
      validateThreadId(options.threadId);
      if (Object.hasOwn(options, "includeTurns") && typeof options.includeTurns !== "boolean") {
        throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
      }
      const params = { threadId: options.threadId };
      if (Object.hasOwn(options, "includeTurns")) params.includeTurns = options.includeTurns;
      return this.#requestBusiness("thread/read", params);
    });
  }

  startTurn(options) {
    return this.#business(() => {
      validateExactObject(options, new Set(["threadId", "text", "clientUserMessageId"]));
      validateThreadId(options.threadId);
      if (!validContentString(options.text, { allowEmpty: true })) {
        throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
      }
      if (Object.hasOwn(options, "clientUserMessageId") && !validBoundedString(options.clientUserMessageId)) {
        throw ownedError("APP_SERVER_CLIENT_ARGUMENT_INVALID");
      }
      const params = { threadId: options.threadId, input: [{ type: "text", text: options.text }] };
      if (Object.hasOwn(options, "clientUserMessageId")) params.clientUserMessageId = options.clientUserMessageId;
      return this.#requestBusiness("turn/start", params);
    });
  }

  interruptTurn(options) {
    return this.#business(() => {
      validateExactObject(options, new Set(["threadId", "turnId"]));
      validateThreadId(options.threadId);
      validateThreadId(options.turnId);
      return this.#requestBusiness("turn/interrupt", { threadId: options.threadId, turnId: options.turnId });
    });
  }

  setRequestHandler(method, handler) {
    return this.#rpc.setRequestHandler(method, handler);
  }

  respond(id, result) {
    return this.#rpc.respond(id, result);
  }

  respondError(id, error) {
    return this.#rpc.respondError(id, error);
  }

  close() {
    if (this.#explicitClose) return;
    this.#explicitClose = true;
    if (this.#state !== "closed") {
      this.#fail(ownedError("APP_SERVER_CLIENT_CLOSED"), true);
    } else {
      this.#terminateOwnedChild();
    }
  }

  #business(operation) {
    if (this.#state === "closed") return Promise.reject(ownedError("APP_SERVER_CLIENT_CLOSED"));
    if (this.#state !== "ready") return Promise.reject(ownedError("APP_SERVER_CLIENT_NOT_INITIALIZED"));
    try {
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #requestBusiness(method, params) {
    return this.#rpc.request(method, params).then((result) => {
      if (!isPlainObject(result)) throw ownedError("APP_SERVER_CLIENT_RESPONSE_INVALID");
      return result;
    });
  }

  #validChild(child) {
    return child && typeof child.on === "function" && typeof child.kill === "function" &&
      isStream(child.stdin, "write") && typeof child.stdin.end === "function" &&
      isStream(child.stdout, "removeListener") && isStream(child.stderr, "removeListener");
  }

  #onStderr = (chunk) => {
    if (this.#stderrEvents >= MAX_STDERR_EVENTS || this.#stderrBytes >= MAX_STDERR_BYTES) return;
    const bytes = Math.min(Buffer.byteLength(chunk), MAX_STDERR_BYTES - this.#stderrBytes);
    this.#stderrBytes += bytes;
    this.#stderrEvents += 1;
    this.#emit(this.#diagnosticCallback, {
      code: "APP_SERVER_CLIENT_STDERR",
      message: DIAGNOSTIC_MESSAGES.APP_SERVER_CLIENT_STDERR,
      bytes,
      truncated: bytes < Buffer.byteLength(chunk) || this.#stderrBytes === MAX_STDERR_BYTES
    });
  };

  #onChildError = () => {
    if (!this.#explicitClose) this.#emitDiagnostic("APP_SERVER_CLIENT_CHILD_FAILED");
    this.#fail(ownedError("APP_SERVER_CLIENT_CHILD_FAILED"), false);
  };

  #onChildExit = () => {
    if (!this.#explicitClose) this.#emitDiagnostic("APP_SERVER_CLIENT_CHILD_EXITED");
    this.#fail(ownedError("APP_SERVER_CLIENT_CHILD_EXITED"), false);
  };

  #onTransportTerminal = (error) => {
    this.#fail(error, true);
  };

  #fail(error, terminateOwnedChild) {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#terminalError = error;
    this.#rpc?.terminate(error);
    if (!this.#transport.closed) this.#transport.close();
    this.#emit(this.#terminalCallback, error);
    if (terminateOwnedChild) this.#terminateOwnedChild();
  }

  #terminateOwnedChild() {
    if (!this.#ownedChild || !this.#child) return;
    const child = this.#child;
    this.#child = null;
    try { child.kill(); } catch { /* the owned process is already terminal */ }
  }

  #emitDiagnostic(code) {
    this.#emit(this.#diagnosticCallback, { code, message: DIAGNOSTIC_MESSAGES[code] });
  }

  #emit(callback, value) {
    queueMicrotask(() => {
      try {
        Promise.resolve(callback(value)).catch(() => undefined);
      } catch { /* observer failures do not affect protocol state */ }
    });
  }
}
