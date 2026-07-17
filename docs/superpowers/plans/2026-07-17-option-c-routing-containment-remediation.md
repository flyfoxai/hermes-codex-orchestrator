# Option C Routing Containment Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent every Zulip routing-authority failure from acquiring Jarvis root's ASK identity while keeping Feishu and ASK behavior unchanged.

**Architecture:** HCO renews the signed route snapshot before its TTL expires; the bridge treats invalid authority separately from a trusted default Hermes route. A dedicated model-free `zulip-ingress` profile owns Zulip polling, while the installer restarts and attests the real gateway transactionally.

**Tech Stack:** Node.js service/tests, Python Hermes plugin/pytest, Bash installer test harness, macOS launchd.

## Global Constraints

- Do not modify Hermes core source.
- Numeric Zulip stream ID and a fresh integrity-checked HCO snapshot are the only project-route authority.
- When the bridge hook detects invalid authority, it returns `项目路由暂不可用，请稍后重试。` with zero Hermes model calls and zero HCO calls.
- Plugin absence or hook failure must remain isolated in project-neutral `zulip-ingress`, never default ASK. Without a Hermes core change, this guarantees context and credential containment, not zero internal model-call attempts.
- Preserve root Feishu, ASK cwd/prompt/memory, unrelated plugins, and unrelated credentials byte-for-byte except required gateway/Zulip ownership changes.
- Installation success requires gateway PID change and live hook plus served-profile attestation; rollback restores prior files and gateway loaded/running intent, not the old process PID.
- Hermes' busy-session guard precedes plugin dispatch, so busy exact commands may queue before the hook; immediate busy-command execution is outside this standalone plugin's guarantee.

---

### Task 1: TTL-Derived Snapshot Renewal

**Files:**
- Modify: `test/hco-service.test.js`
- Modify: `hco/service.js`

**Interfaces:**
- Consumes: `config.snapshot.ttlMs`, `snapshotPublisher(options)`.
- Produces: automatic unchanged-generation renewal before expiry and dirty retry after renewal failure.

- [x] Add a test with a short configured TTL that starts the service, observes at least two publications of generation 0 before the first snapshot can expire, and confirms close stops renewal.
- [x] Run `node --test --test-name-pattern='renews unchanged route snapshots' test/hco-service.test.js`; observe the expected pre-implementation failure.
- [x] Track the last successful publication and schedule renewal from `ttlMs`, bounded to run before expiry.
- [x] Use monotonic elapsed time for renewal scheduling and retain wall-clock timestamps only in the published snapshot.
- [x] Re-run the focused test and `npm run hco-service:test`; expect PASS.

### Task 2: Explicit Snapshot Authority And Fixed Rejection

**Files:**
- Modify: `test/hermes_plugin_contract_test.py`
- Modify: `plugin/hermes-codex-bridge/route_snapshot.py`
- Modify: `plugin/hermes-codex-bridge/plugin.py`
- Modify: `plugin/hermes-codex-bridge/plugin.yaml`

**Interfaces:**
- Produces: `RouteSnapshot`/equivalent explicit validity result and a private route-unavailable command.
- Fixed handler response: `项目路由暂不可用，请稍后重试。`.

- [x] Change contract tests so trusted unmatched streams select `hermes-general`, while missing, stale, corrupt, oversized, and integrity-invalid snapshots rewrite to the fixed private rejection under `zulip-ingress`.
- [x] Add a real gateway dispatch test proving invalid authority makes zero model/HCO calls and never enters the ordinary agent path.
- [x] Run focused pytest tests; observe the expected pre-implementation failures.
- [x] Implement the explicit authority result, hook routing, registered private command, and fixed handler.
- [x] Run `python -m pytest -q test/hermes_plugin_contract_test.py`; expect PASS.

### Task 3: Restricted Zulip Ingress Profile

**Files:**
- Modify: `test/install-hermes-codex-bridge.test.sh`
- Modify: `scripts/install-hermes-codex-bridge.sh`

**Interfaces:**
- Produces: `~/.hermes/profiles/zulip-ingress` with Zulip adapter ownership and no project/model authority.
- Preserves: default Feishu/ASK configuration and `hermes-general`/`codex-bridge` profiles.

