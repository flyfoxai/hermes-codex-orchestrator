# Zulip Project Enforcement Plan Review Synthesis

**Date:** 2026-07-15
**Scope:** ADR and implementation plan only; no production code changed
**Gate:** implementation remains blocked until fresh Claude and Gemini reviews
both end in `APPROVED` with zero open Critical/High findings

## Initial verdicts

| Reviewer | Verdict | Blocking result |
|---|---|---|
| Claude CLI | `CHANGES_REQUIRED` | One repository-access limitation plus four source-valid High gaps |
| Gemini CLI | `CHANGES_REQUIRED` | One Critical gap in real Hermes tool-entry gate placement |

Claude's original C1 was not a product defect: that CLI run could not read the
Hermes checkout. Its H1-H4 findings were checked against HCO and accepted.
Gemini's conclusion that a gate only in `model_tools.py` would be bypassable was
accepted, while its description of `_AGENT_LOOP_TOOLS` membership was corrected
against current source.

## Verified resolutions

| Finding | Resolution in current ADR/plan |
|---|---|
| Numeric inbound identity unspecified | Add validated `SessionSource.stream_id` and HCO `NormalizedMessage.streamId`; never recover it from composite chat IDs |
| Delivery and conversation keys conflated | Preserve delivery `targetKey`; add separate numeric `routeKey` and numeric-stream/topic-hash `conversationKey` |
| New Codex path could replace tmux tasks | Require separate `dispatchCodexConversation()`; preserve `dispatchTask()` and `POST /tasks` with regression coverage |
| Legacy route migration underspecified | Non-destructive one-time import from configured `adapterStatePath`, durable digest marker, no invented stream IDs |
| Tool gate placement incomplete | Define one pure idempotent gate and exact pre-middleware/pre-side-effect ordering in concurrent, sequential, runtime-helper, and model-tool paths |
| Route mutation could occur before auth | Add generic `post_auth_gateway_dispatch`; prove unauthorized traffic causes no plugin, HCO, state, session, or model activity |
| Generic stream behavior was stale | Bind `execution_scope(mode=generic)` and continue model chat with no project tools; reserve `respond` for confirmation/errors/commands |
| Scope cleanup could leak or destroy nesting | Use a dedicated ContextVar token/reset lifecycle with nested, concurrent, and exception tests |
| Active-run and cancellation semantics incomplete | Require UUID run/Runner ownership, owner-matched CAS writes/cleanup, process-group termination, stale/live restart checks, and child reaping |
| New JS coverage incomplete | Require every new JS source/test in package syntax checks and retain both HCO verification suites |

## Codex assessment

The accepted findings are consistent with current repository behavior and the
incident boundary. The revised plan now separates authorization, routing,
delivery, conversation identity, and execution enforcement into explicit
contracts. It also preserves Hermes core neutrality and existing HCO tmux task
behavior.

This synthesis is not an approval. Fresh reviewers must inspect both current
repositories and the revised artifacts. Any new Critical/High finding blocks
implementation; valid Medium/Low findings must be fixed or explicitly deferred
here with a concrete rationale before the gate closes.

## Gemini second-review triage

Gemini's latest complete review still ended in `CHANGES_REQUIRED`. Each item was
checked against the current source and plan rather than accepted by verdict:

| Gemini finding | Codex disposition | Current resolution |
|---|---|---|
| Post-auth insertion point was not exact | Accepted | Plan and ADR now pin the call after the shared authorization exit (current `gateway/run.py:8169`) and before pending-update/built-in processing (current line 8171) |
| `handle_function_call()` scope source was implicit | Accepted and generalized | All four entry paths must use the sole `get_current_execution_scope()`/enforcement helper; none accepts a request-controlled scope or policy |
| Concurrent threads lacked ContextVar propagation | Rejected as factually incorrect | Existing `agent/tool_executor.py` already wraps `_run_tool` with `propagate_context_to_thread()` at current lines 618-624; the plan now makes preservation and regression coverage explicit |
| `invoke_tool()` needed a pre-middleware gate | Already required, wording corrected | Existing plan required it before middleware; the function name is corrected to its actual `apply_tool_request_middleware()` call and the ordering remains mandatory |
| v2 route-store default path was missing | Rejected as a plan-reading miss | The public contract already specifies `${HCO_STATE_DIR:-~/.hco}/zulip-routes.json`; no plan change is needed |

The interrupted Claude rerun produced no verdict or report update and therefore
does not count toward the gate. A fresh read-only Claude run and a fresh Gemini
run must review this amended version from source before implementation begins.

## Third-review preparation

Gemini's subsequent source review ended in `APPROVED`; its valid Medium request
for explicit gate-before-middleware/hook tests is now part of Task 2.4. Claude's
subsequent review remained `CHANGES_REQUIRED`. Codex checked its detailed
requests against installed Codex 0.142.3 and current Hermes schemas, accepting
the specification gaps while rejecting the suggestion that missing Phase-2
infrastructure was itself an implementation defect.

The current revision now freezes all `ExecutionScope`, policy, and decision
fields; the mode validation table; the token/reset ContextVar binder; the
schema-specific file-tool/V4A path matrix; the canonical containment algorithm;
and per-entry call-order tests. It also corrects Codex JSONL parsing to the
top-level `thread_id` field and defines fixed process/output limits plus the
owner-matched active-run state machine. The stated shell boundary remains
deliberately narrower than an OS sandbox.

## Final plan-review gate

Gemini's latest source-backed report ends in `APPROVED`. Claude's resumed
source-backed review also ends in `APPROVED` and withdraws its only new High
finding after confirming the execution-time `realpath` data flow. Its three
Medium observations are already covered by Tasks 1.4, 2.4, and 4.2 and require
no plan amendment.

Codex independently traced `project.path` through current HCO consumers and
confirmed that the legacy `/tasks`/tmux path is separate from the planned
canonical conversation executor. There are zero open Critical or High plan
findings. The external plan-review gate is closed and implementation may begin
under the documented RED/GREEN and verification requirements.
