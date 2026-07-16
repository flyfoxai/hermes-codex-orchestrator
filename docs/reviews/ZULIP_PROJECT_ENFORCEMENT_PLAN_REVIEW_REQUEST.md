# Zulip Project Enforcement Plan Review Request

## Purpose

Review the proposed cross-repository implementation before any production code
is changed. The incident to prevent is a natural-language Zulip request from
one project stream executing in another project's working directory because
Hermes inherited a process-wide default cwd.

This request applies to the revised plan after the initial Claude and Gemini
`CHANGES_REQUIRED` reports. Do not rely on those reports as evidence; inspect
the current files and current source independently.

This is a plan review, not an implementation task. Do not write production
code, tests, configuration, or installation files. The only permitted write is
the assigned Markdown review report.

## Repositories and artifacts

- HCO repository: `/Users/hula/Projects/hermes-codex-orchestrator`
- Hermes repository: `/Users/hula/Projects/hermesAgent`
- Architecture decision:
  `/Users/hula/Projects/hermes-codex-orchestrator/docs/adr/0001-zulip-trusted-execution-scope.md`
- Implementation plan:
  `/Users/hula/Projects/hermes-codex-orchestrator/docs/superpowers/plans/2026-07-15-zulip-project-enforcement.md`
- Hermes repository guidance:
  `/Users/hula/Projects/hermesAgent/AGENTS.md`

Inspect the current source in both repositories. Do not approve assumptions
merely because they appear in the ADR or plan.

## Required checks

1. Verify the stated incident path and whether ordinary Zulip messages bypass
   the HCO `/codex` adapter.
2. Verify numeric Zulip `stream_id`, stream name, topic, Hermes session key,
   and Codex session ID are separated correctly.
3. Verify HCO can be the sole authority for `stream_id -> projectId` and
   `projectId -> canonical projectPath`, including migration from current
   name-based mappings.
4. Verify the proposed HCO HTTP contracts fit the current server, auth,
   registry, state, and test architecture.
5. Verify Hermes can expose a platform-neutral execution-scope contract while
   HCO/Zulip policy remains in an external user plugin. Verify the new hook is
   after authorization but before built-in commands, sessions, and model work,
   and that unauthorized messages cause zero post-auth hook/HCO/state activity.
6. Identify every real Hermes tool execution entry point and any path that can
   skip plugin hooks. Determine whether the proposed core gate is placed early
   enough to prevent side effects.
7. Verify fail-closed behavior for a missing, broken, slow, conflicting, or
   malformed resolver and for `confirmation_required` and `generic` routes.
8. Verify path validation covers implicit cwd, explicit workdir/path fields,
   symlinks, traversal, non-existent write targets, and the documented opaque
   shell-command residual risk without overstating security.
9. Verify task-local isolation, concurrent turns, session serialization,
   prompt-cache compatibility, temporary `HERMES_HOME` E2E coverage, and
   non-Zulip compatibility. Verify the new scope ContextVar uses token reset,
   restores nested outer state, and is cleared on exception.
10. Verify the explicit Codex JSONL invocation and resume syntax against the
   installed CLI; check session-ID parsing, persistence, route changes,
   locking, UUID/CAS ownership, process-group cancellation, stale/live runs,
   child reaping, and secret/prompt handling. Confirm the existing
   `dispatchTask()` and `POST /tasks` tmux behavior are unchanged.
11. Verify deployment order, rollback order, coexistence with the two existing
    Jarvis plugins, and the live acceptance matrix.
12. Judge whether the plan is detailed enough for strict RED/GREEN execution:
    exact files, public contracts, failure cases, commands, and exit criteria.

## Severity and verdict rules

- `Critical`: the plan can still permit cross-project execution, secret
  exposure, or unrecoverable corruption.
- `High`: a required behavior, enforcement path, compatibility constraint, or
  implementable contract is missing or materially wrong.
- `Medium`: meaningful robustness, operability, or test-detail gap that does
  not invalidate the architecture.
- `Low`: clarity, naming, documentation, or optional hardening improvement.

For every finding include:

- severity and short title;
- exact file and line or symbol evidence from current source;
- concrete failure scenario;
- exact amendment to the ADR or plan;
- whether it blocks implementation.

Do not report speculative issues without source evidence. Explicitly list any
assumption that could not be verified. Review both security and development
feasibility.

The final non-empty line must be exactly one of:

```text
APPROVED
```

or

```text
CHANGES_REQUIRED
```

Use `APPROVED` only when there are zero open Critical and zero open High
findings and the plan is sufficiently concrete to implement. Medium/Low items
may accompany approval if they are clearly non-blocking.
