# Claude Zulip Project Enforcement Plan Review

**Date:** 2026-07-15
**Reviewer:** Claude CLI 2.1.177, Claude Opus 4.8
**Scope:** Current ADR, implementation plan, HCO source, and Hermes source
**Changes made by reviewer:** none

## Findings

Claude rechecked the current plan against both repositories and confirmed that
all six previously blocking specification gaps are closed:

- frozen `ExecutionScope`, `ExecutionScopePolicy`, and `ToolScopeDecision`
  contracts with strict mode validation;
- ContextVar binding through `set()` tokens and `reset(token)` cleanup;
- schema-specific path validation and exact gate-before-side-effect ordering at
  all four Hermes tool entry paths;
- top-level Codex JSONL `thread.started.thread_id` parsing;
- fixed subprocess limits and the UUID owner/CAS active-run state machine;
- exact post-authorization hook placement and fail-closed semantics.

## Withdrawn High Finding

Claude withdrew its earlier concern about `runner/config.js::normalizeProject()`
storing `path.resolve(projectPath)` instead of a registration-time `realpath`.
The source-backed data flow is:

1. The stored logical path is registry input.
2. HCO route resolution canonicalizes it with `realpath` at execution time.
3. The same canonical value is used for `registryRevision`, persisted
   conversation identity, Codex child `cwd`, and Hermes `scope.cwd`.
4. Hermes resolves that already canonical `scope.cwd` strictly and therefore
   compares equal.

No raw configured path is compared to the canonical path on the new execution
chain. The existing tmux `/tasks` path is separate and intentionally preserved.

## Non-Blocking Observations

- Legacy Adapter stream-name fuzzy matching remains only until numeric routing
  is introduced in Task 1.4; the plan already removes it from the trusted route.
- Legacy `/tasks/:taskId/cancel` does not signal a subprocess, but the new
  conversation cancellation endpoint has an independent, fully specified
  process-group lifecycle.
- `parse_v4a_patch()` exists and must be wired into the scope gate exactly as
  specified in Task 2.4, including Move destinations.

## Conclusion

No Critical or High finding remains open. The ADR and implementation plan are
sufficiently specific for RED/GREEN implementation.

APPROVED
