# Final Hardening Incremental Review Request

## Objective

Perform a final read-only review of the remediated hardening implementation. This request does not authorize code changes, deployment, LaunchAgent installation, Tailscale changes, or network exposure.

## Accepted architecture and requirements

`docs/IMPROVEMENT_WORK_PLAN.md` is the accepted specification and architecture decision record. The project deliberately supports one Runner process per configuration root, keeps authentication mode as an explicit environment control, and separates code readiness from external deployment validation.

Read these existing review artifacts first:

- `docs/reviews/CLAUDE_HARDENING_IMPLEMENTATION_REVIEW.md`
- `docs/reviews/GEMINI_HARDENING_IMPLEMENTATION_REVIEW.md`
- `docs/reviews/HARDENING_IMPLEMENTATION_REVIEW_REQUEST.md`

## Remediations to verify

1. `runner/index.js`: forced shutdown must terminate with exit code 1 even when an unrelated active handle remains.
2. `scripts/hardening-test.js`: forced shutdown must cover an unrelated active handle, and 401 tests must assert that neither the configured Token nor rejected bearer value appears in captured logs.
3. `runner/config.js`: atomic project configuration temporary files must be unique, and concurrent `upsertProject()` calls must serialize the complete read-modify-write operation so registrations are not lost.
4. `scripts/hardening-test.js`: concurrent registration must deterministically exercise the former collision and prove all calls succeed, the final JSON parses, and all registered projects remain.

## Review question

Determine whether the remediations are correct, narrowly scoped, compatible with Node.js 20+, and sufficient for the accepted single-Runner boundary. Check for deadlocks, rejected-promise queue poisoning, temporary-file leakage, global-test-state leakage, flaky assertions, regressions, or weakened authentication behavior.

The existing `authMode` field in the default/file configuration is intentionally not used to select authentication mode. `HCO_AUTH_MODE` remains environment-only and defaults to `token`; changing that would allow a configuration file to disable authentication. Evaluate whether documentation already makes this operational contract clear, but do not recommend a behavior change unless you can demonstrate a concrete contradiction in the accepted plan.

## Output contract

Return one self-contained Markdown review. Include:

- findings first, ordered by severity with exact file and line references;
- explicit assessment of all four remediations;
- residual test or external validation gaps;
- one final verdict: `BLOCKED` or `READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`.

Do not edit any repository file and do not write code.
