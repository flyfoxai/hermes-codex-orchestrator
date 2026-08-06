import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const OWNED_ERRORS = new WeakSet();
const HASH = /^[a-f0-9]{64}$/u;
const HASH12 = /^[a-f0-9]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,511}$/u;
const RELATIVE_UPLOAD = /^upload\/[A-Za-z0-9][A-Za-z0-9._:-]{15,511}$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_SEALED_FILES = 64;

export const FILE_ATTEMPT_BINDING_VERSION = 1;
export const MANAGED_FILE_EXCHANGE_PROFILE = "local_single_broker_exchange/v1";

export const UNSUPPORTED_FILE_EXCHANGE_CAPABILITY = Object.freeze({
  profile: MANAGED_FILE_EXCHANGE_PROFILE,
  supported: false,
  physicalSeal: false,
  enforcedUploadLimits: false,
  anchoredUploadDirectories: false,
  capabilityRevision: null,
  limitProfileDigest: null,
  maxDepth: null,
  maximumFilesPerAttempt: null,
  maximumBytesPerAttempt: null,
  maximumBytesPerWork: null,
  hcoReserveBytes: null,
  maximumRetentionMs: null,
  maxEffectivePathUnits: null,
  pathUnits: null
});

export function fileExchangeError(code, message) {
  const error = new Error(message);
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isFileExchangeError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

function fail(code = "FILE_EXCHANGE_CONTRACT_INVALID", message = "Managed file exchange contract is invalid.") {
  throw fileExchangeError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function keyBytes(value) {
  if ((!Buffer.isBuffer(value) && typeof value !== "string") || Buffer.byteLength(value) < 32) fail();
  return value;
}

function hmac(key, value) {
  return createHmac("sha256", keyBytes(key)).update(canonicalizeFileExchangeJson(value), "utf8").digest("hex");
}

function macMatches(left, right) {
  if (!HASH.test(left) || !HASH.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function canonicalizeFileExchangeJson(value) {
  const ancestors = new Set();
  const chunks = [];
  let bytes = 0;

  function append(text) {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CANONICAL_BYTES) fail();
    chunks.push(text);
  }

  function serialize(current) {
    if (current === null) return append("null");
    if (typeof current === "string") {
      if (!validUnicode(current)) fail();
      return append(JSON.stringify(current));
    }
    if (typeof current === "boolean") return append(current ? "true" : "false");
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail();
      return append(JSON.stringify(current));
    }
    if (typeof current !== "object" || ancestors.has(current)) fail();
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        append("[");
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) fail();
          if (index > 0) append(",");
          serialize(current[index]);
        }
        append("]");
        return;
      }
      if (!plainObject(current)) fail();
      append("{");
      const keys = Object.keys(current).sort();
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (!validUnicode(key) || current[key] === undefined) fail();
        if (index > 0) append(",");
        append(JSON.stringify(key));
        append(":");
        serialize(current[key]);
      }
      append("}");
    } finally {
      ancestors.delete(current);
    }
  }

  serialize(value);
  return chunks.join("");
}

export function fileExchangeDigest(value) {
  return createHash("sha256").update(canonicalizeFileExchangeJson(value), "utf8").digest("hex");
}

