# 0002 - Hermes to Codex context handoff and thread lifecycle

> Implementation note (2026-07-16): this ADR is the approved Option C App
> Server target. Historical Runner `taskId` values remain audit references but
> never provide App Server continuity.

**Status:** accepted; amended 2026-08-04 for topic-owned logical Codex sessions; implementation in progress
**Date:** 2026-07-16
**Related:** `docs/adr/0001-zulip-trusted-execution-scope.md`
**Evidence:** `docs/reviews/HERMES_CODEX_CONTEXT_MANAGEMENT_SYNTHESIS.md`
**Deciders:** project owner, Codex; reviewers: Claude CLI and Gemini CLI

## Context

The current HCO path can run a full Hermes agent turn and then ask Codex to
read project context and plan again. The adapter also discards structured
constraints and acceptance criteria. Runner continuity is based on a
project-level tmux/Codex TUI process rather than a persisted semantic task
identity.

Codex already supports persisted threads, resume, fork, and native compaction.
HCO needs a business and task control plane around those capabilities; it does
not need a second coding-agent reasoning loop or a duplicate Codex transcript
store.

ADR 0001's proposed `conversationKey -> codexSessionId` mapping becomes the
stable topic-level continuity policy. One Zulip topic can still contain
unrelated objectives, while one objective can need separate exploratory
branches. The topic therefore owns one logical Codex context session and its
primary thread; objective/task identities own concrete work and any managed
branch thread inside that topic session. No objective may borrow a thread from
another topic.

## Decision

### Responsibilities

Hermes infrastructure is the mandatory Zulip-facing gateway. Its standalone
bridge package owns exact-command parsing, one optional semantic model turn,
bridge envelope conversion, and a launchd-supervised send-only Zulip delivery
sidecar. The sidecar uses the bot's REST credentials but never starts a second
inbound poller. These transport operations do not themselves invoke a model.

When invoked, the optional Hermes model owns business dialogue, intent
normalization, omission detection, business clarification, project/risk
reminders, context selection, and cross-objective coordination in one call. It
does not produce code-level plans, repository summaries, implementation
reasoning, or chain-of-thought for Codex. A message passing through Hermes
infrastructure is not, by itself, a reason to invoke the Hermes model.

HCO owns numeric stream routing, authorization, queues, the durable control
record, context-manifest validation, thread registry, lifecycle state machine,
telemetry, result receipts, event journal, reducers, recovery, and Zulip outbox.
HCO never invokes a Hermes model. It receives a typed request through the
plugin tool; the bridge delivery sidecar claims no-model outbox work from HCO.

Codex owns repository inspection, implementation planning, edits, tool use,
tests, verification, and its native execution-thread history.

### Binary Hermes model gate

For each inbound message, Hermes either invokes no model or invokes one
deployment-configured model exactly once. HCO never performs this choice or
model call. Hermes does not classify prose as
simple/complex, select fast/strong models dynamically, or make a preliminary
model call whose output decides whether to make another Hermes call.

No-model handling is limited to a closed positive whitelist:

- typed App Server event journaling and state reduction;
- persisted completed-answer forwarding and Zulip delivery-ledger operations;
- commands in a closed grammar with a registered verb, existing `objectiveId`,
  authorized caller, valid arguments, and no unparsed free-language suffix;
- responses exactly correlated to a pending `InteractionRequest` and authorized
  responder;
- an explicit direct-to-Codex command after project-role and input checks.

Protocol-invalid, malformed, over-limit, or unauthenticated input is rejected
deterministically. All other valid free-language input invokes the configured
Hermes model once. That call performs the entire semantic job and returns one
of `DISPATCH`, `CONTROL`, `CLARIFY`, `BUSINESS_REPLY`, or `REJECT`. `DISPATCH`
contains a complete `IntentEnvelope`; `CONTROL` permits only
`SET_TOPIC_MODE` to `AUTO` or `HERMES_ONLY` and cannot create an objective or
turn; `CLARIFY` contains a bounded ordered question list.

