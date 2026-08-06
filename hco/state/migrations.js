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

const ARTIFACT_CONTRACTS_SCHEMA = `
  CREATE TABLE artifact_contracts (
    submission_id TEXT NOT NULL REFERENCES turn_submissions(submission_id),
    objective_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    base_dir TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
    path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
    expected_sha256 TEXT,
    observed_sha256 TEXT,
    observed_bytes INTEGER CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
    state TEXT NOT NULL CHECK (state IN ('declared', 'verified', 'missing', 'mismatch', 'invalid')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (submission_id, direction, artifact_id)
  ) STRICT;

  CREATE INDEX artifact_contracts_objective_submission
  ON artifact_contracts(objective_id, submission_id, direction);
`;

const UNIFIED_INTERACTION_EXCHANGE_SCHEMA = `
  CREATE TABLE interaction_actions (
    interaction_id TEXT NOT NULL REFERENCES pending_interactions(interaction_id),
    action_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    action_class TEXT NOT NULL CHECK (action_class IN (
      'one_time_allow', 'file_change_allow', 'deny', 'policy_change',
      'network_policy_change', 'choice_input'
    )),
    label TEXT NOT NULL,
    style TEXT NOT NULL CHECK (style IN ('primary', 'warning', 'danger')),
    answer_json TEXT NOT NULL,
    natural_alias_eligible INTEGER NOT NULL CHECK (natural_alias_eligible IN (0, 1)),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (interaction_id, action_id),
    UNIQUE (interaction_id, source_key),
    UNIQUE (interaction_id, ordinal)
  ) STRICT;

  CREATE TRIGGER interaction_actions_no_update
  BEFORE UPDATE ON interaction_actions
  BEGIN
    SELECT RAISE(ABORT, 'interaction actions are immutable');
  END;

  CREATE TRIGGER interaction_actions_no_delete
  BEFORE DELETE ON interaction_actions
  BEGIN
    SELECT RAISE(ABORT, 'interaction actions are immutable');
  END;

  CREATE TABLE interaction_details (
    interaction_id TEXT PRIMARY KEY REFERENCES pending_interactions(interaction_id),
    mode TEXT NOT NULL CHECK (mode IN ('inline', 'chunks', 'document', 'notice')),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
    document_id TEXT,
    detail_state TEXT NOT NULL CHECK (detail_state IN (
      'detail_pending', 'delivered', 'delivery_failed', 'not_required'
    )),
    delivered_at_ms INTEGER CHECK (delivered_at_ms >= 0),
    action_prompt_delivery_id TEXT UNIQUE REFERENCES zulip_outbox(delivery_id),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK ((detail_state = 'delivered') = (delivered_at_ms IS NOT NULL)),
    CHECK (action_prompt_delivery_id IS NULL OR chunk_count > 0 OR detail_state = 'not_required')
  ) STRICT;

  CREATE TABLE interaction_delivery_links (
    delivery_id TEXT PRIMARY KEY REFERENCES zulip_outbox(delivery_id),
    interaction_id TEXT NOT NULL REFERENCES pending_interactions(interaction_id),
    role TEXT NOT NULL CHECK (role IN ('detail', 'action_prompt', 'notice')),
    chunk_index INTEGER CHECK (chunk_index >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (interaction_id, role, chunk_index),
    CHECK ((role = 'detail') = (chunk_index IS NOT NULL))
  ) STRICT;

  CREATE TABLE interaction_settlement_audit (
    interaction_id TEXT PRIMARY KEY REFERENCES pending_interactions(interaction_id),
    action_id TEXT,
    action_class TEXT,
    resolution_source TEXT NOT NULL CHECK (resolution_source IN (
      'legacy_command', 'explicit_action', 'natural_alias', 'answer_command', 'app_server_ui'
    )),
    source_type TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    detail_sha256 TEXT NOT NULL,
    responder_id INTEGER NOT NULL CHECK (responder_id > 0),
    settled_at_ms INTEGER NOT NULL CHECK (settled_at_ms >= 0),
    FOREIGN KEY (interaction_id, action_id) REFERENCES interaction_actions(interaction_id, action_id)
  ) STRICT;

  CREATE TRIGGER interaction_settlement_audit_no_update
  BEFORE UPDATE ON interaction_settlement_audit
  BEGIN
    SELECT RAISE(ABORT, 'interaction settlement audit is immutable');
  END;

  CREATE TRIGGER interaction_settlement_audit_no_delete
  BEFORE DELETE ON interaction_settlement_audit
  BEGIN
    SELECT RAISE(ABORT, 'interaction settlement audit is immutable');
  END;
`;

