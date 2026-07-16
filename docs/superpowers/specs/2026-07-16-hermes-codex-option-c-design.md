# Hermes-Codex Option C Production Design

Date: 2026-07-16
Status: Approved for implementation

## Goal

Complete the production path:

```text
Zulip -> Hermes bridge plugin -> HCO -> Codex App Server
      <- Hermes bridge plugin <- HCO <- Codex App Server
```

The system must preserve Codex context across messages, return complete Codex
results reliably to the originating Zulip conversation, and use Hermes model
inference only where natural-language interpretation adds value. Correct
project selection, context continuity, authorization, and final-result delivery
take priority over token savings.

The existing tmux backend remains an explicit fallback during rollout. This
design does not modify Hermes core source.

## Fixed product rules

1. Hermes has two inference states: no model call, or exactly one call to one
   configured model. There is no fast/strong model router.
2. Exact `/codex` commands and typed mechanical replies use no Hermes model.
3. All other free-form language uses one Hermes model call. That call performs
   the useful interpretation work; it is not a classifier for another model.
4. A Zulip stream has project ownership only when its numeric stream ID maps to
   a registered `projectId`. An unmapped stream and every topic inside it are
   Hermes-managed.
5. A project topic may be `AUTO`, `CODEX_BOUND`, or `HERMES_ONLY`.
6. New topics are lazy. They do not create Codex threads until an executable
   request is accepted.
7. An HCO objective owns a Codex thread. A topic is a mutable delivery address,
   not the permanent thread identity.
8. Completed Codex technical output is stored and relayed unchanged. Hermes
   does not silently rewrite it.
9. Dangerous-operation policy and approval still apply on the direct path.
10. An uncertain App Server attempt is never silently repeated through tmux.

## System boundaries

### Hermes bridge plugin

Install a standalone user plugin at:

```text
~/.hermes/plugins/hermes-codex-bridge/
```

The plugin owns only Hermes integration:

- exact slash-command parsing and awaited command handlers;
- local pre-dispatch inspection and versioned instruction injection;
- one private awaited natural-language command using the public plugin LLM facade;
- conversion of Hermes/Zulip metadata into a versioned bridge envelope;
- short, deterministic unavailable or protocol-error replies.

It does not own objective, thread, turn, delivery, or recovery state.

`pre_gateway_dispatch` runs before Gateway user authorization and is
local-only. It must not call HCO, wait on network I/O, write durable state, or
start an untracked background task. It may inspect the incoming event, select
an allowlisted profile, populate a strictly bounded process-local pending-context
vault, and return `allow`, `rewrite`, or `skip`. Every external side effect
remains in an authorized, awaited private command handler. The vault allocation
is the only pre-authorization mutation and is bounded by short TTL, global
entry/byte limits, and per-sender quotas.

The plugin is fail-open only for an ordinary Hermes conversation whose stream
is positively identified as Hermes-managed, and fail-closed for Codex bridging
and unknown routing. If compatibility checks fail or HCO is unavailable,
already identified non-Codex Hermes chat continues, while Codex commands return
a clear unavailable error.

Hermes runs one Zulip adapter with multiplexed profiles. The default profile
is a restricted project-bridge profile; a named `hermes-general` profile owns
ordinary conversation for streams that the local route snapshot explicitly
marks as Hermes-managed. Both profiles are served by the same adapter because
Hermes rejects two pollers using the same Zulip bot credentials. A missing,
stale, malformed, or unreadable route snapshot leaves the message in the
restricted default profile. The hook may select only locally allowlisted
profile names. Prompt text and plugin hooks are not the security boundary; the
restricted profile's configured toolset is.

Hermes evaluates pre-dispatch hook results in registration order and stops
interpreting results after the first `skip`, `rewrite`, or `allow`. Deployment
therefore includes a compatibility test that enumerates all registered
pre-dispatch callbacks and rejects a configuration in which an earlier callback
can consume bridge messages. Regardless of hook order, the actual default
profile remains restricted so a compatibility failure cannot expose general
shell or filesystem tools to a project stream.

### HCO service

HCO owns:

- project and Zulip stream registration;
- topic modes and topic aliases;
- objective and Codex thread bindings;
- App Server daemon lifecycle and protocol client;
- the tmux backend adapter;
- event journal, reducers, pending interactions, and durable leases;
- final-result rendering and the Zulip outbox;
- restart reconciliation and operator diagnostics.

HCO is the only writer of its SQLite database. Its bridge API binds to loopback
or an owner-only Unix socket and requires a file-backed bearer token.

### Codex App Server

Codex App Server owns Codex thread and turn execution. The first release uses a
dedicated local `codex app-server --stdio` child process because that NDJSON
transport is black-box verified on the installed CLI. HCO initializes the
protocol, sends `initialized`, routes responses by request ID while accepting
interleaved notifications/server requests, verifies required capabilities, and
refuses unsupported protocol versions. Unix-socket daemon/proxy operation is a
later deployment option after separate reconnect and subscription tests.

The required protocol surface is:

- `thread/start`, `thread/resume`, `thread/read`, and `thread/list`;
- `thread/fork` and `thread/compact/start` when policy requests them;
- `turn/start` and `turn/interrupt`;
- completed item, turn, thread-status, token-usage, approval, and user-input
  notifications and responses.

The verified protocol has no global replay sequence. HCO supplies its own local
ingestion order and reconciles from `thread/read(includeTurns=true)`.

### Zulip transport

Hermes remains the user-facing Zulip integration. HCO owns the durable delivery
record and schedules every attempt. The standalone bridge package includes a
send-only delivery sidecar supervised by launchd. The sidecar claims leased
outbox rows from HCO, sends them through the Zulip REST API using the same bot
identity, and returns the immutable Zulip message ID to HCO. It does not poll
Zulip, receive inbound messages, or invoke a model, so one and only one Hermes
Zulip adapter remains responsible for inbound events.

The sidecar is separate because the public Hermes plugin contract exposes no
gateway startup/shutdown lifecycle or adapter accessor suitable for a durable
worker. The bridge must not depend on private `_gateway_runner_ref()` internals
or attach permanent tasks to session hooks. Reusing the live adapter through
those internals is permitted only as an explicitly version-pinned diagnostic
adapter, never as the production default.

Delivery correctness is based on numeric stream ID plus current topic. Stream
display names are metadata only.

## Hermes routing and model boundary

### Exact command path

The plugin registers an awaited async `/codex` command handler. Initial command
families are:

```text
/codex run <instruction>
/codex status [objectiveId]
/codex cancel [objectiveId]
/codex topic show
/codex topic auto
/codex topic hermes
/codex route show
/codex route set <projectId>
/codex route none
/codex route unset
/codex objective new <instruction>
/codex objective continue <objectiveId> <instruction>
/codex approve <replyToken> <choice>
/codex answer <replyToken> <text>
```

The parser accepts only the documented grammar, rejects unknown suffixes, and
never interprets unparsed text as another command. The async handler submits a
versioned envelope to HCO and waits for durable acceptance or a deterministic
failure. Hermes does not invoke a model.

The command handler receives only parsed command arguments, not the original
`MessageEvent`. Therefore the pre-authorization `pre_gateway_dispatch` hook
rewrites public `/codex` commands to a private plugin command carrying a short,
versioned command-context envelope. At the same time it selects a dedicated,
allowlisted, restricted `codex-bridge` profile namespace. Once the event reaches
Gateway dispatch, this keeps exact commands out of the ordinary model session.
Hermes' adapter-level active-session guard runs before plugin hooks, however,
and recognizes only built-in bypass commands. Under the no-core-change Option C
contract, a `/codex` command received while the same adapter session is active
is queued by Hermes and reaches the plugin after that session yields. It still
uses zero Hermes model calls, but is not guaranteed to execute immediately.
Profile selection and command rewriting are local memory operations and have no
external side effect.
The envelope contains the numeric stream ID, topic, numeric Zulip sender ID, source
message ID, original command arguments, issue time, expiry, and nonce; it is
authenticated with a local file-backed HMAC key. Gateway authorization occurs
before the private async handler is invoked, so an unauthorized sender can
never cause an HCO request. The awaited handler accepts only a valid, fresh
envelope and rejects direct private-command input, replay, or signature failure.
It never uses shared mutable "last message" state. HCO unavailability or
envelope failure produces a short deterministic error and never falls through
to a Hermes model call.