The model input contains only the semantic context it needs: `rawText`,
`objectiveBrief`, `projectBrief`, `pendingInteractionRefs`, `callerIdentity`,
`contextRefs`, and `contextTruncated`. HCO remains authoritative for schema,
authorization, policy, freshness, and objective/thread state. It validates the
model result before any action. Invalid output yields `MODEL_PROTOCOL_ERROR`,
fails closed, and is not repaired through a second model call.

Direct-to-Codex bypasses only Hermes semantic processing. It cannot bypass HCO
authorization, active project constraints, dangerous-operation approvals,
journal, or audit. Codex handles all repository and technical work, including
technical error diagnosis and recovery. Independent review is a separate,
explicit user- or policy-triggered workflow, not a dynamic Hermes model tier.
Humans retain authorization, production impact decisions, and genuine business
trade-offs.

All gate outcomes are recorded in telemetry. Fixed token, latency, question
count, or percentage-saving targets are configuration or measurement matters,
not architecture truths.

### Relay contracts

`IntentEnvelope` is the inbound task contract. It includes schema and envelope
IDs, immutable raw user text, optional normalized business goal, constraints,
acceptance criteria, objective/project identity, source provenance, permissions,
correlation, timestamps, and versioned context references. Operational fields
are durable but omitted from model prompts unless needed for the decision.

HCO turns a validated intent into its private execution control record. The
term `ExecutionReceipt` is reserved for the return path: status, outcome,
authoritative completed-message reference and content hash, artifacts, test
evidence, unresolved items, usage, and thread/turn correlation.

`InteractionRequest` carries exact approval or user-input text, request type,
options, deadline, authorization scope, and thread/turn/item correlation. Its
source text is not rewritten by Hermes.

`DeliveryEnvelope` carries the currently resolved Zulip target, renderer
version, content mode
(`verbatim`, `annotated`, or `summary`), chunk hashes, idempotency key, delivery
state, and acknowledged Zulip message IDs. The original completed answer is
stored before rendering or chunking. Any explicitly requested business
annotation is stored in a separate, labelled field and never replaces the source
content; final forwarding does not automatically invoke Hermes.

### Two-part handoff contract

The complete handoff record has two views:

1. **Control plane:** authoritative metadata used by HCO for audit and
   enforcement. It includes correlation/task/project IDs, source message,
   provenance, workspace and git state, permissions, hashes, thread/turn IDs,
   lifecycle decision and reason, timestamps, and usage.
2. **Model-visible intent:** the minimum content Codex needs. It includes the
   original user intent, normalized objective, typed constraints, acceptance
   criteria, confirmed or explicitly unconfirmed assumptions, risk reminders,
   and context/evidence references with purpose.

Example model-visible intent:

```json
{
  "objective": "Preserve structured Hermes requirements when dispatching to Codex.",
  "userIntent": "Do not let Hermes's useful clarification disappear before Codex runs.",
  "constraints": [
    {"id": "c1", "kind": "hard", "text": "Do not change unrelated routes", "source": "user"}
  ],
  "acceptanceCriteria": [
    {"id": "a1", "text": "Constraints and criteria reach the generated task contract"}
  ],
  "assumptions": [
    {"text": "The existing Runner API remains compatible", "status": "unconfirmed"}
  ],
  "riskReminders": [
    {"text": "Current adapter hard-codes both arrays empty", "sourceRef": "repo:adapter/handler.js"}
  ],
  "contextRefs": [
    {
      "path": "adapter/handler.js",
      "contentHash": "sha256:...",
      "purpose": "current task construction",
      "authority": "repository",
      "freshness": "verified-at-dispatch"
    }
  ]
}
```

Large specifications, logs, traces, prior results, and code excerpts are
stored as files and referenced through a manifest. Machine evidence is kept
verbatim. The manifest is versioned and records content hash, source, purpose,
authority, creation time, repository state, and revalidation rule.

### Thread lifecycle

- **New:** start a fresh Codex thread for a new objective, a clean-room rerun,
  or a state change that invalidates material prior assumptions.
- **Resume:** continue the persisted thread for the same objective and main
  execution line after refreshing repository state and active contract.
- **Fork:** copy history only for a history-dependent side branch such as an
  alternative, review, summary, or independent investigation. Record the
  source thread, source turn, and fork reason.
