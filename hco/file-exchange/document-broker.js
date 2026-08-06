import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  fileExchangeError,
  fileExchangeDigest,
  isFileExchangeError,
  normalizeDigest,
  normalizeRootIdentity,
  rootIdentityFromStat,
  requireManagedFileExchangeCapability,
  sameRootIdentity
} from "./contracts.js";
import { validateFileExchangeEnforcement } from "./enforcement.js";

const WORK_LANES = new Map();
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const MESSAGE_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ACTOR_CLASSES = new Set(["hermes", "hco", "codex", "agent"]);
const KINDS = new Set(["command", "context", "event", "result", "interaction", "evidence"]);
const RETENTION_MS = Object.freeze({
  work_default: 30 * 24 * 60 * 60 * 1_000,
  sensitive_short: 7 * 24 * 60 * 60 * 1_000
});
const MIME_EXTENSIONS = Object.freeze({
  "application/json": "json",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt"
});
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const COPY_CHUNK_BYTES = 64 * 1024;

function fail(code, message) {
  throw fileExchangeError(code, message);
}

function text(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSingleComponent(value) {
  if (!SOURCE_NAME.test(value) || value === "." || value === ".." || WINDOWS_RESERVED.test(value) ||
      value.includes("/") || value.includes("\\") || value.includes("\0")) {
    fail("FILE_NAME_REJECTED", "Upload file name is not a safe single component.");
  }
  return value;
}

function formatUtcTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/[-:.]/gu, "");
}

function diagnosticActorDigest(key, actorIdentity) {
  if ((!Buffer.isBuffer(key) && typeof key !== "string") || !text(actorIdentity, 4096)) {
    fail("DOCUMENT_ACTOR_INVALID", "Document actor identity is invalid.");
  }
  return createHmac("sha256", key).update(actorIdentity, "utf8").digest("hex").slice(0, 12);
}

export function createDocumentFilename({
  nowMs,
  messageId,
  actorClass,
  actorIdentity,
  kind,
  version,
  mimeType,
  installationKey
}) {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !MESSAGE_REF.test(messageId) ||
      !ACTOR_CLASSES.has(actorClass) || !KINDS.has(kind) ||
      !Number.isSafeInteger(version) || version < 1 || version > 2147483647 || !extension) {
    fail("DOCUMENT_FILENAME_INVALID", "Document filename inputs are invalid.");
  }
  const actorDigest12 = diagnosticActorDigest(installationKey, actorIdentity);
  const paddedVersion = String(version).padStart(3, "0");
  const filename = `${formatUtcTimestamp(nowMs)}_${messageId}_${actorClass}_${actorDigest12}_${kind}_v${paddedVersion}.${extension}`;
  if (filename.length > 240 || !SOURCE_NAME.test(filename) || WINDOWS_RESERVED.test(filename)) {
    fail("DOCUMENT_FILENAME_INVALID", "Generated document filename exceeds the portable budget.");
  }
  return Object.freeze({ filename, actorDigest12 });
}

async function withWorkLane(workId, operation) {
  const previous = WORK_LANES.get(workId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  WORK_LANES.set(workId, gate);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (WORK_LANES.get(workId) === gate) WORK_LANES.delete(workId);
  }
}

async function requireDirectory(directoryPath, { create = false } = {}) {
  if (create) await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  let status;
  try {
    status = await lstat(directoryPath, { bigint: true });
  } catch {
    fail("FILE_EXCHANGE_ROOT_INVALID", "Managed file exchange directory is unavailable.");
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail("FILE_EXCHANGE_ROOT_INVALID", "Managed file exchange directory is not a trusted directory.");
  }
  if (process.platform !== "win32" && (status.mode & 0o077n) !== 0n) {
    fail("FILE_EXCHANGE_ROOT_INVALID", "Managed file exchange directory permissions are too broad.");
  }
  const resolved = await realpath(directoryPath);
  if (resolved !== path.resolve(directoryPath)) {
    fail("FILE_EXCHANGE_ROOT_INVALID", "Managed file exchange directory resolves through an alias.");
  }
  return status;
}

