import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { MIGRATIONS } from "../hco/state/migrations.js";
import { assertExecutionTransition } from "../hco/state/reducer.js";
import { openStore } from "../hco/state/store.js";

const START_MS = 1_700_000_000_000;
const EXPECTED_MIGRATION_HISTORY = MIGRATIONS.map(({ version, name }) => ({ version, name }));

test("continuation transition reopens only completed execution as ready", () => {
  assert.equal(assertExecutionTransition("completed", "ready", { mode: "continuation" }), "ready");
  for (const status of ["cancelled", "terminal_error"]) {
    assert.throws(
      () => assertExecutionTransition(status, "ready", { mode: "continuation" }),
      { code: "EXECUTION_TRANSITION_INVALID" }
    );
  }
  assert.throws(
    () => assertExecutionTransition("completed", "starting", { mode: "continuation" }),
    { code: "EXECUTION_TRANSITION_INVALID" }
  );
});

function assertCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

function databaseFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-state-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: START_MS };
  const counters = new Map();
  const idFactory = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${next}`;
  };
  const store = openStore({
    databasePath,
    now: () => clock.value,
    idFactory,
    ...options
  });
  t.after(() => store.close());
  return { clock, databasePath, idFactory, store };
}

function rawDatabase(databasePath, options = {}) {
  return new Database(databasePath, options);
}

function createdFact(objectiveId, sourceId = `created-${objectiveId}`, overrides = {}) {
  return {
    sourceType: "bridge",
    sourceId,
    eventName: "objective.created",
    schemaVersion: 1,
    projectId: "project-1",
    deliveryTargetId: `target-${objectiveId}`,
    objectiveId,
    payload: { state: "created", title: `Objective ${objectiveId}` },
    integrity: { algorithm: "sha256", digest: `digest-${objectiveId}` },
    ...overrides
  };
}

function stateFact(objectiveId, state, sourceId, overrides = {}) {
  return {
    sourceType: "app-server",
    sourceId,
    eventName: "objective.state_changed",
    schemaVersion: 1,
    objectiveId,
    payload: { state },
    ...overrides
  };
}

function deliveryFact(objectiveId, sourceId, messages, overrides = {}) {
  return {
    sourceType: "renderer",
    sourceId,
    eventName: "zulip.delivery.requested",
    schemaVersion: 1,
    objectiveId,
    payload: { messages },
    ...overrides
  };
}

function message(semanticKey, text, target = { streamId: 42, topic: "Build" }) {
  return {
    semanticKey,
    payload: { type: "stream", content: text },
    targetSnapshot: target
  };
}

function seedAcknowledgedAppServerTurn(store, {
  objectiveId = "objective-context",
  projectId = "project-context",
  threadId = "thread-context",
  turnId = "turn-context",
  targetSnapshot = { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 99 }
} = {}) {
  const sourceId = `intent-${objectiveId}`;
  store.registerExecutionIntent({
    sourceType: "test", sourceId, objectiveId, projectId,
    backend: "app-server", text: "seed", targetSnapshot,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  store.bindBackendObjective({ objectiveId, backend: "app-server", threadId });
  const prepared = store.prepareTurnSubmission({
    sourceType: "test", sourceId, objectiveId,
    text: "run", targetSnapshot, leaseOwner: "store-test"
  });
  store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId });
  return { objectiveId, projectId, threadId, turnId, targetSnapshot };
}

test("reads an exact durable App Server turn context as deeply frozen authority", (t) => {
  const { store } = databaseFixture(t);
  const seeded = seedAcknowledgedAppServerTurn(store);

  const context = store.readAppServerTurnContext({ threadId: seeded.threadId, turnId: seeded.turnId });

  assert.deepEqual(context, seeded);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.targetSnapshot), true);
  assert.equal(store.readAppServerTurnContext({ threadId: "thread-wrong", turnId: seeded.turnId }), null);
  assert.equal(store.readAppServerTurnContext({ threadId: seeded.threadId, turnId: "turn-wrong" }), null);

  seedAcknowledgedAppServerTurn(store, {
    objectiveId: "objective-other", projectId: "project-other",
    threadId: "thread-other", turnId: "turn-other",
    targetSnapshot: { platform: "zulip", streamId: 43, topic: "Other", sourceMessageId: 100 }
  });
  assert.equal(store.readAppServerTurnContext({ threadId: seeded.threadId, turnId: "turn-other" }), null);
});

test("a proven pre-write failure restores the same durable submission intent", (t) => {
  const { store } = databaseFixture(t);
  const targetSnapshot = {
    platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 99
  };
  store.registerExecutionIntent({
    sourceType: "test",
    sourceId: "rollback-unknown-intent",
    objectiveId: "objective-rollback-unknown",
    projectId: "project-context",
    backend: "app-server",
    text: "retry exact request",
    targetSnapshot,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  store.bindBackendObjective({
    objectiveId: "objective-rollback-unknown",
    backend: "app-server",
    threadId: "thread-rollback-unknown"
  });
  const prepared = store.prepareTurnSubmission({
    sourceType: "test",
    sourceId: "rollback-unknown-intent",
    objectiveId: "objective-rollback-unknown",
    text: "retry exact request",
    targetSnapshot,
    leaseOwner: "store-test"
  });
  store.markSubmissionUnknown({ submissionId: prepared.submission.submissionId });

  const rolledBack = store.rollbackSubmissionUnknown({
    submissionId: prepared.submission.submissionId
  });

  assert.equal(rolledBack.state, "intent");
  assert.equal(rolledBack.reconciliationRequired, false);
  const execution = store.readObjectiveExecution("objective-rollback-unknown");
  assert.equal(execution.executionStatus, "submitting");
  assert.equal(execution.activeSubmission.submissionId, prepared.submission.submissionId);
  assert.equal(execution.activeSubmission.clientUserMessageId, prepared.submission.clientUserMessageId);
});

test("rejects malformed App Server turn context lookups with one owned error", (t) => {
  const { store } = databaseFixture(t);
  for (const options of [
    undefined,
    null,
    {},
    { threadId: "thread" },
    { threadId: "thread", turnId: "turn", extra: true },
    { threadId: " ", turnId: "turn" },
    { threadId: "thread", turnId: "x".repeat(4097) }
  ]) {
    assert.throws(
      () => store.readAppServerTurnContext(options),
      (error) => assertCode(error, "APP_SERVER_TURN_CONTEXT_INVALID")
    );
  }
});

test("opens an owner-only WAL database with foreign keys, busy timeout, and explicit schema history", (t) => {
  const { databasePath } = databaseFixture(t);
  const mode = statSync(databasePath).mode & 0o777;
  assert.equal(mode, 0o600);

  const db = rawDatabase(databasePath);
  t.after(() => db.close());
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
  assert.deepEqual(
    db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    EXPECTED_MIGRATION_HISTORY
  );

  for (const table of [
    "event_journal",
    "objectives",
    "zulip_outbox",
    "delivery_attempts",
    "resource_leases",
    "replay_nonces",
    "objective_execution",
    "turn_submissions",
    "inbound_intents",
    "turn_outputs",
    "pending_interactions",
    "interaction_answer_settlements",
    "turn_audit_facts",
    "control_plane_meta",
    "static_registry_meta",
    "static_stream_routes",
    "runtime_stream_routes",
    "topic_aliases",
    "topic_modes",
    "objective_projects",
    "execution_topic_intents",
    "topic_contexts",
    "topic_context_aliases",
    "work_requests",
    "agent_sessions",
    "agent_activations",
    "agent_parent_edges",
    "codex_conversations",
    "codex_calls",
    "codex_call_ownership",
    "objective_scopes",
    "coordination_mailbox",
    "agent_reports",
    "authority_envelopes",
    "approval_sets",
    "approval_set_members",
    "interaction_coordination",
    "interaction_escalations",
    "notification_ledger",
    "coordination_fence_counters",
    "coordination_write_leases"
  ]) {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count,
      1,
      `${table} should exist`
    );
  }

  assert.throws(() => db.prepare("DELETE FROM schema_migrations").run(), /append-only/i);
  assert.throws(() => db.prepare("UPDATE schema_migrations SET name = 'changed'").run(), /append-only/i);
});

test("v9 hardens action prompt uniqueness when upgrading a populated v8 database", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-v8-migration-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const db = rawDatabase(databasePath);
  for (const migration of MIGRATIONS.slice(0, -1)) {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, START_MS);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.prepare(`
    INSERT INTO event_journal (
      event_record_id, source_type, source_id, received_at_ms, event_schema_version,
      event_name, event_mode, payload_json, integrity_json, objective_id
    ) VALUES ('event-v8', 'test', 'source-v8', ?, 1, 'objective.created',
      'normal', '{}', '{}', 'objective-v8')
  `).run(START_MS);
  db.prepare(`
    INSERT INTO objectives (
      objective_id, state, state_rank, next_outbox_sequence, created_at_ms,
      updated_at_ms, created_event_record_id
    ) VALUES ('objective-v8', 'running', 1, 3, ?, ?, 'event-v8')
  `).run(START_MS, START_MS);
  db.prepare(`
    INSERT INTO objective_execution (
      objective_id, backend, execution_status, backend_objective_started,
      app_server_thread_id, created_at_ms, updated_at_ms
    ) VALUES ('objective-v8', 'app-server', 'running', 1, 'thread-v8', ?, ?)
  `).run(START_MS, START_MS);
  db.prepare(`
    INSERT INTO pending_interactions (
      interaction_id, connection_id, wire_id_type, wire_id_json, method,
      objective_id, thread_id, turn_id, correlation_key, request_json,
      allowed_responder_ids_json, target_snapshot_json, expires_at_ms, state,
      created_at_ms, updated_at_ms
    ) VALUES (
      'interaction-v8', 'connection-v8', 'number', '8',
      'item/commandExecution/requestApproval', 'objective-v8', 'thread-v8',
      'turn-v8', 'correlation-v8', '{}', '[101]',
      '{"streamId":42,"topic":"Build"}', ?, 'pending', ?, ?
    )
  `).run(START_MS + 86_400_000, START_MS, START_MS);
  const insertOutbox = db.prepare(`
    INSERT INTO zulip_outbox (
      delivery_id, objective_id, semantic_key, objective_sequence, payload_json,
      target_snapshot_json, state, created_at_ms, updated_at_ms, event_record_id
    ) VALUES (?, 'objective-v8', ?, ?, '{}', '{}', 'pending', ?, ?, 'event-v8')
  `);
  insertOutbox.run("delivery-v8", "prompt-v8", 1, START_MS, START_MS);
  insertOutbox.run("delivery-v9", "prompt-v9", 2, START_MS, START_MS);
  db.prepare(`
    INSERT INTO interaction_delivery_links (
      delivery_id, interaction_id, role, chunk_index, created_at_ms
    ) VALUES ('delivery-v8', 'interaction-v8', 'action_prompt', NULL, ?)
  `).run(START_MS);
  db.close();

  const store = openStore({ databasePath, now: () => START_MS + 1 });
  store.close();
  const migrated = rawDatabase(databasePath);
  t.after(() => migrated.close());

  assert.equal(migrated.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
  assert.deepEqual(
    migrated.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    EXPECTED_MIGRATION_HISTORY
  );
  const index = migrated.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'interaction_delivery_one_action_prompt'
  `).get();
  assert.match(index.sql, /CREATE UNIQUE INDEX interaction_delivery_one_action_prompt/i);
  assert.match(index.sql, /WHERE role = 'action_prompt'/i);
  assert.throws(
    () => migrated.prepare(`
      INSERT INTO interaction_delivery_links (
        delivery_id, interaction_id, role, chunk_index, created_at_ms
      ) VALUES ('delivery-v9', 'interaction-v8', 'action_prompt', NULL, ?)
    `).run(START_MS + 1),
    /UNIQUE constraint failed: interaction_delivery_links\.interaction_id/
  );
});

