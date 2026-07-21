# Findings

## 2026-07-19 adaptive repair final-verification diagnostics

- Upgrade diagnostics must discover runtime paths from
  `/Users/hula/.hco/hco.json`. The live context key is configured as
  `/Users/hula/.hco/hco-context.key`; assuming a generic `context.key` name
  creates a false missing-file alarm.
- The authenticated health probe reads the bearer from the configured
  `bridge.tokenPath` and sends it directly over the owner-only Unix socket.
  There is no supported `hco-health-header` file contract, so support scripts
  must not depend on one.
- Gateway attestation schema version 1 contains exactly the release identity,
  PID, hook, and ingress profile fields. Runtime platform/profile state belongs
  to Gateway status evidence, not invented attestation fields.
- Fresh production snapshot validation accepted generation `11` and resolved
  only stream `4 -> ASK` and stream `5 -> stockprofits`, with
  `defaultOwner=HERMES`. The config, bearer, context key, database, snapshot,
  and attestation are all owner-only regular files with mode `0600`.
- A read-only Zulip API query after the 17:06 deployment returned no messages
  authored by authorized boss ID `8` or Jarvis ID `9` in General, ASK, or
  stockprofits. SQLite agrees: the newest objective and turn were created at
  15:00. Therefore the new release currently has neither a live acceptance
  success nor a live regression to classify.

## 2026-07-19 operator binding documentation and transition audit

- The renderer accepts only the six controller outcomes currently reachable
  from binding: `ready`, `started`, `submitting`, `running`,
  `submission_unknown`, and `reconciliation_needed`; unknown statuses remain a
  fixed protocol failure rather than reflected backend text.
- The durable replay boundary is source-message scoped. The same binding fact
  returns a resumable submission only for `execution_status=submitting`,
  matching thread/objective, `submission_state=intent`, `turn_id IS NULL`, and
  no reconciliation flag.
- The controller writes `submission_unknown` immediately before the external
  `turn/start`. The normal acknowledgement path permits the same fenced row to
  become `running` only after the call returns a concrete turn ID. A replay
  after the fence receives no submission and performs no external send.
- ADR 0003, the adaptive-dispatch design/plan, and the support guide now record
  the exact command, route/project/ACL boundary, closed response statuses,
  source-message idempotency, crash fence, and Codex-upgrade regression.

## 2026-07-19 operator binding full-suite fixture finding

- The complete plugin contract suite is green at `245/245`.
- The complete HCO/controller pair found two test-only controller doubles that
  predate the production `resolveObjectiveThread` contract. Both fail at
  `createHcoService()` option validation, before exercising concurrency or
  close-drain behavior. Other HCO and controller tests, including all
  `THREAD_BIND`, known-never-sent replay, and post-fence no-resend cases, pass.
- The minimal correction is to give those two local controller doubles the
  same no-op `resolveObjectiveThread` member as the shared fixture. Production
  validation must remain strict.


## 2026-07-19 operator binding resumption audit

- Repository search found no `THREAD_BIND`, `backend.recover`, or `/codex
  thread bind` implementation in the plugin, HCO service, ACL, or tests. The
  existing controller/store method is therefore still unreachable from a real
  Zulip operator message.
- The inherited replacement implementation is intentionally preserved. This
  follow-up is limited to the missing authenticated command surface and the
  exact durable pre-send replay invariant already approved by the user.
- Existing management commands follow one reusable boundary: strict plugin
  parsing and signed context, independent HCO schema validation, numeric-route
  and durable-project authorization, controller execution, then a plugin
  renderer that accepts only known structured results. `THREAD_BIND` can use
  this path without changing Hermes message routing or exposing authority to
  the model.

## 2026-07-19 proven-missing-thread release-blocking review

- `TurnController.resolveObjectiveThread()` and
  `store.resolveObjectiveThread()` are implemented, but no production service,
  bridge command, API, or CLI invokes them. An uncertain replacement creation
  therefore reaches `manual_thread_binding_required` with no supported operator
  recovery path.
- The smallest compatible production surface is an exact signed Zulip command,
  `/codex thread bind <objectiveId> <threadId>`. It must be available even when
  the topic is `HERMES_ONLY`, authorize against the objective's owning project,
  require maintainer/admin role, and use the source Zulip message identity for
  durable idempotency.
- The current binding transaction consumes the source command and changes the
  pending submission to `intent` before `TurnController` calls `turn/start`.
  A process exit in that gap leaves a known-never-sent submission. Replaying the
  same command currently returns `duplicate: true` with no submission, so the
  objective is permanently stranded.
- Replay is safe only while durable state still proves `submission_state =
  'intent'`, `turn_id IS NULL`, and no external attempt may have started. Once a
  backend call may have begun, replay must not resubmit; uncertain post-send
  state remains a manual-resolution boundary.
- These are release blockers inside the approved adaptive compatibility design.
  They do not justify changing Hermes core, broadening missing-thread matching,
  weakening ACLs, or making replacement creation at-least-once.

## 2026-07-19 adaptive dispatch pre-deployment review

- Hermes currently serializes normal inbound work by session key in
  `gateway/platforms/base.py`: an active session owns one background task and
  later messages are queued or used to interrupt that task rather than starting
  a second model turn for the same session. This supports the plugin's
  `(session_id, semantic_digest)` one-shot handler key; distinct sessions remain
  isolated by the session component of that key.
- `GatewayRunner` constructs one `SessionStore` and passes that same instance to
  every `pre_gateway_dispatch` hook invocation. The plugin's registration-scope
  `runtime_session_store` reference therefore cannot switch between concurrent
  stores in the current supported Hermes runtime. The installer compatibility
  probe remains responsible for failing closed if this lifecycle changes.
- Hermes calls `post_llm_call` only for a non-empty, non-interrupted final
  response. An interrupted or empty turn can retain an unused vault entry until
  expiry, but cleanup is bounded by the 60-second capability lifetime plus
  30-second clock-skew window, 256 total entries, 8 entries per sender, and 1 MiB
  total request bytes. Message-ID binding prevents a retained entry from
  attaching to a later message.
- The staged installer verifier checked that `hco_dispatch` existed but did not
  prove its model-facing schema remained semantic-only, and its required-command
  set omitted the new registration handler. Added RED installer-contract
  assertions, then hardened the staged verifier to require exactly one top-level
  `semantic` property, reject additional properties, require the registration
  command, and validate the installed SOUL's internal-capability instructions.
- Final direct review reconfirmed that the vault transition is atomic under one
  lock: authorization moves the exact turn-bound nonce from pending to a key
  scoped by `(session_id, semantic_digest)`, and handler consumption removes it
  before its first await. Cleanup, revocation, duplicate calls, and concurrent
  races can only remove or reject entries; they cannot authorize a different
  session, message, or semantic payload.
- The signed capability still binds the numeric stream, exact topic, source
  message ID, sender ID, project, topic mode, request byte count, and SHA-256.
  The model-facing schema has no capability or `topicModeAction` field. A
  `HERMES_ONLY` route can return bounded non-execution semantics but cannot
  submit DISPATCH work; the HCO wire receives `topicModeAction: null` only after
  the one-shot internal authorization is consumed.

## 2026-07-19 adaptive dispatch implementation and installer gap

- The plugin repair now keeps the signed HCO capability entirely in plugin
  memory and exposes a model-facing `hco_dispatch` schema containing only
  `semantic`. Session, turn, source message, sender, numeric stream, topic,
  project, digest, ACL, expiry, and replay bindings remain enforced by trusted
  plugin state.
- Focused and complete contracts are GREEN: plugin suite `235 passed`; HCO
  service suite `41 passed`. The mapped legacy-topic regression confirms HCO
  already performs lazy objective/thread creation and changes `AUTO` to
  `CODEX_BOUND` only after a durable thread binding.
- Unmapped streams remain on `hermes-general` for normal conversation. Explicit
  project execution/status commands receive a fixed Chinese registration
  template and cannot infer a project from topic or message text.
- Missing Codex threads are created for genuinely new or durably mapped work,
  but generic or uncertain remote errors are not enough evidence to recreate a
  possibly existing thread.
- The installer still embeds an obsolete `BRIDGE_SOUL` instruction telling the
  model to use a supplied capability. This contradicts the new semantic-only
  tool contract and can reintroduce the production failure after installation;
  installer contract coverage must fail first, then the generated profile text
  must be corrected.

## 2026-07-19 adaptive dispatch RED evidence

- Focused plugin contracts produced `2 failed, 1 passed` before the repair.
  The failures are specific: the registered tool schema still declares
  `required: [capability, semantic]`, and the project channel prompt still
  exposes a signed `<hco_capability>` value.
- Supplying a bogus model-authored capability as an extra field is already
  rejected. The repair therefore must remove the field from the model contract
  while preserving fail-closed behavior, rather than weakening token checks.

## 2026-07-19 12:21 legacy-topic dispatch rejection

- Zulip message `445` was an authorized boss ID `8` request in numeric stream
  `4` (`ASK项目`), topic `general chat`. The route snapshot correctly resolved
  stream `4` to project `ASK`; the Hermes session origin also retained message
  ID `445`, profile `codex-bridge`, and the correct stream/topic identity.
- The model called `hco_dispatch`, but its copied 515-character capability was
  not the issued opaque token. The base64url payload becomes malformed in the
  `messageSha256` field and cannot be decoded as canonical JSON. The plugin
  therefore rejected the call in `pre_tool_call` before HCO submission, as its
  fail-closed authorization contract requires.
- HCO contains no inbound intent, objective, submission, or outbox row for
  source message `445`. This rules out a missing Codex thread, objective, or
  topic ledger row as the immediate rejection point.
- The model also emitted `topicModeAction: null`. That did not cause this
  particular rejection because the signed route context carried topic mode
  `AUTO`, but it demonstrates that lazy topic initialization currently depends
  on a model-authored field and is therefore nondeterministic.