function assertPathBudget(capability, ...paths) {
  for (const candidate of paths) {
    const units = capability.pathUnits === "utf8_bytes"
      ? Buffer.byteLength(candidate, "utf8")
      : candidate.length;
    if (units > capability.maxEffectivePathUnits) {
      fail("FILE_PATH_BUDGET_EXCEEDED", "Managed file exchange path exceeds the transport budget.");
    }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function checkDeadline(deadline, signal) {
  if (signal?.aborted) fail("DOCUMENT_IMPORT_CANCELLED", "Document import was cancelled.");
  if (performance.now() > deadline) fail("DOCUMENT_IMPORT_TIMEOUT", "Document import exceeded its deadline.");
}

async function writeAll(handle, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const result = await handle.write(buffer, offset, length - offset, null);
    if (result.bytesWritten <= 0) fail("DOCUMENT_WRITE_FAILED", "Document staging write made no progress.");
    offset += result.bytesWritten;
  }
}

async function inspectRegularFile(filePath) {
  let pathStatus;
  try {
    pathStatus = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail("UPLOAD_FILE_MISSING", "Sealed upload file is missing.");
    fail("FILE_TYPE_REJECTED", "Sealed upload object cannot be inspected.");
  }
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile() || pathStatus.nlink !== 1n) {
    fail("FILE_TYPE_REJECTED", "Sealed upload object is not an isolated regular file.");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const openedStatus = await handle.stat({ bigint: true });
    if (!openedStatus.isFile() || openedStatus.nlink !== 1n || !sameIdentity(pathStatus, openedStatus)) {
      await handle.close();
      fail("FILE_TYPE_REJECTED", "Sealed upload object changed while opening.");
    }
    return { handle, openedStatus };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (isFileExchangeError(error)) throw error;
    fail("FILE_TYPE_REJECTED", "Sealed upload object cannot be opened safely.");
  }
}

async function hashRegularFile(filePath, maximumBytes) {
  const { handle, openedStatus } = await inspectRegularFile(filePath);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > maximumBytes) fail("DOCUMENT_SIZE_MISMATCH", "Document exceeds its declared size.");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const finalStatus = await handle.stat({ bigint: true });
    if (!sameIdentity(openedStatus, finalStatus)) fail("FILE_CHANGED_DURING_IMPORT", "Document changed while hashing.");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function copySealedFile({ source, partPath, maximumBytes, deadlineMs, signal, mimeType }) {
  if (!source?.handle || !source.openedStatus) fail("SEALED_UPLOAD_ATTESTATION_INVALID", "Sealed upload file handle is invalid.");
  let target;
  const hash = createHash("sha256");
  const decoder = mimeType === "application/json" || mimeType.startsWith("text/")
    ? new TextDecoder("utf-8", { fatal: true })
    : null;
  const jsonChunks = mimeType === "application/json" ? [] : null;
  let bytes = 0;
  const deadline = performance.now() + deadlineMs;
  try {
    target = await open(
      partPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    while (true) {
      checkDeadline(deadline, signal);
      const result = await source.handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > maximumBytes) fail("UPLOAD_LIMIT_EXCEEDED", "Sealed upload exceeds the import byte limit.");
      if (decoder) {
        try { decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }); }
        catch { fail("DOCUMENT_MIME_MISMATCH", "Document is not valid UTF-8."); }
        if (jsonChunks) jsonChunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      await writeAll(target, buffer, result.bytesRead);
    }
    if (decoder) {
      try { decoder.decode(); } catch { fail("DOCUMENT_MIME_MISMATCH", "Document is not valid UTF-8."); }
    }
    if (jsonChunks) {
      try { JSON.parse(Buffer.concat(jsonChunks).toString("utf8")); }
      catch { fail("DOCUMENT_MIME_MISMATCH", "Document is not valid JSON."); }
    }
    await target.sync();
    const targetStatus = await target.stat({ bigint: true });
    const finalSourceStatus = await source.handle.stat({ bigint: true });
    if (!sameIdentity(source.openedStatus, finalSourceStatus)) {
      fail("FILE_CHANGED_DURING_IMPORT", "Sealed upload changed during import.");
    }
    if (!targetStatus.isFile() || targetStatus.nlink !== 1n || targetStatus.size !== BigInt(bytes)) {
      fail("DOCUMENT_WRITE_FAILED", "Staged document failed verification.");
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await source.handle.close().catch(() => undefined);
    if (target) await target.close().catch(() => undefined);
  }
}

