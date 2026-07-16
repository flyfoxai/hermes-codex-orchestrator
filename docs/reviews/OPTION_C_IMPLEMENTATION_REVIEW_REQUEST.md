# Option C Final Implementation Review Request

Review the implemented Option C system in this working tree. This is a
read-only production-readiness review, not a request to edit files.

## Architecture And Product Contract

```text
Zulip -> standalone Hermes plugin -> HCO -> Codex App Server
      <- send-only delivery sidecar <- HCO
```

- Hermes core must remain unmodified; the integration is a standalone plugin.
- Numeric Zulip stream ID selects a registered project. Unmapped streams are
  Hermes-managed.
- Project topics are lazy. A Codex objective/thread is created only after an
  accepted execution request.
- Exact commands use zero Hermes model calls. Valid project natural language
  uses one logical Hermes model-facade call and bypasses the ordinary
  conversation loop.
- HCO is authoritative for ACL, routing, topic mode, objective/thread binding,
  idempotency, recovery, and delivery.
- One objective owns one Codex thread. Completed objectives may accept later
  source intents on the same thread; cancelled and terminal-error executions
  remain closed. Explicit NEW creates a separate objective/thread.
- An uncertain App Server write is never automatically repeated or silently
  sent to tmux. tmux runs only when explicitly configured as the backend.
- Completed output and immutable numeric Zulip delivery targets survive
  restart and lost delivery acknowledgements.

Read directly:

- `docs/superpowers/specs/2026-07-16-hermes-codex-option-c-design.md`
- `.planning/2026-07-16-option-c-implementation/task-10-brief.md`
- `.planning/2026-07-16-option-c-implementation/task-10-report.md`
- `.planning/2026-07-16-option-c-implementation/task-10-remediation-review.md`
- `hco/`, `plugin/`, `deploy/`, `scripts/install-hermes-codex-bridge.sh`
- `test/option-c-e2e.test.js`, `test/turn-controller.test.js`,
  `test/hermes_plugin_contract_test.py`, and
  `test/install-hermes-codex-bridge.test.sh`
- Relevant public Hermes extension contracts under
  `/Users/hula/Projects/hermesAgent/hermes_cli/plugins.py` and
  `/Users/hula/Projects/hermesAgent/gateway/run.py`

## Required Review Dimensions

1. Correctness and contract completeness.
2. Security boundaries, authorization, capability replay, secret handling,
   restricted profiles, and pre-authorization hook behavior.
3. Data-loss and duplicate-execution windows.
4. Objective/thread context continuity across completion and restart.
5. Failed, cancelled, uncertain, and connection-loss recovery convergence.
6. Immutable and exactly-once-at-HCO delivery behavior, including the
   documented unavoidable Zulip POST/ACK duplicate window.
7. Installer upgrade/rollback behavior and evidence that Hermes core is not
   modified.
8. Operational gaps that block rollout versus documented residual risks.

## Fresh Local Evidence

- Option C E2E: 7 passed, 0 failed.
- Node full suite: 219 passed, 0 failed.
- Hermes plugin contracts: 190 passed, 0 failed.
- Installer TAP: 22 passed, 0 failed.
- `npm run verify` and `npm run adapter:verify`: exit 0.

Do not modify files, install software, access external networks, stage or
commit changes, or reveal secrets. Do not propose modifying Hermes core as an
Option C fix.

Return exactly:

1. `VERDICT`: `APPROVE` or `REVISE`.
2. `BLOCKERS`: Critical or Important findings, each with severity and exact
   file/line evidence; write `None` if empty.
3. `RESIDUAL_RISKS`: accepted or non-blocking risks, clearly separated from
   defects.
4. `CONTRACT_CHECK`: concise pass/fail assessment for the eight dimensions.
5. `RECOMMENDATION`: rollout decision in plain language.