- The first provider attempt hit `rate_limit_exceeded`; the successful retry
  returned the tool call about 57 seconds after ingress. The capability was
  still within the implemented 60-second lifetime plus 30-second skew window,
  so expiry was not the direct cause. Long provider retries nevertheless make
  a short model-carried credential an unnecessary reliability risk.
- The durable repair boundary is to keep the signed capability inside the
  plugin and bind it to the trusted session/turn internally. The model should
  supply only the semantic decision. Numeric stream routing, sender ACLs,
  message ID binding, replay protection, and project/cwd authority must remain
  fail-closed.

## 2026-07-19 08:04 post-fix audit

- Zulip stream discovery is required before interpreting an empty stream
  query. The live ASK stream's exact name is `ASK项目` and its ID is `4`;
  querying a guessed name such as `ASK` returns no usable acceptance evidence.
- The live target mapping remains: stream `3` = `general`, stream `4` =
  `ASK项目`, and stream `5` = `量化交易stockProfits`.

## 2026-07-18 Jarvis context repair continuation

- Production `iotwq` is not a canonical built-in. Its `providers.iotwq: {}` is
  an endpoint-free compatibility placeholder, while the effective endpoint and
  `HERMES_API_KEY_GPT_BACKUP` selector live in legacy `custom_providers`. The
  minimal isolated closure should omit the empty keyed placeholder, preserve a
  sanitized copy of the effective legacy declaration, copy only its selected
  dotenv value, and resolve through Hermes' real runtime loader.
- The user's latest Zulip transcript is consistent with the first context
  repair not being deployed: the live `codex-bridge/config.yaml` still lacks a
  `model` block and the profile has no `.env`, so the normal Hermes loop reaches
  provider resolution and fails before a model call.
- Hermes `_get_named_custom_provider()` defers immediately to a canonical
  built-in provider when `resolve_provider(requested)` returns the exact raw
  name. Therefore same-named declarations under both `providers:` and legacy
  `custom_providers:` are ignored for canonical `openrouter` at runtime.
- The installer currently keeps the first matching keyed declaration for a
  canonical built-in. That is not the minimal inference closure and diverges
  from Hermes runtime precedence. The pending regression requires both shadow
  declarations to be absent while runtime resolution still selects the global
  authenticated built-in.
- The installer effective-loader probe must expose the same trusted
  Gateway/session-store interfaces now required by the plugin lifecycle. With
  fixed equivalent interfaces, the full transaction suite passes `32/32`;
  this confirms the probe failure was fixture drift rather than a production
  route or Provider defect.

## 2026-07-18 final production acceptance

- The installed Jarvis release is
  `/Users/hula/.hermes/plugin-releases/hermes-codex-bridge-1.0.0-1d1f6e78e55b`.
  HCO PID `72242` owns the canonical SQLite database plus WAL/SHM sidecars at
  the same inodes exposed by `/Users/hula/.hco/hco.sqlite3{,-wal,-shm}`. All
  three paths are owner-only, and an independent SQLite reader can observe the
  completed smoke, closing the prior split-sidecar failure mode.
- A new strict-whitelist request was submitted through the installed Hermes
  plugin for stream `5`, topic `框架安装`, without a Hermes model call. It
  created objective `objective-34196845-262f-4757-b3a7-4d767aff1ec6`, App
  Server thread `019f72e6-d5d5-74c0-ab00-676bad353a72`, and turn
  `019f72e6-dbd6-7740-8336-16ae88f5aa77`.
- The objective, execution, and submission all reached `completed`; terminal
  status is `completed`, `reconciliation_required=0`, and
  `thread_start_uncertain=0`. The persisted output is exactly scoped to
  `cwd=/Users/hula/Projects/stockprofits` with marker
  `HCO_STOCKPROFITS_SMOKE_1784339158080`; it contains no ASK path.
- Delivery outbox record `delivery-fc971dae-b6b9-4642-bccb-407d08adfddb`
  completed in one acknowledged attempt and stored Zulip message ID `345`.
  An independent Zulip API read confirmed message `345` from Jarvis PM in
  stream `量化交易stockProfits`, topic `框架安装`, with the same cwd and marker.
  This verifies the complete route -> App Server -> persistence -> delivery
  chain rather than only request acceptance.
- Fresh post-install release gates passed without relying on earlier runs:
  installer suite `30/30`, Node suite `237/237`, Hermes plugin contract suite
  `210/210`, aggregate `npm run verify`, installer shell parsing, and diff
  whitespace validation.

## 2026-07-18 release-gate checkpoint

- The complete Hermes plugin contract currently passes 210 tests under the
  same Python environment used by Jarvis:
  `/Users/hula/Projects/hermesAgent/.venv/bin/python3`.
- The repository's supported aggregate verification command is
  `npm run verify`; it passed every declared stage. The absent `npm test`
  script remains a documentation/history note rather than a product failure.
- The installer shell parses cleanly and the accumulated Option C diff has no
  whitespace errors. Dual-model review and a fresh live installation remain
  required before the release can be committed.

## 2026-07-18 dual-model review adjudication

- Claude's reconnect-delay finding is unreachable. The delay counter is reset
  to zero immediately after a candidate finishes initialization and becomes
  the installed backend; a later terminal event therefore schedules the first
  retry at one second.
- Claude's migration-rollback/PID finding is unreachable. The rollback path
  stops and drains every retained HCO/delivery PID, and raises on any drain
  failure, before invoking release migration rollback or restoring snapshots.
- Gemini's replacement-PID finding assumed rollback retained only pre-install
  PIDs. In fact rollback queries both current services first, retains their
  replacement PIDs, then bootouts, waits for launchd unload, drains each PID,
  and only afterward reaches migration and snapshot restoration.
- Gemini CLI's first broad review repeatedly requested a nonexistent internal
  shell tool. Its tool-free focused review completed, while a follow-up request
  to retract or confirm the disproved premise failed twice at the local proxy.
  This is a review-tool availability issue, not release evidence or a product
  failure.

## Final boundary audit (2026-07-17)

- The plugin already had a regression for unknown future actions, but newly
  added unknown-status cases demonstrated that `dispatch`, `objective.cancel`,
  and `interaction.answer` reflected unrecognized status strings into Zulip.
  The renderer must validate action-specific status enums before formatting.
- RPC requests already had a fixed 30-second timeout, but the public App Server
  client lifecycle did not expose an initialization-specific timeout for a fast,
  deterministic contract test. A bounded constructor option can preserve the
  30-second production default while proving that an unresponsive handshake
  closes the client and cannot be retried.

## Live App Server completion incident (2026-07-17)

- Fresh objective `objective-2d67f06d-770b-465f-bfde-ccdb27e9fc2e` was accepted for
  `stockprofits`; App Server returned thread
  `019f7038-f4e7-72b1-a922-a85aad34ef8b` and turn
  `019f7039-0e0c-7b51-a994-8a28d52f0e67`.
- The submission became `reconciliation_needed` about 24 seconds after creation,
  with `reconciliation_required=1`, while the objective itself remained `created`.
- There are no `turn_audit_facts`, `turn_outputs`, or Zulip outbox rows for this
  objective. Its event journal contains only `objective.created` and
  `topic.mode_promoted`; no App Server completion event was ingested.
- This evidence places the failure before completion-event persistence. It is not
  yet evidence of an invalid `turn/completed` payload. The next investigation
  boundary is App Server connection/notification ownership versus the recovery
  timer that marked the running submission lost.
- Process start-time evidence ruled out a connection restart: HCO PID `76494`
  and its App Server child remained continuously alive from 21:09 through the
  incident. A separate authenticated `thread/read` recovered the completed
  turn from Codex `0.142.3`, with cwd
  `/Users/hula/Projects/stockprofits` and the expected smoke output.
- Root cause: current App Server `agentMessage` items contain `id`, `type`,
  `text`, and `phase`, but omit per-item `status`. HCO's
  `isCompletedAgentMessage()` requires `status === "completed"`, so it rejects
  both the real final answer and commentary, then marks the otherwise completed
  turn for reconciliation. This exactly explains the 24-second state change and
  lack of output/outbox rows.
- The Codex manual helper returned HTTP 403 while checking current public docs.
  The installed Codex protocol schema generator and the live `thread/read`
  response are the authoritative compatibility evidence for this installation.
- Focused dual-model review agreed that accepting an omitted item status matches
  the current App Server contract. Gemini returned `NO_ACTIONABLE_FINDINGS`.
  Claude identified one reachable test gap: the compatibility change did not
  explicitly lock the rule that a defined non-`completed` item status remains
  rejected. The production filter already enforced that rule, so only a
  negative regression was added for `null`, `inProgress`, `failed`, and
  `cancelled`; the focused controller/E2E run passed 50/50.
- A new, non-reused objective
  `objective-a8b267af-2181-44cc-a4da-14b71e148d13` completed through the live
  App Server after the fix. HCO bound thread
  `019f7053-b556-7212-8289-36820d31eca5` and turn
  `019f7053-d81a-7d80-a767-1cc03723f9c8`, persisted terminal and submission
  status `completed`, set `reconciliation_required=0`, and stored the final
  turn output.
- The live output was exactly scoped to stockprofits and reported
  `cwd=/Users/hula/Projects/stockprofits` plus
  `HCO_APP_SERVER_SMOKE_OK`. It contained no ASK cwd or project selection.
- Delivery consumed the resulting outbox record once (`attempt_count=1`),
  marked it `delivered`, and stored acknowledged Zulip message ID `343`.
  A separate Zulip API read confirmed message `343` in stream
  `量化交易stockProfits`, topic `框架安装`, with the same cwd and success marker.
  This closes the original failure at the App Server notification-to-outbox
  boundary, not merely at the HCO HTTP acceptance boundary.

## Final live runtime checkpoint (2026-07-17)

- At the verification checkpoint, HCO PID `37337` owned App Server processes
  `37340` and `37341`; Gateway PID `37484` and delivery PID `37603` were alive.
  These are observation-time process identifiers, not configuration values.
