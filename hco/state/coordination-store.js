import { createHash } from "node:crypto";
import path from "node:path";

import { stateError } from "./reducer.js";

const ACTIVE_WORK_STATES = new Set([
  "ACCEPTED", "RUNNING", "WAITING_AGENT", "WAITING_CODEX", "WAITING_HUMAN",
  "RESOURCE_WAIT", "STATUS_UNVERIFIED", "DEGRADED_PENDING_OPERATOR"
]);
const TERMINAL_WORK_STATES = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
const TERMINAL_CALL_STATES = new Set(["COMPLETED", "CANCELLED", "FAILED"]);
const AGENT_STATES = new Set([
  "CREATED", "RUNNING", "WAITING_CODEX", "WAITING_CHILDREN", "REPORTED",
  "CANCELLED", "FAILED", "FAILED_ORPHANED"
]);
const TERMINAL_AGENT_STATES = new Set(["REPORTED", "CANCELLED", "FAILED", "FAILED_ORPHANED"]);
const CONVERSATION_KINDS = new Set(["TOPIC_PRIMARY", "JARVIS_WORKER", "AGENT_WORKER", "FORK"]);
const INVOCATION_ORIGINS = new Set(["DIRECT_ZULIP", "JARVIS", "AGENT"]);
const POLICY_DECISIONS = new Set(["AUTO_ALLOW", "AGENT_DECIDE", "JARVIS_DECIDE", "HUMAN_REQUIRED", "DENY"]);
const HIGH_RISK_OPERATION_CLASSES = new Set([
  "destructive_write", "credential_access", "privacy_data_access", "production_change",
  "identity_change", "infrastructure_change", "external_publish", "external_message",
  "pull_request_merge", "payment", "scope_unresolved"
]);
const HARD_DENY_OPERATION_CLASSES = new Set([
  "cross_project", "cross_topic", "outside_canonical_cwd", "policy_revision_mismatch"
]);
const MAX_MAILBOX_CLAIM = 100;
const MAX_MAILBOX_ATTEMPTS = 8;
const MAX_LEASE_MS = 10 * 60 * 1_000;
const STABLE_WORK_BRIEF_KEYS = new Set(["schemaVersion", "originalText"]);
const LEGACY_WORK_BRIEF_KEYS = new Set([
  ...STABLE_WORK_BRIEF_KEYS,
  "instruction", "constraints", "acceptanceCriteria", "reminders"
]);

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, maximum = 4096) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw stateError("COORDINATION_CLOCK_INVALID", "Coordination clock is invalid.");
  }
  return value;
}

function identifier(idFactory, kind) {
  const value = idFactory(kind);
  if (!text(value, 512)) throw stateError("COORDINATION_ID_INVALID", "Coordination ID is invalid.");
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function json(value, maximum = 1024 * 1024) {
  let output;
  try {
    output = canonical(value);
  } catch {
    throw stateError("COORDINATION_DOCUMENT_INVALID", "Coordination document is invalid.");
  }
  if (Buffer.byteLength(output, "utf8") > maximum) {
    throw stateError("COORDINATION_DOCUMENT_TOO_LARGE", "Coordination document is too large.");
  }
  return output;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : json(value), "utf8").digest("hex");
}

function compatibleLegacyWorkBrief(existingJson, incoming) {
  if (!plainObject(incoming) ||
      Object.keys(incoming).some((key) => !STABLE_WORK_BRIEF_KEYS.has(key)) ||
      Object.keys(incoming).length !== STABLE_WORK_BRIEF_KEYS.size) {
    return false;
  }
  let existing;
  try {
    existing = parse(existingJson);
  } catch {
    return false;
  }
  return plainObject(existing) &&
    Object.keys(existing).every((key) => LEGACY_WORK_BRIEF_KEYS.has(key)) &&
    Object.keys(existing).some((key) => !STABLE_WORK_BRIEF_KEYS.has(key)) &&
    existing.schemaVersion === incoming.schemaVersion &&
    existing.originalText === incoming.originalText;
}

function sameWorkIdentity(row, options, topicContextId, requestSha256) {
  return row.topic_context_id === topicContextId &&
    row.project_id === options.projectId &&
    row.requester_user_id === options.requesterUserId &&
    row.original_zulip_message_id === options.originalZulipMessageId &&
    (row.request_sha256 === requestSha256 ||
      compatibleLegacyWorkBrief(row.work_brief_json, options.workBrief));
}

