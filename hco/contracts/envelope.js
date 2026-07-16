import { createHmac, timingSafeEqual } from "node:crypto";

const MINIMUM_KEY_BYTES = 32;
const DEFAULT_MAX_TOKEN_BYTES = 4096;
const MAX_LIFETIME_SECONDS = 120;
const MAX_CLOCK_SKEW_SECONDS = 30;
const BINDING_FIELDS = Object.freeze(["streamId", "topic", "sourceMessageId", "senderId"]);

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function keyBytes(key) {
  let bytes;
  if (typeof key === "string") {
    bytes = Buffer.from(key, "utf8");
  } else if (Buffer.isBuffer(key) || key instanceof Uint8Array) {
    bytes = Buffer.from(key);
  } else {
    bytes = Buffer.alloc(0);
  }

  if (bytes.byteLength < MINIMUM_KEY_BYTES) {
    throw contextError("CONTEXT_KEY_TOO_SHORT", "Context signing key must be at least 32 bytes.");
  }
  return bytes;
}

function tokenLimit(options) {
  const limit = options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_MAX_TOKEN_BYTES) {
    throw contextError("CONTEXT_OPTIONS_INVALID", "Context token size limit is invalid.");
  }
  return limit;
}

function canonicalJson(value) {
  const ancestors = new Set();

  function serialize(current) {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload contains an invalid number.");
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object") {
      throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload contains an unsupported value.");
    }
    if (ancestors.has(current)) {
      throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload must not contain cycles.");
    }

    ancestors.add(current);
    let serialized;
    if (Array.isArray(current)) {
      const items = [];
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload arrays must not be sparse.");
        }
        items.push(serialize(current[index]));
      }
      serialized = `[${items.join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload must contain plain objects.");
      }
      serialized = `{${Object.keys(current)
        .sort()
        .map((name) => `${JSON.stringify(name)}:${serialize(current[name])}`)
        .join(",")}}`;
    }
    ancestors.delete(current);
    return serialized;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contextError("CONTEXT_PAYLOAD_INVALID", "Context payload must be an object.");
  }
  return serialize(value);
}

function signatureFor(encodedPayload, key) {
  return createHmac("sha256", key).update(encodedPayload, "ascii").digest();
}

function assertWithinLimit(token, limit) {
  if (Buffer.byteLength(token, "utf8") > limit) {
    throw contextError("CONTEXT_TOKEN_TOO_LARGE", "Context token exceeds the encoded size limit.");
  }
}

function decodeBase64Url(value, code) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw contextError(code, "Context token encoding is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw contextError(code, "Context token encoding is invalid.");
  }
  return decoded;
}

function safeSignatureMatch(actual, expected) {
  const comparable = Buffer.alloc(expected.byteLength);
  actual.copy(comparable, 0, 0, Math.min(actual.byteLength, comparable.byteLength));
  return timingSafeEqual(comparable, expected) && actual.byteLength === expected.byteLength;
}

function validateTimes(payload, options) {
  const nowProvider = options.now ?? (() => Math.floor(Date.now() / 1000));
  const skew = options.clockSkewSeconds ?? MAX_CLOCK_SKEW_SECONDS;
  if (typeof nowProvider !== "function" || !Number.isFinite(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS) {
    throw contextError("CONTEXT_OPTIONS_INVALID", "Context verification clock options are invalid.");
  }

  const now = nowProvider();
  const { issuedAt, expiresAt } = payload;
  if (![now, issuedAt, expiresAt].every(Number.isFinite) || expiresAt <= issuedAt) {
    throw contextError("CONTEXT_LIFETIME_INVALID", "Context token lifetime is invalid.");
  }
  if (expiresAt - issuedAt > MAX_LIFETIME_SECONDS) {
    throw contextError("CONTEXT_LIFETIME_INVALID", "Context token lifetime exceeds 120 seconds.");
  }
  if (issuedAt > now + skew) {
    throw contextError("CONTEXT_NOT_YET_VALID", "Context token was issued too far in the future.");
  }
  if (expiresAt < now - skew) {
    throw contextError("CONTEXT_EXPIRED", "Context token has expired.");
  }
}

function validateVersion(payload) {
  if (!Number.isSafeInteger(payload.version) || payload.version !== 1) {
    throw contextError("CONTEXT_VERSION_UNSUPPORTED", "Context envelope version is unsupported.");
  }
}

function isValidBinding(binding) {
  return (
    binding !== null &&
    typeof binding === "object" &&
    Number.isSafeInteger(binding.streamId) &&
    binding.streamId > 0 &&
    typeof binding.topic === "string" &&
    binding.topic.trim().length > 0 &&
    Number.isSafeInteger(binding.sourceMessageId) &&
    binding.sourceMessageId > 0 &&
    Number.isSafeInteger(binding.senderId) &&
    binding.senderId > 0
  );
}

function validateBinding(payload, expectedBinding) {
  if (!expectedBinding || typeof expectedBinding !== "object") {
    throw contextError("CONTEXT_BINDING_REQUIRED", "Expected message binding is required.");
  }
  if (!isValidBinding(payload.binding) || !isValidBinding(expectedBinding)) {
    throw contextError("CONTEXT_BINDING_INVALID", "Context token message binding is invalid.");
  }
  if (BINDING_FIELDS.some((field) => !Object.is(payload.binding[field], expectedBinding[field]))) {
    throw contextError("CONTEXT_BINDING_MISMATCH", "Context token message binding does not match.");
  }
}

function recordNonce(payload, replayStore) {
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
    throw contextError("CONTEXT_NONCE_INVALID", "Context token nonce is invalid.");
  }

  let consume;
  try {
    consume = replayStore?.consume;
  } catch {
    throw contextError("CONTEXT_REPLAY_STORE_FAILED", "Context replay store failed.");
  }
  if (typeof consume !== "function") {
    throw contextError("CONTEXT_REPLAY_STORE_INVALID", "Context replay store is invalid.");
  }

  let consumed;
  try {
    consumed = consume.call(replayStore, { nonce: payload.nonce, expiresAt: payload.expiresAt });
  } catch {
    throw contextError("CONTEXT_REPLAY_STORE_FAILED", "Context replay store failed.");
  }
  if (typeof consumed !== "boolean") {
    throw contextError("CONTEXT_REPLAY_STORE_INVALID", "Context replay store returned an invalid result.");
  }
  if (!consumed) {
    throw contextError("CONTEXT_NONCE_REPLAYED", "Context token nonce has already been used.");
  }
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

export function signContext(payload, key, options = {}) {
  const signingKey = keyBytes(key);
  const limit = tokenLimit(options);
  const encodedPayload = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const encodedSignature = signatureFor(encodedPayload, signingKey).toString("base64url");
  const token = `${encodedPayload}.${encodedSignature}`;
  assertWithinLimit(token, limit);
  return token;
}

export function verifyContext(token, key, options = {}) {
  const signingKey = keyBytes(key);
  const limit = tokenLimit(options);
  if (typeof token !== "string") {
    throw contextError("CONTEXT_TOKEN_INVALID", "Context token must be a string.");
  }
  assertWithinLimit(token, limit);

  const segments = token.split(".");
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
    throw contextError("CONTEXT_TOKEN_INVALID", "Context token format is invalid.");
  }
  const [encodedPayload, encodedSignature] = segments;
  const actualSignature = decodeBase64Url(encodedSignature, "CONTEXT_SIGNATURE_INVALID");
  const expectedSignature = signatureFor(encodedPayload, signingKey);
  if (!safeSignatureMatch(actualSignature, expectedSignature)) {
    throw contextError("CONTEXT_SIGNATURE_INVALID", "Context token signature is invalid.");
  }

  const payloadBytes = decodeBase64Url(encodedPayload, "CONTEXT_TOKEN_INVALID");
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw contextError("CONTEXT_TOKEN_INVALID", "Context token payload is invalid.");
  }
  if (Buffer.from(canonicalJson(payload), "utf8").toString("base64url") !== encodedPayload) {
    throw contextError("CONTEXT_CANONICAL_INVALID", "Context token payload is not canonical.");
  }

  validateVersion(payload);
  validateTimes(payload, options);
  validateBinding(payload, options.expectedBinding);
  recordNonce(payload, options.replayStore);
  return deepFreeze(payload);
}