The plugin loads the HMAC key once during initialization and retains it only in
memory. A missing, unreadable, empty, or incorrectly permissioned key disables
bridge registration; it is never loaded lazily from a request path and never
appears in logs or errors.

The envelope uses canonical JSON, a maximum 120-second lifetime, at most 30
seconds of accepted clock skew, a bounded encoded size, and constant-time HMAC
verification. HCO consumes `inboundEventId` transactionally, so a valid
envelope cannot create two domain actions. HMAC protects context integrity; it
does not replace HCO authorization.

The plugin derives ACL identity only from the original Zulip payload's strictly
validated positive integer `raw_message.sender_id`. Hermes currently places the
sender email in `source.user_id`; that field is useful metadata but must never
authorize a project action. The plugin cross-checks the numeric stream/topic and
source message identity against the event before signing.

### Natural-language path

For a route snapshot entry explicitly marked Hermes-managed,
`pre_gateway_dispatch` sets `event.source.profile` to the allowlisted
`hermes-general` profile and otherwise returns `allow` unchanged. Unknown or
invalid routing remains in the restricted default profile.

For a project stream, the hook freezes the original request plus validated
Zulip provenance and route data into a process-local one-shot vault. It rewrites
the event to a private plugin command carrying a short signed capability. The
capability contains a high-entropy nonce, purpose, expiry, message digest and
byte length, and frozen stream/topic/message/sender/project/topic-mode binding;
it never contains the original request text. User-authored invocations of the
private command are rejected by the hook.

After normal Gateway authorization, the private async handler verifies the
canonical capability and atomically consumes the matching vault entry before
its first `await`. Missing, changed, expired, over-capacity, or replayed context
fails closed with zero model and HCO calls. Consumption is permanent even when
the later LLM or HCO operation fails.

The handler invokes `ctx.llm.acomplete_structured()` exactly once and never
enters the ordinary Hermes agent or conversation loop. "One call" means one
logical plugin LLM-facade operation. Hermes may transparently perform provider
transport retries, credential refresh/rotation, or configured fallback because
the current public facade exposes no fail-fast switch; this design does not
claim one physical provider HTTP request. No repair or response-summarization
model call is allowed.

The model receives the user text as a separate untrusted input block and returns
one strict semantic union. The plugin performs authoritative local validation
even when Hermes' optional JSON Schema validator is unavailable. It rejects
unknown fields, wrong scalar types, authority-like fields, empty or oversized
UTF-8 text, excessive list sizes, and excessive serialized output. Model output
can advise execution but can never supply sender, stream, topic, message,
project, cwd, profile, permission, role, token, socket, or filesystem authority.

The semantic result is one tagged union:

```text
DISPATCH       normalize an executable Codex request
CONTROL        request AUTO or HERMES_ONLY without execution
CLARIFY        ask a bounded question without execution
BUSINESS_REPLY answer through Hermes without Codex
REJECT         refuse with a stable reason code
```

`DISPATCH` carries the user's normalized intent, constraints, acceptance
criteria, bounded project/business reminders, optional objective selection,
and an optional topic-mode action. It never supplies a working directory.
Objective selection is deterministic: `objective={mode=NEW}` always creates a
new objective; `objective={mode=CONTINUE,objectiveId}` continues that exact
project-owned objective; and `objective=null` continues the topic's current
project objective when one exists, otherwise it creates a new objective. The
plugin does not infer or substitute an objective after model output validation;
HCO performs this default selection atomically against current durable state.
`CONTROL` currently permits only `SET_TOPIC_MODE` with `AUTO` or
`HERMES_ONLY`; it never creates an objective or thread. Valid `DISPATCH` and
`CONTROL` results are submitted to HCO exactly once, assembled only from the
consumed trusted context plus locally validated semantic advice. HCO returns the
user-visible durable status directly; no model summarizes it. `CLARIFY`,
`BUSINESS_REPLY`, and `REJECT` are bounded local replies and cause zero HCO
submissions.