function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function mapTopic(row, alias = null) {
  if (!row) return null;
  return frozen({
    topicContextId: row.topic_context_id,
    streamId: row.stream_id,
    topic: alias?.topic ?? row.topic ?? null,
    projectId: row.project_id,
    contextRevision: row.context_revision,
    jarvisSessionId: row.jarvis_session_id,
    state: row.state,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapWork(row) {
  if (!row) return null;
  return frozen({
    workRequestId: row.work_request_id,
    topicContextId: row.topic_context_id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    requesterUserId: row.requester_user_id,
    originalZulipMessageId: row.original_zulip_message_id,
    workBrief: parse(row.work_brief_json),
    contextRevision: row.context_revision,
    state: row.state,
    statusReason: row.status_reason,
    supervisorPrincipalId: row.supervisor_principal_id,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    terminalAt: row.terminal_at_ms
  });
}

function mapConversation(row) {
  if (!row) return null;
  return frozen({
    codexConversationId: row.codex_conversation_id,
    topicContextId: row.topic_context_id,
    projectId: row.project_id,
    workRequestId: row.work_request_id,
    conversationKind: row.conversation_kind,
    ownerPrincipalId: row.owner_principal_id,
    agentSessionId: row.agent_session_id,
    objectiveId: row.objective_id,
    threadId: row.app_server_thread_id,
    parentCodexConversationId: row.parent_codex_conversation_id,
    state: row.state,
    contextRevision: row.context_revision,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapCall(row) {
  if (!row) return null;
  return frozen({
    codexCallId: row.codex_call_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    codexConversationId: row.codex_conversation_id,
    workRequestId: row.work_request_id,
    topicContextId: row.topic_context_id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    turnId: row.turn_id,
    invocationOrigin: row.invocation_origin,
    callerPrincipalId: row.caller_principal_id,
    agentSessionId: row.agent_session_id,
    agentActivationId: row.agent_activation_id,
    reportTarget: { kind: row.report_target_kind, id: row.report_target_id },
    interactionTarget: { kind: row.interaction_target_kind, id: row.interaction_target_id },
    authorizationContextId: row.authorization_context_id,
    parentCodexCallId: row.parent_codex_call_id,
    request: parse(row.request_json),
    contextRevision: row.context_revision,
    state: row.state,
    receipt: parse(row.receipt_json),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    terminalAt: row.terminal_at_ms
  });
}

function mapAgent(row) {
  if (!row) return null;
  return frozen({
    agentSessionId: row.agent_session_id,
    hermesSessionId: row.hermes_session_id,
    workRequestId: row.work_request_id,
    topicContextId: row.topic_context_id,
    projectId: row.project_id,
    parentAgentSessionId: row.parent_agent_session_id,
    role: row.role,
    state: row.state,
    activationCount: row.activation_count,
    maxReactivations: row.max_reactivations,
    contextRevision: row.context_revision,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms
  });
}

function mapActivation(row) {
  if (!row) return null;
  return frozen({
    agentActivationId: row.agent_activation_id,
    agentSessionId: row.agent_session_id,
    activationNumber: row.activation_number,
    state: row.state,
    triggerPrincipalId: row.trigger_principal_id,
    reason: row.reason,
    correctionInstruction: row.correction_instruction,
    reviewFindings: parse(row.review_findings_json),
    expectedDelta: row.expected_delta,
    priorArtifacts: parse(row.prior_artifacts_json),
    budget: parse(row.budget_json),
    startedAt: row.started_at_ms,
    updatedAt: row.updated_at_ms,
    endedAt: row.ended_at_ms
  });
}

function mapMailbox(row) {
  if (!row) return null;
  return frozen({
    mailboxItemId: row.mailbox_item_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    workRequestId: row.work_request_id,
    codexCallId: row.codex_call_id,
    itemType: row.item_type,
    semanticKey: row.semantic_key,
    payload: parse(row.payload_json),
    state: row.state,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at_ms,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    acknowledgedAt: row.acknowledged_at_ms,
    lastError: row.last_error
  });
}

function targetFor(origin, topicContextId, agentSessionId) {
  if (origin === "DIRECT_ZULIP") {
    return {
      reportTargetKind: "ZULIP", reportTargetId: topicContextId,
      interactionTargetKind: "ZULIP", interactionTargetId: topicContextId
    };
  }
  if (origin === "AGENT") {
    return {
      reportTargetKind: "AGENT_MAILBOX", reportTargetId: agentSessionId,
      interactionTargetKind: "AGENT", interactionTargetId: agentSessionId
    };
  }
  return {
    reportTargetKind: "JARVIS_MAILBOX", reportTargetId: topicContextId,
    interactionTargetKind: "JARVIS", interactionTargetId: topicContextId
  };
}

function reduceWorkRequestState(db, workRequestId, currentTime) {
  const work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
  if (!work || TERMINAL_WORK_STATES.has(work.state)) return work;

  const facts = db.prepare(`
    SELECT
      sum(CASE WHEN state = 'STATUS_UNVERIFIED' THEN 1 ELSE 0 END) AS unverified_calls,
      sum(CASE WHEN state = 'WAITING_INTERACTION' THEN 1 ELSE 0 END) AS interaction_calls,
      sum(CASE WHEN state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN 1 ELSE 0 END) AS active_calls,
      sum(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed_calls,
      sum(CASE WHEN report_target_kind = 'ZULIP' THEN 1 ELSE 0 END) AS direct_calls
    FROM codex_calls WHERE work_request_id = ?
  `).get(workRequestId);
  const agents = db.prepare(`
    SELECT
      sum(CASE WHEN state NOT IN ('REPORTED', 'CANCELLED', 'FAILED', 'FAILED_ORPHANED') THEN 1 ELSE 0 END) AS active_agents,
      sum(CASE WHEN state IN ('FAILED', 'FAILED_ORPHANED') THEN 1 ELSE 0 END) AS failed_agents,
      sum(CASE WHEN state = 'WAITING_CODEX' THEN 1 ELSE 0 END) AS waiting_codex_agents
    FROM agent_sessions WHERE work_request_id = ?
  `).get(workRequestId);
  const interactions = db.prepare(`
    SELECT count(*) AS count
    FROM interaction_coordination AS coordination
    JOIN pending_interactions AS interaction USING (interaction_id)
    WHERE coordination.work_request_id = ?
      AND (
        interaction.state = 'pending'
        OR (interaction.state = 'answered' AND interaction.response_delivery_state <> 'delivered')
      )
  `).get(workRequestId).count;
  const mailbox = db.prepare(`
    SELECT
      sum(CASE WHEN state IN ('PENDING', 'LEASED') THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN state = 'DEAD' AND (last_error IS NULL OR last_error NOT LIKE 'orphaned:%') THEN 1 ELSE 0 END) AS dead
    FROM coordination_mailbox WHERE work_request_id = ?
  `).get(workRequestId);

  let state;
  let reason;
  if (work.state === "DEGRADED_PENDING_OPERATOR" || (mailbox.dead ?? 0) > 0) {
    state = "DEGRADED_PENDING_OPERATOR";
    reason = "mailbox_delivery_failed";
  } else if ((facts.unverified_calls ?? 0) > 0) {
    state = "STATUS_UNVERIFIED";
    reason = "backend_status_unverified";
  } else if (interactions > 0 || (facts.interaction_calls ?? 0) > 0) {
    state = "WAITING_HUMAN";
    reason = "codex_interaction";
  } else if ((facts.active_calls ?? 0) > 0) {
    state = "WAITING_CODEX";
    reason = (agents.waiting_codex_agents ?? 0) > 0
      ? "agent_waiting_codex"
      : "codex_running";
  } else if ((agents.active_agents ?? 0) > 0) {
    state = "WAITING_AGENT";
    reason = "agent_resume_or_report_required";
  } else if ((mailbox.pending ?? 0) > 0) {
    state = "RUNNING";
    reason = "caller_review";
  } else if ((facts.direct_calls ?? 0) > 0) {
    state = "RUNNING";
    reason = "direct_delivery_pending";
  } else {
    state = "RUNNING";
    reason = (facts.failed_calls ?? 0) > 0 || (agents.failed_agents ?? 0) > 0
      ? "jarvis_finalize_with_failures"
      : "jarvis_finalize";
  }

  if (work.state !== state || work.status_reason !== reason) {
    db.prepare(`
      UPDATE work_requests SET state = ?, status_reason = ?, updated_at_ms = ?
      WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
    `).run(state, reason, currentTime, workRequestId);
  }
  return db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
}

function ensureSameScope(scope, projectId, topicContextId, code = "COORDINATION_SCOPE_MISMATCH") {
  if (!scope || scope.project_id !== projectId || scope.topic_context_id !== topicContextId) {
    throw stateError(code, "Coordination scope does not match the trusted topic and project.");
  }
}

function validateResourceList(resources) {
  if (!Array.isArray(resources) || resources.length === 0 || resources.length > 128) {
    throw stateError("RESOURCE_LEASE_INVALID", "Resource lease request is invalid.");
  }
  const normalized = resources.map((resource) => {
    if (!plainObject(resource) || !text(resource.resourceType, 64) || !text(resource.resourceId, 4096)) {
      throw stateError("RESOURCE_LEASE_INVALID", "Resource lease request is invalid.");
    }
    return { resourceType: resource.resourceType, resourceId: resource.resourceId };
  });
  const keys = normalized.map((resource) => `${resource.resourceType}\0${resource.resourceId}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1])) {
    throw stateError("RESOURCE_LEASE_ORDER_INVALID", "Resources must be unique and sorted in canonical order.");
  }
  return normalized;
}

export function createCoordinationStore(db, { now, idFactory }) {
  if (!db || typeof db.prepare !== "function" || typeof now !== "function" || typeof idFactory !== "function") {
    throw stateError("COORDINATION_STORE_OPTIONS_INVALID", "Coordination store options are invalid.");
  }

  const ensureTopicContextTx = db.transaction((options) => {
    if (!plainObject(options) || !positive(options.streamId) || !text(options.topic, 256) ||
        !text(options.projectId, 64) || !text(options.sourceType, 128) || !text(options.sourceId, 512) ||
        (options.jarvisSessionId !== undefined && options.jarvisSessionId !== null && !text(options.jarvisSessionId, 512))) {
      throw stateError("TOPIC_CONTEXT_INVALID", "Topic context is invalid.");
    }
    const current = db.prepare(`
      SELECT context.*, alias.topic
      FROM topic_context_aliases AS alias
      JOIN topic_contexts AS context USING (topic_context_id)
      WHERE alias.stream_id = ? AND alias.topic = ? AND alias.active = 1
    `).get(options.streamId, options.topic);
    if (current) {
      if (current.project_id !== options.projectId || current.stream_id !== options.streamId) {
        throw stateError("TOPIC_CONTEXT_PROJECT_MISMATCH", "Topic context belongs to another project.");
      }
      if (current.state !== "ACTIVE") {
        throw stateError("TOPIC_ADDRESS_UNVERIFIED", "Topic address is not verified for delivery.");
      }
      if (options.jarvisSessionId && current.jarvis_session_id && current.jarvis_session_id !== options.jarvisSessionId) {
        throw stateError("TOPIC_JARVIS_SESSION_MISMATCH", "Topic is already bound to another Jarvis session.");
      }
      if (options.jarvisSessionId && !current.jarvis_session_id) {
        const currentTime = timestamp(now);
        db.prepare("UPDATE topic_contexts SET jarvis_session_id = ?, updated_at_ms = ? WHERE topic_context_id = ?")
          .run(options.jarvisSessionId, currentTime, current.topic_context_id);
      }
      const row = db.prepare("SELECT * FROM topic_contexts WHERE topic_context_id = ?").get(current.topic_context_id);
      return { duplicate: true, topicContext: mapTopic(row, { topic: options.topic }) };
    }

    const sourceAlias = db.prepare("SELECT * FROM topic_context_aliases WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, options.sourceId);
    if (sourceAlias) throw stateError("TOPIC_CONTEXT_SOURCE_CONFLICT", "Topic context source identity conflicts.");

    const currentTime = timestamp(now);
    const topicContextId = identifier(idFactory, "topic-context");
    db.prepare(`
      INSERT INTO topic_contexts (
        topic_context_id, stream_id, project_id, context_revision, jarvis_session_id,
        state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 1, ?, 'ACTIVE', ?, ?)
    `).run(topicContextId, options.streamId, options.projectId, options.jarvisSessionId ?? null, currentTime, currentTime);
    db.prepare(`
      INSERT INTO topic_context_aliases (
        topic_alias_id, topic_context_id, stream_id, topic, active, source_type,
        source_id, created_at_ms, retired_at_ms
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)
    `).run(
      identifier(idFactory, "topic-context-alias"), topicContextId, options.streamId,
      options.topic, options.sourceType, options.sourceId, currentTime
    );
    return {
      duplicate: false,
      topicContext: mapTopic(
        db.prepare("SELECT * FROM topic_contexts WHERE topic_context_id = ?").get(topicContextId),
        { topic: options.topic }
      )
    };
  });

  const prepareDispatchTx = db.transaction((options) => {
    if (!plainObject(options) || !positive(options.streamId) || !text(options.topic, 256) ||
        !text(options.projectId, 64) || !positive(options.requesterUserId) ||
        !positive(options.originalZulipMessageId) || !text(options.sourceType, 128) ||
        !text(options.sourceId, 512) || !text(options.objectiveId, 512) ||
        !INVOCATION_ORIGINS.has(options.invocationOrigin) || !text(options.callerPrincipalId, 512) ||
        !plainObject(options.workBrief) || !plainObject(options.request) ||
        (options.callSourceId !== undefined && !text(options.callSourceId, 512)) ||
        (options.jarvisSessionId !== undefined && options.jarvisSessionId !== null && !text(options.jarvisSessionId, 512)) ||
        (options.agentSessionId !== undefined && options.agentSessionId !== null && !text(options.agentSessionId, 512)) ||
        (options.agentActivationId !== undefined && options.agentActivationId !== null && !text(options.agentActivationId, 512)) ||
        (options.parentCodexCallId !== undefined && options.parentCodexCallId !== null && !text(options.parentCodexCallId, 512)) ||
        (options.authorizationContextId !== undefined && options.authorizationContextId !== null && !text(options.authorizationContextId, 512)) ||
        (options.forceNewConversation !== undefined && typeof options.forceNewConversation !== "boolean")) {
      throw stateError("COORDINATION_DISPATCH_INVALID", "Coordination dispatch is invalid.");
    }
    if (options.invocationOrigin === "AGENT" && !options.agentSessionId) {
      throw stateError("COORDINATION_CALLER_INVALID", "Agent invocation requires an Agent session.");
    }

    const topicResult = ensureTopicContextTx(options);
    const topicContext = topicResult.topicContext;
    const briefJson = json(options.workBrief);
    const requestSha256 = digest(briefJson);
    let workRow = db.prepare("SELECT * FROM work_requests WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, options.sourceId);
    let workDuplicate = Boolean(workRow);
    if (workRow) {
      if (!sameWorkIdentity(workRow, options, topicContext.topicContextId, requestSha256)) {
        throw stateError("WORK_REQUEST_SOURCE_CONFLICT", "Work request source identity conflicts.");
      }
    } else {
      const currentTime = timestamp(now);
      const workRequestId = identifier(idFactory, "work-request");
      db.prepare(`
        INSERT INTO work_requests (
          work_request_id, topic_context_id, project_id, source_type, source_id,
          requester_user_id, original_zulip_message_id, request_sha256, work_brief_json,
          context_revision, state, status_reason, supervisor_principal_id,
          created_at_ms, updated_at_ms, terminal_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', NULL, ?, ?, ?, NULL)
      `).run(
        workRequestId, topicContext.topicContextId, options.projectId, options.sourceType,
        options.sourceId, options.requesterUserId, options.originalZulipMessageId,
        requestSha256, briefJson, topicContext.contextRevision,
        `jarvis:${topicContext.topicContextId}`, currentTime, currentTime
      );
      workRow = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
      workDuplicate = false;
    }

    if (options.agentSessionId) {
      const agent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(options.agentSessionId);
      ensureSameScope(agent, options.projectId, topicContext.topicContextId, "AGENT_SCOPE_MISMATCH");
      if (agent.work_request_id !== workRow.work_request_id) {
        throw stateError("AGENT_WORK_REQUEST_MISMATCH", "Agent belongs to another work request.");
      }
    }

    const callSourceId = options.callSourceId ?? `${options.sourceId}:call`;
    const existingCall = db.prepare("SELECT * FROM codex_calls WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, callSourceId);
    if (existingCall) {
      if (existingCall.work_request_id !== workRow.work_request_id ||
          existingCall.objective_id !== options.objectiveId ||
          existingCall.invocation_origin !== options.invocationOrigin ||
          existingCall.caller_principal_id !== options.callerPrincipalId ||
          existingCall.request_json !== json(options.request)) {
        throw stateError("CODEX_CALL_SOURCE_CONFLICT", "Codex call source identity conflicts.");
      }
      return frozen({
        duplicate: true,
        topicContext,
        workRequest: mapWork(workRow),
        conversation: mapConversation(db.prepare("SELECT * FROM codex_conversations WHERE codex_conversation_id = ?")
          .get(existingCall.codex_conversation_id)),
        codexCall: mapCall(existingCall)
      });
    }

    const existingScope = db.prepare("SELECT * FROM objective_scopes WHERE objective_id = ?").get(options.objectiveId);
    let conversationRow = null;
    if (existingScope) {
      ensureSameScope(existingScope, options.projectId, topicContext.topicContextId, "OBJECTIVE_TOPIC_MISMATCH");
      conversationRow = db.prepare("SELECT * FROM codex_conversations WHERE codex_conversation_id = ?")
        .get(existingScope.codex_conversation_id);
    } else if (!options.forceNewConversation) {
      conversationRow = db.prepare(`
        SELECT * FROM codex_conversations
        WHERE topic_context_id = ? AND conversation_kind = 'TOPIC_PRIMARY'
      `).get(topicContext.topicContextId);
      if (conversationRow?.objective_id && conversationRow.objective_id !== options.objectiveId) conversationRow = null;
    }

    const currentTime = timestamp(now);
    if (!conversationRow) {
      const activeCount = db.prepare(`
        SELECT count(*) AS count FROM codex_conversations
        WHERE topic_context_id = ? AND state IN ('CREATED', 'READY', 'ACTIVE')
      `).get(topicContext.topicContextId).count;
      const maxConversations = positive(options.maxTopicConversations) ? options.maxTopicConversations : 8;
      if (activeCount >= maxConversations) {
        throw stateError("TOPIC_CODEX_CONVERSATION_LIMIT", "Topic Codex conversation limit is reached.");
      }
      const hasPrimary = db.prepare(`
        SELECT 1 FROM codex_conversations
        WHERE topic_context_id = ? AND conversation_kind = 'TOPIC_PRIMARY'
      `).get(topicContext.topicContextId);
      let conversationKind;
      if (!hasPrimary && !options.forceNewConversation && options.invocationOrigin !== "AGENT") {
        conversationKind = "TOPIC_PRIMARY";
      } else if (options.invocationOrigin === "AGENT") {
        conversationKind = "AGENT_WORKER";
      } else {
        conversationKind = "JARVIS_WORKER";
      }
      const conversationId = identifier(idFactory, "codex-conversation");
      db.prepare(`
        INSERT INTO codex_conversations (
          codex_conversation_id, topic_context_id, project_id, work_request_id,
          conversation_kind, owner_principal_id, agent_session_id, objective_id,
          app_server_thread_id, parent_codex_conversation_id, state, context_revision,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'CREATED', ?, ?, ?)
      `).run(
        conversationId, topicContext.topicContextId, options.projectId, workRow.work_request_id,
        conversationKind, options.callerPrincipalId, options.agentSessionId ?? null,
        options.objectiveId, options.parentCodexConversationId ?? null,
        topicContext.contextRevision, currentTime, currentTime
      );
      conversationRow = db.prepare("SELECT * FROM codex_conversations WHERE codex_conversation_id = ?")
        .get(conversationId);
    }
    ensureSameScope(conversationRow, options.projectId, topicContext.topicContextId);

    if (!existingScope) {
      db.prepare(`
        INSERT INTO objective_scopes (
          objective_id, project_id, topic_context_id, codex_conversation_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(options.objectiveId, options.projectId, topicContext.topicContextId, conversationRow.codex_conversation_id, currentTime);
      if (conversationRow.objective_id === null) {
        db.prepare(`
          UPDATE codex_conversations SET objective_id = ?, updated_at_ms = ?
          WHERE codex_conversation_id = ?
        `).run(options.objectiveId, currentTime, conversationRow.codex_conversation_id);
      }
    }

    const targets = targetFor(options.invocationOrigin, topicContext.topicContextId, options.agentSessionId);
    const codexCallId = identifier(idFactory, "codex-call");
    const requestJson = json(options.request);
    db.prepare(`
      INSERT INTO codex_calls (
        codex_call_id, source_type, source_id, codex_conversation_id, work_request_id,
        topic_context_id, project_id, objective_id, turn_id, invocation_origin,
        caller_principal_id, agent_session_id, agent_activation_id,
        report_target_kind, report_target_id, interaction_target_kind,
        interaction_target_id, authorization_context_id, parent_codex_call_id,
        request_json, context_revision, state, receipt_json, created_at_ms,
        updated_at_ms, terminal_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'CREATED', NULL, ?, ?, NULL)
    `).run(
      codexCallId, options.sourceType, callSourceId, conversationRow.codex_conversation_id,
      workRow.work_request_id, topicContext.topicContextId, options.projectId,
      options.objectiveId, options.invocationOrigin, options.callerPrincipalId,
      options.agentSessionId ?? null, options.agentActivationId ?? null,
      targets.reportTargetKind, targets.reportTargetId,
      targets.interactionTargetKind, targets.interactionTargetId,
      options.authorizationContextId ?? null, options.parentCodexCallId ?? null,
      requestJson, topicContext.contextRevision, currentTime, currentTime
    );
    db.prepare(`
      INSERT INTO codex_call_ownership (
        codex_call_id, owner_kind, owner_id, report_target_kind, report_target_id,
        interaction_target_kind, interaction_target_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      codexCallId, options.invocationOrigin, options.callerPrincipalId,
      targets.reportTargetKind, targets.reportTargetId,
      targets.interactionTargetKind, targets.interactionTargetId, currentTime
    );
    db.prepare(`
      UPDATE work_requests SET state = 'WAITING_CODEX', status_reason = NULL, updated_at_ms = ?
      WHERE work_request_id = ? AND state IN (
        'ACCEPTED', 'RUNNING', 'WAITING_AGENT', 'WAITING_CODEX', 'STATUS_UNVERIFIED'
      )
    `).run(currentTime, workRow.work_request_id);

    return frozen({
      duplicate: workDuplicate,
      topicContext,
      workRequest: mapWork(db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRow.work_request_id)),
      conversation: mapConversation(db.prepare("SELECT * FROM codex_conversations WHERE codex_conversation_id = ?")
        .get(conversationRow.codex_conversation_id)),
      codexCall: mapCall(db.prepare("SELECT * FROM codex_calls WHERE codex_call_id = ?").get(codexCallId))
    });
  });

  const ensureWorkRequestTx = db.transaction((options) => {
    if (!plainObject(options) || !positive(options.streamId) || !text(options.topic, 256) ||
        !text(options.projectId, 64) || !positive(options.requesterUserId) ||
        !positive(options.originalZulipMessageId) || !text(options.sourceType, 128) ||
        !text(options.sourceId, 512) || !plainObject(options.workBrief)) {
      throw stateError("WORK_REQUEST_INVALID", "Work request is invalid.");
    }
    const topic = ensureTopicContextTx(options).topicContext;
    const briefJson = json(options.workBrief);
    const requestSha256 = digest(briefJson);
    let row = db.prepare("SELECT * FROM work_requests WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, options.sourceId);
    if (row) {
      if (!sameWorkIdentity(row, options, topic.topicContextId, requestSha256)) {
        throw stateError("WORK_REQUEST_SOURCE_CONFLICT", "Work request source identity conflicts.");
      }
      return { duplicate: true, topicContext: topic, workRequest: mapWork(row) };
    }
    const currentTime = timestamp(now);
    const workRequestId = identifier(idFactory, "work-request");
    db.prepare(`
      INSERT INTO work_requests (
        work_request_id, topic_context_id, project_id, source_type, source_id,
        requester_user_id, original_zulip_message_id, request_sha256, work_brief_json,
        context_revision, state, status_reason, supervisor_principal_id,
        created_at_ms, updated_at_ms, terminal_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', NULL, ?, ?, ?, NULL)
    `).run(
      workRequestId, topic.topicContextId, options.projectId, options.sourceType,
      options.sourceId, options.requesterUserId, options.originalZulipMessageId,
      requestSha256, briefJson, topic.contextRevision,
      `jarvis:${topic.topicContextId}`, currentTime, currentTime
    );
    row = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
    return { duplicate: false, topicContext: topic, workRequest: mapWork(row) };
  });

  const relinkLegacyObjectiveTopicTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.objectiveId, 512) ||
        !positive(options.streamId) || !text(options.topic, 256) ||
        !text(options.projectId, 64) || !positive(options.requesterUserId) ||
        !positive(options.originalZulipMessageId) || !text(options.sourceType, 128) ||
        !text(options.sourceId, 512)) {
      throw stateError("OBJECTIVE_TOPIC_RELINK_INVALID", "Objective topic relink is invalid.");
    }
    const legacyRows = db.prepare(`
      SELECT DISTINCT stream_id, topic, project_id
      FROM execution_topic_intents WHERE objective_id = ?
      ORDER BY stream_id, topic, project_id
    `).all(options.objectiveId);
    if (legacyRows.length !== 1) {
      throw stateError("OBJECTIVE_TOPIC_RELINK_UNPROVEN", "Legacy objective topic scope is not uniquely proven.");
    }
    const legacy = legacyRows[0];
    if (legacy.project_id !== options.projectId || legacy.stream_id !== options.streamId ||
        legacy.topic !== options.topic) {
      throw stateError("OBJECTIVE_TOPIC_MISMATCH", "Objective belongs to another topic context.");
    }
    const topic = ensureTopicContextTx(options).topicContext;
    const existingScope = db.prepare("SELECT * FROM objective_scopes WHERE objective_id = ?")
      .get(options.objectiveId);
    if (existingScope) {
      ensureSameScope(existingScope, options.projectId, topic.topicContextId, "OBJECTIVE_TOPIC_MISMATCH");
      return frozen({
        duplicate: true,
        topicContext: topic,
        objectiveScope: readObjectiveScope(options.objectiveId)
      });
    }

    const objective = db.prepare(`
      SELECT execution.app_server_thread_id, project.project_id
      FROM objective_execution AS execution
      JOIN objective_projects AS project USING (objective_id)
      WHERE execution.objective_id = ?
    `).get(options.objectiveId);
    if (!objective || objective.project_id !== options.projectId) {
      throw stateError("OBJECTIVE_PROJECT_MISMATCH", "Objective belongs to another project.");
    }
    const currentTime = timestamp(now);
    const workBrief = {
      schemaVersion: 1,
      kind: "objective_topic_relink",
      objectiveId: options.objectiveId
    };
    const briefJson = json(workBrief);
    let work = db.prepare("SELECT * FROM work_requests WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, options.sourceId);
    if (work) {
      if (work.topic_context_id !== topic.topicContextId || work.project_id !== options.projectId ||
          work.requester_user_id !== options.requesterUserId ||
          work.original_zulip_message_id !== options.originalZulipMessageId ||
          work.request_sha256 !== digest(briefJson)) {
        throw stateError("WORK_REQUEST_SOURCE_CONFLICT", "Work request source identity conflicts.");
      }
    } else {
      const workRequestId = identifier(idFactory, "work-request");
      db.prepare(`
        INSERT INTO work_requests (
          work_request_id, topic_context_id, project_id, source_type, source_id,
          requester_user_id, original_zulip_message_id, request_sha256, work_brief_json,
          context_revision, state, status_reason, supervisor_principal_id,
          created_at_ms, updated_at_ms, terminal_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 'objective_topic_relinked',
          ?, ?, ?, ?)
      `).run(
        workRequestId, topic.topicContextId, options.projectId, options.sourceType,
        options.sourceId, options.requesterUserId, options.originalZulipMessageId,
        digest(briefJson), briefJson, topic.contextRevision,
        `jarvis:${topic.topicContextId}`, currentTime, currentTime, currentTime
      );
      work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
    }

    const activeCount = db.prepare(`
      SELECT count(*) AS count FROM codex_conversations
      WHERE topic_context_id = ? AND state IN ('CREATED', 'READY', 'ACTIVE')
    `).get(topic.topicContextId).count;
    if (activeCount >= 8) {
      throw stateError("TOPIC_CODEX_CONVERSATION_LIMIT", "Topic Codex conversation limit is reached.");
    }
    const hasPrimary = db.prepare(`
      SELECT 1 FROM codex_conversations
      WHERE topic_context_id = ? AND conversation_kind = 'TOPIC_PRIMARY'
    `).get(topic.topicContextId);
    const conversationId = identifier(idFactory, "codex-conversation");
    db.prepare(`
      INSERT INTO codex_conversations (
        codex_conversation_id, topic_context_id, project_id, work_request_id,
        conversation_kind, owner_principal_id, agent_session_id, objective_id,
        app_server_thread_id, parent_codex_conversation_id, state, context_revision,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'READY', ?, ?, ?)
    `).run(
      conversationId, topic.topicContextId, options.projectId, work.work_request_id,
      hasPrimary ? "JARVIS_WORKER" : "TOPIC_PRIMARY",
      `zulip-user:${options.requesterUserId}`, options.objectiveId,
      objective.app_server_thread_id, topic.contextRevision, currentTime, currentTime
    );
    db.prepare(`
      INSERT INTO objective_scopes (
        objective_id, project_id, topic_context_id, codex_conversation_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(options.objectiveId, options.projectId, topic.topicContextId, conversationId, currentTime);
    return frozen({
      duplicate: false,
      topicContext: topic,
      objectiveScope: readObjectiveScope(options.objectiveId)
    });
  });

  const recordCallSubmissionTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.codexCallId, 512) || !text(options.objectiveId, 512) ||
        !text(options.status, 128) ||
        (options.turnId !== undefined && options.turnId !== null && !text(options.turnId, 4096)) ||
        (options.threadId !== undefined && options.threadId !== null && !text(options.threadId, 4096))) {
      throw stateError("CODEX_CALL_SUBMISSION_INVALID", "Codex call submission is invalid.");
    }
    const row = db.prepare("SELECT * FROM codex_calls WHERE codex_call_id = ?").get(options.codexCallId);
    if (!row || row.objective_id !== options.objectiveId) {
      throw stateError("CODEX_CALL_NOT_FOUND", "Codex call does not exist in the objective scope.");
    }
    const stateMap = {
      accepted: "RUNNING", duplicate: "RUNNING", busy: "SUBMITTING", completed: "COMPLETED",
      submission_unknown: "STATUS_UNVERIFIED", reconciliation_needed: "STATUS_UNVERIFIED",
      backend_unavailable: "FAILED", cancelled: "CANCELLED", terminal_error: "FAILED"
    };
    const nextState = stateMap[options.status] ?? "SUBMITTING";
    if (TERMINAL_CALL_STATES.has(row.state)) {
      if (row.state !== nextState && !(row.state === "COMPLETED" && options.status === "duplicate")) {
        throw stateError("CODEX_CALL_TERMINAL", "Codex call is already terminal.");
      }
      return { duplicate: true, codexCall: mapCall(row) };
    }
    if (row.turn_id && options.turnId && row.turn_id !== options.turnId) {
      throw stateError("CODEX_CALL_TURN_MISMATCH", "Codex call is already bound to another turn.");
    }
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE codex_calls
      SET turn_id = COALESCE(turn_id, ?), state = ?, receipt_json = ?, updated_at_ms = ?,
          terminal_at_ms = CASE WHEN ? IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN ? ELSE NULL END
      WHERE codex_call_id = ?
    `).run(
      options.turnId ?? null, nextState,
      json({ status: options.status, threadId: options.threadId ?? null, turnId: options.turnId ?? null }),
      currentTime, nextState, currentTime, options.codexCallId
    );
    if (options.threadId) {
      db.prepare(`
        UPDATE codex_conversations SET app_server_thread_id = COALESCE(app_server_thread_id, ?),
          state = 'ACTIVE', updated_at_ms = ? WHERE codex_conversation_id = ?
      `).run(options.threadId, currentTime, row.codex_conversation_id);
    }
    if (nextState === "FAILED" && row.report_target_kind !== "ZULIP") {
      const targetKind = row.report_target_kind === "AGENT_MAILBOX" ? "AGENT" : "JARVIS";
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
        identifier(idFactory, "mailbox-item"), targetKind, row.report_target_id,
        row.work_request_id, row.codex_call_id,
        `codex-call-failure:${row.codex_call_id}`,
        json({
          schemaVersion: 1,
          kind: "CodexCallFailureNotice",
          workRequestId: row.work_request_id,
          codexCallId: row.codex_call_id,
          objectiveId: row.objective_id,
          status: options.status,
          nextAction: "caller_review"
        }),
        currentTime, currentTime
      );
    }
    reduceWorkRequestState(db, row.work_request_id, currentTime);
    return {
      duplicate: false,
      codexCall: mapCall(db.prepare("SELECT * FROM codex_calls WHERE codex_call_id = ?").get(options.codexCallId))
    };
  });

  const createAgentSessionTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.hermesSessionId, 512) || !text(options.workRequestId, 512) ||
        !text(options.role, 256) || !text(options.triggerPrincipalId, 512) || !text(options.reason, 4096) ||
        !plainObject(options.budget) ||
        (options.parentAgentSessionId !== undefined && options.parentAgentSessionId !== null && !text(options.parentAgentSessionId, 512)) ||
        (options.maxReactivations !== undefined && (!Number.isSafeInteger(options.maxReactivations) || options.maxReactivations < 0 || options.maxReactivations > 100))) {
      throw stateError("AGENT_SESSION_INVALID", "Agent session is invalid.");
    }
    const work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(options.workRequestId);
    if (!work || TERMINAL_WORK_STATES.has(work.state)) {
      throw stateError("WORK_REQUEST_NOT_ACTIVE", "Work request is not active.");
    }
    const existing = db.prepare("SELECT * FROM agent_sessions WHERE hermes_session_id = ?").get(options.hermesSessionId);
    if (existing) {
      if (existing.work_request_id !== options.workRequestId || existing.parent_agent_session_id !== (options.parentAgentSessionId ?? null)) {
        throw stateError("AGENT_SESSION_IDENTITY_CONFLICT", "Agent session identity conflicts.");
      }
      const activation = db.prepare(`
        SELECT * FROM agent_activations WHERE agent_session_id = ? ORDER BY activation_number DESC LIMIT 1
      `).get(existing.agent_session_id);
      return { duplicate: true, agentSession: mapAgent(existing), activation: mapActivation(activation) };
    }
    let parentKind = "JARVIS";
    let parentId = work.topic_context_id;
    if (options.parentAgentSessionId) {
      const parent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(options.parentAgentSessionId);
      ensureSameScope(parent, work.project_id, work.topic_context_id, "AGENT_PARENT_SCOPE_MISMATCH");
      if (parent.work_request_id !== work.work_request_id) throw stateError("AGENT_PARENT_WORK_MISMATCH", "Parent Agent belongs to another work request.");
      parentKind = "AGENT";
      parentId = parent.agent_session_id;
    }
    const currentTime = timestamp(now);
    const agentSessionId = identifier(idFactory, "agent-session");
    db.prepare(`
      INSERT INTO agent_sessions (
        agent_session_id, hermes_session_id, work_request_id, topic_context_id,
        project_id, parent_agent_session_id, role, state, activation_count,
        max_reactivations, context_revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', 1, ?, ?, ?, ?)
    `).run(
      agentSessionId, options.hermesSessionId, work.work_request_id, work.topic_context_id,
      work.project_id, options.parentAgentSessionId ?? null, options.role,
      options.maxReactivations ?? 3, work.context_revision, currentTime, currentTime
    );
    db.prepare(`
      INSERT INTO agent_parent_edges (
        child_agent_session_id, parent_kind, parent_id, work_request_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(agentSessionId, parentKind, parentId, work.work_request_id, currentTime);
    const activationId = identifier(idFactory, "agent-activation");
    db.prepare(`
      INSERT INTO agent_activations (
        agent_activation_id, agent_session_id, activation_number, state,
        trigger_principal_id, reason, correction_instruction, review_findings_json,
        expected_delta, prior_artifacts_json, budget_json, started_at_ms,
        updated_at_ms, ended_at_ms
      ) VALUES (?, ?, 1, 'RUNNING', ?, ?, NULL, NULL, NULL, '[]', ?, ?, ?, NULL)
    `).run(activationId, agentSessionId, options.triggerPrincipalId, options.reason, json(options.budget), currentTime, currentTime);
    db.prepare(`
      UPDATE work_requests SET state = 'WAITING_AGENT', status_reason = NULL, updated_at_ms = ?
      WHERE work_request_id = ?
    `).run(currentTime, work.work_request_id);
    return {
      duplicate: false,
      agentSession: mapAgent(db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(agentSessionId)),
      activation: mapActivation(db.prepare("SELECT * FROM agent_activations WHERE agent_activation_id = ?").get(activationId))
    };
  });

  const reactivateAgentTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.agentSessionId, 512) || !text(options.triggerPrincipalId, 512) ||
        !text(options.reason, 4096) || !text(options.correctionInstruction, 16 * 1024) ||
        !Array.isArray(options.reviewFindings) || !text(options.expectedDelta, 16 * 1024) ||
        !Array.isArray(options.priorArtifacts) || !plainObject(options.budget)) {
      throw stateError("AGENT_REACTIVATION_INVALID", "Agent reactivation packet is incomplete.");
    }
    const agent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(options.agentSessionId);
    if (!agent) throw stateError("AGENT_SESSION_NOT_FOUND", "Agent session does not exist.");
    if (!TERMINAL_AGENT_STATES.has(agent.state)) {
      throw stateError("AGENT_NOT_REACTIVATABLE", "Agent must finish its current activation before reactivation.");
    }
    if (agent.activation_count > agent.max_reactivations) {
      throw stateError("AGENT_REACTIVATION_LIMIT", "Agent reactivation limit is reached.");
    }
    const work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(agent.work_request_id);
    if (!work || TERMINAL_WORK_STATES.has(work.state)) throw stateError("WORK_REQUEST_NOT_ACTIVE", "Work request is not active.");
    const currentTime = timestamp(now);
    const activationNumber = agent.activation_count + 1;
    const activationId = identifier(idFactory, "agent-activation");
    db.prepare(`
      INSERT INTO agent_activations (
        agent_activation_id, agent_session_id, activation_number, state,
        trigger_principal_id, reason, correction_instruction, review_findings_json,
        expected_delta, prior_artifacts_json, budget_json, started_at_ms,
        updated_at_ms, ended_at_ms
      ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      activationId, agent.agent_session_id, activationNumber, options.triggerPrincipalId,
      options.reason, options.correctionInstruction, json(options.reviewFindings),
      options.expectedDelta, json(options.priorArtifacts), json(options.budget), currentTime, currentTime
    );
    db.prepare(`
      UPDATE agent_sessions SET state = 'RUNNING', activation_count = ?, updated_at_ms = ?
      WHERE agent_session_id = ?
    `).run(activationNumber, currentTime, agent.agent_session_id);
    db.prepare(`
      UPDATE work_requests SET state = 'WAITING_AGENT', status_reason = 'agent_reactivated', updated_at_ms = ?
      WHERE work_request_id = ?
    `).run(currentTime, agent.work_request_id);
    return {
      agentSession: mapAgent(db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(agent.agent_session_id)),
      activation: mapActivation(db.prepare("SELECT * FROM agent_activations WHERE agent_activation_id = ?").get(activationId))
    };
  });

  function submitAgentReport(options) {
    if (!plainObject(options) || !text(options.sourceType, 128) || !text(options.sourceId, 512) ||
        !text(options.agentSessionId, 512) || !text(options.agentActivationId, 512) ||
        !["progress", "needs_input", "completed", "failed"].includes(options.status) || !plainObject(options.report)) {
      throw stateError("AGENT_REPORT_INVALID", "Agent report is invalid.");
    }
    const agent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(options.agentSessionId);
    const activation = db.prepare("SELECT * FROM agent_activations WHERE agent_activation_id = ?").get(options.agentActivationId);
    if (!agent || !activation || activation.agent_session_id !== agent.agent_session_id) {
      throw stateError("AGENT_REPORT_SCOPE_INVALID", "Agent report does not match an activation.");
    }
    const requiredCalls = db.prepare(`
      SELECT count(*) AS count FROM codex_calls
      WHERE agent_activation_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
    `).get(activation.agent_activation_id).count;
    if (["completed", "failed"].includes(options.status) && requiredCalls > 0) {
      throw stateError("AGENT_REPORT_BLOCKED_BY_CODEX", "Agent still has non-terminal Codex calls.");
    }
    const reportJson = json(options.report);
    const existing = db.prepare("SELECT * FROM agent_reports WHERE source_type = ? AND source_id = ?")
      .get(options.sourceType, options.sourceId);
    if (existing) {
      if (existing.agent_session_id !== agent.agent_session_id || existing.agent_activation_id !== activation.agent_activation_id ||
          existing.status !== options.status || existing.report_json !== reportJson) {
        throw stateError("AGENT_REPORT_SOURCE_CONFLICT", "Agent report source identity conflicts.");
      }
      const edge = db.prepare("SELECT * FROM agent_parent_edges WHERE child_agent_session_id = ?")
        .get(agent.agent_session_id);
      const mailbox = db.prepare("SELECT * FROM coordination_mailbox WHERE semantic_key = ?")
        .get(`agent-report:${existing.report_id}`);
      reduceWorkRequestState(db, agent.work_request_id, timestamp(now));
      return {
        duplicate: true,
        disposition: "REPORTED",
        reportId: existing.report_id,
        agentSessionId: agent.agent_session_id,
        agentActivationId: activation.agent_activation_id,
        mailboxItemId: mailbox?.mailbox_item_id ?? null,
        mailboxTarget: { kind: edge.parent_kind, id: edge.parent_id }
      };
    }
    const edge = db.prepare("SELECT * FROM agent_parent_edges WHERE child_agent_session_id = ?").get(agent.agent_session_id);
    const currentTime = timestamp(now);
    const reportId = identifier(idFactory, "agent-report");
    const mailboxItemId = identifier(idFactory, "mailbox-item");
    db.prepare(`
      INSERT INTO agent_reports (
        report_id, source_type, source_id, work_request_id, agent_session_id,
        agent_activation_id, parent_kind, parent_id, status, report_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId, options.sourceType, options.sourceId, agent.work_request_id,
      agent.agent_session_id, activation.agent_activation_id, edge.parent_kind,
      edge.parent_id, options.status, reportJson, currentTime
    );
    const terminal = options.status === "completed" ? "REPORTED" : options.status === "failed" ? "FAILED" : null;
    if (terminal) {
      db.prepare("UPDATE agent_activations SET state = ?, ended_at_ms = ?, updated_at_ms = ? WHERE agent_activation_id = ?")
        .run(terminal, currentTime, currentTime, activation.agent_activation_id);
      db.prepare("UPDATE agent_sessions SET state = ?, updated_at_ms = ? WHERE agent_session_id = ?")
        .run(terminal, currentTime, agent.agent_session_id);
    } else {
      const waiting = options.status === "needs_input" ? "WAITING_CHILDREN" : "RUNNING";
      db.prepare("UPDATE agent_activations SET state = ?, updated_at_ms = ? WHERE agent_activation_id = ?")
        .run(waiting, currentTime, activation.agent_activation_id);
      db.prepare("UPDATE agent_sessions SET state = ?, updated_at_ms = ? WHERE agent_session_id = ?")
        .run(waiting, currentTime, agent.agent_session_id);
    }
    const targetKind = edge.parent_kind === "AGENT" ? "AGENT" : "JARVIS";
    const semanticKey = `agent-report:${reportId}`;
    db.prepare(`
      INSERT INTO coordination_mailbox (
        mailbox_item_id, target_kind, target_id, work_request_id, codex_call_id,
        item_type, semantic_key, payload_json, state, attempt_count, lease_owner,
        lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms, acknowledged_at_ms
      ) VALUES (?, ?, ?, ?, NULL, 'AGENT_REPORT', ?, ?, 'PENDING', 0, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      mailboxItemId, targetKind, edge.parent_id,
      agent.work_request_id, semanticKey,
      json({ reportId, status: options.status, report: options.report }), currentTime, currentTime
    );
    reduceWorkRequestState(db, agent.work_request_id, currentTime);
    return {
      duplicate: false,
      disposition: "REPORTED",
      reportId,
      agentSessionId: agent.agent_session_id,
      agentActivationId: activation.agent_activation_id,
      mailboxItemId,
      mailboxTarget: { kind: edge.parent_kind, id: edge.parent_id }
    };
  }

  const submitAgentReportTx = db.transaction(submitAgentReport);

  const reportHermesAgentStopTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.sourceId, 512) ||
        !text(options.childHermesSessionId, 512) || !text(options.parentHermesSessionId, 512) ||
        !text(options.childStatus, 128) || typeof options.summary !== "string" ||
        Buffer.byteLength(options.summary, "utf8") > 512 * 1024 ||
        !Number.isSafeInteger(options.durationMs) || options.durationMs < 0) {
      throw stateError("AGENT_STOP_REPORT_INVALID", "Hermes Agent stop report is invalid.");
    }
    const agent = db.prepare("SELECT * FROM agent_sessions WHERE hermes_session_id = ?")
      .get(options.childHermesSessionId);
    if (!agent) {
      return {
        duplicate: false,
        disposition: "UNTRACKED",
        reportId: null,
        agentSessionId: null,
        agentActivationId: null,
        activeCodexCalls: 0,
        mailboxItemId: null,
        mailboxTarget: null
      };
    }
    if (agent.parent_agent_session_id) {
      const parent = db.prepare("SELECT hermes_session_id FROM agent_sessions WHERE agent_session_id = ?")
        .get(agent.parent_agent_session_id);
      if (!parent || parent.hermes_session_id !== options.parentHermesSessionId) {
        throw stateError("AGENT_PARENT_HERMES_MISMATCH", "Hermes Agent parent identity does not match the trusted scope.");
      }
    }
    const activation = db.prepare(`
      SELECT * FROM agent_activations
      WHERE agent_session_id = ? ORDER BY activation_number DESC LIMIT 1
    `).get(agent.agent_session_id);
    if (!activation) throw stateError("AGENT_REPORT_SCOPE_INVALID", "Agent activation does not exist.");

    const completed = options.childStatus === "completed";
    const knownFailure = ["failed", "error", "failure", "timeout", "cancelled"].includes(options.childStatus);
    const status = completed ? "completed" : "failed";
    const unresolved = completed
      ? []
      : [knownFailure
          ? `Hermes Agent stopped with status ${options.childStatus}.`
          : `Hermes Agent returned unsupported status ${options.childStatus}; treated as failed.`];
    const relatedCodexCallIds = db.prepare(`
      SELECT codex_call_id FROM codex_calls
      WHERE agent_activation_id = ? ORDER BY created_at_ms, codex_call_id
    `).all(activation.agent_activation_id).map((row) => row.codex_call_id);
    const report = {
      summary: options.summary || (completed
        ? "Hermes Agent completed without a summary."
        : "Hermes Agent failed without a summary."),
      claims: [],
      verification: [],
      artifacts: [],
      unresolved,
      recommendedNextActions: [],
      relatedCodexCallIds,
      durationMs: options.durationMs,
      hermesStatus: options.childStatus
    };
    const existing = db.prepare("SELECT * FROM agent_reports WHERE source_type = 'hermes-subagent-stop' AND source_id = ?")
      .get(options.sourceId);
    if (existing) {
      const result = submitAgentReport({
        sourceType: "hermes-subagent-stop",
        sourceId: options.sourceId,
        agentSessionId: agent.agent_session_id,
        agentActivationId: activation.agent_activation_id,
        status,
        report
      });
      return { ...result, activeCodexCalls: 0 };
    }
    const activeCodexCalls = db.prepare(`
      SELECT count(*) AS count FROM codex_calls
      WHERE agent_activation_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
    `).get(activation.agent_activation_id).count;
    if (activeCodexCalls > 0) {
      const currentTime = timestamp(now);
      db.prepare(`
        UPDATE agent_activations SET state = 'WAITING_CODEX', updated_at_ms = ?
        WHERE agent_activation_id = ? AND state NOT IN ('REPORTED', 'CANCELLED', 'FAILED', 'FAILED_ORPHANED')
      `).run(currentTime, activation.agent_activation_id);
      db.prepare(`
        UPDATE agent_sessions SET state = 'WAITING_CODEX', updated_at_ms = ?
        WHERE agent_session_id = ? AND state NOT IN ('REPORTED', 'CANCELLED', 'FAILED', 'FAILED_ORPHANED')
      `).run(currentTime, agent.agent_session_id);
      db.prepare(`
        UPDATE work_requests SET state = 'WAITING_CODEX', status_reason = 'agent_waiting_codex', updated_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(currentTime, agent.work_request_id);
      return {
        duplicate: false,
        disposition: "WAITING_CODEX",
        reportId: null,
        agentSessionId: agent.agent_session_id,
        agentActivationId: activation.agent_activation_id,
        activeCodexCalls,
        mailboxItemId: null,
        mailboxTarget: null
      };
    }
    const result = submitAgentReport({
      sourceType: "hermes-subagent-stop",
      sourceId: options.sourceId,
      agentSessionId: agent.agent_session_id,
      agentActivationId: activation.agent_activation_id,
      status,
      report
    });
    return { ...result, activeCodexCalls: 0 };
  });

  const claimMailboxTx = db.transaction((options) => {
    if (!plainObject(options) || !["JARVIS", "AGENT"].includes(options.targetKind) ||
        !text(options.targetId, 512) || !text(options.workerId, 512) ||
        !positive(options.limit) || options.limit > MAX_MAILBOX_CLAIM ||
        !positive(options.leaseMs) || options.leaseMs > MAX_LEASE_MS ||
        (options.mailboxItemId !== undefined && options.mailboxItemId !== null && !text(options.mailboxItemId, 512)) ||
        (options.codexCallId !== undefined && options.codexCallId !== null && !text(options.codexCallId, 512))) {
      throw stateError("MAILBOX_CLAIM_INVALID", "Mailbox claim is invalid.");
    }
    const currentTime = timestamp(now);
    const rows = options.mailboxItemId
      ? db.prepare(`
        SELECT * FROM coordination_mailbox
        WHERE mailbox_item_id = ? AND target_kind = ? AND target_id = ?
          AND (? IS NULL OR codex_call_id = ?)
          AND (state = 'PENDING' OR (state = 'LEASED' AND lease_expires_at_ms <= ?))
        ORDER BY created_at_ms, mailbox_item_id LIMIT ?
      `).all(
        options.mailboxItemId, options.targetKind, options.targetId,
        options.codexCallId ?? null, options.codexCallId ?? null, currentTime, options.limit
      )
      : options.codexCallId
      ? db.prepare(`
        SELECT * FROM coordination_mailbox
        WHERE target_kind = ? AND target_id = ? AND codex_call_id = ?
          AND (state = 'PENDING' OR (state = 'LEASED' AND lease_expires_at_ms <= ?))
        ORDER BY created_at_ms, mailbox_item_id LIMIT ?
      `).all(options.targetKind, options.targetId, options.codexCallId, currentTime, options.limit)
      : db.prepare(`
      SELECT * FROM coordination_mailbox
      WHERE target_kind = ? AND target_id = ?
        AND (state = 'PENDING' OR (state = 'LEASED' AND lease_expires_at_ms <= ?))
      ORDER BY created_at_ms, mailbox_item_id LIMIT ?
      `).all(options.targetKind, options.targetId, currentTime, options.limit);
    const claimed = [];
    for (const row of rows) {
      const leaseToken = identifier(idFactory, "mailbox-lease");
      const updated = db.prepare(`
        UPDATE coordination_mailbox
        SET state = 'LEASED', attempt_count = attempt_count + 1, lease_owner = ?,
          lease_token = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE mailbox_item_id = ?
          AND (state = 'PENDING' OR (state = 'LEASED' AND lease_expires_at_ms <= ?))
      `).run(
        options.workerId, leaseToken, currentTime + options.leaseMs, currentTime,
        row.mailbox_item_id, currentTime
      );
      if (updated.changes === 1) {
        claimed.push(mapMailbox(db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?").get(row.mailbox_item_id)));
      }
    }
    return frozen(claimed);
  });

  const ackMailboxTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.mailboxItemId, 512) || !text(options.leaseToken, 512) ||
        (options.finalDelivery !== undefined && typeof options.finalDelivery !== "boolean")) {
      throw stateError("MAILBOX_ACK_INVALID", "Mailbox acknowledgement is invalid.");
    }
    const row = db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?").get(options.mailboxItemId);
    if (!row) throw stateError("MAILBOX_ITEM_NOT_FOUND", "Mailbox item does not exist.");
    if (options.finalDelivery !== (row.target_kind === "JARVIS")) {
      throw stateError(
        "MAILBOX_DELIVERY_MODE_MISMATCH",
        "Mailbox acknowledgement does not match its private or public delivery target."
      );
    }
    if (row.state === "ACKED") {
      return {
        duplicate: true,
        mailboxItem: mapMailbox(row),
        workRequest: mapWork(db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?")
          .get(row.work_request_id))
      };
    }
    if (row.state !== "LEASED" || row.lease_token !== options.leaseToken) {
      throw stateError("MAILBOX_LEASE_MISMATCH", "Mailbox lease does not match.");
    }
    const currentTime = timestamp(now);
    db.prepare(`
      UPDATE coordination_mailbox SET state = 'ACKED', lease_owner = NULL,
        lease_token = NULL, lease_expires_at_ms = NULL, acknowledged_at_ms = ?, updated_at_ms = ?
      WHERE mailbox_item_id = ?
    `).run(currentTime, currentTime, row.mailbox_item_id);
    let work = reduceWorkRequestState(db, row.work_request_id, currentTime);
    if (
      options.finalDelivery === true &&
      work && !TERMINAL_WORK_STATES.has(work.state) &&
      ["jarvis_finalize", "jarvis_finalize_with_failures"].includes(work.status_reason)
    ) {
      const finalState = work.status_reason === "jarvis_finalize_with_failures"
        ? "PARTIAL"
        : "COMPLETED";
      db.prepare(`
        UPDATE work_requests
        SET state = ?, status_reason = NULL, updated_at_ms = ?, terminal_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(finalState, currentTime, currentTime, row.work_request_id);
      work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(row.work_request_id);
    }
    return {
      duplicate: false,
      mailboxItem: mapMailbox(db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?").get(row.mailbox_item_id)),
      workRequest: mapWork(work)
    };
  });

  const renewMailboxTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.mailboxItemId, 512) ||
        !text(options.leaseToken, 512) || !positive(options.leaseMs) ||
        options.leaseMs > MAX_LEASE_MS) {
      throw stateError("MAILBOX_RENEW_INVALID", "Mailbox lease renewal is invalid.");
    }
    const currentTime = timestamp(now);
    const row = db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
      .get(options.mailboxItemId);
    if (!row) throw stateError("MAILBOX_ITEM_NOT_FOUND", "Mailbox item does not exist.");
    if (row.state !== "LEASED" || row.lease_token !== options.leaseToken ||
        row.lease_expires_at_ms <= currentTime) {
      throw stateError("MAILBOX_LEASE_MISMATCH", "Mailbox lease does not match.");
    }
    db.prepare(`
      UPDATE coordination_mailbox SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE mailbox_item_id = ?
    `).run(currentTime + options.leaseMs, currentTime, row.mailbox_item_id);
    return {
      mailboxItem: mapMailbox(db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
        .get(row.mailbox_item_id))
    };
  });

  const nackMailboxTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.mailboxItemId, 512) ||
        !text(options.leaseToken, 512) || !text(options.error, 4096) ||
        typeof options.retryable !== "boolean") {
      throw stateError("MAILBOX_NACK_INVALID", "Mailbox rejection is invalid.");
    }
    const row = db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
      .get(options.mailboxItemId);
    if (!row) throw stateError("MAILBOX_ITEM_NOT_FOUND", "Mailbox item does not exist.");
    if (row.state !== "LEASED" || row.lease_token !== options.leaseToken) {
      throw stateError("MAILBOX_LEASE_MISMATCH", "Mailbox lease does not match.");
    }
    const currentTime = timestamp(now);
    const nextState = options.retryable && row.attempt_count < MAX_MAILBOX_ATTEMPTS
      ? "PENDING"
      : "DEAD";
    db.prepare(`
      UPDATE coordination_mailbox
      SET state = ?, lease_owner = NULL, lease_token = NULL,
        lease_expires_at_ms = NULL, last_error = ?, updated_at_ms = ?
      WHERE mailbox_item_id = ?
    `).run(nextState, options.error, currentTime, row.mailbox_item_id);
    const work = reduceWorkRequestState(db, row.work_request_id, currentTime);
    return {
      mailboxItem: mapMailbox(db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
        .get(row.mailbox_item_id)),
      workRequest: mapWork(work),
      retryable: nextState === "PENDING"
    };
  });

  const listMailboxRecoveryTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.workerId, 512) ||
        !positive(options.limit) || options.limit > MAX_MAILBOX_CLAIM) {
      throw stateError("MAILBOX_RECOVERY_INVALID", "Mailbox recovery query is invalid.");
    }
    const currentTime = timestamp(now);
    const rows = db.prepare(`
      SELECT mailbox.*, work.project_id, work.topic_context_id,
        work.requester_user_id, work.original_zulip_message_id,
        work.work_brief_json, work.context_revision AS work_context_revision,
        topic.context_revision AS topic_context_revision,
        topic.jarvis_session_id, topic.state AS topic_state,
        alias.stream_id, alias.topic,
        target_agent.hermes_session_id AS target_agent_hermes_session_id,
        target_agent.parent_agent_session_id,
        target_agent.role AS target_agent_role,
        parent_agent.hermes_session_id AS parent_agent_hermes_session_id
      FROM coordination_mailbox AS mailbox
      JOIN work_requests AS work USING (work_request_id)
      JOIN topic_contexts AS topic USING (topic_context_id)
      JOIN topic_context_aliases AS alias
        ON alias.topic_context_id = topic.topic_context_id AND alias.active = 1
      LEFT JOIN agent_sessions AS target_agent
        ON mailbox.target_kind = 'AGENT' AND target_agent.agent_session_id = mailbox.target_id
      LEFT JOIN agent_sessions AS parent_agent
        ON parent_agent.agent_session_id = target_agent.parent_agent_session_id
      WHERE mailbox.state = 'PENDING'
        OR (mailbox.state = 'LEASED' AND mailbox.lease_expires_at_ms <= ?)
      ORDER BY mailbox.created_at_ms, mailbox.mailbox_item_id
      LIMIT ?
    `).all(currentTime, options.limit);
    return frozen(rows.map((row) => ({
      mailboxItem: mapMailbox(row),
      projectId: row.project_id,
      topicContextId: row.topic_context_id,
      streamId: row.stream_id,
      topic: row.topic,
      topicState: row.topic_state,
      topicContextRevision: row.topic_context_revision,
      workContextRevision: row.work_context_revision,
      requesterUserId: row.requester_user_id,
      originalZulipMessageId: row.original_zulip_message_id,
      workBrief: parse(row.work_brief_json),
      callerHermesSessionId: row.target_kind === "JARVIS"
        ? row.jarvis_session_id
        : row.target_agent_hermes_session_id,
      parentHermesSessionId: row.target_kind === "AGENT"
        ? (row.parent_agent_hermes_session_id ?? row.jarvis_session_id)
        : null,
      agentRole: row.target_kind === "AGENT" ? row.target_agent_role : null
    })));
  });

  const abandonMailboxRecoveryTx = db.transaction((options) => {
    const reasons = new Set([
      "recovery_outcome_unverified",
      "caller_session_unavailable",
      "recovery_scope_mismatch"
    ]);
    if (!plainObject(options) || !text(options.mailboxItemId, 512) ||
        !["PENDING", "LEASED"].includes(options.expectedState) ||
        !Number.isSafeInteger(options.expectedAttemptCount) || options.expectedAttemptCount < 0 ||
        !reasons.has(options.reason)) {
      throw stateError("MAILBOX_RECOVERY_INVALID", "Mailbox recovery transition is invalid.");
    }
    const currentTime = timestamp(now);
    const row = db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
      .get(options.mailboxItemId);
    if (!row) throw stateError("MAILBOX_ITEM_NOT_FOUND", "Mailbox item does not exist.");
    if (row.state === "ACKED" || row.state === "DEAD") {
      return {
        duplicate: true,
        mailboxItem: mapMailbox(row),
        workRequest: mapWork(db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?")
          .get(row.work_request_id))
      };
    }
    if (row.state !== options.expectedState || row.attempt_count !== options.expectedAttemptCount ||
        (row.state === "LEASED" && row.lease_expires_at_ms > currentTime)) {
      throw stateError("MAILBOX_RECOVERY_CONFLICT", "Mailbox recovery state changed concurrently.");
    }
    let recoveryTarget = null;
    let orphanedAgent = null;
    if (row.target_kind === "AGENT" &&
        ["recovery_outcome_unverified", "caller_session_unavailable"].includes(options.reason)) {
      orphanedAgent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?")
        .get(row.target_id);
      if (orphanedAgent && orphanedAgent.work_request_id === row.work_request_id) {
        if (orphanedAgent.parent_agent_session_id) {
          const parent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?")
            .get(orphanedAgent.parent_agent_session_id);
          if (parent && !TERMINAL_AGENT_STATES.has(parent.state)) {
            recoveryTarget = { kind: "AGENT", id: parent.agent_session_id };
          }
        }
        if (!recoveryTarget) {
          const topic = db.prepare(`
            SELECT topic.* FROM topic_contexts AS topic
            JOIN work_requests AS work USING (topic_context_id)
            WHERE work.work_request_id = ?
          `).get(row.work_request_id);
          if (topic?.jarvis_session_id) {
            recoveryTarget = { kind: "JARVIS", id: topic.topic_context_id };
          }
        }
      }
    }
    const lastError = recoveryTarget ? `orphaned:${options.reason}` : options.reason;
    db.prepare(`
      UPDATE coordination_mailbox
      SET state = 'DEAD', lease_owner = NULL, lease_token = NULL,
        lease_expires_at_ms = NULL, last_error = ?, updated_at_ms = ?
      WHERE mailbox_item_id = ?
    `).run(lastError, currentTime, row.mailbox_item_id);
    if (orphanedAgent) {
      const activation = db.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_session_id = ? ORDER BY activation_number DESC LIMIT 1
      `).get(orphanedAgent.agent_session_id);
      db.prepare(`
        UPDATE agent_sessions SET state = 'FAILED_ORPHANED', updated_at_ms = ?
        WHERE agent_session_id = ? AND state NOT IN ('REPORTED', 'CANCELLED', 'FAILED', 'FAILED_ORPHANED')
      `).run(currentTime, orphanedAgent.agent_session_id);
      if (activation) {
        db.prepare(`
          UPDATE agent_activations SET state = 'FAILED_ORPHANED', updated_at_ms = ?, ended_at_ms = ?
          WHERE agent_activation_id = ? AND state NOT IN ('REPORTED', 'CANCELLED', 'FAILED', 'FAILED_ORPHANED')
        `).run(currentTime, currentTime, activation.agent_activation_id);
      }
      if (recoveryTarget) {
        const semanticKey = `orphan-recovery:${row.mailbox_item_id}`;
        const payload = {
          schemaVersion: 1,
          kind: "OrphanRecoveryNotice",
          workRequestId: row.work_request_id,
          failedAgentSessionId: orphanedAgent.agent_session_id,
          failedHermesSessionId: orphanedAgent.hermes_session_id,
          failedActivationId: activation?.agent_activation_id ?? null,
          reason: options.reason,
          protectedResultRef: {
            kind: "coordination_mailbox",
            mailboxItemId: row.mailbox_item_id,
            codexCallId: row.codex_call_id
          },
          recoveryOptions: ["reactivate_same_agent", "create_replacement_agent", "cancel_work"]
        };
        const payloadJson = json(payload);
        db.prepare(`
          INSERT INTO coordination_mailbox (
            mailbox_item_id, target_kind, target_id, work_request_id, codex_call_id,
            item_type, semantic_key, payload_json, state, attempt_count, lease_owner,
            lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms,
            acknowledged_at_ms, last_error
          ) VALUES (?, ?, ?, ?, ?, 'ORPHAN_RECOVERY_NOTICE', ?, ?, 'PENDING', 0,
            NULL, NULL, NULL, ?, ?, NULL, NULL)
          ON CONFLICT(semantic_key) DO NOTHING
        `).run(
          identifier(idFactory, "mailbox-item"), recoveryTarget.kind, recoveryTarget.id,
          row.work_request_id, row.codex_call_id, semanticKey, payloadJson,
          currentTime, currentTime
        );
        const supervisor = recoveryTarget.kind === "AGENT"
          ? `agent:${recoveryTarget.id}`
          : `jarvis:${recoveryTarget.id}`;
        db.prepare(`
          UPDATE work_requests SET supervisor_principal_id = ?, updated_at_ms = ?
          WHERE work_request_id = ?
        `).run(supervisor, currentTime, row.work_request_id);
        db.prepare(`
          INSERT INTO notification_ledger (
            notification_id, work_request_id, semantic_key, target_kind, target_id,
            event_class, payload_sha256, state, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'ORPHAN_SUPERVISION_TRANSFER', ?, 'QUEUED', ?, ?)
          ON CONFLICT(semantic_key) DO NOTHING
        `).run(
          identifier(idFactory, "notification"), row.work_request_id,
          `notification:${semanticKey}`, recoveryTarget.kind, recoveryTarget.id,
          digest(payloadJson), currentTime, currentTime
        );
      }
    }
    const work = reduceWorkRequestState(db, row.work_request_id, currentTime);
    return {
      duplicate: false,
      mailboxItem: mapMailbox(db.prepare("SELECT * FROM coordination_mailbox WHERE mailbox_item_id = ?")
        .get(row.mailbox_item_id)),
      workRequest: mapWork(work)
    };
  });

  const listAgentRestartRecoveryTx = db.transaction((options) => {
    if (!plainObject(options) || !Number.isSafeInteger(options.startedBefore) ||
        options.startedBefore <= 0 || !positive(options.limit) || options.limit > MAX_MAILBOX_CLAIM) {
      throw stateError("AGENT_RECOVERY_INVALID", "Agent recovery query is invalid.");
    }
    const rows = db.prepare(`
      SELECT agent.agent_session_id, agent.hermes_session_id, agent.state AS agent_state,
        agent.work_request_id, agent.topic_context_id, agent.project_id,
        agent.parent_agent_session_id, activation.agent_activation_id,
        activation.state AS activation_state, activation.started_at_ms,
        topic.jarvis_session_id,
        parent.hermes_session_id AS parent_hermes_session_id
      FROM agent_sessions AS agent
      JOIN agent_activations AS activation
        ON activation.agent_session_id = agent.agent_session_id
        AND activation.activation_number = agent.activation_count
      JOIN topic_contexts AS topic USING (topic_context_id)
      LEFT JOIN agent_sessions AS parent
        ON parent.agent_session_id = agent.parent_agent_session_id
      WHERE agent.state IN ('RUNNING', 'WAITING_CHILDREN')
        AND activation.state IN ('RUNNING', 'WAITING_CHILDREN')
        AND activation.started_at_ms < ?
      ORDER BY activation.started_at_ms, agent.agent_session_id
      LIMIT ?
    `).all(options.startedBefore, options.limit);
    return frozen(rows.map((row) => ({
      agentSessionId: row.agent_session_id,
      hermesSessionId: row.hermes_session_id,
      agentState: row.agent_state,
      agentActivationId: row.agent_activation_id,
      activationState: row.activation_state,
      activationStartedAt: row.started_at_ms,
      workRequestId: row.work_request_id,
      topicContextId: row.topic_context_id,
      projectId: row.project_id,
      parentHermesSessionId: row.parent_hermes_session_id,
      jarvisSessionId: row.jarvis_session_id
    })));
  });

  const orphanAgentRestartRecoveryTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.agentSessionId, 512) ||
        !text(options.agentActivationId, 512) ||
        !["RUNNING", "WAITING_CHILDREN"].includes(options.expectedState) ||
        !Number.isSafeInteger(options.startedBefore) || options.startedBefore <= 0 ||
        options.reason !== "hermes_restart_outcome_unverified") {
      throw stateError("AGENT_RECOVERY_INVALID", "Agent recovery transition is invalid.");
    }
    const currentTime = timestamp(now);
    const agent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?")
      .get(options.agentSessionId);
    if (!agent) throw stateError("AGENT_RECOVERY_CONFLICT", "Agent recovery target no longer exists.");
    const activation = db.prepare(`
      SELECT * FROM agent_activations
      WHERE agent_session_id = ? ORDER BY activation_number DESC LIMIT 1
    `).get(agent.agent_session_id);
    const semanticKey = `agent-restart-orphan:${options.agentActivationId}`;
    if (agent.state === "FAILED_ORPHANED") {
      const notice = db.prepare("SELECT * FROM coordination_mailbox WHERE semantic_key = ?")
        .get(semanticKey);
      const notification = db.prepare("SELECT * FROM notification_ledger WHERE semantic_key = ?")
        .get(`notification:${semanticKey}`);
      const work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?")
        .get(agent.work_request_id);
      if (!activation || activation.agent_activation_id !== options.agentActivationId ||
          activation.state !== "FAILED_ORPHANED" || activation.started_at_ms >= options.startedBefore ||
          !notification) {
        throw stateError("AGENT_RECOVERY_CONFLICT", "Agent recovery state changed concurrently.");
      }
      return {
        duplicate: true,
        agentSession: mapAgent(agent),
        workRequest: mapWork(work),
        mailboxItem: mapMailbox(notice)
      };
    }
    if (agent.state !== options.expectedState || !activation ||
        activation.agent_activation_id !== options.agentActivationId ||
        activation.state !== options.expectedState ||
        activation.started_at_ms >= options.startedBefore) {
      throw stateError("AGENT_RECOVERY_CONFLICT", "Agent recovery state changed concurrently.");
    }
    const work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?")
      .get(agent.work_request_id);
    let recoveryTarget = null;
    if (agent.parent_agent_session_id) {
      const parent = db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?")
        .get(agent.parent_agent_session_id);
      if (parent && !TERMINAL_AGENT_STATES.has(parent.state)) {
        recoveryTarget = { kind: "AGENT", id: parent.agent_session_id };
      }
    }
    if (!recoveryTarget) {
      const topic = db.prepare("SELECT * FROM topic_contexts WHERE topic_context_id = ?")
        .get(agent.topic_context_id);
      if (topic?.jarvis_session_id) {
        recoveryTarget = { kind: "JARVIS", id: topic.topic_context_id };
      }
    }
    db.prepare(`
      UPDATE agent_sessions SET state = 'FAILED_ORPHANED', updated_at_ms = ?
      WHERE agent_session_id = ? AND state = ?
    `).run(currentTime, agent.agent_session_id, options.expectedState);
    db.prepare(`
      UPDATE agent_activations
      SET state = 'FAILED_ORPHANED', updated_at_ms = ?, ended_at_ms = ?
      WHERE agent_activation_id = ? AND state = ?
    `).run(currentTime, currentTime, activation.agent_activation_id, options.expectedState);
    let notice = null;
    const payload = {
      schemaVersion: 1,
      kind: "OrphanRecoveryNotice",
      workRequestId: work.work_request_id,
      failedAgentSessionId: agent.agent_session_id,
      failedHermesSessionId: agent.hermes_session_id,
      failedActivationId: activation.agent_activation_id,
      reason: options.reason,
      protectedResultRef: {
        kind: "agent_activation",
        agentActivationId: activation.agent_activation_id
      },
      recoveryOptions: ["reactivate_same_agent", "create_replacement_agent", "cancel_work"]
    };
    const payloadJson = json(payload);
    if (recoveryTarget) {
      db.prepare(`
        INSERT INTO coordination_mailbox (
          mailbox_item_id, target_kind, target_id, work_request_id, codex_call_id,
          item_type, semantic_key, payload_json, state, attempt_count, lease_owner,
          lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms,
          acknowledged_at_ms, last_error
        ) VALUES (?, ?, ?, ?, NULL, 'ORPHAN_RECOVERY_NOTICE', ?, ?, 'PENDING', 0,
          NULL, NULL, NULL, ?, ?, NULL, NULL)
        ON CONFLICT(semantic_key) DO NOTHING
      `).run(
        identifier(idFactory, "mailbox-item"), recoveryTarget.kind, recoveryTarget.id,
        work.work_request_id, semanticKey, payloadJson, currentTime, currentTime
      );
      notice = db.prepare("SELECT * FROM coordination_mailbox WHERE semantic_key = ?")
        .get(semanticKey);
      const supervisor = recoveryTarget.kind === "AGENT"
        ? `agent:${recoveryTarget.id}`
        : `jarvis:${recoveryTarget.id}`;
      db.prepare(`
        UPDATE work_requests SET supervisor_principal_id = ?, updated_at_ms = ?
        WHERE work_request_id = ?
      `).run(supervisor, currentTime, work.work_request_id);
      db.prepare(`
        INSERT INTO notification_ledger (
          notification_id, work_request_id, semantic_key, target_kind, target_id,
          event_class, payload_sha256, state, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'ORPHAN_SUPERVISION_TRANSFER', ?, 'QUEUED', ?, ?)
        ON CONFLICT(semantic_key) DO NOTHING
      `).run(
        identifier(idFactory, "notification"), work.work_request_id,
        `notification:${semanticKey}`, recoveryTarget.kind, recoveryTarget.id,
        digest(payloadJson), currentTime, currentTime
      );
      reduceWorkRequestState(db, work.work_request_id, currentTime);
    } else {
      db.prepare(`
        UPDATE work_requests
        SET state = 'DEGRADED_PENDING_OPERATOR',
          status_reason = 'orphan_supervisor_unavailable', updated_at_ms = ?
        WHERE work_request_id = ? AND state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
      `).run(currentTime, work.work_request_id);
      db.prepare(`
        INSERT INTO notification_ledger (
          notification_id, work_request_id, semantic_key, target_kind, target_id,
          event_class, payload_sha256, state, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'OPERATOR', ?, 'ORPHAN_SUPERVISION_TRANSFER', ?, 'FAILED', ?, ?)
        ON CONFLICT(semantic_key) DO NOTHING
      `).run(
        identifier(idFactory, "notification"), work.work_request_id,
        `notification:${semanticKey}`, agent.project_id, digest(payloadJson),
        currentTime, currentTime
      );
    }
    return {
      duplicate: false,
      agentSession: mapAgent(db.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?")
        .get(agent.agent_session_id)),
      workRequest: mapWork(db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?")
        .get(work.work_request_id)),
      mailboxItem: mapMailbox(notice)
    };
  });

  const createAuthorityEnvelopeTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.grantorPrincipalId, 512) || !text(options.granteePrincipalId, 512) ||
        !text(options.topicContextId, 512) || !text(options.projectId, 64) ||
        !Array.isArray(options.operationClasses) || !Array.isArray(options.resourcePatterns) ||
        !Array.isArray(options.pathScope) || !Array.isArray(options.networkScope) ||
        !Number.isSafeInteger(options.riskCeiling) || options.riskCeiling < 0 || options.riskCeiling > 4 ||
        typeof options.canDelegate !== "boolean" || !Number.isSafeInteger(options.maxDelegationDepth) ||
        options.maxDelegationDepth < 0 || !positive(options.maxUses) ||
        !Number.isSafeInteger(options.validFrom) || options.validFrom < 0 ||
        !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= options.validFrom ||
        !positive(options.policyRevision) ||
        (options.parentAuthorizationContextId !== undefined && options.parentAuthorizationContextId !== null && !text(options.parentAuthorizationContextId, 512))) {
      throw stateError("AUTHORITY_ENVELOPE_INVALID", "Authority envelope is invalid.");
    }
    for (const list of [options.operationClasses, options.resourcePatterns, options.pathScope, options.networkScope]) {
      if (list.some((entry) => !text(entry, 4096) || entry.includes("**") || entry === "*")) {
        throw stateError("AUTHORITY_SCOPE_INVALID", "Authority scope contains an unsafe wildcard.");
      }
    }
    const topic = db.prepare("SELECT * FROM topic_contexts WHERE topic_context_id = ?").get(options.topicContextId);
    ensureSameScope(topic, options.projectId, options.topicContextId);
    let depth = 0;
    if (options.parentAuthorizationContextId) {
      const parent = db.prepare("SELECT * FROM authority_envelopes WHERE authorization_context_id = ?")
        .get(options.parentAuthorizationContextId);
      ensureSameScope(parent, options.projectId, options.topicContextId, "AUTHORITY_PARENT_SCOPE_MISMATCH");
      if (!parent.can_delegate || parent.delegation_depth >= parent.max_delegation_depth) {
        throw stateError("AUTHORITY_DELEGATION_DENIED", "Parent authority cannot delegate further.");
      }
      const parentOperations = new Set(parse(parent.operation_classes_json));
      if (options.operationClasses.some((entry) => !parentOperations.has(entry)) ||
          options.riskCeiling > parent.risk_ceiling || options.expiresAt > parent.expires_at_ms ||
          options.maxUses > parent.max_uses - parent.uses_consumed ||
          options.maxDelegationDepth > parent.max_delegation_depth) {
        throw stateError("AUTHORITY_DELEGATION_EXPANSION", "Delegated authority must be a strict subset.");
      }
      depth = parent.delegation_depth + 1;
    }
    const currentTime = timestamp(now);
    const id = identifier(idFactory, "authorization-context");
    db.prepare(`
      INSERT INTO authority_envelopes (
        authorization_context_id, parent_authorization_context_id, grantor_principal_id,
        grantee_principal_id, topic_context_id, project_id, operation_classes_json,
        resource_patterns_json, path_scope_json, network_scope_json, risk_ceiling,
        can_delegate, delegation_depth, max_delegation_depth, max_uses, uses_consumed,
        valid_from_ms, expires_at_ms, policy_revision, revoked_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)
    `).run(
      id, options.parentAuthorizationContextId ?? null, options.grantorPrincipalId,
      options.granteePrincipalId, options.topicContextId, options.projectId,
      json([...new Set(options.operationClasses)].sort()), json([...new Set(options.resourcePatterns)].sort()),
      json([...new Set(options.pathScope)].sort()), json([...new Set(options.networkScope)].sort()),
      options.riskCeiling, options.canDelegate ? 1 : 0, depth, options.maxDelegationDepth,
      options.maxUses, options.validFrom, options.expiresAt, options.policyRevision,
      currentTime, currentTime
    );
    return frozen({ authorizationContextId: id, delegationDepth: depth });
  });

  const evaluateAuthorizationTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.operationClass, 256) || !text(options.principalId, 512) ||
        !text(options.topicContextId, 512) || !text(options.projectId, 64) ||
        !Number.isSafeInteger(options.riskLevel) || options.riskLevel < 0 || options.riskLevel > 4 ||
        !positive(options.policyRevision) ||
        (options.authorizationContextId !== undefined && options.authorizationContextId !== null && !text(options.authorizationContextId, 512)) ||
        (options.path !== undefined && options.path !== null && !text(options.path, 4096))) {
      throw stateError("AUTHORIZATION_REQUEST_INVALID", "Authorization request is invalid.");
    }
    if (HARD_DENY_OPERATION_CLASSES.has(options.operationClass)) {
      return frozen({ decision: "DENY", reason: "hard_policy_denial" });
    }
    if (!options.authorizationContextId) {
      return frozen({
        decision: HIGH_RISK_OPERATION_CLASSES.has(options.operationClass) || options.riskLevel >= 2
          ? "HUMAN_REQUIRED" : "HUMAN_REQUIRED",
        reason: "no_authority_envelope"
      });
    }
    const envelope = db.prepare("SELECT * FROM authority_envelopes WHERE authorization_context_id = ?")
      .get(options.authorizationContextId);
    if (!envelope) return frozen({ decision: "HUMAN_REQUIRED", reason: "authority_not_found" });
    if (envelope.project_id !== options.projectId || envelope.topic_context_id !== options.topicContextId ||
        envelope.grantee_principal_id !== options.principalId) {
      return frozen({ decision: "DENY", reason: "authority_scope_mismatch" });
    }
    const currentTime = timestamp(now);
    if (envelope.revoked_at_ms !== null || currentTime < envelope.valid_from_ms || currentTime >= envelope.expires_at_ms ||
        envelope.uses_consumed >= envelope.max_uses || envelope.policy_revision !== options.policyRevision) {
      return frozen({ decision: "HUMAN_REQUIRED", reason: "authority_expired_or_stale" });
    }
    const operations = new Set(parse(envelope.operation_classes_json));
    if (!operations.has(options.operationClass) || options.riskLevel > envelope.risk_ceiling) {
      return frozen({ decision: "HUMAN_REQUIRED", reason: "authority_scope_insufficient" });
    }
    if (options.path) {
      const candidate = path.resolve(options.path);
      const allowed = parse(envelope.path_scope_json).some((prefix) => {
        const root = path.resolve(prefix);
        return candidate === root || candidate.startsWith(`${root}${path.sep}`);
      });
      if (!allowed) return frozen({ decision: "DENY", reason: "path_outside_authority" });
    }
    db.prepare(`
      UPDATE authority_envelopes SET uses_consumed = uses_consumed + 1, updated_at_ms = ?
      WHERE authorization_context_id = ? AND uses_consumed < max_uses
    `).run(currentTime, envelope.authorization_context_id);
    return frozen({
      decision: envelope.grantee_principal_id.startsWith("agent:") ? "AGENT_DECIDE" : "JARVIS_DECIDE",
      reason: "authority_envelope_matched",
      authorizationContextId: envelope.authorization_context_id,
      remainingUses: envelope.max_uses - envelope.uses_consumed - 1
    });
  });

  const acquireWriteLeasesTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.ownerActivationId, 512) ||
        !positive(options.leaseMs) || options.leaseMs > MAX_LEASE_MS) {
      throw stateError("RESOURCE_LEASE_INVALID", "Resource lease request is invalid.");
    }
    const resources = validateResourceList(options.resources);
    const currentTime = timestamp(now);
    for (const resource of resources) {
      const current = db.prepare(`
        SELECT * FROM coordination_write_leases WHERE resource_type = ? AND resource_id = ?
      `).get(resource.resourceType, resource.resourceId);
      if (current && current.owner_activation_id !== options.ownerActivationId) {
        const transferable = current.expires_at_ms <= currentTime && current.owner_liveness_state === "STOPPED";
        if (!transferable) {
          return frozen({
            acquired: false,
            reason: current.expires_at_ms > currentTime ? "RESOURCE_BUSY" : "OWNER_LIVENESS_UNCONFIRMED",
            resource,
            ownerActivationId: current.owner_activation_id,
            recheckAt: Math.max(current.expires_at_ms, currentTime)
          });
        }
      }
    }
    const leases = [];
    for (const resource of resources) {
      const counter = db.prepare(`
        SELECT next_fencing_token FROM coordination_fence_counters
        WHERE resource_type = ? AND resource_id = ?
      `).get(resource.resourceType, resource.resourceId);
      const fencingToken = counter?.next_fencing_token ?? 1;
      db.prepare(`
        INSERT INTO coordination_fence_counters (resource_type, resource_id, next_fencing_token)
        VALUES (?, ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET next_fencing_token = excluded.next_fencing_token
      `).run(resource.resourceType, resource.resourceId, fencingToken + 1);
      const leaseToken = identifier(idFactory, "write-lease");
      db.prepare(`
        INSERT INTO coordination_write_leases (
          resource_type, resource_id, owner_activation_id, lease_token, fencing_token,
          owner_liveness_state, acquired_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'ALIVE', ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET
          owner_activation_id = excluded.owner_activation_id,
          lease_token = excluded.lease_token,
          fencing_token = excluded.fencing_token,
          owner_liveness_state = 'ALIVE',
          acquired_at_ms = excluded.acquired_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(
        resource.resourceType, resource.resourceId, options.ownerActivationId,
        leaseToken, fencingToken, currentTime, currentTime + options.leaseMs
      );
      leases.push(frozen({ ...resource, leaseToken, fencingToken, expiresAt: currentTime + options.leaseMs }));
    }
    return frozen({ acquired: true, leases });
  });

  const releaseWriteLeasesTx = db.transaction((options) => {
    if (!plainObject(options) || !text(options.ownerActivationId, 512) || !Array.isArray(options.leases) || options.leases.length === 0) {
      throw stateError("RESOURCE_LEASE_RELEASE_INVALID", "Resource lease release is invalid.");
    }
    for (const lease of options.leases) {
      if (!plainObject(lease) || !text(lease.resourceType, 64) || !text(lease.resourceId, 4096) || !text(lease.leaseToken, 512)) {
        throw stateError("RESOURCE_LEASE_RELEASE_INVALID", "Resource lease release is invalid.");
      }
      const current = db.prepare(`
        SELECT * FROM coordination_write_leases WHERE resource_type = ? AND resource_id = ?
      `).get(lease.resourceType, lease.resourceId);
      if (!current || current.owner_activation_id !== options.ownerActivationId || current.lease_token !== lease.leaseToken) {
        throw stateError("RESOURCE_LEASE_FENCE_MISMATCH", "Resource lease fencing token does not match the owner.");
      }
    }
    for (const lease of options.leases) {
      db.prepare("DELETE FROM coordination_write_leases WHERE resource_type = ? AND resource_id = ?")
        .run(lease.resourceType, lease.resourceId);
    }
    return frozen({ released: options.leases.length });
  });

  function readTopicContext(options) {
    if (!plainObject(options) || !positive(options.streamId) || !text(options.topic, 256)) {
      throw stateError("TOPIC_CONTEXT_INVALID", "Topic context lookup is invalid.");
    }
    const row = db.prepare(`
      SELECT context.*, alias.topic
      FROM topic_context_aliases AS alias
      JOIN topic_contexts AS context USING (topic_context_id)
      WHERE alias.stream_id = ? AND alias.topic = ? AND alias.active = 1
    `).get(options.streamId, options.topic);
    return mapTopic(row, row);
  }

  function readObjectiveScope(objectiveId) {
    if (!text(objectiveId, 512)) throw stateError("OBJECTIVE_ID_INVALID", "Objective ID is invalid.");
    const row = db.prepare("SELECT * FROM objective_scopes WHERE objective_id = ?").get(objectiveId);
    return row ? frozen({
      objectiveId: row.objective_id,
      projectId: row.project_id,
      topicContextId: row.topic_context_id,
      codexConversationId: row.codex_conversation_id,
      createdAt: row.created_at_ms
    }) : null;
  }

  function readLegacyObjectiveTopicBinding(objectiveId) {
    if (!text(objectiveId, 512)) throw stateError("OBJECTIVE_ID_INVALID", "Objective ID is invalid.");
    const rows = db.prepare(`
      SELECT DISTINCT stream_id, topic, project_id
      FROM execution_topic_intents WHERE objective_id = ?
      ORDER BY stream_id, topic, project_id
    `).all(objectiveId);
    if (rows.length !== 1) return null;
    return frozen({ streamId: rows[0].stream_id, topic: rows[0].topic, projectId: rows[0].project_id });
  }

  function readCodexCall(id) {
    if (!text(id, 512)) throw stateError("CODEX_CALL_ID_INVALID", "Codex call ID is invalid.");
    return mapCall(db.prepare("SELECT * FROM codex_calls WHERE codex_call_id = ?").get(id));
  }

  function readCallForTurn({ objectiveId, turnId }) {
    if (!text(objectiveId, 512) || !text(turnId, 4096)) throw stateError("CODEX_CALL_TURN_INVALID", "Codex call turn lookup is invalid.");
    return mapCall(db.prepare(`
      SELECT * FROM codex_calls WHERE objective_id = ? AND turn_id = ?
    `).get(objectiveId, turnId));
  }

  function listRecoverableCodexCalls() {
    return frozen(db.prepare(`
      SELECT * FROM codex_calls
      WHERE state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
      ORDER BY created_at_ms, codex_call_id
    `).all().map(mapCall));
  }

  function readAgentScopeByHermesSession(hermesSessionId) {
    if (!text(hermesSessionId, 512)) throw stateError("AGENT_SESSION_ID_INVALID", "Hermes Agent session ID is invalid.");
    const agent = db.prepare("SELECT * FROM agent_sessions WHERE hermes_session_id = ?").get(hermesSessionId);
    if (!agent) return null;
    const activation = db.prepare(`
      SELECT * FROM agent_activations WHERE agent_session_id = ? ORDER BY activation_number DESC LIMIT 1
    `).get(agent.agent_session_id);
    return frozen({ agentSession: mapAgent(agent), activation: mapActivation(activation) });
  }

  function readWorkStatus(workRequestId) {
    if (!text(workRequestId, 512)) throw stateError("WORK_REQUEST_ID_INVALID", "Work request ID is invalid.");
    let work = db.prepare("SELECT * FROM work_requests WHERE work_request_id = ?").get(workRequestId);
    if (!work) return null;
    work = reduceWorkRequestState(db, workRequestId, timestamp(now));
    const calls = db.prepare("SELECT * FROM codex_calls WHERE work_request_id = ? ORDER BY created_at_ms, codex_call_id")
      .all(workRequestId).map(mapCall);
    const agents = db.prepare("SELECT * FROM agent_sessions WHERE work_request_id = ? ORDER BY created_at_ms, agent_session_id")
      .all(workRequestId).map(mapAgent);
    const pendingMailbox = db.prepare(`
      SELECT count(*) AS count FROM coordination_mailbox WHERE work_request_id = ? AND state <> 'ACKED'
    `).get(workRequestId).count;
    return frozen({ workRequest: mapWork(work), codexCalls: calls, agents, pendingMailbox });
  }

  return Object.freeze({
    ensureTopicContext(options) {
      return ensureTopicContextTx.immediate(options);
    },
    prepareCoordinationDispatch(options) {
      return prepareDispatchTx.immediate(options);
    },
    ensureCoordinationWorkRequest(options) {
      return ensureWorkRequestTx.immediate(options);
    },
    relinkLegacyObjectiveTopic(options) {
      return relinkLegacyObjectiveTopicTx.immediate(options);
    },
    recordCodexCallSubmission(options) {
      return recordCallSubmissionTx.immediate(options);
    },
    createAgentSession(options) {
      return createAgentSessionTx.immediate(options);
    },
    reactivateAgent(options) {
      return reactivateAgentTx.immediate(options);
    },
    submitAgentReport(options) {
      return submitAgentReportTx.immediate(options);
    },
    reportHermesAgentStop(options) {
      return reportHermesAgentStopTx.immediate(options);
    },
    claimCoordinationMailbox(options) {
      return claimMailboxTx.immediate(options);
    },
    ackCoordinationMailbox(options) {
      return ackMailboxTx.immediate(options);
    },
    renewCoordinationMailbox(options) {
      return renewMailboxTx.immediate(options);
    },
    nackCoordinationMailbox(options) {
      return nackMailboxTx.immediate(options);
    },
    listCoordinationMailboxRecovery(options) {
      return listMailboxRecoveryTx.immediate(options);
    },
    abandonCoordinationMailboxRecovery(options) {
      return abandonMailboxRecoveryTx.immediate(options);
    },
    listCoordinationAgentRestartRecovery(options) {
      return listAgentRestartRecoveryTx.immediate(options);
    },
    orphanCoordinationAgentRestart(options) {
      return orphanAgentRestartRecoveryTx.immediate(options);
    },
    createAuthorityEnvelope(options) {
      return createAuthorityEnvelopeTx.immediate(options);
    },
    evaluateAuthorization(options) {
      return evaluateAuthorizationTx.immediate(options);
    },
    acquireCoordinationWriteLeases(options) {
      return acquireWriteLeasesTx.immediate(options);
    },
    releaseCoordinationWriteLeases(options) {
      return releaseWriteLeasesTx.immediate(options);
    },
    readTopicContext,
    readObjectiveScope,
    readLegacyObjectiveTopicBinding,
    readCodexCall,
    readCallForTurn,
    listRecoverableCodexCalls,
    readAgentScopeByHermesSession,
    readWorkStatus
  });
}

export const COORDINATION_POLICY_DECISIONS = Object.freeze([...POLICY_DECISIONS]);
export const COORDINATION_ACTIVE_WORK_STATES = Object.freeze([...ACTIVE_WORK_STATES]);
