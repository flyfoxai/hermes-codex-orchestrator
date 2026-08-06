import { createHash, randomBytes } from "node:crypto";

import {
  canonicalizeFileExchangeJson,
  digestFileAttemptRequest,
  digestOwnerReceipt,
  digestSealReceipt,
  fileExchangeDigest,
  fileExchangeError,
  normalizeDigest,
  normalizeOwnerReceipt,
  resolvedFileAttemptBindingDigest
} from "./contracts.js";

const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const HASH12 = /^[a-f0-9]{12}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const MESSAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u;
const ACTOR_CLASSES = new Set(["hermes", "hco", "codex", "agent"]);
const DOCUMENT_KINDS = new Set(["command", "context", "event", "result", "interaction", "evidence"]);
const RETENTION_CLASSES = new Set(["work_default", "sensitive_short"]);
const DOCUMENT_SOURCES = new Set(["hermes_runtime", "hermes_agent", "project_file", "hco_contract", "codex_output"]);
const DOCUMENT_AUTHORITIES = new Set(["system_contract", "user_goal", "supporting_evidence"]);
const DOCUMENT_SENSITIVITIES = new Set(["internal", "sensitive"]);
const DOCUMENT_ACCESS = new Set(["read", "result"]);
const DOCUMENT_OPERATIONS = new Set(["READ_RESULT", "READ_EVIDENCE", "READ_TASK_CONTRACT"]);
const MIME_EXTENSIONS = Object.freeze({
  "application/json": "json",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt"
});

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

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail("STORE_CLOCK_INVALID", "Store clock is invalid.");
  return value;
}

function identifier(idFactory, kind) {
  const value = idFactory(kind);
  if (!text(value)) fail("STORE_ID_INVALID", "Store ID factory returned an invalid ID.");
  return value;
}