- **Compact:** HCO may request Codex's native compact operation based on token
  usage or context pressure. HCO does not write a competing execution summary.

Every continuation re-sends the active hard constraints, current acceptance
criteria, changed user intent, and relevant evidence references. Resume and
fork are rejected or reclassified when project, workspace, branch, permission,
or objective identity conflicts. A repository hash mismatch is inspected for
semantic impact: it is not automatically a fork.

tmux may host or display a process but is never the source of task identity,
thread continuity, ownership, or completion state. `--last` is not used for
automated resume.

Thread persistence does not guarantee that a separately running Codex App
will display the thread in its normal conversation list. CLI/TUI, App, exec,
and app-server threads have distinct source kinds. HCO treats App visibility
as an optional presentation integration, not as evidence that a task exists or
is resumable. The durable
`topicContextId -> codexContextSessionId -> objectiveId -> threadId -> turnId`
registry and app-server events remain authoritative.

### Conversation routing

Creating an empty Zulip topic does not create a Codex thread. The first
executable request creates a stable HCO `topicContextId`, its logical
`codexContextSessionId`, an objective, and a primary thread. The mapping is:

```text
numeric streamId -> projectId
projectId -> canonical project cwd
streamId + stable topic identity -> topicContextId -> codexContextSessionId
topic alias/message -> deliveryTargetId/topicAliasId
objective -> primary or managed branch threadId inside that topic session
execution -> turnId
turn items -> delivery records
```

Stream display names and topic text are aliases and delivery coordinates, not
permanent primary keys. Numeric stream ID and `topicContextId` are the stable
identities. A verified topic rename or same-project move updates the alias and
target after permission checks while preserving the topic context. If the
transport cannot reliably expose the change, HCO requires explicit relinking.
A cross-project move defaults to a new topic context/session. Cross-topic
quotations are evidence only; they do not merge sessions, threads, or
authorization scopes.

Each objective has at most one active turn. Later messages are queued FIFO by
default. Steer, interrupt, approval, and user-input actions must name the exact
turn and pass authorization checks against the stored source and responder
set.

### Event capture and Zulip delivery

App Server events are persisted before reduction or delivery:

```text
App Server notification
  -> durable event journal
  -> idempotent state reducer
  -> result renderer
  -> Zulip outbox/delivery ledger
```

HCO generates `eventRecordId` and a monotonic local `ingestionSeq`. It does not
assume the App Server delta stream provides a global event ID or replay cursor.
The journal stores the raw payload by restricted reference plus payload hash;
the reducer tolerates duplicate and out-of-order observations.

Agent-message deltas may drive an optional progress display. They are not the
final result contract. A completed `agentMessage` item is persisted verbatim
and is the authoritative final answer. Completed plans and other typed items
are handled separately; concatenated deltas must not overwrite their completed
form. Thread/turn/item list methods support reconciliation after reconnect but
are not treated as lossless replay of every original event or tool interaction.

The final answer is filtered by allowlisted event/item type, sensitive-path
policy, known-secret masking, and output limits, then split on Markdown-aware
boundaries. Every chunk has a stable delivery ID, index, content hash, state,
and resulting Zulip message ID. Retrying an acknowledged chunk is forbidden.
If a completed turn has no recoverable authoritative final item, HCO reports an
incomplete recovery instead of allowing Hermes to invent a summary.

The durable registry includes at minimum:

```text
legacyTaskId, correlationId, sourceMessageId,
projectId, numericStreamId, deliveryTargetId, topicAliasId, objectiveId,
threadId, turnId,
eventRecordId, ingestionSeq, rawPayloadRef, payloadHash,
targetKey, stream, topic, deliveryId, chunkIndex,
contentHash, zulipMessageId, deliveryState,
approvalId, allowedResponders, decisionState
```

The bridge delivery sidecar claims an authenticated HCO outbox lease, not a new
Hermes model prompt. It sends the authoritative completed item or its
deterministic chunks/file reference and returns the immutable Zulip message ID.
The public Hermes plugin API has no stable gateway lifecycle or adapter
accessor, so production delivery does not depend on private runner weakrefs or
session-hook background tasks. Raw event streams remain restricted audit data
and are not placed in Hermes prompts or posted to Zulip by default.

