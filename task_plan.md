# Option C Completion Plan

## Goal

Finish the hardened Option C bridge without modifying Hermes core, install it
into the local Jarvis instance, verify real Zulip routing, then commit and push
`codex/option-c-app-server`.

## Phases

- [in_progress] Repair adaptive compatibility for legacy or unregistered project topics: internal-only capability, unmapped-stream behavior, installer/profile contract, upgrade documentation, review, fresh release gates, transactional deployment, and runtime attestation are complete; only fresh authorized boss-ID-8 Zulip acceptance remains.
- [completed] Close the eleventh-pass approval-safety and compact-notification gaps after Codex CLI v2 plan approval: Zulip command rendering is token-gated, object/extended approval decisions are UI-only except decline/cancel, objective mismatch errors are user-visible, and short project IDs participate in verb-object containment.
- [completed] Reproduce and fix rollback verification of HCO-owned runtime files.
- [completed] Trace and fix the real `zulip-ingress` activation failure with tests.
- [completed] Run focused and complete repository verification.
- [completed] Obtain fresh Gemini and Claude reviews and adjudicate findings.
- [completed] Transactionally disable same-credential Zulip pollers in external profiles, with RED/GREEN and rollback coverage.
- [completed] Reinstall into `/Users/hula/.hermes` and verify live routing/renewal/attestation.
- [completed] Update final evidence, review changes, commit, and push.
- [completed] Reproduce the launchd-owned App Server failure and add RED regression coverage for its environment.
- [completed] Implement deterministic launchd PATH/HOME, equivalent canary, and post-activation App Server health gating.
- [completed] Add bounded runtime reconnect/availability state and human-readable Zulip failure/status responses.
- [completed] Add deterministic trusted route queries for projectId and canonical cwd without model inference.
- [completed] Run focused verification and dual-model review, and adjudicate all actionable findings.
- [completed] Transactionally reinstall into Jarvis, restart affected services, and verify the live stockprofits path.
- [completed] Eliminate duplicate Hermes plugin discovery by migrating immutable HCO releases outside `plugins/`, with upgrade and rollback coverage.
- [completed] Accept safe Python runtime caches during legacy release migration without allowing ignored-path security bypasses.
- [completed] Re-run the release gates, review the migration, retry the live transaction, and verify real Zulip dispatch.
- [completed] Trace the accepted real App Server turn that lost its completion notification, add a RED regression, and fix the root cause.
- [completed] Repair the SQLite WAL/SHM lifecycle split with RED/GREEN installer coverage.
- [completed] Record final evidence, run fresh dual-model review and release gates.
- [completed] Reinstall into Jarvis and verify sidecar inode continuity plus a new real stockprofits smoke.
- [completed] Adjudicate the final Gemini residual findings against source and tests.
- [completed] Commit and push the verified release.
- [completed] Repair the Jarvis Hermes context/provider rollout: close the canonical provider-shadow gap, run fresh release gates, and deploy transactionally; lawful ASK/stockprofits/general reply acceptance remains part of the message-ID handoff phase because local credentials cannot author boss ID `8` traffic.
- [completed] Repair the Zulip `MessageEvent.message_id` to `SessionSource.message_id` compatibility handoff and deploy it without Hermes core changes.
- [completed] Isolate the Python contract-test process from live Hermes state and prove a full plugin-contract run cannot rewrite the production Gateway attestation.
- [completed] Complete reply-bearing ASK/stockprofits/general live acceptance from authorized boss ID `8`: stockprofits `380 -> 382/386`, ASK `381 -> 383`, and General `384 -> 385`, with independent Zulip readback and HCO completion/outbox evidence where applicable.
- [completed] Complete the authorized nine-message cross-channel matrix (`G-001/A-001/S-001`, same-text isolation, and burst) with independent Zulip, HCO, route, and log evidence.
- [completed] Diagnose the matrix failures and add RED/GREEN trusted route-query regressions without weakening capability validation.
- [completed] Run release gates, complete mandatory code review, and deploy the route-query repair transactionally.
- [completed] Send and independently verify post-fix General, ASK, and stockprofits live acceptance messages, including progress-only bursts and no-HCO/no-capability evidence.
- [completed] Decide and implement bounded live-test markers as an optional `route.show` reply field; preserve the old reply when no marker is present.
- [completed] Obtain fresh authorized boss ID `8` post-deployment acceptance for General, ASK, and stockprofits, including marker echo and no-HCO evidence.

