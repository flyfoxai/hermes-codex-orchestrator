# Option C Completion Plan

## Goal

Finish the hardened Option C bridge without modifying Hermes core, install it
into the local Jarvis instance, verify real Zulip routing, then commit and push
`codex/option-c-app-server`.

## Phases

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
- [in_progress] Commit and push the verified release.

## Constraints

- Do not modify Hermes core source.
- Preserve unrelated user changes.
- Never expose Zulip credentials or other secrets in logs or documentation.
- Production changes require a failing regression test first.

## Errors Encountered

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
