# Progress

## 2026-07-18 final Jarvis production acceptance

- Recovered the post-compaction state and continued the already accepted
  stream-5 smoke instead of creating a duplicate objective.
- Confirmed HCO PID `72242`, its Codex App Server children, Gateway PID
  `72469`, and delivery PID `72577` remained alive during verification.
- Queried the production database with a bounded busy timeout. Objective
  `objective-34196845-262f-4757-b3a7-4d767aff1ec6`, its App Server execution,
  and its turn submission are all completed with no reconciliation required.
- Verified the stored output reports only
  `/Users/hula/Projects/stockprofits` and the unique smoke marker. The outbox
  delivered it once and recorded Zulip message ID `345`.
- Read message `345` independently through the Zulip client. It is in
  `量化交易stockProfits` / `框架安装`, is authored by Jarvis PM, and contains
  the same stockprofits cwd and marker.
- Compared HCO's open SQLite descriptors with the live database, WAL, and SHM
  paths. Their inodes match, so the writer and fresh readers share the same
  sidecar files after the repaired installation.
- Production acceptance is complete. Remaining work is fresh release gates,
  final Claude/Gemini read-only review, adjudication, commit, and push.
- Completed fresh release gates sequentially after production acceptance:
  installer transactions `30/30`, Node tests `237/237`, Jarvis-runtime Hermes
  plugin contracts `210/210`, and every `npm run verify` stage passed. Shell
  syntax and `git diff --check` also exited cleanly.

## 2026-07-18 - SQLite process-exit timeout continuation

- Restored the prior session and confirmed the active installer suite failed in
  scenario 1 rather than at the new scenario 30 boundary.
- Traced that failure to the test fixture: global environment forwarding
  supplied an empty SQLite stop delay, and the fake HCO crashed while parsing
  it as a float. Updated only the fixture's default parsing; production code is
  unchanged pending a clean RED for the actual timeout behavior.
- Re-ran the complete installer suite. Scenarios 1 through 29 passed, then
  scenario 30 produced the intended RED because the installation succeeded
  after the old HCO exceeded the requested exit deadline.
- Added transaction-level PID retention and a validated test-only timeout
  override. Rollback now checks every retained service PID before restoring
  migrations or snapshots, even when launchd already reports the service as
  unloaded.
- Re-ran all 30 installer transaction scenarios after the production change.
  Both SQLite lifecycle cases passed: replacement waits for descriptor ownership
  to drain, and an exit timeout fails closed before snapshot restoration.
- The inherited `npm test` gate is not defined in `package.json`; npm failed
  before executing tests. Confirmed the repository documents `npm run verify`.
  Shell syntax and `git diff --check` both passed while selecting the actual
  Node gate commands.
- The first `node --test test/*.test.js` run passed 236/237. The only failure
  was an unhandled-rejection race in the 10 ms committed-backpressure timeout
  test; it passed in isolation and reported `PromiseRejectionHandledWarning`
  in the full run. Attached `assert.rejects` immediately after creating the
  request, before yielding to inspect the committed frame.
- Re-ran the remaining release gates after the SQLite lifecycle fix. Jarvis'
  runtime Python passed all 210 Hermes plugin contract tests; `npm run verify`
  passed its syntax, smoke, contract, dispatch, dispatch-success, and hardening
  stages; `bash -n scripts/install-hermes-codex-bridge.sh` and
  `git diff --check` both exited cleanly.
- Completed the requested Claude and Gemini review pass. Claude inspected the
  complete tracked diff and reported two candidate findings; source-level
  control-flow review rejected both because successful initialization resets
  reconnect backoff and rollback drains retained PIDs before migration or
  snapshot restoration. Gemini's repository-tool review was incompatible with
  its current CLI tool registry, so a tool-free focused review was used. Its
  candidate replacement-PID gap was also rejected: rollback captures the
  currently running replacement HCO/delivery PIDs before bootout and drains
  them before restoration. A requested Gemini recheck then encountered a local
  proxy fetch failure; no unadjudicated source finding remains.

## 2026-07-17 final boundary audit

- Restored 14 unsynced messages from the prior Codex context. They showed that
  the full-handshake backpressure regression had already been added and failed
  before the context transition, so no duplicate RED test was created.
- Re-ran focused renderer coverage. Unknown future action passed, while three
  unknown status variants failed because their private values were reflected in
  user-visible text; this is the RED evidence for the status allowlist fix.
- Added a client-level RED test for an unresponsive initialize handshake. It
  exceeded the 100 ms test deadline because the constructor ignored the proposed
  10 ms initialization timeout, confirming the lifecycle gap.
- Implemented action-specific bridge status validation and an initialization
  timeout option with the existing 30-second behavior retained as the default.