HCO validates the union, signed sender authority, stream/project binding, topic
mode, freshness, objective reference, and execution policy. Invalid output
becomes `MODEL_PROTOCOL_ERROR`: no partial state change, no Codex turn, and no
second Hermes repair call. In `HERMES_ONLY`, ordinary `DISPATCH` is blocked
locally; only `DISPATCH` with `topicModeAction=AUTO` may reach HCO for an atomic
mode transition plus dispatch decision. `CONTROL` still reaches HCO for final
ACL enforcement.

### Strict no-model whitelist

Only these inputs bypass Hermes inference:

- a fully parsed registered `/codex` command;
- an exact approval or user-input reply bound to one pending reply token;
- an HCO-generated status, retry, acknowledgement, or terminal delivery event;
- an explicit direct-to-Codex command whose authorization is still checked by
  HCO.

All other valid free-form language invokes the configured Hermes model once.

## Identity and ownership

The persistent identifiers are independent:

| Identifier | Owner and meaning |
| --- | --- |
| `projectId` | Registered project, cwd, backend, and execution policy. |
| `deliveryTargetId` | Platform, numeric Zulip stream ID, and current topic. |
| `topicAliasId` | Stable record of a delivery address and relink history. |
| `objectiveId` | HCO-generated durable unit of user intent. |
| `threadId` | Codex thread bound to one objective after lazy creation. |
| `turnId` | One Codex execution inside a thread. |
| `itemId` | One App Server item, including completed agent output. |
| `inboundEventId` | Immutable source event identity used for idempotency. |
| `eventRecordId` | HCO journal record identity. |
| `outboxMessageId` | One immutable rendered Zulip message. |
| `deliveryAttemptId` | One send attempt for an outbox message. |

A project topic starts in `AUTO` without requiring a stored row. A validated
`DISPATCH` may create an objective and then lazily start its thread. Once an
objective is selected for convenient continuation, the topic becomes
`CODEX_BOUND`.

`CODEX_BOUND` is persisted only in the same successful durable transition that
records a real objective and its real App Server thread binding. An accepted
request that fails before `threadId` persistence leaves the topic in `AUTO`
and enters reconciliation; it never stores a placeholder binding.

`CODEX_BOUND` selects the current objective by default; it does not prevent a
new objective in the same topic. Explicit continuation selects an older
objective. Starting materially unrelated work creates a fresh objective and
thread so inherited assumptions do not contaminate the new task.

`HERMES_ONLY` prevents new Codex dispatch from the topic. It does not delete
history or cancel an already active turn. Cancellation is always separate.
Exact `run`, `objective new`, and `objective continue` commands are also
rejected while the topic is `HERMES_ONLY`; the user must explicitly run
`/codex topic auto` first. Read-only status, cancellation of existing work,
approval/input replies, and topic inspection remain available.

Numeric stream ID is the only authoritative route key and survives a stream
display-name change. A stream name is only a one-time migration alias. HCO may
materialize a name mapping under a numeric ID only after receiving a real
authenticated Zulip event containing that ID and revalidating the project; it
never fabricates or guesses a numeric ID. In the first release,
a topic rename or move requires a verified Zulip rename event or an explicit
relink command. The old address remains an inactive audit alias.

Route command semantics are deterministic. `set` creates or replaces the
numeric runtime mapping after maintainer/admin authorization and project
registry validation; `none` records an explicit Hermes-owned override; `unset`
removes the runtime override and falls back to valid static numeric routing or
Hermes ownership; `show` is read-only. Route mutation and affected topic-mode
cleanup occur in one transaction. None of these commands invokes Hermes.

## Context handoff

HCO does not replay full Zulip history on every turn. A Codex turn receives:

1. the current user instruction;
2. a compact objective brief and current acceptance criteria;
3. unresolved constraints and user corrections since the previous turn;
4. bounded project/business reminders added by Hermes;
5. file references for long context that already exists durably.

Stable repository rules remain in `AGENTS.md` or other project files. Codex
thread history supplies technical continuity. HCO uses compaction only through
explicit policy and records that decision. It forks when history inheritance is
desired and starts a fresh thread when inherited context is unsafe.

