import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, openSync } from "node:fs";

import Database from "better-sqlite3";

import {
  appendArtifactSummary,
  manifestFromRows,
  normalizeArtifactManifest,
  validateArtifactManifestShape,
  verifyInputArtifactRows,
  verifyInputArtifacts,
  verifyOutputArtifactRows
} from "../artifacts.js";
import { interactionActionSpecs } from "../interactions.js";
import { updateProjectLocalExchangeStatus } from "../project-local-exchange.js";
import { createManagedFileExchangeState } from "../file-exchange/state.js";
import { createCoordinationStore } from "./coordination-store.js";
import { applyMigrations, isMigrationStoreError, MIGRATIONS } from "./migrations.js";
import {
  assertExecutionTransition,
  assertSubmissionTransition,
  canonicalJson,
  isStateError,
  reduceFact,
  stateError,
  validateFact
} from "./reducer.js";

const REPLAY_SKEW_MS = 30_000;
const MAX_CLAIM_LIMIT = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const INTERACTION_TTL_MS = 24 * 60 * 60 * 1_000;
const INTERACTION_RESPONSE_LEASE_MS = 2 * 60 * 1_000;
const MAX_INTERACTION_JSON_BYTES = 64 * 1024 * 1024;
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = (2n ** 63n) - 1n;
const INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);
const OWNER_FILE_MODE = 0o600;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ACTIVE_SUBMISSION_STATES = Object.freeze([
  "intent", "running", "submission_unknown", "reconciliation_needed"
]);

function pathStatus(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function secureFile(filePath, { create = false } = {}) {
  const status = pathStatus(filePath);
  if (status?.isSymbolicLink() || (status && !status.isFile())) {
    throw stateError("STORE_OPEN_FAILED", "Store could not be opened.");
  }
  if (!status && !create) return;

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_RDWR | noFollow | (create ? constants.O_CREAT : 0);
  const descriptor = openSync(filePath, flags, OWNER_FILE_MODE);
  try {
    fchmodSync(descriptor, OWNER_FILE_MODE);
  } finally {
    closeSync(descriptor);
  }
}

function secureStoreFiles(databasePath, { createDatabase = false } = {}) {
  secureFile(databasePath, { create: createDatabase });
  secureFile(`${databasePath}-wal`);
  secureFile(`${databasePath}-shm`);
}

function isOwnedStoreError(error) {
  return isStateError(error) || isMigrationStoreError(error);
}

function assertNow(nowProvider) {
  const value = nowProvider();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw stateError("STORE_CLOCK_INVALID", "Store clock must return integer Unix milliseconds.");
  }
  return value;
}

function assertId(idFactory, kind) {
  const value = idFactory(kind);
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw stateError("STORE_ID_INVALID", "Store ID factory returned an invalid ID.");
  }
  return value;
}

function requireText(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isWireRequestId(value) {
  return (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 4096) ||
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "bigint" && value >= MIN_INT64 && value <= MAX_INT64);
}

function encodeWireRequestId(value) {
  return {
    type: typeof value === "string" ? "string" : "number",
    text: String(value)
  };
}

function decodeWireRequestId(type, text) {
  if (type === "string") return text;
  const value = BigInt(text);
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value;
}

function mapOutboxRow(row) {
  return {
    deliveryId: row.delivery_id,
    objectiveId: row.objective_id,
    semanticKey: row.semantic_key,
    objectiveSequence: row.objective_sequence,
    payload: JSON.parse(row.payload_json),
    targetSnapshot: JSON.parse(row.target_snapshot_json),
    state: row.state,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at_ms,
    lastError: row.last_error,
    zulipMessageId: row.acknowledged_zulip_message_id
  };
}

function mapSubmissionRow(row) {
  if (!row) return null;
  return {
    submissionId: row.submission_id,
    objectiveId: row.objective_id,
    clientUserMessageId: row.client_user_message_id,
    text: row.input_text,
    targetSnapshot: JSON.parse(row.target_snapshot_json),
    turnId: row.turn_id,
    state: row.submission_state,
    terminalStatus: row.terminal_status,
    cancellationRequested: row.cancellation_requested === 1,
    reconciliationRequired: row.reconciliation_required === 1,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token
  };
}

function mapTurnOutputRow(row) {
  if (!row) return null;
  return {
    submissionId: row.submission_id,
    objectiveId: row.objective_id,
    turnId: row.turn_id,
    rawText: row.raw_text,
    selectedItemIds: JSON.parse(row.selected_item_ids_json),
    createdAt: row.created_at_ms
  };
}

function mapArtifactRow(row) {
  return {
    submissionId: row.submission_id,
    objectiveId: row.objective_id,
    baseDir: row.base_dir,
    artifactId: row.artifact_id,
    direction: row.direction,
    path: row.path,
    absolutePath: row.absolute_path,
    kind: row.kind,
    mimeType: row.mime_type,
    required: row.required === 1,
    maxBytes: row.max_bytes,
    expectedSha256: row.expected_sha256,
    observedSha256: row.observed_sha256,
    observedBytes: row.observed_bytes,
    state: row.state
  };
}

function mapAuditFactRow(row) {
  return {
    factId: row.fact_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    objectiveId: row.objective_id,
    submissionId: row.submission_id,
    fact: JSON.parse(row.fact_json),
    recordedAt: row.recorded_at_ms
  };
}

function mapInteractionRow(row) {
  if (!row) return null;
  const answerJson = row.settlement_answer_json ?? row.answer_json;
  const answeredById = row.settlement_answered_by_id ?? row.answered_by_id;
  const answeredAt = row.settlement_answered_at_ms ?? row.answered_at_ms;
  return {
    interactionId: row.interaction_id,
    connectionId: row.connection_id,
    wireRequestId: decodeWireRequestId(row.wire_id_type, row.wire_id_json),
    method: row.method,
    objectiveId: row.objective_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    approvalId: row.approval_id,
    request: JSON.parse(row.request_json),
    allowedResponderIds: JSON.parse(row.allowed_responder_ids_json),
    targetSnapshot: JSON.parse(row.target_snapshot_json),
    expiresAt: row.expires_at_ms,
    state: row.state,
    answer: answerJson === null ? null : JSON.parse(answerJson),
    partialAnswers: row.partial_answers_json === null ? null : JSON.parse(row.partial_answers_json),
    answeredById: answeredById === null ? null : Number(answeredById),
    answeredAt,
    responseDeliveryState: row.response_delivery_state,
    responseDeliveryUpdatedAt: row.response_delivery_updated_at_ms,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  };
}

function mapInteractionActionRow(row) {
  return {
    interactionId: row.interaction_id,
    actionId: row.action_id,
    sourceKey: row.source_key,
    actionClass: row.action_class,
    label: row.label,
    style: row.style,
    answer: JSON.parse(row.answer_json),
    naturalAliasEligible: row.natural_alias_eligible === 1,
    ordinal: row.ordinal,
    createdAt: row.created_at_ms
  };
}

function readInteractionActions(db, interactionId) {
  return db.prepare(`
    SELECT * FROM interaction_actions WHERE interaction_id = ? ORDER BY ordinal
  `).all(interactionId).map(mapInteractionActionRow);
}

function mapInteractionWithActions(db, row) {
  const interaction = mapInteractionRow(row);
  if (!interaction) return null;
  interaction.actions = readInteractionActions(db, interaction.interactionId);
  return interaction;
}

function interactionCorrelationKey(options) {
  return createHash("sha256").update(canonicalJson({
    approvalId: options.approvalId ?? null,
    itemId: options.itemId ?? null,
    method: options.method,
    objectiveId: options.objectiveId,
    threadId: options.threadId,
    turnId: options.turnId
  }), "utf8").digest("hex");
}

function validateInteractionRender(rendered) {
  if (isPlainObject(rendered) && requireText(rendered.semanticKey) && isPlainObject(rendered.payload)) {
    return {
      detail: { mode: "notice", contentSha256: createHash("sha256").update("", "utf8").digest("hex"), contentBytes: 0 },
      deliveries: [{ ...rendered, role: "action_prompt", chunkIndex: null }]
    };
  }
  if (!isPlainObject(rendered) || !isPlainObject(rendered.detail) || !Array.isArray(rendered.deliveries) ||
      rendered.deliveries.length === 0 || !["inline", "chunks", "document", "notice"].includes(rendered.detail.mode) ||
      typeof rendered.detail.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rendered.detail.contentSha256) ||
      !Number.isSafeInteger(rendered.detail.contentBytes) || rendered.detail.contentBytes < 0) {
    throw stateError("INTERACTION_RENDER_INVALID", "Interaction renderer output is invalid.");
  }
  const semanticKeys = new Set();
  let actionPrompts = 0;
  let detailChunks = 0;
  for (const delivery of rendered.deliveries) {
    if (!isPlainObject(delivery) || !requireText(delivery.semanticKey) || !isPlainObject(delivery.payload) ||
        semanticKeys.has(delivery.semanticKey) || !["detail", "action_prompt", "notice"].includes(delivery.role) ||
        (delivery.role === "detail" ? !Number.isSafeInteger(delivery.chunkIndex) || delivery.chunkIndex < 0 : delivery.chunkIndex !== null)) {
      throw stateError("INTERACTION_RENDER_INVALID", "Interaction renderer output is invalid.");
    }
    semanticKeys.add(delivery.semanticKey);
    if (delivery.role === "detail") detailChunks += 1;
    if (delivery.role === "action_prompt") actionPrompts += 1;
  }
  if (actionPrompts > 1 || (actionPrompts === 1 && detailChunks === 0)) {
    throw stateError("INTERACTION_RENDER_INVALID", "Interaction renderer output is invalid.");
  }
  return rendered;
}

function validateRenderedChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw stateError("TERMINAL_RENDER_INVALID", "Terminal renderer output is invalid.");
  }
  const semanticKeys = new Set();
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk) ||
        !requireText(chunk.content) || !requireText(chunk.semanticKey) ||
        !requireText(chunk.contentHash) || !Number.isSafeInteger(chunk.index) || chunk.index <= 0 ||
        !Number.isSafeInteger(chunk.total) || chunk.total !== chunks.length ||
        !Number.isSafeInteger(chunk.rendererVersion) || chunk.rendererVersion <= 0 ||
        semanticKeys.has(chunk.semanticKey)) {
      throw stateError("TERMINAL_RENDER_INVALID", "Terminal renderer output is invalid.");
    }
    semanticKeys.add(chunk.semanticKey);
  }
  return chunks;
}

function readExecution(db, objectiveId) {
  const row = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(objectiveId);
  if (!row) return null;
  const placeholders = ACTIVE_SUBMISSION_STATES.map(() => "?").join(", ");
  const active = db.prepare(`
    SELECT * FROM turn_submissions
    WHERE objective_id = ? AND submission_state IN (${placeholders})
    ORDER BY created_at_ms DESC LIMIT 1
  `).get(objectiveId, ...ACTIVE_SUBMISSION_STATES);
  return {
    objectiveId: row.objective_id,
    backend: row.backend,
    executionStatus: row.execution_status,
    backendObjectiveStarted: row.backend_objective_started === 1,
    threadId: row.app_server_thread_id,
    threadStartUncertain: row.thread_start_uncertain === 1,
    activeSubmission: mapSubmissionRow(active)
  };
}