- Authenticated HCO health returned `status=ok` and
  `appServer.available=true`. The stable plugin symlink and Gateway attestation
  resolved to immutable release
  `hermes-codex-bridge-1.0.0-58bb1ceea2a8`.
- The attestation named the live Gateway PID, hook `pre_gateway_dispatch`, and
  ingress profile `zulip-ingress`. Although `launchctl print` could not resolve
  the label on this host, `launchctl list`, `ps`, Gateway logs, and the signed
  attestation agreed on the same running process and release.
- Automatic snapshot renewal advanced its generation from 2 to 3 with a
  60-second validity interval. The trusted document still contained exactly
  stream `4 -> ASK` and stream `5 -> stockprofits`, preserving canonical cwd
  separation between `/Users/hula/workspace/ASK` and
  `/Users/hula/Projects/stockprofits`.

## Retried live deployment checkpoint

- The cache-safe legacy-release migration no longer blocks the real install.
  The transactional installer completed with exit code zero and committed
  plugin version `1.0.0` after the live Codex App Server readiness gate.
- This proves activation-time readiness only. Completion still requires fresh
  evidence that the running launchd service owns an App Server child, Gateway
  attestation resolves to the stable installed release, the signed snapshot
  continues renewing with only the ASK and stockprofits mappings, and a real
  stream-5 dispatch no longer produces `backend_unavailable`.
- The running HCO now owns `codex app-server --stdio`; an authenticated health
  request returned the exact ready contract. The stable plugin link, Gateway
  attestation, and delivery executable all resolve to
  `hermes-codex-bridge-1.0.0-58bb1ceea2a8`.
- Gateway runtime evidence is internally consistent at PID `76801`, includes
  `zulip-ingress`, and reports Zulip connected. There is exactly one
  discoverable HCO manifest under `~/.hermes/plugins`; immutable historical
  releases are outside the discovery tree.
- A read-only Zulip query recovered the exact incident. Stream `5` is named
  `量化交易stockProfits`; boss message `341` requested SpecCompass in topic
  `框架安装`, and Jarvis reply `342` correctly selected project
  `stockprofits` but returned `backend_unavailable`. This separates the fixed
  routing decision from the launchd/App Server availability defect.
- A fresh smoke request must use `OBJECTIVE_NEW`; an unqualified `RUN` would
  continue the topic's existing failed objective and would not independently
  prove new-objective startup after remediation.

## Zulip ingress YAML migration

- Root cause: `ingress_config(installed_plugin_toolsets)` has no root-config or existing-ingress input.
- Required precedence: root `platforms.zulip` supplies migration defaults; existing ingress values win; installer forces `enabled: true`.
- Scope boundary: merge only the Zulip adapter mapping. Project cwd, prompt, memory, model, Task Guard, plugins, skills, and MCP settings must never flow into `zulip-ingress`.
- Nested adapter mappings such as `extra` need recursive merging so a reinstall override does not erase unrelated migrated keys.
- The first RED run failed during Hermes compatibility preflight because
  `home_channel` was a scalar. `HomeChannel.from_dict()` requires `platform`,
  `chat_id`, and optionally `name`/`thread_id`; after correcting the fixture,
  the installer reached the intended missing-migration assertion.

## Claude remediation review adjudication

- The reported cross-version rollback failure is not reachable: releases are
  content-addressed, `promote_release()` never deletes the prior release, and
  rollback removes only a transaction-created new destination. Keeping
  `resolve(strict=True)` is required to prove that the live process loaded an
  existing release rather than merely echoing an expected path string.
- A real `GatewayRunner._handle_message` test already proves invalid route
  authority makes zero LLM calls, zero HCO submissions, and never enters the
  ordinary Hermes agent path.
- Root-to-ingress `platforms.zulip` inheritance and recursive precedence are
  explicit review requirements, not unintended leakage. The merge is scoped
  to that adapter mapping; project/model/memory/Task Guard/plugin/skill/MCP
  fields remain excluded.
- The route reader's strictly increasing stream-ID invariant was not covered
  directly. Added invalid snapshot fixtures for both out-of-order and duplicate
  stream IDs.
- Backward wall-clock movement is already covered by the HCO renewal test;
  scheduling uses monotonic elapsed time while each newly published snapshot
  correctly receives a fresh wall-clock validity interval.

## Final dual-model review

- Gemini found one valid first-install dotenv precedence bug. Migrated root
  values must be defaults, not overrides: `root < existing ingress <
  installer-owned overrides`. A red fixture reproduced it, the merge order was
  corrected, and all 28 installer scenarios passed.
- Gemini session `3a0c0b52-6097-4ac7-b894-574fd7959f06` reviewed the fixed
  tracked diff and returned `NO_ACTIONABLE_FINDINGS`.
- Claude session `d5bc6c5c-78bf-4e09-b124-81e985d3ab42` reported five possible
  findings. Source inspection rejected them: schema v1 already requires and
  publishes `defaultOwner=HERMES`; the reader already enforces strictly
  increasing stream IDs; and the bounded Gateway attestation timeout is an
  intentional fail-closed deployment policy.

## First live deployment failure

- The real installer passed staged/live Hermes and Codex compatibility probes,
  then failed during activation and entered rollback.
- Rollback reported a byte-content mismatch for
  `/Users/hula/.hco/zulip-routes-option-c.json`.
- Post-failure state shows the old plugin symlink and absent ingress profile were
  restored, Gateway is running with a new PID, and HCO/Delivery are running.
- The route snapshot has a new `generatedAtMs`/`validUntilMs`, proving HCO
  renewed this runtime artifact while rollback was verifying it. Static
  byte-for-byte rollback verification is therefore racing the legitimate HCO
  snapshot publisher.
- Hermes core source confirms the canonical Zulip credential names are
  `ZULIP_SITE_URL`, `ZULIP_BOT_EMAIL`, and `ZULIP_API_KEY`, which already match
  the installer. The Gateway warning's abbreviated wording is not evidence of
  a `ZULIP_URL` naming mismatch; the remaining question is whether the live
  Gateway loads the `zulip-ingress` profile dotenv at platform startup.

## Hermes secondary-profile secret propagation

- The multiplexer does load `zulip-ingress/.env`, but it loads those bindings
  into `agent.secret_scope` rather than process-global `os.environ`.
- Before constructing a secondary-profile adapter, Hermes intentionally removes
  all process-global `ZULIP_*` variables via
  `_without_secondary_profile_platform_env()` to prevent cross-profile leaks.
- The current Zulip adapter and `check_zulip_requirements()` still read
  credentials and behavior switches directly from `os.getenv()`. Consequently
  the real multiplexer path cannot see the ingress API key or dotenv-only
  settings even though the installer compatibility probe can.
- The existing probe is a false positive because it calls
  `load_hermes_dotenv(hermes_home=ingress_home)` directly, populating
  `os.environ` instead of exercising `_profile_runtime_scope()`.
- Any bridge-side compatibility layer must remain profile-local, avoid writing
  secrets to global environment state, cover all Zulip settings used during
  adapter construction, and fail closed if the Hermes adapter contract changes.
- The bridge plugin can install that compatibility before adapter startup because
  Hermes discovers Python plugins before creating secondary-profile adapters;
  `GatewayRunner._create_adapter()` imports the Zulip module symbols lazily.
- The compatibility wrapper preserves explicit `PlatformConfig`/YAML values and
  resolves only missing or dotenv-only values through `get_secret()`. In a
  single-profile Gateway, `get_secret()` retains the legacy `os.environ`
  fallback; in the ingress runtime scope, the profile dotenv is authoritative.
- The corrected installer probe now fails if credentials are visible only after
  process-global dotenv injection, if conflicting root values leak into the
  ingress adapter, or if profile scope mutates the surrounding environment.

## Zulip YAML behavior precedence review

- Hermes' Zulip adapter initializes behavior fields from `os.environ` even
  when the profile's `PlatformConfig.extra` contains explicit operator values.
  The compatibility wrapper must therefore reapply all supported YAML behavior
  keys after the legacy constructor returns.
- Presence, not truthiness, defines an explicit YAML override. In particular,
  `catchup_enabled: false`, `require_mention: false`, and
  `allow_insecure: false` must not be replaced by truthy scoped dotenv values.
- The supported YAML behavior surface is `cert_bundle`, `allow_insecure`,
  `require_mention`, `free_response_streams`, `context_depth`,
  `catchup_enabled`, and `catchup_max_messages`. Missing keys retain legacy
  scoped-dotenv fallback behavior.
- The installer remains the authority for containment and always writes
  `platforms.zulip.extra.context_depth: 0`; migrated root or pre-existing
  ingress values cannot raise the ingress profile's conversation depth.
- Gemini's dotenv escaping concern does not reproduce with the actual
  `python-dotenv` parser used by Hermes. Single quotes, backslashes, spaces, and
  embedded newlines survive the installer encoder/parser round trip.
- A schema-v1 route snapshot with `defaultOwner=PROJECT` is invalid input, not a
  missing routing branch. `route_snapshot.py` rejects it before dispatch.

## Duplicate Zulip poller activation failure

- The second real install passed staged and activated compatibility probes but
  failed the live `served_profiles` attestation and rolled back cleanly.
- Hermes logs identify the direct cause without exposing credentials:
  `ask-jarvis-pm` and `zulip-ingress` configured the same Zulip credential, so
  Hermes refused the later duplicate. Profile name ordering lets the unrelated
  profile claim the poller before the installer-owned ingress profile.
- The old runtime already excluded `ask-jarvis-pm` for the same duplicate with
  `default`; disabling only that profile's Zulip adapter therefore does not
  remove a previously served capability.
- The installer must discover every non-owned named profile whose enabled Zulip
  adapter resolves to the ingress API key, snapshot its config path, set only
  `platforms.zulip.enabled` to `false`, and restore the original bytes on any
  failed transaction. Credentials may be compared in memory but never logged.
- The effective external-profile key precedence is explicit YAML `token`, then
  explicit YAML `api_key`, then the profile-local `.env` `ZULIP_API_KEY`.
