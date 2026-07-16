const OBJECTIVE_STATES = Object.freeze({ created: 0, running: 1, completed: 2 });
const EXECUTION_STATUSES = new Set([
  "idle", "starting", "ready", "submitting", "running", "submission_unknown",
  "reconciliation_needed", "backend_unavailable", "completed", "cancelled", "terminal_error"
]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "cancelled", "terminal_error"]);
const SUBMISSION_STATES = new Set([
  "intent", "running", "submission_unknown", "reconciliation_needed",
  "completed", "cancelled", "terminal_error"
]);
const TERMINAL_SUBMISSION_STATES = new Set(["completed", "cancelled", "terminal_error"]);
const EVENT_NAMES = new Set([
  "objective.created",
  "objective.state_changed",
  "zulip.delivery.requested"
]);
const REFERENCE_FIELDS = ["projectId", "deliveryTargetId", "objectiveId", "threadId", "turnId", "itemId"];
const MAX_CANONICAL_JSON_BYTES = 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_DELIVERY_MESSAGES = 100;
const OWNED_ERRORS = new WeakSet();

export function stateError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isStateError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

export function assertExecutionTransition(currentStatus, nextStatus, { mode = "normal" } = {}) {
  if (!EXECUTION_STATUSES.has(currentStatus) || !EXECUTION_STATUSES.has(nextStatus) ||
      !["normal", "reconciliation", "correction", "continuation"].includes(mode)) {
    throw stateError("EXECUTION_TRANSITION_INVALID", "Execution status transition is invalid.");
  }
  if (mode === "continuation") {
    if (currentStatus !== "completed" || nextStatus !== "ready") {
      throw stateError("EXECUTION_TRANSITION_INVALID", "Completed execution can only reopen for continuation.");
    }
    return nextStatus;
  }
  if (mode !== "correction" && TERMINAL_EXECUTION_STATUSES.has(currentStatus) && currentStatus !== nextStatus) {
    throw stateError("EXECUTION_TRANSITION_INVALID", "Terminal execution status cannot move backward.");
  }
  return nextStatus;
}

export function assertSubmissionTransition(currentState, nextState, { mode = "normal" } = {}) {
  if (!SUBMISSION_STATES.has(currentState) || !SUBMISSION_STATES.has(nextState) ||
      !["normal", "reconciliation", "correction"].includes(mode)) {
    throw stateError("SUBMISSION_TRANSITION_INVALID", "Submission state transition is invalid.");
  }
  if (TERMINAL_SUBMISSION_STATES.has(currentState) && currentState !== nextState) {
    throw stateError("SUBMISSION_TRANSITION_INVALID", "Terminal submission state cannot move backward.");
  }
  return nextState;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertText(value, field, { maximum = 256 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw stateError("FACT_INVALID", `Fact ${field} is invalid.`);
  }
}

export function canonicalJson(value) {
  const ancestors = new Set();
  const chunks = [];
  let byteLength = 0;

  function append(chunk) {
    byteLength += Buffer.byteLength(chunk, "utf8");
    if (byteLength > MAX_CANONICAL_JSON_BYTES) {
      throw stateError("FACT_INVALID", "Fact JSON exceeds the size limit.");
    }
    chunks.push(chunk);
  }

  function serialize(current, depth) {
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw stateError("FACT_INVALID", "Fact JSON exceeds the depth limit.");
    }
    if (current === null) {
      append("null");
      return;
    }
    if (typeof current === "string" || typeof current === "boolean") {
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw stateError("FACT_INVALID", "Fact JSON contains an invalid number.");
      append(JSON.stringify(current));
      return;
    }
    if (typeof current !== "object") throw stateError("FACT_INVALID", "Fact JSON contains an unsupported value.");
    if (ancestors.has(current)) throw stateError("FACT_INVALID", "Fact JSON must not contain cycles.");
    ancestors.add(current);

    try {
      if (Array.isArray(current)) {
        append("[");
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw stateError("FACT_INVALID", "Fact JSON arrays must not be sparse.");
          if (index > 0) append(",");
          serialize(current[index], depth + 1);
        }
        append("]");
      } else {
        if (!isPlainObject(current)) throw stateError("FACT_INVALID", "Fact JSON must contain plain objects.");
        append("{");
        const keys = Object.keys(current).sort();
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) append(",");
          append(JSON.stringify(keys[index]));
          append(":");
          serialize(current[keys[index]], depth + 1);
        }
        append("}");
      }
    } finally {
      ancestors.delete(current);
    }
  }

  if (!isPlainObject(value)) throw stateError("FACT_INVALID", "Fact JSON roots must be objects.");
  serialize(value, 0);
  return chunks.join("");
}

function validateDeliveryMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_DELIVERY_MESSAGES) {
    throw stateError("FACT_INVALID", "Delivery facts require between 1 and 100 messages.");
  }
  const semanticKeys = new Set();
  return messages.map((message, index) => {
    if (!Object.hasOwn(messages, index) || !isPlainObject(message)) {
      throw stateError("FACT_INVALID", "Delivery messages must be dense plain objects.");
    }
    assertText(message.semanticKey, "payload.messages[].semanticKey", { maximum: 512 });
    if (semanticKeys.has(message.semanticKey)) {
      throw stateError("FACT_INVALID", "Delivery semantic keys must be unique within a fact.");
    }
    semanticKeys.add(message.semanticKey);
    return {
      semanticKey: message.semanticKey,
      payloadJson: canonicalJson(message.payload),
      targetSnapshotJson: canonicalJson(message.targetSnapshot)
    };
  });
}

