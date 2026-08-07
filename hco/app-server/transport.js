import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";
import { isInteger, isSafeNumber, parse, stringify } from "lossless-json";

// App Server tool results can legitimately include multi-MiB bounded command
// output. Keep a finite transport cap without terminating those valid turns.
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = (2n ** 63n) - 1n;

const ERROR_MESSAGES = Object.freeze({
  APP_SERVER_TRANSPORT_CLOSED: "App Server transport is closed.",
  APP_SERVER_TRANSPORT_EOF: "App Server transport reached end of input.",
  APP_SERVER_TRANSPORT_FRAME_INVALID: "App Server transport received an invalid frame.",
  APP_SERVER_TRANSPORT_FRAME_TOO_LARGE: "App Server transport frame exceeds the configured limit.",
  APP_SERVER_TRANSPORT_PREMATURE_CLOSE: "App Server transport stream closed prematurely.",
  APP_SERVER_TRANSPORT_SEND_CANCELLED: "App Server transport send was cancelled before writing.",
  APP_SERVER_TRANSPORT_STREAM_FAILED: "App Server transport stream failed.",
  APP_SERVER_TRANSPORT_VALUE_INVALID: "App Server transport cannot encode the supplied value."
});

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

function validateJsonValue(value, seen, location = "other") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "bigint") {
    if ((location !== "top-level-id" && location !== "top-level-error-code") ||
        value < MIN_INT64 || value > MAX_INT64) {
      throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
    return;
  }
  if (typeof value !== "object") throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
  if (seen.has(value)) throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
        validateJsonValue(value[index], seen);
      }
      return;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
      }
      let childLocation = "other";
      if (location === "root" && key === "id") childLocation = "top-level-id";
      else if (location === "root" && key === "error") childLocation = "top-level-error";
      else if (location === "top-level-error" && key === "code") {
        childLocation = "top-level-error-code";
      }
      validateJsonValue(descriptor.value, seen, childLocation);
    }
  } finally {
    seen.delete(value);
  }
}

function encodeObject(value) {
  if (!isPlainObject(value)) throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
  try {
    validateJsonValue(value, new Set(), "root");
    const encoded = stringify(value);
    if (typeof encoded !== "string") throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
    return `${encoded}\n`;
  } catch (error) {
    if (error?.code === "APP_SERVER_TRANSPORT_VALUE_INVALID") throw error;
    throw ownedError("APP_SERVER_TRANSPORT_VALUE_INVALID");
  }
}

function parseWireNumber(value) {
  if (isSafeNumber(value)) return Number(value);
  if (isInteger(value)) return BigInt(value);
  return Number(value);
}

function isReadableStream(stream) {
  return stream && typeof stream.on === "function" && typeof stream.removeListener === "function";
}

function isWritableStream(stream) {
  return isReadableStream(stream) && typeof stream.write === "function";
}

/**
 * LF-delimited JSON transport. Emits `message` for decoded objects and exactly
 * one `terminal` event carrying a transport-owned error when the stream ends.
 */
export class NdjsonTransport extends EventEmitter {
  #ended = false;
  #frameBytes = 0;
  #frameParts = [];
  #maxFrameBytes;
  #readable;
  #sendTail = Promise.resolve();
  #terminalError = null;
  #writable;