- The transaction now stages the modified external profile for Hermes preflight,
  atomically activates its config, and includes that dynamic path in rollback.
  It neither edits external `.env` files nor removes external profiles.

## Post-remediation dual-review adjudication

- Gemini's claimed staging ENOENT is false: `atomic_write()` creates parent
  directories recursively before opening its temporary file; all 28 installer
  cases also exercise this staging path.
- Gemini's claimed missing-`.env` crash is false: `validate_mutable_path()`
  explicitly returns on `FileNotFoundError`, and layout reads the file only when
  it exists.
- The attestation PID-reuse scenario is not reachable as described: activation
  deletes the old attestation before `kickstart -k`, requires a PID different
  from the captured old PID, then validates runtime-state PID, attestation PID,
  loaded release path, plugin version, hook, and ingress profile after restart.
- The alleged plugin symlink pre-load TOCTOU reverses the real ordering. The new
  Gateway loads the plugin and writes attestation before the installer validates
  the resolved loaded release; validation is repeated after a stability window.
- Route snapshot `defaultOwner` is already semantically constrained to exactly
  `HERMES`, and the existing `bad-integrity` fixture is valid JSON whose signed
  payload was changed without recomputing the digest.
- The backward-wall-clock test intentionally changes `Date.now()` while
  production renewal uses `performance.now()`; observing renewal under that
  disturbance directly proves the monotonic scheduling property.
- The accepted Option C design explicitly treats a missing/throwing hook as
  containment in project-neutral ingress, not as the fixed-rejection guarantee
  available once the hook executes. Changing this contract is not required for
  the reported routing defect.
- Enabled external profiles with no local YAML or dotenv Zulip key cannot
  inherit the root key. A fresh probe using Hermes'
  `_without_secondary_profile_platform_env()` and `_profile_runtime_scope()`
  showed the root `ZULIP_*` values absent and scoped `get_secret()` returning its
  empty default. The plugin wrapper delegates missing values to this exact
  function, so such a profile is a pre-existing invalid poller rather than a
  same-credential duplicate.
- Hermes does not interpolate a YAML token such as `${ZULIP_API_KEY}`. The real
  `load_gateway_config()` preserved that text literally under the same profile
  scope. It therefore cannot resolve to or contend for the ingress credential;
  treating it as a matching key in the installer would invent semantics Hermes
  itself does not have.
- The narrow policy remains correct: disable only enabled external Zulip
  profiles whose effective local credential (YAML `token`, YAML `api_key`, then
  profile `.env`) exactly matches the ingress credential. Broadly disabling
  every external Zulip adapter would break independent bots and exceed the
  accepted remediation scope.
- Gemini's post-remediation session
  `18ff4740-2a4e-465a-abd8-22589a590f85` raised missing `PlatformConfig`
  attributes and `extra: null`. Both are outside the Hermes host contract:
  the dataclass always defines `token`, `api_key`, and mapping-default `extra`;
  Hermes' native Zulip code accesses those fields directly; and the real
  loader rejects `extra: null` before adapter startup. A direct installed-code
  probe confirmed these facts, so defensive plugin fallbacks would create a
  divergent contract rather than fix a reachable regression.
- Claude's tools-disabled post-remediation session
  `77ac249d-62c5-4f38-9a95-f9458e87e444` claimed the native adapter constructor
  could create a client before profile-scoped fields are applied. The installed
  constructor does not connect or validate: it initializes state and explicitly
  sets `_client = None`. `zulip.Client` construction occurs only in `connect()`
  and send helpers after the subclass overrides the fields. Rejected as
  non-actionable.

## Live Jarvis deployment evidence

- The transaction committed installed release
  `hermes-codex-bridge-1.0.0-7d9368baa347`; the stable plugin link and live
  process attestation both resolve to that release.
- Gateway PID `17655`, HCO PID `17315`, and delivery PID `18003` are running.
  Gateway state reports Zulip and Feishu connected and includes the project-
  neutral `zulip-ingress` profile among the served profiles.
- Live attestation records the real Gateway PID, plugin version `1.0.0`,
  `pre_gateway_dispatch`, and `zulip-ingress`. A temporary-home probe loaded the
  exact same installed release without modifying this online attestation.
- The live snapshot has integrity algorithm `sha256`, trusted
  `defaultOwner=HERMES`, stream `4 -> ASK`, and stream `5 -> stockprofits`.
  Its `generatedAtMs` advanced across multiple TTL windows, proving the running
  HCO publisher is renewing it rather than relying on installer output.
- A real Zulip-shaped event for stream `5` and topic `框架安装` was rewritten to
  `codex-bridge`; the decoded signed capability payload selected only
  `stockprofits`. Production HCO config independently canonicalized that project
  to `/Users/hula/Projects/stockprofits`, while ASK remained
  `/Users/hula/workspace/ASK`.
- `zulip-ingress` is deliberately project-neutral: no cwd, project model,
  memory projection, or Task Guard binding is migrated into it, and Zulip
  context depth remains zero. The former same-credential `ask-jarvis-pm` poller
  is disabled without changing its `.env` bytes or unrelated profile settings.
- ASK and stockprofits are independent routing domains, not aliases. The live
  numeric mapping is `4 -> ASK -> /Users/hula/workspace/ASK` and
  `5 -> stockprofits -> /Users/hula/Projects/stockprofits`; any future ambiguity
  in business ownership must fail to operator confirmation rather than infer a
  project from names, topic text, cwd, memory, or model output.

## Live App Server availability incident

- The failed Zulip objective `objective-24cf35e8-0452-440f-99dc-38612b0c63ec`
  was authoritatively routed to `projectId=stockprofits`; no ASK route or cwd was
  selected. It remained `backend_unavailable`, never started an App Server
  objective, and was not promoted to the topic's current objective.
- The installed HCO LaunchAgent exported only `HCO_CONFIG_PATH`. launchd's
  default PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, while the configured Codex
  executable is `/Users/hula/.npm-global/bin/codex` with `#!/usr/bin/env node`.
  The equivalent environment fails with `env: node: No such file or directory`,
  followed by App Server transport EOF.
- The installer canary inherited an interactive shell PATH, so it could pass
  while the eventual launchd-owned process failed. The activation gate checked
  only HCO's bridge socket/protocol and did not assert App Server availability.
- HCO currently initializes one client once. Initialization or later terminal
  failure leaves a permanently disabled execution gate; no bounded reconnect
  changes the gate back to healthy.
- The bridge plugin serializes internal structured dispatch outcomes directly,
  which is why Zulip displayed a raw JSON object instead of explaining that the
  project was identified but execution never started.
- Trusted projectId/cwd reporting must be deterministic and derive from the
  signed route snapshot plus HCO project registry. The Hermes model must never
  infer either value and must not suppress this non-secret operational status.
- Runtime race audit found one concrete close-ownership gap: when shutdown
  overlaps a retry candidate's pending `initialize()`, runtime shutdown closes
  the active candidate and the connect catch path can close it again. Candidate
  closure needs one shared idempotent owner rather than relying on client close
  implementations to tolerate duplicate calls.
- Gemini's fresh review of the complete availability-remediation diff found no
  actionable defect. Claude's first invocation produced no final content and is
  therefore invalid evidence rather than approval; a constrained structured
  retry remains pending.
- The live pre-install service state independently confirms the environmental
  root cause: the HCO LaunchAgent is healthy as a Node process under the system
  default PATH, but no App Server child exists. This is precisely the partial
  health state now covered by the authenticated health endpoint and installer
  activation gate.
- Claude's structured follow-up reported that `ROUTE SHOW` could dereference a
  missing project after a registry removal. The persisted override can survive,
  but the service constructs every resolver with the current project registry;
  `createRouteResolver()` rejects an override whose project is absent with
  `ROUTE_CONFIG_INVALID` before `routeCommand()` can reach the cwd lookup. The
  service therefore fails closed and cannot publish or execute the stale route.
- Claude's HOME fallback suggestion is also non-actionable. Installer `main()`
  validates `HOME` against the invoking account's passwd home before any plist
  helper runs. Replacing that invariant with `expanduser("~")` would weaken the
  trusted service-environment contract rather than cover a reachable failure.

## Gateway attestation mismatch after availability remediation

- Hermes scans every first-level directory and directory symlink below
  `HERMES_HOME/plugins` that contains `plugin.yaml`.
- The stable `hermes-codex-bridge` symlink and every immutable
  `hermes-codex-bridge-*` release all declare the same manifest name/key.
  Discovery iterates sorted paths and later manifests replace earlier winners,
  so a historical release directory overrides the stable symlink.
- A read-only probe of the live directory reproduced three bridge candidates;
  the winner came from a version directory rather than from stable-link
  authority. This explains why the restarted Gateway wrote a valid attestation
  for a release other than the installer's candidate.
- The robust invariant is one discoverable HCO manifest: keep only the stable
  symlink under `plugins/`, place immutable content-addressed releases in a
  separate owner-only directory, and transactionally migrate legacy releases
  with exact rollback.
- Migration cleanup is part of the installer transaction, not an intermediate
  HCO-readiness step. Its ledger must remain live through App Server health,
  Gateway attestation and stability, and delivery service readiness. Otherwise
  a late activation failure restores a dangling stable link and masks the
  original error with rollback failure.

## Python runtime caches in legacy releases

- Both live historical bridge releases contain user-owned `__pycache__`
  directories created after installation. Their normal Python modes are
  `0755` for directories and `0600` for files, while semantic release content
  remains locked to `0700` directories and `0600` files.
- The first migration implementation excluded `__pycache__` and `*.pyc` from
  `release_manifest()` but included them in `validate_release_manifest()`.
  That inconsistent policy made the synthetic migration tests pass while the
  real Jarvis migration would fail before any service mutation.
- Runtime caches are non-semantic and may differ between otherwise identical
  releases, so they remain outside the content-addressed digest and manifest.
  They are not skipped: every cache path is inspected with `lstat()`, must be
  owned by the installing user, must be a regular file or directory, and must
  not be writable by group or other users. Cache symlinks and special files
  fail closed.
