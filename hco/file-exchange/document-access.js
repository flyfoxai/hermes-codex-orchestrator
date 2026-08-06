import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { canonicalizeFileExchangeJson, fileExchangeError } from "./contracts.js";

const OPERATIONS = new Set(["READ_RESULT", "READ_EVIDENCE", "READ_TASK_CONTRACT"]);

function fail(code, message) {
  throw fileExchangeError(code, message);
}

function text(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bufferDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMac(key, payload) {
  return createHmac("sha256", key).update(canonicalizeFileExchangeJson(payload), "utf8").digest("hex");
}

function encodeToken(payload, key) {
  const signed = { ...payload, mac: tokenMac(key, payload) };
  return Buffer.from(canonicalizeFileExchangeJson(signed), "utf8").toString("base64url");
}

function decodeToken(token, key, keyId) {
  if (!text(token, 16_384)) fail("DOCUMENT_ACCESS_INVALID", "Document access reference is invalid.");
  let value;
  try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { fail("DOCUMENT_ACCESS_INVALID", "Document access reference is invalid."); }
  if (value?.v !== 1 || value.key_id !== keyId || !text(value.document_id) ||
      !Number.isSafeInteger(value.document_version) || !/^[a-f0-9]{64}$/u.test(value.document_sha256) ||
      !OPERATIONS.has(value.operation) || !/^[a-f0-9]{64}$/u.test(value.consumer_digest) ||
      !text(value.issuance_key, 256) || !Number.isSafeInteger(value.expires_at) || value.expires_at < 0 ||
      !/^[a-f0-9]{64}$/u.test(value.mac)) fail("DOCUMENT_ACCESS_INVALID", "Document access reference is invalid.");
  const unsigned = { ...value };
  delete unsigned.mac;
  const expected = tokenMac(key, unsigned);
  if (!timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(expected, "hex"))) {
    fail("DOCUMENT_ACCESS_INVALID", "Document access reference could not be authenticated.");
  }
  return Object.freeze(value);
}