- Extended the same initialization deadline across both handshake phases. A
  valid initialize response followed by a permanently non-draining
  `initialized` notification now fails closed and closes the client instead of
  blocking HCO startup or shutdown indefinitely.
- Fresh focused lifecycle verification passed 4/4 cases: shared initialization,
  silent-server timeout, post-response notification backpressure timeout, and
  failed-initialize non-retry behavior.

## 2026-07-17 - Real App Server completion investigation

- Restored the post-install context with the planning catch-up helper and
  preserved all uncommitted remediation changes.
- Queried the live HCO database using its real schema. Confirmed correct
  `stockprofits` routing, a bound App Server thread and turn, and absence of all
  App Server audit/output/delivery records before recovery changed the submission
  to `reconciliation_needed`.
- No production code has been changed for this incident. Root-cause tracing now
  continues through runtime notification ownership and lost-turn recovery.
- Confirmed the App Server process did not reconnect during the turn. Queried
  the persisted thread through a fresh initialized App Server client and found
  the exact mismatch: current `agentMessage` items omit `status`, while HCO
  requires it. The persisted final answer contains both the canonical
  stockprofits cwd and `HCO_APP_SERVER_SMOKE_OK`.
- The current Codex manual fetch failed with HTTP 403; protocol validation will
  use the installed App Server's generated schema plus the observed live
  payload.
- Generated the installed Codex `0.142.3` JSON schema. Its
  `AgentMessageThreadItem` requires only `id`, `text`, and `type`, permits an
  optional phase, and defines no item status field.
- Added a RED regression with the exact current payload shape and observed the
  expected `null` output. Changed the reducer to accept an omitted item status
  while still rejecting any explicit non-completed status. The focused RED test
  and all 42 turn-controller tests then passed.
- Updated the Option C end-to-end completion fixture to use the current App
  Server schema so future integration coverage cannot silently regress to the
  obsolete test-only status field.
- Added explicit negative coverage for every defined non-completed status raised
  by Claude's review; the focused controller/E2E run passed 50/50. Gemini found
  no actionable issue in the compatibility change.
- Transactionally installed the repaired release into Jarvis. The installer
  passed its launchd-equivalent App Server canary, authenticated live readiness
  gate, Gateway attestation gate, and delivery readiness gate before commit.
- Verified the running checkpoint: HCO PID `37337`, App Server PIDs `37340` and
  `37341`, Gateway PID `37484`, and delivery PID `37603`. Authenticated health
  reported App Server available, and the stable plugin plus Gateway attestation
  resolved to `hermes-codex-bridge-1.0.0-58bb1ceea2a8`.
- Observed automatic route-snapshot renewal advance generation 2 to 3 while the
  only project routes remained `4 -> ASK` and `5 -> stockprofits` with a
  60-second validity interval.
- Submitted fresh read-only objective
  `objective-a8b267af-2181-44cc-a4da-14b71e148d13`; HCO accepted it for
  `stockprofits` and created new App Server thread
  `019f7053-b556-7212-8289-36820d31eca5` and turn
  `019f7053-d81a-7d80-a767-1cc03723f9c8`.
- Confirmed the task completed without reconciliation, persisted output
  `cwd=/Users/hula/Projects/stockprofits` and
  `HCO_APP_SERVER_SMOKE_OK`, and produced an outbox delivery acknowledged once
  as Zulip message `343`.
- Queried Zulip independently and confirmed message `343` landed in
  `量化交易stockProfits / 框架安装` with the exact stockprofits cwd and success
  marker. This is the first fresh end-to-end proof that the repaired completion
  payload reaches the user rather than being discarded.
- Logged non-production diagnostic errors from the smoke investigation: direct
  standalone plugin import, stale SQLite column names, unavailable Zulip client
  method, root-only `launchctl procinfo`, and one undefined local JavaScript
  variable. Each was corrected with a read-only alternative and none created a
  task or changed production state.

## 2026-07-17

- Resumed hardened Option C from the independent Codex review gate.
- Confirmed the remaining Medium finding: `ingress_config()` constructs a fixed Zulip mapping and discards root/existing ingress adapter YAML.
- Added the RED regression scenario before changing production code.
- Corrected the regression fixture's invalid scalar `home_channel` to Hermes'
  supported mapping shape.
- Re-ran the installer suite and observed the intended RED failure at the
  `zulip-ingress` adapter mapping assertion: generated YAML still contained
  only `enabled: true`.
- Implemented a Zulip-only recursive mapping merge with precedence
  `root < existing ingress < installer enabled=true`.
- Re-ran `bash test/install-hermes-codex-bridge.test.sh`: all 28 scenarios
  passed, including fresh migration and reinstall nested override behavior.