- Cache directories move with their containing release. This preserves bytes
  and modes on rollback without a separate cleanup ledger. When identical
  semantic releases collide, cache differences do not prevent deduplication;
  the destination cache must independently pass the same safety checks.
- `.DS_Store` and other unrelated files are not runtime caches. They remain
  semantic release paths and therefore cause digest/name mismatch unless they
  were part of the originally content-addressed release. This is intentional
  contamination detection.
- Release hashing now streams files in bounded chunks rather than using
  `read_bytes()`, preventing file size from becoming an equivalent peak-memory
  allocation during install or migration.
- Claude and Gemini initially reported that empty semantic directories are not
  included in the historical file-only release digest. After receiving the
  complete collision paths, both reclassified the finding as non-actionable:
  `plan_release_migrations()`, `create_release()`, and `promote_release()` all
  compare the full directory set before reusing a same-named destination. A
  structural collision therefore fails closed rather than silently deduping.
  Changing the digest would invalidate historical release names without fixing
  a reachable integrity bypass.

## Final result-rendering review

- Claude's review of the complete rendering change returned
  `NO_ACTIONABLE_FINDINGS`. Gemini session
  `eb516ed2-9f6e-4b43-9811-ad64fd37a78a` reported five candidates.
- `route.set` and `topic.set` do not lose documented response fields: the live
  service contracts do not return the extra route/session fields assumed by
  the review. The renderer preserves every field the corresponding handlers
  actually emit.
- Legacy `accepted` handling intentionally recognizes only the bounded v1
  compatibility response. Broadly rendering arbitrary legacy documents would
  weaken the fail-closed protocol boundary.
- Schema versions other than 1 are intentionally unsupported and must not be
  guessed or partially rendered. A future version requires an explicit parser
  and contract tests.
- The review's project-routing concern reverses the implementation: a trusted
  project route selects the isolated `codex-bridge` profile, while trusted
  unmatched streams select `hermes-general`.
- One finding was valid: the old fallback serialized an unknown schema-v1
  action and could reflect arbitrary future backend fields into Zulip. The
  renderer now returns a constant upgrade/compatibility notice for unknown
  actions, without exposing the action name or any unrecognized value.
- One 10 ms Node timeout test can race its own late `assert.rejects` attachment
  when unrelated pytest work runs concurrently. The focused test and complete
  Node suite pass when run normally. This is a test-harness scheduling issue,
  not evidence of an HCO runtime failure, and no unrelated timing constants
  were changed during this remediation.

## Final status-boundary adjudication

- The initial review was too narrow: the initialize request already had a
  30-second RPC timeout, but that timer ended as soon as valid metadata arrived.
  The following `initialized` notification had no deadline and could wait
  forever if the child stdin accepted the frame but never emitted `drain`.
- This post-response backpressure path is production-reachable and can block
  both initial runtime creation and shutdown. A RED transport test reproduced
  it with a valid response followed by permanently non-draining stdin.
- `CodexAppServerClient` now applies one explicit 30-second default deadline to
  the complete handshake. The deadline closes the transport, releases the
  pending notification send, maps the failure to
  `APP_SERVER_CLIENT_INITIALIZE_FAILED`, and prevents retry on the closed client.
- An arbitrary injected test client may still return a never-settling
  `initialize()` promise. That is outside the production factory contract; the
  concrete production client now owns and bounds both handshake phases.
- Claude's status-reflection finding is valid. The result renderer accepted a
  recognized action but reflected any unknown `status` for `dispatch`,
  `objective.cancel`, and `interaction.answer`. `objective.status` also
  reflected an unknown nested `executionStatus`.
- The renderer now accepts only statuses produced by the corresponding HCO
  controller/service contract. Unknown values return the same fixed
  compatibility notice as an unknown action and expose no response value.

## Final installer rollback adjudication

- The App Server runtime initialization deadline is 30 seconds, but the
  installer originally allowed only 8 seconds for newly activated HCO health.
  A healthy cold start could therefore be mistaken for activation failure.
  App Server readiness now has a separate 40-second installation window;
  ordinary bridge readiness remains 8 seconds.
- `rollback_release_migrations()` previously stopped at its first exception,
  and `rollback()` called it before restoring configuration snapshots. A
  damaged release carrier could therefore prevent unrelated configuration,
  plist, and stable-link restoration.
- Release migration rollback now attempts every migration and aggregates
  failures. The outer rollback independently attempts and verifies every
  non-socket snapshot, preserving the original migration error in a bounded
  diagnostic.
- Prior services are restarted only after restoration is completely verified.
  If any restore or verification step fails, HCO, delivery, and a mutated
  Gateway are stopped so they cannot run against mixed transaction state.
- The cache security regression initially used four-component fixture versions,
  which do not match the managed release pattern and therefore did not exercise
  validation. Valid three-component fixtures exposed that nested directories
  under `__pycache__` were accepted. Cache directories are now restricted to
  the `__pycache__` node itself; ordinary `.pyc` files remain accepted under
  owner-only, non-shared-writable controls.

## SQLite runtime sidecar split after current release activation

- The current-release stockprofits smoke was accepted by the installed plugin
  and HCO as `objective-56b35d0c-ac86-45cd-9a9b-6ba48a24f856`, but neither the
  objective nor its replay nonce was visible to a fresh reader of
  `/Users/hula/.hco/hco.sqlite3`.
- HCO PID `69585` holds the canonical database inode `51682961` and sidecar
  inodes `52666426` (`-wal`) and `52666427` (`-shm`). The sidecar pathnames were
  initially absent, proving those descriptors referred to unlinked files.
- A later independent SQLite access recreated the pathnames with different
  inodes `52677093` and `52677094`. HCO still holds the older inodes, so the
  running writer and new readers now have separate WAL/SHM worlds. An accepted
  response is therefore not persistence evidence, and restarting HCO before
  repair can discard the accepted smoke.
- The successful installer path does not directly call `restore()`. The
  remaining investigation is the lifecycle boundary around
  `initial_bridge_gate()` and service activation: runtime snapshots include the
  database, WAL, SHM, socket, and route snapshot, and the temporary bridge gate
  restores them after its child exits when the installer believes no prior HCO
  is running.

## SQLite exit-timeout regression fixture

- The first run after adding scenario 30 failed in the initial fresh-install
  case, before reaching the intended timeout behavior. The fake HCO received an
  explicitly empty `HCO_TEST_SQLITE_STOP_DELAY` and attempted `float("")`, so
  the fixture process exited before creating its socket.
- This is test-environment cross-contamination, not an installer regression.
  The fixture now treats an unset or empty delay as its existing 0.8-second
  default. Scenario 30 must still fail for the intended missing fail-closed
  installer behavior before production code is changed.
- After the fixture correction, scenarios 1 through 29 passed and scenario 30
  failed for the intended reason: the installer ignored the 0.2-second test
  process-exit deadline, waited for the two-second HCO shutdown, and committed
  instead of failing closed. This is the required RED evidence.
- The transaction now retains every captured HCO/delivery PID until
  `os.kill(pid, 0)` proves it absent. A later launchd query cannot erase that
  obligation. Rollback checks the retained set before restoring any release
  migration or filesystem snapshot, and leaves affected services unloaded if
  ownership remains uncertain. The installer suite passed 30/30 after this
  change.

## Final Gemini residual-finding adjudication

- The SQLite WAL concern is not actionable. The successful activation path
  never calls `restore()`. A first-install temporary HCO restores its captured
  database/WAL/SHM state only after that child has exited; transactional
  rollback restores snapshots only after every retained HCO/delivery PID has
  been proven absent. If ownership cannot drain before the deadline, rollback
  fails closed before restoring any snapshot and leaves HCO unloaded.
- The explicit failed/cancelled agent-message concern confused item status with
  turn status. Output reduction accepts agent messages only inside a completed
  turn and rejects every explicit non-completed item status. A failed turn is
  reconciled to durable `terminal_error`; a cancelled turn is reconciled to
  durable `cancelled`. Both clear the active submission and lease, so neither
  can leave an objective stuck or be silently retried.
- Cancellation intentionally creates one user-facing outbox notification.
  Failed-turn reconciliation intentionally records a terminal audit fact
  without synthesizing a message from unavailable or untrusted backend error
  detail. Adding a new generic failure notification would be a separate product
  decision, not a correctness fix for this incident.
- Claude's full review returned `NO_ACTIONABLE_FINDINGS`. After source-level
  adjudication, Gemini's two residual candidates also require no code change.
# 2026-07-18 canonical Provider precedence confirmation

- Hermes resolves canonical built-in Provider names before same-named keyed or
  legacy custom declarations. The bridge installer must therefore copy no
  provider declaration for a canonical built-in and must carry only the
  selected credential into the isolated profile environment.
- The full line-numbered installer trace exited 0 across all 31 scenarios,
  including a fixture with both keyed and legacy `openrouter` shadows. A fresh
  normal-mode run remains the deployment gate.

# 2026-07-18 production Provider failure evidence

- The user's reported ASK replies correspond to Gateway log entries at
  13:21:05 and 13:21:36. Both enter the normal Hermes agent path and fail before
  any API call with `No inference provider configured`; the user-facing
  authentication warning is a generic Gateway rendering of this local
  configuration failure.
- The activated `codex-bridge/config.yaml` contains neither the default
  profile's `model` selection nor a Provider declaration. Its profile directory
  has no `.env`. In contrast, the default profile selects `gpt-5.5` with the
  non-canonical custom Provider `iotwq` and stores its credential in the
  owner-only default environment.
- The live stable plugin still targets content release
  `hermes-codex-bridge-1.0.0-441a66c6a242`, and HCO/Gateway/delivery all started
  during the 12:30 transaction. This proves production has not received the
  later inference-closure repair, even though that repair passed repository
  gates.
- The next decisive check is whether the current installer stages exactly the
  `iotwq` model/declaration/credential closure and Hermes resolves it under the
  isolated profile. A canonical built-in-only fixture is insufficient evidence
  for this production configuration.