### Durable memory

Always-loaded project memory contains only stable rules, current accepted
decisions, known non-obvious risks, and indexes to details. Raw conversations
and execution histories remain searchable cold records and are not replayed by
default.

An item is promoted only when it is stable, non-obvious, reusable, scoped, and
supported by an explicit user decision or repository artifact. Each item
stores provenance, scope, timestamp, commit/content hash, confidence, and
revalidation or expiry policy.

Current user instructions and current repository facts outrank remembered
summaries. Conflicting memory is marked stale or invalid; it is not silently
merged. Automatic memory writes begin with a small allowlisted pilot and are
evaluated for stale-information rate before expansion.

### Result receipt

Each Codex turn returns or is normalized into a receipt containing:

- outcome and task status;
- changed artifacts and repository state;
- tests and verification evidence;
- unmet acceptance criteria and unresolved questions;
- decisions proposed for durable-memory promotion;
- invalid or stale context references;
- thread ID, turn ID, token/cache usage, timestamps, and correlation ID.

The receipt updates the control plane. It is not automatically copied into
always-loaded memory.

## Consequences

### Positive

- Useful Hermes clarification survives without duplicating Codex planning.
- Long context remains inspectable and versioned instead of repeatedly copied.
- Objective-scoped threads prevent unrelated project tasks from contaminating
  each other while preserving real continuations.
- Provenance, freshness, conflict handling, and receipts make context errors
  observable and reversible.
- Native Codex compaction and session behavior remain the execution authority.

### Negative

- HCO must persist and migrate a thread/task registry and context manifests.
- Lifecycle classification can be wrong and requires conservative fallbacks,
  audit logs, and A/B tests.
- Memory promotion and invalidation add operational maintenance.
- Some turns may send more high-value context even when total token use falls
  less than expected; quality remains the primary acceptance criterion.
- HCO must operate a durable event journal and Zulip outbox; App Server does
  not provide cross-system exactly-once delivery.
- Topic rename/move correctness depends on transport support or explicit
  relinking.

## Alternatives considered

### Replay the Hermes conversation to Codex

Rejected because it duplicates business dialogue, increases distraction, and
does not provide provenance, freshness, or a stable task contract.

### Ask Hermes to produce a detailed technical plan

Rejected because it creates a second coding-reasoning pass and can anchor
Codex to an inferior or stale repository interpretation.

### Keep one permanent Codex session per project or Zulip topic

Rejected as the sole policy because project/conversation scope is broader than
objective scope and can accumulate unrelated history.

### Start a new thread for every message

Rejected because it discards useful execution history and makes interruption
recovery unnecessarily expensive.

### Fork whenever repository state changes

Rejected because fork preserves the old history and therefore does not by
itself fix stale assumptions. The semantic impact of the change determines
whether to refresh and resume, fork for side work, or start new.

### Adopt LangGraph, Letta, or another full agent runtime

Deferred because current needs can be met by Codex app-server plus a small HCO
control ledger. Reconsider only if future workflows require durable multi-step
graphs that cannot be represented by the task/thread registry.

## Validation gates

Before this ADR becomes accepted, a matched benchmark must compare direct
Codex App use, current Hermes/HCO dispatch, and the proposed handoff. It records
provider-native prompt/completion/cache usage, model turns, wall time, retries,
task success, accepted-first-pass rate, omissions, regressions, clarification
turns, stale-context errors, and interrupted-task recovery.

No exact savings or claim of exceeding Codex App is accepted without this
evidence.

Rollout keeps the tmux backend available while App Server is introduced for an
allowlisted, read-only, final-only cohort. Acceptance tests cover same-topic
continuation, a new objective in the same topic, FIFO concurrency, duplicate
events, HCO/App Server restart, Zulip rate limits and partial chunk delivery,
approval authorization, cancellation, and topic rename/move behavior. Writes
and approvals follow only after recovery tests pass; streaming is last.

A single wrong-project or wrong-topic delivery, unauthorized approval/action,
or silently lost authoritative final answer stops and rolls back the affected
cohort. Percentage error thresholds do not apply to these P0 failures.
