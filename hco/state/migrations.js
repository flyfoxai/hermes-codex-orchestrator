const OWNED_ERRORS = new WeakSet();

function storeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isMigrationStoreError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

const INITIAL_SCHEMA = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER schema_migrations_no_update
  BEFORE UPDATE ON schema_migrations
  BEGIN
    SELECT RAISE(ABORT, 'schema_migrations is append-only');
  END;

  CREATE TRIGGER schema_migrations_no_delete
  BEFORE DELETE ON schema_migrations
  BEGIN
    SELECT RAISE(ABORT, 'schema_migrations is append-only');
  END;

  CREATE TABLE event_journal (
    ingestion_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_record_id TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
    event_schema_version INTEGER NOT NULL CHECK (event_schema_version > 0),
    event_name TEXT NOT NULL,
    event_mode TEXT NOT NULL CHECK (event_mode IN ('normal', 'reconciliation', 'correction')),
    payload_json TEXT NOT NULL,
    integrity_json TEXT NOT NULL,
    project_id TEXT,
    delivery_target_id TEXT,
    objective_id TEXT,
    thread_id TEXT,
    turn_id TEXT,
    item_id TEXT,
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE TRIGGER event_journal_no_update
  BEFORE UPDATE ON event_journal
  BEGIN
    SELECT RAISE(ABORT, 'event_journal is append-only');
  END;

  CREATE TRIGGER event_journal_no_delete
  BEFORE DELETE ON event_journal
  BEGIN
    SELECT RAISE(ABORT, 'event_journal is append-only');
  END;

  CREATE TABLE objectives (
    objective_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('created', 'running', 'completed')),
    state_rank INTEGER NOT NULL CHECK (state_rank BETWEEN 0 AND 2),
    next_outbox_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_outbox_sequence > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    created_event_record_id TEXT NOT NULL REFERENCES event_journal(event_record_id)
  ) STRICT;

  CREATE TABLE zulip_outbox (
    delivery_id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL REFERENCES objectives(objective_id),
    semantic_key TEXT NOT NULL UNIQUE,
    objective_sequence INTEGER NOT NULL CHECK (objective_sequence > 0),
    payload_json TEXT NOT NULL,
    target_snapshot_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at_ms INTEGER,
    last_error TEXT,
    acknowledged_zulip_message_id INTEGER CHECK (acknowledged_zulip_message_id > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    event_record_id TEXT NOT NULL REFERENCES event_journal(event_record_id),
    UNIQUE (objective_id, objective_sequence)
  ) STRICT;

  CREATE INDEX zulip_outbox_claimable
  ON zulip_outbox(state, lease_expires_at_ms, created_at_ms);

  CREATE TRIGGER zulip_outbox_immutable_semantics
  BEFORE UPDATE ON zulip_outbox
  WHEN NEW.delivery_id IS NOT OLD.delivery_id
    OR NEW.objective_id IS NOT OLD.objective_id
    OR NEW.semantic_key IS NOT OLD.semantic_key
    OR NEW.objective_sequence IS NOT OLD.objective_sequence
    OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.target_snapshot_json IS NOT OLD.target_snapshot_json
    OR NEW.created_at_ms IS NOT OLD.created_at_ms
    OR NEW.event_record_id IS NOT OLD.event_record_id
  BEGIN
    SELECT RAISE(ABORT, 'zulip_outbox semantic fields are immutable');
  END;

  CREATE TRIGGER zulip_outbox_ack_immutable
  BEFORE UPDATE OF acknowledged_zulip_message_id ON zulip_outbox
  WHEN OLD.acknowledged_zulip_message_id IS NOT NULL
    AND NEW.acknowledged_zulip_message_id IS NOT OLD.acknowledged_zulip_message_id
  BEGIN
    SELECT RAISE(ABORT, 'zulip_outbox acknowledgement is immutable');
  END;

  CREATE TABLE delivery_attempts (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL REFERENCES zulip_outbox(delivery_id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    worker_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
    completed_at_ms INTEGER,
    outcome TEXT,
    error TEXT,
    zulip_message_id INTEGER CHECK (zulip_message_id > 0),
    UNIQUE (delivery_id, attempt_number),
    UNIQUE (delivery_id, lease_token)
  ) STRICT;

  CREATE TABLE resource_leases (
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    lease_owner TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > acquired_at_ms),
    PRIMARY KEY (resource_type, resource_id)
  ) STRICT;

  CREATE INDEX resource_leases_expiry ON resource_leases(expires_at_ms);

  CREATE TABLE replay_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at_seconds INTEGER NOT NULL,
    retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms >= 0),
    consumed_at_ms INTEGER NOT NULL CHECK (consumed_at_ms >= 0)
  ) STRICT;

  CREATE INDEX replay_nonces_retention ON replay_nonces(retain_until_ms);