- [x] Extend installer fixtures with default Zulip, Feishu, ASK cwd/prompt, model credentials, and unrelated configuration.
- [x] Assert every `ZULIP_*` binding, including non-credential adapter settings and `export KEY=value` syntax, moves only to `zulip-ingress`; default Zulip is disabled; ingress lacks model, project cwd/memory, Task Guard, and MCP access; all unrelated root state remains unchanged.
- [x] Run `bash test/install-hermes-codex-bridge.test.sh`; observe the expected missing-profile failures.
- [x] Implement transactional profile creation/config migration, reinstall-safe
  ingress merging, full dotenv value round trips, and project-neutral reminder files.
- [x] Re-run the installer test; expect PASS.

### Task 4: Gateway Restart, Live Attestation, And Rollback

**Files:**
- Modify: `test/install-hermes-codex-bridge.test.sh`
- Modify: `scripts/install-hermes-codex-bridge.sh`
- Modify: `test/option-c-e2e.test.js`

**Interfaces:**
- Consumes: launchd label `ai.hermes.gateway`.
- Produces: PID rotation, readiness/live hook attestation, and exact prior-state rollback.

- [x] Extend fake launchctl/gateway fixtures to model loaded/running/stopped states, PID rotation, hook/profile evidence, restart failure, and rollback.
- [x] Run focused shell/E2E tests; observe the expected lifecycle assertion failures.
- [x] Add gateway state capture, restart, PID/readiness polling, live-process attestation, dynamic platform/profile requirements, and rollback restoration, including first-install rollback where the prior plugin link and attestation are absent and cross-version rollback where the old plugin attests its own version.
- [x] Re-run `bash test/install-hermes-codex-bridge.test.sh` (28/28) and `node --test test/option-c-e2e.test.js` (7/7); expect PASS.

### Task 5: Review, Deployment, And Acceptance

**Files:**
- Modify: remediation planning/review documents as evidence is produced.

- [x] Run `npm run check`, all Node test suites, Python contract tests, and installer tests.
- [x] Ask Gemini and Claude independently to review the actual diff for correctness, lifecycle safety, rollback, and test gaps; save both outputs.
- [x] Adjudicate every finding against source, fix substantiated issues, and rerun focused verification.
- [x] Install into local Jarvis, restart `ai.hermes.gateway`, prove PID change and live hook/profile loading, then exercise ASK, stockprofits, Hermes-owned, invalid-snapshot, and plugin-absent containment cases.
- [ ] Commit the verified changes and push `codex/option-c-app-server`.

#### Review remediation: Zulip ingress YAML preservation

- [x] Trace the installer data flow and confirm `ingress_config()` ignores both root and existing ingress YAML.
- [x] Add a failing regression test for root-to-ingress migration, reinstall precedence, nested adapter settings, and installer-owned `enabled: true`.
- [x] Merge only `platforms.zulip` into the restricted ingress profile; do not inherit project/model/memory/MCP configuration.
- [x] Re-run the focused installer suite and obtain fresh Gemini and Claude reviews.

#### Review remediation: dotenv precedence

- [x] Add a first-install fixture where migrated root and pre-existing ingress
  dotenv values conflict.
- [x] Observe the pre-fix precedence failure.
- [x] Apply precedence `root < existing ingress < installer-owned overrides`.
- [x] Re-run all 28 installer scenarios and obtain a final Gemini review with
  no actionable findings.

#### Live remediation: duplicate Zulip poller ownership

- [x] Reproduce the real `ask-jarvis-pm` same-credential conflict in the
  installer fixture and observe the pre-fix activation failure.
- [x] Discover non-owned, owner-controlled profiles and disable only an enabled
  Zulip adapter whose effective API key equals the ingress key.
- [x] Preserve unrelated profile YAML and dotenv bytes, and add byte-exact
  rollback coverage for a failure after activation.
- [x] Re-run installer (28/28), Node (223/223), and Python (198/198) suites.
- [ ] Obtain fresh Gemini and Claude review of the complete post-remediation diff.
- [ ] Install and attest the real Jarvis runtime, then execute the acceptance matrix.
