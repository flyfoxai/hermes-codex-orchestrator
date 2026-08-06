# 0003 - Zulip channel and topic ownership

**Status:** accepted; amended 2026-08-04 for topic-owned Codex context sessions and proven-missing App Server thread recovery
**Date:** 2026-07-16
**Supersedes:** name-based routing and Runner-task continuity in the 2026-07-15 revision
**Related:** ADR 0001, ADR 0002, `docs/superpowers/specs/2026-07-16-hermes-codex-option-c-design.md`
**Deciders:** project owner, Codex; reviewers: Claude CLI and Gemini CLI

## Context

Zulip provides a numeric stream ID, mutable stream name, and topic. The system
needs deterministic project ownership while allowing an entire stream or an
individual topic to remain with Hermes. The numeric stream owns the project
directory; each stable topic context inside that stream owns one logical Codex
context session. The displayed topic text is mutable, so rename continuity must
be proven rather than guessed.

## Decision

### Channel ownership

The numeric Zulip stream ID is the only authoritative route key. A stream is a
project channel only when that ID maps to a registered `projectId`. An
explicitly generic stream, and an unmatched stream only when a fresh,
integrity-checked snapshot authorizes the Hermes default, is managed by the
`hermes-general` profile and has no project cwd. An unavailable or invalid
snapshot is not an unmatched route and must fail closed in `zulip-ingress`.

A stream name is display metadata and may be used once as a migration alias.
Migration occurs only after an authenticated real Zulip event supplies the
numeric ID and HCO revalidates the selected project. The system never hashes,
guesses, or otherwise fabricates a numeric ID.

Maintainers and administrators manage ownership deterministically:

```text
/codex route set <projectId>
/codex route none
/codex route unset
/codex route show
```

Changing a route clears current topic selections for that stream after policy
checks. In a mapped stream, any explicit project assertion must equal the route.

### Topic state

A topic in a project stream has one of three modes:

- `AUTO`: default, with no stored row required; Hermes may dispatch project work.
- `CODEX_BOUND`: HCO has durably stored the topic context's Codex session and a
  real objective/thread binding for convenient continuation.
- `HERMES_ONLY`: new Codex dispatch is blocked; existing work and history remain.

Users may run `/codex topic show`, `/codex topic auto`, and
`/codex topic hermes`. Natural language may request the same changes through
the single Hermes model call and typed `DISPATCH`/control contract. HCO always
revalidates the authenticated actor, numeric stream route, current topic, and
requested transition. Invalid model output is `MODEL_PROTOCOL_ERROR`; there is
no repair model call.

Only HCO may set `CODEX_BOUND`, and only in the successful durable transition
that records `topicContextId`, `codexContextSessionId`, `objectiveId` and
`threadId`. A failed or uncertain thread start leaves the topic in `AUTO` and
enters reconciliation. Users and the Hermes model may set only `AUTO` or
`HERMES_ONLY`.

Entering `HERMES_ONLY` does not cancel an active turn. Cancellation is an
independent explicit action. The user may also state naturally that a topic no
longer needs Codex; the same validated transition applies.

### Continuity

An HCO `topicContextId` owns one logical `codexContextSessionId` and its primary
Codex App Server thread; an `objectiveId` owns one current thread within that
topic session, and each execution owns a `turnId`. A new topic creates neither
an objective nor a remote thread until an executable request is accepted, but
the first accepted request creates that topic's dedicated context session and
primary thread. Materially unrelated work remains in the same topic context but
gets a new objective and, when needed, a managed fork/branch; it may never use
another topic's thread.

The topic display name is a delivery address alias. A verified Zulip continuity
event or explicit operator relink is required to preserve its
`topicContextId`/Codex session across rename or move. Text similarity alone never
inherits a Codex session.

Historical Runner/tmux `taskId` values remain audit references only. They are
never promoted into App Server thread continuity.

An App Server upgrade or state loss may leave HCO with a durable thread binding
that the server can prove no longer exists. HCO may replace that binding once,
and must update the objective plus every related `CODEX_BOUND` topic in one
transaction. Recovery is authorized only by the installed App Server's exact
missing-thread response for the requested ID; transport errors, timeouts,
generic protocol errors, and message near-matches remain reconciliation-only.
The replacement preserves the original turn text and client message ID and
records both thread IDs. An uncertain replacement `thread/start` requires an
explicit operator binding and is never attempted again automatically. A
maintainer or administrator performs that binding from the objective's mapped
numeric stream with the exact command:

```text
/codex thread bind <objectiveId> <threadId>
```

HCO revalidates the stream route, topic context, objective ownership, ACL, and
trusted source Zulip message ID before changing state. It must also read and
verify that the remote thread belongs to the same canonical cwd and approved
sandbox/profile; if App Server cannot prove this metadata, binding fails closed.
The source message ID is the durable idempotency key. A repeated command may
resume the saved turn only while the
database still proves `execution_status=submitting`,
`submission_state=intent`, `turn_id IS NULL`, and no reconciliation fence. HCO
marks the submission unknown immediately before the external `turn/start` call;
after that fence, command replay never sends the turn again automatically.

## Consequences

- Channel renames do not move work to another project.
- Missing routing cannot inherit a global cwd.
- Hermes-owned streams retain normal conversation without project association.
- Every topic has a dedicated Codex context; unrelated tasks do not borrow
  another topic's thread, and any fork remains owned by the originating topic.
- Route and binding changes require transactional state and migration from the
  existing JSON adapter state.

## Verification

Tests must cover numeric-ID authority, authenticated name migration, generic
stream routing, one-directory-per-stream, one-Codex-context-per-topic,
cross-topic thread rejection, verified topic rename/relink, all topic
transitions, thread-start failure, atomic `CODEX_BOUND` persistence, duplicate
inbound events, natural-language control, restart recovery of objective/thread
bindings, maintainer-only operator binding, cross-project rejection,
source-message conflicts, known-never-sent crash resumption, and post-fence
no-resend behavior.