`;

const DURABLE_EXECUTION_SCHEMA = `
  CREATE TABLE objective_execution (
    objective_id TEXT PRIMARY KEY REFERENCES objectives(objective_id),
    backend TEXT NOT NULL CHECK (backend IN ('app-server', 'tmux')),
    execution_status TEXT NOT NULL CHECK (execution_status IN (
      'idle', 'starting', 'ready', 'submitting', 'running',
      'submission_unknown', 'reconciliation_needed', 'backend_unavailable',
      'completed', 'cancelled', 'terminal_error'
    )),
    backend_objective_started INTEGER NOT NULL DEFAULT 0 CHECK (backend_objective_started IN (0, 1)),
    app_server_thread_id TEXT,
    thread_start_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (thread_start_uncertain IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (backend = 'app-server' OR app_server_thread_id IS NULL)
  ) STRICT;

  CREATE UNIQUE INDEX objective_execution_thread_binding
  ON objective_execution(app_server_thread_id)
  WHERE app_server_thread_id IS NOT NULL;

  CREATE TABLE turn_submissions (
    submission_id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    client_user_message_id TEXT NOT NULL UNIQUE,
    input_text TEXT NOT NULL,
    target_snapshot_json TEXT NOT NULL,
    turn_id TEXT,
    submission_state TEXT NOT NULL CHECK (submission_state IN (
      'intent', 'running', 'submission_unknown', 'reconciliation_needed',
      'completed', 'cancelled', 'terminal_error'
    )),
    terminal_status TEXT,
    cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
    reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_required IN (0, 1)),
    lease_owner TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    UNIQUE (objective_id, turn_id)
  ) STRICT;

  CREATE UNIQUE INDEX turn_submissions_one_active
  ON turn_submissions(objective_id)
  WHERE submission_state IN ('intent', 'running', 'submission_unknown', 'reconciliation_needed');

  CREATE TABLE inbound_intents (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    submission_id TEXT REFERENCES turn_submissions(submission_id),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (source_type, source_id)
  ) STRICT;

  CREATE TABLE turn_outputs (
    submission_id TEXT PRIMARY KEY REFERENCES turn_submissions(submission_id),
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    turn_id TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    selected_item_ids_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (objective_id, turn_id)
  ) STRICT;

  CREATE TRIGGER turn_outputs_no_update
  BEFORE UPDATE ON turn_outputs
  BEGIN
    SELECT RAISE(ABORT, 'turn_outputs is immutable');
  END;

  CREATE TRIGGER turn_outputs_no_delete
  BEFORE DELETE ON turn_outputs
  BEGIN
    SELECT RAISE(ABORT, 'turn_outputs is immutable');
  END;

  CREATE TABLE pending_interactions (
    interaction_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    wire_id_type TEXT NOT NULL CHECK (wire_id_type IN ('string', 'number')),
    wire_id_json TEXT NOT NULL,
    method TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT,
    approval_id TEXT,
    correlation_key TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    allowed_responder_ids_json TEXT NOT NULL,
    target_snapshot_json TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'orphaned', 'expired')),
    answer_json TEXT,
    answered_by_id TEXT,
    answered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    UNIQUE (connection_id, wire_id_type, wire_id_json),
    CHECK ((state = 'answered') = (answer_json IS NOT NULL))
  ) STRICT;

  CREATE INDEX pending_interactions_lookup
  ON pending_interactions(objective_id, state, expires_at_ms);

  CREATE TABLE turn_audit_facts (
    fact_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    submission_id TEXT REFERENCES turn_submissions(submission_id),
    fact_json TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    UNIQUE (source_type, source_id)
  ) STRICT;