  constructor({ readable, writable, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    super();
    if (!isReadableStream(readable) || !isWritableStream(writable) ||
        !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw ownedError("APP_SERVER_TRANSPORT_STREAM_FAILED");
    }
    this.#readable = readable;
    this.#writable = writable;
    this.#maxFrameBytes = maxFrameBytes;

    readable.on("data", this.#onData);
    readable.on("end", this.#onEnd);
    readable.on("error", this.#onStreamError);
    readable.on("close", this.#onReadableClose);
    writable.on("error", this.#onStreamError);
    writable.on("close", this.#onWritableClose);
  }

  get closed() {
    return this.#terminalError !== null;
  }

  send(value, { signal } = {}) {
    if (this.closed) return Promise.reject(ownedError("APP_SERVER_TRANSPORT_CLOSED"));

    let frame;
    try {
      frame = encodeObject(value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(frame, "utf8") - 1 > this.#maxFrameBytes) {
      return Promise.reject(ownedError("APP_SERVER_TRANSPORT_FRAME_TOO_LARGE"));
    }

    const operation = this.#sendTail.then(() => this.#writeFrame(frame, signal));
    this.#sendTail = operation.catch(() => undefined);
    return operation;
  }

  close() {
    if (this.closed) return;
    this.#terminate(ownedError("APP_SERVER_TRANSPORT_CLOSED"));
    if (!this.#writable.writableEnded && typeof this.#writable.end === "function") {
      this.#writable.end();
    }
  }

  #onData = (chunk) => {
    if (this.closed) return;
    let bytes;
    try {
      bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } catch {
      this.#terminate(ownedError("APP_SERVER_TRANSPORT_FRAME_INVALID"));
      return;
    }

    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const lineFeed = bytes.indexOf(0x0a, offset);
      const end = lineFeed === -1 ? bytes.length : lineFeed;
      const part = bytes.subarray(offset, end);
      if (!this.#appendPart(part)) return;
      if (lineFeed === -1) return;
      if (!this.#dispatchFrame()) return;
      offset = lineFeed + 1;
    }
  };

  #appendPart(part) {
    if (this.#frameBytes + part.length > this.#maxFrameBytes) {
      this.#terminate(ownedError("APP_SERVER_TRANSPORT_FRAME_TOO_LARGE"));
      return false;
    }
    if (part.length > 0) this.#frameParts.push(part);
    this.#frameBytes += part.length;
    return true;
  }

  #dispatchFrame() {
    const bytes = this.#frameParts.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat(this.#frameParts, this.#frameBytes);
    this.#frameParts = [];
    this.#frameBytes = 0;

    let value;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.trim().length === 0) throw new Error("blank");
      value = parse(text, undefined, { parseNumber: parseWireNumber });
      if (!isPlainObject(value)) throw new Error("not object");
    } catch {
      this.#terminate(ownedError("APP_SERVER_TRANSPORT_FRAME_INVALID"));
      return false;
    }
    this.emit("message", value);
    return true;
  }

  #onEnd = () => {
    if (this.closed) return;
    this.#ended = true;
    if (this.#frameBytes > 0 && !this.#dispatchFrame()) return;
    this.#terminate(ownedError("APP_SERVER_TRANSPORT_EOF"));
  };

  #onReadableClose = () => {
    if (!this.closed && !this.#ended) {
      this.#terminate(ownedError("APP_SERVER_TRANSPORT_PREMATURE_CLOSE"));
    }
  };

  #onWritableClose = () => {
    if (!this.closed) this.#terminate(ownedError("APP_SERVER_TRANSPORT_PREMATURE_CLOSE"));
  };

  #onStreamError = () => {
    this.#terminate(ownedError("APP_SERVER_TRANSPORT_STREAM_FAILED"));
  };

  #terminate(error) {
    if (this.closed) return;
    this.#terminalError = error;
    this.#frameParts = [];
    this.#frameBytes = 0;
    this.emit("terminal", error);
  }

  async #writeFrame(frame, signal) {
    if (signal?.aborted) throw ownedError("APP_SERVER_TRANSPORT_SEND_CANCELLED");
    if (this.closed) throw ownedError("APP_SERVER_TRANSPORT_CLOSED");
    let accepted;
    try {
      accepted = this.#writable.write(frame);
    } catch {
      this.#terminate(ownedError("APP_SERVER_TRANSPORT_STREAM_FAILED"));
      throw ownedError("APP_SERVER_TRANSPORT_STREAM_FAILED");
    }
    if (accepted) return;

    await new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onTerminal = () => {
        cleanup();
        reject(ownedError("APP_SERVER_TRANSPORT_STREAM_FAILED"));
      };
      const cleanup = () => {
        this.#writable.removeListener("drain", onDrain);
        this.removeListener("terminal", onTerminal);
      };
      this.#writable.once("drain", onDrain);
      this.once("terminal", onTerminal);
      if (this.closed) onTerminal();
    });
  }
}
