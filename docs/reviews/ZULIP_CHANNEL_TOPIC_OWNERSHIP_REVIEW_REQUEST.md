# Zulip Channel And Topic Ownership Review Request

Date: 2026-07-15

## Review goal

Review a proposed routing and ownership mechanism between Zulip, Hermes, and
the Hermes Codex Orchestrator (HCO). Focus on correctness, safety, context
continuity, token efficiency, and what can honestly be implemented in this
repository today.

## Confirmed product decisions

1. A Zulip stream with a configured or persisted `projectId` is a project
   stream. The stream selects the project and its working directory. HCO must
   never infer a project by fuzzy stream-name matching.
2. A Zulip stream without a `projectId` is a Hermes stream. Every topic in it
   remains owned by Hermes and must not create or continue a Codex task/session.
3. In a project stream, each topic has one of three modes:
   - `AUTO`: default. Hermes owns the conversation until it decides project
     execution is needed; then it may create a Codex task/session.
   - `CODEX_BOUND`: the topic has a persisted Codex task/session reference and
     later project execution should continue that context when the execution
     backend supports continuation.
   - `HERMES_ONLY`: the user explicitly disabled Codex for the topic; future
     automatic dispatch is blocked. Existing history is retained and a running
     task is not cancelled implicitly.
4. Users need explicit commands and natural-language controls.
5. Avoid the existing `/codex status <taskId>` collision. Proposed explicit
   commands are `/codex topic show`, `/codex topic auto`, and
   `/codex topic hermes`.
6. Natural language is interpreted by one Hermes model call. Its protocol is a
   tagged union: `DISPATCH | CLARIFY | BUSINESS_REPLY | CONTROL | REJECT`.
   Example: `CONTROL SET_TOPIC_MODE=HERMES_ONLY`. The model only proposes a
   control action; HCO validates authority, stream, topic, transition, and
   persistence.
7. Hermes model use is binary: a strict deterministic whitelist bypasses the
   model; all other valid natural language uses exactly one Hermes model call.
   There is no weak/strong model classifier.
8. This repository currently dispatches Runner tasks via HTTP/tmux and has no
   Codex App Server `threadId` integration. Do not pretend thread continuation
   already exists. Persist only real references available from the backend.
9. Existing Zulip `/codex run --project <projectId> ...` can bypass stream
   ownership. Proposed rule: reject cross-project override in Zulip. A stream
   must first be explicitly mapped with `/codex route set <projectId>`.
10. The HCO adapter currently ignores non-`/codex` messages. Natural-language
    understanding belongs to Hermes. HCO should expose a deterministic semantic
    control contract/function that the Hermes integration layer calls.

## Proposed implementation boundary

- Add persisted `zulipTopicModes[targetKey]` records with `mode`, `projectId`,
  optional real backend references, actor and timestamps.
- Add pure functions to inspect and apply validated topic controls.
- Add the three `/codex topic ...` commands.
- Treat an unmapped Zulip stream as Hermes-owned for dispatch decisions, rather
  than asking HCO to guess/confirm a project.
- Reject `/codex ask`, `/codex run`, and semantic Codex controls in unmapped
  streams; tell the user the stream is Hermes-owned and how an authorized user
  can bind it.
- On successful task creation from a project topic, persist `CODEX_BOUND` plus
  the real `taskId`. Do not invent `threadId`.
- When entering `HERMES_ONLY`, keep previous task/session references for a
  possible later return to `AUTO`; do not cancel work automatically.
- Export a semantic control entry point for the external Hermes layer. It
  accepts already parsed structured output, never raw natural language.

## Questions for independent review

1. Which assumptions above are wrong, incomplete, or unsafe?
2. Is the three-state topic machine sufficient? Give exact transition guards.
3. What should happen for explicit project commands in an unmapped/Hermes
   stream and for `--project` in a mapped project stream?
4. What exact structured `CONTROL` input/output contract should HCO expose?
5. How should permissions, idempotency, replay protection, races, and audit
   fields work?
6. What can be implemented now with Runner task IDs, and what must wait for an
   App Server thread/session backend?
7. What migration behavior is needed for existing state files and existing
   `zulipGenericStreams` settings?
8. What are the essential tests, including negative and concurrency cases?
9. Identify changes that add complexity without improving the current system.

Return a concise Chinese review with these sections:

- verdict
- must-fix issues
- recommended state/contract
- migration and tests
- deferred App Server work

Do not edit files or execute mutating commands.