`;

const INTERACTION_RESPONSE_DELIVERY_SCHEMA = `
  ALTER TABLE pending_interactions
  ADD COLUMN response_delivery_state TEXT NOT NULL DEFAULT 'not_answered'
    CHECK (response_delivery_state IN ('not_answered', 'pending', 'retryable', 'uncertain', 'delivered'));

  ALTER TABLE pending_interactions
  ADD COLUMN response_delivery_updated_at_ms INTEGER
    CHECK (response_delivery_updated_at_ms IS NULL OR response_delivery_updated_at_ms >= 0);

  UPDATE pending_interactions
  SET response_delivery_state = 'pending', response_delivery_updated_at_ms = answered_at_ms
  WHERE state = 'answered';
`;

const IMMUTABLE_INTERACTION_ANSWER_SETTLEMENTS_SCHEMA = `
  CREATE TABLE interaction_answer_settlements (
    interaction_id TEXT PRIMARY KEY REFERENCES pending_interactions(interaction_id),
    answer_json TEXT NOT NULL,
    answered_by_id TEXT NOT NULL,
    answered_at_ms INTEGER NOT NULL CHECK (answered_at_ms >= 0)
  ) STRICT;

  INSERT INTO interaction_answer_settlements (
    interaction_id, answer_json, answered_by_id, answered_at_ms
  )
  SELECT interaction_id, answer_json, answered_by_id, answered_at_ms
  FROM pending_interactions
  WHERE answer_json IS NOT NULL;

  CREATE TRIGGER interaction_answer_settlements_no_update
  BEFORE UPDATE ON interaction_answer_settlements
  BEGIN
    SELECT RAISE(ABORT, 'interaction answer settlements are immutable');
  END;

  CREATE TRIGGER interaction_answer_settlements_no_delete
  BEFORE DELETE ON interaction_answer_settlements
  BEGIN
    SELECT RAISE(ABORT, 'interaction answer settlements are immutable');
  END;