function executionPayloadHash(options) {
  const payload = {
    backend: options.backend,
    objectiveId: options.objectiveId,
    targetSnapshot: options.targetSnapshot,
    text: options.text
  };
  if (options.artifactMode !== undefined) payload.artifactMode = options.artifactMode;
  if (options.projectId !== undefined || options.topicBinding !== undefined) {
    payload.projectId = options.projectId;
    payload.topicBinding = options.topicBinding;
    if (options.topicModeAction !== undefined) payload.topicModeAction = options.topicModeAction;
  }
  if (options.artifacts !== undefined || options.artifactBaseDir !== undefined) {
    payload.artifacts = options.artifacts;
    payload.artifactBaseDir = options.artifactBaseDir;
  }
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function assertControllerIntent(options) {
  const hasArtifacts = options !== null && typeof options === "object" && options.artifacts !== undefined;
  const hasArtifactBaseDir = options !== null && typeof options === "object" && options.artifactBaseDir !== undefined;
  if (
    options === null || typeof options !== "object" ||
    !requireText(options.sourceType) || !requireText(options.sourceId) ||
    !requireText(options.objectiveId) || !["app-server", "tmux"].includes(options.backend) ||
    typeof options.text !== "string" || Buffer.byteLength(options.text, "utf8") > 1024 * 1024 ||
    options.targetSnapshot === null || typeof options.targetSnapshot !== "object" || Array.isArray(options.targetSnapshot)
  ) {
    throw stateError("EXECUTION_INTENT_INVALID", "Execution intent is invalid.");
  }
  if (options.artifactMode !== undefined && !["legacy", "project_local", "managed"].includes(options.artifactMode)) {
    throw stateError("EXECUTION_INTENT_INVALID", "Execution artifact mode is invalid.");
  }
  const controlled = options.projectId !== undefined || options.topicBinding !== undefined;
  if (controlled && (!requireText(options.projectId) || Buffer.byteLength(options.projectId, "utf8") > 64 ||
      !isPlainObject(options.topicBinding) || Object.keys(options.topicBinding).sort().join(",") !== "actorUserId,streamId,topic" ||
      !Number.isSafeInteger(options.topicBinding.streamId) || options.topicBinding.streamId <= 0 ||
      typeof options.topicBinding.topic !== "string" || options.topicBinding.topic.length === 0 ||
      Buffer.byteLength(options.topicBinding.topic, "utf8") > 256 ||
      !Number.isSafeInteger(options.topicBinding.actorUserId) || options.topicBinding.actorUserId <= 0 ||
      (options.topicModeAction !== undefined && options.topicModeAction !== "AUTO"))) {
    throw stateError("EXECUTION_INTENT_INVALID", "Execution intent is invalid.");
  }
  if (!controlled && options.topicModeAction !== undefined) {
    throw stateError("EXECUTION_INTENT_INVALID", "Execution intent is invalid.");
  }
  if (hasArtifacts !== hasArtifactBaseDir) {
    throw stateError("ARTIFACT_MANIFEST_INVALID", "Artifact manifest and base directory must be provided together.");
  }
  if (options.artifactMode === "managed" && hasArtifacts) {
    throw stateError("FILE_EXCHANGE_UNSUPPORTED", "Managed execution cannot use legacy project artifacts.");
  }
  if (options.artifactMode === "project_local" && !hasArtifacts) {
    throw stateError("ARTIFACT_MANIFEST_INVALID", "Project-local execution requires an HCO artifact manifest.");
  }
  if (hasArtifacts) {
    validateArtifactManifestShape(options.artifacts);
    verifyInputArtifacts(normalizeArtifactManifest(options.artifacts, { baseDir: options.artifactBaseDir }));
  }
}

function createTransactions(db, nowProvider, idFactory) {
  function appendControlFact({ sourceType, sourceId, eventName, payload, projectId = null, objectiveId = null, threadId = null, now }) {
    const payloadJson = canonicalJson(payload);
    const existing = db.prepare(`
      SELECT event_name, payload_json FROM event_journal WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    if (existing) {
      if (existing.event_name !== eventName || existing.payload_json !== payloadJson) {
        throw stateError("CONTROL_SOURCE_CONFLICT", "Control source identity conflicts with durable state.");
      }
      return { duplicate: true, payloadJson };
    }
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, project_id, objective_id, thread_id
      ) VALUES (?, ?, ?, ?, 1, ?, 'normal', ?, '{}', ?, ?, ?)
    `).run(eventRecordId, sourceType, sourceId, now, eventName, payloadJson, projectId, objectiveId, threadId);
    return { duplicate: false, payloadJson, eventRecordId };
  }

  function incrementGeneration(now) {
    db.prepare(`
      UPDATE control_plane_meta SET generation = generation + 1, updated_at_ms = ? WHERE singleton = 1
    `).run(now);
    return db.prepare("SELECT generation, updated_at_ms FROM control_plane_meta WHERE singleton = 1").get();
  }

  function activeAlias(streamId, topic) {
    return db.prepare(`
      SELECT * FROM topic_aliases WHERE stream_id = ? AND topic = ? AND active = 1
    `).get(streamId, topic);
  }

  function createAlias(streamId, topic, actorUserId, now) {
    const aliasId = assertId(idFactory, "topic-alias");
    db.prepare(`
      INSERT INTO topic_aliases (
        alias_id, stream_id, topic, active, created_by_user_id, created_at_ms,
        inactivated_by_user_id, inactivated_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)
    `).run(aliasId, streamId, topic, actorUserId, now);
    return { alias_id: aliasId, stream_id: streamId, topic };
  }

  function clearStreamTopics(streamId, actorUserId, now) {
    const aliases = db.prepare("SELECT alias_id FROM topic_aliases WHERE stream_id = ? AND active = 1").all(streamId);
    if (aliases.length === 0) return false;
    db.prepare(`
      DELETE FROM topic_modes WHERE alias_id IN (
        SELECT alias_id FROM topic_aliases WHERE stream_id = ? AND active = 1
      )
    `).run(streamId);
    db.prepare(`
      UPDATE topic_aliases
      SET active = 0, inactivated_by_user_id = ?, inactivated_at_ms = ?
      WHERE stream_id = ? AND active = 1
    `).run(actorUserId, now, streamId);
    return true;
  }

  function promoteObjectiveTopics(objectiveId, threadId, now) {
    const intents = db.prepare(`
      SELECT * FROM execution_topic_intents
      WHERE objective_id = ? AND promoted_at_ms IS NULL
      ORDER BY created_at_ms, source_type, source_id
    `).all(objectiveId);
    let changed = false;
    for (const intent of intents) {
      let alias = activeAlias(intent.stream_id, intent.topic);
      if (!alias) alias = createAlias(intent.stream_id, intent.topic, intent.actor_user_id, now);
      const current = db.prepare("SELECT * FROM topic_modes WHERE alias_id = ?").get(alias.alias_id);
      if (!current || current.mode !== "CODEX_BOUND" || current.project_id !== intent.project_id ||
          current.objective_id !== objectiveId || current.thread_id !== threadId) {
        db.prepare(`
          INSERT INTO topic_modes (alias_id, mode, project_id, objective_id, thread_id, updated_at_ms)
          VALUES (?, 'CODEX_BOUND', ?, ?, ?, ?)
          ON CONFLICT(alias_id) DO UPDATE SET
            mode = excluded.mode, project_id = excluded.project_id, objective_id = excluded.objective_id,
            thread_id = excluded.thread_id, updated_at_ms = excluded.updated_at_ms
        `).run(alias.alias_id, intent.project_id, objectiveId, threadId, now);
        changed = true;
      }
      db.prepare(`
        UPDATE execution_topic_intents SET promoted_at_ms = ?
        WHERE source_type = ? AND source_id = ?
      `).run(now, intent.source_type, intent.source_id);
    }
    if (changed) {
      const factSourceId = assertId(idFactory, "topic-promotion");
      appendControlFact({
        sourceType: "control-plane", sourceId: factSourceId, eventName: "topic.mode_promoted",
        payload: { mode: "CODEX_BOUND", objectiveId, threadId }, objectiveId, threadId, now
      });
      incrementGeneration(now);
    }
    return changed;
  }

  function pendingMissingThreadReplacement({ objectiveId, submissionId, expectedOldThreadId }) {
    const execution = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!execution || execution.backend !== "app-server" || execution.execution_status !== "submitting" ||
        execution.backend_objective_started !== 1 || execution.thread_start_uncertain !== 0 ||
        execution.app_server_thread_id !== expectedOldThreadId || !submission ||
        submission.objective_id !== objectiveId || submission.submission_state !== "intent" ||
        submission.turn_id !== null || submission.reconciliation_required !== 0) {
      throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
    }
    const active = db.prepare(`
      SELECT submission_id FROM turn_submissions
      WHERE objective_id = ? AND submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed')
    `).all(objectiveId);
    if (active.length !== 1 || active[0].submission_id !== submissionId) {
      throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
    }
    const topics = db.prepare("SELECT mode, thread_id FROM topic_modes WHERE objective_id = ?").all(objectiveId);
    if (topics.some((topic) => topic.mode !== "CODEX_BOUND" || topic.thread_id !== expectedOldThreadId)) {
      throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
    }
    return { execution, submission, topics };
  }

  const ingest = db.transaction((validated) => {
    const { fact, integrityJson, mode, payloadJson } = validated;
    const duplicate = db.prepare(`
      SELECT ingestion_seq, event_record_id
      FROM event_journal
      WHERE source_type = ? AND source_id = ?
    `).get(fact.sourceType, fact.sourceId);
    if (duplicate) {
      return {
        duplicate: true,
        ingestionSeq: duplicate.ingestion_seq,
        eventRecordId: duplicate.event_record_id,
        objective: null,
        outbox: []
      };
    }

    const now = assertNow(nowProvider);
    const eventRecordId = assertId(idFactory, "event");
    const inserted = db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, project_id, delivery_target_id,
        objective_id, thread_id, turn_id, item_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventRecordId,
      fact.sourceType,
      fact.sourceId,
      now,
      fact.schemaVersion,
      fact.eventName,
      mode,
      payloadJson,
      integrityJson,
      fact.projectId ?? null,
      fact.deliveryTargetId ?? null,
      fact.objectiveId ?? null,
      fact.threadId ?? null,
      fact.turnId ?? null,
      fact.itemId ?? null
    );
    const reduced = reduceFact(db, validated, { eventRecordId, idFactory: (kind) => assertId(idFactory, kind), now });
    return {
      duplicate: false,
      ingestionSeq: Number(inserted.lastInsertRowid),
      eventRecordId,
      ...reduced
    };
  });

  const claimOutbox = db.transaction(({ workerId, limit, leaseMs }) => {
    const now = assertNow(nowProvider);
    const candidates = db.prepare(`
      SELECT outbox.*
      FROM zulip_outbox AS outbox
      WHERE (
        outbox.state = 'pending'
        OR (outbox.state = 'leased' AND outbox.lease_expires_at_ms <= ?)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM zulip_outbox AS earlier
        WHERE earlier.objective_id = outbox.objective_id
          AND earlier.objective_sequence < outbox.objective_sequence
          AND earlier.state <> 'delivered'
          AND NOT (
            earlier.state = 'failed'
            AND COALESCE(json_extract(earlier.payload_json, '$.kind'), '') = 'interaction_prompt_delete'
          )
      )
      ORDER BY outbox.created_at_ms, outbox.objective_id, outbox.objective_sequence
      LIMIT ?
    `).all(now, limit);
    const claimed = [];
    const expireAttempt = db.prepare(`
      UPDATE delivery_attempts
      SET completed_at_ms = ?, outcome = 'lease_expired', error = 'lease expired'
      WHERE delivery_id = ? AND lease_token = ? AND outcome IS NULL
    `);
    const leaseRow = db.prepare(`
      UPDATE zulip_outbox
      SET state = 'leased', attempt_count = attempt_count + 1,
          lease_owner = ?, lease_token = ?, lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE delivery_id = ?
    `);
    const insertAttempt = db.prepare(`
      INSERT INTO delivery_attempts (
        delivery_id, attempt_number, worker_id, lease_token, started_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const getRow = db.prepare("SELECT * FROM zulip_outbox WHERE delivery_id = ?");

    for (const candidate of candidates) {
      if (candidate.state === "leased") {
        expireAttempt.run(now, candidate.delivery_id, candidate.lease_token);
      }
      const leaseToken = assertId(idFactory, "lease");
      const leaseExpiresAt = now + leaseMs;
      leaseRow.run(workerId, leaseToken, leaseExpiresAt, now, candidate.delivery_id);
      insertAttempt.run(candidate.delivery_id, candidate.attempt_count + 1, workerId, leaseToken, now);
      claimed.push(mapOutboxRow(getRow.get(candidate.delivery_id)));
    }
    return claimed;
  });

  const ackOutbox = db.transaction(({ deliveryId, leaseToken, zulipMessageId }) => {
    const now = assertNow(nowProvider);
    const row = db.prepare("SELECT * FROM zulip_outbox WHERE delivery_id = ?").get(deliveryId);
    if (!row) throw stateError("OUTBOX_DELIVERY_UNKNOWN", "Outbox delivery does not exist.");
    if (row.lease_token !== leaseToken) throw stateError("OUTBOX_LEASE_STALE", "Outbox lease token is stale.");
    if (row.state === "delivered") {
      if (row.acknowledged_zulip_message_id !== zulipMessageId) {
        throw stateError("OUTBOX_ACK_CONFLICT", "Outbox delivery was acknowledged with another message ID.");
      }
      return { deliveryId, state: "delivered", duplicate: true, zulipMessageId };
    }
    if (row.state !== "leased") throw stateError("OUTBOX_LEASE_STALE", "Outbox delivery is not currently leased.");
    if (row.lease_expires_at_ms <= now) throw stateError("OUTBOX_LEASE_EXPIRED", "Outbox lease has expired.");

    db.prepare(`
      UPDATE zulip_outbox
      SET state = 'delivered', acknowledged_zulip_message_id = ?, last_error = NULL, updated_at_ms = ?
      WHERE delivery_id = ?
    `).run(zulipMessageId, now, deliveryId);
    db.prepare(`
      UPDATE delivery_attempts
      SET completed_at_ms = ?, outcome = 'acknowledged', error = NULL, zulip_message_id = ?
      WHERE delivery_id = ? AND lease_token = ? AND outcome IS NULL
    `).run(now, zulipMessageId, deliveryId, leaseToken);
    const link = db.prepare(`
      SELECT interaction_id, role FROM interaction_delivery_links WHERE delivery_id = ?
    `).get(deliveryId);
    if (link?.role === "detail") {
      const remaining = db.prepare(`
        SELECT COUNT(*) AS count
        FROM interaction_delivery_links AS link
        JOIN zulip_outbox AS outbox USING (delivery_id)
        WHERE link.interaction_id = ? AND link.role = 'detail' AND outbox.state <> 'delivered'
      `).get(link.interaction_id).count;
      if (remaining === 0) {
        db.prepare(`
          UPDATE interaction_details
          SET detail_state = 'delivered', delivered_at_ms = ?
          WHERE interaction_id = ? AND detail_state = 'detail_pending'
        `).run(now, link.interaction_id);
      }
    }
    const remainingObjectiveDeliveries = db.prepare(`
      SELECT count(*) AS count FROM zulip_outbox
      WHERE objective_id = ? AND state <> 'delivered'
    `).get(row.objective_id).count;
    if (remainingObjectiveDeliveries === 0) {
      const directCalls = db.prepare(`
        SELECT * FROM codex_calls
        WHERE objective_id = ? AND report_target_kind = 'ZULIP' AND state = 'COMPLETED'
      `).all(row.objective_id);
      for (const call of directCalls) {
        const pendingInteraction = db.prepare(`
          SELECT 1
          FROM interaction_coordination AS coordination
          JOIN pending_interactions AS interaction USING (interaction_id)
          WHERE coordination.codex_call_id = ?
            AND (interaction.state = 'pending' OR interaction.response_delivery_state <> 'delivered')
          LIMIT 1
        `).get(call.codex_call_id);
        if (!pendingInteraction) {
          db.prepare(`
            UPDATE work_requests
            SET state = 'COMPLETED', status_reason = NULL, updated_at_ms = ?, terminal_at_ms = ?
            WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
          `).run(now, now, call.work_request_id);
        }
      }
    }
    return { deliveryId, state: "delivered", duplicate: false, zulipMessageId };
  });

  const nackOutbox = db.transaction(({ deliveryId, leaseToken, error, retryable }) => {
    const now = assertNow(nowProvider);
    const row = db.prepare("SELECT * FROM zulip_outbox WHERE delivery_id = ?").get(deliveryId);
    if (!row) throw stateError("OUTBOX_DELIVERY_UNKNOWN", "Outbox delivery does not exist.");
    if (row.state !== "leased" || row.lease_token !== leaseToken) {
      throw stateError("OUTBOX_LEASE_STALE", "Outbox lease token is stale.");
    }
    if (row.lease_expires_at_ms <= now) throw stateError("OUTBOX_LEASE_EXPIRED", "Outbox lease has expired.");
    const nextState = retryable ? "pending" : "failed";
    db.prepare(`
      UPDATE zulip_outbox
      SET state = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
          last_error = ?, updated_at_ms = ?
      WHERE delivery_id = ?
    `).run(nextState, error, now, deliveryId);
    db.prepare(`
      UPDATE delivery_attempts
      SET completed_at_ms = ?, outcome = ?, error = ?
      WHERE delivery_id = ? AND lease_token = ? AND outcome IS NULL
    `).run(now, retryable ? "retryable_failure" : "permanent_failure", error, deliveryId, leaseToken);
    if (!retryable) {
      const link = db.prepare(`
        SELECT interaction_id, role FROM interaction_delivery_links WHERE delivery_id = ?
      `).get(deliveryId);
      if (link?.role === "detail") {
        db.prepare(`
          UPDATE interaction_details SET detail_state = 'delivery_failed'
          WHERE interaction_id = ? AND detail_state = 'detail_pending'
        `).run(link.interaction_id);
      }
    }
    return { deliveryId, state: nextState, retryable };
  });

  const consume = db.transaction(({ nonce, expiresAt }) => {
    const now = assertNow(nowProvider);
    const retainUntil = expiresAt * 1_000 + REPLAY_SKEW_MS;
    if (!Number.isSafeInteger(retainUntil)) return false;
    db.prepare("DELETE FROM replay_nonces WHERE retain_until_ms < ?").run(now);
    const result = db.prepare(`
      INSERT OR IGNORE INTO replay_nonces (nonce, expires_at_seconds, retain_until_ms, consumed_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(nonce, expiresAt, retainUntil, now);
    return result.changes === 1;
  });

  const registerExecutionIntent = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const payloadHash = executionPayloadHash(options);
    const existingIntent = db.prepare(`
      SELECT inbound.*, submission.turn_id, submission.client_user_message_id
      FROM inbound_intents AS inbound
      LEFT JOIN turn_submissions AS submission ON submission.submission_id = inbound.submission_id
      WHERE inbound.source_type = ? AND inbound.source_id = ?
    `).get(options.sourceType, options.sourceId);
    if (existingIntent) {
      if (existingIntent.payload_hash !== payloadHash) {
        throw stateError("INBOUND_IDENTITY_CONFLICT", "Inbound identity was already used for different intent.");
      }
      let execution = readExecution(db, existingIntent.objective_id);
      const incomplete = existingIntent.submission_id === null;
      const terminal = incomplete && ["cancelled", "terminal_error"].includes(execution?.executionStatus);
      const busy = incomplete && ["starting", "submitting", "running", "submission_unknown", "reconciliation_needed"]
        .includes(execution?.executionStatus);
      if (incomplete && execution?.executionStatus === "completed" && execution.backendObjectiveStarted) {
        assertExecutionTransition("completed", "ready", { mode: "continuation" });
        db.prepare("UPDATE objective_execution SET execution_status = 'ready', updated_at_ms = ? WHERE objective_id = ?")
          .run(now, existingIntent.objective_id);
        execution = readExecution(db, existingIntent.objective_id);
      }
      const resumable = incomplete && execution?.executionStatus === "ready" && execution.backendObjectiveStarted;
      return {
        duplicate: !resumable && !busy && !terminal,
        busy,
        terminal,
        needsObjectiveStart: false,
        objectiveId: existingIntent.objective_id,
        submissionId: existingIntent.submission_id,
        clientUserMessageId: existingIntent.client_user_message_id,
        turnId: existingIntent.turn_id,
        execution
      };
    }

    let objective = db.prepare("SELECT objective_id FROM objectives WHERE objective_id = ?").get(options.objectiveId);
    let execution = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(options.objectiveId);
    let createdExecution = false;
    if (!objective) {
      const eventRecordId = assertId(idFactory, "event");
      db.prepare(`
        INSERT INTO event_journal (
          event_record_id, source_type, source_id, received_at_ms, event_schema_version,
          event_name, event_mode, payload_json, integrity_json, objective_id
        ) VALUES (?, 'execution-intent', ?, ?, 1, 'objective.created', 'normal', ?, ?, ?)
      `).run(
        eventRecordId,
        eventRecordId,
        now,
        canonicalJson({ state: "created" }),
        canonicalJson({ originalSourceId: options.sourceId, originalSourceType: options.sourceType }),
        options.objectiveId
      );
      db.prepare(`
        INSERT INTO objectives (
          objective_id, state, state_rank, next_outbox_sequence, created_at_ms, updated_at_ms, created_event_record_id
        ) VALUES (?, 'created', 0, 1, ?, ?, ?)
      `).run(options.objectiveId, now, now, eventRecordId);
      objective = { objective_id: options.objectiveId };
    }
    if (!execution) {
      db.prepare(`
        INSERT INTO objective_execution (
          objective_id, backend, execution_status, backend_objective_started,
          app_server_thread_id, thread_start_uncertain, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'starting', 0, NULL, 0, ?, ?)
      `).run(options.objectiveId, options.backend, now, now);
      execution = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(options.objectiveId);
      createdExecution = true;
    } else if (execution.backend !== options.backend) {
      throw stateError("OBJECTIVE_BACKEND_CONFLICT", "Objective backend selection is immutable.");
    }

    if (options.projectId !== undefined) {
      const project = db.prepare("SELECT project_id FROM objective_projects WHERE objective_id = ?").get(options.objectiveId);
      if (project && project.project_id !== options.projectId) {
        throw stateError("OBJECTIVE_PROJECT_CONFLICT", "Objective project binding is immutable.");
      }
      if (!project) {
        db.prepare(`
          INSERT INTO objective_projects (objective_id, project_id, created_at_ms) VALUES (?, ?, ?)
        `).run(options.objectiveId, options.projectId, now);
      }
      const topicPayloadHash = createHash("sha256").update(canonicalJson({
        objectiveId: options.objectiveId,
        projectId: options.projectId,
        topicBinding: options.topicBinding
      }), "utf8").digest("hex");
      const existingTopicIntent = db.prepare(`
        SELECT * FROM execution_topic_intents WHERE source_type = ? AND source_id = ?
      `).get(options.sourceType, options.sourceId);
      if (existingTopicIntent && existingTopicIntent.payload_hash !== topicPayloadHash) {
        throw stateError("CONTROL_SOURCE_CONFLICT", "Execution topic source identity conflicts with durable state.");
      }
      if (!existingTopicIntent) {
        db.prepare(`
          INSERT INTO execution_topic_intents (
            source_type, source_id, payload_hash, objective_id, project_id, stream_id, topic,
            actor_user_id, created_at_ms, promoted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          options.sourceType, options.sourceId, topicPayloadHash, options.objectiveId, options.projectId,
          options.topicBinding.streamId, options.topicBinding.topic, options.topicBinding.actorUserId, now
        );
      }
      if (options.topicModeAction === "AUTO") {
        const alias = activeAlias(options.topicBinding.streamId, options.topicBinding.topic);
        const mode = alias ? db.prepare("SELECT mode FROM topic_modes WHERE alias_id = ?").get(alias.alias_id) : null;
        appendControlFact({
          sourceType: options.sourceType,
          sourceId: options.sourceId,
          eventName: "topic.mode_changed",
          payload: {
            actorUserId: options.topicBinding.actorUserId,
            mode: "AUTO",
            projectId: options.projectId,
            streamId: options.topicBinding.streamId,
            topic: options.topicBinding.topic
          },
          projectId: options.projectId,
          objectiveId: options.objectiveId,
          now
        });
        if (alias && mode?.mode === "HERMES_ONLY") {
          db.prepare("DELETE FROM topic_modes WHERE alias_id = ?").run(alias.alias_id);
          db.prepare(`
            UPDATE topic_aliases SET active = 0, inactivated_by_user_id = ?, inactivated_at_ms = ? WHERE alias_id = ?
          `).run(options.topicBinding.actorUserId, now, alias.alias_id);
          incrementGeneration(now);
        }
      }
      if (execution.app_server_thread_id) promoteObjectiveTopics(options.objectiveId, execution.app_server_thread_id, now);
    }

    if (["cancelled", "terminal_error"].includes(execution.execution_status)) {
      return {
        duplicate: false,
        busy: false,
        terminal: true,
        objectiveId: options.objectiveId,
        execution: readExecution(db, options.objectiveId)
      };
    }

    db.prepare(`
      INSERT INTO inbound_intents (
        source_type, source_id, payload_hash, objective_id, submission_id, created_at_ms
      ) VALUES (?, ?, ?, ?, NULL, ?)
    `).run(options.sourceType, options.sourceId, payloadHash, options.objectiveId, now);

    const active = db.prepare(`
      SELECT submission_id FROM turn_submissions
      WHERE objective_id = ? AND submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed')
      LIMIT 1
    `).get(options.objectiveId);
    const busy = active !== undefined || ["starting", "submitting", "running", "submission_unknown", "reconciliation_needed"]
      .includes(execution.execution_status) && !(execution.execution_status === "starting" && createdExecution);
    let needsObjectiveStart = execution.backend_objective_started !== 1;
    if (!busy) {
      const next = needsObjectiveStart ? "starting" : "ready";
      assertExecutionTransition(
        execution.execution_status,
        next,
        execution.execution_status === "completed" ? { mode: "continuation" } : undefined
      );
      db.prepare("UPDATE objective_execution SET execution_status = ?, updated_at_ms = ? WHERE objective_id = ?")
        .run(next, now, options.objectiveId);
    }
    return {
      duplicate: false,
      busy,
      needsObjectiveStart: !busy && needsObjectiveStart,
      objectiveId: options.objectiveId,
      execution: readExecution(db, options.objectiveId)
    };
  });

  const bindBackendObjective = db.transaction(({ objectiveId, backend, threadId }) => {
    const now = assertNow(nowProvider);
    const row = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    if (!row || row.backend !== backend || row.execution_status !== "starting") {
      throw stateError("OBJECTIVE_BINDING_INVALID", "Objective backend binding is invalid.");
    }
    if ((backend === "app-server") !== requireText(threadId)) {
      throw stateError("OBJECTIVE_BINDING_INVALID", "Objective backend binding is invalid.");
    }
    assertExecutionTransition(row.execution_status, "ready");
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = 'ready', backend_objective_started = 1,
          app_server_thread_id = ?, thread_start_uncertain = 0, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(backend === "app-server" ? threadId : null, now, objectiveId);
    if (backend === "app-server") promoteObjectiveTopics(objectiveId, threadId, now);
    return readExecution(db, objectiveId);
  });

  const replaceMissingObjectiveThread = db.transaction(({
    objectiveId,
    submissionId,
    expectedOldThreadId,
    newThreadId
  }) => {
    const pending = pendingMissingThreadReplacement({ objectiveId, submissionId, expectedOldThreadId });
    if (newThreadId === expectedOldThreadId || db.prepare(`
      SELECT objective_id FROM objective_execution WHERE app_server_thread_id = ?
    `).get(newThreadId)) {
      throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
    }

    const now = assertNow(nowProvider);
    db.prepare(`
      UPDATE objective_execution
      SET app_server_thread_id = ?, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(newThreadId, now, objectiveId);
    const changedTopics = db.prepare(`
      UPDATE topic_modes SET thread_id = ?, updated_at_ms = ? WHERE objective_id = ?
    `).run(newThreadId, now, objectiveId).changes;
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, 'app-server-recovery', ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"),
      assertId(idFactory, "thread-replacement-audit"),
      objectiveId,
      submissionId,
      canonicalJson({
        kind: "app_server_thread_replaced",
        newThreadId,
        oldThreadId: expectedOldThreadId,
        reason: "proven_missing_thread"
      }),
      now
    );
    if (changedTopics > 0) incrementGeneration(now);
    return {
      execution: readExecution(db, objectiveId),
      submission: mapSubmissionRow(pending.submission)
    };
  });

  const markReplacementThreadStartUncertain = db.transaction(({
    objectiveId,
    submissionId,
    expectedOldThreadId
  }) => {
    const pending = pendingMissingThreadReplacement({ objectiveId, submissionId, expectedOldThreadId });
    const now = assertNow(nowProvider);
    assertSubmissionTransition(pending.submission.submission_state, "reconciliation_needed", { mode: "reconciliation" });
    assertExecutionTransition(pending.execution.execution_status, "reconciliation_needed", { mode: "reconciliation" });
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'reconciliation_needed', reconciliation_required = 1, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submissionId);
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = 'reconciliation_needed', thread_start_uncertain = 1, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(now, objectiveId);
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, 'app-server-recovery', ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"),
      assertId(idFactory, "thread-replacement-uncertain-audit"),
      objectiveId,
      submissionId,
      canonicalJson({
        kind: "app_server_thread_replacement_uncertain",
        oldThreadId: expectedOldThreadId,
        reason: "replacement_thread_start_uncertain"
      }),
      now
    );
    return readExecution(db, objectiveId);
  });

  const resolveObjectiveThread = db.transaction(({ objectiveId, threadId, sourceType, sourceId }) => {
    const resolutionFact = canonicalJson({ kind: "operator_thread_binding", threadId });
    const existingSource = db.prepare(`
      SELECT objective_id, submission_id, fact_json
      FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    if (existingSource) {
      if (existingSource.objective_id !== objectiveId || existingSource.fact_json !== resolutionFact) {
        throw stateError("OBJECTIVE_THREAD_RESOLUTION_SOURCE_CONFLICT", "Objective thread resolution source identity conflicts with durable state.");
      }
      const execution = readExecution(db, objectiveId);
      const submission = existingSource.submission_id === null ? null : db.prepare(`
        SELECT * FROM turn_submissions WHERE submission_id = ?
      `).get(existingSource.submission_id);
      const safeToResume = execution?.executionStatus === "submitting" &&
        execution.threadId === threadId && execution.threadStartUncertain === false &&
        submission?.objective_id === objectiveId && submission.submission_state === "intent" &&
        submission.turn_id === null && submission.reconciliation_required === 0;
      return {
        duplicate: true,
        execution,
        submission: safeToResume ? mapSubmissionRow(submission) : null
      };
    }

    const row = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    if (!row || row.backend !== "app-server" || row.execution_status !== "reconciliation_needed" ||
        row.thread_start_uncertain !== 1) {
      throw stateError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
    }
    const existingThread = db.prepare(`
      SELECT objective_id FROM objective_execution WHERE app_server_thread_id = ?
    `).get(threadId);
    if (existingThread) {
      throw stateError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
    }

    const now = assertNow(nowProvider);
    const replacementRecovery = row.app_server_thread_id !== null;
    let submission = null;
    if (replacementRecovery) {
      submission = db.prepare(`
        SELECT * FROM turn_submissions
        WHERE objective_id = ? AND submission_state = 'reconciliation_needed' AND turn_id IS NULL
      `).get(objectiveId);
      const topics = db.prepare("SELECT mode, thread_id FROM topic_modes WHERE objective_id = ?").all(objectiveId);
      if (!submission || submission.reconciliation_required !== 1 ||
          topics.some((topic) => topic.mode !== "CODEX_BOUND" || topic.thread_id !== row.app_server_thread_id)) {
        throw stateError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
      }
      assertSubmissionTransition(submission.submission_state, "intent", { mode: "reconciliation" });
      assertExecutionTransition(row.execution_status, "submitting", { mode: "reconciliation" });
    } else {
      const active = db.prepare(`
        SELECT 1 FROM turn_submissions
        WHERE objective_id = ? AND submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed')
      `).get(objectiveId);
      if (active) throw stateError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
      assertExecutionTransition(row.execution_status, "ready", { mode: "reconciliation" });
    }
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"), sourceType, sourceId, objectiveId,
      submission?.submission_id ?? null, resolutionFact, now
    );
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = ?, backend_objective_started = 1,
          app_server_thread_id = ?, thread_start_uncertain = 0, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(replacementRecovery ? "submitting" : "ready", threadId, now, objectiveId);
    if (replacementRecovery) {
      db.prepare(`
        UPDATE turn_submissions
        SET submission_state = 'intent', reconciliation_required = 0, updated_at_ms = ?
        WHERE submission_id = ?
      `).run(now, submission.submission_id);
      const changedTopics = db.prepare(`
        UPDATE topic_modes SET thread_id = ?, updated_at_ms = ? WHERE objective_id = ?
      `).run(threadId, now, objectiveId).changes;
      if (changedTopics > 0) incrementGeneration(now);
    } else {
      promoteObjectiveTopics(objectiveId, threadId, now);
    }
    return {
      duplicate: false,
      execution: readExecution(db, objectiveId),
      submission: submission === null ? null : mapSubmissionRow(
        db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submission.submission_id)
      )
    };
  });

  const applyRouteCommand = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const payload = {
      action: options.action,
      actorUserId: options.actorUserId,
      clearTopics: options.clearTopics,
      projectId: options.projectId ?? null,
      streamId: options.streamId
    };
    const fact = appendControlFact({
      sourceType: options.sourceType, sourceId: options.sourceId, eventName: "route.runtime_changed",
      payload, projectId: options.projectId ?? null, now
    });
    if (fact.duplicate) return { duplicate: true, changed: false, generation: db.prepare("SELECT generation FROM control_plane_meta").get().generation };
    const current = db.prepare("SELECT * FROM runtime_stream_routes WHERE stream_id = ?").get(options.streamId);
    let changed = false;
    if (options.action === "SET") {
      changed = !current || current.override_kind !== "project" || current.project_id !== options.projectId;
      if (changed) db.prepare(`
        INSERT INTO runtime_stream_routes (
          stream_id, override_kind, project_id, actor_user_id, source_type, source_id, updated_at_ms
        ) VALUES (?, 'project', ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          override_kind = excluded.override_kind, project_id = excluded.project_id,
          actor_user_id = excluded.actor_user_id, source_type = excluded.source_type,
          source_id = excluded.source_id, updated_at_ms = excluded.updated_at_ms
      `).run(options.streamId, options.projectId, options.actorUserId, options.sourceType, options.sourceId, now);
    } else if (options.action === "NONE") {
      changed = !current || current.override_kind !== "hermes";
      if (changed) db.prepare(`
        INSERT INTO runtime_stream_routes (
          stream_id, override_kind, project_id, actor_user_id, source_type, source_id, updated_at_ms
        ) VALUES (?, 'hermes', NULL, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          override_kind = excluded.override_kind, project_id = NULL,
          actor_user_id = excluded.actor_user_id, source_type = excluded.source_type,
          source_id = excluded.source_id, updated_at_ms = excluded.updated_at_ms
      `).run(options.streamId, options.actorUserId, options.sourceType, options.sourceId, now);
    } else {
      changed = Boolean(current);
      if (changed) db.prepare("DELETE FROM runtime_stream_routes WHERE stream_id = ?").run(options.streamId);
    }
    if (changed) {
      if (options.clearTopics) clearStreamTopics(options.streamId, options.actorUserId, now);
      incrementGeneration(now);
    }
    return { duplicate: false, changed, generation: db.prepare("SELECT generation FROM control_plane_meta").get().generation };
  });

  const setUserTopicMode = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const payload = {
      actorUserId: options.actorUserId, mode: options.mode, projectId: options.projectId,
      streamId: options.streamId, topic: options.topic
    };
    const fact = appendControlFact({
      sourceType: options.sourceType, sourceId: options.sourceId, eventName: "topic.mode_changed",
      payload, projectId: options.projectId, now
    });
    if (fact.duplicate) return { duplicate: true, changed: false, mode: options.mode, generation: db.prepare("SELECT generation FROM control_plane_meta").get().generation };
    let alias = activeAlias(options.streamId, options.topic);
    const current = alias ? db.prepare("SELECT * FROM topic_modes WHERE alias_id = ?").get(alias.alias_id) : null;
    let changed = false;
    if (options.mode === "AUTO") {
      if (alias && current) {
        db.prepare("DELETE FROM topic_modes WHERE alias_id = ?").run(alias.alias_id);
        db.prepare(`
          UPDATE topic_aliases SET active = 0, inactivated_by_user_id = ?, inactivated_at_ms = ? WHERE alias_id = ?
        `).run(options.actorUserId, now, alias.alias_id);
        changed = true;
      }
    } else {
      if (!alias) alias = createAlias(options.streamId, options.topic, options.actorUserId, now);
      if (!current || current.mode !== "HERMES_ONLY") {
        db.prepare(`
          INSERT INTO topic_modes (alias_id, mode, project_id, objective_id, thread_id, updated_at_ms)
          VALUES (?, 'HERMES_ONLY', NULL, NULL, NULL, ?)
          ON CONFLICT(alias_id) DO UPDATE SET
            mode = excluded.mode, project_id = NULL, objective_id = NULL,
            thread_id = NULL, updated_at_ms = excluded.updated_at_ms
        `).run(alias.alias_id, now);
        changed = true;
      }
    }
    if (changed) incrementGeneration(now);
    return { duplicate: false, changed, mode: options.mode, generation: db.prepare("SELECT generation FROM control_plane_meta").get().generation };
  });

  const bumpControlGeneration = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const fact = appendControlFact({
      sourceType: options.sourceType, sourceId: options.sourceId, eventName: "control.generation_bumped",
      payload: { reason: "static_registry_sync" }, now
    });
    if (fact.duplicate) return { duplicate: true, ...db.prepare("SELECT generation, updated_at_ms FROM control_plane_meta").get() };
    return { duplicate: false, ...incrementGeneration(now) };
  });

  const syncStaticRegistry = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const currentRoutes = db.prepare(`
      SELECT stream_id, project_id FROM static_stream_routes ORDER BY stream_id
    `).all();
    const meta = db.prepare("SELECT * FROM static_registry_meta WHERE singleton = 1").get();
    const unchanged = meta.initialized === 1 && currentRoutes.length === options.routes.length &&
      currentRoutes.every((route, index) => route.stream_id === options.routes[index].streamId &&
        route.project_id === options.routes[index].projectId);
    const readGeneration = () => db.prepare(`
      SELECT generation, updated_at_ms FROM control_plane_meta WHERE singleton = 1
    `).get();
    if (unchanged) {
      return { registryChanged: false, effectiveChanged: false, revision: meta.revision, ...readGeneration() };
    }

    const previous = new Map(currentRoutes.map((route) => [route.stream_id, route.project_id]));
    const next = new Map(options.routes.map((route) => [route.streamId, route.projectId]));
    const runtime = new Map(db.prepare(`
      SELECT stream_id, override_kind, project_id FROM runtime_stream_routes
    `).all().map((route) => [route.stream_id, route]));
    const effective = (streamId, registry) => {
      const override = runtime.get(streamId);
      if (override) return override.override_kind === "project" ? `PROJECT:${override.project_id}` : "HERMES";
      const projectId = registry.get(streamId);
      return projectId === undefined ? "HERMES" : `PROJECT:${projectId}`;
    };
    const streamIds = new Set([...previous.keys(), ...next.keys()]);
    const changedStreams = [...streamIds]
      .filter((streamId) => effective(streamId, previous) !== effective(streamId, next))
      .sort((left, right) => left - right);
    const revision = meta.revision + 1;
    const mappingSha256 = createHash("sha256").update(canonicalJson({ routes: options.routes }), "utf8").digest("hex");

    appendControlFact({
      sourceType: "hco-static-registry",
      sourceId: `revision:${revision}:${mappingSha256}`,
      eventName: "route.static_registry_synced",
      payload: {
        effectiveChangeCount: changedStreams.length,
        mappingSha256,
        registryRevision: revision,
        routeCount: options.routes.length
      },
      now
    });
    db.prepare("DELETE FROM static_stream_routes").run();
    const insert = db.prepare("INSERT INTO static_stream_routes (stream_id, project_id) VALUES (?, ?)");
    for (const route of options.routes) insert.run(route.streamId, route.projectId);
    db.prepare(`
      UPDATE static_registry_meta
      SET initialized = 1, revision = ?, mapping_sha256 = ?, updated_at_ms = ?
      WHERE singleton = 1
    `).run(revision, mappingSha256, now);
    for (const streamId of changedStreams) clearStreamTopics(streamId, null, now);
    const control = changedStreams.length > 0 ? incrementGeneration(now) : readGeneration();
    return {
      registryChanged: true,
      effectiveChanged: changedStreams.length > 0,
      revision,
      ...control
    };
  });

  const prepareTurnSubmission = db.transaction(({
    sourceType,
    sourceId,
    objectiveId,
    text,
    targetSnapshot,
    leaseOwner,
    artifacts,
    artifactBaseDir
  }) => {
    const artifactManifest = artifacts === undefined
      ? null
      : verifyInputArtifacts(normalizeArtifactManifest(artifacts, { baseDir: artifactBaseDir }));
    const now = assertNow(nowProvider);
    const execution = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    if (!execution) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const inbound = db.prepare(`
      SELECT * FROM inbound_intents WHERE source_type = ? AND source_id = ? AND objective_id = ?
    `).get(sourceType, sourceId, objectiveId);
    if (!inbound) throw stateError("EXECUTION_INTENT_NOT_FOUND", "Execution intent does not exist.");
    if (inbound.submission_id) {
      return { duplicate: true, submission: mapSubmissionRow(
        db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(inbound.submission_id)
      ) };
    }
    if (execution.execution_status !== "ready") return { busy: true, duplicate: false, submission: null };

    const submissionId = assertId(idFactory, "submission");
    const clientUserMessageId = assertId(idFactory, "client-user-message");
    const leaseToken = assertId(idFactory, "objective-lease");
    db.prepare(`
      INSERT INTO turn_submissions (
        submission_id, objective_id, client_user_message_id, input_text, target_snapshot_json,
        turn_id, submission_state, terminal_status, cancellation_requested,
        reconciliation_required, lease_owner, lease_token, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, 'intent', NULL, 0, 0, ?, ?, ?, ?)
    `).run(
      submissionId, objectiveId, clientUserMessageId, text, canonicalJson(targetSnapshot),
      leaseOwner, leaseToken, now, now
    );
    if (artifactManifest) {
      const insertArtifact = db.prepare(`
        INSERT INTO artifact_contracts (
          submission_id, objective_id, base_dir, artifact_id, direction, path, absolute_path,
          kind, mime_type, required, max_bytes, expected_sha256, observed_sha256,
          observed_bytes, state, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of [...artifactManifest.input, ...artifactManifest.output]) {
        insertArtifact.run(
          submissionId,
          objectiveId,
          artifactManifest.baseDir,
          artifact.artifactId,
          artifact.direction,
          artifact.path,
          artifact.absolutePath,
          artifact.kind,
          artifact.mimeType,
          artifact.required ? 1 : 0,
          artifact.maxBytes,
          artifact.expectedSha256,
          artifact.observedSha256,
          artifact.observedBytes,
          artifact.state,
          now,
          now
        );
      }
    }
    db.prepare(`
      UPDATE inbound_intents SET submission_id = ? WHERE source_type = ? AND source_id = ?
    `).run(submissionId, sourceType, sourceId);
    assertExecutionTransition(execution.execution_status, "submitting");
    db.prepare("UPDATE objective_execution SET execution_status = 'submitting', updated_at_ms = ? WHERE objective_id = ?")
      .run(now, objectiveId);
    return {
      busy: false,
      duplicate: false,
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId))
    };
  });

  const acknowledgeTurnSubmission = db.transaction(({ submissionId, turnId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    if (submission.turn_id !== null) {
      if (submission.turn_id !== turnId) throw stateError("TURN_ACK_CONFLICT", "Turn acknowledgement conflicts with durable state.");
      return { duplicate: true, submission: mapSubmissionRow(submission) };
    }
    assertSubmissionTransition(submission.submission_state, "running");
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(submission.objective_id);
    assertExecutionTransition(execution?.execution_status, "running");
    db.prepare(`
      UPDATE turn_submissions
      SET turn_id = ?, submission_state = 'running', reconciliation_required = 0, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(turnId, now, submissionId);
    db.prepare("UPDATE objective_execution SET execution_status = 'running', updated_at_ms = ? WHERE objective_id = ?")
      .run(now, submission.objective_id);
    return {
      duplicate: false,
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId))
    };
  });

  const markSubmissionUnknown = db.transaction(({ submissionId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    assertSubmissionTransition(submission.submission_state, "submission_unknown");
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(submission.objective_id);
    assertExecutionTransition(execution?.execution_status, "submission_unknown");
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'submission_unknown', reconciliation_required = 1, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submissionId);
    db.prepare(`
      UPDATE objective_execution SET execution_status = 'submission_unknown', updated_at_ms = ? WHERE objective_id = ?
    `).run(now, submission.objective_id);
    return mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId));
  });

  const rollbackSubmissionUnknown = db.transaction(({ submissionId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    if (submission.submission_state !== "submission_unknown") {
      throw stateError("TURN_SUBMISSION_ROLLBACK_INVALID", "Cannot rollback: submission is not in unknown state.");
    }
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(submission.objective_id);
    assertSubmissionTransition(submission.submission_state, "intent", { mode: "reconciliation" });
    assertExecutionTransition(execution?.execution_status, "submitting", { mode: "reconciliation" });
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'intent', reconciliation_required = 0, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submissionId);
    db.prepare(`
      UPDATE objective_execution SET execution_status = 'submitting', updated_at_ms = ? WHERE objective_id = ?
    `).run(now, submission.objective_id);
    return mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId));
  });

  const markTurnReconciliationNeeded = db.transaction(({ objectiveId, turnId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare(`
      SELECT * FROM turn_submissions WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId);
    if (!submission || !["running", "submission_unknown", "reconciliation_needed"].includes(submission.submission_state)) {
      throw stateError("TURN_RECONCILIATION_INVALID", "Turn reconciliation state is invalid.");
    }
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(objectiveId);
    assertSubmissionTransition(submission.submission_state, "reconciliation_needed", { mode: "reconciliation" });
    assertExecutionTransition(execution?.execution_status, "reconciliation_needed", { mode: "reconciliation" });
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'reconciliation_needed', reconciliation_required = 1, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submission.submission_id);
    db.prepare(`
      UPDATE objective_execution SET execution_status = 'reconciliation_needed', updated_at_ms = ?
      WHERE objective_id = ?
    `).run(now, objectiveId);
    return readExecution(db, objectiveId);
  });

  const markBackendFailure = db.transaction(({ objectiveId, submissionId, uncertain }) => {
    const now = assertNow(nowProvider);
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    const status = uncertain ? "reconciliation_needed" : "backend_unavailable";
    const submissionState = uncertain ? "submission_unknown" : "terminal_error";
    if (!execution) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (submissionId) {
      const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
      if (!submission || submission.objective_id !== objectiveId) {
        throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
      }
      assertSubmissionTransition(submission.submission_state, submissionState);
      db.prepare(`
        UPDATE turn_submissions
        SET submission_state = ?, reconciliation_required = ?, updated_at_ms = ?
        WHERE submission_id = ?
      `).run(submissionState, uncertain ? 1 : 0, now, submissionId);
    }
    assertExecutionTransition(execution.execution_status, status);
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = ?, thread_start_uncertain = ?, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(status, uncertain ? 1 : 0, now, objectiveId);
    return readExecution(db, objectiveId);
  });

  const reconcileTurnSubmission = db.transaction(({ submissionId, turnId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    if (submission.turn_id !== null && submission.turn_id !== turnId) {
      throw stateError("TURN_ACK_CONFLICT", "Turn acknowledgement conflicts with durable state.");
    }
    if (submission.turn_id === turnId && submission.submission_state === "running") {
      return { duplicate: true, submission: mapSubmissionRow(submission) };
    }
    assertSubmissionTransition(submission.submission_state, "running", { mode: "reconciliation" });
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(submission.objective_id);
    assertExecutionTransition(execution?.execution_status, "running", { mode: "reconciliation" });
    db.prepare(`
      UPDATE turn_submissions
      SET turn_id = ?, submission_state = 'running', reconciliation_required = 0, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(turnId, now, submissionId);
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = 'running', thread_start_uncertain = 0, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(now, submission.objective_id);
    return {
      duplicate: false,
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId))
    };
  });

  const reconcileTerminalTurn = db.transaction(({
    objectiveId,
    submissionId,
    turnId,
    remoteStatus,
    sourceType,
    sourceId
  }) => {
    const localStatus = remoteStatus === "cancelled" ? "cancelled" : "terminal_error";
    const factJson = canonicalJson({
      kind: "terminal_reconciled",
      localStatus,
      remoteStatus,
      turnId
    });
    const existingFact = db.prepare(`
      SELECT * FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    if (existingFact) {
      if (existingFact.objective_id !== objectiveId ||
          existingFact.submission_id !== submissionId ||
          existingFact.fact_json !== factJson) {
        throw stateError("TURN_AUDIT_IDENTITY_CONFLICT", "Turn audit identity conflicts with durable state.");
      }
      return {
        duplicate: true,
        status: localStatus,
        submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId)),
        outbox: []
      };
    }

    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission || submission.objective_id !== objectiveId || submission.turn_id !== turnId) {
      throw stateError("TURN_RECONCILIATION_INVALID", "Turn reconciliation state is invalid.");
    }
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?")
      .get(objectiveId);
    assertSubmissionTransition(submission.submission_state, localStatus, { mode: "reconciliation" });
    assertExecutionTransition(execution?.execution_status, localStatus, { mode: "reconciliation" });

    const now = assertNow(nowProvider);
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, objective_id, thread_id, turn_id
      ) VALUES (?, ?, ?, ?, 1, ?, 'reconciliation', ?, ?, ?,
        (SELECT app_server_thread_id FROM objective_execution WHERE objective_id = ?), ?)
    `).run(
      eventRecordId,
      sourceType,
      sourceId,
      now,
      remoteStatus === "cancelled" ? "turn.cancelled" : "turn.failed",
      canonicalJson({ localStatus, remoteStatus }),
      canonicalJson({}),
      objectiveId,
      objectiveId,
      turnId
    );
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"),
      sourceType,
      sourceId,
      objectiveId,
      submissionId,
      factJson,
      now
    );

    const outbox = [];
    if (localStatus === "cancelled") {
      const semanticKey = `turn:${turnId}:cancelled`;
      const existingDelivery = db.prepare("SELECT delivery_id FROM zulip_outbox WHERE semantic_key = ?").get(semanticKey);
      if (!existingDelivery) {
        const objective = db.prepare("SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?").get(objectiveId);
        const deliveryId = assertId(idFactory, "delivery");
        db.prepare(`
          INSERT INTO zulip_outbox (
            delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
            target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms, event_record_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `).run(
          deliveryId,
          objectiveId,
          semanticKey,
          objective.next_outbox_sequence,
          canonicalJson({ content: "Turn cancelled.", kind: "turn_cancelled" }),
          submission.target_snapshot_json,
          now,
          now,
          eventRecordId
        );
        db.prepare(`
          UPDATE objectives SET next_outbox_sequence = next_outbox_sequence + 1, updated_at_ms = ?
          WHERE objective_id = ?
        `).run(now, objectiveId);
        outbox.push({ deliveryId, semanticKey, objectiveSequence: objective.next_outbox_sequence });
      }
    }

    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = ?, terminal_status = ?, reconciliation_required = 0,
          lease_owner = '', updated_at_ms = ?
      WHERE submission_id = ?
    `).run(localStatus, localStatus, now, submissionId);
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = ?, thread_start_uncertain = 0, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(localStatus, now, objectiveId);
    return {
      duplicate: false,
      status: localStatus,
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId)),
      outbox
    };
  });

  const completeTurn = db.transaction(({ objectiveId, turnId, rawText, itemIds, sourceType, sourceId, renderer }) => {
    const existingOutput = db.prepare(`
      SELECT * FROM turn_outputs WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId);
    if (existingOutput) {
      return { duplicate: true, status: "completed", output: mapTurnOutputRow(existingOutput), outbox: [] };
    }

    const existingCompletionSource = db.prepare(`
      SELECT 1 FROM event_journal WHERE source_type = ? AND source_id = ?
      UNION ALL
      SELECT 1 FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
      LIMIT 1
    `).get(sourceType, sourceId, sourceType, sourceId);
    if (existingCompletionSource) {
      throw stateError(
        "TURN_COMPLETION_SOURCE_CONFLICT",
        "Turn completion source identity conflicts with durable state."
      );
    }

    const now = assertNow(nowProvider);
    const submission = db.prepare(`
      SELECT * FROM turn_submissions WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");

    const artifactRows = db.prepare(`
      SELECT * FROM artifact_contracts WHERE submission_id = ? ORDER BY direction, artifact_id
    `).all(submission.submission_id).map(mapArtifactRow);
    const verifiedInputs = verifyInputArtifactRows(
      artifactRows.filter((artifact) => artifact.direction === "input")
    );
    const verifiedOutputs = verifyOutputArtifactRows(
      artifactRows.filter((artifact) => artifact.direction === "output")
    );

    const mode = sourceType === "reconciliation" ? "reconciliation" : "normal";
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    const updateArtifact = db.prepare(`
      UPDATE artifact_contracts
      SET observed_sha256 = ?, observed_bytes = ?, state = ?, updated_at_ms = ?
      WHERE submission_id = ? AND direction = 'output' AND artifact_id = ?
    `);
    for (const artifact of verifiedOutputs.rows) {
      updateArtifact.run(
        artifact.observedSha256,
        artifact.observedBytes,
        artifact.state,
        now,
        submission.submission_id,
        artifact.artifactId
      );
    }
    const artifactFailures = [...verifiedInputs.failures, ...verifiedOutputs.failures];
    if (artifactFailures.length > 0) {
      const failureCode = artifactFailures[0].failureCode ?? (
        artifactFailures[0].path.startsWith(".hco/exchanges/v1/") &&
        artifactFailures[0].direction === "output" && artifactFailures[0].state === "missing"
          ? "PROJECT_LOCAL_OUTPUT_MISSING"
          : "ARTIFACT_VALIDATION_FAILED"
      );
      updateProjectLocalExchangeStatus(artifactRows, { state: "ERROR", errorCode: failureCode, now: () => now });
      assertSubmissionTransition(submission.submission_state, "reconciliation_needed", { mode: "reconciliation" });
      assertExecutionTransition(execution?.execution_status, "reconciliation_needed", { mode: "reconciliation" });
      db.prepare(`
        UPDATE turn_submissions
        SET submission_state = 'reconciliation_needed', reconciliation_required = 1, updated_at_ms = ?
        WHERE submission_id = ?
      `).run(now, submission.submission_id);
      db.prepare(`
        UPDATE objective_execution SET execution_status = 'reconciliation_needed', updated_at_ms = ?
        WHERE objective_id = ?
      `).run(now, objectiveId);

      const auditSourceType = "artifact-validation";
      const auditSourceId = submission.submission_id;
      const existingAudit = db.prepare(`
        SELECT 1 FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
      `).get(auditSourceType, auditSourceId);
      if (!existingAudit) {
        db.prepare(`
          INSERT INTO turn_audit_facts (
            fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          assertId(idFactory, "turn-audit-fact"),
          auditSourceType,
          auditSourceId,
          objectiveId,
          submission.submission_id,
          canonicalJson({
            kind: verifiedInputs.ok ? "artifact_output_validation_failed" : "artifact_input_validation_failed",
            turnId,
            failures: artifactFailures.map((artifact) => ({
              artifactId: artifact.artifactId,
              direction: artifact.direction,
              path: artifact.path,
              state: artifact.state,
              ...(artifact.failureCode ? { failureCode: artifact.failureCode } : {})
            }))
          }),
          now
        );
      }
      return {
        duplicate: false,
        status: "reconciliation_needed",
        errorCode: failureCode,
        output: null,
        outbox: []
      };
    }

    assertSubmissionTransition(submission.submission_state, "completed", { mode });
    assertExecutionTransition(execution?.execution_status, "completed", { mode });

    const completedManifestRows = db.prepare(`
      SELECT * FROM artifact_contracts WHERE submission_id = ? ORDER BY direction, artifact_id
    `).all(submission.submission_id).map(mapArtifactRow);
    const artifactManifest = manifestFromRows(completedManifestRows);

    db.prepare(`
      INSERT INTO turn_outputs (
        submission_id, objective_id, turn_id, raw_text, selected_item_ids_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(submission.submission_id, objectiveId, turnId, rawText, JSON.stringify(itemIds), now);

    const renderedText = appendArtifactSummary(rawText, artifactManifest);
    const submissionIntent = db.prepare(`
      SELECT source_type, source_id FROM inbound_intents WHERE submission_id = ?
    `).get(submission.submission_id);
    let coordinationCall = submissionIntent?.source_type === "coordination-call"
      ? db.prepare(`
          SELECT * FROM codex_calls WHERE codex_call_id = ? AND objective_id = ?
        `).get(submissionIntent.source_id, objectiveId)
      : null;
    if (coordinationCall?.turn_id && coordinationCall.turn_id !== turnId) {
      throw stateError("CODEX_CALL_TURN_MISMATCH", "Codex call is already bound to another turn.");
    }
    coordinationCall ??= db.prepare(`
      SELECT * FROM codex_calls WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId);
    if (!coordinationCall) {
      const candidates = db.prepare(`
        SELECT * FROM codex_calls
        WHERE objective_id = ? AND turn_id IS NULL
          AND state IN ('CREATED', 'SUBMITTING', 'RUNNING', 'WAITING_INTERACTION', 'STATUS_UNVERIFIED')
        ORDER BY created_at_ms, codex_call_id LIMIT 2
      `).all(objectiveId);
      coordinationCall = candidates.length === 1 ? candidates[0] : null;
    }
    if (coordinationCall?.turn_id === null) {
      db.prepare("UPDATE codex_calls SET turn_id = ?, updated_at_ms = ? WHERE codex_call_id = ?")
        .run(turnId, now, coordinationCall.codex_call_id);
      coordinationCall = { ...coordinationCall, turn_id: turnId, updated_at_ms: now };
    }
    const mailboxRouted = coordinationCall && coordinationCall.report_target_kind !== "ZULIP";
    const chunks = mailboxRouted
      ? []
      : validateRenderedChunks(renderer({ objectiveId, text: renderedText }));
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, objective_id, thread_id, turn_id
      ) VALUES (?, ?, ?, ?, 1, 'turn.completed', ?, ?, ?, ?,
        (SELECT app_server_thread_id FROM objective_execution WHERE objective_id = ?), ?)
    `).run(
      eventRecordId, sourceType, sourceId, now, mode,
      canonicalJson({ itemIds, status: "completed" }), canonicalJson({}), objectiveId, objectiveId, turnId
    );
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"), sourceType, sourceId, objectiveId,
      submission.submission_id, canonicalJson({ itemIds, status: "completed", turnId }), now
    );

    if (coordinationCall) {
      db.prepare(`
        UPDATE codex_calls
        SET state = 'COMPLETED', receipt_json = ?, updated_at_ms = ?, terminal_at_ms = ?
        WHERE codex_call_id = ? AND state NOT IN ('CANCELLED', 'FAILED')
      `).run(
        canonicalJson({
          schemaVersion: 1,
          status: "completed",
          objectiveId,
          turnId,
          itemIds,
          text: rawText,
          artifacts: artifactManifest
        }),
        now,
        now,
        coordinationCall.codex_call_id
      );
      db.prepare(`
        UPDATE codex_conversations
        SET state = 'READY', updated_at_ms = ?
        WHERE codex_conversation_id = ?
      `).run(now, coordinationCall.codex_conversation_id);
      db.prepare(`
        UPDATE work_requests
        SET state = 'RUNNING', status_reason = 'codex_receipt_pending_review', updated_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(now, coordinationCall.work_request_id);
      if (mailboxRouted) {
        const targetKind = coordinationCall.report_target_kind === "AGENT_MAILBOX" ? "AGENT" : "JARVIS";
        db.prepare(`
          INSERT INTO coordination_mailbox (
            mailbox_item_id, target_kind, target_id, work_request_id, codex_call_id,
            item_type, semantic_key, payload_json, state, attempt_count, lease_owner,
            lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms, acknowledged_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'CODEX_RECEIPT', ?, ?, 'PENDING', 0,
            NULL, NULL, NULL, ?, ?, NULL)
          ON CONFLICT(semantic_key) DO NOTHING
        `).run(
          assertId(idFactory, "mailbox-item"),
          targetKind,
          coordinationCall.report_target_id,
          coordinationCall.work_request_id,
          coordinationCall.codex_call_id,
          `codex-receipt:${coordinationCall.codex_call_id}:${turnId}`,
          canonicalJson({
            schemaVersion: 1,
            kind: "CodexReceipt",
            codexCallId: coordinationCall.codex_call_id,
            codexConversationId: coordinationCall.codex_conversation_id,
            workRequestId: coordinationCall.work_request_id,
            topicContextId: coordinationCall.topic_context_id,
            projectId: coordinationCall.project_id,
            contextRevision: coordinationCall.context_revision,
            status: "completed",
            objectiveId,
            turnId,
            itemIds,
            text: rawText,
            artifacts: artifactManifest
          }),
          now,
          now
        );
      }
    }

    const objective = db.prepare(`
      SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?
    `).get(objectiveId);
    let sequence = objective.next_outbox_sequence;
    const outbox = [];
    for (const chunk of chunks) {
      const deliveryId = assertId(idFactory, "delivery");
      db.prepare(`
        INSERT INTO zulip_outbox (
          delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
          target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms, event_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        deliveryId,
        objectiveId,
        chunk.semanticKey,
        sequence,
        canonicalJson(artifactManifest ? { ...chunk, artifacts: artifactManifest } : chunk),
        submission.target_snapshot_json, now, now, eventRecordId
      );
      outbox.push({ deliveryId, semanticKey: chunk.semanticKey, objectiveSequence: sequence });
      sequence += 1;
    }

    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'completed', terminal_status = 'completed', reconciliation_required = 0,
          lease_owner = '', updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submission.submission_id);
    db.prepare(`
      UPDATE objective_execution SET execution_status = 'completed', updated_at_ms = ? WHERE objective_id = ?
    `).run(now, objectiveId);
    db.prepare(`
      UPDATE objectives
      SET state = 'completed', state_rank = 2, next_outbox_sequence = ?, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(sequence, now, objectiveId);
    updateProjectLocalExchangeStatus(completedManifestRows, { state: "AVAILABLE", now: () => now });
    return {
      duplicate: false,
      status: "completed",
      output: mapTurnOutputRow(db.prepare(`
        SELECT * FROM turn_outputs WHERE objective_id = ? AND turn_id = ?
      `).get(objectiveId, turnId)),
      outbox
    };
  });

  const requestCancellation = db.transaction(({ objectiveId, sourceType, sourceId }) => {
    const now = assertNow(nowProvider);
    const existingFact = db.prepare(`
      SELECT * FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    const submission = db.prepare(`
      SELECT * FROM turn_submissions WHERE objective_id = ? ORDER BY created_at_ms DESC LIMIT 1
    `).get(objectiveId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    if (existingFact) {
      if (existingFact.objective_id !== objectiveId || JSON.parse(existingFact.fact_json).kind !== "cancellation_requested") {
        throw stateError("TURN_AUDIT_IDENTITY_CONFLICT", "Turn audit identity conflicts with durable state.");
      }
      return {
        duplicate: true,
        confirmed: submission.submission_state === "cancelled",
        submission: mapSubmissionRow(submission)
      };
    }
    if (submission.submission_state === "cancelled") {
      return { duplicate: true, confirmed: true, submission: mapSubmissionRow(submission) };
    }
    if (submission.submission_state !== "running" || !requireText(submission.turn_id)) {
      throw stateError("TURN_CANCELLATION_INVALID", "Turn cannot be cancelled in its current state.");
    }
    db.prepare(`
      UPDATE turn_submissions SET cancellation_requested = 1, updated_at_ms = ? WHERE submission_id = ?
    `).run(now, submission.submission_id);
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertId(idFactory, "turn-audit-fact"), sourceType, sourceId, objectiveId,
      submission.submission_id, canonicalJson({ kind: "cancellation_requested", turnId: submission.turn_id }), now
    );
    return {
      duplicate: false,
      confirmed: false,
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submission.submission_id))
    };
  });

  const confirmCancellation = db.transaction(({ objectiveId, submissionId, sourceType, sourceId }) => {
    const now = assertNow(nowProvider);
    const submission = db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission || submission.objective_id !== objectiveId || submission.cancellation_requested !== 1) {
      throw stateError("TURN_CANCELLATION_INVALID", "Turn cancellation confirmation is invalid.");
    }
    if (submission.submission_state === "cancelled") {
      return { duplicate: true, status: "cancelled", submission: mapSubmissionRow(submission), outbox: [] };
    }

    assertSubmissionTransition(submission.submission_state, "cancelled");
    const execution = db.prepare("SELECT execution_status FROM objective_execution WHERE objective_id = ?").get(objectiveId);
    assertExecutionTransition(execution?.execution_status, "cancelled");

    const semanticKey = `turn:${submission.turn_id}:cancelled`;
    const existingDelivery = db.prepare("SELECT delivery_id FROM zulip_outbox WHERE semantic_key = ?").get(semanticKey);
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, objective_id, thread_id, turn_id
      ) VALUES (?, ?, ?, ?, 1, 'turn.cancelled', 'normal', ?, ?, ?,
        (SELECT app_server_thread_id FROM objective_execution WHERE objective_id = ?), ?)
    `).run(
      eventRecordId, sourceType, sourceId, now,
      canonicalJson({ status: "cancelled" }), canonicalJson({}), objectiveId, objectiveId, submission.turn_id
    );

    const outbox = [];
    if (!existingDelivery) {
      const objective = db.prepare("SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?").get(objectiveId);
      const deliveryId = assertId(idFactory, "delivery");
      db.prepare(`
        INSERT INTO zulip_outbox (
          delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
          target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms, event_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        deliveryId, objectiveId, semanticKey, objective.next_outbox_sequence,
        canonicalJson({ content: "Turn cancelled.", kind: "turn_cancelled" }),
        submission.target_snapshot_json, now, now, eventRecordId
      );
      db.prepare(`
        UPDATE objectives SET next_outbox_sequence = next_outbox_sequence + 1, updated_at_ms = ?
        WHERE objective_id = ?
      `).run(now, objectiveId);
      outbox.push({ deliveryId, semanticKey, objectiveSequence: objective.next_outbox_sequence });
    }
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'cancelled', terminal_status = 'cancelled', reconciliation_required = 0, updated_at_ms = ?
      WHERE submission_id = ?
    `).run(now, submissionId);
    db.prepare(`
      UPDATE objective_execution SET execution_status = 'cancelled', updated_at_ms = ? WHERE objective_id = ?
    `).run(now, objectiveId);
    return {
      duplicate: false,
      status: "cancelled",
      submission: mapSubmissionRow(db.prepare("SELECT * FROM turn_submissions WHERE submission_id = ?").get(submissionId)),
      outbox
    };
  });

  const recordTurnAuditFact = db.transaction(({ objectiveId, turnId, sourceType, sourceId, fact }) => {
    const factJson = canonicalJson(fact);
    const existing = db.prepare(`
      SELECT * FROM turn_audit_facts WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    if (existing) {
      if (existing.objective_id !== objectiveId || existing.fact_json !== factJson) {
        throw stateError("TURN_AUDIT_IDENTITY_CONFLICT", "Turn audit identity conflicts with durable state.");
      }
      return { duplicate: true, fact: mapAuditFactRow(existing) };
    }
    const submission = db.prepare(`
      SELECT * FROM turn_submissions WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId);
    if (!submission) throw stateError("TURN_SUBMISSION_NOT_FOUND", "Turn submission does not exist.");
    const now = assertNow(nowProvider);
    const factId = assertId(idFactory, "turn-audit-fact");
    db.prepare(`
      INSERT INTO turn_audit_facts (
        fact_id, source_type, source_id, objective_id, submission_id, fact_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(factId, sourceType, sourceId, objectiveId, submission.submission_id, factJson, now);
    return {
      duplicate: false,
      fact: mapAuditFactRow(db.prepare("SELECT * FROM turn_audit_facts WHERE fact_id = ?").get(factId))
    };
  });

  const createInteraction = db.transaction((options) => {
    const now = assertNow(nowProvider);
    const wireId = encodeWireRequestId(options.wireRequestId);
    const correlationKey = interactionCorrelationKey(options);
    const requestJson = canonicalJson(options.request, { maximumBytes: MAX_INTERACTION_JSON_BYTES });
    const responderIdsJson = JSON.stringify(options.allowedResponderIds);
    const targetSnapshotJson = canonicalJson(options.targetSnapshot);
    const existing = db.prepare("SELECT * FROM pending_interactions WHERE correlation_key = ?").get(correlationKey);
    if (existing) {
      if (existing.connection_id !== options.connectionId || existing.wire_id_type !== wireId.type ||
          existing.wire_id_json !== wireId.text || existing.request_json !== requestJson ||
          existing.allowed_responder_ids_json !== responderIdsJson ||
          existing.target_snapshot_json !== targetSnapshotJson) {
        throw stateError("INTERACTION_IDENTITY_CONFLICT", "Interaction identity conflicts with durable state.");
      }
      return { duplicate: true, interaction: mapInteractionWithActions(db, existing), outbox: [] };
    }
    const wireMatch = db.prepare(`
      SELECT interaction_id FROM pending_interactions
      WHERE connection_id = ? AND wire_id_type = ? AND wire_id_json = ?
    `).get(options.connectionId, wireId.type, wireId.text);
    if (wireMatch) {
      throw stateError("INTERACTION_IDENTITY_CONFLICT", "Interaction identity conflicts with durable state.");
    }

    const execution = db.prepare("SELECT * FROM objective_execution WHERE objective_id = ?").get(options.objectiveId);
    const submission = db.prepare(`
      SELECT * FROM turn_submissions WHERE objective_id = ? AND turn_id = ?
    `).get(options.objectiveId, options.turnId);
    if (!execution || execution.backend !== "app-server" || execution.app_server_thread_id !== options.threadId || !submission) {
      throw stateError("INTERACTION_CORRELATION_INVALID", "Interaction correlation is invalid.");
    }

    const interactionId = assertId(idFactory, "interaction");
    const expiresAt = now + INTERACTION_TTL_MS;
    db.prepare(`
      INSERT INTO pending_interactions (
        interaction_id, connection_id, wire_id_type, wire_id_json, method, objective_id,
        thread_id, turn_id, item_id, approval_id, correlation_key, request_json,
        allowed_responder_ids_json, target_snapshot_json, expires_at_ms, state,
        answer_json, answered_by_id, answered_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
    `).run(
      interactionId, options.connectionId, wireId.type, wireId.text, options.method,
      options.objectiveId, options.threadId, options.turnId, options.itemId ?? null,
      options.approvalId ?? null, correlationKey, requestJson, responderIdsJson,
      targetSnapshotJson, expiresAt, now, now
    );

    const actionSpecs = interactionActionSpecs(options.method, options.request);
    const insertAction = db.prepare(`
      INSERT INTO interaction_actions (
        interaction_id, action_id, source_key, action_class, label, style,
        answer_json, natural_alias_eligible, ordinal, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [ordinal, spec] of actionSpecs.entries()) {
      insertAction.run(
        interactionId,
        assertId(idFactory, "interaction-action"),
        spec.sourceKey,
        spec.actionClass,
        spec.label,
        spec.style,
        canonicalJson(spec.answer, { maximumBytes: MAX_INTERACTION_JSON_BYTES }),
        spec.naturalAliasEligible ? 1 : 0,
        ordinal,
        now
      );
    }
    const interaction = mapInteractionWithActions(
      db,
      db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId)
    );
    let coordinationCall = db.prepare(`
      SELECT * FROM codex_calls WHERE objective_id = ? AND turn_id = ?
    `).get(options.objectiveId, options.turnId);
    if (!coordinationCall) {
      coordinationCall = db.prepare(`
        SELECT * FROM codex_calls
        WHERE objective_id = ? AND turn_id IS NULL
          AND state IN ('CREATED', 'SUBMITTING', 'RUNNING', 'STATUS_UNVERIFIED')
        ORDER BY created_at_ms, codex_call_id LIMIT 1
      `).get(options.objectiveId);
      if (coordinationCall) {
        db.prepare("UPDATE codex_calls SET turn_id = ?, updated_at_ms = ? WHERE codex_call_id = ?")
          .run(options.turnId, now, coordinationCall.codex_call_id);
        coordinationCall = { ...coordinationCall, turn_id: options.turnId, updated_at_ms: now };
      }
    }
    if (coordinationCall) {
      db.prepare(`
        INSERT INTO interaction_coordination (
          interaction_id, work_request_id, topic_context_id, project_id,
          invocation_origin, caller_principal_id, agent_session_id,
          codex_conversation_id, codex_call_id, approver_set_id,
          authorization_context_id, policy_decision, interaction_target_kind,
          interaction_target_id, reply_token_sha256, context_revision, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'HUMAN_REQUIRED', ?, ?, ?, ?, ?)
      `).run(
        interactionId,
        coordinationCall.work_request_id,
        coordinationCall.topic_context_id,
        coordinationCall.project_id,
        coordinationCall.invocation_origin,
        coordinationCall.caller_principal_id,
        coordinationCall.agent_session_id,
        coordinationCall.codex_conversation_id,
        coordinationCall.codex_call_id,
        coordinationCall.authorization_context_id,
        coordinationCall.interaction_target_kind,
        coordinationCall.interaction_target_id,
        createHash("sha256").update(interactionId, "utf8").digest("hex"),
        coordinationCall.context_revision,
        now
      );
      db.prepare(`
        UPDATE codex_calls SET state = 'WAITING_INTERACTION', updated_at_ms = ?
        WHERE codex_call_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
      `).run(now, coordinationCall.codex_call_id);
      db.prepare(`
        UPDATE work_requests SET state = 'WAITING_HUMAN', status_reason = 'codex_interaction', updated_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(now, coordinationCall.work_request_id);
    }
    const rendered = validateInteractionRender(options.renderer({ interaction }));
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, objective_id, thread_id, turn_id, item_id
      ) VALUES (?, 'app-server-interaction', ?, ?, 1, 'interaction.requested', 'normal', ?, ?, ?, ?, ?, ?)
    `).run(
      eventRecordId, interactionId, now,
      canonicalJson({ interactionId, method: options.method }), canonicalJson({}),
      options.objectiveId, options.threadId, options.turnId, options.itemId ?? null
    );
    const objective = db.prepare("SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?")
      .get(options.objectiveId);
    const insertOutbox = db.prepare(`
      INSERT INTO zulip_outbox (
        delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
        target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms, event_record_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);
    const insertLink = db.prepare(`
      INSERT INTO interaction_delivery_links (
        delivery_id, interaction_id, role, chunk_index, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const outbox = [];
    let actionPromptDeliveryId = null;
    for (const [offset, delivery] of rendered.deliveries.entries()) {
      const deliveryId = assertId(idFactory, "delivery");
      const sequence = objective.next_outbox_sequence + offset;
      insertOutbox.run(
        deliveryId, options.objectiveId, delivery.semanticKey, sequence,
        canonicalJson(delivery.payload, { maximumBytes: MAX_INTERACTION_JSON_BYTES }), targetSnapshotJson, now, now, eventRecordId
      );
      insertLink.run(deliveryId, interactionId, delivery.role, delivery.chunkIndex, now);
      if (delivery.role === "action_prompt") actionPromptDeliveryId = deliveryId;
      outbox.push({ deliveryId, semanticKey: delivery.semanticKey, objectiveSequence: sequence });
    }
    db.prepare(`
      UPDATE objectives SET next_outbox_sequence = next_outbox_sequence + ?, updated_at_ms = ?
      WHERE objective_id = ?
    `).run(rendered.deliveries.length, now, options.objectiveId);
    const detailChunks = rendered.deliveries.filter((delivery) => delivery.role === "detail").length;
    const detailState = detailChunks > 0 ? "detail_pending" : "not_required";
    db.prepare(`
      INSERT INTO interaction_details (
        interaction_id, mode, content_sha256, content_bytes, chunk_count, document_id,
        detail_state, delivered_at_ms, action_prompt_delivery_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    `).run(
      interactionId,
      rendered.detail.mode,
      rendered.detail.contentSha256,
      rendered.detail.contentBytes,
      detailChunks,
      detailState,
      actionPromptDeliveryId,
      now
    );
    return {
      duplicate: false,
      interaction,
      outbox
    };
  });

  const commitInteractionAnswer = db.transaction(({ interactionId, responderId, targetSnapshot, answer, audit = null }) => {
    const row = db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId);
    if (!row) return { accepted: false, reason: "not_found", interaction: null };
    if (row.state === "orphaned") return { accepted: false, reason: "orphaned", interaction: mapInteractionRow(row) };
    if (row.state === "expired") return { accepted: false, reason: "expired", interaction: mapInteractionRow(row) };

    const responderIds = JSON.parse(row.allowed_responder_ids_json);
    if (!responderIds.includes(responderId)) {
      return { accepted: false, reason: "unauthorized", interaction: mapInteractionRow(row) };
    }
    if (row.target_snapshot_json !== canonicalJson(targetSnapshot)) {
      return { accepted: false, reason: "target_mismatch", interaction: mapInteractionRow(row) };
    }
    const answerJson = canonicalJson(answer, { maximumBytes: MAX_INTERACTION_JSON_BYTES });
    if (row.state === "answered") {
      return answerJson === row.answer_json
        ? { accepted: true, duplicate: true, interaction: mapInteractionRow(row) }
        : { accepted: false, reason: "conflict", interaction: mapInteractionRow(row) };
    }

    const now = assertNow(nowProvider);
    if (now >= row.expires_at_ms) {
      db.prepare(`
        UPDATE pending_interactions SET state = 'expired', updated_at_ms = ? WHERE interaction_id = ?
      `).run(now, interactionId);
      return {
        accepted: false,
        reason: "expired",
        interaction: mapInteractionRow(db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId))
      };
    }
    db.prepare(`
      UPDATE pending_interactions
      SET state = 'answered', answer_json = ?, answered_by_id = ?, answered_at_ms = ?,
          partial_answers_json = NULL, response_delivery_state = 'pending',
          response_delivery_updated_at_ms = ?, updated_at_ms = ?
      WHERE interaction_id = ?
    `).run(answerJson, String(responderId), now, now, now, interactionId);
    db.prepare(`
      INSERT INTO interaction_answer_settlements (
        interaction_id, answer_json, answered_by_id, answered_at_ms
      ) VALUES (?, ?, ?, ?)
    `).run(interactionId, answerJson, String(responderId), now);
    if (audit !== null) {
      const detail = db.prepare(`
        SELECT content_sha256 FROM interaction_details WHERE interaction_id = ?
      `).get(interactionId);
      db.prepare(`
        INSERT INTO interaction_settlement_audit (
          interaction_id, action_id, action_class, resolution_source, source_type,
          source_message_id, detail_sha256, responder_id, settled_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        interactionId,
        audit.actionId ?? null,
        audit.actionClass ?? null,
        audit.resolutionSource,
        audit.sourceType,
        audit.sourceMessageId,
        detail?.content_sha256 ?? createHash("sha256").update("", "utf8").digest("hex"),
        responderId,
        now
      );
    }
    const prompt = db.prepare(`
      SELECT outbox.acknowledged_zulip_message_id, outbox.event_record_id
      FROM interaction_delivery_links AS link
      JOIN zulip_outbox AS outbox USING (delivery_id)
      WHERE link.interaction_id = ? AND link.role = 'action_prompt'
    `).get(interactionId);
    if (prompt?.acknowledged_zulip_message_id) {
      const semanticKey = `interaction:${interactionId}:prompt:delete`;
      const objective = db.prepare(`
        SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?
      `).get(row.objective_id);
      const deliveryId = assertId(idFactory, "delivery");
      db.prepare(`
        INSERT INTO zulip_outbox (
          delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
          target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms, event_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        deliveryId,
        row.objective_id,
        semanticKey,
        objective.next_outbox_sequence,
        canonicalJson({
          schemaVersion: 2,
          kind: "interaction_prompt_delete",
          zulipMessageId: prompt.acknowledged_zulip_message_id
        }),
        row.target_snapshot_json,
        now,
        now,
        prompt.event_record_id
      );
      db.prepare(`
        UPDATE objectives SET next_outbox_sequence = next_outbox_sequence + 1, updated_at_ms = ?
        WHERE objective_id = ?
      `).run(now, row.objective_id);
    }
    return {
      accepted: true,
      duplicate: false,
      interaction: mapInteractionRow(db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId))
    };
  });

  const persistInteractionPartialAnswers = db.transaction(({ interactionId, partialAnswers }) => {
    const row = db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId);
    if (!row) throw stateError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
    if (row.state !== "pending") {
      throw stateError("INTERACTION_ANSWER_CONFLICT", "Interaction is no longer pending.");
    }
    const now = assertNow(nowProvider);
    if (now >= row.expires_at_ms) {
      db.prepare(`
        UPDATE pending_interactions SET state = 'expired', updated_at_ms = ? WHERE interaction_id = ?
      `).run(now, interactionId);
      throw stateError("INTERACTION_EXPIRED", "Interaction has expired.");
    }
    db.prepare(`
      UPDATE pending_interactions SET partial_answers_json = ?, updated_at_ms = ? WHERE interaction_id = ?
    `).run(canonicalJson(partialAnswers), now, interactionId);
    return mapInteractionRow(db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId));
  });

  function recordInteractionStatusUnverified(row, reason, currentTime) {
    const coordination = db.prepare(`
      SELECT coordination.*, call.report_target_kind, call.report_target_id,
        call.state AS call_state
      FROM interaction_coordination AS coordination
      JOIN codex_calls AS call USING (codex_call_id)
      WHERE coordination.interaction_id = ?
    `).get(row.interaction_id);
    if (!coordination) return { notified: false, targetKind: null };

    db.prepare(`
      UPDATE codex_calls SET state = 'STATUS_UNVERIFIED', updated_at_ms = ?
      WHERE codex_call_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
    `).run(currentTime, coordination.codex_call_id);
    db.prepare(`
      UPDATE work_requests
      SET state = 'STATUS_UNVERIFIED', status_reason = ?, updated_at_ms = ?
      WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
    `).run(reason, currentTime, coordination.work_request_id);

    const semanticKey = `interaction-status:${row.interaction_id}`;
    const payload = {
      schemaVersion: 1,
      kind: "InteractionStatusNotice",
      workRequestId: coordination.work_request_id,
      codexCallId: coordination.codex_call_id,
      interactionId: row.interaction_id,
      status: "STATUS_UNVERIFIED",
      reason,
      answerState: row.state === "answered" ? "settled_outcome_unverified" : "not_settled",
      nextAction: "caller_reconcile"
    };
    const payloadJson = canonicalJson(payload);
    let targetKind = null;
    let targetId = coordination.report_target_id;
    let notificationState = "QUEUED";

    if (coordination.report_target_kind === "ZULIP") {
      const event = db.prepare(`
        SELECT outbox.event_record_id
        FROM interaction_delivery_links AS link
        JOIN zulip_outbox AS outbox USING (delivery_id)
        WHERE link.interaction_id = ?
        ORDER BY CASE link.role WHEN 'action_prompt' THEN 0 ELSE 1 END, outbox.objective_sequence
        LIMIT 1
      `).get(row.interaction_id);
      const objective = db.prepare(`
        SELECT next_outbox_sequence FROM objectives WHERE objective_id = ?
      `).get(row.objective_id);
      if (event && objective) {
        const existing = db.prepare("SELECT delivery_id FROM zulip_outbox WHERE semantic_key = ?")
          .get(semanticKey);
        if (!existing) {
          db.prepare(`
            INSERT INTO zulip_outbox (
              delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
              target_snapshot_json, state, attempt_count, created_at_ms, updated_at_ms,
              event_record_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
          `).run(
            assertId(idFactory, "delivery"), row.objective_id, semanticKey,
            objective.next_outbox_sequence,
            canonicalJson({
              schemaVersion: 1,
              kind: "interaction_status_notice",
              content: "Codex could not verify the approval handoff outcome. The answer was not resent; caller reconciliation is required."
            }),
            row.target_snapshot_json,
            currentTime,
            currentTime,
            event.event_record_id
          );
          db.prepare(`
            UPDATE objectives SET next_outbox_sequence = next_outbox_sequence + 1, updated_at_ms = ?
            WHERE objective_id = ?
          `).run(currentTime, row.objective_id);
        }
        targetKind = "ZULIP";
      }
    } else if (["JARVIS_MAILBOX", "AGENT_MAILBOX"].includes(coordination.report_target_kind)) {
      targetKind = coordination.report_target_kind === "AGENT_MAILBOX" ? "AGENT" : "JARVIS";
      db.prepare(`
        INSERT INTO coordination_mailbox (
          mailbox_item_id, target_kind, target_id, work_request_id, codex_call_id,
          item_type, semantic_key, payload_json, state, attempt_count, lease_owner,
          lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms,
          acknowledged_at_ms, last_error
        ) VALUES (?, ?, ?, ?, ?, 'STATUS_NOTICE', ?, ?, 'PENDING', 0,
          NULL, NULL, NULL, ?, ?, NULL, NULL)
        ON CONFLICT(semantic_key) DO NOTHING
      `).run(
        assertId(idFactory, "mailbox-item"), targetKind, targetId,
        coordination.work_request_id, coordination.codex_call_id,
        semanticKey, payloadJson, currentTime, currentTime
      );
    }

    if (targetKind === null) {
      targetKind = "OPERATOR";
      targetId = coordination.project_id;
      notificationState = "FAILED";
      db.prepare(`
        UPDATE work_requests
        SET state = 'DEGRADED_PENDING_OPERATOR', status_reason = 'interaction_status_notice_unroutable',
          updated_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(currentTime, coordination.work_request_id);
    }
    db.prepare(`
      INSERT INTO notification_ledger (
        notification_id, work_request_id, semantic_key, target_kind, target_id,
        event_class, payload_sha256, state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'INTERACTION_STATUS_UNVERIFIED', ?, ?, ?, ?)
      ON CONFLICT(semantic_key) DO NOTHING
    `).run(
      assertId(idFactory, "notification"), coordination.work_request_id,
      `notification:${semanticKey}`, targetKind, targetId,
      createHash("sha256").update(payloadJson, "utf8").digest("hex"),
      notificationState, currentTime, currentTime
    );
    return { notified: notificationState === "QUEUED", targetKind };
  }

  const recordInteractionResponseDelivery = db.transaction(({ interactionId, leaseToken, state }) => {
    const row = db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId);
    if (!row || row.state !== "answered") {
      throw stateError("INTERACTION_RESPONSE_STATE_INVALID", "Interaction response delivery state is invalid.");
    }
    const allowed = {
      pending: new Set(["retryable", "uncertain", "delivered"]),
      retryable: new Set(["retryable", "uncertain", "delivered"]),
      uncertain: new Set(["uncertain"]),
      delivered: new Set(["delivered"])
    };
    if (!allowed[row.response_delivery_state]?.has(state)) {
      throw stateError("INTERACTION_RESPONSE_STATE_INVALID", "Interaction response delivery state is invalid.");
    }
    const lease = db.prepare(`
      SELECT lease_token FROM resource_leases
      WHERE resource_type = 'interaction_response' AND resource_id = ?
    `).get(interactionId);
    if (!lease || lease.lease_token !== leaseToken) {
      throw stateError("INTERACTION_RESPONSE_LEASE_STALE", "Interaction response lease token is stale.");
    }
    const now = assertNow(nowProvider);
    db.prepare(`
      UPDATE pending_interactions
      SET response_delivery_state = ?, response_delivery_updated_at_ms = ?, updated_at_ms = ?
      WHERE interaction_id = ?
    `).run(state, now, now, interactionId);
    db.prepare(`
      DELETE FROM resource_leases WHERE resource_type = 'interaction_response' AND resource_id = ?
    `).run(interactionId);
    if (state === "uncertain") {
      recordInteractionStatusUnverified(row, "interaction_response_outcome_unverified", now);
    }
    if (state === "delivered") {
      const coordination = db.prepare(`
        SELECT * FROM interaction_coordination WHERE interaction_id = ?
      `).get(interactionId);
      if (coordination) {
        db.prepare(`
          UPDATE codex_calls SET state = 'RUNNING', updated_at_ms = ?
          WHERE codex_call_id = ? AND state = 'WAITING_INTERACTION'
        `).run(now, coordination.codex_call_id);
        db.prepare(`
          UPDATE work_requests SET state = 'WAITING_CODEX', status_reason = NULL, updated_at_ms = ?
          WHERE work_request_id = ? AND state = 'WAITING_HUMAN'
        `).run(now, coordination.work_request_id);
      }
    }
    return mapInteractionRow(db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId));
  });

  const claimInteractionResponse = db.transaction(({ interactionId, leaseOwner }) => {
    const now = assertNow(nowProvider);
    const row = db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId);
    if (!row || row.state !== "answered") {
      throw stateError("INTERACTION_RESPONSE_STATE_INVALID", "Interaction response delivery state is invalid.");
    }
    if (row.response_delivery_state === "delivered" || row.response_delivery_state === "uncertain") {
      return { acquired: false, state: row.response_delivery_state, interaction: mapInteractionRow(row) };
    }
    const existing = db.prepare(`
      SELECT * FROM resource_leases WHERE resource_type = 'interaction_response' AND resource_id = ?
    `).get(interactionId);
    if (existing) {
      if (existing.expires_at_ms <= now) {
        db.prepare(`
          UPDATE pending_interactions
          SET response_delivery_state = 'uncertain', response_delivery_updated_at_ms = ?, updated_at_ms = ?
          WHERE interaction_id = ?
        `).run(now, now, interactionId);
        db.prepare(`
          DELETE FROM resource_leases WHERE resource_type = 'interaction_response' AND resource_id = ?
        `).run(interactionId);
        recordInteractionStatusUnverified(row, "interaction_response_lease_expired", now);
        return {
          acquired: false,
          state: "uncertain",
          interaction: mapInteractionRow(db.prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?").get(interactionId))
        };
      }
      return { acquired: false, state: "in_progress", interaction: mapInteractionRow(row) };
    }
    const leaseToken = assertId(idFactory, "interaction-response-lease");
    db.prepare(`
      INSERT INTO resource_leases (
        resource_type, resource_id, lease_owner, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES ('interaction_response', ?, ?, ?, ?, ?)
    `).run(interactionId, leaseOwner, leaseToken, now, now + INTERACTION_RESPONSE_LEASE_MS);
    return { acquired: true, state: row.response_delivery_state, leaseToken, interaction: mapInteractionRow(row) };
  });

  const deleteOrphanedInteractionResponseLeases = db.prepare(`
    DELETE FROM resource_leases
    WHERE resource_type = 'interaction_response'
      AND resource_id IN (
        SELECT interaction_id
        FROM pending_interactions
        WHERE connection_id = ? AND state = 'orphaned'
      )
  `);

  const orphanInteractions = db.transaction(({ connectionId }) => {
    const now = assertNow(nowProvider);
    const candidates = db.prepare(`
      SELECT * FROM pending_interactions
      WHERE connection_id = ?
        AND (
          state = 'pending'
          OR (state = 'answered' AND response_delivery_state IN ('pending', 'retryable', 'uncertain'))
        )
    `).all(connectionId);
    const result = db.prepare(`
      UPDATE pending_interactions
      SET state = 'orphaned', answer_json = NULL, partial_answers_json = NULL, answered_by_id = NULL,
          answered_at_ms = NULL, updated_at_ms = ?
      WHERE connection_id = ?
        AND (
          state = 'pending'
          OR (state = 'answered' AND response_delivery_state IN ('pending', 'retryable', 'uncertain'))
        )
    `).run(now, connectionId);
    deleteOrphanedInteractionResponseLeases.run(connectionId);
    for (const candidate of candidates) {
      recordInteractionStatusUnverified(candidate, "interaction_orphaned", now);
    }
    return { connectionId, orphaned: result.changes };
  });

  const resolveNaturalInteraction = db.transaction(({ binding, intent, normalizedAlias }) => {
    const sourceType = "zulip-interaction-reply";
    const sourceId = String(binding.sourceMessageId);
    const existing = db.prepare(`
      SELECT event_name, payload_json FROM event_journal WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    if (existing) {
      if (existing.event_name !== "interaction.natural_reply_resolved") {
        throw stateError("INTERACTION_REPLY_SOURCE_CONFLICT", "Interaction reply source was already consumed.");
      }
      const payload = JSON.parse(existing.payload_json);
      if (payload.intent !== intent || payload.normalizedAlias !== normalizedAlias ||
          canonicalJson(payload.binding) !== canonicalJson(binding)) {
        throw stateError("INTERACTION_REPLY_SOURCE_CONFLICT", "Interaction reply source conflicts with durable state.");
      }
      return { ...payload.outcome, duplicate: true };
    }

    const now = assertNow(nowProvider);
    const candidates = [];
    {
      const allowedClasses = intent === "allow"
        ? new Set(["one_time_allow", "file_change_allow"])
        : new Set(["deny"]);
      const rows = db.prepare(`
        SELECT interaction.*, action.action_id, action.action_class, action.answer_json
          , action.source_key, action.ordinal
        FROM pending_interactions AS interaction
        JOIN interaction_actions AS action USING (interaction_id)
        JOIN interaction_details AS detail USING (interaction_id)
        WHERE interaction.state = 'pending' AND interaction.expires_at_ms > ?
          AND action.natural_alias_eligible = 1
          AND (detail.chunk_count = 0 OR detail.detail_state = 'delivered')
        ORDER BY interaction.created_at_ms, interaction.interaction_id, action.ordinal
      `).all(now);
      const matching = [];
      for (const row of rows) {
        const target = JSON.parse(row.target_snapshot_json);
        const responders = JSON.parse(row.allowed_responder_ids_json);
        if (allowedClasses.has(row.action_class) && target.platform === "zulip" &&
            target.streamId === binding.streamId && target.topic === binding.topic &&
            responders.includes(binding.senderId)) {
          matching.push({
            interactionId: row.interaction_id,
            actionId: row.action_id,
            actionClass: row.action_class,
            sourceKey: row.source_key,
            answer: JSON.parse(row.answer_json),
            objectiveId: row.objective_id,
            targetSnapshot: target
          });
        }
      }
      if (intent === "allow") {
        candidates.push(...matching);
      } else {
        const cancelAlias = normalizedAlias === "取消" || normalizedAlias === "cancel";
        const byInteraction = new Map();
        for (const candidate of matching) {
          const list = byInteraction.get(candidate.interactionId) ?? [];
          list.push(candidate);
          byInteraction.set(candidate.interactionId, list);
        }
        for (const actions of byInteraction.values()) {
          const preferredKeys = cancelAlias ? ["cancel", "decline", "deny"] : ["decline", "deny", "cancel"];
          const selected = preferredKeys
            .map((key) => actions.find((action) => action.sourceKey.toLowerCase() === key))
            .find(Boolean) ?? (actions.length === 1 ? actions[0] : null);
          if (selected) candidates.push(selected);
        }
      }
    }
    let outcome;
    if (candidates.length === 0) {
      outcome = { status: "not_applicable" };
    } else if (candidates.length > 1) {
      outcome = {
        status: "ambiguous",
        candidateInteractionIds: [...new Set(candidates.map(({ interactionId }) => interactionId))]
      };
    } else {
      outcome = { status: "selected", ...candidates[0] };
      const answerJson = canonicalJson(outcome.answer, { maximumBytes: MAX_INTERACTION_JSON_BYTES });
      const settled = db.prepare(`
        UPDATE pending_interactions
        SET state = 'answered', answer_json = ?, answered_by_id = ?, answered_at_ms = ?,
            partial_answers_json = NULL, response_delivery_state = 'pending',
            response_delivery_updated_at_ms = ?, updated_at_ms = ?
        WHERE interaction_id = ? AND state = 'pending'
      `).run(answerJson, String(binding.senderId), now, now, now, outcome.interactionId);
      if (settled.changes !== 1) {
        throw stateError("INTERACTION_ANSWER_CONFLICT", "Interaction is no longer pending.");
      }
      db.prepare(`
        INSERT INTO interaction_answer_settlements (
          interaction_id, answer_json, answered_by_id, answered_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(outcome.interactionId, answerJson, String(binding.senderId), now);
      const detail = db.prepare(`
        SELECT content_sha256 FROM interaction_details WHERE interaction_id = ?
      `).get(outcome.interactionId);
      db.prepare(`
        INSERT INTO interaction_settlement_audit (
          interaction_id, action_id, action_class, resolution_source, source_type,
          source_message_id, detail_sha256, responder_id, settled_at_ms
        ) VALUES (?, ?, ?, 'natural_alias', ?, ?, ?, ?, ?)
      `).run(
        outcome.interactionId,
        outcome.actionId,
        outcome.actionClass,
        sourceType,
        sourceId,
        detail.content_sha256,
        binding.senderId,
        now
      );
    }
    const eventRecordId = assertId(idFactory, "event");
    db.prepare(`
      INSERT INTO event_journal (
        event_record_id, source_type, source_id, received_at_ms, event_schema_version,
        event_name, event_mode, payload_json, integrity_json, objective_id
      ) VALUES (?, ?, ?, ?, 1, 'interaction.natural_reply_resolved', 'normal', ?, ?, ?)
    `).run(
      eventRecordId,
      sourceType,
      sourceId,
      now,
      canonicalJson({ binding, intent, normalizedAlias, outcome }),
      canonicalJson({}),
      outcome.objectiveId ?? null
    );
    return { ...outcome, duplicate: false };
  });

  const markConnectionLost = db.transaction(({ connectionId }) => {
    const now = assertNow(nowProvider);
    const interactionCandidates = db.prepare(`
      SELECT * FROM pending_interactions
      WHERE connection_id = ?
        AND (
          state = 'pending'
          OR (state = 'answered' AND response_delivery_state IN ('pending', 'retryable', 'uncertain'))
        )
    `).all(connectionId);
    const activeExecutions = db.prepare(`
      SELECT objective_id, execution_status FROM objective_execution
      WHERE backend = 'app-server'
        AND execution_status IN ('starting', 'submitting', 'running', 'submission_unknown', 'reconciliation_needed')
    `).all();
    const activeSubmissions = db.prepare(`
      SELECT submission_state FROM turn_submissions
      WHERE objective_id IN (
        SELECT objective_id FROM objective_execution
        WHERE backend = 'app-server'
          AND execution_status IN ('starting', 'submitting', 'running', 'submission_unknown', 'reconciliation_needed')
      )
        AND submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed')
    `).all();
    for (const submission of activeSubmissions) {
      assertSubmissionTransition(submission.submission_state, "reconciliation_needed", { mode: "reconciliation" });
    }
    for (const execution of activeExecutions) {
      assertExecutionTransition(execution.execution_status, "reconciliation_needed", { mode: "reconciliation" });
    }
    db.prepare(`
      UPDATE turn_submissions
      SET submission_state = 'reconciliation_needed', reconciliation_required = 1, updated_at_ms = ?
      WHERE objective_id IN (
        SELECT objective_id FROM objective_execution
        WHERE backend = 'app-server'
          AND execution_status IN ('starting', 'submitting', 'running', 'submission_unknown', 'reconciliation_needed')
      )
        AND submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed')
    `).run(now);
    db.prepare(`
      UPDATE objective_execution
      SET execution_status = 'reconciliation_needed', updated_at_ms = ?
      WHERE backend = 'app-server'
        AND execution_status IN ('starting', 'submitting', 'running', 'submission_unknown', 'reconciliation_needed')
    `).run(now);
    const orphaned = db.prepare(`
      UPDATE pending_interactions
      SET state = 'orphaned', answer_json = NULL, partial_answers_json = NULL, answered_by_id = NULL,
          answered_at_ms = NULL, updated_at_ms = ?
      WHERE connection_id = ?
        AND (
          state = 'pending'
          OR (state = 'answered' AND response_delivery_state IN ('pending', 'retryable', 'uncertain'))
        )
    `).run(now, connectionId).changes;
    deleteOrphanedInteractionResponseLeases.run(connectionId);
    for (const candidate of interactionCandidates) {
      recordInteractionStatusUnverified(candidate, "app_server_connection_lost", now);
    }
    return { affectedObjectives: activeExecutions.length, orphanedInteractions: orphaned };
  });

  return {
    applyRouteCommand,
    ackOutbox,
    acknowledgeTurnSubmission,
    bindBackendObjective,
    bumpControlGeneration,
    claimOutbox,
    claimInteractionResponse,
    completeTurn,
    commitInteractionAnswer,
    confirmCancellation,
    createInteraction,
    consume,
    ingest,
    markBackendFailure,
    markConnectionLost,
    markReplacementThreadStartUncertain,
    markSubmissionUnknown,
    markTurnReconciliationNeeded,
    nackOutbox,
    orphanInteractions,
    persistInteractionPartialAnswers,
    prepareTurnSubmission,
    recordInteractionResponseDelivery,
    recordTurnAuditFact,
    resolveNaturalInteraction,
    reconcileTerminalTurn,
    reconcileTurnSubmission,
    requestCancellation,
    registerExecutionIntent,
    replaceMissingObjectiveThread,
    resolveObjectiveThread,
    rollbackSubmissionUnknown,
    setUserTopicMode,
    syncStaticRegistry
  };
}

export function openStore({
  databasePath,
  now = Date.now,
  idFactory = (kind) => `${kind}-${randomUUID()}`,
  fileAttemptIdFactory,
  migrations = MIGRATIONS
} = {}) {
  if (!requireText(databasePath) || typeof now !== "function" || typeof idFactory !== "function" ||
      (fileAttemptIdFactory !== undefined && typeof fileAttemptIdFactory !== "function")) {
    throw stateError("STORE_OPTIONS_INVALID", "Store options are invalid.");
  }

  let db;
  try {
    if (databasePath !== ":memory:") secureStoreFiles(databasePath, { createDatabase: true });
    db = new Database(databasePath, { timeout: 5_000 });
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    applyMigrations(db, { migrations, now: () => assertNow(now) });
    if (databasePath !== ":memory:") secureStoreFiles(databasePath);
  } catch (error) {
    if (db?.open) {
      try {
        db.close();
      } catch {
        // Preserve the opening failure rather than replacing it with cleanup failure.
      }
    }
    if (isOwnedStoreError(error)) throw error;
    throw stateError("STORE_OPEN_FAILED", "Store could not be opened.");
  }

  const transactions = createTransactions(db, now, idFactory);
  const coordination = createCoordinationStore(db, { now, idFactory });
  const fileExchange = createManagedFileExchangeState(db, { now, idFactory, fileAttemptIdFactory });
  let closed = false;
  return Object.freeze({
    ...coordination,
    ...fileExchange,
    ingest(fact) {
      const validated = validateFact(fact);
      return transactions.ingest.immediate(validated);
    },
    claimOutbox(options) {
      if (
        options === null ||
        typeof options !== "object" ||
        !requireText(options.workerId) ||
        !Number.isSafeInteger(options.limit) ||
        options.limit <= 0 ||
        options.limit > MAX_CLAIM_LIMIT ||
        !Number.isSafeInteger(options.leaseMs) ||
        options.leaseMs <= 0 ||
        options.leaseMs > MAX_LEASE_MS
      ) {
        throw stateError("OUTBOX_CLAIM_INVALID", "Outbox claim options are invalid.");
      }
      return transactions.claimOutbox.immediate(options);
    },
    ackOutbox(options) {
      if (
        options === null ||
        typeof options !== "object" ||
        !requireText(options.deliveryId) ||
        !requireText(options.leaseToken) ||
        !Number.isSafeInteger(options.zulipMessageId) ||
        options.zulipMessageId <= 0
      ) {
        throw stateError("OUTBOX_ACK_INVALID", "Outbox acknowledgement is invalid.");
      }
      return transactions.ackOutbox.immediate(options);
    },
    nackOutbox(options) {
      if (
        options === null ||
        typeof options !== "object" ||
        !requireText(options.deliveryId) ||
        !requireText(options.leaseToken) ||
        !requireText(options.error) ||
        typeof options.retryable !== "boolean"
      ) {
        throw stateError("OUTBOX_NACK_INVALID", "Outbox rejection is invalid.");
      }
      return transactions.nackOutbox.immediate(options);
    },
    consume(options) {
      if (
        options === null ||
        typeof options !== "object" ||
        !requireText(options.nonce) ||
        !Number.isSafeInteger(options.expiresAt) ||
        options.expiresAt <= 0
      ) {
        return false;
      }
      return transactions.consume.immediate(options);
    },
    registerExecutionIntent(options) {
      assertControllerIntent(options);
      return transactions.registerExecutionIntent.immediate(options);
    },
    getRuntimeRoute(streamId) {
      if (!Number.isSafeInteger(streamId) || streamId <= 0) throw stateError("CONTROL_ROUTE_INVALID", "Runtime route is invalid.");
      const row = db.prepare("SELECT * FROM runtime_stream_routes WHERE stream_id = ?").get(streamId);
      return row ? Object.freeze({
        streamId: row.stream_id, kind: row.override_kind, projectId: row.project_id,
        actorUserId: row.actor_user_id, sourceType: row.source_type, sourceId: row.source_id, updatedAt: row.updated_at_ms
      }) : null;
    },
    listRuntimeRoutes() {
      return db.prepare("SELECT * FROM runtime_stream_routes ORDER BY stream_id").all().map((row) => Object.freeze({
        streamId: row.stream_id, kind: row.override_kind, projectId: row.project_id,
        actorUserId: row.actor_user_id, sourceType: row.source_type, sourceId: row.source_id, updatedAt: row.updated_at_ms
      }));
    },
    applyRouteCommand(options) {
      if (!isPlainObject(options) || Object.keys(options).some((key) => !["sourceType", "sourceId", "streamId", "action", "projectId", "actorUserId", "clearTopics"].includes(key)) ||
          !requireText(options.sourceType) || !requireText(options.sourceId) || !Number.isSafeInteger(options.streamId) || options.streamId <= 0 ||
          !["SET", "NONE", "UNSET"].includes(options.action) || !Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0 ||
          (options.clearTopics !== undefined && typeof options.clearTopics !== "boolean") ||
          (options.clearTopics === false && options.action !== "UNSET") ||
          (options.action === "SET" ? !requireText(options.projectId) || Buffer.byteLength(options.projectId, "utf8") > 64 : options.projectId !== undefined)) {
        throw stateError("CONTROL_ROUTE_INVALID", "Runtime route command is invalid.");
      }
      return transactions.applyRouteCommand.immediate({ ...options, clearTopics: options.clearTopics ?? true });
    },
    readTopicState(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "streamId,topic" ||
          !Number.isSafeInteger(options.streamId) || options.streamId <= 0 || typeof options.topic !== "string" ||
          options.topic.length === 0 || Buffer.byteLength(options.topic, "utf8") > 256) {
        throw stateError("CONTROL_TOPIC_INVALID", "Topic address is invalid.");
      }
      const row = db.prepare(`
        SELECT alias.stream_id, alias.topic, mode.mode, mode.project_id, mode.objective_id, mode.thread_id
        FROM topic_aliases AS alias
        LEFT JOIN topic_modes AS mode ON mode.alias_id = alias.alias_id
        WHERE alias.stream_id = ? AND alias.topic = ? AND alias.active = 1
      `).get(options.streamId, options.topic);
      return Object.freeze({
        streamId: options.streamId, topic: options.topic, mode: row?.mode ?? "AUTO",
        projectId: row?.project_id ?? null, objectiveId: row?.objective_id ?? null, threadId: row?.thread_id ?? null
      });
    },
    setUserTopicMode(options) {
      if (!isPlainObject(options) || Object.keys(options).some((key) => !["sourceType", "sourceId", "streamId", "topic", "projectId", "mode", "actorUserId"].includes(key)) ||
          !requireText(options.sourceType) || !requireText(options.sourceId) || !Number.isSafeInteger(options.streamId) || options.streamId <= 0 ||
          typeof options.topic !== "string" || options.topic.length === 0 || Buffer.byteLength(options.topic, "utf8") > 256 ||
          !requireText(options.projectId) || !["AUTO", "HERMES_ONLY"].includes(options.mode) ||
          !Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) {
        throw stateError("CONTROL_TOPIC_INVALID", "Topic mode command is invalid.");
      }
      return transactions.setUserTopicMode.immediate(options);
    },
    listSnapshotTopicModes() {
      return db.prepare(`
        SELECT alias.stream_id, alias.topic, mode.mode
        FROM topic_aliases AS alias JOIN topic_modes AS mode ON mode.alias_id = alias.alias_id
        WHERE alias.active = 1 ORDER BY alias.stream_id, alias.topic
      `).all().map((row) => Object.freeze({ streamId: row.stream_id, topic: row.topic, mode: row.mode }));
    },
    readObjectiveProject(objectiveId) {
      if (!requireText(objectiveId)) throw stateError("OBJECTIVE_ID_INVALID", "Objective ID is invalid.");
      return db.prepare("SELECT project_id FROM objective_projects WHERE objective_id = ?").get(objectiveId)?.project_id ?? null;
    },
    readAppServerTurnContext(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "threadId,turnId" ||
          !requireText(options.threadId) || !requireText(options.turnId)) {
        throw stateError("APP_SERVER_TURN_CONTEXT_INVALID", "App Server turn context lookup is invalid.");
      }
      const row = db.prepare(`
        SELECT execution.objective_id, project.project_id,
          execution.app_server_thread_id, submission.turn_id, submission.target_snapshot_json
        FROM objective_execution AS execution
        JOIN turn_submissions AS submission ON submission.objective_id = execution.objective_id
        JOIN objective_projects AS project ON project.objective_id = execution.objective_id
        WHERE execution.backend = 'app-server'
          AND execution.app_server_thread_id = ? AND submission.turn_id = ?
      `).get(options.threadId, options.turnId);
      if (!row) return null;
      return deepFreeze({
        objectiveId: row.objective_id,
        projectId: row.project_id,
        threadId: row.app_server_thread_id,
        turnId: row.turn_id,
        targetSnapshot: JSON.parse(row.target_snapshot_json)
      });
    },
    readCurrentTopicObjective(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "projectId,streamId,topic" ||
          !Number.isSafeInteger(options.streamId) || options.streamId <= 0 || typeof options.topic !== "string" || !requireText(options.projectId)) {
        throw stateError("CONTROL_TOPIC_INVALID", "Topic address is invalid.");
      }
      return db.prepare(`
        SELECT mode.objective_id FROM topic_aliases AS alias
        JOIN topic_modes AS mode ON mode.alias_id = alias.alias_id
        WHERE alias.stream_id = ? AND alias.topic = ? AND alias.active = 1
          AND mode.mode = 'CODEX_BOUND' AND mode.project_id = ?
      `).get(options.streamId, options.topic, options.projectId)?.objective_id ?? null;
    },
    bumpControlGeneration(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "sourceId,sourceType" ||
          !requireText(options.sourceType) || !requireText(options.sourceId)) {
        throw stateError("CONTROL_GENERATION_INVALID", "Control generation bump is invalid.");
      }
      const result = transactions.bumpControlGeneration.immediate(options);
      return Object.freeze({ duplicate: result.duplicate, generation: result.generation, updatedAt: result.updated_at_ms });
    },
    readControlGeneration() {
      const row = db.prepare("SELECT generation, updated_at_ms FROM control_plane_meta WHERE singleton = 1").get();
      return Object.freeze({ generation: row.generation, updatedAt: row.updated_at_ms });
    },
    syncStaticRegistry(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "routes" ||
          !Array.isArray(options.routes) || options.routes.length > 4096) {
        throw stateError("STATIC_REGISTRY_INVALID", "Static registry is invalid.");
      }
      let priorStreamId = 0;
      const routes = options.routes.map((route) => {
        if (!isPlainObject(route) || Object.keys(route).sort().join(",") !== "projectId,streamId" ||
            !Number.isSafeInteger(route.streamId) || route.streamId <= priorStreamId ||
            typeof route.projectId !== "string" || !PROJECT_ID.test(route.projectId)) {
          throw stateError("STATIC_REGISTRY_INVALID", "Static registry is invalid.");
        }
        priorStreamId = route.streamId;
        return { streamId: route.streamId, projectId: route.projectId };
      });
      const result = transactions.syncStaticRegistry.immediate({ routes });
      return Object.freeze({
        registryChanged: result.registryChanged,
        effectiveChanged: result.effectiveChanged,
        revision: result.revision,
        generation: result.generation,
        updatedAt: result.updated_at_ms
      });
    },
    bindBackendObjective(options) {
      if (options === null || typeof options !== "object" || !requireText(options.objectiveId) ||
          !["app-server", "tmux"].includes(options.backend) ||
          (options.threadId !== null && options.threadId !== undefined && !requireText(options.threadId))) {
        throw stateError("OBJECTIVE_BINDING_INVALID", "Objective backend binding is invalid.");
      }
      return transactions.bindBackendObjective.immediate({ ...options, threadId: options.threadId ?? null });
    },
    replaceMissingObjectiveThread(options) {
      if (!isPlainObject(options) ||
          Object.keys(options).sort().join(",") !== "expectedOldThreadId,newThreadId,objectiveId,submissionId" ||
          !requireText(options.objectiveId) || !requireText(options.submissionId) ||
          !requireText(options.expectedOldThreadId) || !requireText(options.newThreadId)) {
        throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
      }
      return transactions.replaceMissingObjectiveThread.immediate(options);
    },
    markReplacementThreadStartUncertain(options) {
      if (!isPlainObject(options) ||
          Object.keys(options).sort().join(",") !== "expectedOldThreadId,objectiveId,submissionId" ||
          !requireText(options.objectiveId) || !requireText(options.submissionId) ||
          !requireText(options.expectedOldThreadId)) {
        throw stateError("OBJECTIVE_THREAD_REPLACEMENT_INVALID", "Objective thread replacement is invalid.");
      }
      return transactions.markReplacementThreadStartUncertain.immediate(options);
    },
    prepareTurnSubmission(options) {
      if (options === null || typeof options !== "object" || !requireText(options.sourceType) ||
          !requireText(options.sourceId) || !requireText(options.objectiveId) ||
          typeof options.text !== "string" || !requireText(options.leaseOwner) ||
          options.targetSnapshot === null || typeof options.targetSnapshot !== "object" || Array.isArray(options.targetSnapshot)) {
        throw stateError("TURN_SUBMISSION_INVALID", "Turn submission is invalid.");
      }
      return transactions.prepareTurnSubmission.immediate(options);
    },
    acknowledgeTurnSubmission(options) {
      if (options === null || typeof options !== "object" || !requireText(options.submissionId) || !requireText(options.turnId)) {
        throw stateError("TURN_ACK_INVALID", "Turn acknowledgement is invalid.");
      }
      return transactions.acknowledgeTurnSubmission.immediate(options);
    },
    markSubmissionUnknown(options) {
      if (options === null || typeof options !== "object" || !requireText(options.submissionId)) {
        throw stateError("TURN_SUBMISSION_INVALID", "Turn submission is invalid.");
      }
      return transactions.markSubmissionUnknown.immediate(options);
    },
    rollbackSubmissionUnknown(options) {
      if (!isPlainObject(options) || Object.keys(options).sort().join(",") !== "submissionId" ||
          !requireText(options.submissionId)) {
        throw stateError("TURN_SUBMISSION_ROLLBACK_INVALID", "Turn submission rollback is invalid.");
      }
      return transactions.rollbackSubmissionUnknown.immediate(options);
    },
    markTurnReconciliationNeeded(options) {
      if (options === null || typeof options !== "object" ||
          !requireText(options.objectiveId) || !requireText(options.turnId)) {
        throw stateError("TURN_RECONCILIATION_INVALID", "Turn reconciliation state is invalid.");
      }
      return transactions.markTurnReconciliationNeeded.immediate(options);
    },
    markBackendFailure(options) {
      if (options === null || typeof options !== "object" || !requireText(options.objectiveId) ||
          (options.submissionId !== null && options.submissionId !== undefined && !requireText(options.submissionId)) ||
          typeof options.uncertain !== "boolean") {
        throw stateError("BACKEND_FAILURE_INVALID", "Backend failure state is invalid.");
      }
      return transactions.markBackendFailure.immediate({ ...options, submissionId: options.submissionId ?? null });
    },
    markConnectionLost(options) {
      if (options === null || typeof options !== "object" || !requireText(options.connectionId)) {
        throw stateError("CONNECTION_LOSS_INVALID", "Connection loss record is invalid.");
      }
      return transactions.markConnectionLost.immediate(options);
    },
    resolveObjectiveThread(options) {
      if (options === null || typeof options !== "object" || !requireText(options.objectiveId) ||
          !requireText(options.threadId) || !requireText(options.sourceType) || !requireText(options.sourceId)) {
        throw stateError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
      }
      return transactions.resolveObjectiveThread.immediate(options);
    },
    reconcileTurnSubmission(options) {
      if (options === null || typeof options !== "object" ||
          !requireText(options.submissionId) || !requireText(options.turnId)) {
        throw stateError("TURN_ACK_INVALID", "Turn reconciliation acknowledgement is invalid.");
      }
      return transactions.reconcileTurnSubmission.immediate(options);
    },
    reconcileTerminalTurn(options) {
      if (!isPlainObject(options) || !requireText(options.objectiveId) ||
          !requireText(options.submissionId) || !requireText(options.turnId) ||
          !["cancelled", "failed"].includes(options.remoteStatus) ||
          !requireText(options.sourceType) || !requireText(options.sourceId)) {
        throw stateError("TURN_RECONCILIATION_INVALID", "Turn reconciliation state is invalid.");
      }
      return transactions.reconcileTerminalTurn.immediate(options);
    },
    completeTurn(options) {
      if (options === null || typeof options !== "object" ||
          !requireText(options.objectiveId) || !requireText(options.turnId) ||
          typeof options.rawText !== "string" || !Array.isArray(options.itemIds) ||
          options.itemIds.some((itemId) => !requireText(itemId)) ||
          !requireText(options.sourceType) || !requireText(options.sourceId) ||
          typeof options.renderer !== "function") {
        throw stateError("TURN_COMPLETION_INVALID", "Turn completion is invalid.");
      }
      return transactions.completeTurn.immediate(options);
    },
    requestCancellation(options) {
      if (options === null || typeof options !== "object" ||
          !requireText(options.objectiveId) || !requireText(options.sourceType) || !requireText(options.sourceId)) {
        throw stateError("TURN_CANCELLATION_INVALID", "Turn cancellation request is invalid.");
      }
      return transactions.requestCancellation.immediate(options);
    },
    confirmCancellation(options) {
      if (options === null || typeof options !== "object" || !requireText(options.objectiveId) ||
          !requireText(options.submissionId) || !requireText(options.sourceType) || !requireText(options.sourceId)) {
        throw stateError("TURN_CANCELLATION_INVALID", "Turn cancellation confirmation is invalid.");
      }
      return transactions.confirmCancellation.immediate(options);
    },
    recordTurnAuditFact(options) {
      if (options === null || typeof options !== "object" || !requireText(options.objectiveId) ||
          !requireText(options.turnId) || !requireText(options.sourceType) || !requireText(options.sourceId) ||
          options.fact === null || typeof options.fact !== "object" || Array.isArray(options.fact)) {
        throw stateError("TURN_AUDIT_INVALID", "Turn audit fact is invalid.");
      }
      return transactions.recordTurnAuditFact.immediate(options);
    },
    createInteraction(options) {
      if (options === null || typeof options !== "object" || !requireText(options.connectionId) ||
          !isWireRequestId(options.wireRequestId) || !INTERACTION_METHODS.has(options.method) ||
          !requireText(options.objectiveId) || !requireText(options.threadId) || !requireText(options.turnId) ||
          (options.itemId !== null && options.itemId !== undefined && !requireText(options.itemId)) ||
          (options.approvalId !== null && options.approvalId !== undefined && !requireText(options.approvalId)) ||
          !isPlainObject(options.request) || !Array.isArray(options.allowedResponderIds) ||
          options.allowedResponderIds.length === 0 ||
          options.allowedResponderIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
          new Set(options.allowedResponderIds).size !== options.allowedResponderIds.length ||
          !isPlainObject(options.targetSnapshot) || typeof options.renderer !== "function") {
        throw stateError("INTERACTION_REQUEST_INVALID", "Interaction request is invalid.");
      }
      return transactions.createInteraction.immediate(options);
    },
    commitInteractionAnswer(options) {
      if (options === null || typeof options !== "object" || !requireText(options.interactionId) ||
          !Number.isSafeInteger(options.responderId) || options.responderId <= 0 ||
          !isPlainObject(options.targetSnapshot) || !isPlainObject(options.answer) ||
          (options.audit !== undefined && options.audit !== null &&
            (!isPlainObject(options.audit) ||
             !["legacy_command", "explicit_action", "natural_alias", "answer_command", "app_server_ui"].includes(options.audit.resolutionSource) ||
             !requireText(options.audit.sourceType) || !requireText(options.audit.sourceMessageId) ||
             (options.audit.actionId !== null && options.audit.actionId !== undefined && !requireText(options.audit.actionId)) ||
             (options.audit.actionClass !== null && options.audit.actionClass !== undefined && !requireText(options.audit.actionClass))))) {
        throw stateError("INTERACTION_ANSWER_INVALID", "Interaction answer is invalid.");
      }
      return transactions.commitInteractionAnswer.immediate(options);
    },
    persistInteractionPartialAnswers(options) {
      if (options === null || typeof options !== "object" || !requireText(options.interactionId) ||
          !isPlainObject(options.partialAnswers)) {
        throw stateError("INTERACTION_ANSWER_INVALID", "Partial interaction answer is invalid.");
      }
      return transactions.persistInteractionPartialAnswers.immediate(options);
    },
    recordInteractionResponseDelivery(options) {
      if (options === null || typeof options !== "object" || !requireText(options.interactionId) ||
          !requireText(options.leaseToken) || !["retryable", "uncertain", "delivered"].includes(options.state)) {
        throw stateError("INTERACTION_RESPONSE_STATE_INVALID", "Interaction response delivery state is invalid.");
      }
      return transactions.recordInteractionResponseDelivery.immediate(options);
    },
    claimInteractionResponse(options) {
      if (!isPlainObject(options) || !requireText(options.interactionId) || !requireText(options.leaseOwner)) {
        throw stateError("INTERACTION_RESPONSE_STATE_INVALID", "Interaction response delivery claim is invalid.");
      }
      return transactions.claimInteractionResponse.immediate(options);
    },
    resolveNaturalInteraction(options) {
      if (!isPlainObject(options) || !isPlainObject(options.binding) ||
          !Number.isSafeInteger(options.binding.streamId) || options.binding.streamId <= 0 ||
          typeof options.binding.topic !== "string" || !options.binding.topic ||
          !Number.isSafeInteger(options.binding.sourceMessageId) || options.binding.sourceMessageId <= 0 ||
          !Number.isSafeInteger(options.binding.senderId) || options.binding.senderId <= 0 ||
          !["allow", "deny"].includes(options.intent) || !requireText(options.normalizedAlias)) {
        throw stateError("INTERACTION_NATURAL_REPLY_INVALID", "Natural interaction reply is invalid.");
      }
      return transactions.resolveNaturalInteraction.immediate(options);
    },
    orphanInteractions(options) {
      if (options === null || typeof options !== "object" || !requireText(options.connectionId)) {
        throw stateError("INTERACTION_ORPHAN_INVALID", "Interaction orphan request is invalid.");
      }
      return transactions.orphanInteractions.immediate(options);
    },
    readInteraction(interactionId) {
      if (!requireText(interactionId)) throw stateError("INTERACTION_READ_INVALID", "Interaction read is invalid.");
      return mapInteractionWithActions(db,
        db.prepare(`
          SELECT interaction.*,
            settlement.answer_json AS settlement_answer_json,
            settlement.answered_by_id AS settlement_answered_by_id,
            settlement.answered_at_ms AS settlement_answered_at_ms
          FROM pending_interactions AS interaction
          LEFT JOIN interaction_answer_settlements AS settlement USING (interaction_id)
          WHERE interaction.interaction_id = ?
        `).get(interactionId)
      );
    },
    readInteractionDetail(interactionId) {
      if (!requireText(interactionId)) throw stateError("INTERACTION_READ_INVALID", "Interaction read is invalid.");
      const row = db.prepare("SELECT * FROM interaction_details WHERE interaction_id = ?").get(interactionId);
      if (!row) return null;
      return {
        interactionId: row.interaction_id,
        mode: row.mode,
        contentSha256: row.content_sha256,
        contentBytes: row.content_bytes,
        chunkCount: row.chunk_count,
        state: row.detail_state,
        deliveredAt: row.delivered_at_ms,
        actionPromptDeliveryId: row.action_prompt_delivery_id
      };
    },
    readInteractionSettlementAudit(interactionId) {
      if (!requireText(interactionId)) throw stateError("INTERACTION_READ_INVALID", "Interaction read is invalid.");
      const row = db.prepare(`
        SELECT * FROM interaction_settlement_audit WHERE interaction_id = ?
      `).get(interactionId);
      if (!row) return null;
      return {
        interactionId: row.interaction_id,
        actionId: row.action_id,
        actionClass: row.action_class,
        resolutionSource: row.resolution_source,
        sourceType: row.source_type,
        sourceMessageId: row.source_message_id,
        detailSha256: row.detail_sha256,
        responderId: row.responder_id,
        settledAt: row.settled_at_ms
      };
    },
    readTurnSubmission(objectiveId, turnId) {
      if (!requireText(objectiveId) || !requireText(turnId)) {
        throw stateError("TURN_SUBMISSION_READ_INVALID", "Turn submission read is invalid.");
      }
      return mapSubmissionRow(db.prepare(`
        SELECT * FROM turn_submissions WHERE objective_id = ? AND turn_id = ?
      `).get(objectiveId, turnId));
    },
    readTurnAuditFacts(objectiveId) {
      if (!requireText(objectiveId)) throw stateError("TURN_AUDIT_READ_INVALID", "Turn audit read is invalid.");
      return db.prepare(`
        SELECT * FROM turn_audit_facts WHERE objective_id = ? ORDER BY recorded_at_ms, fact_id
      `).all(objectiveId).map(mapAuditFactRow);
    },
    readTurnOutput(objectiveId, turnId) {
      if (!requireText(objectiveId) || !requireText(turnId)) {
        throw stateError("TURN_OUTPUT_READ_INVALID", "Turn output read is invalid.");
      }
      return mapTurnOutputRow(db.prepare(`
        SELECT * FROM turn_outputs WHERE objective_id = ? AND turn_id = ?
      `).get(objectiveId, turnId));
    },
    readObjectiveExecution(objectiveId) {
      if (!requireText(objectiveId)) throw stateError("OBJECTIVE_READ_INVALID", "Objective read is invalid.");
      return readExecution(db, objectiveId);
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    }
  });
}
