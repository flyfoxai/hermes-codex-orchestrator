# Hermes Adaptive Topic Dispatch Repair

## Incident

An authorized request in mapped Zulip stream `4`, legacy topic `general chat`,
was routed to project `ASK` correctly but rejected before HCO received it. The
Hermes model copied a signed capability from its prompt into `hco_dispatch` and
changed the token. The plugin correctly failed closed, but the architecture had
made a model responsible for losslessly carrying an internal credential.

## Security Boundary

The numeric Zulip stream remains the project authority. Sender ACLs, trusted
session and turn identity, source message identity, project ACLs, replay
protection, and the canonical request digest remain mandatory. Topic text and
model output never infer a project. General/HERMES routes remain on
`hermes-general`.

## Repair

The plugin stores the signed HCO context token only in its bounded in-memory
vault. The model-facing tool accepts exactly one property, `semantic`. During
`pre_tool_call`, the plugin validates the semantic object and atomically moves
the request bound to the trusted `(session_id, turn_id)` into a one-shot slot
keyed by `(session_id, semantic_digest)`. The handler consumes that slot before
its first await and submits the untouched internal token to HCO.

The model-facing DISPATCH shape no longer includes `topicModeAction`. For the
wire protocol, the plugin derives `topicModeAction` from trusted topic state:
`AUTO` and `CODEX_BOUND` dispatches carry `null`; a `HERMES_ONLY` topic remains
blocked unless an explicit authorized CONTROL request changes it.

Mapped streams keep lazy topic behavior. A missing topic row reads as `AUTO`;
the first executable request creates an objective and starts a real Codex App
Server thread. The topic is promoted to `CODEX_BOUND` only after the durable
thread binding succeeds.

Unmapped streams do not enter project dispatch. They stay under Hermes and
receive a bounded Chinese registration prompt only when project execution is
requested. The prompt asks for `projectId`, canonical absolute working folder,
whether to register the numeric stream, and whether to create or continue an
objective.

## Failure And Recovery

Unused turn bindings are revoked after the model call. Duplicate pre-tool
calls, direct handler calls, cross-session calls, digest mismatches, expired
requests, and missing source message IDs fail closed. Backend uncertainty never
causes an automatic replacement thread, because that can duplicate work. A
replacement is allowed only after the backend proves the durable thread is
absent and HCO revalidates route, project, topic, and ACL authority.

For the installed `codex-cli 0.142.3`, the accepted proof is exactly JSON-RPC
code `-32600` plus message `thread not loaded: ${requestedThreadId}`. Code-only,
prefix, whitespace-tolerant, or fuzzy matches are not proof. HCO creates at
most one replacement, atomically rebinds the objective and all related topics,
reuses the stored text and `clientUserMessageId`, and audits old/new IDs with
reason `proven_missing_thread`. If replacement creation has an uncertain
outcome, HCO retains the old ID for audit, persists
`manual_thread_binding_required`, and submits the known-never-submitted turn
only after one explicit operator binding. The supported recovery surface is the
exact single-line command `/codex thread bind <objectiveId> <threadId>`, sent by
a maintainer or administrator in the objective's mapped numeric stream. It is
available even when the topic is `HERMES_ONLY`; it does not change topic routing
or make the command available to the model.

The signed command uses the trusted Zulip source message ID as its durable
idempotency identity. HCO independently validates command shape, numeric route,
objective-to-project ownership, and `backend.recover` ACL before binding. A
duplicate command resumes work only when durable execution/submission state
still proves a pre-send `intent` with no turn ID and no reconciliation flag.
Immediately before calling external `turn/start`, HCO persists
`submission_unknown`; a crash or replay after this uncertainty fence returns
the stored state and never sends a second external turn. A successful call may
acknowledge that same fenced submission to `running` with its real `turnId`.
A failure of the replacement turn does not recursively create another thread.

The command response uses action `objective.thread.bind` and a closed status
set: `ready`, `started`, `submitting`, `running`, `submission_unknown`, or
`reconciliation_needed`. Hermes renders only those statuses as readable text;
unknown shapes or statuses fail closed as protocol errors.

## Upgrade Contract

Hermes upgrades must preserve these hook facts:

- `pre_gateway_dispatch` has trusted Zulip provenance and runtime session APIs.
- `pre_llm_call` and `pre_tool_call` expose `session_id` and `turn_id`.
- tool handlers expose `session_id`; they need not expose `turn_id`.
- `pre_tool_call` runs before the registered handler.
- `post_llm_call` runs for unused-call cleanup.

The installer contract suite must fail an upgrade when any of these assumptions
changes.

Codex upgrades must also re-run an isolated initialized App Server probe for a
random nonexistent thread. The observed error code, exact message, optional
data shape, and installed Codex version must be recorded. Any signature drift
keeps automatic replacement disabled until the classifier and its exact-match,
near-match, timeout, disconnect, malformed-response, one-shot, and manual-
binding regressions are reviewed and updated.

Upgrade acceptance must also replay the same operator source message in two
durable crash fixtures: before the uncertainty fence it resumes once; after the
fence it performs zero additional `turn/start` calls. This invariant is part of
the release contract, not an implementation detail.