export function normalizeFileExchangeCapability(value) {
  if (value === undefined || value === null) return UNSUPPORTED_FILE_EXCHANGE_CAPABILITY;
  const keys = [
    "profile", "supported", "physicalSeal", "enforcedUploadLimits",
    "anchoredUploadDirectories", "capabilityRevision", "limitProfileDigest", "maxDepth",
    "maximumFilesPerAttempt", "maximumBytesPerAttempt", "maximumBytesPerWork",
    "hcoReserveBytes", "maximumRetentionMs", "maxEffectivePathUnits", "pathUnits"
  ];
  if (!plainObject(value) || !exactKeys(value, keys) || value.profile !== MANAGED_FILE_EXCHANGE_PROFILE ||
      typeof value.supported !== "boolean" || typeof value.physicalSeal !== "boolean" ||
      typeof value.enforcedUploadLimits !== "boolean" || typeof value.anchoredUploadDirectories !== "boolean") {
    fail("FILE_EXCHANGE_CAPABILITY_INVALID", "Managed file exchange capability is invalid.");
  }
  if (!value.supported) {
    if (value.physicalSeal || value.enforcedUploadLimits || value.anchoredUploadDirectories ||
        value.capabilityRevision !== null || value.limitProfileDigest !== null || value.maxDepth !== null ||
        value.maximumFilesPerAttempt !== null || value.maximumBytesPerAttempt !== null ||
        value.maximumBytesPerWork !== null || value.hcoReserveBytes !== null ||
        value.maximumRetentionMs !== null || value.maxEffectivePathUnits !== null || value.pathUnits !== null) {
      fail("FILE_EXCHANGE_CAPABILITY_INVALID", "Unsupported file exchange capability must fail closed.");
    }
    return UNSUPPORTED_FILE_EXCHANGE_CAPABILITY;
  }
  if (!value.physicalSeal || !value.enforcedUploadLimits || !value.anchoredUploadDirectories ||
      !boundedText(value.capabilityRevision, 256) || !HASH.test(value.limitProfileDigest) ||
      value.maxDepth !== 1 || !Number.isSafeInteger(value.maximumFilesPerAttempt) ||
      value.maximumFilesPerAttempt <= 0 || !Number.isSafeInteger(value.maximumBytesPerAttempt) ||
      value.maximumBytesPerAttempt <= 0 || !Number.isSafeInteger(value.maximumBytesPerWork) ||
      value.maximumBytesPerWork < value.maximumBytesPerAttempt || !Number.isSafeInteger(value.hcoReserveBytes) ||
      value.hcoReserveBytes <= 0 || !Number.isSafeInteger(value.maximumRetentionMs) ||
      value.maximumRetentionMs <= 0 ||
      !Number.isSafeInteger(value.maxEffectivePathUnits) || value.maxEffectivePathUnits <= 0 ||
      !["utf8_bytes", "utf16_code_units"].includes(value.pathUnits)) {
    fail("FILE_EXCHANGE_CAPABILITY_INVALID", "Supported file exchange capability lacks required enforcement.");
  }
  return Object.freeze({ ...value });
}

export function requireManagedFileExchangeCapability(value) {
  const capability = normalizeFileExchangeCapability(value);
  if (!capability.supported) {
    throw fileExchangeError(
      "FILE_EXCHANGE_UNSUPPORTED",
      "Execution transport does not enforce managed file exchange."
    );
  }
  return capability;
}

export function normalizeDigest(value) {
  if (typeof value !== "string" || !HASH.test(value)) fail();
  return value;
}

export function normalizeRootIdentity(value) {
  if (!plainObject(value) || value.platform !== "posix" ||
      !exactKeys(value, ["platform", "dev", "ino"]) ||
      !/^[0-9]+$/u.test(value.dev) || !/^[0-9]+$/u.test(value.ino)) {
    fail("UPLOAD_ROOT_IDENTITY_INVALID", "Upload root identity is invalid or unsupported on this platform.");
  }
  return Object.freeze({ platform: "posix", dev: value.dev, ino: value.ino });
}

export function rootIdentityFromStat(status) {
  if (!status || status.dev === undefined || status.ino === undefined) {
    fail("UPLOAD_ROOT_IDENTITY_INVALID", "Upload root status is invalid.");
  }
  return normalizeRootIdentity({ platform: "posix", dev: String(status.dev), ino: String(status.ino) });
}

export function sameRootIdentity(left, right) {
  const normalizedLeft = normalizeRootIdentity(left);
  const normalizedRight = normalizeRootIdentity(right);
  return normalizedLeft.platform === normalizedRight.platform &&
    normalizedLeft.dev === normalizedRight.dev && normalizedLeft.ino === normalizedRight.ino;
}

function ownerReceiptPayload(value) {
  return {
    receipt_version: value.receipt_version,
    work_id: value.work_id,
    lock_identity: value.lock_identity,
    owner_lock_token_digest: value.owner_lock_token_digest,
    process_instance_id: value.process_instance_id,
    acquired_at: value.acquired_at,
    key_id: value.key_id
  };
}

