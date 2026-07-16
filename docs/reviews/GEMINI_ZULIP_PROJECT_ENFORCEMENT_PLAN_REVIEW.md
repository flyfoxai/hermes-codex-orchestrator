# Gemini Zulip Project Enforcement Plan Review

**Date:** 2026-07-15
**Reviewer:** Gemini CLI 0.47.0, `gemini-3.1-pro-preview`
**Scope:** Current ADR, implementation plan, HCO source, and Hermes source
**Changes made by reviewer:** none

## Findings

### Medium: Verify `_handle_message` shared post-authorization point

- **Evidence:** `/Users/hula/Projects/hermesAgent/gateway/run.py`, around the
  authorization convergence before pending-update handling.
- **Failure scenario:** A shifted insertion point or an untested early return
  could let an authenticated path bypass post-auth scope resolution.
- **Required implementation check:** Verify the live symbol before editing and
  retain tests proving both authorized branch shapes reach the hook while all
  unauthorized returns bypass it. Pending-update handling must occur only after
  the intended scope decision.
- **Blocking:** No. The current plan already requires this exact placement and
  ordering coverage.

### Low: Double-check V4A Move paths

- **Evidence:** `/Users/hula/Projects/hermesAgent/tools/patch_parser.py` exposes
  Add, Update, Delete, and Move operations; Move carries `file_path` plus
  `new_path`.
- **Failure scenario:** Validating only the source would permit an unchecked
  destination outside the trusted project root.
- **Required implementation check:** Validate every source and destination,
  including Move `new_path`.
- **Blocking:** No. The current plan explicitly includes this field.

### Low: Preserve ContextVar propagation in concurrent workers

- **Evidence:** `/Users/hula/Projects/hermesAgent/agent/tool_executor.py` uses
  `propagate_context_to_thread(_run_tool)` for worker submission.
- **Failure scenario:** Removing or bypassing this wrapper in a refactor would
  lose the execution scope inside a worker.
- **Required implementation check:** Preserve the wrapper and keep the planned
  mapped/generic/unset propagation regression tests.
- **Blocking:** No. The current plan explicitly covers it.

## Conclusion

The architecture correctly separates HCO route/path authority from
platform-neutral Hermes enforcement. The immutable gate, numeric stream route,
canonical containment rules, authenticated hook placement, and explicit Codex
session ownership form an implementable RED/GREEN plan. No Critical or High
finding remains open.

APPROVED
