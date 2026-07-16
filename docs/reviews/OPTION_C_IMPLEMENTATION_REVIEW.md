# Option C Implementation Review

## Verdict

Option C is approved for a controlled rollout. Claude and Gemini both returned
`APPROVE` with no Critical or Important blocker. The independent Task 10 code
review also returned Spec APPROVED and Quality APPROVED with zero Critical,
Important, or Minor findings. The final independent closure review also approved
both deferred Task 4 Minor remediations with zero findings.

This is approval to deploy with monitoring and rollback available. It is not a
claim that a new integration should immediately replace every existing path
without an observation period.

## Execution-Plane Boundary

The repository intentionally retains the older `runner/` + `adapter/` tmux MVP
beside Option C. They are separate execution planes, not two writers for one
state model:

- the Option C installer starts `hco/index.js`, the standalone
  `hermes-codex-bridge` plugin, and the send-only delivery sidecar;
- it does not install, import, or launch `adapter/` or migrate its JSON state;
- Option C authorizes routes only by numeric Zulip stream ID and persists its
  authority in HCO SQLite plus the signed route snapshot;
- the legacy adapter continues to key its compatibility state by stream display
  name and Runner `taskId`. Those values are never accepted as HCO route,
  objective, thread, turn, or ACL authority.

Accordingly, a deployment must choose one inbound project-command execution
plane for a Zulip bot. The old Runner LaunchAgent may remain available for
manual rollback, but it is outside the Option C bridge path and must not be
treated as synchronized state.

## Reviewer Results

| Review | Verdict | Blockers | Main conclusion |
| --- | --- | --- | --- |
| Claude final implementation review | APPROVE | None | Context continuity, terminal recovery, explicit-only tmux fallback, and durable outbox behavior satisfy the design. |
| Gemini final implementation review | APPROVE | None | All eight requested contract dimensions pass; three operational residual risks were noted. |
| Independent Task 10 re-review | Spec APPROVED / Quality APPROVED | None | Remote `cancelled` and `failed` turns now converge durably and idempotently after restart. |
| Independent Task 4 deferred-Minor closure review | Spec APPROVED / Quality APPROVED | None | Closed-transport error precedence and rejected observer-Promise containment are covered through public interfaces. |

## Contract Check

| Dimension | Result | Basis |
| --- | --- | --- |
| Correctness and completeness | PASS | Project streams route by numeric stream ID, topics bind lazily, and HCO remains authoritative. |
| Security boundaries | PASS | Signed, expiring, message-bound capabilities; restricted Hermes profiles; fail-closed validation; persistent HCO replay protection. |
| Duplicate and data-loss handling | PASS with documented edge | Durable inbound identity and outbox semantics prevent duplicate HCO execution; the Zulip POST-success/ACK-loss window can still duplicate a visible message. |
| Context continuity | PASS | One objective keeps one App Server thread across completed turns and process restarts; explicit `NEW` creates another objective/thread. |
| Recovery convergence | PASS | Completed, cancelled, failed, uncertain, and connection-loss paths have durable recovery states; uncertain writes are not automatically replayed. |
| Delivery behavior | PASS with documented edge | HCO provides durable semantic delivery identity and retry state. It cannot make the external Zulip POST and local ACK one atomic transaction. |
| Install, upgrade, and rollback | PASS | The standalone plugin and sidecars are staged and probed before activation; Hermes core remains outside the mutation boundary. |
| Operational readiness | PASS for controlled rollout | No code blocker remains. Monitoring, duplicate-message observation, and rollback readiness are still required during rollout. |

## Adjudication Of Residual Risks

### Zulip POST/ACK duplicate window

Accepted. If Zulip accepts a message but the delivery sidecar loses the response
before HCO records the acknowledgement, HCO may later resend that semantic
delivery. Eliminating this would require an idempotency contract from Zulip or a
distributed transaction across two systems. Operators should monitor duplicate
delivery rate and keep user-visible output identifiable by its HCO delivery
record.

### Hermes busy-session delay

Accepted for Option C. Exact commands still use zero Hermes model calls, but the
current public Hermes adapter can queue the rewritten private command behind an
active session. Guaranteeing immediate bypass would require a new Hermes public
extension point or a Hermes core change, both outside Option C.

### Outbox polling latency

Accepted and tunable. Delivery is asynchronous, so a reply may wait until the
next bounded poll. This affects response latency, not correctness or context
continuity. Poll interval and sidecar health should be operational metrics.

### Uncertain App Server thread start

Accepted fail-safe behavior. When HCO cannot know whether App Server received a
thread-start request, it does not repeat the request and does not silently fall
back to tmux. The objective remains blocked for reconciliation until an operator
binds the known thread or resolves the uncertainty.

### Gemini's process-local nonce concern

Partially accepted, but reclassified. The Hermes natural-language vault is
intentionally process-local and one-shot (`plugin/hermes-codex-bridge/plugin.py`):
a plugin restart can discard a short-lived request that has not yet reached HCO.
That is a bounded availability/retry concern.

It is not an unbounded duplicate-execution path. Every event that reaches HCO is
checked again against the SQLite-backed `replay_nonces` table
(`hco/state/store.js`) and against the durable Zulip source identity
`(sourceType, sourceId)` before a turn starts. The same signed capability or the
same Zulip message therefore remains idempotent across HCO restarts. A user may
need to resend after a Hermes restart, but HCO will not execute the already
accepted source message twice.

## Rollout Recommendation

Use a controlled deployment:

1. Install with the provided preflight and compatibility probes.
2. Start with one project stream and a small set of maintainers.
3. Monitor bridge availability, outbox age/retries, duplicate visible replies,
   uncertain App Server submissions, and objective reconciliation backlog.
4. Keep the documented rollback path ready during the observation period.
5. Expand project-by-project after normal commands, natural-language dispatch,
   restart continuity, cancellation, and delivery recovery have all been seen
   in the real Zulip environment.

No Hermes core source modification is required by this rollout.

## Final Verification Evidence

| Check | Result |
| --- | --- |
| Node test suite | PASS: 221/221 |
| Python plugin and delivery-sidecar tests | PASS: 264/264 |
| Installer acceptance suite | PASS: 22/22, final TAP plan `1..22` |
| Legacy HCO verification | PASS: `npm run verify` |
| Adapter verification | PASS: `npm run adapter:verify` |
| Source hygiene | PASS: shell syntax, tracked/staged whitespace, generated-cache, fixture-process, and staging-area checks |
| Hermes core boundary | PASS: adjacent Hermes checkout clean; no Hermes core source changes |

No files were staged, committed, or pushed during implementation or final
verification.
