# Claude implementation-readiness review

**Review source:** Claude CLI `claude-opus-4-8[1m]` local session, 2026-07-13  
**Verdict:** `READY_WITH_REQUIRED_ADDITIONS`

The original CLI response was recovered from the local session record. Its final R4 section was truncated upstream; the R4 guidance below is a normalized summary of the already stated blocker, not a claim that missing model text was recovered.

## Blocking gaps

1. The `tmuxSession` regex permits at most 64 characters, but `normalizeProject()` generates `${tmuxPrefix}-${projectId}`. With default prefix `codex` and a 64-character projectId, the generated value reaches 70 characters. The plan does not say whether to reject, truncate, hash, or relax the limit.
2. Mid-stream request abort behavior is described, but the Node.js event, guard condition, routing behavior, and test mechanism are not frozen.
3. A task Markdown file stores `status` and `updatedAt` in both JSON metadata and body lines. The retry rules describe metadata replay but do not require body replay from the newest content.
4. The concurrent-update test requires a monotonically increasing application sequence but does not define whether it is persisted, exposed in the API, or observed only by tests.

## Required additions

### Final tmux session validation

Validate the final value after `normalizeProject()` has selected either the explicit input or generated `${tmuxPrefix}-${projectId}` value. Retain one documented maximum and use it for both paths. Do not silently truncate because two distinct project IDs can collapse to the same tmux target.

If an auto-generated value exceeds the limit, project registration must return `400 invalid_request` with `details.field = "tmuxSession"` and instruct the caller to supply a valid explicit value. Tests must cover the exact maximum, maximum plus one, and an overlong auto-generated value.

### Client abort handling

Freeze an implementation contract for Node.js 20:

- Register request close/abort observation before consuming the body.
- Treat the request as prematurely aborted only when the incoming message is incomplete, such as `!req.complete`; a normal completed request must not be misclassified.
- If stream consumption throws after a premature close, convert it to an internal request-aborted sentinel rather than an HTTP 500.
- The route/server catch path must log one structured `request_aborted` warning and must not invoke the route handler or write a response to a destroyed response stream.
- Remove listeners in `finally` and avoid an unhandled rejection.

The hardening test must use a raw TCP connection, send headers plus a partial body, then destroy the socket. It must assert no 500, no unhandled rejection, and one structured abort log.

### Metadata and Markdown body replay

Every conflict retry must re-read and parse the newest `{ metadata, body }`, merge only the declared metadata patch, then update the latest body's `Status:` and `UpdatedAt:` lines with the same attempt values. All other body text and unknown metadata fields must remain unchanged.

After a successful write, the test must parse the metadata block and separately inspect the Markdown body. Both status values and both timestamp values must match.

### Test-only application observer

The application sequence is test instrumentation only:

- Do not persist it in task metadata or Markdown.
- Do not expose it through any HTTP response.
- Allow the task-store test to provide an internal optional observer invoked after a successful atomic rename and before the task mutex is released.
- The observer receives the sequence, taskId, applied status, and applied timestamp. It must not perform task-store operations or reacquire the task mutex.
- The test compares the final file with the successful observation having the greatest sequence.

### Lock coverage

State explicitly that every caller of `updateTaskStatus`, including cancellation and dispatch success/failure paths, uses the same taskId-scoped mutex and conflict-replay implementation. Callers must not implement a second lock or bypass the shared mutation path.

## Acceptance guidance

- Explicit `tmuxSession` at exactly 64 characters succeeds; 65 fails; an overlong generated value fails without truncation.
- A clean completed request is not logged as aborted; a partial TCP upload followed by socket destruction is.
- Concurrent state updates leave a parseable task file with intact metadata delimiters.
- Final metadata/body status and timestamp equal the maximum-sequence successful observation.
- External edits to unrelated body text and unknown metadata survive a successful retry.
- Cancellation uses the same retry budget and returns `409 task_conflict` after exhaustion.

## Non-blocking guidance

- Keep retry waiting fixed for this phase unless measurements justify jitter.
- Keep the observer narrow and test-only; a production event bus is unnecessary.
- Document missing body `Status:` or `UpdatedAt:` lines as a conflict or explicit warning policy rather than allowing each implementer to decide.

## Rejected scope expansion

- Do not silently truncate or hash session names in this phase.
- Do not persist test sequence values.
- Do not add a database, distributed mutex, ETag API, or public state-transition API in this phase.

## Implementation-readiness checklist

- [ ] Validate explicit and generated tmux session names after normalization.
- [ ] Define exact premature-close detection and no-response behavior.
- [ ] Replay metadata and Markdown body fields from the latest file on every retry.
- [ ] Define a non-persistent test observer for application ordering.
- [ ] Route cancel and dispatch state changes through one mutation contract.
- [ ] Add boundary, concurrency, external-edit, and abort tests.