const INTERACTION_DELIVERY_LINK_HARDENING_SCHEMA = `
  CREATE UNIQUE INDEX interaction_delivery_one_action_prompt
  ON interaction_delivery_links(interaction_id)
  WHERE role = 'action_prompt';
`;

const TOPIC_AGENT_CODEX_COORDINATION_SCHEMA = `
  CREATE TABLE topic_contexts (
    topic_context_id TEXT PRIMARY KEY,
    stream_id INTEGER NOT NULL CHECK (stream_id > 0),
    project_id TEXT NOT NULL,
    context_revision INTEGER NOT NULL DEFAULT 1 CHECK (context_revision > 0),
    jarvis_session_id TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN (
      'ACTIVE', 'TOPIC_ADDRESS_UNVERIFIED', 'ARCHIVED'
    )),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE topic_context_aliases (
    topic_alias_id TEXT PRIMARY KEY,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    stream_id INTEGER NOT NULL CHECK (stream_id > 0),
    topic TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= created_at_ms),
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE UNIQUE INDEX topic_context_aliases_one_active_address
  ON topic_context_aliases(stream_id, topic) WHERE active = 1;

  CREATE UNIQUE INDEX topic_context_aliases_one_active_context
  ON topic_context_aliases(topic_context_id) WHERE active = 1;

  CREATE TABLE work_requests (
    work_request_id TEXT PRIMARY KEY,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    requester_user_id INTEGER NOT NULL CHECK (requester_user_id > 0),
    original_zulip_message_id INTEGER NOT NULL CHECK (original_zulip_message_id > 0),
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    work_brief_json TEXT NOT NULL,
    context_revision INTEGER NOT NULL CHECK (context_revision > 0),
    state TEXT NOT NULL CHECK (state IN (
      'ACCEPTED', 'RUNNING', 'WAITING_AGENT', 'WAITING_CODEX', 'WAITING_HUMAN',
      'RESOURCE_WAIT', 'STATUS_UNVERIFIED', 'DEGRADED_PENDING_OPERATOR',
      'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'
    )),
    status_reason TEXT,
    supervisor_principal_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE INDEX work_requests_topic_state
  ON work_requests(topic_context_id, state, created_at_ms);

  CREATE TABLE agent_sessions (
    agent_session_id TEXT PRIMARY KEY,
    hermes_session_id TEXT NOT NULL UNIQUE,
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    parent_agent_session_id TEXT REFERENCES agent_sessions(agent_session_id),
    role TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'CREATED', 'RUNNING', 'WAITING_CODEX', 'WAITING_CHILDREN', 'REPORTED',
      'CANCELLED', 'FAILED', 'FAILED_ORPHANED'
    )),
    activation_count INTEGER NOT NULL DEFAULT 0 CHECK (activation_count >= 0),
    max_reactivations INTEGER NOT NULL DEFAULT 3 CHECK (max_reactivations >= 0),
    context_revision INTEGER NOT NULL CHECK (context_revision > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE agent_parent_edges (
    child_agent_session_id TEXT PRIMARY KEY REFERENCES agent_sessions(agent_session_id),
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('JARVIS', 'AGENT')),
    parent_id TEXT NOT NULL,
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER agent_parent_edges_no_update
  BEFORE UPDATE ON agent_parent_edges
  BEGIN
    SELECT RAISE(ABORT, 'agent parent edge is immutable');
  END;

  CREATE TRIGGER agent_parent_edges_no_delete
  BEFORE DELETE ON agent_parent_edges
  BEGIN
    SELECT RAISE(ABORT, 'agent parent edge is immutable');
  END;

  CREATE TABLE agent_activations (
    agent_activation_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id),
    activation_number INTEGER NOT NULL CHECK (activation_number > 0),
    state TEXT NOT NULL CHECK (state IN (
      'CREATED', 'RUNNING', 'WAITING_CODEX', 'WAITING_CHILDREN', 'REPORTED',
      'CANCELLED', 'FAILED', 'FAILED_ORPHANED'
    )),
    trigger_principal_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    correction_instruction TEXT,
    review_findings_json TEXT,
    expected_delta TEXT,
    prior_artifacts_json TEXT NOT NULL DEFAULT '[]',
    budget_json TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    UNIQUE (agent_session_id, activation_number)
  ) STRICT;

  CREATE TABLE codex_conversations (
    codex_conversation_id TEXT PRIMARY KEY,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    work_request_id TEXT REFERENCES work_requests(work_request_id),
    conversation_kind TEXT NOT NULL CHECK (conversation_kind IN (
      'TOPIC_PRIMARY', 'JARVIS_WORKER', 'AGENT_WORKER', 'FORK'
    )),
    owner_principal_id TEXT NOT NULL,
    agent_session_id TEXT REFERENCES agent_sessions(agent_session_id),
    objective_id TEXT UNIQUE,
    app_server_thread_id TEXT UNIQUE,
    parent_codex_conversation_id TEXT REFERENCES codex_conversations(codex_conversation_id),
    state TEXT NOT NULL CHECK (state IN ('CREATED', 'READY', 'ACTIVE', 'CLOSED', 'FAILED')),
    context_revision INTEGER NOT NULL CHECK (context_revision > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE UNIQUE INDEX codex_conversations_one_topic_primary
  ON codex_conversations(topic_context_id) WHERE conversation_kind = 'TOPIC_PRIMARY';

  CREATE TABLE codex_calls (
    codex_call_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    codex_conversation_id TEXT NOT NULL REFERENCES codex_conversations(codex_conversation_id),
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    objective_id TEXT,
    turn_id TEXT,
    invocation_origin TEXT NOT NULL CHECK (invocation_origin IN ('DIRECT_ZULIP', 'JARVIS', 'AGENT')),
    caller_principal_id TEXT NOT NULL,
    agent_session_id TEXT REFERENCES agent_sessions(agent_session_id),
    agent_activation_id TEXT REFERENCES agent_activations(agent_activation_id),
    report_target_kind TEXT NOT NULL CHECK (report_target_kind IN ('ZULIP', 'JARVIS_MAILBOX', 'AGENT_MAILBOX')),
    report_target_id TEXT NOT NULL,
    interaction_target_kind TEXT NOT NULL CHECK (interaction_target_kind IN ('ZULIP', 'JARVIS', 'AGENT', 'POLICY')),
    interaction_target_id TEXT NOT NULL,
    authorization_context_id TEXT,
    parent_codex_call_id TEXT REFERENCES codex_calls(codex_call_id),
    request_json TEXT NOT NULL,
    context_revision INTEGER NOT NULL CHECK (context_revision > 0),
    state TEXT NOT NULL CHECK (state IN (
      'CREATED', 'SUBMITTING', 'RUNNING', 'WAITING_INTERACTION',
      'STATUS_UNVERIFIED', 'COMPLETED', 'CANCELLED', 'FAILED'
    )),
    receipt_json TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE UNIQUE INDEX codex_calls_objective_turn
  ON codex_calls(objective_id, turn_id) WHERE objective_id IS NOT NULL AND turn_id IS NOT NULL;

  CREATE INDEX codex_calls_work_state
  ON codex_calls(work_request_id, state, created_at_ms);

  CREATE TABLE codex_call_ownership (
    codex_call_id TEXT PRIMARY KEY REFERENCES codex_calls(codex_call_id),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('DIRECT_ZULIP', 'JARVIS', 'AGENT')),
    owner_id TEXT NOT NULL,
    report_target_kind TEXT NOT NULL,
    report_target_id TEXT NOT NULL,
    interaction_target_kind TEXT NOT NULL,
    interaction_target_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER codex_call_ownership_no_update
  BEFORE UPDATE ON codex_call_ownership
  BEGIN
    SELECT RAISE(ABORT, 'codex call ownership is immutable');
  END;

  CREATE TRIGGER codex_call_ownership_no_delete
  BEFORE DELETE ON codex_call_ownership
  BEGIN
    SELECT RAISE(ABORT, 'codex call ownership is immutable');
  END;

  CREATE TABLE objective_scopes (
    objective_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    codex_conversation_id TEXT NOT NULL REFERENCES codex_conversations(codex_conversation_id),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER objective_scopes_no_update
  BEFORE UPDATE ON objective_scopes
  BEGIN
    SELECT RAISE(ABORT, 'objective scope binding is immutable');
  END;

  CREATE TRIGGER objective_scopes_no_delete
  BEFORE DELETE ON objective_scopes
  BEGIN
    SELECT RAISE(ABORT, 'objective scope binding is immutable');
  END;

  CREATE TABLE coordination_mailbox (
    mailbox_item_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('JARVIS', 'AGENT')),
    target_id TEXT NOT NULL,
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    codex_call_id TEXT REFERENCES codex_calls(codex_call_id),
    item_type TEXT NOT NULL CHECK (item_type IN (
      'CODEX_RECEIPT', 'INTERACTION_REQUEST', 'AGENT_REPORT',
      'ORPHAN_RECOVERY_NOTICE', 'STATUS_NOTICE', 'AUTHORIZATION_NOTICE'
    )),
    semantic_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'LEASED', 'ACKED', 'DEAD')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner TEXT,
    lease_token TEXT UNIQUE,
    lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    acknowledged_at_ms INTEGER CHECK (acknowledged_at_ms IS NULL OR acknowledged_at_ms >= created_at_ms)
  ) STRICT;

  CREATE INDEX coordination_mailbox_claimable
  ON coordination_mailbox(target_kind, target_id, state, lease_expires_at_ms, created_at_ms);

  CREATE TABLE agent_reports (
    report_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id),
    agent_activation_id TEXT NOT NULL REFERENCES agent_activations(agent_activation_id),
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('JARVIS', 'AGENT')),
    parent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('progress', 'needs_input', 'completed', 'failed')),
    report_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (source_type, source_id)
  ) STRICT;

  CREATE TABLE authority_envelopes (
    authorization_context_id TEXT PRIMARY KEY,
    parent_authorization_context_id TEXT REFERENCES authority_envelopes(authorization_context_id),
    grantor_principal_id TEXT NOT NULL,
    grantee_principal_id TEXT NOT NULL,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    operation_classes_json TEXT NOT NULL,
    resource_patterns_json TEXT NOT NULL,
    path_scope_json TEXT NOT NULL,
    network_scope_json TEXT NOT NULL,
    risk_ceiling INTEGER NOT NULL CHECK (risk_ceiling BETWEEN 0 AND 4),
    can_delegate INTEGER NOT NULL CHECK (can_delegate IN (0, 1)),
    delegation_depth INTEGER NOT NULL CHECK (delegation_depth >= 0),
    max_delegation_depth INTEGER NOT NULL CHECK (max_delegation_depth >= delegation_depth),
    max_uses INTEGER NOT NULL CHECK (max_uses > 0),
    uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK (uses_consumed BETWEEN 0 AND max_uses),
    valid_from_ms INTEGER NOT NULL CHECK (valid_from_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > valid_from_ms),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= valid_from_ms),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE approval_sets (
    approver_set_id TEXT PRIMARY KEY,
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    operation_class TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (topic_context_id, operation_class, policy_revision)
  ) STRICT;

  CREATE TABLE approval_set_members (
    approver_set_id TEXT NOT NULL REFERENCES approval_sets(approver_set_id),
    user_id INTEGER NOT NULL CHECK (user_id > 0),
    role TEXT NOT NULL,
    PRIMARY KEY (approver_set_id, user_id)
  ) STRICT;

  CREATE TABLE interaction_coordination (
    interaction_id TEXT PRIMARY KEY REFERENCES pending_interactions(interaction_id),
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    topic_context_id TEXT NOT NULL REFERENCES topic_contexts(topic_context_id),
    project_id TEXT NOT NULL,
    invocation_origin TEXT NOT NULL,
    caller_principal_id TEXT NOT NULL,
    agent_session_id TEXT REFERENCES agent_sessions(agent_session_id),
    codex_conversation_id TEXT NOT NULL REFERENCES codex_conversations(codex_conversation_id),
    codex_call_id TEXT NOT NULL REFERENCES codex_calls(codex_call_id),
    approver_set_id TEXT REFERENCES approval_sets(approver_set_id),
    authorization_context_id TEXT REFERENCES authority_envelopes(authorization_context_id),
    policy_decision TEXT NOT NULL CHECK (policy_decision IN (
      'AUTO_ALLOW', 'AGENT_DECIDE', 'JARVIS_DECIDE', 'HUMAN_REQUIRED', 'DENY'
    )),
    interaction_target_kind TEXT NOT NULL,
    interaction_target_id TEXT NOT NULL,
    reply_token_sha256 TEXT NOT NULL CHECK (length(reply_token_sha256) = 64),
    context_revision INTEGER NOT NULL CHECK (context_revision > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;

  CREATE TRIGGER interaction_coordination_no_update
  BEFORE UPDATE ON interaction_coordination
  BEGIN
    SELECT RAISE(ABORT, 'interaction coordination binding is immutable');
  END;

  CREATE TRIGGER interaction_coordination_no_delete
  BEFORE DELETE ON interaction_coordination
  BEGIN
    SELECT RAISE(ABORT, 'interaction coordination binding is immutable');
  END;

  CREATE TABLE interaction_escalations (
    escalation_id TEXT PRIMARY KEY,
    interaction_id TEXT NOT NULL REFERENCES pending_interactions(interaction_id),
    source_principal_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('JARVIS', 'HUMAN', 'OPERATOR')),
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    context_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'DELIVERED', 'RESOLVED', 'FAILED')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE notification_ledger (
    notification_id TEXT PRIMARY KEY,
    work_request_id TEXT NOT NULL REFERENCES work_requests(work_request_id),
    semantic_key TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('ZULIP', 'JARVIS', 'AGENT', 'OPERATOR')),
    target_id TEXT NOT NULL,
    event_class TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    state TEXT NOT NULL CHECK (state IN ('PLANNED', 'QUEUED', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE coordination_fence_counters (
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    next_fencing_token INTEGER NOT NULL CHECK (next_fencing_token > 0),
    PRIMARY KEY (resource_type, resource_id)
  ) STRICT;

  CREATE TABLE coordination_write_leases (
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_activation_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    owner_liveness_state TEXT NOT NULL CHECK (owner_liveness_state IN ('ALIVE', 'STOPPED', 'UNKNOWN')),
    acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > acquired_at_ms),
    PRIMARY KEY (resource_type, resource_id)
  ) STRICT;
`;