- Collected Claude CLI review session
  `9352ccc0-17bc-4a99-869a-bea36dc77d03` and adjudicated all five reported
  findings against source and tests.
- Added explicit invalid-snapshot cases for out-of-order and duplicate Zulip
  stream IDs.
- The first focused pytest command used the system Python and failed collection
  with `ModuleNotFoundError: hermes_cli`; the repository's required interpreter
  is `/Users/hula/Projects/hermesAgent/.venv/bin/python3`.
- Added a RED first-install fixture for conflicting root and existing ingress
  dotenv values, then fixed precedence to `root < existing ingress <
  installer-owned overrides`.
- Re-ran the complete installer suite: 28/28 passed.
- Gemini final review session `3a0c0b52-6097-4ac7-b894-574fd7959f06` reported
  no actionable findings after that fix.
- Claude final review session `d5bc6c5c-78bf-4e09-b124-81e985d3ab42` reported
  five possible findings; source and test adjudication found no additional
  production defect and added direct stream-ordering regression coverage.
- Started the first real Jarvis installation from Gateway PID `19571`.
- Installer passed bridge, Codex App Server, staged Hermes, activated Hermes,
  and installed Hermes compatibility probes, then failed and attempted
  rollback.
- Rollback verification reported route snapshot content mismatch and exited 1.
  Post-failure checks found Gateway running at PID `78031`, HCO and Delivery
  running, the old plugin link restored, and the ingress profile absent.
- The route snapshot timestamps changed during rollback, identifying a race
  between static rollback verification and the legitimate HCO renewal writer.
- Restored the interrupted session and added a root completion plan covering
  rollback repair, ingress diagnosis, dual-model review, live deployment, and
  git publication.
- Traced Hermes' canonical Zulip variables and ruled out the suspected
  `ZULIP_SITE_URL` versus `ZULIP_URL` mismatch.
- Added a failing rollback regression in which the restored HCO legitimately
  republishes its route snapshot during startup; the original activation error
  was previously masked by byte-for-byte runtime-artifact verification.
- Changed rollback verification to prove static state before service restart,
  then validate HCO-owned DB/socket/route artifacts through restored service
  readiness. The installer suite passed all 28 scenarios after this change.
- Traced the remaining live activation failure through Hermes multiplexer
  internals: profile dotenv values enter `agent.secret_scope`, while the current
  Zulip adapter reads `os.environ`; `_without_secondary_profile_platform_env`
  deliberately removes the global fallback before the adapter is constructed.
- Added a RED installer regression that loads the installed plugin and then
  reproduces Hermes' real `_without_secondary_profile_platform_env()` plus
  `_profile_runtime_scope()` startup sequence with conflicting global values.
- Implemented an idempotent plugin-side Zulip compatibility wrapper around the
  requirement check and adapter constructor. It uses `get_secret()`, preserves
  YAML precedence, covers all constructor-time `ZULIP_*` settings, and never
  mutates the process environment or Hermes core.
- Replaced the installer's false-positive ingress dotenv probe with the same
  real multiplexer contexts, requirement check, adapter construction, and
  global-environment isolation assertions.
- The focused plugin contract suite passed all 198 tests. The installer suite
  passed all 28 scenarios after the compatibility wrapper and was rerun after
  the probe correction.
- The first fresh final-review attempts did not produce review findings:
  Claude terminated while requesting an unavailable tool and Gemini hit a
  local proxy fetch failure. Both processes were stopped rather than treated as
  successful reviews.
- Restarted both reviews with the tracked implementation/test diff supplied
  directly on stdin and tool use disabled, so the result cannot depend on a
  CLI-specific shell tool name.
- Gemini review session `ba2713c1-01c2-4bf7-9178-134cb29cdbe7` reported three
  possible issues. Source and contract review accepted one: explicit Zulip YAML
  behavior settings were being overwritten by scoped dotenv values. The dotenv
  single-quote claim was rejected after a real `python-dotenv` round trip, and
  the `defaultOwner=PROJECT` branch was rejected because schema v1 only accepts
  `defaultOwner=HERMES`.
- The Claude review process returned success metadata but an empty `result`;
  resuming session `4cc89360-2f8d-4af4-b5c7-d75e97fbba53` then reported that
  the conversation did not exist. This attempt is recorded as a failed review,
  not an approval.
- Added a RED installer fixture with explicit YAML values conflicting with the
  ingress dotenv for certificate, insecure transport, mention gating, free
  streams, catch-up, and context depth.
- Changed the plugin compatibility adapter so explicit YAML key presence wins,
  including explicit `false` and empty values, while absent keys continue to
  resolve through the active profile's secret scope.
- Changed ingress YAML generation to validate `platforms.zulip.extra` and force
  `context_depth: 0`, independent of a migrated root value.
