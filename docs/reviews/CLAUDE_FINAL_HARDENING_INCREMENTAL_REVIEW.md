# Claude Final Hardening Incremental Review

**Repository:** hermes-codex-orchestrator  
**Review date:** 2026-07-14  
**Reviewer:** Claude CLI (`claude-opus-4-8[1m]`), read-only plan-mode pass  
**Request:** `docs/reviews/FINAL_HARDENING_INCREMENTAL_REVIEW_REQUEST.md`

## Findings

No Critical or High issues were found.

### Low: stdout flush is not guaranteed before forced exit

**File:** `runner/index.js`

The timeout branch flushes stderr before `process.exit(1)`, while the earlier informational `shutdown started` message is written to stdout. A buffered stdout info line could be lost during forced exit. The required `shutdown_timeout` diagnostic is an error written to stderr and is flushed, so this is diagnostic-only and not a shutdown, security, or deployment blocker.

**Disposition recommended by reviewer:** no implementation change required.

### Low: environment-only authentication mode needs an explicit documentation note

**Files:** `runner/config.js`, `docs/SETUP.md`

`loadOrchestratorConfig()` intentionally selects the mode from `HCO_AUTH_MODE` and defaults to `token`, ignoring a file-based `authMode`. This is fail-closed and conforms to the accepted plan, but an operator could otherwise assume the field in the default configuration is effective.

**Disposition recommended by reviewer:** document that the file field is intentionally ignored; do not change authentication behavior.

## Remediation Assessment

### 1. Forced shutdown termination

**Status:** Correct.

The timeout path closes all HTTP connections, marks the shutdown result as status 1, and calls `process.exit(1)` after the preceding stderr writes drain. This guarantees termination even when a non-HTTP handle remains. The idempotent `finish()` guard prevents a later server-close callback from changing the result.

### 2. Shutdown and authentication regressions

**Status:** Correct.

The forced-exit child establishes an unrelated `setInterval` before importing the Runner, while a partial HTTP request holds shutdown open until the timeout. The test requires exit status 1 and the timeout diagnostic. The 401 tests capture output through completion of both responses and assert that neither the accepted nor rejected Token value is present.

### 3. Project configuration concurrency

**Status:** Correct.

The UUID suffix makes temporary paths unique even with the same PID and timestamp. Cleanup removes a failed temporary file and tolerates the expected missing source after a successful rename. The promise-tail mutex serializes the complete read-modify-write block. `finally` always releases the next waiter, so an operation failure does not poison the queue; a resolved tail does not accumulate pending promises.

### 4. Concurrent registration regression

**Status:** Correct.

Freezing `Date.now()` recreates the former temporary-path collision condition. The test proves zero rejected registrations, valid final JSON, and preservation of all ten project IDs. `try/finally` restores the global function before later scenarios.

## Residual External Gaps

- Real Codex create, dispatch, write-back, and query cycle on devmac.
- User-level launchd installation, health check, and restart validation.
- Tailscale Serve or equivalent private-network call.
- Public exposure check.
- Windows API-only regression.

## Verdict

`READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`
