# Progress

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