const MANAGED_FILE_EXCHANGE_SCHEMA = `
  CREATE TABLE file_broker_owners (
    work_id TEXT PRIMARY KEY REFERENCES objective_execution(objective_id),
    file_broker_epoch INTEGER NOT NULL CHECK (
      file_broker_epoch > 0 AND file_broker_epoch <= 9007199254740991
    ),
    owner_lock_token TEXT NOT NULL UNIQUE,
    owner_receipt_digest TEXT NOT NULL CHECK (length(owner_receipt_digest) = 64),
    state TEXT NOT NULL CHECK (state IN ('OWNED', 'RECONCILING', 'RELEASED')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE TABLE file_attempt_bindings (
    file_attempt_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    command_id TEXT NOT NULL UNIQUE REFERENCES turn_submissions(submission_id),
    binding_version INTEGER NOT NULL CHECK (binding_version = 1),
    expected_thread_id TEXT,
    scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
    creator_file_broker_epoch INTEGER NOT NULL CHECK (creator_file_broker_epoch > 0),
    upload_relpath TEXT NOT NULL UNIQUE,
    limit_profile_digest TEXT NOT NULL CHECK (length(limit_profile_digest) = 64),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    request_json TEXT NOT NULL,
    file_attempt_request_digest TEXT NOT NULL CHECK (length(file_attempt_request_digest) = 64),
    bound_thread_id TEXT,
    bound_turn_id TEXT,
    resolved_file_attempt_binding_digest TEXT,
    seal_status TEXT NOT NULL CHECK (seal_status IN ('OPEN', 'SEALED', 'REVOKED')),
    file_attempt_seal_receipt_digest TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
      (bound_thread_id IS NULL AND bound_turn_id IS NULL AND resolved_file_attempt_binding_digest IS NULL)
      OR
      (bound_thread_id IS NOT NULL AND bound_turn_id IS NOT NULL AND length(resolved_file_attempt_binding_digest) = 64)
    ),
    CHECK (
      (seal_status = 'SEALED' AND length(file_attempt_seal_receipt_digest) = 64)
      OR
      (seal_status != 'SEALED' AND file_attempt_seal_receipt_digest IS NULL)
    ),
    CHECK (seal_status != 'SEALED' OR resolved_file_attempt_binding_digest IS NOT NULL)
  ) STRICT;

  CREATE INDEX file_attempt_bindings_work_status
  ON file_attempt_bindings(work_id, seal_status, creator_file_broker_epoch);

  CREATE TRIGGER file_attempt_binding_scope_guard
  BEFORE INSERT ON file_attempt_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM turn_submissions
    WHERE submission_id = NEW.command_id AND objective_id = NEW.work_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'file attempt command belongs to another work');
  END;

  CREATE TRIGGER file_attempt_binding_immutable_request
  BEFORE UPDATE ON file_attempt_bindings
  WHEN NEW.file_attempt_id IS NOT OLD.file_attempt_id
    OR NEW.work_id IS NOT OLD.work_id
    OR NEW.command_id IS NOT OLD.command_id
    OR NEW.binding_version IS NOT OLD.binding_version
    OR NEW.expected_thread_id IS NOT OLD.expected_thread_id
    OR NEW.scope_digest IS NOT OLD.scope_digest
    OR NEW.creator_file_broker_epoch IS NOT OLD.creator_file_broker_epoch
    OR NEW.upload_relpath IS NOT OLD.upload_relpath
    OR NEW.limit_profile_digest IS NOT OLD.limit_profile_digest
    OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
    OR NEW.request_json IS NOT OLD.request_json
    OR NEW.file_attempt_request_digest IS NOT OLD.file_attempt_request_digest
    OR OLD.seal_status IN ('SEALED', 'REVOKED')
  BEGIN
    SELECT RAISE(ABORT, 'file attempt binding immutable fields changed');
  END;

  CREATE TRIGGER file_attempt_binding_state_guard
  BEFORE UPDATE ON file_attempt_bindings
  WHEN (OLD.seal_status = 'OPEN' AND NEW.seal_status NOT IN ('OPEN', 'SEALED', 'REVOKED'))
    OR (OLD.seal_status != 'OPEN' AND NEW.seal_status IS NOT OLD.seal_status)
    OR (OLD.bound_thread_id IS NOT NULL AND (
      NEW.bound_thread_id IS NOT OLD.bound_thread_id
      OR NEW.bound_turn_id IS NOT OLD.bound_turn_id
      OR NEW.resolved_file_attempt_binding_digest IS NOT OLD.resolved_file_attempt_binding_digest
    ))
  BEGIN
    SELECT RAISE(ABORT, 'file attempt binding state transition is invalid');
  END;

  CREATE TABLE file_attempt_seal_commands (
    seal_command_id TEXT PRIMARY KEY,
    file_attempt_id TEXT NOT NULL UNIQUE REFERENCES file_attempt_bindings(file_attempt_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENT', 'CONFIRMED', 'UNKNOWN', 'REJECTED')),
    receipt_json TEXT,
    receipt_digest TEXT,
    last_error_code TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
      (state = 'CONFIRMED' AND receipt_json IS NOT NULL AND length(receipt_digest) = 64)
      OR
      (state != 'CONFIRMED' AND receipt_json IS NULL AND receipt_digest IS NULL)
    )
  ) STRICT;

  CREATE TRIGGER file_attempt_seal_command_immutable
  BEFORE UPDATE ON file_attempt_seal_commands
  WHEN NEW.seal_command_id IS NOT OLD.seal_command_id
    OR NEW.file_attempt_id IS NOT OLD.file_attempt_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.payload_digest IS NOT OLD.payload_digest
    OR OLD.state IN ('CONFIRMED', 'REJECTED')
  BEGIN
    SELECT RAISE(ABORT, 'file attempt seal command immutable fields changed');
  END;

  CREATE TRIGGER file_attempt_seal_command_state_guard
  BEFORE UPDATE ON file_attempt_seal_commands
  WHEN (OLD.state IN ('CONFIRMED', 'REJECTED') AND NEW.state IS NOT OLD.state)
    OR (OLD.state NOT IN ('CONFIRMED', 'REJECTED') AND NEW.state NOT IN (
      'SENT', 'CONFIRMED', 'UNKNOWN', 'REJECTED'
    ))
  BEGIN
    SELECT RAISE(ABORT, 'file attempt seal command state transition is invalid');
  END;

  CREATE TABLE document_manifests (
    document_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    direction TEXT NOT NULL CHECK (direction IN ('INBOX', 'OUTBOX')),
    message_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
    final_filename TEXT NOT NULL,
    actor_class TEXT NOT NULL CHECK (actor_class IN ('hermes', 'hco', 'codex', 'agent')),
    actor_digest12 TEXT NOT NULL CHECK (length(actor_digest12) = 12),
    kind TEXT NOT NULL CHECK (kind IN ('command', 'context', 'event', 'result', 'interaction', 'evidence')),
    mime_type TEXT NOT NULL,
    expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
    expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
    manifest_json TEXT NOT NULL,
    manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
    retention_class TEXT NOT NULL CHECK (retention_class IN ('work_default', 'sensitive_short')),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    creator_file_broker_epoch INTEGER NOT NULL CHECK (creator_file_broker_epoch > 0),
    current_recovery_broker_epoch INTEGER NOT NULL CHECK (current_recovery_broker_epoch > 0),
    broker_owner_receipt_digest TEXT NOT NULL CHECK (length(broker_owner_receipt_digest) = 64),
    file_attempt_id TEXT REFERENCES file_attempt_bindings(file_attempt_id),
    file_attempt_request_digest TEXT,
    resolved_file_attempt_binding_digest TEXT,
    file_attempt_seal_receipt_digest TEXT,
    state TEXT NOT NULL CHECK (state IN ('STAGING', 'AVAILABLE', 'UNAVAILABLE', 'QUARANTINED')),
    failure_code TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    UNIQUE (work_id, direction, message_id, version),
    UNIQUE (work_id, direction, final_filename),
    CHECK (
      direction = 'INBOX'
      OR (
        file_attempt_id IS NOT NULL
        AND length(file_attempt_request_digest) = 64
        AND length(resolved_file_attempt_binding_digest) = 64
        AND length(file_attempt_seal_receipt_digest) = 64
      )
    )
  ) STRICT;

  CREATE INDEX document_manifests_work_state
  ON document_manifests(work_id, state, direction, created_at_ms);

  CREATE TRIGGER document_manifest_immutable_identity
  BEFORE UPDATE ON document_manifests
  WHEN NEW.document_id IS NOT OLD.document_id
    OR NEW.work_id IS NOT OLD.work_id
    OR NEW.direction IS NOT OLD.direction
    OR NEW.message_id IS NOT OLD.message_id
    OR NEW.version IS NOT OLD.version
    OR NEW.final_filename IS NOT OLD.final_filename
    OR NEW.actor_class IS NOT OLD.actor_class
    OR NEW.actor_digest12 IS NOT OLD.actor_digest12
    OR NEW.kind IS NOT OLD.kind
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.expected_bytes IS NOT OLD.expected_bytes
    OR NEW.expected_sha256 IS NOT OLD.expected_sha256
    OR NEW.manifest_json IS NOT OLD.manifest_json
    OR NEW.manifest_digest IS NOT OLD.manifest_digest
    OR NEW.retention_class IS NOT OLD.retention_class
    OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
    OR NEW.creator_file_broker_epoch IS NOT OLD.creator_file_broker_epoch
    OR NEW.broker_owner_receipt_digest IS NOT OLD.broker_owner_receipt_digest
    OR NEW.file_attempt_id IS NOT OLD.file_attempt_id
    OR NEW.file_attempt_request_digest IS NOT OLD.file_attempt_request_digest
    OR NEW.resolved_file_attempt_binding_digest IS NOT OLD.resolved_file_attempt_binding_digest
    OR NEW.file_attempt_seal_receipt_digest IS NOT OLD.file_attempt_seal_receipt_digest
  BEGIN
    SELECT RAISE(ABORT, 'document manifest immutable fields changed');
  END;

  CREATE TRIGGER document_manifest_state_guard
  BEFORE UPDATE ON document_manifests
  WHEN (OLD.state = 'STAGING' AND NEW.state NOT IN ('STAGING', 'AVAILABLE', 'UNAVAILABLE', 'QUARANTINED'))
    OR (OLD.state = 'AVAILABLE' AND NEW.state NOT IN ('AVAILABLE', 'UNAVAILABLE'))
    OR (OLD.state IN ('UNAVAILABLE', 'QUARANTINED') AND NEW.state IS NOT OLD.state)
    OR NEW.current_recovery_broker_epoch < OLD.current_recovery_broker_epoch
  BEGIN
    SELECT RAISE(ABORT, 'document manifest state transition is invalid');
  END;

  CREATE TRIGGER file_broker_owner_epoch_guard
  BEFORE UPDATE ON file_broker_owners
  WHEN NEW.file_broker_epoch < OLD.file_broker_epoch
    OR NEW.file_broker_epoch > OLD.file_broker_epoch + 1
  BEGIN
    SELECT RAISE(ABORT, 'file broker epoch transition is invalid');
  END;
`;