test("migrates a populated Task 2 v1 database to durable execution state without data loss", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-v1-migration-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const db = rawDatabase(databasePath);
  MIGRATIONS[0].up(db);
  db.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (1, ?, ?)")
    .run(MIGRATIONS[0].name, START_MS);
  db.pragma("user_version = 1");
  db.prepare(`
    INSERT INTO event_journal (
      event_record_id, source_type, source_id, received_at_ms, event_schema_version,
      event_name, event_mode, payload_json, integrity_json, objective_id
    ) VALUES ('event-v1', 'bridge', 'source-v1', ?, 1, 'objective.created',
      'normal', '{"state":"created"}', '{}', 'objective-v1')
  `).run(START_MS);
  db.prepare(`
    INSERT INTO objectives (
      objective_id, state, state_rank, next_outbox_sequence, created_at_ms,
      updated_at_ms, created_event_record_id
    ) VALUES ('objective-v1', 'created', 0, 1, ?, ?, 'event-v1')
  `).run(START_MS, START_MS);
  db.close();

  const store = openStore({ databasePath, now: () => START_MS + 1 });
  t.after(() => store.close());
  const migrated = rawDatabase(databasePath, { readonly: true });
  t.after(() => migrated.close());

  assert.equal(migrated.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
  assert.deepEqual(
    migrated.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    EXPECTED_MIGRATION_HISTORY
  );
  assert.deepEqual(
    migrated.prepare("SELECT objective_id, state, created_event_record_id FROM objectives").get(),
    { objective_id: "objective-v1", state: "created", created_event_record_id: "event-v1" }
  );
  for (const table of [
    "objective_execution",
    "turn_submissions",
    "inbound_intents",
    "turn_outputs",
    "pending_interactions",
    "interaction_answer_settlements",
    "turn_audit_facts",
    "control_plane_meta",
    "static_registry_meta",
    "static_stream_routes",
    "runtime_stream_routes",
    "topic_aliases",
    "topic_modes",
    "objective_projects",
    "execution_topic_intents"
  ]) {
    assert.equal(
      migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count,
      1,
      `${table} should exist after current migrations`
    );
  }
  const interactionColumns = migrated.pragma("table_info('pending_interactions')");
  assert.deepEqual(
    interactionColumns
      .filter(({ name }) => ["response_delivery_state", "response_delivery_updated_at_ms"].includes(name))
      .map(({ name, notnull, dflt_value: defaultValue }) => ({ name, notnull, defaultValue })),
    [
      { name: "response_delivery_state", notnull: 1, defaultValue: "'not_answered'" },
      { name: "response_delivery_updated_at_ms", notnull: 0, defaultValue: null }
    ]
  );
});