This arrangement avoids paying Hermes to reproduce Codex's detailed technical
reasoning while still allowing Hermes to improve incomplete human instructions.

## Execution backend

Define one `ExecutionBackend` contract with at least:

```text
startObjective
startTurn
interruptTurn
readObjective
reconcileObjective
respondToInteraction
getCapabilities
```

`appServer` is the preferred backend for allowlisted projects. `tmux` remains a
separately available explicit fallback and does not claim App Server thread
continuity. Neither HCO nor the plugin automatically selects tmux because App
Server is unavailable or an acknowledgement is uncertain.

HCO enforces one active turn per objective with a durable lease. Additional
requests are either queued in order or receive a stable busy response according
to command semantics. On restart, a lease is evidence to reconcile, not proof
that a turn is still active.

HCO records intent before sending `turn/start`. If the acknowledgement is lost,
it reconciles the thread instead of blindly creating another turn. A backend
failure puts the objective in `backend_unavailable` or `reconciliation_needed`.

Switching an existing uncertain objective to tmux requires an explicit operator
or user action that creates a recorded new attempt. There is no automatic
cross-backend retry.

## Durable state

Use SQLite in WAL mode as the HCO state authority. The final durability pragma
is selected from measured failure semantics and latency; this design does not
preselect `synchronous=NORMAL`.

The database has an explicit schema version and an append-only migration table.
Migrations run transactionally before the service accepts bridge requests.
Each inbound fact is handled in one transaction that appends the journal row,
applies the idempotent reducer, and enqueues any resulting outbox rows. A crash
cannot expose reduced state without its journal fact or a terminal result
without its delivery record.

HCO atomically publishes a bounded, versioned route snapshot for the plugin.
The snapshot includes generation time and integrity metadata and distinguishes
a valid absent mapping from an unreadable or invalid snapshot. The hook never
switches to `hermes-general` on snapshot failure.

### Event journal

`event_journal` is append-only and contains:

- `eventRecordId` and monotonic `ingestionSeq`;
- source type and immutable source ID;
- receive time and schema version;
- project, delivery target, objective, thread, turn, and item references;
- typed payload and integrity metadata.

A unique source identity prevents duplicate reduction. Reconciliation facts
learned from reads are stored as explicitly labelled local reconciliation
events, not misrepresented as replayed App Server notifications.

### Reduced state

Reducer tables cover:

- projects and numeric stream routes;
- topic aliases and modes;
- objectives and objective-thread bindings;
- turns, items, backend state, and durable leases;
- pending approvals and user-input requests;
- reconciliation state and schema migrations.

Reducers are idempotent. Objective and turn state transitions reject illegal
backward movement except through an explicit reconciliation or correction
event.

### Zulip outbox

`zulip_outbox` stores an immutable rendered payload, delivery-target snapshot,
semantic uniqueness key, sequence within objective, state, attempt count, and
last error. `delivery_attempts` records each attempt and any returned Zulip
message ID.

One transaction appends an event, updates reduced state, and enqueues resulting
outbox messages. Platform delivery occurs only after commit. Messages for one
objective are ordered; independent objectives may deliver concurrently.

On an uncertain delivery failure, HCO retries the same semantic outbox message
with the same visible delivery marker. Zulip does not expose a proven
idempotency key, so a crash after send but before acknowledgement can create a
duplicate platform message. The system guarantees no loss and no regenerated
semantic identity, records this honest at-least-once window, and gives operators
a stable marker for deduplication.

## Result and interaction delivery

Completed Codex agent-message items are authoritative final content. Delta
events may produce optional progress notices but are not final truth.

When `agentMessage.phase` is present, `final_answer` items are final content and
`commentary` items are progress only. Because the protocol permits a null phase,
the reducer falls back deterministically to terminal item order and reconciles
with `thread/read(includeTurns=true)` whenever the completed turn's items view
is not full.

HCO stores the completed technical text unchanged. If it exceeds Zulip limits,
HCO creates deterministic ordered chunks or a durable file attachment with a
short index. Chunk retry preserves order and semantic identity.