- The first GREEN rerun exposed two stale reinstall expectations. Updated them
  to the documented precedence `root < existing ingress < installer-owned
  overrides` and the recursive YAML merge contract.
- Re-ran the focused Hermes plugin contract suite with the Hermes virtualenv:
  198 tests passed.
- Completed fresh final reviews with the complete tracked diff supplied on
  stdin. Gemini session `f1e50bb3-e61a-4c7b-8562-6eb888a79f6c` and a non-empty
  Claude final answer both reported `NO_ACTIONABLE_FINDINGS`.
- Rejected Claude's residual `defaultOwner` concern because the snapshot reader
  explicitly requires `HERMES`; accepted the remaining upgrade, bounded
  timeout, and queue-latency points as fail-closed residual risks.
- The next live install failed closed at Gateway runtime attestation and rolled
  back successfully. Runtime logs proved `ask-jarvis-pm` claimed the same Zulip
  credential before `zulip-ingress`, causing Hermes to refuse the ingress
  profile as a duplicate poller.
- Added a dedicated remediation phase: first reproduce successful migration and
  byte-exact rollback for same-credential external profiles, then implement the
  smallest transactional installer change.
- Added a real `ask-jarvis-pm` fixture sharing the ingress Zulip credential and
  observed the expected RED failure before changing the installer.
- Implemented owner-controlled external-profile discovery and transactional
  disabling of only `platforms.zulip.enabled` when the effective API key matches
  ingress. Profile dotenv files and unrelated YAML fields remain unchanged.
- Added fault-injection coverage proving an external profile config is restored
  byte-for-byte and its `.env` hash is unchanged after rollback.
- Re-ran the installer suite: all 28 scenarios passed.
- Completed fresh full contract runs: Node 223/223 and Hermes plugin 198/198
  passed. The repository verify run also passed smoke, contract, dispatch, and
  hardening stages in the captured output; a final fresh verification remains
  required after live installation and review adjudication.
- Resumed the final post-remediation adjudication and traced Hermes'
  `agent.secret_scope.get_secret()` contract: an installed profile scope is
  authoritative and absent keys do not fall through to root `os.environ`.
- The first isolated residual-finding probe did not start because its outer
  JavaScript command template interpreted a literal dotenv reference. The
  escaped retry reached Python but failed on the plugin's relative import; no
  repository or Hermes files were changed by either attempt. The next probe
  will reuse the package-aware loader already exercised by the test suite.
- A third diagnostic attempt used a temporary Hermes home and `PluginManager`,
  but did not install the wrapper because the synthetic plugin installation was
  incomplete. Per the three-strike protocol, stopped that emulation path. The
  remaining decision depends directly on Hermes' authoritative profile-secret
  scope and literal YAML parsing, both of which can be tested without fabricating
  a Gateway installation.
- Ran a successful minimal probe with Hermes' real secondary-profile contexts.
  It proved an absent profile-local `ZULIP_API_KEY` returns the empty default,
  root `ZULIP_*` variables are hidden, and a YAML `${ZULIP_API_KEY}` token stays
  literal. Adjudicated both residual review claims as non-defects; no production
  change is warranted.
- Collected Gemini post-remediation review session
  `18ff4740-2a4e-465a-abd8-22589a590f85`. Its two reported compatibility
  concerns were tested against the installed Hermes classes: supported
  `PlatformConfig` instances always expose `token`, `api_key`, and mapping
  `extra`; `extra: null` and objects missing those fields are already rejected
  by Hermes' loader/native Zulip path. Recorded both as non-actionable.
- The resumed Claude session `b977b24d-b802-4f74-906c-46c2e568b173` again
  exited successfully with an empty `result`, so it was not counted as an
  approval. Started a smaller fresh Claude review focused on the duplicate
  poller remediation and Gemini's two compatibility claims.
- Verified pure-stdin, tools-disabled Claude invocation, then completed review
  session `77ac249d-62c5-4f38-9a95-f9458e87e444`. Its single finding assumed
  native construction creates a Zulip client before scoped-field overrides.
  Installed source proves `_client` remains `None` until later `connect()` or
  send operations, so Codex rejected the finding without changing production
  code.
- Fresh regression evidence: installer suite reached `1..28` with every
  scenario successful; Hermes plugin contract suite passed 198/198. Node's
  complete suite remained in progress at this checkpoint.
- The bare `node --test` command auto-discovered
  `test/fixtures/fake-app-server.js`, a deliberately persistent fixture, and
  waited after all real tests completed. Process inspection identified that
  exact child; the run was stopped and not counted as a test result.
- Re-ran the intended Node test set explicitly with
  `node --test test/*.test.js`: 223/223 passed with zero failures or
  cancellations.