- Production-shaped scenario 32 now reproduces that exact topology. The staged
  profile ignores endpoint-free `providers.iotwq: {}`, retains a sanitized
  legacy `custom_providers.iotwq`, strips its inline key, copies only
  `HERMES_API_KEY_GPT_BACKUP`, and resolves successfully through Hermes' real
  runtime loader. The full installer suite emitted `1..32` and exited 0.
- This scenario-32 fix is still undeployed. The latest user transcript therefore
  exercised the old Provider-incomplete release, not the current patch.

# 2026-07-18 capability lifetime review continuation

- Independent review found a real residual boundary issue: the project
  capability is inserted into ephemeral `channel_prompt` and added to the
  in-process `PendingVault`, but an ordinary model answer never calls
  `hco_dispatch` and therefore does not consume the entry. It remains valid for
  the rest of its 60-second lifetime.
- Consumption is correctly performed before the first `await` when the tool is
  called, and the token remains bound to sender, stream, Zulip message, project,
  topic mode, and request digest. The missing property is per-turn revocation
  when no tool call occurs; global or per-topic invalidation could break
  concurrent legitimate turns and is not acceptable.
- The current checkout is the existing feature branch
  `codex/option-c-app-server`, not a linked worktree. The repair is a continuation
  of already-uncommitted work, so moving only the new changes into another
  worktree would split the transaction and its tests.
- Next evidence boundary: determine whether Hermes invokes a plugin hook after
  each inbound agent turn, and whether tool handlers receive a trustworthy
  session/message/turn identity. The lifecycle fix must be keyed to one turn,
  not to all pending entries.
- Hermes exposes trusted `pre_llm_call` and `post_llm_call` hooks containing
  `session_id`, `task_id`, and `turn_id`; `pre_tool_call` additionally receives
  the same trusted session/turn identity before registry dispatch.
- The plugin tool handler itself receives `session_id` but not `turn_id`, so a
  handler-only cross-turn check cannot be made without modifying Hermes core.
  The bridge must bind in a lifecycle hook, authorize in `pre_tool_call`, and
  revoke an unused token in `post_llm_call`.
- Sender-, stream-, topic-, and session-wide cleanup is unsafe because multiple
  valid turns may overlap. Capability lifecycle state must remain isolated to
  one exact Hermes turn.
- The remaining mapping question is how the Gateway `pre_gateway_dispatch`
  event can be correlated unambiguously with the later `pre_llm_call` event.
  The ephemeral `channel_prompt` is not part of `pre_llm_call.user_message`, so
  the profile-aware Gateway session key/session store path must be verified.
- Direct source inspection reconfirmed the reachable failure: the only normal
  `PendingVault.consume()` path is inside `hco_dispatch_handler`; the Gateway
  hook inserts the nonce before returning `allow`, and no lifecycle hook is
  currently registered. A normal assistant answer therefore leaves the nonce
  available until TTL cleanup.
- Hermes Gateway exports `gateway.session.build_session_key()`. The next check
  is whether `pre_gateway_dispatch` runs before or after profile-aware session
  lookup and whether the passed Gateway/session store exposes the exact entry
  needed to bind this event without sender/topic-wide state.
- `pre_gateway_dispatch` runs before authorization and before
  `SessionStore.get_or_create_session()`, but receives both `gateway` and
  `session_store`. After the bridge selects `source.profile=codex-bridge`,
  `gateway._session_key_for_source(source)` computes the same profile-aware key
  later stored on the session entry.
- Gateway installs a per-session pending sentinel before awaits and queues later
  messages for that key. Thus one session's turns are serialized; distinct
  session keys can still progress concurrently. A session-key FIFO plus exact
  `session_id + turn_id` binding can preserve concurrency isolation if the
  reverse session lookup and lifecycle cleanup are fail-closed.

# 2026-07-18 production failure recheck

- The latest user transcript maps exactly to Gateway entries at 13:21:05 and
  13:21:36. Both calls entered Hermes inference with zero provider API calls and
  failed locally as `No inference provider configured`; the displayed
  authentication warning is only the Gateway's generic user-facing wrapper.
- Production still points `plugins/hermes-codex-bridge` at immutable release
  `hermes-codex-bridge-1.0.0-441a66c6a242`. That release and all three launchd
  services started at 12:30, before the production-shaped Provider closure fix.
- The active `profiles/codex-bridge` directory contains `SOUL.md` and
  `config.yaml` but no `.env`. This confirms the current runtime cannot resolve
  the default profile's `iotwq` model/declaration/credential closure.
- The immediate production defect is therefore an undeployed repair, not a bad
  secret and not a failure to enter the normal Hermes agent loop.

# 2026-07-18 exact message binding investigation

- Hermes Gateway binds `context.source.message_id` into the task-local
  `HERMES_SESSION_MESSAGE_ID` before running the agent and preserves that
  ContextVar in the executor with `copy_context()`.
- The plugin's `pre_llm_call` therefore has a core-supported, concurrency-safe
  correlation key without modifying Hermes core. Its current session-key plus
  request-text scan is weaker: an orphan earlier capability can claim a later
  identical message before that message's own capability.
- The repair boundary is exact `session_key + sourceMessageId + request` matching.
  Missing or malformed message IDs must fail closed; distinct queued messages
  with identical text remain independently bindable by their Zulip IDs.
- The installed Zulip adapter constructs `SessionSource` without passing its
  triggering message ID, then stores the same ID only on `MessageEvent`. The
  Gateway later exports `context.source.message_id`, so the plugin receives an
  empty `HERMES_SESSION_MESSAGE_ID` even though provenance validation already
  proved the event ID. The narrow compatibility repair is to copy that verified
  ID into an otherwise-empty source inside `pre_gateway_dispatch`; an existing
  conflicting source ID must continue to fail closed.
- A future immutable or renamed `SessionSource.message_id` would make a direct
  compatibility assignment raise inside the Gateway hook. A RED contract
  reproduced the uncaught `AttributeError`; the compatibility boundary now
  converts any assignment failure to the fixed route-unavailable rewrite, so
  Hermes upgrades fail closed instead of dropping the hook result.
- The upgrade invariant is the complete chain `raw message.id ->
  MessageEvent.message_id -> SessionSource.message_id ->
  HERMES_SESSION_MESSAGE_ID -> pre_llm_call`. Test fixtures must start from the
  actual adapter-owned fields rather than pre-populating the downstream source.
- Deployment review found that the first compatibility placement filled the
  verified source ID before route selection, which also changed General events.
  A focused RED contract reproduced that broader mutation. The assignment now
  runs only after a signed snapshot selects a project-owned natural-language
  turn; General, commands, and invalid routes retain their original source.

# 2026-07-18 hermes-general provider failure

- The latest Gateway errors are local runtime failures: `hermes-general` was
  generated with Zulip toolsets but without `model`, a selected provider
  declaration, or a profile-local `.env` credential.
- Multiplexed Gateway turns execute inside `_profile_runtime_scope`, which
  resolves both configuration and secrets strictly from the routed profile.
  Falling back to the default profile's process environment is intentionally
  disabled, so this incomplete profile deterministically reports
  `No inference provider configured`.
- The project routes must remain isolated in `codex-bridge`; changing general
  traffic back to the ASK-flavored default profile would reintroduce project
  identity and credential leakage. The correct boundary is a minimal,
  project-neutral inference closure in `hermes-general`.
- A new installer regression first failed with `KeyError: 'model'`. The
  implementation now stages the same sanitized selected-provider closure and
  only its referenced credential into both `codex-bridge` and
  `hermes-general`; it does not copy default cwd, system prompt, memory, or task
  guard fields.
- The effective Hermes probe now resolves the general provider under the real
  profile runtime scope before live activation. The full installer transaction
  suite passed all 32 scenarios after this change.

# 2026-07-18 general provider deployment and lawful live-test boundary

- The complete post-fix gates passed immediately before deployment: installer
  transactions `32/32`, Hermes plugin contracts `218/218`, Node tests
  `237/237`, `npm run verify`, shell syntax, and `git diff --check`.
- The production installer committed successfully after using the HCO-configured
  Codex executable. Its staged and activated route, inference-provider, and
  effective-Hermes probes all passed before the service transaction committed.
- Production `hermes-general` now has the selected `iotwq` model/custom-provider
  declaration and a profile-local `.env` containing only its referenced
  credential. Both general and bridge dotenv files are owner-only mode `0600`;
  direct `_profile_runtime_scope` resolution reports a custom provider with a
  non-empty base URL and API key without exposing either secret.
- Attestation binds Gateway PID `83436` to immutable plugin release
  `hermes-codex-bridge-1.0.0-1ea64b603b0a`. The fresh route snapshot retained
  stream `4 -> ASK`, stream `5 -> stockprofits`, and default owner `HERMES`.
- The local `.zuliprc` authenticates as Jarvis PM bot ID `9`, while HCO project
  ACLs and the Gateway allowlist authorize boss ID `8`. Safari had no retained
  boss session and redirected to `/login/`; no lawful boss credential is
  available locally.
- As a real transport test, SpecPlanner bot ID `10` sent messages `368`, `369`,
  and `370` to general, ASK, and stockprofits under topic
  `codex-repair-live-20260718-110033`. Zulip accepted all three, and the running
  Gateway logged three `Unauthorized user` rejections before routing. This
  proves live ingress and the allowlist boundary, but it is not a successful
  project/general acceptance test and produced no replies.
- Do not widen the allowlist, add ID `10` to project ACLs, forge sender ID `8`,
  or write inbound rows directly. Final live acceptance requires three new
  messages authored by the already-authorized boss account.
# 2026-07-18 post-deployment acceptance evidence rule

- A successful historical reply cannot prove a later immutable release, even
  when stream, topic, request text, route, and bot are identical. Live
  acceptance evidence must bind the inbound boss message ID, outbound Jarvis
  message ID, Gateway/HCO/delivery PIDs, and release content hash from the same
  observation window.
