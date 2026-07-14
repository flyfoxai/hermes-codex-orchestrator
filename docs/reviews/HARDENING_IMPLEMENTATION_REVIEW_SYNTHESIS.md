# Hardening Implementation Review Synthesis

**Date:** 2026-07-14  
**Specification:** `docs/IMPROVEMENT_WORK_PLAN.md`  
**Scope:** local implementation and documentation readiness through Phase 3, plus locally reproducible verification gates  
**Deployment status:** not deployed; external deployment validation remains pending

## Executive Conclusion

The implementation has no known Critical or High code blocker. Claude and Gemini independently conclude `READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION` after reviewing the final remediations. This verdict means the repository can proceed to the plan's external validation stage; it does not satisfy the loopback, Tailscale/LAN, LaunchAgent, Windows, or public-exposure deployment gates by itself.

## Review Sources

- `docs/reviews/CLAUDE_HARDENING_IMPLEMENTATION_REVIEW.md`
- `docs/reviews/GEMINI_HARDENING_IMPLEMENTATION_REVIEW.md`
- `docs/reviews/CLAUDE_FINAL_HARDENING_INCREMENTAL_REVIEW.md`
- `docs/reviews/GEMINI_FINAL_HARDENING_INCREMENTAL_REVIEW.md`
- `docs/reviews/HARDENING_IMPLEMENTATION_REVIEW_REQUEST.md`
- `docs/reviews/FINAL_HARDENING_INCREMENTAL_REVIEW_REQUEST.md`

## Findings and Final Disposition

| Source | Severity | Finding | Verification | Final disposition |
|---|---|---|---|---|
| Claude initial | Medium | Concurrent `upsertProject()` calls can collide on one temporary path and lose updates. | Fixed `Date.now()` and ran ten registrations; the old implementation produced nine `ENOENT` rejections. | Accepted and fixed. UUID temporary paths plus a mutex around the full read-modify-write operation. |
| Claude initial | Low | File-based `authMode` is ignored. | The plan and code define `HCO_AUTH_MODE` as an explicit fail-closed environment control. | Behavior change rejected. Added an explicit operator note to `docs/SETUP.md`. |
| Claude initial | Low | Forced shutdown only set `process.exitCode`, so an unrelated handle could keep the process alive. | A child with a non-HTTP interval failed to exit before the fix. | Accepted and fixed. Timeout path now flushes stderr and explicitly exits with status 1. |
| Claude initial | Low | Token-log assertion did not observe 401 requests. | The earlier console capture started after the authentication requests. | Accepted and fixed. Missing and incorrect Token requests are now captured directly and both values are asserted absent. |
| Claude final | Low | Forced exit does not separately flush the earlier stdout info log. | The required `shutdown_timeout` error is written to stderr and flushed before exit. | No code change. Possible loss is limited to a non-critical info line; the required diagnostic and exit contract are covered. |
| Gemini initial/final | None | No additional implementation blockers. | Both passes checked plan sections 4, 5, 7, and 8; the final pass rechecked the four remediations. | Accepted as corroborating review, subject to the main-agent verification below. |

## Remediation Evidence

### Project configuration concurrency

`runner/config.js` now gives every temporary file a `randomUUID()` suffix and removes leftover temporary files on failure. `upsertProject()` enters an in-process promise-tail mutex before loading `projects.json` and holds it through normalization and atomic save. The mutex releases in `finally`, so rejected operations do not block later registrations.

`scripts/hardening-test.js` freezes `Date.now()`, launches ten registrations, requires zero rejected results, parses the final file, and checks every project ID. The time function is restored in `finally`. This test failed on the old implementation and passed after the fix.

This is intentionally not a cross-process lock. The accepted boundary remains one Runner process per configuration root.

### Forced shutdown

`runner/index.js` closes idle connections at shutdown start, waits for active requests, and on timeout closes all HTTP connections before explicitly exiting with status 1 after stderr drains. The forced path test creates an independent interval handle, proving the process exit is not merely a consequence of the event loop becoming empty.

### Authentication logging

The 401 regression captures both missing-token and wrong-token requests. It asserts that neither the configured Token nor the rejected bearer value appears in logs. Authentication still defaults to `token`; `none` remains restricted to exact loopback addresses.

### Authentication configuration boundary

No file value can disable authentication. `HCO_AUTH_MODE` is environment-only and defaults to `token`; `docs/SETUP.md` now states this explicitly. The unused default/file `authMode` value may be removed in a future cleanup, but it must not become an implicit file override without first changing the accepted security plan and rerunning review.

## Requirements Audit

- Plan 4.1: request byte limits, content-length and chunked enforcement, upload abort behavior, and response-write guards are implemented and tested.
- Plan 4.2: fail-closed Token authentication, loopback-only `none`, fixed-length digest comparison, and credential-safe examples are implemented and tested.
- Plan 4.3: atomic task writes, per-task mutex, conflict replay, bounded retry, dual metadata/body updates, and duplicate IDs are implemented and tested.
- Plan 4.4: create-first tmux behavior, exact duplicate recognition, concurrency coverage, and final session-name validation are implemented and tested.
- Plan 4.5: graceful and forced shutdown behavior plus launchd/systemd operational guidance are implemented and tested where locally reproducible.
- Plan 5: unexpected 5xx responses are sanitized; internal path exposure remains within the documented trusted-caller boundary.
- Plan 7: hardening scenarios are part of `npm run verify`.
- Plan 8: external deployment gates are not complete and remain intentionally out of this development pass.

## Final Local Verification

On 2026-07-14, a fresh `npm run verify` completed with exit code 0. Syntax checks, smoke coverage, API contracts, dispatch failure and fake-Codex success contracts, and all four hardening phases passed.

A repository scan found no temporary atomic-write artifacts. Credential-example review found one stale `HCO_API_TOKEN=change-me` example in `HTTP_API_INTEGRATION.md`; it was replaced with a repository-external `0600` Token-file workflow. Remaining Bearer values outside operator commands are test fixtures or protocol placeholders, while executable documentation commands use `$HCO_API_TOKEN`.

## External Validation Still Required

1. Run a real devmac task through create, dispatch, Codex write-back, and query regression.
2. Install and verify the user-level LaunchAgent with a repository-external `0600` Token file and wrapper.
3. Verify Tailscale Serve or an equivalent private-network path before any Tailscale/LAN use.
4. Confirm the Runner port is not directly reachable from the public internet.
5. Run the API-only suite on Windows, where tmux dispatch is unsupported.
6. Confirm only one Runner process writes a given configuration root.

## Final Verdict

`READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`

Do not describe this verdict as deployed or unconditionally deployable. Public direct exposure remains unsupported, and loopback/Tailscale deployment approval depends on completing the corresponding external gates in `docs/IMPROVEMENT_WORK_PLAN.md`.