const MANAGED_DOCUMENT_ACCESS_HARDENING_SCHEMA = `
  CREATE TABLE file_broker_owner_receipts (
    receipt_digest TEXT PRIMARY KEY CHECK (length(receipt_digest) = 64),
    work_id TEXT NOT NULL REFERENCES objective_execution(objective_id),
    file_broker_epoch INTEGER NOT NULL CHECK (file_broker_epoch > 0),
    owner_lock_token_digest TEXT NOT NULL CHECK (length(owner_lock_token_digest) = 64),
    key_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (work_id, file_broker_epoch)
  ) STRICT;

  ALTER TABLE document_manifests ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE document_manifests ADD COLUMN authority TEXT NOT NULL DEFAULT 'supporting_evidence';
  ALTER TABLE document_manifests ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal';
  ALTER TABLE document_manifests ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read';
  ALTER TABLE document_manifests ADD COLUMN provenance_receipt_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE document_manifests ADD COLUMN provenance_receipt_digest TEXT NOT NULL DEFAULT '${"0".repeat(64)}';
  ALTER TABLE document_manifests ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE document_manifests ADD COLUMN key_id TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE document_manifests ADD COLUMN delete_pending_at_ms INTEGER;
  ALTER TABLE document_manifests ADD COLUMN deleted_at_ms INTEGER;

  CREATE INDEX document_manifests_retention
  ON document_manifests(state, expires_at_ms, delete_pending_at_ms);

  CREATE TRIGGER document_manifest_provenance_immutable
  BEFORE UPDATE ON document_manifests
  WHEN NEW.source IS NOT OLD.source
    OR NEW.authority IS NOT OLD.authority
    OR NEW.sensitivity IS NOT OLD.sensitivity
    OR NEW.access_mode IS NOT OLD.access_mode
    OR NEW.provenance_receipt_json IS NOT OLD.provenance_receipt_json
    OR NEW.provenance_receipt_digest IS NOT OLD.provenance_receipt_digest
    OR NEW.policy_revision IS NOT OLD.policy_revision
    OR NEW.key_id IS NOT OLD.key_id
  BEGIN
    SELECT RAISE(ABORT, 'document manifest provenance changed');
  END;

  CREATE TABLE document_access_issues (
    access_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document_manifests(document_id),
    document_version INTEGER NOT NULL,
    document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
    operation TEXT NOT NULL CHECK (operation IN ('READ_RESULT', 'READ_EVIDENCE', 'READ_TASK_CONTRACT')),
    consumer_digest TEXT NOT NULL CHECK (length(consumer_digest) = 64),
    grant_digest TEXT NOT NULL CHECK (length(grant_digest) = 64),
    issuance_key TEXT NOT NULL UNIQUE,
    access_ref_digest TEXT NOT NULL UNIQUE CHECK (length(access_ref_digest) = 64),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    state TEXT NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED')),
    consumed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT;

  CREATE INDEX document_access_issues_document_state
  ON document_access_issues(document_id, state, expires_at_ms);

  CREATE TRIGGER document_access_issue_identity_immutable
  BEFORE UPDATE ON document_access_issues
  WHEN NEW.access_id IS NOT OLD.access_id
    OR NEW.document_id IS NOT OLD.document_id
    OR NEW.document_version IS NOT OLD.document_version
    OR NEW.document_sha256 IS NOT OLD.document_sha256
    OR NEW.operation IS NOT OLD.operation
    OR NEW.consumer_digest IS NOT OLD.consumer_digest
    OR NEW.grant_digest IS NOT OLD.grant_digest
    OR NEW.issuance_key IS NOT OLD.issuance_key
    OR NEW.access_ref_digest IS NOT OLD.access_ref_digest
    OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
  BEGIN
    SELECT RAISE(ABORT, 'document access issue identity changed');
  END;
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

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "artifact_contracts",
  up(db) {
    db.exec(ARTIFACT_CONTRACTS_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "unified_interaction_exchange",
  up(db) {
    db.exec(UNIFIED_INTERACTION_EXCHANGE_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "interaction_delivery_link_hardening",
  up(db) {
    db.exec(INTERACTION_DELIVERY_LINK_HARDENING_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "topic_agent_codex_coordination",
  up(db) {
    db.exec(TOPIC_AGENT_CODEX_COORDINATION_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "coordination_mailbox_failure_recovery",
  up(db) {
    db.exec("ALTER TABLE coordination_mailbox ADD COLUMN last_error TEXT;");
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "managed_file_exchange",
  up(db) {
    db.exec(MANAGED_FILE_EXCHANGE_SCHEMA);
  }
}));

migrations.push(Object.freeze({
  version: migrations.at(-1).version + 1,
  name: "managed_document_access_hardening",
  up(db) {
    db.exec(MANAGED_DOCUMENT_ACCESS_HARDENING_SCHEMA);
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