- A lawful message from an unauthorized bot proves transport ingress and ACL
  containment only. It cannot prove project dispatch, App Server execution, or
  reply delivery, and authorization must not be widened merely to make an
  acceptance test pass.
- The local send credential is Jarvis PM ID `9`; the installed project ACLs
  authorize boss ID `8`. Sending as Jarvis would exercise outbound transport,
  not a user-to-Gateway turn, and spoofing/reusing another user's web session
  would invalidate both security and acceptance evidence.

# 2026-07-18 pytest/live-attestation isolation failure

- Hermes plugin registration is not read-only: loading the bridge writes a
  process attestation containing the current PID and resolved plugin path.
  Therefore any test import that can reach global plugin discovery is a
  production-state mutation unless the entire process is isolated first.
- Per-test `HERMES_HOME` monkeypatching is insufficient. Pytest collection,
  module imports, and lazy module-global `PluginManager` creation may occur
  before or outside the test function's fixture lifetime. A passing contract
  suite can still corrupt live operational evidence.
- The observed mismatch was decisive: disk attestation PID `22476` belonged to
  pytest, launchd Gateway PID remained `13671`, and `pluginPath` resolved to the
  production immutable release. This distinguishes test pollution from a real
  Gateway restart.
- The durable boundary is collection-time isolation in `test/conftest.py`:
  redirect both `HOME` and `HERMES_HOME` before test modules import, then assert
  at session teardown that the original production attestation bytes did not
  change. Full-suite before/after SHA-256 equality is required release evidence.
- Teardown cleanup belongs in `finally`; otherwise the very assertion intended
  to expose production-state pollution leaves its temporary Hermes home behind
  on failure and can contaminate later diagnostics.
- After every Hermes upgrade, re-audit plugin import and registration side
  effects. New writes under `HOME`, `HERMES_HOME`, profile homes, caches, or
  plugin stores must either stay inside the process sandbox or be guarded by an
  explicit unchanged snapshot. Test success alone is not proof of isolation.

# 2026-07-19 authorized three-channel acceptance

- Authorized boss ID `8` supplied all three post-deployment canaries under
  topic `message-id-repair-20260718-2055`. Exact readback is stockprofits
  `380 -> 382/386`, ASK `381 -> 383`, and General `384 -> 385`; Jarvis replies
  are sender ID `9`. The project results differ because their inbound messages
  came from numeric streams `5` and `4`, not because General changed project.
- General stayed on stream `3` and `hermes-general`. It did not enter HCO and
  no compatibility field was written for it, which is the intended boundary.
  ASK used its trusted stream route, while stockprofits exercised the complete
  asynchronous HCO/App Server/outbox/delivery path.
- The stockprofits objective is durably completed, bound to project
  `stockprofits`, and its outbox row is delivered once with Zulip acknowledgement
  `386`. The immediate `382` acknowledgement alone would not have been enough
  to prove execution or delivery.
- Zulip `get_messages` returned no row for a direct `id=385` narrow but returned
  message `385` through the exact `general` stream/topic window. A single query
  shape can create a false missing-message diagnosis; use at least one
  independent stream/topic readback before changing the send path.

# 2026-07-19 nine-message cross-channel matrix diagnosis

- The authorized matrix used topic `message-id-repair-20260718-2055` across
  General stream `3`, ASK stream `4`, and stockprofits stream `5`, with direct,
  same-text, and burst variants. General stayed on `hermes-general`; the ASK
  burst (`401 -> 402`) was rejected by the capability boundary; the
  stockprofits burst (`403 -> 404/405`) completed through HCO. Only objective
  `objective-a3685a61-4082-4a17-91a7-66d2bc6a365b` was created, for stockprofits
  message `403`.
- The practical common cause was that read-only context/progress questions were
  still allowed to enter the model path. `_is_route_query()` recognized only a
  narrow phrase set, so the natural request
  `请回复当前 projectId、工作目录，并用一句话汇报项目进度。` bypassed the
  trusted route response. stockprofits then repeated stale ASK context, while
  ASK made an unnecessary capability-bearing tool call.
- The ASK failure is not evidence that capability validation should be weakened.
  Hermes delivered an invalid capability suffix (`...QVNLIn0=.invalid`), and the
  existing fail-closed signature/turn/ACL checks correctly rejected it.
- Repair boundary: classify the bounded read-only project context/progress
  phrases as trusted zero-model `route.show` responses; leave signed capability
  issuance, binding, replay protection, ACL, and HCO dispatch unchanged.
- Upgrade lesson: natural-language status requests need an explicit, tested
  zero-model route classification. Otherwise model/provider changes can turn a
  harmless status query into an execution attempt or a cross-project context
  hallucination. The post-fix acceptance must prove no HCO objective and no
  model capability are used for these phrases.

# 2026-07-19 route-query repair deployment handoff

- The repaired immutable release
  `/Users/hula/.hermes/plugin-releases/hermes-codex-bridge-1.0.0-aff45e13f157`
  became active at 06:36 local time. Gateway, HCO, and delivery restarted at
  that boundary; the stable plugin link resolves to this release.
- Independent Zulip readback shows the latest authorized matrix traffic is
  still boss messages `391`, `397`, and `403` (with replies `392`, `398`, and
  `404/405`) from 06:09-06:13. Those replies were generated before the repaired
  release and retain the old symptoms: ASK used a rejected `hco_dispatch`,
  while stockprofits created objectives and returned progress through HCO.
- After deployment there is no boss ID `8` message in General, ASK, or
  `量化交易stockProfits`; the live SQLite database remains at seven objectives
  and no post-deployment turn/outbox rows exist. This is a test-input timing
  gap, not evidence that the repair failed.
- The remaining acceptance action is a fresh authorized boss message matrix on
  the active release: General profile confirmation, ASK and stockprofits
  project/cwd/progress queries, plus progress-only bursts with fresh markers.
  Verify each by stream/topic readback, Gateway route/model logs, and SQLite
  objective/turn/outbox deltas. Never use a bot-authored substitute or relax
  the ID `8` allowlist.

# 2026-07-19 live marker grammar gap

- The post-deployment boss matrix was valid and exposed a real classifier gap,
  not a routing-table or stream-name problem. All seven test messages reached
  the Gateway with the expected stream IDs, but all seven still invoked a
  provider (`api_calls=1`).
- `_is_route_query()` normalized whitespace and punctuation, then compared
  against exact strings. The installed code recognized only the historical
  `并回显测试编号 ...` progress form. It did not recognize either actual canary
  form, `。回显 POSTFIX-*` or `，并回显 POSTFIX-*`, and omitted the bounded
  projectId/cwd-only query entirely.
- Future acceptance plans must be turned into classifier contract fixtures
  before deployment. The exact messages sent by the human are part of the
  interface; changing canary wording after tests are written can silently move
  a read-only request back onto the model/HCO path.
- The safe repair pattern is base-command whitelist plus a separately bounded,
  anchored marker grammar. Do not strip arbitrary trailing text and do not use
  a broad keyword test such as `projectId in text`, because either would let
  real work requests bypass the normal capability and ACL path.

## 2026-07-19 08:27 deployment timing finding

The boss-authored messages read at 08:02-08:04 were consumed by the old
`aff45e13f157` release. The repaired release `4cedb2c0be61` was not active until
08:27, so those replies are valid regression evidence but not live proof of the
classifier fix. The installer gate was `32/32`; attestation PID `50067`, HCO
health, and App Server readiness all match the new release. Do not reuse the old
markers or send from Jarvis ID `9`; require new boss ID `8` messages after the
deployment boundary.

## 2026-07-19 08:34 live acceptance result

- The repaired release correctly separates the three routes under real
  authorized traffic. General message `423` used `hermes-general` and produced
  reply `424`; ASK messages `425`, `429`, and `435` produced replies `426`,
  `430`, and `436` with the ASK cwd; stockprofits messages `427`, `431`, and
  `433` produced replies `428`, `432`, and `434` with the stockprofits cwd.
- The absence of ordinary Gateway inbound/`response ready` entries for the six
  project turns is expected: `pre_gateway_dispatch` rewrites bounded route
  queries directly to `route.show`, so the Gateway only records the outbound
  send. General is intentionally outside that rewrite and recorded one provider
  call.
- Database evidence is stronger than relying on the log shape alone. After
  epoch `1784420820000` (08:27 local deployment boundary), all three HCO queries
  return zero rows; total counts remain objectives `10`, submissions `9`, and
  outbox `8`.
- Marker acceptance and marker rendering are separate behaviors. The bounded
  marker grammar successfully classifies project queries, but the `route.show`
  renderer emits only project, cwd, and the conservative progress sentence.
  Therefore General's marker echo passed while all six project marker-echo
  assertions failed. Future live plans must explicitly decide whether markers
  are correlation-only test input or part of the user-visible reply contract.
- Zulip SDK `get_raw_message()` returns the actual row under the nested
  `message` key and the source markdown under `raw_content`. Reading only
  top-level message fields falsely reports a successful call with empty data;
  upgrade diagnostics should inspect the returned schema before concluding a
  message is missing.

# 2026-07-19 bounded marker reply repair

- Root cause was split across two narrow boundaries: `_is_route_query()` did
  not recognize the exact canary suffixes, and the direct `route.show`
  renderer had no way to receive a correlation marker. The first issue sent
  project queries through the provider/HCO path; the second made successful
  direct replies impossible to correlate from Zulip.
- The repair intentionally does not alter Hermes core, HCO command shape,
  project ACLs, capability signatures, replay handling, or normal
  `hermes-general` inference. `replyMarker` is signed, command-bound, and
  strictly validated before rendering. Without a marker, the prior reply
  text is unchanged.
- Upgrade note: future Hermes changes must preserve the ingress event text
  exactly long enough for the closed route-query parser to inspect it. New
  acceptance wording must first become a RED contract fixture; do not broaden
  matching to keyword heuristics or strip arbitrary suffixes. After each
  upgrade, rerun the installed-runtime contract and verify the live
  attestation before sending fresh boss-ID-8 canaries.

# 2026-07-19 bounded marker live acceptance