export function normalizeOwnerReceipt(value) {
  const keys = [
    "receipt_version", "work_id", "lock_identity", "owner_lock_token_digest",
    "process_instance_id", "acquired_at", "key_id", "receipt_mac"
  ];
  if (!plainObject(value) || !exactKeys(value, keys) || value.receipt_version !== 1 ||
      !boundedText(value.work_id) || !boundedText(value.lock_identity, 1024) ||
      !HASH.test(value.owner_lock_token_digest) || !boundedText(value.process_instance_id) ||
      !Number.isSafeInteger(value.acquired_at) || value.acquired_at < 0 ||
      !boundedText(value.key_id, 128) || !HASH.test(value.receipt_mac)) {
    fail("FILE_BROKER_OWNER_RECEIPT_INVALID", "File broker owner receipt is invalid.");
  }
  return Object.freeze({ ...value });
}

export function signOwnerReceipt(value, { key, keyId }) {
  if (!plainObject(value) || !boundedText(keyId, 128)) {
    fail("FILE_BROKER_OWNER_RECEIPT_INVALID", "File broker owner receipt inputs are invalid.");
  }
  const unsigned = ownerReceiptPayload({ ...value, receipt_version: 1, key_id: keyId });
  return normalizeOwnerReceipt({ ...unsigned, receipt_mac: hmac(key, unsigned) });
}

export function verifyOwnerReceipt(value, { key, expectedKeyId, workId, ownerLockToken } = {}) {
  const receipt = normalizeOwnerReceipt(value);
  const tokenDigest = typeof ownerLockToken === "string"
    ? createHash("sha256").update(ownerLockToken, "utf8").digest("hex")
    : null;
  if ((expectedKeyId !== undefined && receipt.key_id !== expectedKeyId) ||
      (workId !== undefined && receipt.work_id !== workId) ||
      (tokenDigest !== null && receipt.owner_lock_token_digest !== tokenDigest) ||
      !macMatches(receipt.receipt_mac, hmac(key, ownerReceiptPayload(receipt)))) {
    fail("FILE_BROKER_OWNER_RECEIPT_INVALID", "File broker owner receipt could not be verified.");
  }
  return receipt;
}

export function digestOwnerReceipt(value) {
  const receipt = normalizeOwnerReceipt(value);
  return Object.freeze({
    receipt,
    canonicalJson: canonicalizeFileExchangeJson(receipt),
    digest: fileExchangeDigest(receipt)
  });
}

export function createFileAttemptRequest(value) {
  const required = [
    "binding_version", "file_attempt_id", "work_id", "command_id", "scope_digest",
    "creator_file_broker_epoch", "upload_relpath", "limit_profile_digest", "expires_at"
  ];
  if (!plainObject(value) || !exactKeys(value, required, ["expected_thread_id"]) ||
      value.binding_version !== FILE_ATTEMPT_BINDING_VERSION || !OPAQUE_ID.test(value.file_attempt_id) ||
      !boundedText(value.work_id) || !boundedText(value.command_id) ||
      !HASH.test(value.scope_digest) || !HASH.test(value.limit_profile_digest) ||
      !Number.isSafeInteger(value.creator_file_broker_epoch) || value.creator_file_broker_epoch <= 0 ||
      !RELATIVE_UPLOAD.test(value.upload_relpath) ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at < 0 ||
      (Object.hasOwn(value, "expected_thread_id") && !boundedText(value.expected_thread_id))) {
    fail();
  }
  return Object.freeze({ ...value });
}

export function digestFileAttemptRequest(value) {
  const request = createFileAttemptRequest(value);
  return Object.freeze({
    request,
    canonicalJson: canonicalizeFileExchangeJson(request),
    digest: fileExchangeDigest(request)
  });
}