`;

const ROUTE_ACL_CONTROL_PLANE_SCHEMA = `
  CREATE TABLE control_plane_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  INSERT INTO control_plane_meta (singleton, generation, updated_at_ms)
  VALUES (1, 0, 0);

  CREATE TABLE static_registry_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    mapping_sha256 TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK ((initialized = 1) = (mapping_sha256 IS NOT NULL))
  ) STRICT;

  INSERT INTO static_registry_meta (singleton, initialized, revision, mapping_sha256, updated_at_ms)
  VALUES (1, 0, 0, NULL, 0);

  CREATE TABLE static_stream_routes (
    stream_id INTEGER PRIMARY KEY CHECK (stream_id > 0),
    project_id TEXT NOT NULL
  ) STRICT;

  CREATE TABLE runtime_stream_routes (
    stream_id INTEGER PRIMARY KEY CHECK (stream_id > 0),
    override_kind TEXT NOT NULL CHECK (override_kind IN ('project', 'hermes')),
    project_id TEXT,
    actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK ((override_kind = 'project') = (project_id IS NOT NULL)),
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE TABLE topic_aliases (
    alias_id TEXT PRIMARY KEY,
    stream_id INTEGER NOT NULL CHECK (stream_id > 0),
    topic TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    inactivated_by_user_id INTEGER CHECK (inactivated_by_user_id > 0),
    inactivated_at_ms INTEGER CHECK (inactivated_at_ms >= 0)
  ) STRICT;

  CREATE UNIQUE INDEX topic_aliases_one_active_address
  ON topic_aliases(stream_id, topic) WHERE active = 1;

  CREATE TABLE topic_modes (
    alias_id TEXT PRIMARY KEY REFERENCES topic_aliases(alias_id),
    mode TEXT NOT NULL CHECK (mode IN ('HERMES_ONLY', 'CODEX_BOUND')),
    project_id TEXT,
    objective_id TEXT REFERENCES objective_execution(objective_id),
    thread_id TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
      (mode = 'HERMES_ONLY' AND project_id IS NULL AND objective_id IS NULL AND thread_id IS NULL)
      OR
      (mode = 'CODEX_BOUND' AND project_id IS NOT NULL AND objective_id IS NOT NULL AND thread_id IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE objective_projects (
    objective_id TEXT PRIMARY KEY REFERENCES objective_execution(objective_id),
    project_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER objective_projects_no_update
  BEFORE UPDATE ON objective_projects
  BEGIN
    SELECT RAISE(ABORT, 'objective project binding is immutable');
  END;

  CREATE TRIGGER objective_projects_no_delete
  BEFORE DELETE ON objective_projects
  BEGIN
    SELECT RAISE(ABORT, 'objective project binding is immutable');
  END;

  CREATE TABLE execution_topic_intents (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    project_id TEXT NOT NULL,
    stream_id INTEGER NOT NULL CHECK (stream_id > 0),
    topic TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    promoted_at_ms INTEGER CHECK (promoted_at_ms >= 0),
    PRIMARY KEY (source_type, source_id)
  ) STRICT;
`;

const INTERACTION_PARTIAL_ANSWERS_SCHEMA = `
  ALTER TABLE pending_interactions
  ADD COLUMN partial_answers_json TEXT;
`;

const migrations = [
  Object.freeze({
    version: 1,
    name: "initial_authority",
    up(db) {
      db.exec(INITIAL_SCHEMA);
    }
  }),
  Object.freeze({
    version: 2,
    name: "durable_execution_controller",
    up(db) {
      db.exec(DURABLE_EXECUTION_SCHEMA);
    }
  }),
  Object.freeze({
    version: 3,
    name: "interaction_response_delivery",
    up(db) {
      db.exec(INTERACTION_RESPONSE_DELIVERY_SCHEMA);
    }
  }),
  Object.freeze({
    version: 4,
    name: "immutable_interaction_answer_settlements",
    up(db) {
      db.exec(IMMUTABLE_INTERACTION_ANSWER_SETTLEMENTS_SCHEMA);
    }
  })
];

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "route_acl_control_plane",
  up(db) {
    db.exec(ROUTE_ACL_CONTROL_PLANE_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "interaction_partial_answers",
  up(db) {
    db.exec(INTERACTION_PARTIAL_ANSWERS_SCHEMA);
  }
}));

export const MIGRATIONS = Object.freeze(migrations);

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw storeError("STORE_MIGRATIONS_INVALID", "Store migrations must be a non-empty array.");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (
      migration === null ||
      typeof migration !== "object" ||
      migration.version !== index + 1 ||
      typeof migration.name !== "string" ||
      migration.name.length === 0 ||
      typeof migration.up !== "function"
    ) {
      throw storeError("STORE_MIGRATIONS_INVALID", "Store migrations must have contiguous versions and valid names.");
    }
  }
}

function historyExists(db) {
  return db.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get().count === 1;
}

export function applyMigrations(db, { migrations = MIGRATIONS, now }) {
  validateMigrations(migrations);
  const currentVersion = db.pragma("user_version", { simple: true });
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0 || currentVersion > migrations.length) {
    throw storeError("STORE_SCHEMA_UNSUPPORTED", "Database schema version is unsupported.");
  }

  if (currentVersion > 0) {
    if (!historyExists(db)) {
      throw storeError("STORE_SCHEMA_MISMATCH", "Database migration history is missing.");
    }
    const history = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    if (
      history.length !== currentVersion ||
      history.some((entry, index) => entry.version !== index + 1 || entry.name !== migrations[index].name)
    ) {
      throw storeError("STORE_SCHEMA_MISMATCH", "Database migration history does not match the schema version.");
    }
  }

  for (const migration of migrations.slice(currentVersion)) {
    const migrate = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now());
      db.pragma(`user_version = ${migration.version}`);
    });
    try {
      migrate.immediate();
    } catch {
      throw storeError("STORE_MIGRATION_FAILED", `Store migration ${migration.version} failed.`);
    }
  }
}
