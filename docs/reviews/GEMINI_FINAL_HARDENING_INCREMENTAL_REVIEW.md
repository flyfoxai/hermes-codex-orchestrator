# Gemini Final Hardening Incremental Review

**Repository:** hermes-codex-orchestrator  
**Review date:** 2026-07-14  
**Reviewer:** Gemini CLI (`gemini-3.1-pro-preview`), read-only plan-mode pass  
**Request:** `docs/reviews/FINAL_HARDENING_INCREMENTAL_REVIEW_REQUEST.md`

## Findings

No Critical or High blockers were found. The four requested remediations are implemented correctly and have direct regression coverage.

## Remediation Assessment

### 1. Forced shutdown termination

**Status:** Verified.  
**Files:** `runner/index.js`, `scripts/hardening-test.js`

The timeout branch explicitly exits with status 1 after closing all HTTP connections and flushing stderr. The regression creates an unrelated active interval handle, so a successful bounded exit proves that the implementation does not rely only on `process.exitCode` or an empty event loop.

### 2. Authentication log coverage

**Status:** Verified.  
**File:** `scripts/hardening-test.js`

The missing-token and wrong-token 401 requests run while console output is captured. Assertions verify that neither the configured `HCO_API_TOKEN` nor the rejected bearer value appears in captured output.

### 3. Project configuration concurrency

**Status:** Verified.  
**File:** `runner/config.js`

Atomic configuration writes use a UUID-suffixed temporary path. `upsertProject()` serializes the complete load, normalize, modify, and save sequence with an in-process mutex queue, preventing both temporary-path collisions and lost updates under the accepted single-Runner boundary.

### 4. Concurrent registration regression

**Status:** Verified.  
**File:** `scripts/hardening-test.js`

The test fixes `Date.now()` to reproduce the former same-process, same-millisecond collision condition, starts ten registrations with `Promise.allSettled`, requires zero rejections, parses the final JSON, and checks that every project remains. The original time function is restored in `finally`.

## Authentication Mode Contract

Keeping authentication mode environment-only is consistent with the fail-closed plan. A file configuration value cannot silently disable authentication, and no behavior change is necessary.

## Residual External Gaps

- Real Codex dispatch, task-file callback, and query regression on devmac.
- User-level LaunchAgent installation and service smoke test.
- Tailscale Serve or equivalent private-network validation.
- Confirmation that the Runner port is not publicly reachable.
- Windows API-only regression where tmux dispatch is unavailable.

## Verdict

`READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`