Text rendering is deterministic and versioned. Version 1 normalizes line
endings to LF, preserves the stored final text otherwise unchanged, targets a
maximum UTF-8 payload of 9,000 bytes per Zulip message, and prefers the last
blank-line boundary, then the last line boundary, then the last Unicode scalar
boundary that fits. A fenced Markdown block that crosses a boundary is closed
and reopened with the same fence marker and language tag. Every visible chunk
starts with `[objective <shortId> result i/N]`; that marker is part of the
content hash and stable idempotency identity. Oversized single attachments or
payloads that cannot be represented by this rule become a durable file plus a
short deterministic index message.

App Server approval and user-input requests are durably recorded before a Zulip
prompt is enqueued. Each prompt contains a short opaque reply token and bounded
choices where applicable. A reply is accepted only when all are true:

- sender is authorized;
- delivery target matches;
- token identifies the same objective, turn, and request;
- request has not expired or already been answered.

HCO records the reply before responding to App Server.

An interaction expires after 24 hours by default; a project may configure a
value from 5 minutes through 7 days. The absolute deadline is fixed when the
request is journaled and is not extended by retries, reconnects, or keep-alive
traffic.

Cancellation records intent before `turn/interrupt`. Ordinary late final
delivery is suppressed after confirmed cancellation, but any late App Server
completion remains in the journal for audit. One labelled cancellation
acknowledgement is delivered.

## Restart and reconciliation

On HCO restart or App Server reconnect:

1. open and migrate SQLite, then recover pending outbox rows;
2. reconnect to the daemon and verify protocol capabilities;
3. rate-limit reconciliation across nonterminal objectives;
4. call `thread/read(includeTurns=true)` and compare known turns and items;
5. append labelled reconciliation events and reduce them idempotently;
6. restore still-valid interactions and mark unverifiable requests for operator
   action;
7. release or renew leases based on reconciled server state;
8. resume ordered outbox delivery;
9. never create a replacement turn solely because an acknowledgement is
   missing.

If App Server is unavailable, normal Hermes chat remains available. Affected
Codex objectives expose `backend_unavailable` and retain their durable state.

## Security and compatibility

- Project cwd comes only from the HCO project registry. Zulip content cannot
  select an arbitrary path or override the stream's project.
- HCO project ACLs are keyed by immutable Zulip user ID with `viewer`,
  `contributor`, and `maintainer` grants. Viewers may inspect project/topic
  state; contributors may create or continue objectives within project policy;
  maintainers may change route/topic ownership and select explicit fallback.
  Approval/input replies additionally require membership in the request's
  stored responder set. A deployment-wide admin grant may manage all projects.
  Stream membership, display names, Hermes/model roles, and envelope fields do
  not create grants.
- HCO and App Server sockets are local and owner-readable. Bridge credentials
  are file-backed and never placed in command-line arguments.
- Payloads are typed, size-bounded, and schema-versioned. Known secrets are
  masked in logs, and database/outbox files use restrictive permissions.
- Approval policy remains enforced by Codex and project configuration. The
  direct path does not add default auto-approval.
- Plugin and HCO protocol versions are explicit. Every bridge request sends
  integer `protocolVersion: 1`, a non-empty bounded `pluginVersion` string, and
  a capability list. Compatibility returns `protocolVersion`,
  `peerPluginVersion`, and the capability intersection. HCO accepts only the
  configured integer protocol version and returns `BRIDGE_VERSION_UNSUPPORTED`
  before reading peer metadata or causing any durable side effect on mismatch.
  Plugin startup and sidecar health checks call the
  same read-only compatibility endpoint and verify the installed Hermes and
  App Server capabilities.
- Contract tests run against the installed Hermes checkout. An unsupported
  Hermes upgrade disables only the bridge and reports the incompatibility.
- Codex Desktop visibility is an acceptance observation, not a correctness
  dependency, because the protocol does not guarantee ordinary desktop-list
  presentation.

## Observability

Record without exposing prompt or secret content:

- Hermes model calls per inbound message;
- Hermes input/output token usage when available;
- objective, thread, turn, and backend identifiers;
- time to durable acceptance, first progress, completion, and Zulip delivery;
- retries, duplicate suppression, reconciliation outcomes, and outbox age;
- App Server token usage and compaction events.