## Constraints

- Do not modify Hermes core source.
- Preserve unrelated user changes.
- Never expose Zulip credentials or other secrets in logs or documentation.
- Production changes require a failing regression test first.

## Errors Encountered

- The first Jarvis context repair reached the normal Hermes agent path but the
  isolated `codex-bridge` profile had no inference provider, producing
  `No inference provider configured` / provider-authentication failures instead
  of Jarvis replies. The repair must snapshot only the default profile's active
  inference closure and prove Hermes can resolve it before activation.
- The first post-fix installer GREEN run was externally terminated with exit
  143 after its early transaction cases passed. It produced no assertion or
  product error. Confirm no fixture process remains, then retry once with a
  direct long-running session and shorter output polls; investigate rather
  than repeat if SIGTERM recurs.
- The subsequent line-numbered trace passed the rollback assertion previously
  suspected after a PTY-only early exit, continued through all remaining
  scenarios, and exited 0 with `1..31`. A fresh normal-mode installer run is
  still required as release-gate evidence before deployment.
- The fresh normal-mode installer rerun after the Gateway/session-store probe
  repair completed with `1..32` and exit code zero. Continue with the remaining
  repository gates and mandatory review before production deployment.

- The first follow-up GREEN route-query run covered `。回显` but not the live
  `，并回显` connector: three focused tests passed and three failed. The next
  change added only the optional connector to the bounded marker grammar; the
  focused set then passed `6/6`.

- The provider/general repair is deployed and all local/runtime gates pass.
  Three real Zulip messages from SpecPlanner ID `10` were accepted by Zulip but
  rejected by the expected Gateway allowlist, so they produced no replies.
  This was a temporary acceptance dependency, not a reason to weaken security.
  The authorized boss later supplied messages `380`, `381`, and `384`; their
  reply-bearing evidence closed the pending ASK/stockprofits/General phase.

- The inherited release-gate list named `npm test`, but this repository has no
  `test` script. npm exited with `Missing script: "test"` before running code.
  Use the repository's documented `npm run verify` plus all `test/*.test.js`
  files through Node's test runner.

- The first all-Node run passed 236/237. A 10 ms timeout test waited for
  `setImmediate` before attaching `assert.rejects`, so full-suite event-loop
  load could reject the promise first and trigger Node's unhandled-rejection
  failure. The same test passed alone. Attach the rejection assertion before
  yielding while retaining the committed-frame assertion.

- The first scenario-30 suite run failed during the initial fresh-install
  scenario because the test harness forwarded an empty SQLite stop-delay value
  and the fake HCO attempted `float("")`. This was fixture contamination, not
  the expected production RED; normalize the empty test value to the prior
  default before evaluating scenario 30.

- The first documentation update for the SQLite incident used a heading that
  exists in `findings.md` but not `progress.md`; `apply_patch` rejected the
  complete patch without changing files. Retried with exact existing anchors.

- First live install rolled back because a renewed route snapshot was compared
  byte-for-byte after the restored HCO had resumed ownership of it.
- The outer rollback error masked the original activation exception; inspect the
  ingress adapter contract before retrying deployment.
- The second live activation correctly failed attestation because the existing
  `ask-jarvis-pm` profile sorted before `zulip-ingress` and claimed the same
  Zulip bot credential. Hermes then refused to serve the ingress duplicate.