- Completed the repository verification command `npm run verify` after the
  focused suites; syntax, smoke, contract, dispatch failure/success, and all
  hardening phases completed with exit code 0.
- Installed the hardened bridge transactionally into the Jarvis Hermes home.
  Staged and activated bridge, Codex App Server, Hermes, project-route rewrite,
  and effective multiplexer probes all passed before the installer committed
  release `hermes-codex-bridge-1.0.0-7d9368baa347`.
- Verified the live Gateway restarted from PID `94048` to PID `17655`; HCO is
  running at PID `17315` and delivery is running at PID `18003`. Gateway runtime
  state reports both Zulip and Feishu connected and includes `zulip-ingress` in
  `served_profiles`.
- Verified live attestation is owner-only, names Gateway PID `17655`, resolves
  to the content-addressed installed release, and records the expected
  `pre_gateway_dispatch` hook and `zulip-ingress` profile.
- Verified the external `ask-jarvis-pm` profile retains its model and unrelated
  YAML settings while only Zulip is disabled. Its `.env` SHA-256 remains
  `c11ec349d69fe72b1b2bca527867f5cd95833cd640577a6caf5dc5a8b2007225`.
  The ingress profile has no cwd or model and fixes Zulip context depth at zero.
- Observed live route snapshot renewal continue without manual writes:
  `generatedAtMs` advanced from `1784275410137` to `1784275602647` while the
  document remained integrity-protected with a 60-second validity interval.
- Loaded the exact installed release through a temporary Hermes home so the
  live attestation could not be overwritten. A real Zulip-shaped natural
  language event for stream `5`, topic `框架安装`, sender `8` rewrote to
  `codex-bridge`; its signed capability payload contained project
  `stockprofits`, stream `5`, and no `ASK` value.
- Loaded the real HCO registry with the production config and confirmed stream
  `5` maps only to canonical cwd `/Users/hula/Projects/stockprofits`; ASK remains
  isolated at `/Users/hula/workspace/ASK`.
- Re-ran every final release gate after the live installation and review
  adjudication: installer `28/28`, Hermes plugin contracts `198/198`, Node
  tests `223/223`, and `npm run verify` all completed with exit code zero.
- Reconfirmed the business-routing invariant with the operator: ASK and
  stockprofits are separate projects. Stream `4` owns only project `ASK` at
  `/Users/hula/workspace/ASK`; stream `5` owns only project `stockprofits` at
  `/Users/hula/Projects/stockprofits`. No cwd, session, objective, or task state
  may cross that boundary; ambiguous business ownership requires explicit
  operator confirmation.
- Independent Codex closure review returned `NO_FINDINGS` after fresh focused
  service `40/40`, plugin `198/198`, and diff-format verification. The main
  release gate independently covered the reviewer's remaining installer gap
  with the fresh `28/28` run.
- Rechecked the live installation immediately before publication: Gateway PID
  `17655`, HCO PID `17315`, and delivery PID `18003` remained running; Zulip and
  Feishu remained connected; the renewed snapshot at `1784276468911` still
  contained only `4 -> ASK` and `5 -> stockprofits` project routes.
- Committed the verified implementation as `5860529` (`Harden Option C routing
  containment`) and pushed it to `origin/codex/option-c-app-server`.
- Began the live App Server availability remediation after reproducing the
  `stockprofits` Zulip failure against objective
  `objective-24cf35e8-0452-440f-99dc-38612b0c63ec`.
- Confirmed the route is correct and isolated from ASK; the immediate startup
  failure is launchd PATH resolution of the Node-based Codex wrapper.
- Adopted the already approved full Option C repair: deterministic service
  environment, launchd-equivalent canary, live health gate, bounded reconnect,
  human-readable failure rendering, and trusted route/status queries.
- Resumed after context compaction and independently reproduced the remaining
  installer RED: fresh activation passed bridge, App Server canary, route, and
  Hermes gates, then failed the new HCO health gate because its fake server
  returned only a compatibility document. Rollback subsequently reported a
  service-settle failure.
- Updated only the fresh-HCO fixture to distinguish `/v1/health` from the
  compatibility endpoint. Legacy-HCO and lock-gate fixtures remain unchanged so
  upgrade and rollback compatibility coverage stays meaningful.
- The next GREEN attempt reached the installed-plist assertions and stopped on
  a test-only `NameError`: the new PATH assertion referenced `expected_node`
  without passing it into the Python fixture. Added `$FAKE_NODE` as an explicit
  fixture argument and now assert both the HCO executable and PATH from it.
- Line-level inspection showed `$FAKE_NODE` is only the fake launchctl's service
  shim; the installer itself receives `--node-bin "$(command -v node)"`. Corrected
  the fixture argument to that real installer input while retaining exact
  executable and PATH assertions.
