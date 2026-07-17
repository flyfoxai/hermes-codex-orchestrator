# Findings

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
