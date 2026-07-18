# Findings

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