- The deployed repair passed real authorized traffic, not only local contract
  tests. General `437 -> 438` stayed on `hermes-general` and echoed
  `LIVE-0901-G-001`; ASK `439/441 -> 440/442` returned only the ASK project and
  cwd with the matching markers; stockprofits `443 -> 444` returned only the
  stockprofits project and cwd with its matching marker.
- The route split is observable in Gateway logs: General made one provider
  call, while project queries emitted direct sends without ordinary provider
  processing. SQLite independently confirms no HCO work was created after
  `1784424744000`; objective/submission/outbox totals remain `10/9/8`.
- Upgrade acceptance must verify all three layers separately: user-visible
  marker echo, route/profile/cwd correctness, and absence of HCO rows for
  bounded `route.show` queries. A correct cwd alone would not detect a marker
  rendering regression, and a marker alone would not prove route isolation.
- This repair remains outside Hermes core. It did not widen the boss ID `8`
  authorization boundary, project ACLs, capability validation, replay
  protection, or the HCO command schema. The only new value is the bounded,
  signed, command-bound `replyMarker` used by the direct reply renderer.

# 2026-07-19 adaptive dispatch review and SessionStore hardening

- The fresh installer transaction suite passed all `32/32` scenarios with the
  semantic-only `hco_dispatch` schema, exact `required: ["semantic"]`, closed
  additional properties, registration guidance, and installed SOUL language
  that forbids model-supplied capability or `topicModeAction` values.
- A read-only Claude review reported no Critical findings and three High
  candidates. One was accepted: the plugin previously replaced its captured
  Gateway `SessionStore` whenever a later dispatch supplied a different
  object. Current Hermes creates one store, but a future lifecycle change could
  silently redirect turn binding. A RED regression proved the replacement;
  the minimal GREEN fix pins the first trusted object under a lock and fails
  closed on later object drift. `pre_llm_call` reads the pinned reference under
  the same lock.
- Retaining an unused pending-vault entry is intentional bounded fail-closed
  behavior, not cross-turn authorization. Entries are bound to message ID,
  sender, stream, topic, project, request digest, session, and turn; they expire
  after 60 seconds plus 30 seconds clock skew and are capped at 256 total,
  eight per sender, and 1 MiB.
- The protected `codex-bridge/.env` provider closure is required because the
  restricted profile still performs semantic classification. The installer
  strips inline config credentials, copies only the selected provider's
  referenced secret, enforces owner-only state, and validates the effective
  provider. Removing it would recreate the observed provider-authentication
  failure rather than reduce bridge authority.
- The model schema excludes `topicModeAction`; the plugin deep-copies a valid
  semantic object and injects `null` only on the trusted HCO wire for DISPATCH.
  Malformed session and turn values already fail closed during vault binding
  and authorization. No remaining accepted Critical or High issue was found in
  this review pass.
# 2026-07-19 - Gateway rollback test path normalization

- The first installer GREEN retry failed after the rollback scenario had
  restored a running Gateway with a fresh PID. The missing `bootstrap` assertion
  was a test-path representation mismatch: macOS `TMPDIR` ended in `/`, so the
  shell fixture retained `.../T//hco-installer-test...`, while the installer's
  Python `Path` normalized the same plist path to `.../T/hco-installer-test...`
  before invoking `launchctl`.
- The product rollback branch already invokes `bootstrap` with the original
  Gateway plist. A first fixture correction used `pwd -P`, which expanded
  macOS `/var` to `/private/var`; the installer intentionally retained `/var`.
  The fixture now applies the same Python `Path` lexical normalization as the
  installer. A later sequence assertion had the same stale raw path and
  filtered the real `bootstrap` line out of its mutation list; it now reuses
  the normalized fixture value. No product behavior was changed for these
  assertion failures.
# 2026-07-19 - Final state-machine review finding

- Direct review confirmed mapped legacy topics are safe during first dispatch:
  `registerExecutionIntent()` records the objective/topic association while the
  topic still reads as `AUTO`, and `bindBackendObjective()` calls
  `promoteObjectiveTopics()` only after a concrete App Server `threadId` is
  durably stored.
- Direct review also confirmed uncertain thread creation fails closed:
  `TurnController.acceptIntent()` records `thread_start_uncertain`, and
  reconciliation returns `manual_thread_binding_required` without issuing a
  second `thread/start` or reading a null thread ID.
- One required compatibility path is missing. `createAppServerBackend()` maps
  every App Server business error outside its small pre-write set to
  `EXECUTION_BACKEND_REQUEST_UNCERTAIN`; neither the backend nor controller has
  a proven-missing-thread result or replacement path. Therefore an objective
  with a durable HCO thread binding whose Codex App Server thread was actually
  deleted cannot self-heal, despite the accepted design and implementation plan
  requiring replacement only after the backend proves absence.
# Codex App Server missing-thread compatibility (2026-07-19)

- An isolated protocol probe against the installed `codex-cli 0.142.3` sent
  `thread/read` for a random UUID after a normal initialize handshake. The
  exact JSON-RPC response was an error with code `-32600`, message
  `thread not loaded: <the requested threadId>`, and no `data` member.
- Code `-32600` is not specific enough to authorize recovery by itself. Safe
  classification must require both that code and exact equality between the
  remote message and `thread not loaded: ${requestedThreadId}`. Fuzzy text
  matching, prefix-only matching, and classification of other `-32600`
  responses would permit an unrelated invalid request to replace a durable
  binding.
- The current RPC wrapper discards the validated remote message and optional
  data, and the App Server backend collapses all remote errors into
  `EXECUTION_BACKEND_REQUEST_UNCERTAIN`. This is the direct compatibility gap
  preventing proven-missing thread recovery.
- Resume audit confirmed the four production modules and their focused tests
  have no inherited worktree edits, despite substantial unrelated pending
  plugin/installer changes. The repair can therefore remain scoped to the RPC
  client, App Server backend, turn controller, state store, and their tests.
- The replacement transaction must compare the expected old thread ID against
  both `objective_execution.backend_objective_id` and every related durable
  `topic_modes.thread_id`, require the current intent submission, reject a new
  thread already owned by another objective, update both bindings together,
  and append one audit fact in the same SQLite transaction.
- The implemented RPC boundary retains remote code/message/data as immutable,
  non-enumerable diagnostics. Non-enumerability is required because lossless
  JSON may decode an out-of-range RPC code as `BigInt`; enumerating it through
  ordinary `JSON.stringify(error)` would otherwise throw and could leak remote
  detail into public logs.
- Focused review now proves all topic rows for an objective move with the
  replacement, a replacement turn that also reports missing does not create a
  third thread, and replaying the same operator-binding source identity does
  not submit the stored turn twice. These are release invariants, not optional
  retry behavior.

# 2026-07-19 - Proven-missing repair release boundary

- Session catch-up confirms the local implementation and complete regression
  results belong to the current dirty branch, while the live immutable release
  still predates this compatibility repair. Local green tests are therefore not
  production acceptance evidence.
- Deployment remains gated on a direct review of compare-and-swap transaction
  invariants, one-shot replacement, uncertain creation recovery, duplicate
  operator binding, and exact RPC classification against ADR 0003 and the
  adaptive-dispatch design.

# 2026-07-19 - Operator binding dual-review adjudication

- Claude's direct review reported `Critical=0`, `High=0`, `Medium=3`, and
  `Low=5`. Gemini's independent pure-diff review reported zero findings at all
  severities. The three Medium candidates were checked against the production
  implementation rather than accepted from the review summary.
- M1 is not actionable: `PendingVault` already serializes `_turn_nonces`
  mutations with `self._lock`, and cleanup uses idempotent
  `.pop(..., None)`. The claimed unsynchronized cleanup race is absent.
- M2 is not actionable: the binding transition executes inside a SQLite write
  transaction, which serializes writers and revalidates the expected objective,
  project, old thread, topic bindings, and submission state before updating.
  SQLite does not provide the proposed row-level `SELECT ... FOR UPDATE` form.
- M3 is not actionable: selecting `app-server` already returns the single
  configured `#appServerBackend` instance. An extra identity comparison would
  repeat the selector invariant without changing replacement behavior.
- The Low findings are documentation/style suggestions or outside the scoped
  legacy-thread repair. No Critical, High, or accepted Medium issue remains;
  the mandatory ADR-aware deployment review is complete.

# 2026-07-19 - Message 445 regression-to-release trace

- The exact old rejection was at the model/plugin boundary: the old tool
  contract exposed a 515-character signed capability to the model, the model
  returned a non-canonical copy, and `pre_tool_call` rejected it before HCO saw
  source message `445`. A missing topic binding or Codex thread was not the
  immediate cause.
- `test_project_prompt_never_exposes_internal_capability` and
  `test_model_supplied_capability_is_rejected_as_an_extra_tool_field` lock the
  new trust boundary: no capability enters the prompt or schema, and a
  model-authored capability remains invalid rather than gaining authority.
- `test_real_gateway_enters_agent_then_contains_every_natural_result` exercises
  the actual Gateway hook lifecycle. It proves that `pre_gateway_dispatch`
  keeps the capability in `PendingVault`, `pre_llm_call` binds it to the exact
  session/turn/message ID, and `pre_tool_call` authorizes a semantic-only call.
  The lifecycle variants also cover message-ID promotion, cross-turn
  isolation, FIFO identical messages, replay consumption, and missing-ID
  fail-closed behavior.
- `mapped legacy topic lazily creates a thread and promotes only after durable
  binding` reproduces source message ID `445`, topic `general chat`, and a
  mapped project stream with no topic binding. It keeps the topic in `AUTO`
  while `thread/start` is unresolved, then promotes to `CODEX_BOUND` only after
  the objective/thread binding is durable.
- These tests cover both independent defects without weakening sender ACLs,
  numeric-stream routing, signatures, message-ID binding, or replay fences.
  End-to-end acceptance still requires a new authorized boss ID `8` message;
  the installed Jarvis bot is ID `9` and cannot lawfully substitute for it.