async function readRegularFile(filePath, maximumBytes) {
  let pathStatus;
  try { pathStatus = await lstat(filePath, { bigint: true }); }
  catch { fail("DOCUMENT_NOT_AVAILABLE", "Document file is unavailable."); }
  if (!pathStatus.isFile() || pathStatus.isSymbolicLink() || pathStatus.nlink !== 1n) {
    fail("DOCUMENT_NOT_AVAILABLE", "Document file is unavailable.");
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== pathStatus.dev || opened.ino !== pathStatus.ino || opened.size > BigInt(maximumBytes)) {
      fail("DOCUMENT_NOT_AVAILABLE", "Document file changed or exceeds its limit.");
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createDocumentAccessBroker({
  store,
  accessKey,
  accessKeyId = "hco-document-access-v1",
  authorize,
  exchangeRootForWork,
  now = Date.now,
  maximumBytes = 64 * 1024 * 1024,
  ttlMs = 60_000
} = {}) {
  if (!store || typeof store.readDocumentManifest !== "function" || typeof store.issueDocumentAccess !== "function" ||
      typeof store.readDocumentAccessByIssuanceKey !== "function" ||
      typeof store.consumeDocumentAccess !== "function" || typeof authorize !== "function" ||
      typeof exchangeRootForWork !== "function" || (!Buffer.isBuffer(accessKey) && typeof accessKey !== "string") ||
      Buffer.byteLength(accessKey) < 32 || !text(accessKeyId, 128) || typeof now !== "function" ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    fail("DOCUMENT_ACCESS_INVALID", "Document access broker options are invalid.");
  }

  return Object.freeze({
    async issue({ documentId, documentVersion, documentSha256, operation, invocationRef, issuanceKey }) {
      if (!text(documentId) || !Number.isSafeInteger(documentVersion) || documentVersion < 1 ||
          !/^[a-f0-9]{64}$/u.test(documentSha256) || !OPERATIONS.has(operation) || !text(invocationRef, 4096) || !text(issuanceKey, 256)) {
        fail("DOCUMENT_ACCESS_INVALID", "Document access issuance is invalid.");
      }
      const authorization = await authorize({ invocationRef, documentId, operation });
      if (!authorization?.allowed || !/^[a-f0-9]{64}$/u.test(authorization.grantDigest)) {
        fail("DOCUMENT_ACCESS_DENIED", "Current invocation cannot read this document.");
      }
      const consumerDigest = digest(invocationRef);
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) fail("STORE_CLOCK_INVALID", "Document access clock is invalid.");
      const previous = store.readDocumentAccessByIssuanceKey(issuanceKey);
      const expiresAt = previous?.expiresAt ?? issuedAt + ttlMs;
      const payload = {
        v: 1,
        key_id: accessKeyId,
        document_id: documentId,
        document_version: documentVersion,
        document_sha256: documentSha256,
        operation,
        consumer_digest: consumerDigest,
        issuance_key: issuanceKey,
        expires_at: expiresAt,
        nonce: digest(`document-access:${issuanceKey}`).slice(0, 32)
      };
      const accessRef = encodeToken(payload, accessKey);
      const issued = store.issueDocumentAccess({
        documentId,
        documentVersion,
        documentSha256,
        operation,
        consumerDigest,
        grantDigest: authorization.grantDigest,
        issuanceKey,
        accessRefDigest: digest(accessRef),
        expiresAt
      });
      return Object.freeze({ accessRef, expiresAt: issued.issue.expiresAt, duplicate: issued.duplicate });
    },

    async read({ accessRef, invocationRef }) {
      if (!text(invocationRef, 4096)) fail("DOCUMENT_ACCESS_INVALID", "Invocation reference is invalid.");
      const token = decodeToken(accessRef, accessKey, accessKeyId);
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || token.expires_at <= currentTime) fail("DOCUMENT_ACCESS_EXPIRED", "Document access reference has expired.");
      if (digest(invocationRef) !== token.consumer_digest) fail("DOCUMENT_ACCESS_DENIED", "Document access reference belongs to another invocation.");
      const authorization = await authorize({ invocationRef, documentId: token.document_id, operation: token.operation });
      if (!authorization?.allowed || authorization.grantDigest !== undefined && !/^[a-f0-9]{64}$/u.test(authorization.grantDigest)) {
        fail("DOCUMENT_ACCESS_DENIED", "Current invocation cannot read this document.");
      }
      const issued = store.readDocumentAccessByIssuanceKey(token.issuance_key);
      if (!issued || issued.accessRefDigest !== digest(accessRef) ||
          issued.documentId !== token.document_id || issued.documentVersion !== token.document_version ||
          issued.documentSha256 !== token.document_sha256 || issued.operation !== token.operation ||
          issued.consumerDigest !== token.consumer_digest) {
        fail("DOCUMENT_ACCESS_INVALID", "Document access reference does not match durable issuance.");
      }
      if (issued.grantDigest !== authorization.grantDigest) {
        fail("DOCUMENT_ACCESS_DENIED", "Document access authorization has changed.");
      }
      const consumed = store.consumeDocumentAccess({
        accessRefDigest: digest(accessRef),
        documentId: token.document_id,
        operation: token.operation,
        consumerDigest: token.consumer_digest
      });
      if (consumed.duplicate) fail("DOCUMENT_ACCESS_REPLAY", "Document access reference has already been consumed.");
      const manifest = store.readDocumentManifest(token.document_id);
      if (!manifest || manifest.state !== "AVAILABLE" || manifest.version !== token.document_version ||
          manifest.expectedSha256 !== token.document_sha256 || manifest.expiresAt <= currentTime) {
        fail("DOCUMENT_NOT_AVAILABLE", "Document is no longer available.");
      }
      const root = await exchangeRootForWork({ workId: manifest.workId, direction: manifest.direction });
      if (typeof root !== "string" || !path.isAbsolute(root)) fail("DOCUMENT_ACCESS_INVALID", "Document root is invalid.");
      const directory = path.join(root, manifest.direction === "INBOX" ? "inbox" : "outbox");
      const content = await readRegularFile(path.join(directory, manifest.finalFilename), maximumBytes);
      if (bufferDigest(content) !== manifest.expectedSha256) fail("DOCUMENT_NOT_AVAILABLE", "Document hash verification failed.");
      return Object.freeze({ manifest, content });
    }
  });
}
