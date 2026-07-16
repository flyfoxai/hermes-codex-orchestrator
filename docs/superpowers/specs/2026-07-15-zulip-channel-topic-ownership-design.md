# Zulip Channel And Topic Ownership Design

Date: 2026-07-15
Status: Accepted for implementation

## Goal

Make Zulip routing predictable while allowing a user to control, by explicit
command or natural language, whether the current project topic may dispatch
Codex work. Preserve real execution references without claiming Runner/tmux
provides App Server thread continuation.

## Ownership model

### Stream ownership

A Zulip stream is a project stream only when its normalized name has an
explicit mapping in either `config.zulipStreamProjectRoutes` or persisted
`state.zulipStreamProjectRoutes`. A persisted `zulipGenericStreams` entry
overrides a configured route for backward compatibility.

Every other Zulip stream is Hermes-owned. All topics in a Hermes-owned stream
remain with Hermes and HCO rejects project task dispatch and project topic
controls. HCO never derives a project from an exact or fuzzy stream/project
name match.

`/codex route set <projectId>` is the authorized operation that changes a
stream into a project stream. `/codex route none` makes the backward-compatible
Hermes override explicit. `/codex route unset` removes the runtime decision,
after which a configured mapping, if present, becomes effective again.

### Topic modes

Only a project stream has project topic modes:

| Mode | Meaning |
| --- | --- |
| `AUTO` | Default with no required state record. Hermes may dispatch project work. |
| `CODEX_BOUND` | A real Runner task was created for this topic. The record contains its real `taskId`; it does not promise model-context continuation. |
| `HERMES_ONLY` | Later project dispatch from this topic is blocked until the user restores `AUTO`. |

Legal transitions are:

```text
AUTO -> CODEX_BOUND       successful HCO task creation only
AUTO -> HERMES_ONLY       explicit command or validated semantic control
CODEX_BOUND -> AUTO       explicit command or validated semantic control
CODEX_BOUND -> HERMES_ONLY explicit command or validated semantic control
HERMES_ONLY -> AUTO       explicit command or validated semantic control
```

Repeating the current requested mode is idempotent. `AUTO` and `HERMES_ONLY`
may retain `lastTaskId` for audit and cancellation guidance, but only
`CODEX_BOUND.taskId` describes the latest bound task.

Entering `HERMES_ONLY` never cancels a task. If a real task reference exists,
the result explicitly says that it was not cancelled and shows
`/codex cancel <taskId>`.

## Commands

```text
/codex topic show
/codex topic auto
/codex topic hermes
```

These commands always target the Zulip stream/topic carried by the incoming
message. A caller cannot name another topic. Any authenticated member may show
or narrow/restore the current topic mode. This does not grant task write
permission: `/codex run` remains restricted by its existing permission rule.
Only maintainer/admin actors may change stream project routing.

For compatibility, `/codex run --project X ...` in a project stream treats
`X` as an assertion. It succeeds only when `X` equals the mapped project and
is rejected when it differs. It never overrides stream ownership.

## Natural-language contract

HCO does not call a language model and does not parse raw natural language.
The upstream Hermes model returns one tagged decision. For a topic control it
calls HCO with:

```js
{
  type: "CONTROL",
  action: "SET_TOPIC_MODE",
  mode: "AUTO" // or "HERMES_ONLY"
}
```

The HCO entry point is:

```js
applySemanticControl({ control, message, config, statePath, now })
```

`message` supplies the authoritative platform, stream, topic, actor, and
message ID. HCO derives the target key and project mapping, checks permission,
validates the exact control union, applies an idempotent transition, persists
audit fields, and returns a structured result with user-facing text. Invalid
model output fails closed with `model_protocol_error`; HCO makes no repair
model call.

## Persisted record

```json
{
  "zulipTopicModes": {
    "zulip:stockprofits/requirements": {
      "mode": "CODEX_BOUND",
      "projectId": "stockprofits",
      "stream": "stockprofits",
      "topic": "requirements",
      "taskId": "TASK-123",
      "lastTaskId": "TASK-123",
      "updatedBy": {
        "userId": "u1",
        "source": "zulip",
        "messageId": "m1"
      },
      "updatedAt": "2026-07-15T12:00:00.000Z"
    }
  }
}
```

Old state files load with `zulipTopicModes: {}`. A topic record whose stored
`projectId` differs from the stream's current mapping is stale and is ignored.
Changing a runtime stream route removes stored topic records for that stream,
preventing cross-project carryover.

## Current limitations

- This repository contains no Hermes model loop. Natural-language support is
  implemented as the deterministic HCO receiving contract; the Hermes caller
  must connect its `CONTROL` decision to that function.
- Runner/tmux returns task IDs, not App Server thread IDs. `CODEX_BOUND` cannot
  resume model context today.
- Atomic file replacement prevents a torn JSON file but not cross-process
  lost updates. The adapter should have one state-writing process until a file
  lock or transactional store is introduced.
- Existing write-task gating is project-wide and has a race between checking
  and creating a task. This design does not claim to solve that broader issue.
