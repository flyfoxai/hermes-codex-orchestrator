# Gemini Review: Zulip Channel And Topic Ownership

Date: 2026-07-15

## Verdict

The separation is sound: Hermes handles uncertain language interpretation and
HCO owns deterministic validation and state changes. Strict stream-to-project
mapping prevents cross-project context pollution. The three topic modes are
sufficient for the current backend.

## Must-fix recommendations

- Switching to `HERMES_ONLY` must tell the user that a running task was not
  stopped and provide its task ID when available.
- In a mapped project stream, `--project` is acceptable only when it equals the
  stream's mapped project. A different project must be rejected.
- Repeating the same requested mode should be idempotent.
- Automatic task creation needs serialization before multiple simultaneous
  Hermes decisions can safely bind a topic.

## Suggested contract

Hermes should submit a structured request containing `SET_TOPIC_MODE`, target
mode, Zulip stream/topic identity, and actor identity. HCO should return the
previous and resulting modes plus a user-facing result. `AUTO -> CODEX_BOUND`
must happen only after a real Runner task is created successfully.

Missing state records should be treated as `AUTO`. Tests should cover unmapped
streams, cross-project overrides, permissions, all transitions, audit fields,
idempotency, and concurrent attempts.

## Deferred work

Store only a real Runner task ID today. Real continuation must wait for a
backend that supplies a thread/session identity. Until then, a later task must
be described as a new task rather than continuation of prior model context.
