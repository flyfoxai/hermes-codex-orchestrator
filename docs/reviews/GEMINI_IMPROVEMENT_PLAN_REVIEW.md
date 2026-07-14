# Gemini implementation-readiness review

**Review source:** Gemini CLI `gemini-3.1-pro-preview` local session, 2026-07-13  
**Verdict:** `READY_WITH_REQUIRED_ADDITIONS`

## Blocking gaps

1. The plan says `updatedAt` is generated once at operation start and remains fixed across conflict retries. Gemini considers this chronologically inaccurate: after an external edit causes a retry, the final successful write should carry the successful attempt time.
2. The plan requires `updateTaskStatus` to use the mutex and version check, but does not explicitly bind `POST /tasks/:taskId/cancel` and every other caller to the same lock and retry contract.

## Required additions

### Task status retries

Add a normative rule that all task-state changes, including cancellation and dispatch-triggered changes, enter the same taskId-scoped mutex and bounded conflict-retry implementation. Each retry must re-read and re-parse the latest task file before applying the patch.

Generate a new `updatedAt` for each write attempt after the latest content has been read. Use that one value consistently in both the metadata block and the Markdown body for that attempt. A successful retry therefore records the time of the successful merge rather than the first failed attempt.

Acceptance evidence:

- Exercise `POST /tasks/:taskId/cancel` while an external writer changes the task file.
- Confirm successful retries preserve unrelated external fields and keep both representations of `status` and `updatedAt` equal.
- Confirm retry exhaustion returns `409 task_conflict` and does not overwrite the latest external content.

Affected files in the future implementation: `runner/task-store.js`, `runner/http.js`, `runner/codex.js`, `scripts/hardening-test.js`.

### Request-body limit scope

Add this exact boundary: `HCO_MAX_BODY_BYTES` applies only to incoming request bodies parsed by `readJsonBody`. It does not cap response bodies, including `GET /tasks/:taskId/raw`.

Acceptance evidence:

- Create or fixture a task whose raw response exceeds `HCO_MAX_BODY_BYTES`.
- Confirm `GET /tasks/:taskId/raw` still returns `200` with the complete content.

### Token setup

Add a setup command that generates at least 32 random bytes as base64url or hexadecimal text and stores it in the protected token file. The command must not print or commit the generated value.

## Useful but non-blocking additions

- Retry jitter or exponential backoff could reduce contention. Fixed 20 ms waits remain acceptable for the current single-process, single-writer boundary.
- Document the meaning of `updatedAt` as the successful state-application time so future implementations do not reinterpret it as request-arrival time.

## Already sufficient

- Fail-closed authentication and fixed-length SHA-256 digest comparison before `timingSafeEqual` are actionable.
- Direct tmux creation plus strict duplicate-session recognition is the correct race-handling direction.
- Graceful shutdown specifies Node.js APIs, timeout behavior, and process exit outcomes.

## Rejected scope expansion

- Do not add HTTP ETag/If-Match semantics in this phase.
- Do not add comprehensive JSON Schema validation or a new validation framework in this phase.
- Do not replace the task Markdown fact source or introduce distributed locking.

## Implementation-readiness checklist

- [ ] Make request-body scope explicit and test oversized responses.
- [ ] Apply one mutex/retry contract to cancellation, dispatch, and direct state changes.
- [ ] Refresh `updatedAt` per retry attempt and synchronize metadata/body values.
- [ ] Test successful external-conflict replay and exhausted conflicts.
- [ ] Add a secure token-generation command to setup documentation.
- [ ] Retain the existing single-Runner and non-public deployment boundaries.

