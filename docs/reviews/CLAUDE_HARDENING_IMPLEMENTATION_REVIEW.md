# Claude Hardening Implementation Review

**Repository:** hermes-codex-orchestrator  
**Review date:** 2026-07-14  
**Reviewer:** Claude (`claude-opus-4-8`), read-only pass  
**Baseline:** `docs/IMPROVEMENT_WORK_PLAN.md`

## Executive Summary

No Critical or High code blockers were found. The Phase 1-3 implementation items from plan section 4 are present, and `scripts/hardening-test.js` covers the mandatory gates in section 7. The remaining unmet items in section 8 are external deployment validation activities.

## Findings

### Medium: project configuration writes can race

**File:** `runner/config.js:48`

`writeJsonAtomic()` names its temporary file with only the process ID and current millisecond. Two concurrent `upsertProject()` calls in the same process can select the same path. More generally, the two calls can both read the same prior `projects.json` and then overwrite one another's update.

**Suggested remediation:** use a UUID-suffixed temporary path and serialize the project configuration read-modify-write operation. Add a concurrent project registration regression that asserts the final file is valid JSON and contains every registered project.

### Low: file-based `authMode` is ignored

**File:** `runner/config.js:73`

`authMode` is intentionally selected from `HCO_AUTH_MODE` with a default of `token`; an `authMode` field in `config/orchestrator.json` does not alter this. This remains fail-closed but can surprise an operator who assumes every default configuration field is configurable through the file.

**Suggested remediation:** either use the merged file value when the environment variable is absent, or explicitly document that authentication mode is environment-only.

### Low: forced shutdown does not guarantee process termination

**File:** `runner/index.js:39`

On timeout, the implementation calls `server.closeAllConnections()` and sets `process.exitCode = 1`, but another active handle can keep the event loop alive indefinitely. This does not satisfy the plan's requirement to exit with code 1 after the forced-close timeout.

**Suggested remediation:** explicitly terminate with code 1 after flushing the timeout log. Extend the forced SIGTERM test with a synthetic active handle and assert bounded process exit.

### Low: the token-log assertion does not cover authentication failures

**File:** `scripts/hardening-test.js:242`

The existing console capture surrounds only the aborted-upload test. Its token assertion therefore does not inspect log lines produced by the missing-token and wrong-token requests.

**Suggested remediation:** capture the authentication test logs and assert that neither the configured token nor the rejected bearer value appears.

## Requirements Coverage

### Section 4

- Request limits, `413 payload_too_large`, chunked accounting, upload-abort handling, and response guards are implemented.
- Authentication is fail-closed, `none` is loopback-only, and token comparison uses fixed-length SHA-256 digests with `timingSafeEqual`.
- Task writes use same-directory atomic rename, a per-task mutex, content-version retries, dual metadata/body replay, and duplicate task protection.
- tmux session creation uses create-first semantics, exact duplicate parsing, and final-name validation.
- SIGINT/SIGTERM handling is idempotent and closes idle connections immediately. The forced-exit guarantee is the gap described above.

### Section 5

Unexpected 5xx responses are sanitized; the public task DTO follows the documented path boundary; `/health` remains authenticated; and TLS/rate limiting remain gateway responsibilities.

### Section 7

The mandatory hardening scenarios are implemented and wired into `npm run verify`. The authentication logging observation above is a coverage weakness rather than an implementation failure.

### Section 8

The code-side prerequisites through Phase 3 are satisfied. The following external checks remain unexecuted:

- Real Codex dispatch, task-file callback, and query regression on devmac.
- User-level LaunchAgent installation and smoke test.
- Tailscale Serve or equivalent private-network validation.
- Confirmation that the Runner port is not publicly reachable.
- Windows API-only regression where tmux dispatch is unsupported.

## Verdict

`READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`

Claude classified the findings as non-blocking for loopback validation and recommended addressing the configuration race and forced-exit gap before enabling Tailscale or LAN access.