- The first residual-finding probe was intercepted by JavaScript template
  interpolation before Python started; the escaped retry then failed because a
  relative-import plugin cannot be loaded as an isolated file module. Reuse the
  repository's package-aware test loader for the next probe.
- A temporary-home `PluginManager` probe did not install the compatibility
  wrapper because the synthetic home lacked the full installed-plugin metadata.
  After three harness failures, stop emulating plugin discovery and verify the
  decisive real contracts directly: scoped `get_secret()` and YAML loading.
- A long, truncated review output visually repeated
  `rollback_produced_valid_attestation`; the attempted cleanup patch did not
  apply. Direct numbered source inspection confirmed the file contains only one
  condition, so no production change was required.
- The live HCO process accepted bridge requests while its Codex App Server child
  was absent. Under launchd's default PATH, the configured Codex wrapper could
  not resolve `node`, so initialization ended with transport EOF and the plugin
  exposed the internal `backend_unavailable` JSON to Zulip.
- The first remediation installer run reached the new post-activation health
  gate and failed because the fresh-HCO test fixture returned a compatibility
  document for every HTTP path. The resulting rollback also reported an HCO
  service-settle failure. Preserve old-HCO fixtures, but teach the fresh-HCO
  fixture to answer `/v1/health` before reassessing rollback behavior.
- A fresh plugin-contract run used system `python3` and failed at import time
  because that interpreter does not contain Jarvis' `hermes_cli`. This is a
  harness selection error. The guessed `/Users/hula/.hermes/venv/bin/python`
  also does not exist, and unittest entry points are inapplicable because this
  is a pytest module. Resolved with Jarvis' actual runtime interpreter at
  `/Users/hula/Projects/hermesAgent/.venv/bin/python3 -m pytest`.
- Direct execution of the installer returned `permission denied` because the
  repository shell script is not executable. Invoke it through `bash`; do not
  change file mode as an unrelated deployment-side edit.
- The setup guide uses illustrative secret filenames that are not the live
  HCO paths. Treat `hco.json` as authoritative and validate its referenced
  owner-only files instead of assuming the examples exist.
- The first live availability-remediation transaction passed the App Server
  canary and post-activation HCO readiness gate, then exited at the Gateway
  activation evidence gate because the Hermes Codex bridge attestation did not
  match the activated release. Do not retry until rollback state and the
  symlink/Gateway/attestation boundary are traced.
- Hermes `PluginManager._scan_directory_level()` treats the stable symlink and
  every historical `plugins/hermes-codex-bridge-*` release directory as
  separate manifests. They share one manifest key, and the last sorted path
  wins, so the stable link is not authoritative. The live scan reproduced
  three candidates and selected a historical directory. Releases must move to
  a non-discoverable owner-only store, with transactional legacy migration.
- The first migration rollback RED restored the old stable symlink but not its
  target directories. `commit_release_migrations()` had cleared the migration
  ledger immediately after HCO process readiness, before App Server health,
  Gateway attestation/stability, and delivery readiness could still fail.
  Moving that commit to the final success boundary preserved the original
  activation error and restored every migrated release on rollback.
- A read-only live SQLite probe incorrectly queried `stream_id` directly from
  `topic_modes`; that table keys through `alias_id`. No state changed. Use the
  documented join through `topic_aliases` for subsequent topic-state checks.
- The first smoke harness imported a synthetic `hermes_codex_bridge` package
  name, but the installed plugin directory is not exposed under that name.
  Import failed before token generation or HCO submission, so no objective or
  Zulip message was created. Retry with the installed directory on `sys.path`
  and its real top-level `bridge_client` module.
- A later smoke probe imported the installed `plugin.py` as a standalone module
  and hit its relative import before dispatch. No task was created. Use the
  installed package-aware loader rather than direct file import.
