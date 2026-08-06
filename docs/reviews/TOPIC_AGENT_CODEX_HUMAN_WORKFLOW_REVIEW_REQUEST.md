# Topic/Agent/Codex Human Workflow Review Request

**Date**: 2026-07-28  
**Design under review**: `docs/superpowers/specs/2026-07-28-topic-agent-codex-coordination-design.md`

## Review role

Act as a skeptical product/operations reviewer. Review the design from the perspective of real people using Zulip, not only from the perspective of internal architecture or database consistency.

Do not edit files or execute mutating commands. Read the complete design and return a Chinese review.

## Required personas and journeys

Evaluate all of these perspectives:

1. **Boss/requester**: sends one requirement and expects fast acknowledgement, accurate execution, useful progress only when needed, a clear final result, and no need to understand internal IDs.
2. **Human approver**: receives a Codex/Agent request, must understand what is being approved, why they are the correct approver, consequences, expiry, and whether the action already ran.
3. **Jarvis**: may answer business language, call Codex directly, delegate multiple Agents, inspect results, reactivate an Agent, aggregate evidence, and act for a human only inside an explicit authorization envelope.
4. **Agent**: receives a bounded assignment, may call multiple Codex conversations, may need authorization or human input, must report to its parent, and may later be reactivated.
5. **Operator**: diagnoses stuck, duplicated, misrouted, restarted, partially delivered, or authorization-conflicted work without reading model chain-of-thought.

Walk through at least these scenarios:

- a normal Boss request handled by Jarvis + two Agents + one Jarvis-owned Codex call;
- a direct `/codex` request with a Codex clarification/approval and a human answer;
- an Agent-owned Codex request that needs human approval;
- Jarvis approves within delegated authority;
- requested approval exceeds Jarvis authority and reaches the correct human;
- Agent reports a weak result and Jarvis reactivates it with corrections;
- task 2 starts in the same topic while task 1 is still running;
- two topics in one project work concurrently without context leakage;
- Hermes/HCO/App Server restarts while waiting for a Codex interaction;
- a result or interaction arrives after its Agent appears to have finished.

## Review questions

1. Does the Boss receive the right acknowledgement, progress, decision requests, and final response at the right times?
2. Does the design avoid both silence and excessive internal-status spam?
3. Is every Codex result routed to the correct caller and every escalation routed to the correct Zulip topic?
4. Can a human understand the approval request and confidently decide?
5. Can a human response be deterministically correlated back to the exact Codex request?
6. Are Agent ownership, parent reporting, asynchronous waiting, reactivation, and cancellation unambiguous?
7. Can Jarvis safely approve without accidentally expanding its authority?
8. Are there deadlocks, notification loops, stale approvals, race conditions, or orphaned work not covered by deterministic fallback rules?
9. Which features would be confusing or operationally expensive for the first release?
10. Which missing acceptance tests would allow a serious user-visible failure to pass?

## Output format

Return these sections:

1. `结论` — APPROVE / APPROVE_WITH_CHANGES / REJECT
2. `人工旅程评估`
3. `P0 必修问题`
4. `P1/P2 改进`
5. `授权与审批意见`
6. `Agent 协作与重新激活意见`
7. `失败恢复与运维意见`
8. `必须新增的人工验收场景`
9. `建议写回方案的确定性规则`

For every issue, describe a concrete user-visible failure and a specific design change. Avoid generic advice.