- The following run exposed a second test-contract mistake: `HERMES_HOME` is
  isolated fixture state, whereas launchd `HOME` must be the actual service
  user's home. The generated plist correctly used the process HOME and the
  node parent in PATH; changed the assertion to match that intended contract.
- The installer then passed all earlier transaction scenarios and failed only
  the first-install temporary-HCO handoff. Root cause: the fake node depended on
  two `HCO_TEST_*` variables that are intentionally absent from the new
  launchd-equivalent environment. Embedded the fake server and lifecycle-log
  paths as fixture arguments so the executable no longer relies on ambient
  test-only environment variables.
- Re-ran the complete installer suite after fixture corrections: all 28
  scenarios passed, including rollback renewal, legacy compatibility, failure
  injection, lock serialization, and temporary-HCO handoff.
- Added a shutdown-versus-retry-initialize regression and observed the intended
  RED result: close counts were `[1, 2]` instead of `[1, 1]`. Implemented a
  candidate-owned idempotent close helper shared by terminal, connect-failure,
  and runtime shutdown paths.
- Ran the four newly added runtime edge-case scenarios. The first run exposed a
  test-only queue-consumption mistake: the backoff test shifted the same retry
  record twice before invoking it. Corrected the fixture without changing
  production behavior.
- Re-ran `node --test test/hco-runtime.test.js`: all 20 runtime tests passed,
  including bounded backoff/reset, shutdown cancellation, stale terminal
  isolation, synchronous backend-construction recovery, and single-owner close.
- Resumed the App Server remediation after context compaction and recovered the
  pending review/install plan from the on-disk planning files.
- Gemini completed the full uncommitted-diff review as session
  `7f0f753e-dedc-4cb7-a9e1-bad90f9acee5` and returned
  `NO_ACTIONABLE_FINDINGS` without tool writes.
- Claude's first full-diff process exited successfully but returned an empty
  result, so it was not counted as an approval. Started a smaller read-only
  review with a mandatory structured-output schema.
- Collected fresh pre-install regression evidence: Node `233/233`, Hermes
  plugin contracts `200/200`, and installer transactions `28/28` all passed
  with zero failures. The installer warning is an existing third-party
  `pkg_resources` deprecation notice, not a test failure.
- Captured the live pre-install baseline: launchd still supplied only
  `/usr/bin:/bin:/usr/sbin:/sbin`; HCO PID `17315` was alive but owned no
  `codex app-server --stdio` child. This reproduces the reported degraded state
  without any ASK/stockprofits routing ambiguity.
- Adjudicated Claude's structured review. Both findings are already blocked by
  stronger invariants: stale removed-project overrides fail resolver
  construction with `ROUTE_CONFIG_INVALID`, and missing/mismatched HOME fails
  the installer entry check before plist generation. No production change was
  justified; the approved remediation diff remains unchanged.
- The first fresh plugin-contract command used system `python3` and stopped
  before tests with `ModuleNotFoundError: hermes_cli`. This interpreter is not
  the Jarvis runtime and the result is not counted; verification will use the
  installed Hermes venv Python.
- Fresh verification now has Node `233/233` and Hermes plugin contracts
  `200/200` passing. The latter used the exact Python environment referenced by
  the live delivery LaunchAgent.
- Fresh installer transaction verification passed `28/28`, including the new
  App Server health gate, prior-version rollback, route-snapshot renewal races,
  service-state restoration, and first-install temporary HCO handoff.
- Restored the post-compaction session with the planning catch-up helper and
  reconfirmed the live pre-install baseline: HCO PID `17315` still has no child
  App Server and its LaunchAgent still exposes only launchd's default PATH.
- The first installer help probe invoked the non-executable script directly and
  returned `permission denied`; all production invocations must use `bash
  scripts/install-hermes-codex-bridge.sh`, matching the test and documented
  shell-script contract.
- The setup document's illustrative secret names (`bridge.bearer` and
  `context.key`) do not match this installation. The authoritative HCO config
  references owner-only `hco.bearer` and `hco-context.key`; deployment will use
  the config paths and will not print their contents.
- Ran the real transaction with the approved context-depth containment flag.
  Bridge protocol, launchd-equivalent Codex App Server compatibility, staged
  and activated route/Hermes probes, installed Hermes compatibility, and the
  new live App Server readiness gate all passed.
- The transaction then exited with code 1 at the Gateway activation evidence
  gate: the runtime attestation did not match the newly activated release.
  Started a boundary-by-boundary rollback and attestation investigation before
  any retry.
- Read Hermes' complete user-plugin discovery path. Confirmed it scans the
  stable symlink plus every historical immutable release, then deduplicates by
  the shared manifest key with the last sorted directory winning.
- Ran a read-only live discovery probe: all three HCO paths were candidates and
  the selected winner was a historical version directory. This establishes the
  remaining activation failure's root cause without another production retry.