async function quarantinePart(partPath, quarantineDirectory, documentId) {
  const quarantinePath = path.join(
    quarantineDirectory,
    `${documentId}.${randomBytes(8).toString("hex")}.part`
  );
  try {
    await link(partPath, quarantinePath);
    await unlink(partPath);
  } catch {
    await unlink(partPath).catch(() => undefined);
  }
}

function validateMimeBuffer(mimeType, content) {
  if (mimeType === "application/json" || mimeType.startsWith("text/")) {
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { fail("DOCUMENT_MIME_MISMATCH", "Document is not valid UTF-8."); }
    if (mimeType === "application/json") {
      try { JSON.parse(decoded); } catch { fail("DOCUMENT_MIME_MISMATCH", "Document is not valid JSON."); }
    }
  }
}

async function publishBuffer({ content, partPath, finalPath, mimeType, expectedBytes, expectedSha256 }) {
  if (!Buffer.isBuffer(content) || content.byteLength !== expectedBytes) fail("DOCUMENT_HASH_MISMATCH", "Document byte count does not match.");
  validateMimeBuffer(mimeType, content);
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expectedSha256) fail("DOCUMENT_HASH_MISMATCH", "Document hash does not match.");
  const target = await open(partPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await writeAll(target, content, content.length);
    await target.sync();
  } finally {
    await target.close().catch(() => undefined);
  }
  try {
    await link(partPath, finalPath);
    await unlink(partPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await hashRegularFile(finalPath, expectedBytes);
    if (existing.bytes !== expectedBytes || existing.sha256 !== expectedSha256) fail("DOCUMENT_CONFLICT", "Final document contains different bytes.");
    await unlink(partPath).catch(() => undefined);
  }
  const installed = await hashRegularFile(finalPath, expectedBytes);
  if (installed.bytes !== expectedBytes || installed.sha256 !== expectedSha256) fail("DOCUMENT_HASH_MISMATCH", "Published document failed final verification.");
}