export function resolvedFileAttemptBindingDigest({ fileAttemptRequestDigest, threadId, turnId }) {
  if (!HASH.test(fileAttemptRequestDigest) || !boundedText(threadId) || !boundedText(turnId)) fail();
  const resolved = Object.freeze({
    binding_version: FILE_ATTEMPT_BINDING_VERSION,
    file_attempt_request_digest: fileAttemptRequestDigest,
    thread_id: threadId,
    turn_id: turnId
  });
  return Object.freeze({
    resolved,
    canonicalJson: canonicalizeFileExchangeJson(resolved),
    digest: fileExchangeDigest(resolved)
  });
}

function normalizeSealedFiles(value) {
  if (!Array.isArray(value) || value.length > MAX_SEALED_FILES || Object.keys(value).length !== value.length) {
    fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "Sealed file list is invalid.");
  }
  const names = new Set();
  return Object.freeze(value.map((entry) => {
    if (!plainObject(entry) || !exactKeys(entry, ["source_name", "mime_type", "bytes", "sha256"]) ||
        !SAFE_COMPONENT.test(entry.source_name) || names.has(entry.source_name.toLowerCase()) ||
        !boundedText(entry.mime_type, 192) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !HASH.test(entry.sha256)) {
      fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "Sealed file entry is invalid.");
    }
    names.add(entry.source_name.toLowerCase());
    return Object.freeze({ ...entry });
  }));
}

function sealReceiptPayload(value) {
  return {
    receipt_version: value.receipt_version,
    seal_command_id: value.seal_command_id,
    resolved_file_attempt_binding_digest: value.resolved_file_attempt_binding_digest,
    isolation_instance_id: value.isolation_instance_id,
    enforcement_adapter_revision: value.enforcement_adapter_revision,
    creator_file_broker_epoch: value.creator_file_broker_epoch,
    sealed_at: value.sealed_at,
    files: value.files,
    key_id: value.key_id
  };
}

export function normalizeSealReceipt(value) {
  const keys = [
    "receipt_version", "seal_command_id", "resolved_file_attempt_binding_digest", "isolation_instance_id",
    "enforcement_adapter_revision", "creator_file_broker_epoch", "sealed_at", "files", "key_id", "receipt_mac"
  ];
  if (!plainObject(value) || !exactKeys(value, keys) || value.receipt_version !== 1 ||
      !boundedText(value.seal_command_id) || !HASH.test(value.resolved_file_attempt_binding_digest) ||
      !boundedText(value.isolation_instance_id) || !boundedText(value.enforcement_adapter_revision, 256) ||
      !Number.isSafeInteger(value.creator_file_broker_epoch) || value.creator_file_broker_epoch <= 0 ||
      !Number.isSafeInteger(value.sealed_at) || value.sealed_at < 0 ||
      !boundedText(value.key_id, 128) || !HASH.test(value.receipt_mac)) {
    fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "File attempt seal receipt is invalid.");
  }
  return Object.freeze({ ...value, files: normalizeSealedFiles(value.files) });
}

export function signSealReceipt(value, { key, keyId }) {
  if (!plainObject(value) || !boundedText(keyId, 128)) {
    fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "File attempt seal receipt inputs are invalid.");
  }
  const files = normalizeSealedFiles(value.files ?? []);
  const unsigned = sealReceiptPayload({ ...value, receipt_version: 1, files, key_id: keyId });
  return normalizeSealReceipt({ ...unsigned, receipt_mac: hmac(key, unsigned) });
}

export function verifySealReceipt(value, { key, expectedKeyId, sealCommandId } = {}) {
  const receipt = normalizeSealReceipt(value);
  if ((expectedKeyId !== undefined && receipt.key_id !== expectedKeyId) ||
      (sealCommandId !== undefined && receipt.seal_command_id !== sealCommandId) ||
      !macMatches(receipt.receipt_mac, hmac(key, sealReceiptPayload(receipt)))) {
    fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "File attempt seal receipt could not be verified.");
  }
  return receipt;
}

export function digestSealReceipt(value) {
  const receipt = normalizeSealReceipt(value);
  return Object.freeze({
    receipt,
    canonicalJson: canonicalizeFileExchangeJson(receipt),
    digest: fileExchangeDigest(receipt)
  });
}
