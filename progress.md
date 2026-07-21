# Progress

## 2026-07-21 - Twelfth-pass Markdown safety and interactionId validation closure

- Closed 4 residual issues from the eleventh-pass review:
  - **P1a**: Replaced `escapeMarkdownCodeBlock` with `fencedCodeBlock()` — commands are now written verbatim inside fenced code blocks; fence length auto-extends past the longest backtick run in the command to prevent early fence close.
  - **P1b**: Added `codeSpan()` helper that uses dynamic-length backtick fencing (no backslash-escaping); replaced all `\`${escapeMarkdownInline(v)}\`` code-span usages in `turn-controller.js` (cwd, option.label, question.id, interactionId reply tokens, hardFallbackContent).
  - **P2**: Added `isSafeCliToken(interactionId)` guard at the head of `safeApprovalCommands` and in every command-generating path in `toCompactContent` and `defaultInteractionRenderer`.
  - **P3**: Added `_UNSAFE_QUESTION_ID_CHARS` frozenset in `plugin.py`; `_is_safe_question_id` now rejects `` `"'<>[]{}()|;\/ `` to mirror Node `isSafeCliToken`.
- Verification passed: `npm run check`; Node suite `245/245`; full pytest `295/295`; `git diff --check`.
- Created `docs/superpowers/records/2026-07-21-hco-twelfth-pass-fix-record.md`. No commit or push was performed.

## 2026-07-21 - Eleventh-pass approval safety and compact notification closure

- Codex CLI read-only plan review v2 returned PASS after v1 blockers were folded into the remediation plan.
- Closed the approved safety gaps in HCO and the Hermes bridge plugin: extended approval detection now includes `proposedExecpolicyAmendment`, object approval decisions are command-line restricted to decline/cancel, renderer slash-command tokens are validated before display, Markdown-facing fields are escaped, compact/hard fallback paths are method-aware, `OBJECTIVE_PROJECT_MISMATCH` is user-visible, and short project IDs participate in verb-object containment.
- Replaced old tests that expected object decisions such as `acceptWithExecpolicyAmendment` to be approved from Zulip, and replaced the old `run test` short-project exception with fail-safe project-reference detection.
- Verification passed: `npm run check`; focused Node `node --test test/turn-controller.test.js test/hco-service.test.js test/bridge-server.test.js` at `128/128`; full plugin pytest at `294/294`; full Node suite at `268/268`; `git diff --check`.
- Created `docs/superpowers/records/2026-07-21-hco-eleventh-pass-fix-record.md`. No commit or push was performed.

## 2026-07-19 - Adaptive legacy-topic repair final verification resumed

- Restored the approved repair scope from `task_plan.md`, `findings.md`, and
  the prior session handoff. The implementation remains limited to HCO, the
  Hermes bridge plugin, its transactional installer, tests, and upgrade
  documentation; Hermes core, ACLs, project boundaries, signature checks, and
  uncertain-request replay policy remain unchanged.
- Reconfirmed the direct production root cause for boss message `445`: the old
  prompt exposed a signed capability to the model, the copied token was
  corrupted, and the plugin rejected it before HCO received an intent. Legacy
  topic registration is a separate compatibility path now covered by mapped
  stream lazy creation and durable thread binding.
- Current repository and runtime work are already implemented and deployed.
  This resumed phase will run fresh complete release gates, compare the live
  release to repository source, inspect post-deployment logs/state read-only,
  and retain authorized boss-ID-8 Zulip acceptance as an explicit external
  dependency rather than manufacturing bot-authored evidence.
- No new human decision is required: the user already approved the adaptive
  strategy. Any newly discovered behavioral regression will return to a RED
  test before the smallest production fix; otherwise this phase changes only
  verification records.
- Fresh complete release gates passed in this resumed phase: Node
  `node --test test/*.test.js` passed `248/248`; Jarvis-runtime pytest passed
  `245/245`; the transactional installer harness passed `1..32`; and
  `npm run verify` completed check, smoke, contract, dispatch,
  dispatch-success, and hardening with exit code zero. `bash -n` for the
  installer and `git diff --check` also exited zero.
- The installer harness's two `invalid Hermes home` lines were emitted by its
  intentional fail-closed Provider fixtures; both enclosing TAP cases reported
  `ok`. No production install, service restart, route mutation, or message send
  occurred during these verification commands.
- Fresh runtime comparison confirmed stable release
  `hermes-codex-bridge-1.0.0-53254c3a9d63` and matching repository/installed
  plugin SHA-256
  `556af1e446ad5d6558fa29c7c2be654c6b5db4e382dfde4ca6b9f937772657ec`.
  HCO `35249`, Codex wrapper `35255`, native App Server `35259`, Gateway
  `35335`, and delivery `35459` remain from the 17:06 deployment.
- Authenticated health returned `status=ok` and
  `appServer.available=true`. Production `validateRouteSnapshot()` accepted
  generation `11`, resolved `4 -> ASK` and `5 -> stockprofits`, and retained
  `defaultOwner=HERMES`. All configured security/runtime files are owner-only
  regular files with mode `0600`.
- The first health diagnostic referenced a nonexistent `hco-health-header`
  file, and the first permission diagnostic guessed `context.key` instead of
  reading `bridge.contextKeyPath`. Both commands failed before contacting or
  modifying production state. Retrying from `hco.json` succeeded; these path
  assumptions are now recorded in `findings.md` for future Hermes upgrades.
- Historical bridge-rejection log entries stop at 12:22, before deployment.
  A fresh Zulip API query after the exact 17:06 cutoff returned no boss ID `8`
  or Jarvis ID `9` messages in General, ASK, or stockprofits. SQLite's newest
  objective/turn remains the unrelated 15:00 stockprofits execution, so there
  is still no post-deployment live acceptance traffic to evaluate.

## 2026-07-19 - Operator thread-binding release blocker resumed

- Restored the approved exact command and crash-safety boundary without
  changing Hermes core, General routing, stream authority, or uncertainty
  policy.
- Reconfirmed from the current dirty worktree that proven-missing thread
  replacement exists, while `/codex thread bind <objectiveId> <threadId>` has
  no plugin/service/ACL production path yet.
- Reconfirmed the remaining crash gap: durable binding moves the saved turn to
  pre-send `intent`, but a replay currently cannot resume a process exit before
  `startTurn`, and no durable `submission_unknown` fence is written immediately
  before the external call.
- Next action is RED-only test editing for exact grammar, signed dispatch,
  project/ACL/HERMES_ONLY enforcement, readable output, safe pre-send replay,
  and no replay after the uncertainty fence.

## 2026-07-19 - Proven-missing thread recovery implementation and review

- Preserved App Server RPC code/message/data behind immutable non-enumerable
  diagnostics and classified only the installed `codex-cli 0.142.3` exact
  `-32600` / `thread not loaded: <requested id>` response as proven missing.
- Added the one-shot controller path and atomic SQLite replacement transaction.
  Original text/client ID are preserved; objective plus every related topic are
  rebound together; old/new IDs are audited with `proven_missing_thread`.
- Replacement creation uncertainty is durable and manual-only. Explicit
  binding resumes the stored known-never-submitted turn once; duplicate binding
  source identities do not resubmit; a replacement turn failure cannot recurse.
- Fresh focused verification passed `99/99` across
  `test/app-server-transport.test.js` and `test/turn-controller.test.js`,
  including exact/near-match classification, multiple topic bindings,
  restart/manual recovery, and no-recursive-replacement behavior.
- Updated ADR 0003, the adaptive dispatch design, and the support guide with
  the Codex-version compatibility signature and mandatory upgrade probe. Full
  release gates, deployment, runtime attestation, and authorized Zulip
  acceptance remain pending at this checkpoint.

## 2026-07-19 - Proven-missing thread recovery resumption

- Restored the approved boundary from the prior session: recover only the exact
  App Server `-32600` / `thread not loaded: <requested id>` response, create at
  most one replacement, and leave every uncertain failure manual-only.
- Confirmed the RED tests are present in `test/app-server-transport.test.js`
  and `test/turn-controller.test.js`; no production implementation for this
  recovery has been added yet.
- Preserved all unrelated and earlier adaptive-routing worktree changes. The
  next action is to run both focused files and record their expected failures.
- Focused RED is confirmed. `test/app-server-transport.test.js` failed 2/50
  because `rpcMessage` was absent; `test/turn-controller.test.js` failed 4/48
  at exact missing-thread classification, one-shot replacement, uncertain
  replacement persistence, and the now-async operator-resolution contract.
- The near-miss and transport counterexamples passed, so implementation must
  preserve their current uncertain classification.

## 2026-07-19 - Adaptive repair release-gate resumption

- Recovered the approved adaptive-dispatch implementation and the completed
  installer rollback hardening without changing scope or routing policy.
- Session catchup confirms the latest installer transaction suite completed
  `1..32`; this is recovery context only and will not be reused as final release
  evidence.
- Remaining ordered gates are direct security/behavior review, fresh complete
  Python and Node suites, installer and aggregate verification, strict dry-run,
  transactional deployment, runtime attestation/health checks, and authorized
  Zulip acceptance. No production state has been changed in this resumed turn.

## 2026-07-19 - Adaptive dispatch review and installer hardening

- Recovered the approved adaptive-dispatch implementation without changing the
  routing strategy or Hermes core.
- Verified against current Hermes source that same-session work is serialized,
  one GatewayRunner owns one SessionStore, `pre_tool_call` runs before the async
  handler, and `post_llm_call` runs only after the tool loop for non-interrupted,
  non-empty turns.
- Classified interrupted/empty-turn vault retention as bounded cleanup rather
  than an authorization crossover: entries expire within the signed lifetime
  plus clock-skew allowance and remain subject to strict global, per-sender, and
  byte limits.
- Added installer-contract assertions for the registration command and staged
  semantic-only schema validation. The first focused run failed at the expected
  new assertion before any production change.
- Updated the staged verifier to require the registration command, exact
  semantic-only top-level dispatch parameters, and the installed SOUL wording
  that keeps capability and topic-mode authority out of model arguments. The
  full installer GREEN run is in progress.

## 2026-07-19 - Adaptive legacy-topic repair continuation

- Restored the approved design and prior RED/GREEN evidence after context
  handoff. Production message `445` was rejected inside the plugin because the
  model corrupted a copied signed capability; route mapping and legacy topic
  identity were correct, and HCO received no request.
- Implemented and verified the internal capability vault, semantic-only model
  tool contract, trusted `topicModeAction: null`, `HERMES_ONLY` guard, mapped
  legacy-topic lazy creation, and unmapped-stream registration behavior.
- Fresh prior phase evidence: full plugin contract `235 passed`; full HCO
  service suite `41 passed`.
- Resumption audit found the next release blocker: installer-generated
  `BRIDGE_SOUL` still documents the removed model-carried capability. Next step
  is a RED installer assertion, minimal profile-text repair, installer suite,
  documentation, full verification, review, transactional deployment, and
  authorized live Zulip acceptance.
- Added installer source and installed-profile assertions for the semantic-only
  contract. The first run produced the expected RED after two successful
  dry-run checks: embedded Python exited with `AssertionError` because the old
  capability instruction was still present.
- Replaced only the generated `BRIDGE_SOUL` instruction: executable work now
  calls `hco_dispatch` once with only `semantic`, while capability and
  `topicModeAction` remain private trusted bridge state.
- The first full GREEN attempt advanced past the new source assertions but
  failed the staged effective-Hermes health gate. Its embedded probe still
  required an `<hco_capability>` prompt, so it rejected the repaired bounded
  prompt as malformed. Updated that exact probe expectation to the new
  semantic-only prompt; no runtime authorization rule was weakened.
- The second full run passed that gate and failed later at embedded-contract
  line 218: the installed plugin correctly registered the new private
  `hermes-codex-bridge-registration` command, but the installer test still
  expected the old three-command set. Updated the expected private command set
  and added an installed-registry assertion that `hco_dispatch` accepts only
  the required `semantic` property with additional properties disabled.
- The third full installer transaction run completed `1..32`. It covered fresh
  install, reinstall, staged Gateway/provider probes, activation and rollback,
  immutable release migration, profile/SOUL installation, process ownership,
  SQLite drain, and fail-closed fixtures.
- Updated the support/upgrade guide to separate unmapped streams from invalid
  snapshots, record the internal-only capability invariant, define mapped old
  topic lazy creation, prohibit thread recreation on uncertain errors, and add
  the exact staged/install/live acceptance checks needed after Hermes upgrades.

## 2026-07-19 - Adaptive topic dispatch RED

- Added model-contract regressions requiring `hco_dispatch` to expose only the
  semantic object and forbidding any signed capability in the channel prompt.
- Ran the three focused plugin contracts with Jarvis' Hermes interpreter. The
  result was the expected RED: `2 failed, 1 passed`; the schema still required
  `capability`, and the prompt still contained `<hco_capability>`. The extra
  model-supplied capability case already failed closed.
- This proves the tests exercise the production defect before implementation.
  The next change keeps the signed token in the plugin vault and binds a
  semantic-only call to trusted session/turn identity.

## 2026-07-19 12:21 - Legacy-topic rejection investigation

- Read Zulip, Gateway, Hermes session, tool-call, and HCO database evidence for
  boss message `445` and Jarvis reply `446` without changing runtime state.
- Confirmed stream `4 -> ASK` routing and message provenance were correct. The
  failure happened before HCO received an intent: the model corrupted the
  opaque capability while copying it into `hco_dispatch`, and the plugin
  correctly rejected the invalid signature/payload.
- Separated the immediate fault from the requested compatibility behavior.
  Unregistered mapped topics need deterministic lazy initialization; unmapped
  streams need a bounded projectId/canonical-cwd registration question; a
  missing Codex App Server thread should be recreated only after durable route
  and ACL validation.
- No plugin, HCO database, topic mode, route snapshot, service, or deployment
  was modified. Protocol design confirmation is required before RED tests and
  implementation because moving capability custody changes the bridge trust
  boundary.

## 2026-07-19 08:04 - Post-fix live acceptance audit continuation

- Resumed the authorized boss ID `8` acceptance audit after the user confirmed
  all post-fix messages had been sent by 08:04 Asia/Shanghai.
- Queried Zulip's stream catalog read-only. The canonical ASK stream is
  `ASK项目` (stream ID `4`), not `ASK`; the earlier empty ASK read was therefore
  a query-name error and is not delivery evidence. The other targets are
  `general` (stream ID `3`) and `量化交易stockProfits` (stream ID `5`).
- The deployed process set is unchanged at this checkpoint: Gateway PID
  `26930`, HCO PID `26835`, and delivery PID `27044`, all started during the
  06:36 repair deployment. No runtime or routing state was changed by this
  read-only audit.

## 2026-07-19 - Route-query repair continuation

- Reconciled the authorized nine-message matrix with the implementation state.
  The matrix is a pre-fix baseline: the running Gateway still loads release
  `hermes-codex-bridge-1.0.0-4c49ebe19474`, while the repository contains the
  new trusted route-query classifier. No post-fix live acceptance can be
  inferred from those replies.
- Recorded both observed failure paths in `findings.md`: a combined
  projectId/cwd/progress query bypassed the narrow route-query classifier and
  allowed stale model context; the ASK burst then produced a malformed
  capability and was correctly rejected fail-closed.
- The new RED/GREEN tests cover the exact combined phrase and progress-only
  burst form. Focused verification is `3 passed`; deployment and post-fix
  real Zulip acceptance remain pending.
- One planning-file patch used the wrong Markdown heading level for the
  existing progress section and applied no changes. The retry used exact
  anchors and changed only the intended planning records.

## 2026-07-19 - Authorized three-channel acceptance closeout

- Began a fresh read-only Zulip audit for messages `380-386` supplied by the
  authorized boss acceptance run. The first query passed integer message IDs
  in an `id` narrow; the installed Zulip API rejected all seven requests with
  `Invalid narrow[0]` because narrow elements must be string pairs. No message,
  route, service, profile, ACL, database, or credential state changed. Retry
  with the same IDs serialized as strings before drawing any visibility or
  delivery conclusion.
- The first SQLite schema probe carried forward the obsolete table guess
  `delivery_outbox`; the live `.tables` output in the same read-only command
  showed the deployed schema uses `zulip_outbox`. Its `PRAGMA` therefore
  returned no columns and no state changed. Subsequent acceptance queries must
  use the discovered table name and inspect its columns before selecting rows.
- Retried the Zulip API with string IDs. Independent readback bound authorized
  boss ID `8` message `380` in stream `5` (`量化交易stockProfits`) to Jarvis
  acknowledgement `382` and final result `386`; message `381` in stream `4`
  (`ASK项目`) to reply `383`; and message `384` in stream `3` (`general`) to
  reply `385`. All seven messages share topic
  `message-id-repair-20260718-2055` and Jarvis replies are authored by bot ID
  `9`. The General reply states `hermes-general`; ASK reports project `ASK` and
  `/Users/hula/workspace/ASK`; stockprofits reports project `stockprofits` and
  `/Users/hula/Projects/stockprofits`.
- Direct `id=385` narrow returned an empty successful result even though a
  stream/topic read immediately recovered message `385`. Therefore an empty
  single-ID narrow is not sufficient evidence that a bot reply was never sent;
  acceptance readback must cross-check the exact stream/topic window.
- The live HCO schema was inspected before querying. Objective
  `objective-fa804d14-1743-43e9-9bf0-102b73291368` is `completed`, its turn
  submission and App Server execution are both `completed`, its project binding
  is `stockprofits`, and its one-attempt outbox delivery is `delivered` with
  `acknowledged_zulip_message_id=386`. This closes the asynchronous path beyond
  the immediate acknowledgement `382`.
- Fresh runtime evidence found Gateway PID `82761`, HCO PID `13595`, and
  delivery PID `13806` still running. HCO health returned HTTP 200 with
  `status=ok` and `appServer.available=true`; route snapshot generation `6`
  retained `4 -> ASK`, `5 -> stockprofits`, and `defaultOwner=HERMES`.
- Fresh release gates passed: complete Python `296/296`, complete Node
  `237/237`, installer transactions `32/32`, aggregate `npm run verify`,
  installer shell parsing, and `git diff --check`. The apparent ASK-to-
  stockprofits jump in the pasted transcript is display interleaving across two
  project streams, not a route mutation inside General.

## 2026-07-18 - Final release-gate continuation

- Recovered the post-restart context without changing the approved routing
  strategy. The deployed release remains
  `hermes-codex-bridge-1.0.0-4c49ebe19474`; the last verified Gateway PID is
  `82761`, HCO PID is `13595`, and delivery PID is `13806`.
- Reviewed the collection-time pytest isolation guard. Its production
  attestation comparison was correct, but an assertion failure could skip
  temporary-home cleanup. Moved cleanup into `finally` without changing the
  fail-closed production-state assertion.
- The next gate is the complete Python suite with a production attestation
  hash comparison before and after, followed by the remaining repository
  release gates and read-only Zulip acceptance audit.
- Ran the complete Python suite with Jarvis' Hermes interpreter: `296 passed`
  in 15.03 seconds. The live attestation SHA-256 was
  `89da2963cdfa8ebcbeea065fc4759d9a0914143893b05a52e307c2885f3fe040`
  both before and after pytest, proving the collection-time isolation held for
  the full `test/` tree.
- The complete Node suite passed `237/237`. Installer shell parsing and
  `git diff --check` both exited zero. The transactional installer harness and
  aggregate `npm run verify` remain before the final runtime audit.
- The transactional installer harness completed `1..32` with exit code zero.
  Its two `invalid Hermes home` messages came from intentional fail-closed
  fixtures; the corresponding canonical/custom Provider scenarios passed.
- `npm run verify` completed every declared check, smoke, contract, dispatch,
  dispatch-success, and hardening phase with exit code zero.
- Final runtime observation found HCO PID `13595`, delivery PID `13806`, and
  Gateway PID `82761` running with no prior exit. Stable, the live attestation,
  and the installed plugin all agree on release
  `hermes-codex-bridge-1.0.0-4c49ebe19474`; repository and installed plugin
  SHA-256 both equal
  `3bf0c13b263f331b910aebf89699c5d38c3b4ffc58141bf92aa401669ae3cd82`.
- Authenticated HCO health reports `status=ok` and
  `appServer.available=true`. Renewing snapshot generation `5` still contains
  only `4 -> ASK` and `5 -> stockprofits`, with `defaultOwner=HERMES`.
- Independent Zulip API readback found no boss ID `8` message after deployment.
  Messages `377-379` were authored by SpecPlanner ID `10`; Gateway correctly
  rejected them under the unchanged allowlist, and HCO's journal contains no
  corresponding execution. Therefore the three reply-bearing General/ASK/
  stockprofits acceptance checks remain pending a lawful boss-authored turn.
- A read-only outbox query first used obsolete guessed column
  `zulip_message_id`; schema inspection showed the current column is
  `acknowledged_zulip_message_id`. The corrected query confirmed deliveries
  `343-345` remain acknowledged once. No state changed; future upgrade audits
  must inspect the installed schema before issuing diagnostic SQL.
- Final focused verification passed all `222` plugin contracts. The production
  attestation SHA-256 remained
  `89da2963cdfa8ebcbeea065fc4759d9a0914143893b05a52e307c2885f3fe040`
  before and after; `git diff --check`, installer shell parsing, authenticated
  HCO health, launchd process checks, and live attestation validation all
  exited cleanly at the same checkpoint.

## 2026-07-18 - Message-ID repair final acceptance continuation

- Restored the persisted implementation context and reconciled it with the
  dirty worktree. No inherited user change was discarded or rewritten.
- Revalidated the running deployment without mutation: stable resolves to
  immutable release `hermes-codex-bridge-1.0.0-4c49ebe19474`; repository and
  installed `plugin.py` SHA-256 values both equal
  `3bf0c13b263f331b910aebf89699c5d38c3b4ffc58141bf92aa401669ae3cd82`.
- Confirmed HCO PID `13595`, Gateway PID `13671`, delivery PID `13806`, and
  the HCO Codex App Server child remain running from the same deployment.
- Queried Zulip read-only using the configured Jarvis credential. The only
  configured identity is Jarvis PM bot ID `9`, not authorized boss ID `8`.
  No new boss-authored message exists after the post-deployment ingress probes
  `377-379`; therefore no reply-bearing post-repair ASK turn can yet be audited.
- Historical readback remains useful but is not post-repair acceptance:
  General `371 -> 372` and stockprofits `375 -> 376` replied before the
  message-ID release, while ASK `373 -> 374` contains the original bridge
  rejection. These messages must not be relabelled as evidence for the new
  release.
- Re-reviewed the compatibility boundary in source: only a signed
  project-owned natural-language turn may fill an empty source message ID;
  General remains unchanged, conflicts fail provenance, and a read-only field
  becomes the fixed route-unavailable response.

## 2026-07-18 - Jarvis context repair resumed

- Recovered 21 unsynced messages from the prior Codex session and reconciled
  them with the dirty worktree. The Provider closure fix remains staged but
  undeployed; production is still on the inference-incomplete release. The
  active review item is whether an orphan pre-dispatch capability can bind a
  later identical request without modifying Hermes core.
- Restored the interrupted capability-lifecycle review and confirmed the
  Provider repair is still undeployed; production remains on the old
  inference-incomplete release.
- Verified that Hermes lifecycle hooks expose trusted per-turn identity, while
  the plugin tool handler omits `turn_id`. The next TDD boundary is an unused
  turn-A capability presented during turn B, followed by same-turn and
  concurrent-turn isolation coverage.
- Restored the latest production incident context and confirmed the remaining
  untested shape is non-canonical `iotwq` with an empty keyed compatibility
  placeholder plus the effective legacy `custom_providers` declaration. The
  next TDD case will exercise Hermes runtime resolution from the installed
  isolated profile, not only compare generated YAML.
- Added installer transaction scenario 32 with the exact production Provider
  topology. Before any production change, the suite reached that scenario and
  failed at the expected `bridge.get("providers") is None` assertion; staged
  Hermes runtime resolution had already passed. This isolates the defect to
  copying an endpoint-free keyed placeholder into an otherwise valid closure.
- Investigated the user's 13:21 production failure before making any new
  change. The live Gateway log reports `No inference provider configured`,
  not an upstream credential rejection.
- Confirmed the activated `codex-bridge` profile has no model/provider closure
  and no `.env`, while the default profile selects `gpt-5.5` through the
  custom `iotwq` Provider. The 12:30 rollout therefore restored the Hermes
  agent/SOUL path but activated an inference-incomplete isolated profile.
- Current repository fixes had not been deployed after their release gates;
  production is still running release `1.0.0-441a66c6a242` from the earlier
  incomplete rollout. Review now expands from the canonical built-in fixture
  to the actual custom-Provider closure before a dry-run or transaction.
- Completed fresh pre-review release gates after the Provider precedence fix:
  installer transactions `31/31`, repository `npm run verify`, bridge plugin
  contracts `212/212`, Hermes focused regressions `109/109`, installer shell
  syntax, and both dirty worktree whitespace checks all exited cleanly.
- The recovered line-numbered installer trace completed with exit 0 and
  `1..31`. Its final canonical built-in Provider scenario passed after proving
  the isolated bridge profile omitted both same-named keyed and legacy custom
  shadows while Hermes resolved the built-in `openrouter` credential.
- Recovered the active line-numbered installer trace after context handoff. It
  passed the previously suspected Gateway activation rollback assertion at
  test line 1261 and continued into the following missing-attestation case.
  This rules out that rollback assertion as a deterministic product failure;
  the trace remains in progress and is not yet GREEN evidence.
- Recovered the previous session and preserved both dirty worktrees.
- Rechecked Hermes runtime precedence against
  `hermes_cli/runtime_provider.py`; the outstanding canonical keyed-shadow
  review finding is valid.
- Resuming at the TDD review gate before any production deployment. The next
  action is to run the new canonical-shadow installer case and confirm the
  expected RED failure, then make the minimal closure-selection change.
- The inherited canonical test initially passed because it contained only a
  legacy `custom_providers:` shadow. Added a same-named keyed
  `providers.openrouter` endpoint and reran the full installer suite.
- The corrected suite reached the final scenario and failed at the exact
  `bridge.get("providers") is None` assertion (exit 1), while installation and
  staged provider resolution succeeded. This proves the regression targets the
  closure-copy mismatch rather than fixture authentication.
- Applied the minimal production change: canonical built-ins now return an
  empty provider-declaration closure before keyed or legacy declarations are
  copied.
- The first GREEN rerun was terminated by SIGTERM (exit 143) before reaching
  the target scenario and emitted no failing assertion. It is not verification
  evidence; checking for leaked harness processes precedes one adjusted retry.

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

## 2026-07-18 - Provider closure continuation

- Added production-shaped installer scenario 32 for the exact live `iotwq`
  keyed-placeholder plus legacy-custom topology. It failed against the prior
  selector and passed after endpoint-free keyed declarations were excluded;
  the complete installer suite emitted `1..32` and exited 0.
- Restored the session after compaction and confirmed the latest patch remains
  undeployed. Began mandatory dual-CLI review before fresh release gates and
  transactional activation.
- An initial planning-file patch used a stale section anchor and applied no
  changes. Retried against the current file tails.

## 2026-07-18 - Capability lifetime review continuation

- Restored the existing plan and repository state after context compaction.
- Confirmed production still runs the old Provider-incomplete release; no
  deployment has occurred in this continuation.
- Adjudicated the latest Claude review as actionable: unused NLP capabilities
  remain in `PendingVault` until expiry when Hermes answers normally.
- Began source tracing across Hermes Gateway hooks, session finalization, and
  tool invocation context before adding a focused RED regression.
- Restored the implementation session from the on-disk plan and confirmed the
  checkout remains on `codex/option-c-app-server` with the Provider/capability
  repair still uncommitted and undeployed.
- Confirmed the pending Gemini diff review is still running and has produced no
  result yet. A separate older repository-reading review is also still alive;
  neither is counted as review evidence until it returns a concrete result.
- Restored the compacted session using the planning catch-up helper and checked
  current production state without mutation. The stable release is still
  `441a66c6a242`, the isolated profile still has no `.env`, and fresh Gateway
  log evidence reproduces `No inference provider configured` for both messages
  in the user's latest transcript.
- Began source-level reachability analysis of Gemini's identical-request stale
  capability candidate before running release gates or deploying.
- Confirmed the Gateway exposes the triggering platform message ID through a
  task-local ContextVar that reaches `pre_llm_call`. Added RED contract cases
  for orphan identical-text capabilities, valid identical-text FIFO turns, and
  missing-message-ID fail-closed behavior; production logic is unchanged until
  those tests fail for the expected reason.
- Ran the three focused cases before the production edit: orphan reuse and
  missing-ID cases failed at their rejection assertions, while the valid FIFO
  case passed. Updated `PendingVault.bind_turn()` to require exact canonical
  source-message-ID equality and `pre_llm_call` to read Hermes' task-local ID.
- Re-ran the focused message-binding cases GREEN (`3/3`) and the complete
  Hermes bridge plugin contract suite GREEN (`218/218`).
- The first full installer rerun stopped in its fresh-install effective-loader
  probe because that embedded probe passed only an event to `pre_gateway_dispatch`.
  It therefore lacked the trusted Gateway/session-store interfaces required by
  the already-added lifecycle binding. Added only equivalent fixed-key fixture
  interfaces to the installer probe before rerunning the transaction suite.
- Re-ran the complete installer transaction suite after repairing that probe.
  All `32/32` scenarios passed with exit code zero, including canonical
  Provider shadow handling, the production-shaped `iotwq` inference closure,
  lifecycle-bound capability dispatch, release migration, and rollback gates.
- Completed the remaining sequential pre-deployment gates with fresh evidence:
  `npm run verify` exited zero, all Node tests passed `237/237`, all Hermes
  plugin contracts passed `218/218`, the installer shell parsed cleanly, and
  `git diff --check` reported no whitespace errors.

## 2026-07-18 - General profile provider repair

- Reproduced the user's provider-authentication warning as a missing
  `hermes-general` inference closure rather than a bad credential.
- Added a RED installer contract requiring the general profile to contain the
  selected model/provider declaration, no inline key or project fields, and
  only the selected profile-local credential. It failed with `KeyError:
  'model'` against the prior installer.
- Refactored provider staging into one shared sanitizer used by
  `codex-bridge` and `hermes-general`; added transactional staging, snapshot,
  rollback, activation, and effective-probe handling for the general `.env`.
- Re-ran the installer transaction suite after the implementation; all 32
  scenarios passed and `git diff --check` remained clean.

## 2026-07-18 - General provider deployment and live ingress test

- Re-ran every release gate after the final stale-provider cleanup: installer
  `32/32`, plugin contracts `218/218`, Node `237/237`, `npm run verify`, shell
  syntax, and `git diff --check` all exited zero.
- Ran a read-only installer dry-run, then deployed transactionally with the
  Codex executable bound in `~/.hco/hco.json`. All staged/activated probes and
  final service readiness checks passed; installation committed as plugin
  `1.0.0`.
- Verified the live general and bridge profiles both resolve the selected
  inference provider inside Hermes' isolated profile scope, with non-empty
  credentials and owner-only dotenv files. Verified attestation, service PIDs,
  and the unchanged ASK/stockprofits/default-Hermes route snapshot.
- Sent three real Zulip messages as SpecPlanner ID `10`: message IDs `368-370`
  in streams `3-5`. The running Gateway consumed all three but correctly
  rejected that sender at its allowlist; no reply was generated.
- Confirmed the only local Zulip API identity is Jarvis ID `9`, Safari has no
  authenticated boss session, and all project ACLs authorize only boss ID `8`.
  Final reply-bearing live acceptance remains pending a lawful ID `8` message;
  no ACL or sender identity was weakened to manufacture a pass.

## 2026-07-18 - Zulip message-ID handoff repair

- Reproduced the current ASK rejection by tracing the real adapter and Gateway:
  Zulip puts the triggering ID on `MessageEvent`, while the Gateway's task-local
  session environment reads it from `SessionSource`, which remains empty.
- Selected the plugin compatibility repair already approved by the user: after
  strict nested-event provenance validation, fill only a missing source ID from
  the verified event ID. Do not modify Hermes core or weaken conflict checks.
- Began RED coverage by changing the real-Gateway fixture to match the installed
  Zulip adapter and requiring the plugin hook to complete the handoff.
- RED evidence: the focused contract failed because routing selected
  `codex-bridge` while `SessionSource.message_id` remained `None` instead of
  the verified event value `"600"`.
- Implemented the minimal compatibility handoff after provenance validation;
  existing non-empty source IDs are never overwritten.
- Added a second RED contract for a future read-only `SessionSource.message_id`.
  Before the production guard, the hook raised `AttributeError` and PluginManager
  returned no routing result. Wrapped only the verified-ID assignment so such
  compatibility drift returns the fixed route-unavailable command.
- Re-ran the focused promotion/read-only contracts GREEN (`2/2`). Updated the
  support guide, linked context-repair design, findings, and progress records
  with the end-to-end ID chain and Hermes upgrade/removal criteria.
- Resumed from the persisted plan without restarting the already-running Node
  gate. The complete `node --test test/*.test.js` run finished with exit code
  zero: `237/237` passed, with no failures, skips, cancellations, or todos.
- Reconciled the session catch-up report with the worktree. The Provider/general
  rollout is already active in production; the remaining deployment delta is
  the `MessageEvent.message_id` to `SessionSource.message_id` compatibility
  handoff and its upgrade documentation.
- Deployment review identified an avoidable blast radius: the initial handoff
  also filled the source ID for General traffic before route selection. Added a
  RED General contract, then moved the assignment into the signed project
  natural-language branch. The focused promotion/General/read-only matrix is
  GREEN (`3/3`), while General and command handling remain untouched.
- Completed the final-state installer transaction suite after the scope
  refinement: all `32/32` scenarios passed with exit code zero. The suite
  covered immutable release promotion, rollback, concurrent installation,
  provider closure, service-state restoration, and the effective Hermes probe.
- Re-ran the deployment static gates against the same worktree: `bash -n
  scripts/install-hermes-codex-bridge.sh` and `git diff --check` both exited
  zero with no output.
- Rechecked the final diff against ADR 0001, ADR 0002, and the context-repair
  design. The Codex review found no Critical or High issue after the General
  scope correction. Claude returned an empty review body and Gemini terminated
  with `INVALID_STREAM`, so neither external attempt is counted as review
  evidence or a pass.
- Ran the strict installer dry-run with the HCO-configured Codex executable;
  it exited zero without reading configuration contents or mutating runtime
  state. Ran the same installer transaction without `--dry-run`; staged and
  activated route, Provider, effective-Hermes, bridge-protocol, and App Server
  readiness probes passed before `installation committed: plugin 1.0.0`.
- Independently verified immutable release `4c49ebe19474`: the stable symlink
  points to it, repository and installed `plugin.py` SHA-256 values match, the
  Hermes discovery tree contains one bridge manifest, and the live attestation
  binds Gateway PID `13671` to that exact release. HCO PID `13595` and delivery
  PID `13806` are also fresh and running.
- Verified bridge compatibility and App Server availability through the live
  authenticated Unix socket without exposing the bearer. Verified both
  `codex-bridge` and `hermes-general` resolve a Provider inside Hermes' real
  profile runtime scope. The signed route snapshot validates as stream `4 ->
  ASK`, stream `5 -> stockprofits`, default `HERMES`; protected configuration,
  secret, snapshot, attestation, profile dotenv, and plist files remain mode
  `0600`, while the release store remains `0700`.
- Sent post-deployment Zulip messages `377`, `378`, and `379` as the lawful
  SpecPlanner bot ID `10` to General, ASK, and stockprofits under topic
  `message-id-repair-20260718-2055`. The Gateway consumed all three and rejected
  them at the unchanged authorization gate. After 20 seconds there were zero
  replies and HCO inbound/objective/turn/outbox counts were unchanged. This is
  valid ingress/ACL evidence, not reply-bearing acceptance; the only local bot
  credentials are IDs `9-14`, while project ACLs and HCO admin authority remain
  ID `8` only. Three boss-authored messages are still required for complete live
  ASK/stockprofits/General reply acceptance.
- Ran the final fresh post-deployment repository gates: Hermes plugin contracts
  passed `221/221`, Node tests passed `237/237`, `npm run verify` completed every
  check/smoke/contract/dispatch/hardening stage, and shell syntax plus `git diff
  --check` exited zero. Removed only the generated untracked pytest bytecode
  cache after the run.

## 2026-07-18 - Python contract isolation incident

- Found that the preceding full plugin-contract run had replaced the live
  `/Users/hula/.hermes/hermes-codex-bridge-attestation.json` with pytest PID
  `22476`, while launchd still reported Gateway PID `13671`. The plugin path was
  the real immutable release, proving live plugin discovery occurred inside the
  test process rather than the Gateway restarting.
- Traced the boundary to Hermes import-time/lazy plugin discovery: importing
  the real Gateway dependency graph can instantiate the module-global
  `PluginManager`, and plugin registration writes its process attestation.
  Function-scoped `monkeypatch.setenv("HERMES_HOME", tmp_path)` begins too late
  to protect collection and unrelated global discovery.
- Added a RED contract requiring process-wide Hermes state isolation before
  plugin discovery. It failed because `HERMES_HOME` was absent. Added
  `test/conftest.py`, which redirects both `HOME` and `HERMES_HOME` to one
  temporary sandbox during conftest import and snapshots every original live
  attestation candidate for a session-end unchanged check.
- The first GREEN run exposed only the macOS `/var` to `/private/var`
  canonicalization difference; comparing resolved paths made the invariant
  portable without weakening it.
- Re-ran the focused isolation contract GREEN (`1/1`) and the complete plugin
  contract suite GREEN (`222/222`). For both runs, the production attestation
  SHA-256 was exactly `c316e5c3f542b959a0645811e03daef97b1f06e4f435415701b7396ddb61b4b0`
  before and after.

## 2026-07-18 - Resumed production verification

- Restored the persisted plan after context handoff and rechecked production
  without changing Gateway, HCO, delivery, Hermes profiles, ACLs, or Zulip
  state. Gateway PID `82761`, HCO PID `13595`, and delivery PID `13806` remain
  live. The stable bridge and Gateway attestation still resolve to immutable
  release `4c49ebe19474`; repository and installed `plugin.py` SHA-256 values
  both equal `3bf0c13b263f331b910aebf89699c5d38c3b4ffc58141bf92aa401669ae3cd82`.
- Authenticated HCO health returned HTTP 200 with `status=ok` and
  `appServer.available=true`. The signed route snapshot remains generation 5
  with stream `4 -> ASK`, stream `5 -> stockprofits`, and
  `defaultOwner=HERMES`.
- A fresh read-only Zulip query found no post-deployment boss ID `8` messages.
  The newest relevant messages remain `377-379`, all authored by SpecPlanner
  ID `10`. Gateway logs record the three expected authorization rejections,
  and HCO journal/objective/submission/outbox rows remain unchanged.
- The first health probe used the guessed config key `bearerTokenPath`; the
  installed schema uses `bridge.tokenPath`. The corrected probe succeeded.
  A first read-only SQLite query guessed `outbox_id`, `status`, and
  `platform_message_id`; schema inspection showed the actual columns are
  `delivery_id`, `state`, and `acknowledged_zulip_message_id`. The corrected
  queries confirmed no new work. These diagnostic errors changed no state and
  reinforce the support rule to inspect live config/database schemas before
  querying across upgrades.
- Ran fresh final gates after the recovery audit: complete Python `296/296`,
  complete Node `237/237`, installer transactions `32/32`, aggregate
  `npm run verify`, installer shell parsing, and `git diff --check` all exited
  zero. The production attestation SHA-256 remained
  `89da2963cdfa8ebcbeea065fc4759d9a0914143893b05a52e307c2885f3fe040`
  before and after the Python suite, proving test discovery did not touch the
  live Gateway attestation.
- Rechecked production after every gate: the same three service PIDs remained
  active, HCO health still returned HTTP 200/`ok` with App Server available,
  and repository/installed plugin hashes remained identical. A final Zulip
  read still found only messages `377-379` from ID `10`, so reply-bearing live
  acceptance remains correctly open pending three authorized ID `8` messages.

## 2026-07-19 - Route-query repair deployment and test timing audit

- Deployed release `hermes-codex-bridge-1.0.0-aff45e13f157` at 06:36 local
  time. The stable plugin symlink points to that immutable release; live
  Gateway PID `26930`, HCO PID `26835`, and delivery PID `27044` were started
  at the same deployment boundary. HCO health and App Server availability
  remained operational.
- Independently read the three route-query matrix streams after deployment.
  The last authorized boss messages are `391`, `397`, and `403`, timestamped
  06:09-06:13, with old-version replies `392`, `398`, and `404/405`. No new
  boss ID `8` message exists after 06:36 in General, ASK, or
  `量化交易stockProfits`.
- Queried the live SQLite state without mutation: objective count remains `7`,
  and no new post-deployment objective/turn/outbox was created. The absence of
  fresh traffic means the repaired zero-model route path is deployed but not
  yet reply-bearing live-accepted.
- Acceptance remains intentionally blocked on a new message from authorized
  boss ID `8`; the local `.zuliprc` is Jarvis bot ID `9`, so sending locally
  would test outbound delivery only and would invalidate the authorization
  evidence. Fresh markers are required to distinguish the new release from
  the pre-deployment baseline.

## 2026-07-19 - 08:04 traffic was pre-deployment; repaired release active at 08:27

- The complete installer gate passed `32/32` and committed immutable release
  `hermes-codex-bridge-1.0.0-4cedb2c0be61` at 08:27 local time.
- Stable plugin resolution, live attestation, and Gateway agree on the new
  release. Gateway PID `50067`, HCO PID `49983`, and delivery sidecar PID
  `50168` are active. Authenticated HCO `/v1/health` returned `status=ok` and
  `appServer.available=true`.
- Independent Zulip readback found boss messages `406-422` only in the
  08:02:30-08:04:50 window, before deployment. They reproduce the old
  `api_calls=1`, objective-creation, and stockprofits-to-ASK cwd symptoms but
  cannot serve as post-fix acceptance.
- Future acceptance must use fresh markers from authorized boss ID `8` after
  the deployment boundary; local Jarvis credentials are ID `9` and are not a
  valid substitute.

## 2026-07-19 - 08:04 authorized acceptance diagnosis and follow-up repair

- Independently audited the authorized boss messages `406`, `408`, `410`,
  `411`, `412`, `416`, and `419` and Jarvis replies `407`, `409`, `413-418`,
  and `420-422` across General stream `3`, ASK stream `4`, and stockprofits
  stream `5`. Every inbound turn reported `api_calls=1` in Gateway logs.
- ASK and stockprofits progress-only requests created HCO objectives, while the
  stockprofits same-text response returned the ASK cwd. The deployed route
  snapshot and service identities were correct; the failure occurred before
  the trusted route-show rewrite.
- Gateway logs show the hook receives the same clean text visible in Zulip, so
  mention stripping and hidden newlines are not involved. The classifier did
  not accept the live `回显 POSTFIX-*` suffixes or the project/cwd-only form.
- Added a three-case RED contract from the exact live text. All three cases
  returned `allow`, reproducing the production failure. The bounded classifier
  repair accepts only known route-query bases plus an optional `回显` marker of
  1-64 ASCII letters, digits, dots, underscores, or hyphens.
- The first GREEN run passed the sentence-boundary form but exposed the second
  live connector, `并回显`; three tests passed and three failed. Adding only the
  optional connector brought the focused route-query set to `6/6` passing.

## 2026-07-19 - 08:34 post-deployment authorized acceptance

- Independently read back the authorized boss ID `8` matrix and Jarvis ID `9`
  replies: General `423 -> 424`, ASK `425 -> 426`, stockprofits `427 -> 428`,
  ASK burst `429 -> 430`, stockprofits burst `431 -> 432`, stockprofits
  same-marker `433 -> 434`, and ASK same-marker `435 -> 436`.
- General reply `424` reported `hermes-general`, confirmed General, and echoed
  `LIVE-0827-G-001`. Gateway recorded the expected normal General model path at
  08:34:41-08:34:48 with `api_calls=1`.
- All six project replies used the trusted route result: ASK always returned
  `/Users/hula/workspace/ASK`; stockprofits always returned
  `/Users/hula/Projects/stockprofits`. Gateway logged only the direct send for
  these replies, with no ordinary inbound/model-response record.
- From the 08:27 deployment boundary onward, live SQLite has no new
  `objectives`, `turn_submissions`, or `zulip_outbox` rows. Totals remain
  `10`, `9`, and `8`; their maximum creation times all predate deployment.
- The project route replies did not echo their requested `LIVE-*` marker.
  This does not invalidate stream-to-project isolation or zero-model/no-HCO
  evidence, but it is a separate reply-contract gap and must not be reported as
  a successful marker-echo assertion.

## 2026-07-19 - marker reply contract repair and deployment

- Chose the smallest compatible fix: keep the existing closed route-query
  whitelist and add only a bounded, anchored marker suffix. The grammar is
  ASCII `[A-Za-z0-9._-]{1,64}`; arbitrary prose remains a normal model path.
- The accepted marker is carried only in the signed Python bridge context as
  optional `replyMarker`, and is valid only for `{"type":"ROUTE","action":"SHOW"}`.
  HCO command events, ACLs, capability validation, replay protection, and
  Hermes core remain unchanged.
- Added RED/GREEN contract coverage for exact marker preservation, no-marker
  reply compatibility, whitelist non-expansion, and no-model project queries.
- Verification: focused plugin contract `5 passed`; full plugin contract
  `232 passed`; Node suite `237 passed`; Hermes Python suite `306 passed`;
  installer contract `32/32`; `npm run verify`, `npm run adapter:verify`,
  shell syntax, and `git diff --check` passed.
- Dry-run completed without secret reads. Transactional install committed
  release `hermes-codex-bridge-1.0.0-7d4b736404d0`; stable link, installed
  `plugin.py`, and source have identical SHA-256. Post-install HCO health is
  `status=ok` with `appServer.available=true`; Gateway PID `7015`, HCO PID
  `6927`, and delivery PID `7124` are running, and attestation points at the
  new release.
- Remaining acceptance is intentionally external: boss ID `8` must send new
  post-deployment General, ASK, and stockprofits messages. Existing messages
  are not reused, and local bot ID `9` is not an authorized substitute.

## 2026-07-19 - 09:32 authorized marker acceptance completed

- Independent Zulip API readback confirmed boss ID `8` and Jarvis ID `9` pairs:
  General `437 -> 438`, ASK `439 -> 440` and `441 -> 442`, and stockprofits
  `443 -> 444`. There were no newer Zulip messages when rechecked at 09:55.
- General reply `438` reported `hermes-general`, confirmed General, and echoed
  `LIVE-0901-G-001`. Gateway recorded the expected model path with
  `api_calls=1`.
- ASK replies `440` and `442` returned project `ASK`, cwd
  `/Users/hula/workspace/ASK`, and their exact markers. Stockprofits reply
  `444` returned project `stockprofits`, cwd
  `/Users/hula/Projects/stockprofits`, and `LIVE-0901-STOCK-001`.
- Gateway logs contain only direct Zulip sends for the three project queries,
  as expected for `route.show`. From the first acceptance message timestamp
  `1784424744000`, SQLite added zero `objectives`, zero `turn_submissions`, and
  zero `zulip_outbox` rows. Totals remain `10`, `9`, and `8`.
- Fresh runtime evidence after readback: HCO PID `6927`, Gateway PID `7015`,
  and delivery PID `7124` are live; authenticated bridge health is `status=ok`
  with `appServer.available=true`; attestation points to immutable release
  `hermes-codex-bridge-1.0.0-7d4b736404d0`.

## 2026-07-19 - adaptive dispatch full regression before review

- Resumed the semantic-only capability-vault repair after context handoff and
  collected the already-running full suites instead of starting duplicates.
- The complete Hermes Python suite passed `309/309` in 15.62 seconds.
- The complete Node suite passed `238/238` with zero failures, cancellations,
  skips, or todos in 11.31 seconds.
- These results include the mapped legacy-topic regression, semantic-only
  plugin contract, installer/profile compatibility coverage, and the existing
  App Server uncertainty/reconciliation protections. Mandatory ADR/spec review,
  aggregate gates, transactional deployment, and fresh live acceptance remain.

## 2026-07-19 - installer gate, external review, and lifecycle hardening

- Recovered the already-running installer suite and confirmed exit zero with
  `1..32`. The staged upgrade probe now enforces the semantic-only tool schema,
  registration command, and installed SOUL boundary before activation.
- Recovered a completed read-only Claude review: Critical `0`, High `3`, Medium
  `4`, Low `4`. Adjudication accepted only the runtime `SessionStore`
  replacement risk as a release-blocking hardening item; the other candidates
  are bounded retention, required protected provider closure, already-fail-
  closed malformed lifecycle values, or a review-side boundary misread.
- Added `test_natural_capability_rejects_runtime_session_store_replacement`.
  RED produced the ordinary `allow` result where route-unavailable was
  required. The minimal implementation pins the first store under a lock,
  rejects a later different object, and reads the reference under the same
  lock in `pre_llm_call`.
- Focused GREEN passed `4/4`, covering replacement rejection, correct bound
  turn behavior, concurrent session isolation, and FIFO message-ID binding.
- Next: rerun every repository gate from the current tree, perform the
  mandatory ADR-aware final code review, execute the strict production
  dry-run, then deploy and verify runtime state before requesting or inspecting
  fresh authorized Zulip acceptance traffic.

## 2026-07-19 - adaptive dispatch fresh release gates

- Full Hermes Python suite: `310 passed in 17.94s` with exit zero.
- Full Node suite: `238` tests passed with zero failures, cancellations, skips,
  or todos.
- Installer transaction suite: `1..32` with exit zero, including fresh install,
  upgrades, immutable release migration, compatibility rejection, rollback,
  staged-runtime probes, launchd handoff, SQLite ownership, and provider
  closure scenarios.
- `npm run verify` and `npm run adapter:verify` both exited zero. Installer and
  installer-test shell parsing, plus `git diff --check`, also exited zero.
- The only emitted warning was the existing third-party `pkg_resources`
  deprecation warning from Hermes' `lark_oapi` dependency; it did not affect a
  product assertion or exit status.
- Next release gate is the mandatory ADR/spec-aware final review. Production
  remains untouched by these tests.

## 2026-07-19 - adaptive dispatch review resumed

- Restored the active plan, findings, progress ledger, branch state, and the
  unsynchronized session tail before taking further action.
- Reconfirmed the deployment boundary: the semantic-only capability-vault
  implementation and its local release gates are complete, while this release
  has not yet been installed into the live Jarvis Hermes instance.
- The ADR gate is satisfied by ADR 0001 and the 2026-07-19 adaptive-dispatch
  design: single Zulip ingress, restricted `codex-bridge`, General isolation,
  HCO authority for project/cwd, internal-only capability, mapped-topic lazy
  creation, and fail-closed uncertain-thread behavior are all documented.
- Started the mandatory final direct review. Production dry-run, transactional
  install, runtime attestation checks, and authorized Zulip acceptance remain
  gated on a review result with no accepted Critical or High findings.
# 2026-07-19 - Gateway rollback GREEN retry diagnosis

- Collected the completed installer run: it failed only at the new assertion
  that rollback reloads `ai.hermes.gateway.plist`.
- Traced the generated fake `launchctl`, installer rollback branch, and fixture
  variables. The assertion expected a double-slash TMPDIR spelling while the
  installer logged Python's normalized spelling of the identical path.
- Updated only the test fixture to compare against the canonical LaunchAgents
  path. That retry exposed a second representation difference (`/private/var`
  versus `/var`) caused by `pwd -P`. Replaced it with the installer's Python
  `Path` normalization rule. A later rollback-order filter still passed the raw
  double-slash path and omitted the actual `bootstrap` log entry; updated that
  filter to reuse the normalized value. The next action is a fresh installer
  GREEN run.
# 2026-07-19 - Adaptive dispatch final review resumed

- Ran the planning-with-files catch-up after context handoff and recovered 13
  unsynced messages. They confirm the approved strategy and the outstanding
  gate: direct production-state review, fresh release verification, strict
  dry-run, transactional deployment, and authorized live acceptance.
- Located the actual HCO production modules under `hco/`, including
  `service.js`, `turn-controller.js`, and `state/store.js`; no `src/` or `lib/`
  production tree exists. No runtime or production state was changed during
  recovery.
- Review found one release-blocking implementation gap: proven missing App
  Server threads are still collapsed into uncertain backend failures, so the
  accepted automatic-replacement path is absent. Next step is a focused RED
  regression followed by the smallest store/backend/controller repair; generic
  and uncertain failures must remain non-recoverable.
# 2026-07-19 - Proven-missing App Server thread repair

- Resumed the approved adaptive topic repair without changing route ownership,
  ACL policy, or Hermes core.
- Traced the remaining failure through controller, backend, RPC client, and
  store. Confirmed that durable thread binding currently has no replacement
  path and that backend error flattening removes the distinction needed for a
  safe recovery decision.
- Ran an isolated protocol probe against `codex-cli 0.142.3`. A missing
  `thread/read` returned JSON-RPC `-32600` with the exact message
  `thread not loaded: <requested threadId>` and no data. The probe did not use
  the production HCO database or an existing Codex thread.
- Next: add RED tests for exact RPC preservation/classification, single
  replacement binding and resubmission, and fail-closed uncertain errors.

## 2026-07-19 - Proven-missing repair resume audit

- Restored `task_plan.md`, `findings.md`, and `progress.md`, ran the session
  catch-up helper, and reconciled the dirty branch without reverting any
  inherited changes.
- Confirmed the target production and focused test files have no pre-existing
  diff. No repository-local `AGENTS.md` adds further instructions.
- Reconfirmed the approved fail-closed boundary: only JSON-RPC `-32600` plus
  exact `thread not loaded: ${requestedThreadId}` may authorize replacement;
  all transport, timeout, invalid-response, and other RPC failures remain
  uncertain or unavailable.
- Proceeding with RED tests before any production-code edit.

## 2026-07-19 - Proven-missing repair finalization resumed

- Recovered the prior session with the planning catch-up helper and reconciled
  it with the current branch and planning ledgers. The scoped implementation,
  focused tests, complete local release gates, and upgrade notes are present.
- Production has not yet received this proven-missing-thread release. The
  remaining order is mandatory ADR-aware direct review, release-ledger update,
  strict installer dry-run, transactional deployment, runtime attestation, and
  authorized boss-ID-8 Zulip acceptance on a genuinely missing legacy thread.
- No production state or repository source was changed during context recovery.
# 2026-07-19 release-blocking recovery follow-up

- Restored the prior session from the persistent planning ledgers and confirmed
  the worktree remains intentionally dirty with the earlier adaptive-recovery
  implementation and documentation.
- Confirmed two production gaps before deployment: the operator thread-binding
  method is unreachable, and a crash after its durable transaction but before
  `turn/start` strands a known-never-sent submission on idempotent replay.
- Recorded the approved repair boundary in the plan and findings. Next action:
  inspect the exact-command/service patterns and write focused RED tests before
  changing production code.
# 2026-07-19 operator thread-binding RED evidence

- Plugin contract RED: `/Users/hula/Projects/hermesAgent/.venv/bin/python3 -m pytest -q test/hermes_plugin_contract_test.py` completed with `243 passed, 2 failed`. The only failures are the absent exact `/codex thread bind <objectiveId> <threadId>` signed-command grammar and absent readable `objective.thread.bind` renderer.
- HCO/controller RED: `node --test test/hco-service.test.js test/turn-controller.test.js` completed with `91 passed, 3 failed`. HCO rejects `THREAD_BIND` as `BRIDGE_EVENT_INVALID`; the two controller failures exposed a test-fixture counter error before reaching the intended replay assertions, so those fixtures were corrected without changing production code and must be rerun for clean RED evidence.
- Focused fixture rerun proved the durable uncertainty-fence counterexample already makes zero `startTurn` calls. The safe pre-send case initially asserted a stale transaction return row; it now reads committed execution state so the final RED distinguishes durable state from the transaction's pre-update snapshot.
# 2026-07-19 - Operator thread binding completion continuation

- Restored the existing Option C plan and preserved the dirty worktree. The
  approved scope remains the authenticated `/codex thread bind` recovery path,
  durable pre-send replay invariant, upgrade documentation, transactional
  deployment, and real Zulip acceptance; Hermes core and General routing remain
  out of scope.
- Fresh full plugin contract verification passed `245/245` with Jarvis'
  Hermes interpreter.
- Fresh combined HCO/controller verification passed `92/94`. The two failures
  are fixture-contract failures in the concurrency and close-drain service
  tests: those tests replace the controller object but omit the newly required
  `resolveObjectiveThread` method, so `createHcoService()` correctly returns
  `HCO_SERVICE_OPTIONS_INVALID` before either scenario runs. No production
  assertion failed. Add the missing no-op fixture method and rerun the complete
  pair before broader gates.
- Added the missing fail-fast `resolveObjectiveThread` member to only those two
  local controller doubles; production validation was not weakened. The fresh
  complete rerun passed `94/94`, including all binding replay and uncertainty
  fence cases.

# 2026-07-19 - Operator thread binding release continuation

- Restored the persistent plan, findings, progress ledger, branch state, and
  unsynchronized session tail without reverting the inherited dirty worktree.
- Reconfirmed that the exact operator command and durable pre-send replay
  invariant are implemented and covered by fresh focused suites: plugin
  contracts `245/245` and HCO/controller tests `94/94`.
- Corrected the plan checkboxes for those two completed implementation tasks.
  Remaining work is documentation, mandatory dual local review, full release
  gates, strict installer dry-run, transactional activation, runtime
  attestation, and real Zulip/durable-state acceptance.
- Completed the manual renderer/store/controller transition audit and updated
  ADR 0003, the adaptive-dispatch design and implementation plan, and the
  Hermes/Zulip support guide with the exact operator command and crash replay
  invariant. Documentation is complete; review and release gates remain.

## 2026-07-19 - Operator binding review adjudicated

- Completed the mandatory ADR-aware dual review before deployment. Claude
  reported `Critical=0`, `High=0`, `Medium=3`, `Low=5`; Gemini's bounded
  pure-diff review reported no findings.
- Rechecked all three Medium candidates in source. `PendingVault` cleanup is
  lock-protected and idempotent; SQLite write transactions already serialize
  the compare-and-swap binding transition; and the app-server selector already
  returns the configured backend singleton. None changes runtime correctness.
- Recorded the full rationale in `findings.md` and split the plan gate so review
  is complete while fresh release verification remains pending. No production
  code or live Hermes state changed during this adjudication.

## 2026-07-19 - Operator binding release gates

- Fresh aggregate verification passed with exit zero: `npm run verify`.
- Fresh complete Node verification passed `248/248`, including exact
  missing-thread classification, one-shot replacement, operator binding,
  pre-send replay, and post-fence no-resend coverage.
- Fresh Hermes plugin contracts passed `245/245` with Jarvis' runtime Python.
- Fresh transactional installer contracts passed `1..32`; the two printed
  `invalid Hermes home` lines came from intentional fail-closed fixtures.
- `bash -n scripts/install-hermes-codex-bridge.sh`, `git diff --check`, and all
  commands above exited zero. The live stable release remained
  `hermes-codex-bridge-1.0.0-7d4b736404d0`, so these are pre-deployment gates,
  not production acceptance.

## 2026-07-19 - Operator binding deployment and independent runtime checks

- Strict installer dry-run exited zero without reading secret contents,
  starting processes, or mutating live state.
- The transactional install passed bridge protocol compatibility, installed
  Codex App Server compatibility, staged and activated Hermes probes, installed
  Hermes compatibility, and post-activation App Server readiness. It committed
  immutable release `hermes-codex-bridge-1.0.0-53254c3a9d63`.
- Source and installed `plugin.py` SHA-256 were independently compared during
  deployment and matched at
  `556af1e446ad5d6558fa29c7c2be654c6b5db4e382dfde4ca6b9f937772657ec`.
- Independent authenticated `GET /v1/health` over the owner-only Unix socket
  returned HTTP `200` with `status=ok` and `appServer.available=true`.
- The live HCO PID is `35249`; its Codex wrapper child PID `35255` and native
  App Server child PID `35259` are present. Delivery sidecar PID `35459` is
  running from the new immutable release.
- Gateway attestation names PID `35335`, schema `1`, hook
  `pre_gateway_dispatch`, ingress profile `zulip-ingress`, and the same new
  immutable release. The attested path and stable plugin symlink resolve to the
  identical directory.
- HCO config, bearer, context key, SQLite database, signed route snapshot, and
  Gateway attestation are regular files owned by UID `502` with mode `0600`.
- Remaining acceptance: validate route-snapshot integrity and project mapping,
  inspect durable objective/thread/submission state, then exercise a genuinely
  legacy or unregistered boss-ID-8 Zulip topic through the exact recovery path.
- The production `validateRouteSnapshot()` accepted a fresh generation `11`
  snapshot. It resolves numeric stream `4` to `ASK`, stream `5` to
  `stockprofits`, and keeps `defaultOwner=HERMES`; no project is inferred from
  channel names, topic names, or message text.
- Durable topic state contains three active `CODEX_BOUND` aliases: the ASK and
  stockprofits message-ID acceptance topics plus stockprofits topic `框架安装`.
  Objective/thread IDs agree between `topic_modes` and `objective_execution`.
- A 15:00 stockprofits submission remains `running`. Its trusted stream/topic
  route is stockprofits even though its input text asks to work in ASK. This is
  an intentional conflict that must not be resolved by model inference or a
  cross-project cwd switch; investigate completion separately.
- One historical stockprofits smoke objective remains
  `reconciliation_needed`, while another older objective has no App Server
  thread and remains `backend_unavailable`. These rows predate this release and
  are candidates for the documented operator recovery path, not evidence that
  they may be blindly resubmitted.
- A combined SQLite schema/query diagnostic encountered `database is locked`
  after earlier read-only queries succeeded. No state changed. Retry individual
  diagnostics through SQLite read-only URI mode with a bounded busy timeout.
- The read-only retry succeeded. The 15:00 objective has a durable App Server
  thread and running turn, and its initial outbox notification was delivered
  once as Zulip message `449`; no terminal `turn_outputs` row exists yet. This
  is a long-running Codex turn, not a bridge rejection or missing-thread case.
- Gateway logs contain historical `Codex bridge request rejected` entries at
  2026-07-18 19:08, 2026-07-19 06:11, and 2026-07-19 12:22. All precede the
  new immutable release activation around 17:05, so none is post-fix failure
  evidence.
- The `database is locked` retry used SQLite URI `mode=ro` plus a bounded busy
  timeout and returned normally. This is the preferred upgrade-diagnostic form
  when live HCO may be writing WAL state.

## 2026-07-19 17:17 - Message 445 compatibility verification

- Traced the 12:21 production rejection to the old model-carried capability,
  not to topic/objective/thread registration. The current semantic-only bridge
  removes that failure source while preserving all authorization checks.
- Fresh focused Hermes lifecycle verification passed `14/14` with
  `231 deselected`. It covered capability non-disclosure, extra capability
  rejection, verified message-ID promotion, real Gateway dispatch outcomes,
  exact turn binding, and identical-message FIFO isolation.
- Fresh HCO verification of `mapped legacy topic lazily creates a thread and
  promotes only after durable binding` passed `1/1`. The fixture uses source
  message ID `445` and topic `general chat`.
- The live stable symlink still resolves to immutable release
  `hermes-codex-bridge-1.0.0-53254c3a9d63`; source and installed `plugin.py`
  SHA-256 remain identical at
  `556af1e446ad5d6558fa29c7c2be654c6b5db4e382dfde4ca6b9f937772657ec`.
- HCO PID `35249`, Codex wrapper PID `35255`, native App Server PID `35259`,
  Gateway PID `35335`, and delivery PID `35459` remain present from the 17:06
  activation. No post-activation `Codex bridge request rejected` was found in
  the inspected logs.
- A read-only Zulip query at 17:17 found no boss ID `8` or Jarvis ID `9`
  messages in streams `3`, `4`, or `5` after 17:00. This is honest absence of
  post-deployment acceptance traffic, not a passing or failing live result.