export function createDocumentBroker({
  store,
  enforcement,
  ownerLock,
  exchangeRoot,
  installationKey,
  now = Date.now,
  defaultCopyDeadlineMs = 30_000,
  maximumImportBytes = 64 * 1024 * 1024
} = {}) {
  const adapter = validateFileExchangeEnforcement(enforcement);
  const capability = requireManagedFileExchangeCapability(adapter.getCapability());
  if (!store || typeof store.readFileAttemptBinding !== "function" ||
      typeof store.readDocumentManifestByIdentity !== "function" ||
      typeof store.createOutboxStagingManifest !== "function" ||
      typeof store.transitionDocumentManifest !== "function" ||
      typeof store.listDocumentManifests !== "function" ||
      !ownerLock || typeof ownerLock.assertHeld !== "function" || !path.isAbsolute(exchangeRoot) ||
      (!Buffer.isBuffer(installationKey) && typeof installationKey !== "string") ||
      typeof now !== "function" || !Number.isSafeInteger(defaultCopyDeadlineMs) || defaultCopyDeadlineMs <= 0 ||
      !Number.isSafeInteger(maximumImportBytes) || maximumImportBytes <= 0) {
    fail("DOCUMENT_BROKER_INVALID", "Document broker configuration is invalid.");
  }

  async function assertHeld(fence) {
    const held = await ownerLock.assertHeld(fence);
    if (held !== true) fail("FILE_BROKER_FENCE_LOST", "File broker owner lock is not held.");
  }

  return Object.freeze({
    async importSealedOutput(options) {
      if (!plainObject(options) || !text(options.workId) || !text(options.fileAttemptId) ||
          !text(options.ownerLockToken) || !Number.isSafeInteger(options.epoch) || options.epoch <= 0 ||
          !text(options.sourceName, 240) || !MESSAGE_REF.test(options.messageId) ||
          !Number.isSafeInteger(options.version) || options.version < 1 || options.version > 2147483647 ||
          !ACTOR_CLASSES.has(options.actorClass) || !text(options.actorIdentity, 4096) ||
          !KINDS.has(options.kind) || !Object.hasOwn(MIME_EXTENSIONS, options.mimeType) ||
          !Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0 ||
          !Number.isSafeInteger(options.copyDeadlineMs ?? defaultCopyDeadlineMs) ||
          (options.copyDeadlineMs ?? defaultCopyDeadlineMs) <= 0 ||
          !Object.hasOwn(RETENTION_MS, options.retentionClass)) {
        fail("DOCUMENT_IMPORT_INVALID", "Document import request is invalid.");
      }
      normalizeDigest(options.expectedSha256);
      validateSingleComponent(options.sourceName);
      if (options.expectedBytes > maximumImportBytes ||
          options.expectedBytes > capability.maximumBytesPerAttempt ||
          RETENTION_MS[options.retentionClass] > capability.maximumRetentionMs) {
        fail("UPLOAD_LIMIT_EXCEEDED", "Declared document exceeds the import byte limit.");
      }
      return withWorkLane(options.workId, async () => {
        const fence = {
          workId: options.workId,
          epoch: options.epoch,
          ownerLockToken: options.ownerLockToken
        };
        await assertHeld(fence);
        const currentTime = now();
        if (!Number.isSafeInteger(currentTime) || currentTime < 0) fail("STORE_CLOCK_INVALID", "Broker clock is invalid.");
        const binding = store.readFileAttemptBinding(options.fileAttemptId);
        if (!binding || binding.workId !== options.workId || binding.sealStatus !== "SEALED" ||
            binding.expiresAt <= currentTime ||
            binding.creatorFileBrokerEpoch !== options.epoch ||
            binding.limitProfileDigest !== capability.limitProfileDigest ||
            !binding.resolvedFileAttemptBindingDigest || !binding.fileAttemptSealReceiptDigest) {
          fail("FILE_ATTEMPT_NOT_SEALED", "Document import requires a matching sealed file attempt.");
        }
        const upload = await adapter.getSealedUploadDirectory({ binding });
        if (!plainObject(upload) || upload.sealed !== true ||
            upload.fileAttemptId !== binding.fileAttemptId ||
            upload.resolvedFileAttemptBindingDigest !== binding.resolvedFileAttemptBindingDigest ||
            upload.creatorFileBrokerEpoch !== binding.creatorFileBrokerEpoch) {
          fail("SEALED_UPLOAD_ATTESTATION_INVALID", "Sealed upload directory attestation is invalid.");
        }
        const attestedRootIdentity = normalizeRootIdentity(upload.rootIdentity);
        const rootStatus = await requireDirectory(exchangeRoot);
        const outboxDirectory = path.join(exchangeRoot, "outbox");
        const quarantineDirectory = path.join(exchangeRoot, "quarantine");
        const generated = createDocumentFilename({
          nowMs: currentTime,
          messageId: options.messageId,
          actorClass: options.actorClass,
          actorIdentity: options.actorIdentity,
          kind: options.kind,
          version: options.version,
          mimeType: options.mimeType,
          installationKey
        });
        const plannedFinalPath = path.join(outboxDirectory, generated.filename);
        assertPathBudget(
          capability,
          path.join(exchangeRoot, "inbox", "x".repeat(240)),
          path.join(exchangeRoot, "upload", binding.fileAttemptId, options.sourceName),
          plannedFinalPath,
          `${plannedFinalPath}.part.${"0".repeat(16)}`,
          path.join(quarantineDirectory, `${"x".repeat(240)}.${"0".repeat(16)}.part`)
        );
        const outboxStatus = await requireDirectory(outboxDirectory, { create: true });
        const quarantineStatus = await requireDirectory(quarantineDirectory, { create: true });
        if (outboxStatus.dev !== rootStatus.dev || quarantineStatus.dev !== rootStatus.dev) {
          fail("FILE_EXCHANGE_CROSS_VOLUME", "Managed exchange directories must use one local volume.");
        }
        const existingManifest = store.readDocumentManifestByIdentity({
          workId: options.workId,
          direction: "OUTBOX",
          messageId: options.messageId,
          version: options.version
        });
        if (existingManifest && (
          existingManifest.fileAttemptId !== options.fileAttemptId ||
          existingManifest.actorClass !== options.actorClass ||
          existingManifest.actorDigest12 !== generated.actorDigest12 ||
          existingManifest.kind !== options.kind || existingManifest.mimeType !== options.mimeType ||
          existingManifest.expectedBytes !== options.expectedBytes ||
          existingManifest.expectedSha256 !== options.expectedSha256 ||
          existingManifest.retentionClass !== options.retentionClass
        )) {
          fail("DOCUMENT_CONFLICT", "Document retry conflicts with the durable manifest.");
        }
        const staging = existingManifest
          ? { duplicate: true, manifest: existingManifest }
          : store.createOutboxStagingManifest({
            ...fence,
            fileAttemptId: options.fileAttemptId,
            messageId: options.messageId,
            version: options.version,
            finalFilename: generated.filename,
            actorClass: options.actorClass,
            actorDigest12: generated.actorDigest12,
            kind: options.kind,
            mimeType: options.mimeType,
            expectedBytes: options.expectedBytes,
            expectedSha256: options.expectedSha256,
            retentionClass: options.retentionClass,
            expiresAt: currentTime + RETENTION_MS[options.retentionClass],
            source: "codex_output",
            authority: "supporting_evidence",
            sensitivity: options.sensitivity ?? "internal",
            access: "result",
            provenanceReceipt: {
              receipt_version: 1,
              source: "codex_output",
              file_attempt_id: binding.fileAttemptId,
              resolved_file_attempt_binding_digest: binding.resolvedFileAttemptBindingDigest,
              policy_revision: options.policyRevision ?? 1
            },
            provenanceReceiptDigest: fileExchangeDigest({
              receipt_version: 1,
              source: "codex_output",
              file_attempt_id: binding.fileAttemptId,
              resolved_file_attempt_binding_digest: binding.resolvedFileAttemptBindingDigest,
              policy_revision: options.policyRevision ?? 1
            }),
            policyRevision: options.policyRevision ?? 1,
            keyId: options.keyId ?? "hco-provenance-v1"
          });
        if (staging.manifest.state === "AVAILABLE") return staging.manifest;
        if (staging.manifest.state !== "STAGING") {
          fail("DOCUMENT_STATE_INVALID", "Document manifest is not importable.");
        }

        const finalPath = path.join(outboxDirectory, staging.manifest.finalFilename);
        const partPath = `${finalPath}.part.${randomBytes(8).toString("hex")}`;
        assertPathBudget(capability, finalPath, partPath, quarantineDirectory);
        try {
          await assertHeld(fence);
          const source = await adapter.openSealedUploadFile({
            binding,
            sourceName: options.sourceName,
            attestation: upload
          });
          if (!plainObject(source) || !source.handle || typeof source.handle.stat !== "function" ||
              !source.openedStatus || !source.openedStatus.isFile?.() || source.openedStatus.nlink !== 1n ||
              (source.directoryIdentity !== undefined && !sameRootIdentity(source.directoryIdentity, attestedRootIdentity))) {
            await source?.handle?.close?.().catch?.(() => undefined);
            fail("SEALED_UPLOAD_ATTESTATION_INVALID", "Sealed upload file is not anchored to the attested root.");
          }
          const copied = await copySealedFile({
            source,
            partPath,
            maximumBytes: Math.min(maximumImportBytes, options.expectedBytes),
            deadlineMs: options.copyDeadlineMs ?? defaultCopyDeadlineMs,
            signal: options.signal,
            mimeType: options.mimeType
          });
          if (copied.bytes !== options.expectedBytes || copied.sha256 !== options.expectedSha256) {
            fail("DOCUMENT_HASH_MISMATCH", "Imported document does not match its sealed manifest.");
          }
          await assertHeld(fence);
          try {
            await link(partPath, finalPath);
            await unlink(partPath);
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existing = await hashRegularFile(finalPath, maximumImportBytes);
            if (existing.bytes !== options.expectedBytes || existing.sha256 !== options.expectedSha256) {
              fail("DOCUMENT_CONFLICT", "Final document filename already contains different bytes.");
            }
            await unlink(partPath).catch(() => undefined);
          }
          const installed = await hashRegularFile(finalPath, maximumImportBytes);
          if (installed.bytes !== options.expectedBytes || installed.sha256 !== options.expectedSha256) {
            fail("DOCUMENT_HASH_MISMATCH", "Published document failed final verification.");
          }
          await assertHeld(fence);
          return store.transitionDocumentManifest({
            ...fence,
            documentId: staging.manifest.documentId,
            state: "AVAILABLE"
          }).manifest;
        } catch (error) {
          await quarantinePart(partPath, quarantineDirectory, staging.manifest.documentId);
          try {
            await assertHeld(fence);
            store.transitionDocumentManifest({
              ...fence,
              documentId: staging.manifest.documentId,
              state: "QUARANTINED",
              failureCode: isFileExchangeError(error) ? error.code : "DOCUMENT_IMPORT_FAILED"
            });
          } catch {
            // A lost fence intentionally leaves STAGING for the next owner to reconcile.
          }
          if (isFileExchangeError(error)) throw error;
          fail("DOCUMENT_IMPORT_FAILED", "Document import failed.");
        }
      });
    },

    async publishInboxDocument(options) {
      if (!plainObject(options) || !text(options.workId) || !text(options.ownerLockToken) ||
          !Number.isSafeInteger(options.epoch) || options.epoch <= 0 || !Buffer.isBuffer(options.content) ||
          !MESSAGE_REF.test(options.messageId) || !Number.isSafeInteger(options.version) || options.version < 1 ||
          !ACTOR_CLASSES.has(options.actorClass) || !text(options.actorIdentity, 4096) || !KINDS.has(options.kind) ||
          !Object.hasOwn(MIME_EXTENSIONS, options.mimeType) || !Object.hasOwn(RETENTION_MS, options.retentionClass)) {
        fail("DOCUMENT_IMPORT_INVALID", "Inbox document request is invalid.");
      }
      if (options.content.byteLength > maximumImportBytes || options.content.byteLength > capability.maximumBytesPerAttempt) {
        fail("UPLOAD_LIMIT_EXCEEDED", "Inbox document exceeds the import byte limit.");
      }
      return withWorkLane(options.workId, async () => {
        const fence = { workId: options.workId, epoch: options.epoch, ownerLockToken: options.ownerLockToken };
        await assertHeld(fence);
        const rootStatus = await requireDirectory(exchangeRoot);
        const inboxDirectory = path.join(exchangeRoot, "inbox");
        const quarantineDirectory = path.join(exchangeRoot, "quarantine");
        const currentTime = now();
        if (!Number.isSafeInteger(currentTime) || currentTime < 0) fail("STORE_CLOCK_INVALID", "Broker clock is invalid.");
        const expectedSha256 = createHash("sha256").update(options.content).digest("hex");
        const generated = createDocumentFilename({
          nowMs: currentTime,
          messageId: options.messageId,
          actorClass: options.actorClass,
          actorIdentity: options.actorIdentity,
          kind: options.kind,
          version: options.version,
          mimeType: options.mimeType,
          installationKey
        });
        const finalPath = path.join(inboxDirectory, generated.filename);
        const partPath = `${finalPath}.part.${randomBytes(8).toString("hex")}`;
        assertPathBudget(
          capability,
          path.join(exchangeRoot, "inbox", "x".repeat(240)),
          finalPath,
          partPath,
          path.join(quarantineDirectory, `${"x".repeat(240)}.${"0".repeat(16)}.part`)
        );
        const inboxStatus = await requireDirectory(inboxDirectory, { create: true });
        await requireDirectory(quarantineDirectory, { create: true });
        if (inboxStatus.dev !== rootStatus.dev || inboxStatus.ino === undefined) fail("FILE_EXCHANGE_CROSS_VOLUME", "Managed exchange directories must use one local volume.");
        const provenanceReceipt = options.provenanceReceipt ?? {
          receipt_version: 1,
          source: options.source ?? "hermes_runtime",
          actor_class: options.actorClass,
          message_id: options.messageId,
          policy_revision: options.policyRevision ?? 1
        };
        const provenanceReceiptDigest = fileExchangeDigest(provenanceReceipt);
        const staging = store.createInboxStagingManifest({
          ...fence,
          messageId: options.messageId,
          version: options.version,
          finalFilename: generated.filename,
          actorClass: options.actorClass,
          actorDigest12: generated.actorDigest12,
          kind: options.kind,
          mimeType: options.mimeType,
          expectedBytes: options.content.byteLength,
          expectedSha256,
          retentionClass: options.retentionClass,
          expiresAt: currentTime + RETENTION_MS[options.retentionClass],
          source: options.source ?? "hermes_runtime",
          authority: options.authority ?? "user_goal",
          sensitivity: options.sensitivity ?? "internal",
          access: options.access ?? "read",
          provenanceReceipt,
          provenanceReceiptDigest,
          policyRevision: options.policyRevision ?? 1,
          keyId: options.keyId ?? "hco-provenance-v1"
        }).manifest;
        if (staging.state === "AVAILABLE") return staging;
        try {
          await publishBuffer({
            content: options.content,
            partPath,
            finalPath,
            mimeType: options.mimeType,
            expectedBytes: options.content.byteLength,
            expectedSha256
          });
          await assertHeld(fence);
          return store.transitionDocumentManifest({ ...fence, documentId: staging.documentId, state: "AVAILABLE" }).manifest;
        } catch (error) {
          await quarantinePart(partPath, quarantineDirectory, staging.documentId);
          try {
            await assertHeld(fence);
            store.transitionDocumentManifest({
              ...fence,
              documentId: staging.documentId,
              state: "QUARANTINED",
              failureCode: isFileExchangeError(error) ? error.code : "DOCUMENT_IMPORT_FAILED"
            });
          } catch { /* leave STAGING for a fenced recovery owner */ }
          if (isFileExchangeError(error)) throw error;
          fail("DOCUMENT_IMPORT_FAILED", "Document import failed.");
        }
      });
    },

    async recoverStagingDocuments(options) {
      if (!plainObject(options) || !text(options.workId) || !text(options.ownerLockToken) ||
          !Number.isSafeInteger(options.epoch) || options.epoch <= 0) fail("DOCUMENT_RECOVERY_INVALID", "Document recovery request is invalid.");
      return withWorkLane(options.workId, async () => {
        const fence = { workId: options.workId, epoch: options.epoch, ownerLockToken: options.ownerLockToken };
        await assertHeld(fence);
        await requireDirectory(exchangeRoot);
        const outboxDirectory = path.join(exchangeRoot, "outbox");
        const inboxDirectory = path.join(exchangeRoot, "inbox");
        const quarantineDirectory = path.join(exchangeRoot, "quarantine");
        await requireDirectory(outboxDirectory, { create: true });
        await requireDirectory(inboxDirectory, { create: true });
        await requireDirectory(quarantineDirectory, { create: true });
        const manifests = store.listDocumentManifests({ workId: options.workId });
        const known = new Set(manifests.map((manifest) => manifest.finalFilename));
        const recovered = [];
        for (const manifest of manifests.filter((entry) => entry.state === "STAGING")) {
          let adopted;
          try {
            if (manifest.direction === "OUTBOX") {
              const binding = store.readFileAttemptBinding(manifest.fileAttemptId);
              const sealCommand = store.readFileAttemptSealCommandByAttempt(manifest.fileAttemptId);
              if (!binding || !sealCommand?.receipt) fail("DOCUMENT_RECOVERY_UNPROVEN", "Staging document has no seal evidence.");
              await adapter.verifyFileAttemptSealReceipt({ sealCommandId: sealCommand.sealCommandId, binding, receipt: sealCommand.receipt });
            }
            adopted = store.adoptStagingDocument({ ...fence, documentId: manifest.documentId }).manifest;
          } catch (error) {
            const state = error?.code === "FILE_ATTEMPT_EXPIRED" ? "UNAVAILABLE" : "QUARANTINED";
            try { store.transitionDocumentManifest({ ...fence, documentId: manifest.documentId, state, failureCode: error?.code ?? "DOCUMENT_RECOVERY_UNPROVEN" }); } catch { /* keep evidence for operator */ }
            recovered.push(store.readDocumentManifest(manifest.documentId));
            continue;
          }
          const directory = manifest.direction === "INBOX" ? path.join(exchangeRoot, "inbox") : outboxDirectory;
          const finalPath = path.join(directory, adopted.finalFilename);
          let finalState = "UNAVAILABLE";
          try {
            const installed = await hashRegularFile(finalPath, maximumImportBytes);
            finalState = installed.bytes === adopted.expectedBytes && installed.sha256 === adopted.expectedSha256 ? "AVAILABLE" : "QUARANTINED";
            if (finalState === "QUARANTINED") await quarantinePart(finalPath, quarantineDirectory, adopted.documentId);
          } catch {
            const entries = await readdir(directory).catch(() => []);
            const parts = entries.filter((entry) => entry.startsWith(`${adopted.finalFilename}.part.`));
            for (const part of parts) await quarantinePart(path.join(directory, part), quarantineDirectory, adopted.documentId);
            finalState = parts.length > 0 ? "QUARANTINED" : "UNAVAILABLE";
          }
          try { recovered.push(store.transitionDocumentManifest({ ...fence, documentId: adopted.documentId, state: finalState, failureCode: finalState === "AVAILABLE" ? null : "DOCUMENT_RECOVERY_INCOMPLETE" }).manifest); }
          catch { recovered.push(store.readDocumentManifest(adopted.documentId)); }
        }
        const entries = await readdir(outboxDirectory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isFile() && !known.has(entry.name)) await quarantinePart(path.join(outboxDirectory, entry.name), quarantineDirectory, options.workId);
        }
        return Object.freeze(recovered);
      });
    },

    async cleanupExpiredDocuments({ workId } = {}) {
      if (!text(workId)) fail("DOCUMENT_RETENTION_INVALID", "Document retention work ID is invalid.");
      return withWorkLane(workId, async () => {
        const manifests = store.listDocumentManifests({ workId });
        const currentTime = now();
        const cleaned = [];
        for (const manifest of manifests) {
          if (manifest.state === "STAGING" || manifest.expiresAt > currentTime ||
              manifest.deletedAt !== null || store.hasActiveDocumentAccess(manifest.documentId)) continue;
          const directory = manifest.direction === "INBOX" ? path.join(exchangeRoot, "inbox") : path.join(exchangeRoot, "outbox");
          await unlink(path.join(directory, manifest.finalFilename)).catch(() => undefined);
          store.markDocumentDeletePending({ documentId: manifest.documentId });
          cleaned.push(store.markDocumentDeleted({ documentId: manifest.documentId, deletedAt: currentTime }).manifest);
        }
        return Object.freeze(cleaned);
      });
    }
  });
}
