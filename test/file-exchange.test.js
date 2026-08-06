import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat as lstatAsync, open as openAsync } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import {
  MANAGED_FILE_EXCHANGE_PROFILE,
  UNSUPPORTED_FILE_EXCHANGE_CAPABILITY,
  digestFileAttemptRequest,
  fileExchangeDigest,
  fileExchangeError,
  rootIdentityFromStat,
  resolvedFileAttemptBindingDigest,
  signOwnerReceipt
} from "../hco/file-exchange/contracts.js";
import { createDocumentBroker, createDocumentFilename } from "../hco/file-exchange/document-broker.js";
import { createDocumentAccessBroker } from "../hco/file-exchange/document-access.js";
import {
  confirmManagedFileAttemptSeal,
  createSealReceiptAuthority,
  createUnsupportedFileExchangeEnforcement
} from "../hco/file-exchange/enforcement.js";
import { createProcessOwnerLockManager } from "../hco/file-exchange/owner-lock.js";
import { executionFileExchangeCapability } from "../hco/execution/backend.js";
import { createAppServerBackend } from "../hco/execution/app-server-backend.js";
import { openStore } from "../hco/state/store.js";

const START_MS = 1_700_000_000_000;
const SCOPE_DIGEST = "a".repeat(64);
const LIMIT_DIGEST = "b".repeat(64);
const OWNER_RECEIPT_KEY = "test-owner-receipt-key-0123456789";
const SEAL_RECEIPT_KEY = "test-seal-receipt-key-0123456789ab";
const SUPPORTED_CAPABILITY = Object.freeze({
  profile: MANAGED_FILE_EXCHANGE_PROFILE,
  supported: true,
  physicalSeal: true,
  enforcedUploadLimits: true,
  anchoredUploadDirectories: true,
  capabilityRevision: "test-enforcement/v1",
  limitProfileDigest: LIMIT_DIGEST,
  maxDepth: 1,
  maximumFilesPerAttempt: 16,
  maximumBytesPerAttempt: 64 * 1024 * 1024,
  maximumBytesPerWork: 256 * 1024 * 1024,
  hcoReserveBytes: 1024 * 1024,
  maximumRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxEffectivePathUnits: 4096,
  pathUnits: "utf8_bytes"
});

function assertCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hco-file-exchange-")));
  const databasePath = path.join(directory, "authority.sqlite3");
  const counters = new Map();
  const idFactory = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${next}`;
  };
  let attemptCounter = 0;
  const store = openStore({
    databasePath,
    now: () => START_MS,
    idFactory,
    fileAttemptIdFactory: () => (++attemptCounter).toString(16).padStart(32, "0")
  });
  const ownerLockManager = createProcessOwnerLockManager({
    controlDirectory: path.join(directory, "broker-locks"),
    receiptKey: OWNER_RECEIPT_KEY,
    processInstanceId: "test-process-instance"
  });
  t.after(async () => {
    await ownerLockManager.close();
    store.close();
  });
  return { directory, databasePath, store, ownerLockManager };
}

async function seedOpenBinding(store, {
  objectiveId = "objective-files",
  sourceId = "source-files",
  threadId = "thread-files",
  turnId = "turn-files",
  ownerLockManager
} = {}) {
  store.registerExecutionIntent({
    sourceType: "test",
    sourceId,
    objectiveId,
    projectId: "project-files",
    backend: "app-server",
    text: "produce a managed document",
    targetSnapshot: { streamId: 42, topic: "Files" },
    topicBinding: { streamId: 42, topic: "Files", actorUserId: 7 }
  });
  store.bindBackendObjective({ objectiveId, backend: "app-server", threadId });
  const processOwnerLock = await ownerLockManager.acquire(objectiveId);
  const owner = store.acquireFileBrokerOwnership({
    workId: objectiveId,
    expectedEpoch: 0,
    ownerLockToken: processOwnerLock.ownerLockToken,
    ownerReceipt: processOwnerLock.receipt
  }).owner;
  const prepared = store.prepareTurnSubmission({
    sourceType: "test",
    sourceId,
    objectiveId,
    text: "produce a managed document",
    targetSnapshot: { streamId: 42, topic: "Files" },
    leaseOwner: "test-controller"
  });
  const binding = store.createFileAttemptBinding({
    workId: objectiveId,
    commandId: prepared.submission.submissionId,
    expectedThreadId: threadId,
    scopeDigest: SCOPE_DIGEST,
    limitProfileDigest: LIMIT_DIGEST,
    expiresAt: START_MS + 60_000,
    epoch: owner.epoch,
    ownerLockToken: processOwnerLock.ownerLockToken
  }).binding;
  store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId });
  store.resolveFileAttemptBinding({
    fileAttemptId: binding.fileAttemptId,
    threadId,
    turnId,
    epoch: owner.epoch,
    ownerLockToken: processOwnerLock.ownerLockToken
  });
  return {
    binding: store.readFileAttemptBinding(binding.fileAttemptId),
    owner,
    ownerLockToken: processOwnerLock.ownerLockToken,
    ownerLock: processOwnerLock,
    objectiveId,
    threadId,
    turnId
  };
}

async function sealBinding(store, seeded) {
  const seal = store.prepareFileAttemptSeal({
    fileAttemptId: seeded.binding.fileAttemptId,
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken
  }).command;
  const authority = createSealReceiptAuthority({ key: SEAL_RECEIPT_KEY, keyId: "test-seal-v1" });
  return (await confirmManagedFileAttemptSeal({
    store,
    enforcement: {
      getCapability: () => SUPPORTED_CAPABILITY,
      prepareFileAttempt: async () => undefined,
      sealFileAttempt: async () => undefined,
      revokeFileAttempt: async () => undefined,
      verifyFileAttemptSealReceipt: async ({ sealCommandId, receipt }) => authority.verify(receipt, { sealCommandId }),
      getSealedUploadDirectory: async () => { throw new Error("not used"); },
      openSealedUploadFile: async () => { throw new Error("not used"); }
    },
    sealCommandId: seal.sealCommandId,
    fileAttemptId: seeded.binding.fileAttemptId,
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken,
    receipt: authority.sign({
      receipt_version: 1,
      seal_command_id: seal.sealCommandId,
      resolved_file_attempt_binding_digest: seeded.binding.resolvedFileAttemptBindingDigest,
      isolation_instance_id: "test-isolation-1",
      enforcement_adapter_revision: "test-enforcement/v1",
      creator_file_broker_epoch: seeded.owner.epoch,
      sealed_at: START_MS + 1,
      files: []
    })
  })).binding;
}

function fakeEnforcement(uploadDirectory, hooks = {}) {
  return Object.freeze({
    getCapability: () => SUPPORTED_CAPABILITY,
    prepareFileAttempt: async () => undefined,
    sealFileAttempt: async () => undefined,
    revokeFileAttempt: async () => undefined,
    verifyFileAttemptSealReceipt: async ({ receipt, sealCommandId }) => {
      const authority = createSealReceiptAuthority({ key: SEAL_RECEIPT_KEY, keyId: "test-seal-v1" });
      return authority.verify(receipt, { sealCommandId });
    },
    async getSealedUploadDirectory({ binding }) {
      await hooks.beforeDirectory?.(binding);
      const status = await lstatAsync(uploadDirectory, { bigint: true });
      return {
        sealed: true,
        directoryPath: uploadDirectory,
        fileAttemptId: binding.fileAttemptId,
        resolvedFileAttemptBindingDigest: binding.resolvedFileAttemptBindingDigest,
        creatorFileBrokerEpoch: binding.creatorFileBrokerEpoch,
        rootIdentity: rootIdentityFromStat(status)
      };
    },
    async openSealedUploadFile({ sourceName }) {
      try {
        const filePath = path.join(uploadDirectory, sourceName);
        const pathStatus = await lstatAsync(filePath, { bigint: true });
        const handle = await openAsync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
        const openedStatus = await handle.stat({ bigint: true });
        if (!pathStatus.isFile() || pathStatus.isSymbolicLink() || pathStatus.nlink !== 1n ||
            !openedStatus.isFile() || openedStatus.nlink !== 1n || pathStatus.dev !== openedStatus.dev || pathStatus.ino !== openedStatus.ino) {
          await handle.close();
          throw fileExchangeError("FILE_TYPE_REJECTED", "test upload is not a regular isolated file");
        }
        const directoryStatus = await lstatAsync(uploadDirectory, { bigint: true });
        return {
          handle,
          openedStatus,
          directoryIdentity: rootIdentityFromStat(directoryStatus)
        };
      } catch (error) {
        if (error?.code === "FILE_TYPE_REJECTED") throw error;
        throw fileExchangeError("FILE_TYPE_REJECTED", "test upload is not a regular isolated file");
      }
    }
  });
}

function createBroker({ store, directory, uploadDirectory, hooks, ownerLock, exchangeRoot, now = () => START_MS }) {
  return createDocumentBroker({
    store,
    enforcement: fakeEnforcement(uploadDirectory, hooks),
    ownerLock: ownerLock ?? { assertHeld: async () => true },
    exchangeRoot: exchangeRoot ?? realpathSync(mkdtempSync(path.join(directory, "exchange-"))),
    installationKey: "test-installation-key",
    now,
    defaultCopyDeadlineMs: 2_000,
    maximumImportBytes: 1024 * 1024
  });
}

function importOptions(seeded, sourceName, content, overrides = {}) {
  const buffer = Buffer.from(content);
  return {
    workId: seeded.objectiveId,
    fileAttemptId: seeded.binding.fileAttemptId,
    ownerLockToken: seeded.ownerLockToken,
    epoch: seeded.owner.epoch,
    sourceName,
    messageId: "msg_result_1",
    version: 1,
    actorClass: "codex",
    actorIdentity: "codex:test",
    kind: "result",
    mimeType: "text/plain",
    expectedBytes: buffer.byteLength,
    expectedSha256: createHash("sha256").update(buffer).digest("hex"),
    retentionClass: "work_default",
    ...overrides
  };
}

function manifestProvenance(seeded) {
  const provenanceReceipt = {
    receipt_version: 1,
    source: "codex_output",
    file_attempt_id: seeded.binding.fileAttemptId,
    resolved_file_attempt_binding_digest: seeded.binding.resolvedFileAttemptBindingDigest,
    policy_revision: 1
  };
  return {
    source: "codex_output",
    authority: "supporting_evidence",
    sensitivity: "internal",
    access: "result",
    provenanceReceipt,
    provenanceReceiptDigest: fileExchangeDigest(provenanceReceipt),
    policyRevision: 1,
    keyId: "hco-provenance-v1"
  };
}

test("FileAttemptBinding request and resolved digests match shared golden vectors", () => {
  const request = digestFileAttemptRequest({
    binding_version: 1,
    file_attempt_id: "0123456789abcdef0123456789abcdef",
    work_id: "work-1",
    command_id: "command-1",
    expected_thread_id: "thread-1",
    scope_digest: "a".repeat(64),
    creator_file_broker_epoch: 7,
    upload_relpath: "upload/0123456789abcdef0123456789abcdef",
    limit_profile_digest: "b".repeat(64),
    expires_at: START_MS
  });
  assert.equal(
    request.canonicalJson,
    "{\"binding_version\":1,\"command_id\":\"command-1\",\"creator_file_broker_epoch\":7," +
    "\"expected_thread_id\":\"thread-1\",\"expires_at\":1700000000000," +
    "\"file_attempt_id\":\"0123456789abcdef0123456789abcdef\"," +
    "\"limit_profile_digest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"," +
    "\"scope_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"," +
    "\"upload_relpath\":\"upload/0123456789abcdef0123456789abcdef\",\"work_id\":\"work-1\"}"
  );
  assert.equal(request.digest, "1a7e9a10287cee8e2263b90381e5d98553312b8006cbb0cacc93239cfe42abdc");
  assert.equal(resolvedFileAttemptBindingDigest({
    fileAttemptRequestDigest: request.digest,
    threadId: "thread-1",
    turnId: "turn-1"
  }).digest, "b456ce44b708f0ff7ae0dcbbfc81f8c30057a3bb5754c9ee1edaa25e3698fcac");
});

test("owner lock remains exclusive across managers and safely reclaims only its stale socket", async (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hco-file-lock-")));
  const controlDirectory = path.join(directory, "locks");
  const first = createProcessOwnerLockManager({
    controlDirectory,
    receiptKey: OWNER_RECEIPT_KEY,
    processInstanceId: "lock-process-1"
  });
  const second = createProcessOwnerLockManager({
    controlDirectory,
    receiptKey: OWNER_RECEIPT_KEY,
    processInstanceId: "lock-process-2"
  });
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const held = await first.acquire("lock-work");
  await assert.rejects(
    second.acquire("lock-work"),
    (error) => assertCode(error, "FILE_BROKER_LOCK_BUSY")
  );
  await held.release();
  const reacquired = await second.acquire("lock-work");
  assert.notEqual(reacquired.ownerLockToken, held.ownerLockToken);
  assert.equal(await reacquired.assertHeld({ workId: "lock-work", ownerLockToken: reacquired.ownerLockToken }), true);
});

test("one command gets one durable FileAttemptBinding and cannot change it on retry", async (t) => {
  const { store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  const duplicate = store.createFileAttemptBinding({
    workId: seeded.objectiveId,
    commandId: seeded.binding.commandId,
    expectedThreadId: seeded.threadId,
    scopeDigest: SCOPE_DIGEST,
    limitProfileDigest: LIMIT_DIGEST,
    expiresAt: START_MS + 60_000,
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.binding.fileAttemptId, seeded.binding.fileAttemptId);
  assert.throws(() => store.createFileAttemptBinding({
    workId: seeded.objectiveId,
    commandId: seeded.binding.commandId,
    expectedThreadId: seeded.threadId,
    scopeDigest: "d".repeat(64),
    limitProfileDigest: LIMIT_DIGEST,
    expiresAt: START_MS + 60_000,
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken
  }), (error) => assertCode(error, "FILE_ATTEMPT_MISMATCH"));
});

test("OUTBOX staging requires a confirmed physical seal and stale epochs cannot publish", async (t) => {
  const { store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  const manifestOptions = {
    workId: seeded.objectiveId,
    fileAttemptId: seeded.binding.fileAttemptId,
    messageId: "msg_result_1",
    version: 1,
    finalFilename: "20260804T143012087Z_msg_result_1_codex_a1b2c3d4e5f6_result_v001.txt",
    actorClass: "codex",
    actorDigest12: "a1b2c3d4e5f6",
    kind: "result",
    mimeType: "text/plain",
    expectedBytes: 3,
    expectedSha256: createHash("sha256").update("ok\n").digest("hex"),
    retentionClass: "work_default",
    ...manifestProvenance(seeded),
    expiresAt: START_MS + 60_000,
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken
  };
  assert.throws(
    () => store.createOutboxStagingManifest(manifestOptions),
    (error) => assertCode(error, "FILE_ATTEMPT_NOT_SEALED")
  );
  await sealBinding(store, seeded);
  const staging = store.createOutboxStagingManifest(manifestOptions).manifest;
  const nextOwner = store.acquireFileBrokerOwnership({
    workId: seeded.objectiveId,
    expectedEpoch: seeded.owner.epoch,
    ownerLockToken: "owner-lock-2",
    ownerReceipt: signOwnerReceipt({
      work_id: seeded.objectiveId,
      lock_identity: "test-lock-2",
      owner_lock_token_digest: createHash("sha256").update("owner-lock-2", "utf8").digest("hex"),
      process_instance_id: "test-process-2",
      acquired_at: START_MS + 2
    }, { key: OWNER_RECEIPT_KEY, keyId: "hco-owner-lock-v1" })
  }).owner;
  assert.equal(nextOwner.epoch, seeded.owner.epoch + 1);
  assert.throws(() => store.transitionDocumentManifest({
    documentId: staging.documentId,
    state: "AVAILABLE",
    epoch: seeded.owner.epoch,
    ownerLockToken: seeded.ownerLockToken
  }), (error) => assertCode(error, "FILE_BROKER_FENCE_LOST"));
});

test("document broker imports a sealed regular file and publishes only verified bytes", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  await sealBinding(store, seeded);
  seeded.binding = store.readFileAttemptBinding(seeded.binding.fileAttemptId);
  const uploadDirectory = path.join(directory, "upload", seeded.binding.fileAttemptId);
  mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  const content = "verified result\n";
  writeFileSync(path.join(uploadDirectory, "result.txt"), content);
  const broker = createBroker({ store, directory, uploadDirectory, ownerLock: seeded.ownerLock });
  const manifest = await broker.importSealedOutput(importOptions(seeded, "result.txt", content));
  assert.equal(manifest.state, "AVAILABLE");
  assert.equal(manifest.expectedSha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(store.readDocumentManifest(manifest.documentId).state, "AVAILABLE");
});

test("document broker publishes an inbox document through a manifest before it is readable", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  const broker = createBroker({ store, directory, ownerLock: seeded.ownerLock, uploadDirectory: directory });
  const content = Buffer.from("context from Hermes\n", "utf8");
  const manifest = await broker.publishInboxDocument({
    workId: seeded.objectiveId,
    ownerLockToken: seeded.ownerLockToken,
    epoch: seeded.owner.epoch,
    messageId: "msg_context_1",
    version: 1,
    actorClass: "hermes",
    actorIdentity: "hermes:test",
    kind: "context",
    mimeType: "text/plain",
    retentionClass: "work_default",
    content
  });
  assert.equal(manifest.direction, "INBOX");
  assert.equal(manifest.state, "AVAILABLE");
  assert.equal(manifest.expectedBytes, content.byteLength);
  assert.equal(store.readDocumentManifest(manifest.documentId).state, "AVAILABLE");
});

test("document access refs are ACL-bound and single-use", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  const exchangeRoot = realpathSync(mkdtempSync(path.join(directory, "access-exchange-")));
  const broker = createBroker({ store, directory, ownerLock: seeded.ownerLock, exchangeRoot, uploadDirectory: directory });
  const content = Buffer.from("document access\n", "utf8");
  const manifest = await broker.publishInboxDocument({
    workId: seeded.objectiveId,
    ownerLockToken: seeded.ownerLockToken,
    epoch: seeded.owner.epoch,
    messageId: "msg_access_1",
    version: 1,
    actorClass: "hermes",
    actorIdentity: "hermes:test",
    kind: "context",
    mimeType: "text/plain",
    retentionClass: "work_default",
    content
  });
  const grantDigest = "d".repeat(64);
  const access = createDocumentAccessBroker({
    store,
    accessKey: "test-document-access-key-0123456789",
    authorize: async () => ({ allowed: true, grantDigest }),
    exchangeRootForWork: async () => exchangeRoot,
    now: () => START_MS
  });
  const issued = await access.issue({
    documentId: manifest.documentId,
    documentVersion: manifest.version,
    documentSha256: manifest.expectedSha256,
    operation: "READ_TASK_CONTRACT",
    invocationRef: "invocation-1",
    issuanceKey: "issuance-1"
  });
  const read = await access.read({ accessRef: issued.accessRef, invocationRef: "invocation-1" });
  assert.deepEqual(read.content, content);
  await assert.rejects(
    access.read({ accessRef: issued.accessRef, invocationRef: "invocation-1" }),
    (error) => assertCode(error, "DOCUMENT_ACCESS_REPLAY")
  );
});

test("document retry reuses the first durable filename instead of regenerating time-based identity", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  await sealBinding(store, seeded);
  seeded.binding = store.readFileAttemptBinding(seeded.binding.fileAttemptId);
  const uploadDirectory = path.join(directory, "upload", seeded.binding.fileAttemptId);
  mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  const content = "retry result\n";
  writeFileSync(path.join(uploadDirectory, "retry.txt"), content);
  const expected = importOptions(seeded, "retry.txt", content, { messageId: "msg_retry" });
  const generated = createDocumentFilename({
    nowMs: START_MS,
    messageId: expected.messageId,
    actorClass: expected.actorClass,
    actorIdentity: expected.actorIdentity,
    kind: expected.kind,
    version: expected.version,
    mimeType: expected.mimeType,
    installationKey: "test-installation-key"
  });
  const first = store.createOutboxStagingManifest({
    workId: seeded.objectiveId,
    fileAttemptId: seeded.binding.fileAttemptId,
    ownerLockToken: seeded.ownerLockToken,
    epoch: seeded.owner.epoch,
    messageId: expected.messageId,
    version: expected.version,
    finalFilename: generated.filename,
    actorClass: expected.actorClass,
    actorDigest12: generated.actorDigest12,
    kind: expected.kind,
    mimeType: expected.mimeType,
    expectedBytes: expected.expectedBytes,
    expectedSha256: expected.expectedSha256,
    retentionClass: expected.retentionClass,
    ...manifestProvenance(seeded),
    expiresAt: START_MS + 30 * 24 * 60 * 60 * 1_000
  }).manifest;
  const broker = createBroker({
    store,
    directory,
    uploadDirectory,
    ownerLock: seeded.ownerLock,
    now: () => START_MS + 5_000
  });
  const result = await broker.importSealedOutput(expected);
  assert.equal(result.documentId, first.documentId);
  assert.equal(result.finalFilename, first.finalFilename);
  assert.equal(result.state, "AVAILABLE");
});

test("document broker rejects symlink, directory, FIFO, socket, and hard-link uploads without blocking", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  await sealBinding(store, seeded);
  seeded.binding = store.readFileAttemptBinding(seeded.binding.fileAttemptId);
  const uploadDirectory = realpathSync(mkdtempSync(path.join("/tmp", "hcofx-upload-")));
  writeFileSync(path.join(uploadDirectory, "target.txt"), "target");
  symlinkSync("target.txt", path.join(uploadDirectory, "link.txt"));
  mkdirSync(path.join(uploadDirectory, "folder"));
  execFileSync("mkfifo", [path.join(uploadDirectory, "pipe")]);
  linkSync(path.join(uploadDirectory, "target.txt"), path.join(uploadDirectory, "hard.txt"));
  const socketPath = path.join(uploadDirectory, "socket");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const broker = createBroker({ store, directory, uploadDirectory, ownerLock: seeded.ownerLock });
  const cases = ["link.txt", "folder", "pipe", "hard.txt", "socket"];
  for (const [index, sourceName] of cases.entries()) {
    await assert.rejects(
      broker.importSealedOutput(importOptions(seeded, sourceName, "target", {
        messageId: `msg_rejected_${index + 1}`
      })),
      (error) => assertCode(error, "FILE_TYPE_REJECTED")
    );
  }
});

test("document broker stops an over-limit copy and serializes concurrent workers per work", async (t) => {
  const { directory, store, ownerLockManager } = fixture(t);
  const seeded = await seedOpenBinding(store, { ownerLockManager });
  await sealBinding(store, seeded);
  seeded.binding = store.readFileAttemptBinding(seeded.binding.fileAttemptId);
  const uploadDirectory = path.join(directory, "upload", seeded.binding.fileAttemptId);
  mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(uploadDirectory, "large.txt"), "too large");
  writeFileSync(path.join(uploadDirectory, "one.txt"), "one");
  writeFileSync(path.join(uploadDirectory, "two.txt"), "two");
  let active = 0;
  let maximumActive = 0;
  const broker = createBroker({
    store,
    directory,
    uploadDirectory,
    ownerLock: seeded.ownerLock,
    hooks: {
      async beforeDirectory() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      }
    }
  });
  await assert.rejects(
    broker.importSealedOutput(importOptions(seeded, "large.txt", "tiny", { messageId: "msg_too_large" })),
    (error) => assertCode(error, "UPLOAD_LIMIT_EXCEEDED")
  );
  const [one, two] = await Promise.all([
    broker.importSealedOutput(importOptions(seeded, "one.txt", "one", { messageId: "msg_one" })),
    broker.importSealedOutput(importOptions(seeded, "two.txt", "two", { messageId: "msg_two" }))
  ]);
  assert.equal(one.state, "AVAILABLE");
  assert.equal(two.state, "AVAILABLE");
  assert.equal(maximumActive, 1);
});

test("current App Server exposes managed exchange as unsupported and enforcement fails closed", async () => {
  const client = {
    startThread: async () => ({ thread: { id: "thread-1" } }),
    startTurn: async () => ({ turn: { id: "turn-1" } }),
    interruptTurn: async () => ({ ok: true }),
    readThread: async () => ({ thread: { id: "thread-1", turns: [] } }),
    respond: async () => undefined,
    respondError: async () => undefined
  };
  const backend = createAppServerBackend({ client });
  assert.deepEqual(executionFileExchangeCapability(backend), UNSUPPORTED_FILE_EXCHANGE_CAPABILITY);
  const unsupported = createUnsupportedFileExchangeEnforcement();
  await assert.rejects(
    Promise.resolve().then(() => unsupported.getSealedUploadDirectory()),
    (error) => assertCode(error, "FILE_EXCHANGE_UNSUPPORTED")
  );
});
