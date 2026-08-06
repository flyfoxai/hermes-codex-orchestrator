# Hermes Turn Coordinator Necessity Review Request

Date: 2026-07-30

## Review mode

Perform a read-only architecture review. Do not modify files. Do not assume the
proposal is correct. Prefer the smallest architecture that fully closes the
failure class without relying on model behavior or transcript-tail heuristics.

Repositories:

- Hermes: `/Users/hula/Projects/hermesAgent`
- HCO: `/Users/hula/Projects/hermes-codex-orchestrator`

## Observed incident

1. In Zulip topic `hermes-v019-pc03-atomic-20260730-100608`, a prior two-tab
   clarify test atomically accepted option B. The later option A submission was
   stale.
2. The clarify tool result was durably stored as
   `{"user_response":"选项 B"}`.
3. The provider then exhausted retries with HTTP 502 before producing a normal
   assistant confirmation.
4. The durable transcript contained the user request, assistant tool call and
   tool result, but no assistant turn result. A later ordinary `你好。` in the
   same topic loaded history ending at the old tool result.
5. The model volunteered `刚才的交互测试中你选择了：选项 B`, even though the
   current message contained no selection and the old selection had been sent
   by browser test automation using the Boss account.
6. Logs and DB evidence rule out a new clarify settlement and cross-topic
   leakage. The old same-topic context was replayed.

Evidence and implementation points:

- `/Users/hula/.hermes/profiles/codex-bridge/sessions/request_dump_20260730_101300_66014a3f_20260730_102216_650609.json`
- `/Users/hula/Projects/hermes-codex-orchestrator/docs/superpowers/test-artifacts/2026-07-30-hermes-v019-interaction-atomic-manual/zulip-api-evidence.json`
- `/Users/hula/Projects/hermesAgent/agent/conversation_loop.py`, provider retry
  exhaustion around lines 4130-4305. `_persist_session` runs before the final
  error response is built.
- `/Users/hula/Projects/hermesAgent/gateway/run.py`, transient failure transcript
  handling around lines 13380-13530. The Gateway intentionally persists only
  the user message and does not treat a gateway-generated error hint as model
  output.
- `/Users/hula/Projects/hermesAgent/tools/clarify_gateway.py`. Native clarify
  pending entries and first-answer tombstones are process-local dictionaries.
- Hermes `~/.hermes/state.db` has `sessions`, `messages`,
  `delivery_obligations`, and related tables, but no durable inbound-turn
  entity. `sessions.ended_at/end_reason` represent conversation/session
  boundaries.
- HCO has durable and separate work request, Agent, Codex call, interaction,
  answer settlement and delivery state machines in
  `/Users/hula/Projects/hermes-codex-orchestrator/hco/state/`.

## Proposed architectural direction

Do not infer that a conversation ended from a provider failure. Keep these
lifecycles separate:

1. Topic conversation/session: remains active until explicit reset, archive or
   close.
2. Inbound turn: one message-processing attempt, with explicit success,
   failure, cancellation, waiting-interaction or asynchronous-handoff outcome.
3. Native clarify interaction: pending, answered, consumed, expired or
   cancelled, with answer provenance and one-shot settlement.
4. HCO work/Codex/Agent state: remains independently owned by HCO.
5. Outbound delivery: pending, delivered, failed or outcome-unverified.

Add a durable Hermes Gateway `Turn Coordinator` plus a durable native
interaction core. Transcript messages remain semantic history, not the source
of truth for whether an old operation is active. Every inbound platform
message gets a `turn_id` and idempotency key. A normal new message creates a new
turn unless it carries an exact, authorized binding to an active interaction,
work item or earlier turn. Closed/failed old turns are never resumed merely
because the transcript ends in a tool result.

Legacy or conflicting state must have deterministic safe behavior:

- no state / legacy tool tail: create a new turn and do not auto-resume;
- exact active interaction binding: route to that interaction;
- state conflict: reconciliation-required, no business side effect;
- uncertain outbound delivery: do not blindly resend;
- provider failure closes only the current execution/turn outcome, never the
  topic conversation or unrelated asynchronous work.

Implementation should be isolated behind stable Gateway lifecycle hooks and a
separate module/store, with minimal edits to upstream `gateway/run.py`. Hermes
native interactions remain Hermes-owned; HCO interactions remain HCO-owned,
but they may share a state contract and routing rules.

## Questions

Return a concrete architecture review with these headings:

1. `Verdict`: `NECESSARY`, `PARTIALLY_NECESSARY`, or `UNNECESSARY`.
2. `Root cause`: is the missing durable turn state genuinely the architectural
   cause, or can existing Hermes state represent the requirement safely?
3. `Minimum sufficient architecture`: the smallest durable model and routing
   changes that close this failure class.
4. `Overengineering`: proposed tables, states or components that should be
   removed or deferred.
5. `Lifecycle semantics`: exact distinction between conversation/session,
   turn, interaction, work and delivery; avoid the ambiguous word terminal.
6. `Recovery and migration`: restart, legacy transcript tail, concurrent new
   message, provider failure after an accepted interaction, and delivery
   outcome uncertainty.
7. `Ownership and upgrade risk`: where this belongs, how to avoid coupling
   generic Hermes conversations to HCO, and how to reduce future Hermes upgrade
   conflicts.
8. `Decision`: whether this architecture should be implemented now, replaced by
   a smaller design, or deferred. State blocking issues and required tests.

Evaluate from the human user's perspective as well: a greeting must not revive
an old failed interaction, a pending task must not block an unrelated new task,
and the system must never claim that a human personally acted when it can prove
only that an authenticated account submitted an interaction response.