- The first completion poll queried `turn_submissions.state`; the production
  schema names that column `submission_state`. Schema inspection corrected the
  read-only query without changing production state.
- The first Zulip confirmation attempted the unavailable Python client method
  `get_message`. Retrying with `get_messages` recovered the delivered message.
- A read-only audit query used `turn_id` and `created_at_ms` against
  `turn_audit_facts`; its actual keys are `submission_id` and `recorded_at_ms`.
- `launchctl procinfo` requires root on this host and was not used as evidence.
  PID ownership was instead checked with `launchctl list`, `ps`, logs, and the
  signed runtime attestation.
- One diagnostic JavaScript wrapper referenced an undefined local `uid`. The
  corrected read-only probe succeeded; no service or repository state changed.
- A full plugin-contract run imported the real Gateway module outside a
  function-scoped temporary-home fixture. Hermes plugin discovery has a
  registration-time attestation write, so the pytest PID replaced the live
  Gateway attestation even though all assertions passed. Added collection-time
  `HOME`/`HERMES_HOME` isolation plus a session guard that compares the original
  attestation bytes before and after the suite.
- The first isolation GREEN assertion compared macOS `/var` and canonical
  `/private/var` spellings as raw strings. The sandbox was active and the live
  attestation hash was unchanged; compare resolved paths instead.
- The first RED wrapper used zsh's read-only `status` parameter, so the expected
  pytest failure was followed by a shell-assignment error before its after-hash
  line. Retried subsequent evidence with the neutral variable name `rc`.

- The authorized route-query matrix messages `391-405` were received at
  06:09-06:13 on 2026-07-19, before the repaired release was activated at
  06:36. They are therefore baseline evidence, not post-fix acceptance. A
  post-deployment Zulip read found no new boss ID `8` messages, and the live
  SQLite database still contains exactly seven objectives. Do not send as the
  local Jarvis bot (ID `9`) or widen the allowlist to manufacture acceptance;
  the same matrix must be resent by boss after deployment.

- The 08:02-08:04 boss matrix was also pre-deployment: it was handled by
  release `aff45e13f157` before repaired release `4cedb2c0be61` activated at
  08:27. Installer gate `32/32`, live attestation, and HCO/App Server health
  are complete; remaining work is fresh ID `8` post-deployment acceptance.

- Authorized post-deployment traffic arrived at 08:34-08:36. General
  `423 -> 424` stayed on `hermes-general`; ASK `425/429/435 -> 426/430/436`
  and stockprofits `427/431/433 -> 428/432/434` returned their correct, isolated
  cwd values without creating HCO work. The project replies omitted the
  requested marker text, so marker rendering remains an explicit follow-up
  decision rather than being silently treated as passed.
# Proven-missing App Server thread recovery addendum (2026-07-19)

- [x] Reconfirm the controller/backend/RPC/store failure boundary.
- [x] Capture the installed Codex version's exact missing-thread response.
- [x] RED: lock remote error preservation, exact classification, and uncertain
  error counterexamples.
- [x] GREEN: add atomic replacement binding and one-shot controller recovery.
- [x] RED/GREEN: expose an authenticated `/codex thread bind <objectiveId> <threadId>` production path with project ownership, maintainer/admin ACLs, source-message idempotency, and `HERMES_ONLY` availability.
- [x] RED/GREEN: let an idempotent binding replay resume only a durably proven pre-send `intent`; never resend after acknowledgement or an uncertain external attempt.
- [x] Update the ADR, adaptive-dispatch specification, and support guide with the operator command and crash-state invariant.
- [x] Complete mandatory ADR-aware dual review and adjudicate every finding.
- [x] Run focused and complete release gates.
- [x] Strict dry-run, transactional deployment, and runtime attestation.
- [ ] Fresh authorized boss-ID-8 Zulip acceptance on General, ASK, stockprofits,
  and the ASK legacy topic used by message `445`, including durable-state and
  no-duplicate-turn evidence.