- Started a TDD migration phase: first require exactly one discoverable HCO
  manifest with immutable releases stored outside `plugins/`, then add legacy
  upgrade and transaction rollback coverage before implementation.
- Reproduced the migration rollback RED with the preserved fixture. The stable
  link returned to the old release name, but both old release directories
  remained in `plugin-releases/` because the migration ledger had been cleared
  before Gateway attestation.
- Moved migration commit/cleanup to the final transaction boundary after HCO
  App Server readiness, Gateway attestation/stability, and delivery readiness.
- Fresh verification after the fix: installer transactions `28/28`, Node tests
  `233/233`, Hermes plugin contracts `200/200`, shell syntax, and diff whitespace
  checks all passed.
- Gemini's focused migration review identified a reachable mismatch between
  cache exclusion in release manifest generation and strict destination
  validation. Read-only inspection confirmed both live historical release
  directories contain normal Python runtime caches, so a real retry would have
  failed before migration despite the synthetic suite passing.
- Added the cache-bearing legacy migration regression first and observed the
  expected RED failure: `plugin release integrity check rejected directory
  mode` for a normal `0755` `__pycache__` directory.
- Implemented one consistent policy: runtime caches stay outside semantic
  content hashes but every ignored path is still ownership/type/mode checked;
  cache symlinks, special paths, and cross-user writable paths remain rejected.
  File hashing now uses bounded streaming reads.
- Re-ran the installer transaction suite after the cache fix. All `28/28`
  scenarios passed, including cache preservation during migration, cache
  symlink rejection before service mutation, and byte-preserving rollback.
- The first focused Claude and Gemini review attempts returned empty responses
  and were explicitly rejected as evidence. Smaller non-mutating reviews then
  both raised the same empty-directory digest concern.
- Supplied the reviewers with every destination reuse and migration branch.
  Claude session `f6866761-6c32-42ca-a30e-1181e333bdd2` and Gemini session
  `0bebe861-d9d8-489b-a77e-ef688fd72400` both concluded `NON_ACTIONABLE` because
  full directory manifests are validated before any same-name destination is
  reused. No compatibility-breaking digest change was made.
- Completed the retried live transactional install with exit code zero. Bridge
  compatibility, launchd-equivalent App Server compatibility, staged and
  activated Hermes probes, and live Codex App Server readiness all passed;
  plugin version `1.0.0` was committed. Runtime process, attestation, renewal,
  route isolation, and real `stockprofits` delivery remain to be verified
  before publication.
- Verified the committed runtime: LaunchAgent PID `76494` owns the Codex App
  Server stdio child, authenticated `/v1/health` reports App Server available,
  Gateway PID `76801` serves `zulip-ingress` with Zulip connected, and delivery
  PID `76903` runs from the same immutable release selected by the stable link
  and Gateway attestation.
- Reconfirmed the live registry is isolated: stream `4` maps only to `ASK` at
  `/Users/hula/workspace/ASK`; stream `5` maps only to `stockprofits` at
  `/Users/hula/Projects/stockprofits`; both use the App Server backend.
- Observed route snapshot renewal from `1784293933299` to `1784293981402` with
  the exact two-route document, 60-second validity interval, SHA-256 integrity,
  and owner-only mode.
- Queried the real stream-5 topic without mutation. Incident reply `342`
  confirms the bridge had selected `stockprofits`; only backend availability
  failed. Prepared a bounded, read-only `OBJECTIVE_NEW` smoke request so the
  verification cannot reuse the prior failed objective or alter project files.
- A diagnostic topic-mode query used the wrong table shape and failed before
  reading rows. Schema inspection confirmed `topic_modes` joins to
  `topic_aliases` by `alias_id`; the production database was not mutated.
- First live smoke harness stopped at `ModuleNotFoundError` because it used a
  nonexistent import package name. No bridge request was sent and no live
  objective was created; the retry will use the installed module layout.
- Recovered the real completed turn through `thread/read` and confirmed the
  completion-loss root cause: Codex App Server `0.142.3` omits `status` from
  `agentMessage` items, while HCO required `status === "completed"`.
- Added the current-protocol RED regression before changing production logic;
  it failed because output reduction returned `null`. Updated the filter to
  accept an omitted status or explicit `completed`, while rejecting every
  explicit alternative. Focused recovery/service/E2E verification passed
  137/137 after the production fix.
- Ran fresh Gemini and Claude incident reviews. Gemini reported no actionable
  finding. Claude's low-severity negative-coverage finding was valid, so added
  explicit rejection coverage for `null`, `inProgress`, `failed`, and
  `cancelled` item statuses. The focused controller/E2E run passed 50/50.