function mapOwner(row) {
  if (!row) return null;
  return Object.freeze({
    workId: row.work_id,
    epoch: row.file_broker_epoch,
    ownerLockToken: row.owner_lock_token,
    ownerReceiptDigest: row.owner_receipt_digest,
    state: row.state,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapBinding(row) {
  if (!row) return null;
  return Object.freeze({
    fileAttemptId: row.file_attempt_id,
    workId: row.work_id,
    commandId: row.command_id,
    bindingVersion: row.binding_version,
    expectedThreadId: row.expected_thread_id,
    scopeDigest: row.scope_digest,
    creatorFileBrokerEpoch: row.creator_file_broker_epoch,
    uploadRelpath: row.upload_relpath,
    limitProfileDigest: row.limit_profile_digest,
    expiresAt: row.expires_at_ms,
    request: Object.freeze(JSON.parse(row.request_json)),
    fileAttemptRequestDigest: row.file_attempt_request_digest,
    boundThreadId: row.bound_thread_id,
    boundTurnId: row.bound_turn_id,
    resolvedFileAttemptBindingDigest: row.resolved_file_attempt_binding_digest,
    sealStatus: row.seal_status,
    fileAttemptSealReceiptDigest: row.file_attempt_seal_receipt_digest,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapSealCommand(row) {
  if (!row) return null;
  return Object.freeze({
    sealCommandId: row.seal_command_id,
    fileAttemptId: row.file_attempt_id,
    idempotencyKey: row.idempotency_key,
    payload: Object.freeze(JSON.parse(row.payload_json)),
    payloadDigest: row.payload_digest,
    state: row.state,
    receipt: row.receipt_json === null ? null : Object.freeze(JSON.parse(row.receipt_json)),
    receiptDigest: row.receipt_digest,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapManifest(row) {
  if (!row) return null;
  return Object.freeze({
    documentId: row.document_id,
    workId: row.work_id,
    direction: row.direction,
    messageId: row.message_id,
    version: row.version,
    finalFilename: row.final_filename,
    actorClass: row.actor_class,
    actorDigest12: row.actor_digest12,
    kind: row.kind,
    mimeType: row.mime_type,
    expectedBytes: row.expected_bytes,
    expectedSha256: row.expected_sha256,
    manifest: Object.freeze(JSON.parse(row.manifest_json)),
    manifestDigest: row.manifest_digest,
    retentionClass: row.retention_class,
    expiresAt: row.expires_at_ms,
    source: row.source,
    authority: row.authority,
    sensitivity: row.sensitivity,
    access: row.access_mode,
    provenanceReceipt: Object.freeze(JSON.parse(row.provenance_receipt_json)),
    provenanceReceiptDigest: row.provenance_receipt_digest,
    policyRevision: row.policy_revision,
    keyId: row.key_id,
    deletePendingAt: row.delete_pending_at_ms,
    deletedAt: row.deleted_at_ms,
    creatorFileBrokerEpoch: row.creator_file_broker_epoch,
    currentRecoveryBrokerEpoch: row.current_recovery_broker_epoch,
    brokerOwnerReceiptDigest: row.broker_owner_receipt_digest,
    fileAttemptId: row.file_attempt_id,
    fileAttemptRequestDigest: row.file_attempt_request_digest,
    resolvedFileAttemptBindingDigest: row.resolved_file_attempt_binding_digest,
    fileAttemptSealReceiptDigest: row.file_attempt_seal_receipt_digest,
    state: row.state,
    failureCode: row.failure_code,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapAccessIssue(row) {
  if (!row) return null;
  return Object.freeze({
    accessId: row.access_id,
    documentId: row.document_id,
    documentVersion: row.document_version,
    documentSha256: row.document_sha256,
    operation: row.operation,
    consumerDigest: row.consumer_digest,
    grantDigest: row.grant_digest,
    issuanceKey: row.issuance_key,
    accessRefDigest: row.access_ref_digest,
    expiresAt: row.expires_at_ms,
    state: row.state,
    consumedAt: row.consumed_at_ms,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function assertOwner(db, { workId, epoch, ownerLockToken }, { allowReconciling = false } = {}) {
  const owner = db.prepare("SELECT * FROM file_broker_owners WHERE work_id = ?").get(workId);
  if (!owner || owner.file_broker_epoch !== epoch || owner.owner_lock_token !== ownerLockToken ||
      (owner.state !== "OWNED" && !(allowReconciling && owner.state === "RECONCILING"))) {
    fail("FILE_BROKER_FENCE_LOST", "File broker no longer owns the work.");
  }
  return owner;
}

function validateOwnerFence(options) {
  return plainObject(options) && text(options.workId) && Number.isSafeInteger(options.epoch) && options.epoch > 0 &&
    text(options.ownerLockToken);
}

function expectedFilenameSuffix(options) {
  const extension = MIME_EXTENSIONS[options.mimeType];
  if (!extension) return null;
  return `_${options.messageId}_${options.actorClass}_${options.actorDigest12}_${options.kind}_v${String(options.version).padStart(3, "0")}.${extension}`;
}

function validateProvenance(options) {
  if (!DOCUMENT_SOURCES.has(options.source) || !DOCUMENT_AUTHORITIES.has(options.authority) ||
      !DOCUMENT_SENSITIVITIES.has(options.sensitivity) || !DOCUMENT_ACCESS.has(options.access) ||
      !plainObject(options.provenanceReceipt) || !Number.isSafeInteger(options.policyRevision) ||
      options.policyRevision <= 0 || !text(options.keyId, 128)) return false;
  const digest = fileExchangeDigest(options.provenanceReceipt);
  return digest === options.provenanceReceiptDigest;
}

export function createManagedFileExchangeState(db, {
  now = Date.now,
  idFactory,
  fileAttemptIdFactory = () => randomBytes(16).toString("hex")
} = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function" ||
      typeof now !== "function" || typeof idFactory !== "function" || typeof fileAttemptIdFactory !== "function") {
    fail("FILE_EXCHANGE_STORE_INVALID", "Managed file exchange store is invalid.");
  }

  const acquireFileBrokerOwnershipTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const work = db.prepare("SELECT objective_id FROM objective_execution WHERE objective_id = ?").get(options.workId);
    if (!work) fail("OBJECTIVE_NOT_FOUND", "File exchange work does not exist.");
    const ownerReceipt = normalizeOwnerReceipt(options.ownerReceipt);
    const ownerReceiptDigest = digestOwnerReceipt(ownerReceipt).digest;
    const tokenDigest = createHash("sha256").update(options.ownerLockToken, "utf8").digest("hex");
    if (ownerReceipt.work_id !== options.workId || ownerReceipt.owner_lock_token_digest !== tokenDigest) {
      fail("FILE_BROKER_OWNER_RECEIPT_INVALID", "File broker owner receipt does not match the lock.");
    }
    const current = db.prepare("SELECT * FROM file_broker_owners WHERE work_id = ?").get(options.workId);
    if (current?.owner_lock_token === options.ownerLockToken &&
        current.owner_receipt_digest === ownerReceiptDigest && current.state !== "RELEASED") {
      return { duplicate: true, owner: mapOwner(current) };
    }
    const currentEpoch = current?.file_broker_epoch ?? 0;
    if (options.expectedEpoch !== currentEpoch) {
      fail("FILE_BROKER_EPOCH_CONFLICT", "File broker epoch conflicts with durable state.");
    }
    if (currentEpoch >= MAX_EPOCH) {
      fail("FILE_BROKER_EPOCH_EXHAUSTED", "File broker epoch is exhausted.");
    }
    const nextEpoch = currentEpoch + 1;
    const openOldAttempts = db.prepare(`
      SELECT count(*) AS count FROM file_attempt_bindings
      WHERE work_id = ? AND seal_status = 'OPEN'
    `).get(options.workId).count;
    const state = openOldAttempts > 0 ? "RECONCILING" : "OWNED";
    db.prepare(`
      INSERT INTO file_broker_owner_receipts (
        receipt_digest, work_id, file_broker_epoch, owner_lock_token_digest,
        key_id, receipt_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerReceiptDigest, options.workId, nextEpoch, tokenDigest, ownerReceipt.key_id,
      canonicalizeFileExchangeJson(ownerReceipt), currentTime
    );
    if (current) {
      db.prepare(`
        UPDATE file_broker_owners
        SET file_broker_epoch = ?, owner_lock_token = ?, owner_receipt_digest = ?, state = ?, updated_at_ms = ?
        WHERE work_id = ? AND file_broker_epoch = ?
      `).run(
        nextEpoch, options.ownerLockToken, ownerReceiptDigest, state,
        currentTime, options.workId, currentEpoch
      );
    } else {
      db.prepare(`
        INSERT INTO file_broker_owners (
          work_id, file_broker_epoch, owner_lock_token, owner_receipt_digest,
          state, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        options.workId, nextEpoch, options.ownerLockToken, ownerReceiptDigest,
        state, currentTime, currentTime
      );
    }
    return {
      duplicate: false,
      owner: mapOwner(db.prepare("SELECT * FROM file_broker_owners WHERE work_id = ?").get(options.workId))
    };
  });

  const markFileBrokerReadyTx = db.transaction((options) => {
    const owner = assertOwner(db, options, { allowReconciling: true });
    const openOldAttempts = db.prepare(`
      SELECT count(*) AS count FROM file_attempt_bindings
      WHERE work_id = ? AND creator_file_broker_epoch < ? AND seal_status = 'OPEN'
    `).get(options.workId, options.epoch).count;
    if (openOldAttempts !== 0) {
      fail("FILE_BROKER_RECONCILIATION_REQUIRED", "Old file attempt writers are not revoked.");
    }
    if (owner.state === "OWNED") return { duplicate: true, owner: mapOwner(owner) };
    if (owner.state !== "RECONCILING") fail("FILE_BROKER_FENCE_LOST", "File broker is not active.");
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE file_broker_owners SET state = 'OWNED', updated_at_ms = ?
      WHERE work_id = ? AND file_broker_epoch = ? AND owner_lock_token = ? AND state = 'RECONCILING'
    `).run(currentTime, options.workId, options.epoch, options.ownerLockToken);
    return {
      duplicate: false,
      owner: mapOwner(db.prepare("SELECT * FROM file_broker_owners WHERE work_id = ?").get(options.workId))
    };
  });

  const createFileAttemptBindingTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const owner = assertOwner(db, options);
    if (options.expiresAt <= currentTime) fail("FILE_ATTEMPT_EXPIRED", "File attempt is already expired.");
    const command = db.prepare(`
      SELECT submission_id, objective_id, submission_state FROM turn_submissions WHERE submission_id = ?
    `).get(options.commandId);
    if (!command || command.objective_id !== options.workId) {
      fail("FILE_ATTEMPT_COMMAND_INVALID", "File attempt command does not belong to the work.");
    }
    const existing = db.prepare("SELECT * FROM file_attempt_bindings WHERE command_id = ?").get(options.commandId);
    if (existing) {
      const same = existing.work_id === options.workId && existing.expected_thread_id === (options.expectedThreadId ?? null) &&
        existing.scope_digest === options.scopeDigest && existing.limit_profile_digest === options.limitProfileDigest &&
        existing.expires_at_ms === options.expiresAt && existing.creator_file_broker_epoch === options.epoch;
      if (!same) fail("FILE_ATTEMPT_MISMATCH", "Command already has a different file attempt binding.");
      return { duplicate: true, binding: mapBinding(existing) };
    }
    if (command.submission_state !== "intent") {
      fail("FILE_ATTEMPT_COMMAND_INVALID", "File attempt must be bound before command dispatch.");
    }
    const fileAttemptId = fileAttemptIdFactory();
    const request = {
      binding_version: 1,
      file_attempt_id: fileAttemptId,
      work_id: options.workId,
      command_id: options.commandId,
      ...(options.expectedThreadId ? { expected_thread_id: options.expectedThreadId } : {}),
      scope_digest: options.scopeDigest,
      creator_file_broker_epoch: options.epoch,
      upload_relpath: `upload/${fileAttemptId}`,
      limit_profile_digest: options.limitProfileDigest,
      expires_at: options.expiresAt
    };
    const digested = digestFileAttemptRequest(request);
    db.prepare(`
      INSERT INTO file_attempt_bindings (
        file_attempt_id, work_id, command_id, binding_version, expected_thread_id,
        scope_digest, creator_file_broker_epoch, upload_relpath, limit_profile_digest,
        expires_at_ms, request_json, file_attempt_request_digest, bound_thread_id,
        bound_turn_id, resolved_file_attempt_binding_digest, seal_status,
        file_attempt_seal_receipt_digest, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'OPEN', NULL, ?, ?)
    `).run(
      fileAttemptId, options.workId, options.commandId, options.expectedThreadId ?? null,
      options.scopeDigest, owner.file_broker_epoch, request.upload_relpath, options.limitProfileDigest,
      options.expiresAt, digested.canonicalJson, digested.digest, currentTime, currentTime
    );
    return {
      duplicate: false,
      binding: mapBinding(db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(fileAttemptId))
    };
  });

  const resolveFileAttemptBindingTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const binding = db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(options.fileAttemptId);
    if (!binding) fail("FILE_ATTEMPT_NOT_FOUND", "File attempt does not exist.");
    assertOwner(db, {
      workId: binding.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken
    });
    if (binding.bound_thread_id !== null) {
      if (binding.bound_thread_id !== options.threadId || binding.bound_turn_id !== options.turnId) {
        fail("FILE_ATTEMPT_MISMATCH", "File attempt is bound to another remote turn.");
      }
      return { duplicate: true, binding: mapBinding(binding) };
    }
    if (binding.seal_status !== "OPEN" || binding.creator_file_broker_epoch !== options.epoch ||
        binding.expires_at_ms <= currentTime ||
        (binding.expected_thread_id !== null && binding.expected_thread_id !== options.threadId)) {
      fail("FILE_ATTEMPT_MISMATCH", "File attempt cannot bind to this remote turn.");
    }
    const durable = db.prepare(`
      SELECT submission.turn_id, execution.app_server_thread_id
      FROM turn_submissions AS submission
      JOIN objective_execution AS execution USING (objective_id)
      WHERE submission.submission_id = ? AND submission.objective_id = ?
    `).get(binding.command_id, binding.work_id);
    if (!durable || durable.turn_id !== options.turnId || durable.app_server_thread_id !== options.threadId) {
      fail("FILE_ATTEMPT_MISMATCH", "Remote turn does not match durable command state.");
    }
    const resolved = resolvedFileAttemptBindingDigest({
      fileAttemptRequestDigest: binding.file_attempt_request_digest,
      threadId: options.threadId,
      turnId: options.turnId
    });
    const changed = db.prepare(`
      UPDATE file_attempt_bindings
      SET bound_thread_id = ?, bound_turn_id = ?, resolved_file_attempt_binding_digest = ?, updated_at_ms = ?
      WHERE file_attempt_id = ? AND bound_thread_id IS NULL AND seal_status = 'OPEN'
    `).run(options.threadId, options.turnId, resolved.digest, currentTime, options.fileAttemptId).changes;
    if (changed !== 1) fail("FILE_ATTEMPT_MISMATCH", "File attempt binding changed concurrently.");
    return {
      duplicate: false,
      binding: mapBinding(db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(options.fileAttemptId))
    };
  });

  const prepareFileAttemptSealTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const binding = db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(options.fileAttemptId);
    if (!binding) fail("FILE_ATTEMPT_NOT_FOUND", "File attempt does not exist.");
    assertOwner(db, { workId: binding.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken });
    const existing = db.prepare("SELECT * FROM file_attempt_seal_commands WHERE file_attempt_id = ?")
      .get(options.fileAttemptId);
    if (existing) return { duplicate: true, command: mapSealCommand(existing) };
    if (binding.expires_at_ms <= currentTime) fail("FILE_ATTEMPT_EXPIRED", "File attempt has expired.");
    if (binding.seal_status !== "OPEN" || binding.bound_thread_id === null ||
        binding.creator_file_broker_epoch !== options.epoch) {
      fail("FILE_ATTEMPT_NOT_SEALABLE", "File attempt is not ready to seal.");
    }
    const sealCommandId = identifier(idFactory, "file-seal-command");
    const idempotencyKey = identifier(idFactory, "file-seal-idempotency");
    const payload = Object.freeze({
      seal_command_id: sealCommandId,
      idempotency_key: idempotencyKey,
      command_id: binding.command_id,
      file_attempt_id: binding.file_attempt_id,
      thread_id: binding.bound_thread_id,
      turn_id: binding.bound_turn_id,
      expected_scope_digest: binding.scope_digest,
      expected_creator_file_broker_epoch: binding.creator_file_broker_epoch
    });
    const payloadJson = canonicalizeFileExchangeJson(payload);
    const payloadDigest = fileExchangeDigest(payload);
    db.prepare(`
      INSERT INTO file_attempt_seal_commands (
        seal_command_id, file_attempt_id, idempotency_key, payload_json, payload_digest,
        state, receipt_json, receipt_digest, last_error_code, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?)
    `).run(
      sealCommandId, binding.file_attempt_id, idempotencyKey, payloadJson,
      payloadDigest, currentTime, currentTime
    );
    return {
      duplicate: false,
      command: mapSealCommand(db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
        .get(sealCommandId))
    };
  });

  const recordFileAttemptSealStateTx = db.transaction((options) => {
    const command = db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
      .get(options.sealCommandId);
    if (!command) fail("FILE_ATTEMPT_SEAL_COMMAND_NOT_FOUND", "File attempt seal command does not exist.");
    if (command.state === options.state && command.last_error_code === (options.errorCode ?? null)) {
      return { duplicate: true, command: mapSealCommand(command) };
    }
    if (["CONFIRMED", "REJECTED"].includes(command.state) ||
        !["SENT", "UNKNOWN", "REJECTED"].includes(options.state)) {
      fail("FILE_ATTEMPT_SEAL_STATE_INVALID", "File attempt seal state transition is invalid.");
    }
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE file_attempt_seal_commands SET state = ?, last_error_code = ?, updated_at_ms = ?
      WHERE seal_command_id = ?
    `).run(options.state, options.errorCode ?? null, currentTime, options.sealCommandId);
    return {
      duplicate: false,
      command: mapSealCommand(db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
        .get(options.sealCommandId))
    };
  });

  const confirmVerifiedFileAttemptSealTx = db.transaction((options) => {
    const command = db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
      .get(options.sealCommandId);
    if (!command) fail("FILE_ATTEMPT_SEAL_COMMAND_NOT_FOUND", "File attempt seal command does not exist.");
    const binding = db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?")
      .get(command.file_attempt_id);
    assertOwner(db, { workId: binding.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken });
    const currentTime = timestamp(now);
    if (binding.expires_at_ms <= currentTime) fail("FILE_ATTEMPT_EXPIRED", "File attempt has expired.");
    const digested = digestSealReceipt(options.receipt);
    if (command.state === "CONFIRMED") {
      if (command.receipt_digest !== digested.digest) {
        fail("FILE_ATTEMPT_SEAL_CONFLICT", "File attempt seal receipt conflicts with durable state.");
      }
      return { duplicate: true, binding: mapBinding(binding), command: mapSealCommand(command) };
    }
    if (command.state === "REJECTED" || binding.seal_status !== "OPEN" ||
        command.seal_command_id !== digested.receipt.seal_command_id ||
        binding.resolved_file_attempt_binding_digest !== digested.receipt.resolved_file_attempt_binding_digest ||
        binding.creator_file_broker_epoch !== digested.receipt.creator_file_broker_epoch ||
        binding.creator_file_broker_epoch !== options.epoch) {
      fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "File attempt seal receipt does not match the binding.");
    }
    db.prepare(`
      UPDATE file_attempt_seal_commands
      SET state = 'CONFIRMED', receipt_json = ?, receipt_digest = ?, last_error_code = NULL, updated_at_ms = ?
      WHERE seal_command_id = ? AND state IN ('PENDING', 'SENT', 'UNKNOWN')
    `).run(digested.canonicalJson, digested.digest, currentTime, options.sealCommandId);
    const changed = db.prepare(`
      UPDATE file_attempt_bindings
      SET seal_status = 'SEALED', file_attempt_seal_receipt_digest = ?, updated_at_ms = ?
      WHERE file_attempt_id = ? AND seal_status = 'OPEN'
    `).run(digested.digest, currentTime, binding.file_attempt_id).changes;
    if (changed !== 1) fail("FILE_ATTEMPT_SEAL_CONFLICT", "File attempt changed while sealing.");
    return {
      duplicate: false,
      binding: mapBinding(db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?")
        .get(binding.file_attempt_id)),
      command: mapSealCommand(db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
        .get(options.sealCommandId))
    };
  });

  const revokeFileAttemptTx = db.transaction((options) => {
    const binding = db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(options.fileAttemptId);
    if (!binding) fail("FILE_ATTEMPT_NOT_FOUND", "File attempt does not exist.");
    assertOwner(db, { workId: binding.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken }, {
      allowReconciling: true
    });
    if (binding.seal_status === "REVOKED") return { duplicate: true, binding: mapBinding(binding) };
    if (binding.seal_status === "SEALED") fail("FILE_ATTEMPT_STATE_INVALID", "Sealed file attempt cannot be revoked.");
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE file_attempt_bindings SET seal_status = 'REVOKED', updated_at_ms = ?
      WHERE file_attempt_id = ? AND seal_status = 'OPEN'
    `).run(currentTime, options.fileAttemptId);
    return {
      duplicate: false,
      binding: mapBinding(db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?")
        .get(options.fileAttemptId))
    };
  });

  const createOutboxStagingManifestTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const owner = assertOwner(db, options);
    const binding = db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?")
      .get(options.fileAttemptId);
    if (binding?.expires_at_ms <= currentTime) fail("FILE_ATTEMPT_EXPIRED", "File attempt has expired.");
    if (!binding || binding.work_id !== options.workId || binding.seal_status !== "SEALED" ||
        options.expiresAt <= currentTime ||
        binding.creator_file_broker_epoch !== options.epoch || binding.bound_thread_id === null) {
      fail("FILE_ATTEMPT_NOT_SEALED", "A matching sealed file attempt is required.");
    }
    const existing = db.prepare(`
      SELECT * FROM document_manifests
      WHERE work_id = ? AND direction = 'OUTBOX' AND message_id = ? AND version = ?
    `).get(options.workId, options.messageId, options.version);
    const manifest = Object.freeze({
      manifest_version: 1,
      work_id: options.workId,
      direction: "OUTBOX",
      message_id: options.messageId,
      version: options.version,
      final_filename: options.finalFilename,
      actor_class: options.actorClass,
      actor_digest12: options.actorDigest12,
      kind: options.kind,
      mime_type: options.mimeType,
      expected_bytes: options.expectedBytes,
      expected_sha256: options.expectedSha256,
      retention_class: options.retentionClass,
      expires_at: options.expiresAt,
      source: options.source,
      authority: options.authority,
      sensitivity: options.sensitivity,
      access: options.access,
      provenance_receipt_digest: options.provenanceReceiptDigest,
      policy_revision: options.policyRevision,
      key_id: options.keyId,
      creator_file_broker_epoch: binding.creator_file_broker_epoch,
      broker_owner_receipt_digest: owner.owner_receipt_digest,
      file_attempt_id: binding.file_attempt_id,
      file_attempt_request_digest: binding.file_attempt_request_digest,
      resolved_file_attempt_binding_digest: binding.resolved_file_attempt_binding_digest,
      file_attempt_seal_receipt_digest: binding.file_attempt_seal_receipt_digest
    });
    const manifestJson = canonicalizeFileExchangeJson(manifest);
    const manifestDigest = fileExchangeDigest(manifest);
    if (existing) {
      if (existing.manifest_digest !== manifestDigest || existing.expected_sha256 !== options.expectedSha256) {
        fail("DOCUMENT_CONFLICT", "Document identity already has different content.");
      }
      return { duplicate: true, manifest: mapManifest(existing) };
    }
    const documentId = identifier(idFactory, "document");
    db.prepare(`
      INSERT INTO document_manifests (
        document_id, work_id, direction, message_id, version, final_filename,
        actor_class, actor_digest12, kind, mime_type, expected_bytes, expected_sha256,
        manifest_json, manifest_digest, retention_class, expires_at_ms,
        source, authority, sensitivity, access_mode, provenance_receipt_json,
        provenance_receipt_digest, policy_revision, key_id,
        creator_file_broker_epoch, current_recovery_broker_epoch,
        broker_owner_receipt_digest, file_attempt_id, file_attempt_request_digest,
        resolved_file_attempt_binding_digest, file_attempt_seal_receipt_digest,
        state, failure_code, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'OUTBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'STAGING', NULL, ?, ?)
    `).run(
      documentId, options.workId, options.messageId, options.version, options.finalFilename,
      options.actorClass, options.actorDigest12, options.kind, options.mimeType,
      options.expectedBytes, options.expectedSha256, manifestJson, manifestDigest,
      options.retentionClass, options.expiresAt, options.source, options.authority,
      options.sensitivity, options.access, canonicalizeFileExchangeJson(options.provenanceReceipt),
      options.provenanceReceiptDigest, options.policyRevision, options.keyId, binding.creator_file_broker_epoch,
      owner.file_broker_epoch, owner.owner_receipt_digest, binding.file_attempt_id,
      binding.file_attempt_request_digest, binding.resolved_file_attempt_binding_digest,
      binding.file_attempt_seal_receipt_digest, currentTime, currentTime
    );
    return {
      duplicate: false,
      manifest: mapManifest(db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(documentId))
    };
  });

  const transitionDocumentManifestTx = db.transaction((options) => {
    const row = db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(options.documentId);
    if (!row) fail("DOCUMENT_NOT_FOUND", "Document manifest does not exist.");
    assertOwner(db, { workId: row.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken });
    if (row.current_recovery_broker_epoch !== options.epoch) {
      fail("FILE_BROKER_FENCE_LOST", "Document manifest belongs to another broker epoch.");
    }
    if (row.state === options.state && row.failure_code === (options.failureCode ?? null)) {
      return { duplicate: true, manifest: mapManifest(row) };
    }
    const allowed = row.state === "STAGING" && ["AVAILABLE", "UNAVAILABLE", "QUARANTINED"].includes(options.state) ||
      row.state === "AVAILABLE" && options.state === "UNAVAILABLE";
    if (!allowed) fail("DOCUMENT_STATE_INVALID", "Document state transition is invalid.");
    const currentTime = timestamp(now);
    const changed = db.prepare(`
      UPDATE document_manifests SET state = ?, failure_code = ?, updated_at_ms = ?
      WHERE document_id = ? AND state = ? AND current_recovery_broker_epoch = ?
    `).run(
      options.state, options.failureCode ?? null, currentTime, options.documentId,
      row.state, options.epoch
    ).changes;
    if (changed !== 1) fail("FILE_BROKER_FENCE_LOST", "Document manifest changed concurrently.");
    return {
      duplicate: false,
      manifest: mapManifest(db.prepare("SELECT * FROM document_manifests WHERE document_id = ?")
        .get(options.documentId))
    };
  });

  const adoptStagingDocumentTx = db.transaction((options) => {
    const row = db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(options.documentId);
    if (!row || row.state !== "STAGING") fail("DOCUMENT_STATE_INVALID", "Only staging documents can be adopted.");
    assertOwner(db, { workId: row.work_id, epoch: options.epoch, ownerLockToken: options.ownerLockToken });
    if (row.current_recovery_broker_epoch === options.epoch) {
      return { duplicate: true, manifest: mapManifest(row) };
    }
    const binding = row.direction === "INBOX" ? null : db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?")
      .get(row.file_attempt_id);
    if (row.direction === "OUTBOX") {
      if (binding?.expires_at_ms <= timestamp(now)) fail("FILE_ATTEMPT_EXPIRED", "File attempt has expired.");
      if (!binding || binding.seal_status !== "SEALED" ||
          binding.file_attempt_request_digest !== row.file_attempt_request_digest ||
          binding.resolved_file_attempt_binding_digest !== row.resolved_file_attempt_binding_digest ||
          binding.file_attempt_seal_receipt_digest !== row.file_attempt_seal_receipt_digest) {
        fail("DOCUMENT_RECOVERY_UNPROVEN", "Document recovery evidence is incomplete.");
      }
    }
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE document_manifests SET current_recovery_broker_epoch = ?, updated_at_ms = ?
      WHERE document_id = ? AND state = 'STAGING' AND current_recovery_broker_epoch = ?
    `).run(options.epoch, currentTime, options.documentId, row.current_recovery_broker_epoch);
    return {
      duplicate: false,
      manifest: mapManifest(db.prepare("SELECT * FROM document_manifests WHERE document_id = ?")
        .get(options.documentId))
    };
  });

  const createInboxStagingManifestTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const owner = assertOwner(db, options);
    if (options.expiresAt <= currentTime) fail("DOCUMENT_EXPIRED", "Document retention has already expired.");
    if (!validateProvenance(options)) fail("DOCUMENT_PROVENANCE_INVALID", "Document provenance is invalid.");
    const existing = db.prepare(`
      SELECT * FROM document_manifests
      WHERE work_id = ? AND direction = 'INBOX' AND message_id = ? AND version = ?
    `).get(options.workId, options.messageId, options.version);
    const manifest = Object.freeze({
      manifest_version: 1,
      work_id: options.workId,
      direction: "INBOX",
      message_id: options.messageId,
      version: options.version,
      final_filename: options.finalFilename,
      actor_class: options.actorClass,
      actor_digest12: options.actorDigest12,
      kind: options.kind,
      mime_type: options.mimeType,
      expected_bytes: options.expectedBytes,
      expected_sha256: options.expectedSha256,
      retention_class: options.retentionClass,
      expires_at: options.expiresAt,
      source: options.source,
      authority: options.authority,
      sensitivity: options.sensitivity,
      access: options.access,
      provenance_receipt_digest: options.provenanceReceiptDigest,
      policy_revision: options.policyRevision,
      key_id: options.keyId,
      broker_owner_receipt_digest: owner.owner_receipt_digest
    });
    const manifestJson = canonicalizeFileExchangeJson(manifest);
    const manifestDigest = fileExchangeDigest(manifest);
    if (existing) {
      if (existing.manifest_digest !== manifestDigest) fail("DOCUMENT_CONFLICT", "Document identity already has different content.");
      return { duplicate: true, manifest: mapManifest(existing) };
    }
    const documentId = identifier(idFactory, "document");
    db.prepare(`
      INSERT INTO document_manifests (
        document_id, work_id, direction, message_id, version, final_filename,
        actor_class, actor_digest12, kind, mime_type, expected_bytes, expected_sha256,
        manifest_json, manifest_digest, retention_class, expires_at_ms,
        source, authority, sensitivity, access_mode, provenance_receipt_json,
        provenance_receipt_digest, policy_revision, key_id,
        creator_file_broker_epoch, current_recovery_broker_epoch,
        broker_owner_receipt_digest, file_attempt_id, file_attempt_request_digest,
        resolved_file_attempt_binding_digest, file_attempt_seal_receipt_digest,
        state, failure_code, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'INBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'STAGING', NULL, ?, ?)
    `).run(
      documentId, options.workId, options.messageId, options.version, options.finalFilename,
      options.actorClass, options.actorDigest12, options.kind, options.mimeType,
      options.expectedBytes, options.expectedSha256, manifestJson, manifestDigest,
      options.retentionClass, options.expiresAt, options.source, options.authority,
      options.sensitivity, options.access, canonicalizeFileExchangeJson(options.provenanceReceipt),
      options.provenanceReceiptDigest, options.policyRevision, options.keyId,
      owner.file_broker_epoch, owner.file_broker_epoch, owner.owner_receipt_digest,
      currentTime, currentTime
    );
    return { duplicate: false, manifest: mapManifest(db.prepare(
      "SELECT * FROM document_manifests WHERE document_id = ?"
    ).get(documentId)) };
  });

  const issueDocumentAccessTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const document = db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(options.documentId);
    if (!document || document.state !== "AVAILABLE") fail("DOCUMENT_NOT_AVAILABLE", "Document is not available.");
    if (document.version !== options.documentVersion || document.expected_sha256 !== options.documentSha256 ||
        document.expires_at_ms <= currentTime) fail("DOCUMENT_ACCESS_DENIED", "Document access is expired or mismatched.");
    const existing = db.prepare("SELECT * FROM document_access_issues WHERE issuance_key = ?").get(options.issuanceKey);
    if (existing) {
      if (existing.document_id !== options.documentId || existing.operation !== options.operation ||
          existing.consumer_digest !== options.consumerDigest || existing.grant_digest !== options.grantDigest) {
        fail("DOCUMENT_ACCESS_CONFLICT", "Document access issuance conflicts with durable state.");
      }
      return { duplicate: true, issue: mapAccessIssue(existing) };
    }
    const accessId = identifier(idFactory, "document-access");
    db.prepare(`
      INSERT INTO document_access_issues (
        access_id, document_id, document_version, document_sha256, operation,
        consumer_digest, grant_digest, issuance_key, access_ref_digest,
        expires_at_ms, state, consumed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', NULL, ?, ?)
    `).run(
      accessId, options.documentId, document.version, document.expected_sha256, options.operation,
      options.consumerDigest, options.grantDigest, options.issuanceKey, options.accessRefDigest,
      Math.min(options.expiresAt, document.expires_at_ms), currentTime, currentTime
    );
    return { duplicate: false, issue: mapAccessIssue(db.prepare(
      "SELECT * FROM document_access_issues WHERE access_id = ?"
    ).get(accessId)) };
  });

  const consumeDocumentAccessTx = db.transaction((options) => {
    const currentTime = timestamp(now);
    const row = db.prepare("SELECT * FROM document_access_issues WHERE access_ref_digest = ?").get(options.accessRefDigest);
    if (!row) fail("DOCUMENT_ACCESS_NOT_FOUND", "Document access reference does not exist.");
    if (row.document_id !== options.documentId || row.consumer_digest !== options.consumerDigest ||
        row.operation !== options.operation) fail("DOCUMENT_ACCESS_DENIED", "Document access reference is not valid for this consumer.");
    if (row.state === "CONSUMED") return { duplicate: true, issue: mapAccessIssue(row) };
    if (row.state !== "ISSUED" || row.expires_at_ms <= currentTime) {
      db.prepare("UPDATE document_access_issues SET state = 'EXPIRED', updated_at_ms = ? WHERE access_id = ? AND state = 'ISSUED'")
        .run(currentTime, row.access_id);
      fail("DOCUMENT_ACCESS_EXPIRED", "Document access reference has expired.");
    }
    db.prepare("UPDATE document_access_issues SET state = 'CONSUMED', consumed_at_ms = ?, updated_at_ms = ? WHERE access_id = ? AND state = 'ISSUED'")
      .run(currentTime, currentTime, row.access_id);
    return { duplicate: false, issue: mapAccessIssue(db.prepare(
      "SELECT * FROM document_access_issues WHERE access_id = ?"
    ).get(row.access_id)) };
  });

  const markDocumentDeletePendingTx = db.transaction(({ documentId }) => {
    const currentTime = timestamp(now);
    const row = db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(documentId);
    if (!row) fail("DOCUMENT_NOT_FOUND", "Document manifest does not exist.");
    if (row.state === "STAGING") {
      fail("DOCUMENT_RETENTION_BLOCKED", "Staging documents must be reconciled before retention cleanup.");
    }
    if (row.delete_pending_at_ms !== null) return { duplicate: true, manifest: mapManifest(row) };
    db.prepare("UPDATE document_manifests SET delete_pending_at_ms = ?, updated_at_ms = ? WHERE document_id = ?")
      .run(currentTime, currentTime, documentId);
    return { duplicate: false, manifest: mapManifest(db.prepare(
      "SELECT * FROM document_manifests WHERE document_id = ?"
    ).get(documentId)) };
  });

  const markDocumentDeletedTx = db.transaction(({ documentId, deletedAt }) => {
    const currentTime = timestamp(now);
    const row = db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(documentId);
    if (!row) fail("DOCUMENT_NOT_FOUND", "Document manifest does not exist.");
    if (row.deleted_at_ms !== null) return { duplicate: true, manifest: mapManifest(row) };
    if (!Number.isSafeInteger(deletedAt) || deletedAt < 0) fail("DOCUMENT_RETENTION_INVALID", "Document deletion time is invalid.");
    db.prepare("UPDATE document_manifests SET state = 'UNAVAILABLE', deleted_at_ms = ?, updated_at_ms = ? WHERE document_id = ? AND state IN ('AVAILABLE', 'UNAVAILABLE', 'QUARANTINED')")
      .run(deletedAt, currentTime, documentId);
    return { duplicate: false, manifest: mapManifest(db.prepare(
      "SELECT * FROM document_manifests WHERE document_id = ?"
    ).get(documentId)) };
  });

  return Object.freeze({
    acquireFileBrokerOwnership(options) {
      if (!plainObject(options) || !text(options.workId) || !text(options.ownerLockToken) ||
          !plainObject(options.ownerReceipt) || !Number.isSafeInteger(options.expectedEpoch) || options.expectedEpoch < 0) {
        fail("FILE_BROKER_OWNER_INVALID", "File broker ownership request is invalid.");
      }
      normalizeOwnerReceipt(options.ownerReceipt);
      return acquireFileBrokerOwnershipTx.immediate(options);
    },
    markFileBrokerReady(options) {
      if (!validateOwnerFence(options)) fail("FILE_BROKER_OWNER_INVALID", "File broker fence is invalid.");
      return markFileBrokerReadyTx.immediate(options);
    },
    createFileAttemptBinding(options) {
      if (!validateOwnerFence(options) || !text(options.commandId) ||
          (options.expectedThreadId !== undefined && options.expectedThreadId !== null && !text(options.expectedThreadId)) ||
          !Number.isSafeInteger(options.expiresAt) || options.expiresAt < 0) {
        fail("FILE_ATTEMPT_BINDING_INVALID", "File attempt binding request is invalid.");
      }
      normalizeDigest(options.scopeDigest);
      normalizeDigest(options.limitProfileDigest);
      return createFileAttemptBindingTx.immediate({ ...options, expectedThreadId: options.expectedThreadId ?? null });
    },
    resolveFileAttemptBinding(options) {
      if (!plainObject(options) || !text(options.fileAttemptId) || !text(options.threadId) ||
          !text(options.turnId) || !Number.isSafeInteger(options.epoch) || options.epoch <= 0 ||
          !text(options.ownerLockToken)) {
        fail("FILE_ATTEMPT_BINDING_INVALID", "Resolved file attempt binding is invalid.");
      }
      return resolveFileAttemptBindingTx.immediate(options);
    },
    prepareFileAttemptSeal(options) {
      if (!plainObject(options) || !text(options.fileAttemptId) || !Number.isSafeInteger(options.epoch) ||
          options.epoch <= 0 || !text(options.ownerLockToken)) {
        fail("FILE_ATTEMPT_SEAL_COMMAND_INVALID", "File attempt seal command is invalid.");
      }
      return prepareFileAttemptSealTx.immediate(options);
    },
    recordFileAttemptSealState(options) {
      if (!plainObject(options) || !text(options.sealCommandId) ||
          !["SENT", "UNKNOWN", "REJECTED"].includes(options.state) ||
          (options.errorCode !== undefined && options.errorCode !== null && !text(options.errorCode, 128))) {
        fail("FILE_ATTEMPT_SEAL_STATE_INVALID", "File attempt seal state is invalid.");
      }
      return recordFileAttemptSealStateTx.immediate(options);
    },
    confirmVerifiedFileAttemptSeal(options) {
      if (!plainObject(options) || !text(options.sealCommandId) || !plainObject(options.receipt) ||
          !Number.isSafeInteger(options.epoch) || options.epoch <= 0 || !text(options.ownerLockToken)) {
        fail("FILE_ATTEMPT_SEAL_RECEIPT_INVALID", "File attempt seal receipt is invalid.");
      }
      return confirmVerifiedFileAttemptSealTx.immediate(options);
    },
    revokeFileAttempt(options) {
      if (!plainObject(options) || !text(options.fileAttemptId) || !Number.isSafeInteger(options.epoch) ||
          options.epoch <= 0 || !text(options.ownerLockToken)) {
        fail("FILE_ATTEMPT_STATE_INVALID", "File attempt revocation is invalid.");
      }
      return revokeFileAttemptTx.immediate(options);
    },
    createOutboxStagingManifest(options) {
      const filenameSuffix = plainObject(options) ? expectedFilenameSuffix(options) : null;
      if (!validateOwnerFence(options) || !text(options.fileAttemptId) || !MESSAGE_ID.test(options.messageId) ||
          !Number.isSafeInteger(options.version) || options.version < 1 || options.version > 2147483647 ||
          !FILE_NAME.test(options.finalFilename) || !ACTOR_CLASSES.has(options.actorClass) ||
          !HASH12.test(options.actorDigest12) || !DOCUMENT_KINDS.has(options.kind) ||
          !MIME_TYPE.test(options.mimeType) || !Number.isSafeInteger(options.expectedBytes) ||
          options.expectedBytes < 0 || !RETENTION_CLASSES.has(options.retentionClass) ||
          !Number.isSafeInteger(options.expiresAt) || options.expiresAt < 0 || filenameSuffix === null ||
          !validateProvenance(options) ||
          !/^\d{8}T\d{9}Z_/u.test(options.finalFilename) || !options.finalFilename.endsWith(filenameSuffix)) {
        fail("DOCUMENT_MANIFEST_INVALID", "Document manifest is invalid.");
      }
      normalizeDigest(options.expectedSha256);
      return createOutboxStagingManifestTx.immediate(options);
    },
    createInboxStagingManifest(options) {
      const filenameSuffix = plainObject(options) ? expectedFilenameSuffix(options) : null;
      if (!validateOwnerFence(options) || !text(options.messageId) || !MESSAGE_ID.test(options.messageId) ||
          !Number.isSafeInteger(options.version) || options.version < 1 || options.version > 2147483647 ||
          !FILE_NAME.test(options.finalFilename) || !ACTOR_CLASSES.has(options.actorClass) ||
          !HASH12.test(options.actorDigest12) || !DOCUMENT_KINDS.has(options.kind) ||
          !MIME_TYPE.test(options.mimeType) || !Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0 ||
          !RETENTION_CLASSES.has(options.retentionClass) || !Number.isSafeInteger(options.expiresAt) || options.expiresAt < 0 ||
          filenameSuffix === null || !options.finalFilename.endsWith(filenameSuffix) ||
          !plainObject(options.provenanceReceipt) || !validateProvenance(options)) {
        fail("DOCUMENT_MANIFEST_INVALID", "Inbox document manifest is invalid.");
      }
      normalizeDigest(options.expectedSha256);
      return createInboxStagingManifestTx.immediate(options);
    },
    transitionDocumentManifest(options) {
      if (!plainObject(options) || !text(options.documentId) || !Number.isSafeInteger(options.epoch) ||
          options.epoch <= 0 || !text(options.ownerLockToken) ||
          !["AVAILABLE", "UNAVAILABLE", "QUARANTINED"].includes(options.state) ||
          (options.failureCode !== undefined && options.failureCode !== null && !text(options.failureCode, 128))) {
        fail("DOCUMENT_STATE_INVALID", "Document state transition is invalid.");
      }
      return transitionDocumentManifestTx.immediate(options);
    },
    adoptStagingDocument(options) {
      if (!plainObject(options) || !text(options.documentId) || !Number.isSafeInteger(options.epoch) ||
          options.epoch <= 0 || !text(options.ownerLockToken)) {
        fail("DOCUMENT_RECOVERY_INVALID", "Document recovery request is invalid.");
      }
      return adoptStagingDocumentTx.immediate(options);
    },
    readFileBrokerOwner(workId) {
      if (!text(workId)) fail("FILE_BROKER_OWNER_INVALID", "File broker work ID is invalid.");
      return mapOwner(db.prepare("SELECT * FROM file_broker_owners WHERE work_id = ?").get(workId));
    },
    readFileBrokerOwnerReceipt(receiptDigest) {
      normalizeDigest(receiptDigest);
      const row = db.prepare("SELECT * FROM file_broker_owner_receipts WHERE receipt_digest = ?").get(receiptDigest);
      return row ? Object.freeze({
        receiptDigest: row.receipt_digest,
        workId: row.work_id,
        epoch: row.file_broker_epoch,
        ownerLockTokenDigest: row.owner_lock_token_digest,
        keyId: row.key_id,
        receipt: Object.freeze(JSON.parse(row.receipt_json)),
        createdAt: row.created_at_ms
      }) : null;
    },
    readFileAttemptBinding(fileAttemptId) {
      if (!text(fileAttemptId)) fail("FILE_ATTEMPT_BINDING_INVALID", "File attempt ID is invalid.");
      return mapBinding(db.prepare("SELECT * FROM file_attempt_bindings WHERE file_attempt_id = ?").get(fileAttemptId));
    },
    readFileAttemptSealCommand(sealCommandId) {
      if (!text(sealCommandId)) fail("FILE_ATTEMPT_SEAL_COMMAND_INVALID", "Seal command ID is invalid.");
      return mapSealCommand(db.prepare("SELECT * FROM file_attempt_seal_commands WHERE seal_command_id = ?")
        .get(sealCommandId));
    },
    readFileAttemptSealCommandByAttempt(fileAttemptId) {
      if (!text(fileAttemptId)) fail("FILE_ATTEMPT_SEAL_COMMAND_INVALID", "File attempt ID is invalid.");
      return mapSealCommand(db.prepare("SELECT * FROM file_attempt_seal_commands WHERE file_attempt_id = ?")
        .get(fileAttemptId));
    },
    readDocumentManifest(documentId) {
      if (!text(documentId)) fail("DOCUMENT_MANIFEST_INVALID", "Document ID is invalid.");
      return mapManifest(db.prepare("SELECT * FROM document_manifests WHERE document_id = ?").get(documentId));
    },
    readDocumentManifestByIdentity({ workId, direction, messageId, version }) {
      if (!text(workId) || !["INBOX", "OUTBOX"].includes(direction) || !MESSAGE_ID.test(messageId) ||
          !Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
        fail("DOCUMENT_MANIFEST_INVALID", "Document identity is invalid.");
      }
      return mapManifest(db.prepare(`
        SELECT * FROM document_manifests
        WHERE work_id = ? AND direction = ? AND message_id = ? AND version = ?
      `).get(workId, direction, messageId, version));
    },
    listDocumentManifests({ workId, state, direction } = {}) {
      if (!text(workId) || (state !== undefined && !["STAGING", "AVAILABLE", "UNAVAILABLE", "QUARANTINED"].includes(state)) ||
          (direction !== undefined && !["INBOX", "OUTBOX"].includes(direction))) {
        fail("DOCUMENT_MANIFEST_INVALID", "Document manifest query is invalid.");
      }
      const clauses = ["work_id = ?"];
      const params = [workId];
      if (state !== undefined) { clauses.push("state = ?"); params.push(state); }
      if (direction !== undefined) { clauses.push("direction = ?"); params.push(direction); }
      return db.prepare(`SELECT * FROM document_manifests WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms, document_id`)
        .all(...params).map(mapManifest);
    },
    issueDocumentAccess(options) {
      if (!plainObject(options) || !text(options.documentId) || !Number.isSafeInteger(options.documentVersion) ||
          options.documentVersion < 1 || !/^[a-f0-9]{64}$/u.test(options.documentSha256) ||
          !DOCUMENT_OPERATIONS.has(options.operation) || !/^[a-f0-9]{64}$/u.test(options.consumerDigest) ||
          !/^[a-f0-9]{64}$/u.test(options.grantDigest) || !text(options.issuanceKey, 256) ||
          !/^[a-f0-9]{64}$/u.test(options.accessRefDigest) || !Number.isSafeInteger(options.expiresAt) || options.expiresAt < 0) {
        fail("DOCUMENT_ACCESS_INVALID", "Document access issuance is invalid.");
      }
      return issueDocumentAccessTx(options);
    },
    readDocumentAccessByIssuanceKey(issuanceKey) {
      if (!text(issuanceKey, 256)) fail("DOCUMENT_ACCESS_INVALID", "Document issuance key is invalid.");
      return mapAccessIssue(db.prepare("SELECT * FROM document_access_issues WHERE issuance_key = ?").get(issuanceKey));
    },
    consumeDocumentAccess(options) {
      if (!plainObject(options) || !/^[a-f0-9]{64}$/u.test(options.accessRefDigest) || !text(options.documentId) ||
          !DOCUMENT_OPERATIONS.has(options.operation) || !/^[a-f0-9]{64}$/u.test(options.consumerDigest)) {
        fail("DOCUMENT_ACCESS_INVALID", "Document access consumption is invalid.");
      }
      return consumeDocumentAccessTx(options);
    },
    hasActiveDocumentAccess(documentId) {
      if (!text(documentId)) fail("DOCUMENT_ACCESS_INVALID", "Document ID is invalid.");
      return db.prepare("SELECT count(*) AS count FROM document_access_issues WHERE document_id = ? AND state = 'ISSUED' AND expires_at_ms > ?")
        .get(documentId, timestamp(now)).count > 0;
    },
    markDocumentDeletePending(options) {
      if (!plainObject(options) || !text(options.documentId)) fail("DOCUMENT_RETENTION_INVALID", "Document retention request is invalid.");
      return markDocumentDeletePendingTx(options);
    },
    markDocumentDeleted(options) {
      if (!plainObject(options) || !text(options.documentId) || !Number.isSafeInteger(options.deletedAt)) {
        fail("DOCUMENT_RETENTION_INVALID", "Document deletion request is invalid.");
      }
      return markDocumentDeletedTx(options);
    }
  });
}
