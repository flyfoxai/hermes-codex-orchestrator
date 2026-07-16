# Claude Review: Zulip Channel And Topic Ownership

Date: 2026-07-15

## Verdict

The direction is compatible with the current adapter. The three topic modes
are a reasonable incremental model. The main implementation work is topic
state persistence, strict stream ownership, command parsing, and permission
and idempotency rules.

## Must-fix recommendations

- Remove project selection based on a Zulip stream name. An unmapped stream is
  Hermes-owned.
- Prevent `--project` from overriding a stream's project mapping.
- Add `zulipTopicModes` to the state schema.
- Parse `/codex topic ...` independently from the existing
  `/codex status <taskId>` command.
- When switching to `HERMES_ONLY`, explicitly say that an existing task is not
  cancelled and show the cancellation command when a task ID is known.
- Keep `zulipGenericStreams` compatible rather than introducing another
  parallel stream marker.

## Suggested transitions

| From | To | Guard |
| --- | --- | --- |
| no record / `AUTO` | `CODEX_BOUND` | mapped project stream and real task ID |
| no record / `AUTO` | `HERMES_ONLY` | mapped project stream and authorized actor |
| `CODEX_BOUND` | `AUTO` | authorized actor; do not pretend to resume context |
| `CODEX_BOUND` | `HERMES_ONLY` | authorized actor; preserve task reference and warn |
| `HERMES_ONLY` | `AUTO` | authorized actor |

The exported semantic contract should accept structured `SET_TOPIC_MODE`
actions only. Binding a real task is an internal operation. Missing topic
records should read as `AUTO`, making migration additive.

## Deferred work

Do not add a synthetic `threadId` or claim real context continuation while the
backend remains Runner HTTP plus tmux. Add those fields only after App Server
returns a real thread reference.

## Codex audit note

Two technical claims in the review need correction:

- The current compact stream-name comparison is used to produce suggestions,
  not to automatically return a fuzzy-matched project. It is still removed
  from the new flow because suggestions conflict with deterministic ownership.
- Atomic rename prevents a torn state file but does not serialize concurrent
  read-modify-write operations. Concurrency needs a separate lock or a
  serialized state update API before external callers can safely race updates.