- Re-ran both external reviews after adding the complete user-facing result
  renderer. Claude returned `NO_ACTIONABLE_FINDINGS`. Gemini session
  `eb516ed2-9f6e-4b43-9811-ad64fd37a78a` raised five possible issues; source,
  protocol, and server-response checks rejected four as contract
  misunderstandings and accepted one privacy/compatibility defect.
- Added a RED contract case proving that an unknown future schema-v1 action
  caused arbitrary response fields, including a token-shaped value, to be
  reflected to Zulip. Replaced that reflection with a fixed compatibility
  notice that exposes neither the unknown action nor any unrecognized field.
  The focused renderer suite passed 8/8.
- Ran the complete pre-deployment gates after the renderer fix: Node 235/235,
  Hermes plugin contracts 206/206, installer transactions 28/28, and
  `npm run verify` all passed. A single Node test initially raced only while
  Node and pytest were run concurrently: its 10 ms rejection could occur
  before `assert.rejects` was attached after a `setImmediate`. The same test
  and the complete Node suite passed in isolation; no unrelated production or
  test timing change was made.
- The first initialize-pending adjudication was incomplete: the production RPC
  request owns a 30-second timeout, but that deadline ends before the following
  `initialized` notification. Independent review reproduced a valid initialize
  response followed by permanently non-draining stdin, which left the complete
  handshake and initial shutdown pending.
- Added RED renderer cases for unknown statuses on dispatch, cancellation,
  interaction answer, and nested objective execution status. All four failed
  by reflecting the injected private marker before the production change.
- Added action-specific status allowlists and one fixed fail-closed
  compatibility response. The focused renderer run passed 11/11 and the full
  Hermes plugin contract suite passed 210/210.
- Added a RED App Server regression for post-response notification backpressure;
  before the fix it exceeded the 100 ms test deadline. Applied one deadline to
  the complete initialize handshake so timeout closes the transport and releases
  the pending send. The focused initialize/backpressure run passed 5/5.
- Added an installer contract proving App Server activation uses a distinct
  40-second readiness window instead of the normal 8-second bridge window.
- Added a partial release-migration rollback fault injection. The repaired
  transaction restores and verifies every independent snapshot, stops all
  affected services on incomplete evidence, and retains the original failure
  without secrets.
- Corrected two cache fixtures to valid semantic versions, exposing and fixing
  acceptance of nested directories under `__pycache__` while preserving normal
  owner-controlled `.pyc` support.
- Re-ran the installer transaction suite after the final rollback changes; all
  `28/28` scenarios passed.

## 2026-07-18 SQLite sidecar persistence incident

- Submitted a current-release, stream-5 `stockprofits` smoke through the real
  installed plugin without starting another Zulip poller. The plugin reported
  objective `objective-56b35d0c-ac86-45cd-9a9b-6ba48a24f856` accepted.
- Confirmed the accepted objective and replay nonce are absent to a fresh
  SQLite reader. HCO PID `69585` has the main database open at the expected
  inode but holds WAL/SHM inodes whose pathnames had been removed.
- Rechecked after pathname recreation: HCO descriptors still point to WAL/SHM
  inodes `52666426/52666427`, while the live paths point to
  `52677093/52677094`. This rules out a wrong database path and proves split
  SQLite sidecar state.
- Deferred service restart so the unlinked WAL remains available for forensic
  inspection. Began TDD investigation of installer runtime snapshot lifecycle;
  no production fix has been applied yet.

## 2026-07-18 - Final external-review adjudication

- Completed source-level review of Gemini's two residual candidates after
  Claude returned `NO_ACTIONABLE_FINDINGS`.
- Confirmed successful installation never restores SQLite runtime snapshots.
  Temporary preflight and rollback restoration are both ordered after HCO
  process exit; the retained-PID timeout test proves uncertain ownership fails
  closed before any snapshot restoration.
- Confirmed failed and cancelled App Server turns are durable terminal states,
  not stuck work. Both clear reconciliation and lease state; cancellation emits
  one outbox notification, while failure records `terminal_error` and an audit
  fact without reflecting untrusted backend error text.
- No further production or test change was required for either review item.

## 2026-07-18 - Final pre-commit verification

- Re-ran the installer transaction suite sequentially: all `30/30` scenarios
  passed, including SQLite owner-drain handoff and exit-timeout fail-closed
  restoration.
- Re-ran all Node tests sequentially: `237/237` passed.
- Re-ran the Jarvis Hermes plugin contracts with its actual virtualenv:
  `210/210` passed.
- Re-ran `npm run verify`; syntax, smoke, contract, dispatch failure/success,
  and hardening stages all exited successfully.
- Committed the verified Option C repair as `9325ea8` and pushed
  `codex/option-c-app-server` to `origin`.