test("migrates populated v3 interaction answers into immutable settlement audit without data loss", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-v3-migration-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const db = rawDatabase(databasePath);
  for (const migration of MIGRATIONS.slice(0, 3)) {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, START_MS);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.prepare(`
    INSERT INTO event_journal (
      event_record_id, source_type, source_id, received_at_ms, event_schema_version,
      event_name, event_mode, payload_json, integrity_json, objective_id
    ) VALUES ('event-v3', 'bridge', 'source-v3', ?, 1, 'objective.created',
      'normal', '{"state":"created"}', '{}', 'objective-v3')
  `).run(START_MS);
  db.prepare(`
    INSERT INTO objectives (
      objective_id, state, state_rank, next_outbox_sequence, created_at_ms,
      updated_at_ms, created_event_record_id
    ) VALUES ('objective-v3', 'created', 0, 1, ?, ?, 'event-v3')
  `).run(START_MS, START_MS);
  db.prepare(`
    INSERT INTO objective_execution (
      objective_id, backend, execution_status, backend_objective_started,
      app_server_thread_id, created_at_ms, updated_at_ms
    ) VALUES ('objective-v3', 'app-server', 'running', 1, 'thread-v3', ?, ?)
  `).run(START_MS, START_MS);
  db.prepare(`
    INSERT INTO pending_interactions (
      interaction_id, connection_id, wire_id_type, wire_id_json, method, objective_id,
      thread_id, turn_id, correlation_key, request_json, allowed_responder_ids_json,
      target_snapshot_json, expires_at_ms, state, answer_json, answered_by_id,
      answered_at_ms, created_at_ms, updated_at_ms, response_delivery_state,
      response_delivery_updated_at_ms
    ) VALUES (
      'interaction-v3', 'connection-v3', 'number', '7', 'item/tool/requestUserInput',
      'objective-v3', 'thread-v3', 'turn-v3', 'correlation-v3', '{}', '[101]',
      '{"streamId":42,"topic":"Build"}', ?, 'answered', '{"decision":"accept"}',
      '101', ?, ?, ?, 'retryable', ?
    )
  `).run(START_MS + 86_400_000, START_MS, START_MS, START_MS, START_MS);
  db.close();

  const store = openStore({ databasePath, now: () => START_MS + 1 });
  t.after(() => store.close());
  const migrated = rawDatabase(databasePath);
  t.after(() => migrated.close());

  assert.equal(migrated.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
  assert.deepEqual(
    migrated.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    EXPECTED_MIGRATION_HISTORY
  );
  assert.deepEqual(
    migrated.prepare(`
      SELECT interaction_id, answer_json, answered_by_id, answered_at_ms
      FROM interaction_answer_settlements
    `).get(),
    {
      interaction_id: "interaction-v3",
      answer_json: '{"decision":"accept"}',
      answered_by_id: "101",
      answered_at_ms: START_MS
    }
  );
  const interaction = store.readInteraction("interaction-v3");
  assert.deepEqual(
    { answer: interaction.answer, answeredById: interaction.answeredById, answeredAt: interaction.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  assert.deepEqual(
    migrated.prepare("SELECT objective_id, state, created_event_record_id FROM objectives").get(),
    { objective_id: "objective-v3", state: "created", created_event_record_id: "event-v3" }
  );
  assert.throws(
    () => migrated.prepare("UPDATE interaction_answer_settlements SET answer_json = '{}' ").run(),
    /immutable/i
  );
  assert.throws(
    () => migrated.prepare("DELETE FROM interaction_answer_settlements").run(),
    /immutable/i
  );
});

test("creates the database owner-only under a permissive umask and repairs crash-left WAL sidecars", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-permissions-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const previousUmask = process.umask(0);
  let store;
  try {
    store = openStore({ databasePath });
  } finally {
    process.umask(previousUmask);
  }
  store.close();
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);

  for (const suffix of ["-wal", "-shm"]) {
    writeFileSync(`${databasePath}${suffix}`, "", { mode: 0o644 });
    chmodSync(`${databasePath}${suffix}`, 0o644);
  }

  store = openStore({ databasePath });
  try {
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${databasePath}${suffix}`;
      assert.equal(existsSync(sidecarPath), true, `${suffix} should exist while the WAL store is open`);
      assert.equal(statSync(sidecarPath).mode & 0o777, 0o600);
    }
  } finally {
    store.close();
  }
});

test("rejects a symlink database without following it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-symlink-"));
  const targetPath = path.join(directory, "target.sqlite3");
  const databasePath = path.join(directory, "authority.sqlite3");
  writeFileSync(targetPath, "");
  symlinkSync(targetPath, databasePath);

  let opened;
  try {
    opened = openStore({ databasePath });
  } catch (error) {
    assertCode(error, "STORE_OPEN_FAILED");
    assert.equal(error.message.includes(databasePath), false);
    return;
  }
  opened.close();
  assert.fail("openStore followed a symlink database");
});

test("normalizes native filesystem and SQLite open failures without exposing the database path", () => {
  const databasePath = mkdtempSync(path.join(tmpdir(), "hco-open-directory-"));
  assert.throws(
    () => openStore({ databasePath }),
    (error) => {
      assertCode(error, "STORE_OPEN_FAILED");
      assert.equal(error.message.includes(databasePath), false);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test("does not trust a caller-supplied STORE_ error code as a project-owned error", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-forged-error-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const forgedMigrations = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") {
        const error = new Error(`forged failure at ${databasePath}`);
        error.code = "STORE_FORGED";
        throw error;
      }
      return Reflect.get(target, property, receiver);
    }
  });

  assert.throws(
    () => openStore({ databasePath, migrations: forgedMigrations }),
    (error) => {
      assertCode(error, "STORE_OPEN_FAILED");
      assert.equal(error.message.includes(databasePath), false);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test("a failed custom migration rolls back its schema, version, and history atomically", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-migration-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  openStore({ databasePath }).close();

  const failingVersion = MIGRATIONS.at(-1).version + 1;
  const failingMigration = {
    version: failingVersion,
    name: "deliberate_failure",
    up(db) {
      db.exec("CREATE TABLE must_rollback (id INTEGER PRIMARY KEY)");
      throw new Error("deliberate migration failure");
    }
  };

  assert.throws(
    () => openStore({ databasePath, migrations: [...MIGRATIONS, failingMigration] }),
    (error) => assertCode(error, "STORE_MIGRATION_FAILED")
  );

  const db = rawDatabase(databasePath);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      EXPECTED_MIGRATION_HISTORY
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'must_rollback'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test("migration failures preserve the stable store error without exposing the native cause or path", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-migration-cause-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  openStore({ databasePath }).close();
  const failingVersion = MIGRATIONS.at(-1).version + 1;
  const leakingMigration = {
    version: failingVersion,
    name: "leaking_native_failure",
    up() {
      const error = new Error(`unable to open database file: ${databasePath}`);
      error.code = "SQLITE_CANTOPEN";
      throw error;
    }
  };

  assert.throws(
    () => openStore({ databasePath, migrations: [...MIGRATIONS, leakingMigration] }),
    (error) => {
      assertCode(error, "STORE_MIGRATION_FAILED");
      assert.equal(error.message, `Store migration ${failingVersion} failed.`);
      assert.equal(error.message.includes(databasePath), false);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test("ingest appends canonical journal data and creates reduced objective state in one transaction", (t) => {
  const { databasePath, store } = databaseFixture(t);
  const first = store.ingest(createdFact("objective-1", "source-1", {
    payload: { z: 1, state: "created", nested: { beta: true, alpha: false } },
    integrity: { z: "last", a: "first" },
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1"
  }));

  assert.deepEqual(first, {
    duplicate: false,
    ingestionSeq: 1,
    eventRecordId: "event-1",
    objective: { objectiveId: "objective-1", state: "created" },
    outbox: []
  });

  const db = rawDatabase(databasePath);
  t.after(() => db.close());
  const journal = db.prepare("SELECT * FROM event_journal WHERE ingestion_seq = 1").get();
  assert.equal(journal.event_record_id, "event-1");
  assert.equal(journal.source_type, "bridge");
  assert.equal(journal.source_id, "source-1");
  assert.equal(journal.received_at_ms, START_MS);
  assert.equal(journal.event_schema_version, 1);
  assert.equal(journal.event_name, "objective.created");
  assert.equal(journal.project_id, "project-1");
  assert.equal(journal.delivery_target_id, "target-objective-1");
  assert.equal(Object.hasOwn(journal, "delivery_id"), false);
  assert.equal(journal.objective_id, "objective-1");
  assert.equal(journal.thread_id, "thread-1");
  assert.equal(journal.turn_id, "turn-1");
  assert.equal(journal.item_id, "item-1");
  assert.equal(journal.payload_json, '{"nested":{"alpha":false,"beta":true},"state":"created","z":1}');
  assert.equal(journal.integrity_json, '{"a":"first","z":"last"}');
  assert.deepEqual(
    db.prepare("SELECT objective_id, state, next_outbox_sequence FROM objectives").get(),
    { objective_id: "objective-1", state: "created", next_outbox_sequence: 1 }
  );
  assert.throws(() => db.prepare("DELETE FROM event_journal").run(), /append-only/i);
  assert.throws(() => db.prepare("UPDATE event_journal SET event_name = 'changed'").run(), /append-only/i);
});

test("duplicate source identity returns the original ingestion identity without reducing or enqueueing twice", (t) => {
  const { databasePath, store } = databaseFixture(t);
  const fact = createdFact("objective-1", "same-source");
  const original = store.ingest(fact);
  const duplicate = store.ingest(fact);

  assert.deepEqual(duplicate, {
    duplicate: true,
    ingestionSeq: original.ingestionSeq,
    eventRecordId: original.eventRecordId,
    objective: null,
    outbox: []
  });

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM objectives").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM zulip_outbox").get().count, 0);
});

test("fact validation fails before mutation with a stable code", (t) => {
  const { databasePath, store } = databaseFixture(t);
  const invalid = createdFact("objective-1");
  invalid.payload = { state: "created", unsupported: undefined };

  assert.throws(() => store.ingest(invalid), (error) => assertCode(error, "FACT_INVALID"));

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM objectives").get().count, 0);
});

test("fact JSON rejects oversized roots and oversized combined payload before mutation", (t) => {
  const { databasePath, store } = databaseFixture(t);
  const oversized = "x".repeat(1024 * 1024);
  const substantial = "x".repeat(600 * 1024);
  const facts = [
    createdFact("objective-payload", "oversized-payload", { payload: { state: "created", oversized } }),
    createdFact("objective-integrity", "oversized-integrity", { integrity: { oversized } }),
    createdFact("objective-total", "oversized-total", {
      payload: { state: "created", substantial },
      integrity: { substantial }
    }),
    deliveryFact("objective-message", "oversized-message", [
      message("oversized-message", oversized)
    ]),
    deliveryFact("objective-target", "oversized-target", [
      message("oversized-target", "small", { streamId: 42, topic: oversized })
    ])
  ];

  for (const fact of facts) {
    assert.throws(() => store.ingest(fact), (error) => assertCode(error, "FACT_INVALID"));
  }

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM objectives").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM zulip_outbox").get().count, 0);
});

test("fact JSON rejects nesting deeper than 64 before mutation", (t) => {
  const { databasePath, store } = databaseFixture(t);
  let nested = "leaf";
  for (let depth = 0; depth < 65; depth += 1) nested = { nested };
  const fact = createdFact("objective-deep", "deep-json", {
    payload: { state: "created", nested }
  });

  assert.throws(() => store.ingest(fact), (error) => assertCode(error, "FACT_INVALID"));

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 0);
});

test("delivery facts reject more than 100 messages before mutation", (t) => {
  const { databasePath, store } = databaseFixture(t);
  const messages = Array.from({ length: 101 }, (_, index) => message(`message-${index}`, `payload-${index}`));

  assert.throws(
    () => store.ingest(deliveryFact("objective-many", "too-many-messages", messages)),
    (error) => assertCode(error, "FACT_INVALID")
  );

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM zulip_outbox").get().count, 0);
});

test("objective state moves forward and rejects backward movement unless explicitly corrected", (t) => {
  const { databasePath, store } = databaseFixture(t);
  store.ingest(createdFact("objective-1"));
  const running = store.ingest(stateFact("objective-1", "running", "state-running"));
  assert.deepEqual(running.objective, { objectiveId: "objective-1", state: "running" });

  assert.throws(
    () => store.ingest(stateFact("objective-1", "created", "illegal-backward")),
    (error) => assertCode(error, "OBJECTIVE_TRANSITION_INVALID")
  );

  const corrected = store.ingest(stateFact("objective-1", "created", "correction-1", {
    sourceType: "correction",
    mode: "correction"
  }));
  assert.deepEqual(corrected.objective, { objectiveId: "objective-1", state: "created" });

  assert.throws(
    () => store.ingest(stateFact("objective-1", "running", "bad-reconciliation", { mode: "reconciliation" })),
    (error) => assertCode(error, "FACT_INVALID")
  );

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT state FROM objectives WHERE objective_id = 'objective-1'").get().state, "created");
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 3);
});

test("one fact atomically enqueues immutable semantic deliveries with objective-local sequence", (t) => {
  const { databasePath, store } = databaseFixture(t);
  store.ingest(createdFact("objective-1"));

  const result = store.ingest(deliveryFact("objective-1", "delivery-source", [
    message("objective-1:final:1", "first"),
    message("objective-1:final:2", "second")
  ]));

  assert.equal(result.outbox.length, 2);
  assert.deepEqual(result.outbox.map(({ deliveryId, semanticKey, objectiveSequence }) => ({
    deliveryId,
    semanticKey,
    objectiveSequence
  })), [
    { deliveryId: "delivery-1", semanticKey: "objective-1:final:1", objectiveSequence: 1 },
    { deliveryId: "delivery-2", semanticKey: "objective-1:final:2", objectiveSequence: 2 }
  ]);

  const db = rawDatabase(databasePath);
  t.after(() => db.close());
  const rows = db.prepare(
    "SELECT delivery_id, semantic_key, objective_sequence, payload_json, target_snapshot_json, state FROM zulip_outbox ORDER BY objective_sequence"
  ).all();
  assert.deepEqual(rows, [
    {
      delivery_id: "delivery-1",
      semantic_key: "objective-1:final:1",
      objective_sequence: 1,
      payload_json: '{"content":"first","type":"stream"}',
      target_snapshot_json: '{"streamId":42,"topic":"Build"}',
      state: "pending"
    },
    {
      delivery_id: "delivery-2",
      semantic_key: "objective-1:final:2",
      objective_sequence: 2,
      payload_json: '{"content":"second","type":"stream"}',
      target_snapshot_json: '{"streamId":42,"topic":"Build"}',
      state: "pending"
    }
  ]);
  assert.throws(
    () => db.prepare("UPDATE zulip_outbox SET semantic_key = 'changed' WHERE delivery_id = 'delivery-1'").run(),
    /immutable/i
  );
});

test("outbox insertion failure rolls back the journal and objective sequence", (t) => {
  const { databasePath, store } = databaseFixture(t);
  store.ingest(createdFact("objective-1"));
  store.ingest(deliveryFact("objective-1", "first-delivery", [message("same-key", "first")]));

  assert.throws(
    () => store.ingest(deliveryFact("objective-1", "failing-delivery", [message("same-key", "duplicate")])),
    (error) => assertCode(error, "OUTBOX_SEMANTIC_CONFLICT")
  );

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_journal").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM zulip_outbox").get().count, 1);
  assert.equal(
    db.prepare("SELECT next_outbox_sequence FROM objectives WHERE objective_id = 'objective-1'").get().next_outbox_sequence,
    2
  );
});

test("claim is atomic, bounded, ordered per objective, and records durable attempts", (t) => {
  const { databasePath, store } = databaseFixture(t);
  for (const objectiveId of ["objective-1", "objective-2"]) {
    store.ingest(createdFact(objectiveId));
    store.ingest(deliveryFact(objectiveId, `delivery-${objectiveId}`, [
      message(`${objectiveId}:1`, `${objectiveId} first`),
      message(`${objectiveId}:2`, `${objectiveId} second`)
    ]));
  }

  const claimed = store.claimOutbox({ workerId: "worker-1", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((row) => row.objectiveId).sort(), ["objective-1", "objective-2"]);
  assert.ok(claimed.every((row) => row.objectiveSequence === 1));
  assert.ok(claimed.every((row) => row.state === "leased" && row.attemptCount === 1));
  assert.ok(claimed.every((row) => row.leaseOwner === "worker-1" && row.leaseExpiresAt === START_MS + 1_000));
  assert.notEqual(claimed[0].leaseToken, claimed[1].leaseToken);
  assert.deepEqual(store.claimOutbox({ workerId: "worker-2", limit: 10, leaseMs: 1_000 }), []);

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT delivery_id, attempt_number, worker_id, outcome FROM delivery_attempts ORDER BY attempt_id").all(),
    claimed.map((row) => ({
      delivery_id: row.deliveryId,
      attempt_number: 1,
      worker_id: "worker-1",
      outcome: null
    }))
  );
});

test("ack requires the current lease and is idempotent only for the identical Zulip message", (t) => {
  const { databasePath, store } = databaseFixture(t);
  store.ingest(createdFact("objective-1"));
  store.ingest(deliveryFact("objective-1", "delivery-source", [
    message("objective-1:1", "first"),
    message("objective-1:2", "second")
  ]));
  const [first] = store.claimOutbox({ workerId: "worker-1", limit: 2, leaseMs: 1_000 });

  const ack = store.ackOutbox({
    deliveryId: first.deliveryId,
    leaseToken: first.leaseToken,
    zulipMessageId: 777
  });
  assert.deepEqual(ack, { deliveryId: first.deliveryId, state: "delivered", duplicate: false, zulipMessageId: 777 });
  assert.deepEqual(
    store.ackOutbox({ deliveryId: first.deliveryId, leaseToken: first.leaseToken, zulipMessageId: 777 }),
    { deliveryId: first.deliveryId, state: "delivered", duplicate: true, zulipMessageId: 777 }
  );
  assert.throws(
    () => store.ackOutbox({ deliveryId: first.deliveryId, leaseToken: first.leaseToken, zulipMessageId: 778 }),
    (error) => assertCode(error, "OUTBOX_ACK_CONFLICT")
  );
  assert.throws(
    () => store.ackOutbox({ deliveryId: first.deliveryId, leaseToken: "stale-token", zulipMessageId: 777 }),
    (error) => assertCode(error, "OUTBOX_LEASE_STALE")
  );
  assert.throws(
    () => store.ackOutbox({ deliveryId: "missing", leaseToken: "lease", zulipMessageId: 1 }),
    (error) => assertCode(error, "OUTBOX_DELIVERY_UNKNOWN")
  );
  assert.throws(
    () => store.ackOutbox({ deliveryId: first.deliveryId, leaseToken: first.leaseToken, zulipMessageId: 0 }),
    (error) => assertCode(error, "OUTBOX_ACK_INVALID")
  );

  const [second] = store.claimOutbox({ workerId: "worker-1", limit: 2, leaseMs: 1_000 });
  assert.equal(second.objectiveSequence, 2);

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT state, acknowledged_zulip_message_id FROM zulip_outbox WHERE delivery_id = ?").get(first.deliveryId),
    { state: "delivered", acknowledged_zulip_message_id: 777 }
  );
  assert.deepEqual(
    db.prepare("SELECT outcome, zulip_message_id FROM delivery_attempts WHERE delivery_id = ?").get(first.deliveryId),
    { outcome: "acknowledged", zulip_message_id: 777 }
  );
});

test("retryable nack preserves semantic identity while permanent nack fails the row", (t) => {
  const { databasePath, store } = databaseFixture(t);
  store.ingest(createdFact("objective-1"));
  const enqueued = store.ingest(deliveryFact("objective-1", "delivery-source", [message("stable-key", "payload")]));
  const [firstClaim] = store.claimOutbox({ workerId: "worker-1", limit: 1, leaseMs: 1_000 });

  assert.deepEqual(
    store.nackOutbox({
      deliveryId: firstClaim.deliveryId,
      leaseToken: firstClaim.leaseToken,
      error: "temporary outage",
      retryable: true
    }),
    { deliveryId: firstClaim.deliveryId, state: "pending", retryable: true }
  );

  const [retry] = store.claimOutbox({ workerId: "worker-2", limit: 1, leaseMs: 1_000 });
  assert.equal(retry.deliveryId, enqueued.outbox[0].deliveryId);
  assert.equal(retry.semanticKey, "stable-key");
  assert.equal(retry.objectiveSequence, 1);
  assert.equal(retry.attemptCount, 2);
  assert.notEqual(retry.leaseToken, firstClaim.leaseToken);
  assert.throws(
    () => store.nackOutbox({
      deliveryId: retry.deliveryId,
      leaseToken: firstClaim.leaseToken,
      error: "stale",
      retryable: true
    }),
    (error) => assertCode(error, "OUTBOX_LEASE_STALE")
  );

  assert.deepEqual(
    store.nackOutbox({
      deliveryId: retry.deliveryId,
      leaseToken: retry.leaseToken,
      error: "invalid target",
      retryable: false
    }),
    { deliveryId: retry.deliveryId, state: "failed", retryable: false }
  );
  assert.deepEqual(store.claimOutbox({ workerId: "worker-3", limit: 1, leaseMs: 1_000 }), []);

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT delivery_id, semantic_key, objective_sequence, payload_json, state, attempt_count, last_error FROM zulip_outbox").get(),
    {
      delivery_id: enqueued.outbox[0].deliveryId,
      semantic_key: "stable-key",
      objective_sequence: 1,
      payload_json: '{"content":"payload","type":"stream"}',
      state: "failed",
      attempt_count: 2,
      last_error: "invalid target"
    }
  );
});

test("permanent nack blocks later messages only for the same objective", (t) => {
  const { databasePath, store } = databaseFixture(t);
  for (const objectiveId of ["objective-blocked", "objective-independent"]) {
    store.ingest(createdFact(objectiveId));
    store.ingest(deliveryFact(objectiveId, `deliver-${objectiveId}`, [
      message(`${objectiveId}:1`, "first"),
      message(`${objectiveId}:2`, "second")
    ]));
  }

  const firstClaims = store.claimOutbox({ workerId: "worker-1", limit: 10, leaseMs: 1_000 });
  const blocked = firstClaims.find((row) => row.objectiveId === "objective-blocked");
  const independent = firstClaims.find((row) => row.objectiveId === "objective-independent");
  store.nackOutbox({
    deliveryId: blocked.deliveryId,
    leaseToken: blocked.leaseToken,
    error: "permanent failure",
    retryable: false
  });
  store.ackOutbox({
    deliveryId: independent.deliveryId,
    leaseToken: independent.leaseToken,
    zulipMessageId: 9001
  });

  const [next] = store.claimOutbox({ workerId: "worker-2", limit: 10, leaseMs: 1_000 });
  assert.equal(next.objectiveId, "objective-independent");
  assert.equal(next.objectiveSequence, 2);
  store.ackOutbox({ deliveryId: next.deliveryId, leaseToken: next.leaseToken, zulipMessageId: 9002 });
  assert.deepEqual(store.claimOutbox({ workerId: "worker-3", limit: 10, leaseMs: 1_000 }), []);

  const db = rawDatabase(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT objective_sequence, state FROM zulip_outbox WHERE objective_id = ? ORDER BY objective_sequence")
      .all("objective-blocked"),
    [
      { objective_sequence: 1, state: "failed" },
      { objective_sequence: 2, state: "pending" }
    ]
  );
});

test("restart after claim recovers only after expiry and rejects the stale lease token", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-restart-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: START_MS };
  let nextId = 0;
  const idFactory = (kind) => `${kind}-${++nextId}`;

  const firstStore = openStore({ databasePath, now: () => clock.value, idFactory });
  firstStore.ingest(createdFact("objective-1"));
  firstStore.ingest(deliveryFact("objective-1", "delivery-source", [message("stable", "payload")]));
  const [firstClaim] = firstStore.claimOutbox({ workerId: "worker-1", limit: 1, leaseMs: 1_000 });
  firstStore.close();

  const secondStore = openStore({ databasePath, now: () => clock.value, idFactory });
  assert.deepEqual(secondStore.claimOutbox({ workerId: "worker-2", limit: 1, leaseMs: 1_000 }), []);
  clock.value += 1_001;
  const [recovered] = secondStore.claimOutbox({ workerId: "worker-2", limit: 1, leaseMs: 1_000 });
  assert.equal(recovered.deliveryId, firstClaim.deliveryId);
  assert.equal(recovered.attemptCount, 2);
  assert.notEqual(recovered.leaseToken, firstClaim.leaseToken);
  assert.throws(
    () => secondStore.ackOutbox({
      deliveryId: recovered.deliveryId,
      leaseToken: firstClaim.leaseToken,
      zulipMessageId: 888
    }),
    (error) => assertCode(error, "OUTBOX_LEASE_STALE")
  );
  assert.deepEqual(
    secondStore.ackOutbox({
      deliveryId: recovered.deliveryId,
      leaseToken: recovered.leaseToken,
      zulipMessageId: 888
    }),
    { deliveryId: recovered.deliveryId, state: "delivered", duplicate: false, zulipMessageId: 888 }
  );
  assert.deepEqual(
    secondStore.ackOutbox({
      deliveryId: recovered.deliveryId,
      leaseToken: recovered.leaseToken,
      zulipMessageId: 888
    }),
    { deliveryId: recovered.deliveryId, state: "delivered", duplicate: true, zulipMessageId: 888 }
  );
  secondStore.close();
});

test("durable resource leases retain turn ownership and an absolute expiry", (t) => {
  const { databasePath } = databaseFixture(t);
  const db = rawDatabase(databasePath);
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO resource_leases (resource_type, resource_id, lease_owner, lease_token, acquired_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("turn", "turn-1", "worker-1", "token-1", START_MS, START_MS + 5_000);
  db.close();

  const reopened = rawDatabase(databasePath);
  t.after(() => reopened.open && reopened.close());
  const lease = reopened.prepare("SELECT * FROM resource_leases WHERE resource_type = 'turn' AND resource_id = 'turn-1'").get();
  assert.equal(lease.lease_owner, "worker-1");
  assert.equal(lease.lease_token, "token-1");
  assert.equal(lease.expires_at_ms, START_MS + 5_000);
  assert.equal(lease.expires_at_ms <= START_MS + 4_999, false);
  assert.equal(lease.expires_at_ms <= START_MS + 5_000, true);
});

test("consume is atomic across connections and retains nonces through the 30-second skew window", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-replay-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: START_MS };
  const first = openStore({ databasePath, now: () => clock.value });
  const second = openStore({ databasePath, now: () => clock.value });
  const expiresAt = Math.floor(START_MS / 1000) + 10;

  assert.equal(first.consume({ nonce: "nonce-1", expiresAt }), true);
  assert.equal(second.consume({ nonce: "nonce-1", expiresAt }), false);

  clock.value = expiresAt * 1_000 + 30_000;
  assert.equal(second.consume({ nonce: "nonce-1", expiresAt }), false);

  clock.value += 1;
  assert.equal(second.consume({ nonce: "nonce-1", expiresAt }), true);
  assert.equal(first.consume({ nonce: "", expiresAt }), false);
  assert.equal(first.consume({ nonce: "bad-expiry", expiresAt: 1.5 }), false);

  first.close();
  second.close();
});

test("claim and nack reject malformed input with stable codes", (t) => {
  const { store } = databaseFixture(t);
  for (const options of [
    undefined,
    { workerId: "", limit: 1, leaseMs: 1_000 },
    { workerId: "worker", limit: 0, leaseMs: 1_000 },
    { workerId: "worker", limit: 1, leaseMs: -1 }
  ]) {
    assert.throws(() => store.claimOutbox(options), (error) => assertCode(error, "OUTBOX_CLAIM_INVALID"));
  }

  assert.throws(
    () => store.nackOutbox({ deliveryId: "missing", leaseToken: "token", error: "failure", retryable: true }),
    (error) => assertCode(error, "OUTBOX_DELIVERY_UNKNOWN")
  );
  assert.throws(
    () => store.nackOutbox({ deliveryId: "delivery", leaseToken: "token", error: "", retryable: true }),
    (error) => assertCode(error, "OUTBOX_NACK_INVALID")
  );
});

function coordinationDispatch(overrides = {}) {
  return {
    streamId: 42,
    topic: "Build",
    projectId: "project-1",
    requesterUserId: 3,
    originalZulipMessageId: 900,
    sourceType: "zulip-work-request",
    sourceId: "900",
    callSourceId: "call-source-1",
    objectiveId: "objective-coordination",
    invocationOrigin: "JARVIS",
    callerPrincipalId: "jarvis:topic",
    workBrief: {
      schemaVersion: 1,
      originalText: "Implement the change",
      instruction: "Implement the change",
      constraints: [],
      acceptanceCriteria: ["tests pass"],
      reminders: []
    },
    request: { instruction: "Implement the change" },
    ...overrides
  };
}

function createCoordinatedInteraction(store, overrides = {}) {
  const dispatch = coordinationDispatch(overrides);
  const coordination = store.prepareCoordinationDispatch(dispatch);
  const targetSnapshot = {
    platform: "zulip",
    streamId: dispatch.streamId,
    topic: dispatch.topic,
    sourceMessageId: dispatch.originalZulipMessageId
  };
  store.registerExecutionIntent({
    sourceType: "coordination-call",
    sourceId: coordination.codexCall.codexCallId,
    objectiveId: dispatch.objectiveId,
    projectId: dispatch.projectId,
    backend: "app-server",
    text: "coordinated interaction",
    targetSnapshot,
    topicBinding: {
      streamId: dispatch.streamId,
      topic: dispatch.topic,
      actorUserId: dispatch.requesterUserId
    }
  });
  const threadId = `thread-${dispatch.objectiveId}`;
  const turnId = `turn-${dispatch.objectiveId}`;
  store.bindBackendObjective({ objectiveId: dispatch.objectiveId, backend: "app-server", threadId });
  const prepared = store.prepareTurnSubmission({
    sourceType: "coordination-call",
    sourceId: coordination.codexCall.codexCallId,
    objectiveId: dispatch.objectiveId,
    text: "coordinated interaction",
    targetSnapshot,
    leaseOwner: "state-test"
  });
  store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId });
  store.recordCodexCallSubmission({
    codexCallId: coordination.codexCall.codexCallId,
    objectiveId: dispatch.objectiveId,
    status: "accepted",
    threadId,
    turnId
  });
  const created = store.createInteraction({
    connectionId: `connection-${dispatch.objectiveId}`,
    wireRequestId: `wire-${dispatch.objectiveId}`,
    method: "item/commandExecution/requestApproval",
    objectiveId: dispatch.objectiveId,
    threadId,
    turnId,
    itemId: `item-${dispatch.objectiveId}`,
    approvalId: `approval-${dispatch.objectiveId}`,
    request: { command: "npm test", availableDecisions: ["accept", "cancel"] },
    allowedResponderIds: [dispatch.requesterUserId],
    targetSnapshot,
    renderer: ({ interaction }) => ({
      semanticKey: `interaction:${interaction.interactionId}:prompt`,
      payload: { schemaVersion: 1, kind: "interaction_request", content: "Approval requested." }
    })
  });
  return { coordination, created, dispatch, targetSnapshot };
}

test("uncertain coordinated interaction response notifies the exact caller without resending", (t) => {
  const { store } = databaseFixture(t);
  const fixture = createCoordinatedInteraction(store, {
    sourceId: "interaction-uncertain-work",
    callSourceId: "interaction-uncertain-call",
    objectiveId: "objective-interaction-uncertain",
    jarvisSessionId: "jarvis-interaction-session"
  });
  const interactionId = fixture.created.interaction.interactionId;
  store.commitInteractionAnswer({
    interactionId,
    responderId: fixture.dispatch.requesterUserId,
    targetSnapshot: fixture.targetSnapshot,
    answer: { decision: "accept" }
  });
  const response = store.claimInteractionResponse({
    interactionId,
    leaseOwner: "interaction-response-test"
  });
  store.recordInteractionResponseDelivery({
    interactionId,
    leaseToken: response.leaseToken,
    state: "uncertain"
  });

  const status = store.readWorkStatus(fixture.coordination.workRequest.workRequestId);
  assert.equal(status.workRequest.state, "STATUS_UNVERIFIED");
  assert.equal(status.codexCalls[0].state, "STATUS_UNVERIFIED");
  const [notice] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: fixture.coordination.topicContext.topicContextId,
    workerId: "interaction-notice-worker",
    limit: 10,
    leaseMs: 1_000
  });
  assert.equal(notice.itemType, "STATUS_NOTICE");
  assert.equal(notice.payload.kind, "InteractionStatusNotice");
  assert.equal(notice.payload.reason, "interaction_response_outcome_unverified");
  assert.equal(notice.payload.answerState, "settled_outcome_unverified");
  assert.equal(JSON.stringify(notice.payload).includes("accept"), false);
});

test("orphaned coordinated interaction closes waiting state and reports through the caller mailbox", (t) => {
  const { store } = databaseFixture(t);
  const fixture = createCoordinatedInteraction(store, {
    sourceId: "interaction-orphan-work",
    callSourceId: "interaction-orphan-call",
    objectiveId: "objective-interaction-orphan",
    jarvisSessionId: "jarvis-interaction-orphan-session"
  });

  assert.deepEqual(store.orphanInteractions({
    connectionId: "connection-objective-interaction-orphan"
  }), {
    connectionId: "connection-objective-interaction-orphan",
    orphaned: 1
  });
  const status = store.readWorkStatus(fixture.coordination.workRequest.workRequestId);
  assert.equal(status.workRequest.state, "STATUS_UNVERIFIED");
  assert.equal(status.codexCalls[0].state, "STATUS_UNVERIFIED");
  assert.equal(store.readInteraction(fixture.created.interaction.interactionId).state, "orphaned");
  const [notice] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: fixture.coordination.topicContext.topicContextId,
    workerId: "interaction-orphan-worker",
    limit: 10,
    leaseMs: 1_000
  });
  assert.equal(notice.payload.reason, "interaction_orphaned");
  assert.equal(notice.payload.answerState, "not_settled");
});

test("direct Zulip interaction uncertainty uses the durable outbox fallback", (t) => {
  const { store } = databaseFixture(t);
  const fixture = createCoordinatedInteraction(store, {
    sourceId: "interaction-direct-work",
    callSourceId: "interaction-direct-call",
    objectiveId: "objective-interaction-direct",
    invocationOrigin: "DIRECT_ZULIP",
    callerPrincipalId: "zulip-user:3"
  });
  const [prompt] = store.claimOutbox({ workerId: "direct-prompt", limit: 10, leaseMs: 1_000 });
  store.ackOutbox({
    deliveryId: prompt.deliveryId,
    leaseToken: prompt.leaseToken,
    zulipMessageId: 991
  });
  const interactionId = fixture.created.interaction.interactionId;
  store.commitInteractionAnswer({
    interactionId,
    responderId: fixture.dispatch.requesterUserId,
    targetSnapshot: fixture.targetSnapshot,
    answer: { decision: "accept" }
  });
  const response = store.claimInteractionResponse({ interactionId, leaseOwner: "direct-response" });
  store.recordInteractionResponseDelivery({
    interactionId,
    leaseToken: response.leaseToken,
    state: "uncertain"
  });

  const [promptDelete] = store.claimOutbox({ workerId: "direct-delete", limit: 10, leaseMs: 1_000 });
  assert.equal(promptDelete.payload.kind, "interaction_prompt_delete");
  store.ackOutbox({
    deliveryId: promptDelete.deliveryId,
    leaseToken: promptDelete.leaseToken,
    zulipMessageId: 992
  });
  const [notice] = store.claimOutbox({ workerId: "direct-notice", limit: 10, leaseMs: 1_000 });
  assert.equal(notice.payload.kind, "interaction_status_notice");
  assert.match(notice.payload.content, /not resent/i);
  assert.deepEqual(notice.targetSnapshot, fixture.targetSnapshot);
  assert.equal(store.readWorkStatus(fixture.coordination.workRequest.workRequestId).workRequest.state,
    "STATUS_UNVERIFIED");
});

test("coordination identities are idempotent and objective scope cannot cross topics", (t) => {
  const { store } = databaseFixture(t);
  const first = store.prepareCoordinationDispatch(coordinationDispatch());
  const duplicate = store.prepareCoordinationDispatch(coordinationDispatch());

  assert.equal(first.topicContext.topic, "Build");
  assert.equal(first.workRequest.state, "WAITING_CODEX");
  assert.equal(first.conversation.conversationKind, "TOPIC_PRIMARY");
  assert.equal(first.codexCall.reportTarget.kind, "JARVIS_MAILBOX");
  assert.equal(duplicate.codexCall.codexCallId, first.codexCall.codexCallId);
  assert.deepEqual(store.readObjectiveScope("objective-coordination"), {
    objectiveId: "objective-coordination",
    projectId: "project-1",
    topicContextId: first.topicContext.topicContextId,
    codexConversationId: first.conversation.codexConversationId,
    createdAt: START_MS
  });

  assert.throws(
    () => store.prepareCoordinationDispatch(coordinationDispatch({
      topic: "Other",
      sourceId: "901",
      originalZulipMessageId: 901,
      callSourceId: "call-source-other"
    })),
    (error) => assertCode(error, "OBJECTIVE_TOPIC_MISMATCH")
  );
});

test("a legacy work brief reuses one exact Boss request while independent dispatches create distinct calls", (t) => {
  const { store } = databaseFixture(t);
  const legacy = coordinationDispatch();
  const first = store.prepareCoordinationDispatch(legacy);
  const currentBrief = {
    schemaVersion: legacy.workBrief.schemaVersion,
    originalText: legacy.workBrief.originalText
  };
  const second = store.prepareCoordinationDispatch(coordinationDispatch({
    callSourceId: "call-source-2",
    objectiveId: "objective-coordination-2",
    forceNewConversation: true,
    workBrief: currentBrief,
    request: { instruction: "Review the first result independently" }
  }));

  assert.equal(second.workRequest.workRequestId, first.workRequest.workRequestId);
  assert.notEqual(second.codexCall.codexCallId, first.codexCall.codexCallId);
  assert.notEqual(second.codexCall.objectiveId, first.codexCall.objectiveId);
  assert.equal(store.readWorkStatus(first.workRequest.workRequestId).codexCalls.length, 2);

  for (const [field, value] of [
    ["requesterUserId", 4],
    ["originalZulipMessageId", 901],
    ["workBrief", { schemaVersion: 2, originalText: legacy.workBrief.originalText }],
    ["workBrief", { schemaVersion: 1, originalText: "A different Boss request" }]
  ]) {
    assert.throws(
      () => store.prepareCoordinationDispatch(coordinationDispatch({
        callSourceId: `conflict-${typeof value === "object" ? JSON.stringify(value) : value}`,
        objectiveId: `objective-conflict-${typeof value === "object" ? value.schemaVersion : value}`,
        workBrief: currentBrief,
        [field]: value
      })),
      (error) => assertCode(error, "WORK_REQUEST_SOURCE_CONFLICT")
    );
  }
});

test("turn completion uses the submission call identity when one objective has multiple active calls", (t) => {
  const { store } = databaseFixture(t);
  const first = store.prepareCoordinationDispatch(coordinationDispatch());
  const second = store.prepareCoordinationDispatch(coordinationDispatch({
    callSourceId: "call-source-exact-completion",
    request: { instruction: "Second call on the same objective" }
  }));
  const targetSnapshot = {
    platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 900
  };
  store.registerExecutionIntent({
    sourceType: "coordination-call",
    sourceId: second.codexCall.codexCallId,
    objectiveId: second.codexCall.objectiveId,
    projectId: "project-1",
    backend: "app-server",
    text: "Second call on the same objective",
    targetSnapshot,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  store.bindBackendObjective({
    objectiveId: second.codexCall.objectiveId,
    backend: "app-server",
    threadId: "thread-exact-completion"
  });
  const prepared = store.prepareTurnSubmission({
    sourceType: "coordination-call",
    sourceId: second.codexCall.codexCallId,
    objectiveId: second.codexCall.objectiveId,
    text: "Second call on the same objective",
    targetSnapshot,
    leaseOwner: "test"
  });
  store.acknowledgeTurnSubmission({
    submissionId: prepared.submission.submissionId,
    turnId: "turn-exact-completion"
  });
  store.completeTurn({
    objectiveId: second.codexCall.objectiveId,
    turnId: "turn-exact-completion",
    rawText: "Second call completed",
    itemIds: ["item-exact-completion"],
    sourceType: "app-server",
    sourceId: "completion-exact-call",
    renderer() { throw new Error("Jarvis result must use its mailbox"); }
  });

  assert.equal(store.readCodexCall(second.codexCall.codexCallId).state, "COMPLETED");
  assert.equal(store.readCodexCall(second.codexCall.codexCallId).turnId, "turn-exact-completion");
  assert.equal(store.readCodexCall(first.codexCall.codexCallId).state, "CREATED");
});

test("Jarvis Codex completion is delivered once to its durable mailbox instead of Zulip", (t) => {
  const { store } = databaseFixture(t);
  const coordination = store.prepareCoordinationDispatch(coordinationDispatch());
  const callId = coordination.codexCall.codexCallId;
  const objectiveId = coordination.codexCall.objectiveId;
  const targetSnapshot = { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 900 };
  store.registerExecutionIntent({
    sourceType: "coordination-call",
    sourceId: callId,
    objectiveId,
    projectId: "project-1",
    backend: "app-server",
    text: "Implement the change",
    targetSnapshot,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  store.bindBackendObjective({ objectiveId, backend: "app-server", threadId: "thread-coordination" });
  const prepared = store.prepareTurnSubmission({
    sourceType: "coordination-call",
    sourceId: callId,
    objectiveId,
    text: "Implement the change",
    targetSnapshot,
    leaseOwner: "test"
  });
  store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId: "turn-coordination" });
  store.recordCodexCallSubmission({
    codexCallId: callId,
    objectiveId,
    status: "accepted",
    threadId: "thread-coordination",
    turnId: "turn-coordination"
  });
  const completed = store.completeTurn({
    objectiveId,
    turnId: "turn-coordination",
    rawText: "Verified result",
    itemIds: ["item-1"],
    sourceType: "app-server",
    sourceId: "completion-coordination",
    renderer() {
      throw new Error("Jarvis completion must not render a Zulip delivery");
    }
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.outbox, []);
  assert.equal(store.claimOutbox({ workerId: "zulip", limit: 10, leaseMs: 1_000 }).length, 0);
  assert.deepEqual(store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: coordination.topicContext.topicContextId,
    codexCallId: "another-call",
    workerId: "wrong-call-worker",
    limit: 10,
    leaseMs: 1_000
  }), []);
  const [mail] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: coordination.topicContext.topicContextId,
    codexCallId: callId,
    workerId: "jarvis-worker",
    limit: 10,
    leaseMs: 1_000
  });
  assert.equal(mail.itemType, "CODEX_RECEIPT");
  assert.equal(mail.codexCallId, callId);
  assert.equal(mail.payload.text, "Verified result");
  assert.throws(
    () => store.ackCoordinationMailbox({
      mailboxItemId: mail.mailboxItemId,
      leaseToken: mail.leaseToken,
      finalDelivery: false
    }),
    (error) => assertCode(error, "MAILBOX_DELIVERY_MODE_MISMATCH")
  );
  const acknowledged = store.ackCoordinationMailbox({
    mailboxItemId: mail.mailboxItemId,
    leaseToken: mail.leaseToken,
    finalDelivery: true
  });
  assert.equal(acknowledged.duplicate, false);
  assert.equal(acknowledged.workRequest.state, "COMPLETED");
  assert.equal(store.ackCoordinationMailbox({
    mailboxItemId: mail.mailboxItemId,
    leaseToken: mail.leaseToken,
    finalDelivery: true
  }).duplicate, true);
  assert.deepEqual(store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: coordination.topicContext.topicContextId,
    workerId: "jarvis-worker",
    limit: 10,
    leaseMs: 1_000
  }), []);
});

test("Agent sessions report to the exact parent and require a correction packet for reactivation", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch());
  const created = store.createAgentSession({
    hermesSessionId: "hermes-agent-a",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "reviewer",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Review implementation",
    budget: { turns: 4 },
    maxReactivations: 2
  });
  const report = store.submitAgentReport({
    sourceType: "agent",
    sourceId: "agent-report-1",
    agentSessionId: created.agentSession.agentSessionId,
    agentActivationId: created.activation.agentActivationId,
    status: "completed",
    report: { summary: "Review incomplete", claims: [], verification: [], artifacts: [], unresolved: ["coverage"] }
  });
  assert.equal(typeof report.reportId, "string");
  assert.throws(
    () => store.reactivateAgent({ agentSessionId: created.agentSession.agentSessionId }),
    (error) => assertCode(error, "AGENT_REACTIVATION_INVALID")
  );
  const reactivated = store.reactivateAgent({
    agentSessionId: created.agentSession.agentSessionId,
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Coverage was insufficient",
    correctionInstruction: "Add the missing integration test.",
    reviewFindings: ["No restart coverage"],
    expectedDelta: "A restart integration test and verified result",
    priorArtifacts: ["artifact://agent-report-1"],
    budget: { turns: 2 }
  });
  assert.equal(reactivated.activation.activationNumber, 2);
  assert.equal(reactivated.agentSession.state, "RUNNING");
});

test("Hermes Agent stop reports resolve trusted session scope and are idempotent", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch());
  const created = store.createAgentSession({
    hermesSessionId: "hermes-agent-stop",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "reviewer",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Review implementation",
    budget: { turns: 4 }
  });
  const input = {
    sourceId: "hermes-stop-source-1",
    childHermesSessionId: "hermes-agent-stop",
    parentHermesSessionId: "hermes-jarvis-topic",
    childStatus: "completed",
    summary: "Review verified",
    durationMs: 1250
  };

  const first = store.reportHermesAgentStop(input);
  const duplicate = store.reportHermesAgentStop(input);

  assert.equal(first.disposition, "REPORTED");
  assert.equal(first.duplicate, false);
  assert.equal(first.agentSessionId, created.agentSession.agentSessionId);
  assert.equal(first.activeCodexCalls, 0);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reportId, first.reportId);
  assert.equal(store.readWorkStatus(work.workRequest.workRequestId).agents[0].state, "REPORTED");
  const [mail] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: work.topicContext.topicContextId,
    workerId: "jarvis-report-reader",
    limit: 10,
    leaseMs: 1000
  });
  assert.equal(mail.itemType, "AGENT_REPORT");
  assert.equal(mail.payload.report.summary, "Review verified");
  assert.deepEqual(mail.payload.report.relatedCodexCallIds, []);
});

test("Hermes Agent stop waits for required Codex before accepting a terminal report", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch());
  const created = store.createAgentSession({
    hermesSessionId: "hermes-agent-waiting",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Implement with Codex",
    budget: { turns: 4 }
  });
  const coordination = store.prepareCoordinationDispatch(coordinationDispatch({
    callSourceId: "agent-call-source-waiting",
    objectiveId: "objective-agent-waiting",
    invocationOrigin: "AGENT",
    callerPrincipalId: `agent:${created.agentSession.agentSessionId}`,
    agentSessionId: created.agentSession.agentSessionId,
    agentActivationId: created.activation.agentActivationId,
    forceNewConversation: true
  }));
  const input = {
    sourceId: "hermes-stop-source-waiting",
    childHermesSessionId: "hermes-agent-waiting",
    parentHermesSessionId: "hermes-jarvis-topic",
    childStatus: "failed",
    summary: "Stopped while Codex was active",
    durationMs: 2000
  };

  const waiting = store.reportHermesAgentStop(input);
  assert.equal(waiting.disposition, "WAITING_CODEX");
  assert.equal(waiting.activeCodexCalls, 1);
  let status = store.readWorkStatus(work.workRequest.workRequestId);
  assert.equal(status.workRequest.state, "WAITING_CODEX");
  assert.equal(status.workRequest.statusReason, "agent_waiting_codex");
  assert.equal(status.agents[0].state, "WAITING_CODEX");

  store.recordCodexCallSubmission({
    codexCallId: coordination.codexCall.codexCallId,
    objectiveId: coordination.codexCall.objectiveId,
    status: "terminal_error",
    turnId: null,
    threadId: null
  });
  const reported = store.reportHermesAgentStop(input);
  assert.equal(reported.disposition, "REPORTED");
  assert.equal(reported.activeCodexCalls, 0);
  status = store.readWorkStatus(work.workRequest.workRequestId);
  assert.equal(status.agents[0].state, "FAILED");
});

test("a coordinated Codex submission failure notifies its exact caller without terminating sibling work", (t) => {
  const { store } = databaseFixture(t);
  const coordination = store.prepareCoordinationDispatch(coordinationDispatch({
    sourceId: "coordinated-failure-work",
    callSourceId: "coordinated-failure-call",
    objectiveId: "objective-coordinated-failure",
    jarvisSessionId: "jarvis-failure-session"
  }));

  store.recordCodexCallSubmission({
    codexCallId: coordination.codexCall.codexCallId,
    objectiveId: coordination.codexCall.objectiveId,
    status: "terminal_error",
    turnId: null,
    threadId: null
  });

  const status = store.readWorkStatus(coordination.workRequest.workRequestId);
  assert.equal(status.codexCalls[0].state, "FAILED");
  assert.equal(status.workRequest.state, "RUNNING");
  assert.equal(status.workRequest.statusReason, "caller_review");
  assert.equal(status.pendingMailbox, 1);
  const [failureNotice] = store.listCoordinationMailboxRecovery({
    workerId: "failure-notice-recovery",
    limit: 10
  });
  assert.equal(failureNotice.mailboxItem.targetKind, "JARVIS");
  assert.equal(failureNotice.mailboxItem.targetId, coordination.topicContext.topicContextId);
  assert.equal(failureNotice.mailboxItem.itemType, "STATUS_NOTICE");
  assert.equal(failureNotice.mailboxItem.codexCallId, coordination.codexCall.codexCallId);
  assert.equal(failureNotice.callerHermesSessionId, "jarvis-failure-session");
  assert.equal(failureNotice.mailboxItem.payload.status, "terminal_error");
});

test("nested Hermes Agent reports route only to the exact parent Agent", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch());
  const parent = store.createAgentSession({
    hermesSessionId: "hermes-parent-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "lead",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Lead review",
    budget: { turns: 4 }
  });
  store.createAgentSession({
    hermesSessionId: "hermes-child-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: parent.agentSession.agentSessionId,
    role: "worker",
    triggerPrincipalId: `agent:${parent.agentSession.agentSessionId}`,
    reason: "Nested review",
    budget: { turns: 2 }
  });
  const input = {
    sourceId: "hermes-stop-nested",
    childHermesSessionId: "hermes-child-agent",
    parentHermesSessionId: "hermes-parent-agent",
    childStatus: "completed",
    summary: "Nested result",
    durationMs: 500
  };

  const reported = store.reportHermesAgentStop(input);
  assert.deepEqual(reported.mailboxTarget, {
    kind: "AGENT",
    id: parent.agentSession.agentSessionId
  });
  assert.deepEqual(store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: work.topicContext.topicContextId,
    workerId: "wrong-parent",
    limit: 10,
    leaseMs: 1000
  }), []);
  const [mail] = store.claimCoordinationMailbox({
    targetKind: "AGENT",
    targetId: parent.agentSession.agentSessionId,
    workerId: "exact-parent",
    limit: 10,
    leaseMs: 1000
  });
  assert.equal(mail.payload.report.summary, "Nested result");
  assert.throws(
    () => store.reportHermesAgentStop({ ...input, sourceId: "wrong-parent-source", parentHermesSessionId: "another-agent" }),
    (error) => assertCode(error, "AGENT_PARENT_HERMES_MISMATCH")
  );
});

test("untracked and unknown Hermes Agent stop states have deterministic outcomes", (t) => {
  const { store } = databaseFixture(t);
  assert.deepEqual(store.reportHermesAgentStop({
    sourceId: "untracked-stop",
    childHermesSessionId: "untracked-child",
    parentHermesSessionId: "parent-session",
    childStatus: "completed",
    summary: "Native Hermes only",
    durationMs: 1
  }), {
    duplicate: false,
    disposition: "UNTRACKED",
    reportId: null,
    agentSessionId: null,
    agentActivationId: null,
    activeCodexCalls: 0,
    mailboxItemId: null,
    mailboxTarget: null
  });

  const work = store.ensureCoordinationWorkRequest(coordinationDispatch());
  store.createAgentSession({
    hermesSessionId: "unknown-status-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Unknown status test",
    budget: { turns: 1 }
  });
  const failed = store.reportHermesAgentStop({
    sourceId: "unknown-status-stop",
    childHermesSessionId: "unknown-status-agent",
    parentHermesSessionId: "parent-session",
    childStatus: "future_status",
    summary: "Unexpected runtime state",
    durationMs: 2
  });
  assert.equal(failed.disposition, "REPORTED");
  assert.equal(store.readWorkStatus(work.workRequest.workRequestId).agents[0].state, "FAILED");
  const [mail] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: work.topicContext.topicContextId,
    workerId: "unknown-status-reader",
    limit: 1,
    leaseMs: 1000
  });
  assert.match(mail.payload.report.unresolved[0], /unsupported status future_status/);
});

test("mailbox processing failures retry finitely and then require operator recovery", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "mailbox-failure-work",
    callSourceId: "mailbox-failure-call"
  }));
  store.createAgentSession({
    hermesSessionId: "mailbox-failure-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Mailbox failure test",
    budget: { turns: 1 }
  });
  const report = store.reportHermesAgentStop({
    sourceId: "mailbox-failure-report",
    childHermesSessionId: "mailbox-failure-agent",
    parentHermesSessionId: "jarvis-session",
    childStatus: "completed",
    summary: "Completed work",
    durationMs: 1
  });
  assert.equal(report.disposition, "REPORTED");

  let rejected;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const [item] = store.claimCoordinationMailbox({
      targetKind: "JARVIS",
      targetId: work.topicContext.topicContextId,
      mailboxItemId: report.mailboxItemId,
      workerId: `failure-worker-${attempt}`,
      limit: 1,
      leaseMs: 1_000
    });
    assert.equal(item.attemptCount, attempt);
    rejected = store.nackCoordinationMailbox({
      mailboxItemId: item.mailboxItemId,
      leaseToken: item.leaseToken,
      error: "caller resume failed",
      retryable: true
    });
    assert.equal(rejected.retryable, attempt < 8);
    assert.equal(rejected.mailboxItem.state, attempt < 8 ? "PENDING" : "DEAD");
  }
  assert.equal(rejected.workRequest.state, "DEGRADED_PENDING_OPERATOR");
  assert.equal(rejected.workRequest.statusReason, "mailbox_delivery_failed");
  assert.equal(rejected.mailboxItem.lastError, "caller resume failed");
  assert.deepEqual(store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: work.topicContext.topicContextId,
    workerId: "post-dead-worker",
    limit: 1,
    leaseMs: 1_000
  }), []);
});

test("restart recovery exposes exact durable scope and abandons uncertain leases", (t) => {
  const { clock, store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "recovery-work",
    callSourceId: "recovery-call",
    jarvisSessionId: "jarvis-recovery-session"
  }));
  const agent = store.createAgentSession({
    hermesSessionId: "agent-recovery-session",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "reviewer",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Recovery test",
    budget: { turns: 1 }
  });
  const report = store.reportHermesAgentStop({
    sourceId: "recovery-agent-report",
    childHermesSessionId: "agent-recovery-session",
    parentHermesSessionId: "jarvis-recovery-session",
    childStatus: "completed",
    summary: "Recovered report",
    durationMs: 1
  });
  assert.equal(report.disposition, "REPORTED");

  const [pending] = store.listCoordinationMailboxRecovery({
    workerId: "recovery-scanner",
    limit: 10
  });
  assert.equal(pending.mailboxItem.mailboxItemId, report.mailboxItemId);
  assert.equal(pending.mailboxItem.state, "PENDING");
  assert.equal(pending.mailboxItem.attemptCount, 0);
  assert.equal(pending.projectId, "project-1");
  assert.equal(pending.topicContextId, work.topicContext.topicContextId);
  assert.equal(pending.streamId, 42);
  assert.equal(pending.topic, "Build");
  assert.equal(pending.callerHermesSessionId, "jarvis-recovery-session");
  assert.equal(pending.parentHermesSessionId, null);
  assert.equal(pending.agentRole, null);
  assert.equal(pending.workBrief.originalText, "Implement the change");
  assert.equal(agent.agentSession.hermesSessionId, "agent-recovery-session");

  const [leased] = store.claimCoordinationMailbox({
    targetKind: "JARVIS",
    targetId: work.topicContext.topicContextId,
    mailboxItemId: report.mailboxItemId,
    workerId: "crashed-worker",
    limit: 1,
    leaseMs: 1_000
  });
  clock.value += 1_001;
  const [uncertain] = store.listCoordinationMailboxRecovery({
    workerId: "restart-scanner",
    limit: 10
  });
  assert.equal(uncertain.mailboxItem.state, "LEASED");
  assert.equal(uncertain.mailboxItem.attemptCount, 1);
  const abandoned = store.abandonCoordinationMailboxRecovery({
    mailboxItemId: leased.mailboxItemId,
    expectedState: "LEASED",
    expectedAttemptCount: 1,
    reason: "recovery_outcome_unverified"
  });
  assert.equal(abandoned.duplicate, false);
  assert.equal(abandoned.mailboxItem.state, "DEAD");
  assert.equal(abandoned.mailboxItem.lastError, "recovery_outcome_unverified");
  assert.equal(abandoned.workRequest.state, "DEGRADED_PENDING_OPERATOR");
  assert.deepEqual(store.listCoordinationMailboxRecovery({
    workerId: "after-abandon",
    limit: 10
  }), []);

  const orphanWork = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "agent-orphan-work",
    originalZulipMessageId: 901,
    jarvisSessionId: "jarvis-recovery-session"
  }));
  const orphanAgent = store.createAgentSession({
    hermesSessionId: "agent-orphan-session",
    workRequestId: orphanWork.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "reviewer",
    triggerPrincipalId: `jarvis:${orphanWork.topicContext.topicContextId}`,
    reason: "Agent orphan recovery test",
    budget: { turns: 1 }
  });
  const agentCall = store.prepareCoordinationDispatch(coordinationDispatch({
    sourceId: "agent-orphan-work",
    originalZulipMessageId: 901,
    callSourceId: "recovery-agent-call",
    objectiveId: "objective-recovery-agent",
    invocationOrigin: "AGENT",
    callerPrincipalId: `agent:${orphanAgent.agentSession.agentSessionId}`,
    agentSessionId: orphanAgent.agentSession.agentSessionId,
    agentActivationId: orphanAgent.activation.agentActivationId,
    forceNewConversation: true,
    jarvisSessionId: "jarvis-recovery-session"
  }));
  const agentTarget = {
    platform: "zulip",
    streamId: 42,
    topic: "Build",
    sourceMessageId: 901
  };
  store.registerExecutionIntent({
    sourceType: "coordination-call",
    sourceId: agentCall.codexCall.codexCallId,
    objectiveId: agentCall.codexCall.objectiveId,
    projectId: "project-1",
    backend: "app-server",
    text: "Recover Agent work",
    targetSnapshot: agentTarget,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  store.bindBackendObjective({
    objectiveId: agentCall.codexCall.objectiveId,
    backend: "app-server",
    threadId: "thread-recovery-agent"
  });
  const submission = store.prepareTurnSubmission({
    sourceType: "coordination-call",
    sourceId: agentCall.codexCall.codexCallId,
    objectiveId: agentCall.codexCall.objectiveId,
    text: "Recover Agent work",
    targetSnapshot: agentTarget,
    leaseOwner: "test"
  });
  store.acknowledgeTurnSubmission({
    submissionId: submission.submission.submissionId,
    turnId: "turn-recovery-agent"
  });
  store.recordCodexCallSubmission({
    codexCallId: agentCall.codexCall.codexCallId,
    objectiveId: agentCall.codexCall.objectiveId,
    status: "accepted",
    threadId: "thread-recovery-agent",
    turnId: "turn-recovery-agent"
  });
  store.completeTurn({
    objectiveId: agentCall.codexCall.objectiveId,
    turnId: "turn-recovery-agent",
    rawText: "Recovered Agent result",
    itemIds: ["item-recovery-agent"],
    sourceType: "app-server",
    sourceId: "completion-recovery-agent",
    renderer() {
      throw new Error("Agent completion must not render a Zulip delivery");
    }
  });
  const [agentRecovery] = store.listCoordinationMailboxRecovery({
    workerId: "agent-recovery-scanner",
    limit: 10
  });
  assert.equal(agentRecovery.mailboxItem.targetKind, "AGENT");
  assert.equal(agentRecovery.mailboxItem.targetId, orphanAgent.agentSession.agentSessionId);
  assert.equal(agentRecovery.callerHermesSessionId, "agent-orphan-session");
  assert.equal(agentRecovery.parentHermesSessionId, "jarvis-recovery-session");
  assert.equal(agentRecovery.agentRole, "reviewer");
  const [claimedAgentRecovery] = store.claimCoordinationMailbox({
    targetKind: "AGENT",
    targetId: orphanAgent.agentSession.agentSessionId,
    mailboxItemId: agentRecovery.mailboxItem.mailboxItemId,
    workerId: "crashed-agent-recovery-worker",
    limit: 1,
    leaseMs: 1_000
  });
  clock.value += 1_001;
  const transferred = store.abandonCoordinationMailboxRecovery({
    mailboxItemId: claimedAgentRecovery.mailboxItemId,
    expectedState: "LEASED",
    expectedAttemptCount: 1,
    reason: "recovery_outcome_unverified"
  });
  assert.equal(transferred.mailboxItem.state, "DEAD");
  assert.equal(transferred.mailboxItem.lastError, "orphaned:recovery_outcome_unverified");
  assert.equal(transferred.workRequest.state, "RUNNING");
  assert.equal(transferred.workRequest.statusReason, "caller_review");
  const statusAfterOrphan = store.readWorkStatus(orphanWork.workRequest.workRequestId);
  assert.equal(statusAfterOrphan.agents[0].state, "FAILED_ORPHANED");
  const [orphanNotice] = store.listCoordinationMailboxRecovery({
    workerId: "orphan-notice-recovery",
    limit: 10
  });
  assert.equal(orphanNotice.mailboxItem.targetKind, "JARVIS");
  assert.equal(orphanNotice.mailboxItem.itemType, "ORPHAN_RECOVERY_NOTICE");
  assert.equal(orphanNotice.callerHermesSessionId, "jarvis-recovery-session");
  assert.deepEqual(orphanNotice.mailboxItem.payload.recoveryOptions, [
    "reactivate_same_agent",
    "create_replacement_agent",
    "cancel_work"
  ]);
  assert.deepEqual(orphanNotice.mailboxItem.payload.protectedResultRef, {
    kind: "coordination_mailbox",
    mailboxItemId: claimedAgentRecovery.mailboxItemId,
    codexCallId: agentCall.codexCall.codexCallId
  });
  assert.equal(JSON.stringify(orphanNotice.mailboxItem.payload).includes("Recovered Agent result"), false);
});

test("Hermes restart recovery orphans only pre-start active Agent activations", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "restart-agent-work",
    originalZulipMessageId: 902,
    jarvisSessionId: "jarvis-restart-session"
  }));
  const agent = store.createAgentSession({
    hermesSessionId: "agent-before-restart",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Restart recovery test",
    budget: { turns: 1 }
  });

  assert.deepEqual(store.listCoordinationAgentRestartRecovery({
    startedBefore: START_MS,
    limit: 10
  }), []);
  const [candidate] = store.listCoordinationAgentRestartRecovery({
    startedBefore: START_MS + 1,
    limit: 10
  });
  assert.equal(candidate.agentSessionId, agent.agentSession.agentSessionId);
  assert.equal(candidate.hermesSessionId, "agent-before-restart");
  assert.equal(candidate.agentActivationId, agent.activation.agentActivationId);
  assert.equal(candidate.agentState, "RUNNING");
  assert.equal(candidate.parentHermesSessionId, null);
  assert.equal(candidate.jarvisSessionId, "jarvis-restart-session");

  const orphaned = store.orphanCoordinationAgentRestart({
    agentSessionId: candidate.agentSessionId,
    agentActivationId: candidate.agentActivationId,
    expectedState: candidate.agentState,
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  });
  assert.equal(orphaned.duplicate, false);
  assert.equal(orphaned.agentSession.state, "FAILED_ORPHANED");
  assert.equal(orphaned.workRequest.state, "RUNNING");
  assert.equal(orphaned.workRequest.statusReason, "caller_review");
  assert.equal(orphaned.mailboxItem.targetKind, "JARVIS");
  assert.equal(orphaned.mailboxItem.itemType, "ORPHAN_RECOVERY_NOTICE");
  assert.equal(orphaned.mailboxItem.payload.failedHermesSessionId, "agent-before-restart");
  assert.deepEqual(orphaned.mailboxItem.payload.protectedResultRef, {
    kind: "agent_activation",
    agentActivationId: agent.activation.agentActivationId
  });
  assert.equal(store.orphanCoordinationAgentRestart({
    agentSessionId: candidate.agentSessionId,
    agentActivationId: candidate.agentActivationId,
    expectedState: candidate.agentState,
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  }).duplicate, true);
  assert.throws(() => store.orphanCoordinationAgentRestart({
    agentSessionId: candidate.agentSessionId,
    agentActivationId: "activation-stale",
    expectedState: candidate.agentState,
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  }), (error) => assertCode(error, "AGENT_RECOVERY_CONFLICT"));
  assert.deepEqual(store.listCoordinationAgentRestartRecovery({
    startedBefore: START_MS + 1,
    limit: 10
  }), []);
});

test("Hermes restart recovery CAS preserves an Agent that reported after the scan", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "restart-cas-work",
    originalZulipMessageId: 903,
    jarvisSessionId: "jarvis-restart-cas"
  }));
  const agent = store.createAgentSession({
    hermesSessionId: "agent-restart-cas",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "CAS recovery test",
    budget: { turns: 1 }
  });
  const [candidate] = store.listCoordinationAgentRestartRecovery({
    startedBefore: START_MS + 1,
    limit: 10
  });
  store.reportHermesAgentStop({
    sourceId: "restart-cas-report",
    childHermesSessionId: "agent-restart-cas",
    parentHermesSessionId: "jarvis-restart-cas",
    childStatus: "completed",
    summary: "Completed before orphan transition",
    durationMs: 10
  });

  assert.throws(() => store.orphanCoordinationAgentRestart({
    agentSessionId: candidate.agentSessionId,
    agentActivationId: candidate.agentActivationId,
    expectedState: candidate.agentState,
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  }), (error) => assertCode(error, "AGENT_RECOVERY_CONFLICT"));
  assert.equal(store.readWorkStatus(work.workRequest.workRequestId).agents[0].state, "REPORTED");
});

test("Hermes restart orphan notice targets the exact parent Agent", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "restart-nested-work",
    originalZulipMessageId: 904,
    jarvisSessionId: "jarvis-restart-nested"
  }));
  const parent = store.createAgentSession({
    hermesSessionId: "restart-parent-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "lead",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Supervise nested recovery",
    budget: { turns: 2 }
  });
  const child = store.createAgentSession({
    hermesSessionId: "restart-child-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: parent.agentSession.agentSessionId,
    role: "worker",
    triggerPrincipalId: `agent:${parent.agentSession.agentSessionId}`,
    reason: "Nested recovery target",
    budget: { turns: 1 }
  });
  const orphaned = store.orphanCoordinationAgentRestart({
    agentSessionId: child.agentSession.agentSessionId,
    agentActivationId: child.activation.agentActivationId,
    expectedState: "RUNNING",
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  });

  assert.equal(orphaned.mailboxItem.targetKind, "AGENT");
  assert.equal(orphaned.mailboxItem.targetId, parent.agentSession.agentSessionId);
  assert.equal(orphaned.workRequest.supervisorPrincipalId, `agent:${parent.agentSession.agentSessionId}`);
});

test("Hermes restart orphan without a live supervisor degrades to operator", (t) => {
  const { store } = databaseFixture(t);
  const work = store.ensureCoordinationWorkRequest(coordinationDispatch({
    sourceId: "restart-operator-work",
    originalZulipMessageId: 905,
    jarvisSessionId: null
  }));
  const agent = store.createAgentSession({
    hermesSessionId: "restart-operator-agent",
    workRequestId: work.workRequest.workRequestId,
    parentAgentSessionId: null,
    role: "worker",
    triggerPrincipalId: `jarvis:${work.topicContext.topicContextId}`,
    reason: "Operator fallback test",
    budget: { turns: 1 }
  });
  const orphaned = store.orphanCoordinationAgentRestart({
    agentSessionId: agent.agentSession.agentSessionId,
    agentActivationId: agent.activation.agentActivationId,
    expectedState: "RUNNING",
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  });

  assert.equal(orphaned.mailboxItem, null);
  assert.equal(orphaned.workRequest.state, "DEGRADED_PENDING_OPERATOR");
  assert.equal(orphaned.workRequest.statusReason, "orphan_supervisor_unavailable");
  store.readWorkStatus(work.workRequest.workRequestId);
  assert.equal(store.orphanCoordinationAgentRestart({
    agentSessionId: agent.agentSession.agentSessionId,
    agentActivationId: agent.activation.agentActivationId,
    expectedState: "RUNNING",
    startedBefore: START_MS + 1,
    reason: "hermes_restart_outcome_unverified"
  }).duplicate, true);
});

test("authority delegation narrows scope and write leases require ordered fenced acquisition", (t) => {
  const { store } = databaseFixture(t);
  const topic = store.ensureTopicContext({
    streamId: 42,
    topic: "Build",
    projectId: "project-1",
    sourceType: "test",
    sourceId: "topic-authority"
  }).topicContext;
  const authority = store.createAuthorityEnvelope({
    grantorPrincipalId: "boss:3",
    granteePrincipalId: "jarvis:topic",
    topicContextId: topic.topicContextId,
    projectId: "project-1",
    operationClasses: ["file_change"],
    resourcePatterns: ["src/"],
    pathScope: ["/project/src"],
    networkScope: [],
    riskCeiling: 1,
    canDelegate: true,
    maxDelegationDepth: 1,
    maxUses: 2,
    validFrom: START_MS - 1,
    expiresAt: START_MS + 10_000,
    policyRevision: 1
  });
  assert.equal(store.evaluateAuthorization({
    authorizationContextId: authority.authorizationContextId,
    principalId: "jarvis:topic",
    topicContextId: topic.topicContextId,
    projectId: "project-1",
    operationClass: "file_change",
    path: "/project/src/a.js",
    riskLevel: 1,
    policyRevision: 1
  }).decision, "JARVIS_DECIDE");
  assert.equal(store.evaluateAuthorization({
    authorizationContextId: authority.authorizationContextId,
    principalId: "jarvis:topic",
    topicContextId: topic.topicContextId,
    projectId: "project-1",
    operationClass: "file_change",
    path: "/other/a.js",
    riskLevel: 1,
    policyRevision: 1
  }).decision, "DENY");

  assert.throws(() => store.acquireCoordinationWriteLeases({
    ownerActivationId: "activation-a",
    leaseMs: 1_000,
    resources: [
      { resourceType: "path", resourceId: "z" },
      { resourceType: "path", resourceId: "a" }
    ]
  }), (error) => assertCode(error, "RESOURCE_LEASE_ORDER_INVALID"));
  const acquired = store.acquireCoordinationWriteLeases({
    ownerActivationId: "activation-a",
    leaseMs: 1_000,
    resources: [
      { resourceType: "path", resourceId: "a" },
      { resourceType: "path", resourceId: "z" }
    ]
  });
  assert.equal(acquired.acquired, true);
  assert.deepEqual(acquired.leases.map((lease) => lease.fencingToken), [1, 1]);
  assert.equal(store.acquireCoordinationWriteLeases({
    ownerActivationId: "activation-b",
    leaseMs: 1_000,
    resources: [{ resourceType: "path", resourceId: "a" }]
  }).reason, "RESOURCE_BUSY");
  assert.equal(store.releaseCoordinationWriteLeases({
    ownerActivationId: "activation-a",
    leases: acquired.leases.map(({ resourceType, resourceId, leaseToken }) => ({ resourceType, resourceId, leaseToken }))
  }).released, 2);
});