The expected invariant is zero Hermes model calls for exact commands and relay
events, and exactly one logical plugin LLM-facade call for valid project
free-form language. Provider transport attempts are measured separately because
Hermes may transparently retry beneath the facade. Measurements inform later
optimization but do not weaken correctness gates.

## Migration and rollout

Implementation proceeds in these gates:

1. Define versioned bridge contracts and pure identity/routing rules.
2. Add SQLite migrations, journal, reducers, leases, and outbox behind tests.
3. Add fake App Server and fake Zulip integration tests for duplicates,
   disconnects, restart, lost acknowledgement, late completion, interaction
   expiry, authorization, chunking, and ordered delivery.
4. Implement the App Server daemon client and run a read-only/final-only canary
   on one allowlisted project.
5. Black-box test whether created and resumed App Server threads appear in
   Codex Desktop; record the result without changing the correctness contract.
6. Verify real restart reconciliation and final-result delivery.
7. Enable approvals, user input, cancellation, and write-capable canary turns.
8. Install the standalone Hermes plugin and enable exact commands.
9. Enable the one-call natural-language typed-dispatch path.
10. Expand per project while retaining explicit tmux rollback.
11. Add streaming progress only after final-only delivery is stable.

Automatic fork and compaction policies are deferred in the first release.
Those App Server methods are invoked only by explicit operator or user action
until measured context-quality evidence justifies an automatic policy.

Existing JSON state is migrated or imported into the new tables without
inventing App Server thread continuity for historical tmux tasks. Current
`taskId` values remain audit references.

The single Zulip adapter should use `ZULIP_CONTEXT_DEPTH=0`. Hermes session
continuity and HCO/Codex objective continuity carry project context; replaying
topic history through the adapter would duplicate context and token cost. This
is a deployment default and is verified before rollout rather than silently
overwriting an operator setting.

Immediate rollback triggers are:

- execution in the wrong project;
- delivery to the wrong stream or topic;
- unauthorized approval or user input;
- duplicate execution;
- silently missing final output.

## Acceptance criteria

The implementation is complete when all of the following are demonstrated:

- project and Hermes-owned streams route according to numeric stream mapping;
- one Zulip bot credential is consumed by one adapter/poller;
- dynamic profile selection determines session namespace, profile home, and
  Zulip toolset before slash-command or model execution;
- a missing/corrupt snapshot or hook exception remains in the restricted
  profile;
- forged, expired, replayed, and concurrent command envelopes fail closed;
- route management commands invoke zero Hermes model calls;
- a new project topic creates no Codex thread until an executable dispatch;
- exact commands produce no Hermes model call;
- exact commands execute immediately when the adapter session is idle and are
  delivered from Hermes' pending queue when that session is busy, without
  falling through to the Hermes model;
- free-form language produces at most one Hermes model call;
- `HERMES_ONLY` is controllable by exact command and natural language;
- one objective resumes the same App Server thread across turns and restarts;
- a clearly new objective receives a fresh thread;
- duplicate Zulip events do not duplicate turns;
- lost App Server acknowledgements do not create replacement turns;
- completed technical output reaches the correct topic unchanged;
- uncertain Zulip delivery preserves one semantic identity and exposes the
  narrow at-least-once duplicate window instead of silently losing output;
- approvals and input cannot be answered by the wrong sender or topic;
- restart reconciliation restores nonterminal work and pending delivery;
- schema upgrades and crash points preserve the journal/reducer/outbox atomic
  invariant;
- App Server failure does not silently run the task through tmux;
- an incompatible bridge does not break normal Hermes chat;
- the installed plugin requires no Hermes core source modification.

## Explicit non-goals

- replacing Hermes' general conversation behavior;
- choosing among weak and strong Hermes models;
- reproducing full Codex reasoning inside Hermes;
- guaranteeing Codex Desktop list visibility without observed support;
- automatic topic rename inference without verified Zulip continuity data;
- automatic cross-backend retry of uncertain execution;
- streaming every App Server delta in the first production release.