export function validateFact(fact) {
  if (!isPlainObject(fact)) throw stateError("FACT_INVALID", "Fact must be a plain object.");
  assertText(fact.sourceType, "sourceType");
  assertText(fact.sourceId, "sourceId", { maximum: 512 });
  assertText(fact.eventName, "eventName");
  if (!EVENT_NAMES.has(fact.eventName) || fact.schemaVersion !== 1) {
    throw stateError("FACT_INVALID", "Fact event name or schema version is unsupported.");
  }

  const mode = fact.mode ?? "normal";
  if (!["normal", "reconciliation", "correction"].includes(mode)) {
    throw stateError("FACT_INVALID", "Fact mode is invalid.");
  }
  if (mode !== "normal" && fact.sourceType !== mode) {
    throw stateError("FACT_INVALID", "Reconciliation and correction facts require their own source type.");
  }
  for (const field of REFERENCE_FIELDS) {
    if (fact[field] !== undefined && fact[field] !== null) assertText(fact[field], field, { maximum: 512 });
  }
  if (!isPlainObject(fact.payload)) throw stateError("FACT_INVALID", "Fact payload must be an object.");
  const payloadJson = canonicalJson(fact.payload);
  const integrityJson = canonicalJson(fact.integrity ?? {});
  if (Buffer.byteLength(payloadJson, "utf8") + Buffer.byteLength(integrityJson, "utf8") > MAX_CANONICAL_JSON_BYTES) {
    throw stateError("FACT_INVALID", "Fact JSON exceeds the combined size limit.");
  }

  assertText(fact.objectiveId, "objectiveId", { maximum: 512 });
  let messages = [];
  if (fact.eventName === "objective.created") {
    if (fact.payload.state !== "created") throw stateError("FACT_INVALID", "Created objectives must start in created state.");
  } else if (fact.eventName === "objective.state_changed") {
    if (!Object.hasOwn(OBJECTIVE_STATES, fact.payload.state)) {
      throw stateError("FACT_INVALID", "Objective state is unsupported.");
    }
  } else {
    messages = validateDeliveryMessages(fact.payload.messages);
  }

  return Object.freeze({
    fact,
    integrityJson,
    messages,
    mode,
    payloadJson
  });
}

function currentObjective(db, objectiveId) {
  return db.prepare("SELECT objective_id, state, state_rank, next_outbox_sequence FROM objectives WHERE objective_id = ?")
    .get(objectiveId);
}

function createObjective(db, fact, eventRecordId, now) {
  if (currentObjective(db, fact.objectiveId)) {
    throw stateError("OBJECTIVE_ALREADY_EXISTS", "Objective already exists.");
  }
  db.prepare(`
    INSERT INTO objectives (
      objective_id, state, state_rank, next_outbox_sequence, created_at_ms, updated_at_ms, created_event_record_id
    ) VALUES (?, 'created', ?, 1, ?, ?, ?)
  `).run(fact.objectiveId, OBJECTIVE_STATES.created, now, now, eventRecordId);
  return { objectiveId: fact.objectiveId, state: "created" };
}

function changeObjectiveState(db, fact, mode, now) {
  const objective = currentObjective(db, fact.objectiveId);
  if (!objective) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
  const nextState = fact.payload.state;
  const nextRank = OBJECTIVE_STATES[nextState];
  if (nextRank < objective.state_rank && mode === "normal") {
    throw stateError("OBJECTIVE_TRANSITION_INVALID", "Objective state cannot move backward.");
  }
  db.prepare("UPDATE objectives SET state = ?, state_rank = ?, updated_at_ms = ? WHERE objective_id = ?")
    .run(nextState, nextRank, now, fact.objectiveId);
  return { objectiveId: fact.objectiveId, state: nextState };
}

function enqueueDeliveries(db, fact, messages, eventRecordId, now, idFactory) {
  const objective = currentObjective(db, fact.objectiveId);
  if (!objective) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
  let sequence = objective.next_outbox_sequence;
  const outbox = [];
  const findSemanticKey = db.prepare("SELECT delivery_id FROM zulip_outbox WHERE semantic_key = ?");
  const insert = db.prepare(`
    INSERT INTO zulip_outbox (
      delivery_id, objective_id, semantic_key, objective_sequence, payload_json, target_snapshot_json,
      state, attempt_count, created_at_ms, updated_at_ms, event_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `);

  for (const message of messages) {
    if (findSemanticKey.get(message.semanticKey)) {
      throw stateError("OUTBOX_SEMANTIC_CONFLICT", "Outbox semantic key already exists.");
    }
    const deliveryId = idFactory("delivery");
    insert.run(
      deliveryId,
      fact.objectiveId,
      message.semanticKey,
      sequence,
      message.payloadJson,
      message.targetSnapshotJson,
      now,
      now,
      eventRecordId
    );
    outbox.push({ deliveryId, semanticKey: message.semanticKey, objectiveSequence: sequence });
    sequence += 1;
  }
  db.prepare("UPDATE objectives SET next_outbox_sequence = ?, updated_at_ms = ? WHERE objective_id = ?")
    .run(sequence, now, fact.objectiveId);
  return outbox;
}

export function reduceFact(db, validated, { eventRecordId, idFactory, now }) {
  const { fact, messages, mode } = validated;
  if (fact.eventName === "objective.created") {
    return { objective: createObjective(db, fact, eventRecordId, now), outbox: [] };
  }
  if (fact.eventName === "objective.state_changed") {
    return { objective: changeObjectiveState(db, fact, mode, now), outbox: [] };
  }
  return {
    objective: null,
    outbox: enqueueDeliveries(db, fact, messages, eventRecordId, now, idFactory)
  };
}
