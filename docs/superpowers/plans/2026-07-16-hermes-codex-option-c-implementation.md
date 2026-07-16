# Hermes-Codex Option C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the production Zulip -> Hermes bridge -> HCO -> Codex App Server path with durable context, exact-command zero-model routing, one-call natural-language routing, and no Hermes core changes.

**Architecture:** Add a new `hco/` production service beside the legacy `adapter/` and `runner/` MVP. HCO owns versioned bridge contracts, SQLite state, App Server execution, reconciliation, and Zulip outbox; a standalone Hermes plugin owns inbound routing and a separately supervised send-only sidecar owns outbound Zulip REST delivery.

**Tech Stack:** Node.js 20+ ESM, `better-sqlite3`, built-in `node:test`, Codex App Server NDJSON over stdio, Python 3.13 Hermes plugin contract tests, Zulip REST API, launchd.

## Global Constraints

- Do not modify `/Users/hula/Projects/hermesAgent` core source.
- Preserve the current dirty worktree and legacy Runner behavior.
- Numeric Zulip stream ID is the only authoritative project route key.
- Exact `/codex` commands invoke zero Hermes models; valid free-form language invokes zero or exactly one configured Hermes model.
- `pre_gateway_dispatch` is synchronous, pre-authorization, local-only, and has no external side effect.
- Unknown routing stays in the restricted default Hermes profile.
- Never automatically retry an uncertain App Server turn or fall back to tmux.
- Store completed Codex technical output unchanged before deterministic rendering.
- Use one inbound Zulip poller; the outbound sidecar is send-only.
- All production behavior follows red-green-refactor TDD.

---

### Task 1: Bridge Contracts, Identity, And Signed Envelopes

**Files:**
- Create: `hco/contracts/protocol.js`
- Create: `hco/contracts/identity.js`
- Create: `hco/contracts/envelope.js`
- Create: `test/contracts.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `negotiateBridge(request) -> compatibility result`
- Produces: `zulipTargetKey({streamId, topic}) -> string`
- Produces: `signContext(payload, key, options) -> token`
- Produces: `verifyContext(token, key, options) -> verified payload`

- [x] Write tests proving numeric identity, canonical JSON signing, tamper rejection, 120-second expiry, 30-second skew, size bounds, nonce replay rejection, and major-version fail-closed negotiation.
- [x] Run `node --test test/contracts.test.js`; verify RED because the modules do not exist.
- [x] Implement only the tested contracts with stable error codes and constant-time HMAC comparison.
- [x] Run the focused test, then `npm run verify`; both must pass.

### Task 2: SQLite Authority, Migrations, Journal, And Outbox

**Files:**
- Create: `hco/state/migrations.js`
- Create: `hco/state/store.js`
- Create: `hco/state/reducer.js`
- Create: `test/state-store.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: protocol and identity values from Task 1.
- Produces: `openStore({databasePath}) -> HcoStore`
- Produces: `store.ingest(fact) -> reduced result`
- Produces: `store.claimOutbox({workerId, limit, leaseMs}) -> rows`
- Produces: `store.ackOutbox({deliveryId, leaseToken, zulipMessageId})`

- [x] Write crash-window tests for transactional migration, duplicate `sourceId`, journal/reducer/outbox atomicity, lease expiry, ordered objective delivery, and ack idempotency.
- [x] Run `node --test test/state-store.test.js`; verify RED for the missing store.
- [x] Add `better-sqlite3` and implement schema versioning, WAL, restrictive file creation, transactions, and stable state transitions.
- [x] Run focused tests and the legacy suite; no existing JSON state is deleted or rewritten.

### Task 3: Renderer And Delivery Claim Protocol

**Files:**
- Create: `hco/delivery/renderer.js`
- Create: `hco/bridge/auth.js`
- Create: `hco/bridge/server.js`
- Create: `test/renderer.test.js`
- Create: `test/bridge-server.test.js`

**Interfaces:**
- Produces: `renderFinal({objectiveId, text, maxBytes, rendererVersion}) -> chunks`
- Produces HTTP/Unix-socket endpoints: `GET /v1/compatibility`, `POST /v1/events`, `POST /v1/outbox/claim`, `POST /v1/outbox/:id/ack`, `POST /v1/outbox/:id/nack`.

- [x] Write RED tests for UTF-8 byte limits, paragraph/line/scalar splitting, fenced code reopening, stable markers/hashes, bearer authentication, version rejection before mutation, claim leases, and ack/nack ownership.
- [x] Implement deterministic renderer v1 and authenticated bridge endpoints.
- [x] Verify restart after claim, crash after simulated send before ack, and repeated ack behavior with a temporary SQLite database.

### Task 4: App Server NDJSON Transport And RPC Client

**Files:**
- Create: `hco/app-server/transport.js`
- Create: `hco/app-server/rpc-client.js`
- Create: `hco/app-server/client.js`
- Create: `test/app-server-transport.test.js`
- Create: `test/fixtures/fake-app-server.js`

**Interfaces:**
- Produces: `NdjsonTransport` with line framing, write backpressure, close/error states.
- Produces: `AppServerRpcClient.request(method, params)` and server-request callbacks.
- Produces: `CodexAppServerClient.initialize/startThread/resumeThread/readThread/startTurn/interruptTurn/respond`.

- [x] Write RED tests using the fake child process for interleaved responses/notifications/server requests, string and int64 IDs, malformed lines, EOF, initialization order, timeout, and unknown-method rejection.
- [x] Implement `codex app-server --stdio` lifecycle with `initialize` then `initialized` and capability checks.
- [x] Verify no request is retried automatically after write or lost acknowledgement.

### Task 5: Objective And Turn Controller

**Files:**
- Create: `hco/execution/backend.js`
- Create: `hco/execution/app-server-backend.js`
- Create: `hco/execution/tmux-backend.js`
- Create: `hco/turn-controller.js`
- Create: `hco/recovery.js`
- Create: `test/turn-controller.test.js`

**Interfaces:**
- Produces the approved `ExecutionBackend` methods.
- Produces: `TurnController.acceptIntent`, `continueObjective`, `cancelTurn`, `answerInteraction`, and `reconcile`.

- [x] Write RED tests for lazy thread creation, `objectiveId -> threadId -> turnId`, one active lease, duplicate inbound event suppression, `submission_unknown`, `thread/read` reconciliation, final-item selection, null phase fallback, cancellation, and explicit-only tmux selection.
- [x] Implement intent journaling before App Server calls and final output storage before outbox rendering.
- [x] Verify restart scenarios with a fresh controller over the same SQLite database.

### Task 6: HCO Service And Route/ACL Control Plane

**Files:**
- Create: `hco/config.js`
- Create: `hco/service.js`
- Create: `hco/index.js`
- Create: `hco/routes.js`
- Create: `hco/acl.js`
- Create: `test/hco-service.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces exact command and typed semantic-dispatch bridge APIs.
- Produces atomically published, bounded route snapshot format v1.

- [ ] Write RED tests for numeric route `show/set/none/unset`, immutable user-ID roles, project registry cwd authority, `AUTO/CODEX_BOUND/HERMES_ONLY`, lazy objective creation, natural-language `CONTROL`, and snapshot corruption/staleness.
- [ ] Implement the service composition and route snapshot publisher.
- [ ] Verify that all rejected/unauthorized requests cause zero backend side effects.

### Task 7: Standalone Hermes Plugin

**Files:**
- Create: `plugin/hermes-codex-bridge/plugin.py`
- Create: `plugin/hermes-codex-bridge/bridge_client.py`
- Create: `plugin/hermes-codex-bridge/route_snapshot.py`
- Create: `plugin/hermes-codex-bridge/__init__.py`
- Create: `plugin/hermes-codex-bridge/plugin.yaml`
- Create: `test/hermes_plugin_contract_test.py`

**Interfaces:**
- Registers one local-only `pre_gateway_dispatch` callback.
- Registers a private awaited slash handler for signed exact commands.
- Initially registers one `is_async=True` natural-language HCO tool; Task 9.5 removes it after the installed-runtime boundary is proven.

- [ ] Write RED contract tests against `/Users/hula/Projects/hermesAgent/venv/bin/python3` for fail-closed profile routing, exact-command rewrite into the dedicated restricted `codex-bridge` namespace, idle-session awaited delivery, documented busy-session queuing without model fallthrough, strict numeric `raw_message["message"]["sender_id"]` ACL provenance with nested message/source identity cross-checks and no top-level fallback, initialization-time HMAC loading, no shared mutable request context, ContextVar natural-language provenance, async handler/tool awaiting, and multi-hook ordering checks.
- [ ] Implement the plugin without importing private Gateway runner internals.
- [ ] Verify exact commands never enter the Hermes Agent loop and malformed envelopes never fall through to a model.

### Task 8: Send-Only Zulip Delivery Sidecar

**Files:**
- Create: `plugin/hermes-codex-bridge/delivery_sidecar.py`
- Create: `plugin/hermes-codex-bridge/zulip_sender.py`
- Create: `test/delivery_sidecar_test.py`

**Interfaces:**
- Consumes HCO claim/ack/nack endpoints.
- Produces one Zulip REST `send_message` operation using canonical `<streamId>:<topic>` target data.

- [ ] Write RED tests for no inbound polling, lease ownership, ordered sending, immutable message-ID ack, retryable/permanent errors, crash after send, and credential masking.
- [ ] Implement bounded long-poll/claim processing under an external supervisor.
- [ ] Verify the documented at-least-once duplicate window and stable visible marker.

### Task 9: Installation, Upgrade, And Rollback

**Files:**
- Create: `scripts/install-hermes-codex-bridge.sh`
- Create: `test/install-hermes-codex-bridge.test.sh`
- Create: `deploy/com.hermes.codex-bridge-hco.plist.example`
- Create: `deploy/com.hermes.codex-bridge-delivery.plist.example`
- Create: `config/hco.json.example`
- Modify: `plugin/hermes-codex-bridge/plugin.py`
- Modify: `test/hermes_plugin_contract_test.py`
- Modify: `docs/SETUP.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `README.md`
- Create: `.planning/2026-07-16-option-c-implementation/task-9-report.md`

**Interfaces:**
- Activates a complete versioned plugin directory through the stable Hermes plugin symlink only after installed-runtime compatibility and effective-profile checks.
- Starts HCO and the send-only sidecar as independent LaunchAgents; compatibility failure disables only bridge components without changing Hermes core or `hermes-general`.

- [ ] Write RED shell and plugin contract tests for strict dry-run zero mutation, current-user `st_uid` checks, same-filesystem version/symlink activation, two independent LaunchAgents, and full file/service-state rollback.
- [ ] Implement transactional `HCO_CONFIG_PATH` injection through the default Hermes root `.env`; preserve prior values and do not patch the Hermes-generated gateway plist.
- [ ] Validate `plugins.enabled`, `gateway.multiplex_profiles`, resolved default/`codex-bridge`/`hermes-general` homes, hook order, and each profile's effective Zulip toolsets through actual installed Hermes loaders and `_get_platform_tools(config, "zulip")`, including `known_plugin_toolsets`, `no_mcp`, plugin/MCP, and context-engine behavior.
- [ ] Prove restricted profiles expose no general shell, filesystem, MCP, or context-engine tools, while `hermes-general` remains usable with all bridge components disabled.
- [ ] Verify effective `ZULIP_CONTEXT_DEPTH == 0` through Hermes dotenv and Zulip adapter resolution, not config text alone.
- [ ] Gate rollout separately on HCO `/v1/compatibility`, installed Hermes contracts, and an installed Codex App Server canary; on any failure do not enable/restart the plugin and leave HCO/delivery unloaded.
- [ ] Inject failures across install/upgrade and prove rollback restores the plugin version/current symlink, root and named-profile configs, root `.env`, credentials/configs, both plists, and prior launchd loaded/running state without exposing secrets.

### Task 9.5: One-Call Private Natural-Language Command

**Files:**
- Modify: `plugin/hermes-codex-bridge/plugin.py`
- Modify: `plugin/hermes-codex-bridge/plugin.yaml`
- Modify: `test/hermes_plugin_contract_test.py`
- Modify: `scripts/install-hermes-codex-bridge.sh`
- Modify: `test/install-hermes-codex-bridge.test.sh`
- Modify: `docs/superpowers/specs/2026-07-16-hermes-codex-option-c-design.md`

**Interfaces:**
- Rewrites valid project natural language to a signed private async command backed by a bounded one-shot pending-context vault.
- Invokes `ctx.llm.acomplete_structured()` exactly once, bypasses the ordinary Hermes agent loop, and locally validates a strict five-result union.
- Submits accepted `DISPATCH`/`CONTROL` to HCO exactly once; returns bounded local `CLARIFY`/`BUSINESS_REPLY`/`REJECT` without HCO.
- Removes the model-callable `hco_bridge` tool and proves the restricted effective Zulip tool set is empty.

- [ ] Write RED tests for one logical facade call on every valid natural-language result, zero calls for exact/invalid capability paths, no ordinary conversation-loop entry, exact HCO submission counts, strict local schema validation, and `HERMES_ONLY` behavior.
- [ ] Prove `objective=null` reaches HCO unchanged and atomically continues the topic's current project objective when present, otherwise creates a new objective; explicit `NEW` and `CONTINUE` retain their existing deterministic meanings.
- [ ] Write RED tests for signed short capabilities, direct-private-command rejection, atomic consume-before-await, tamper/expiry/replay/binding rejection, request digest/length checks, vault TTL/global-byte/entry/per-sender limits, and concurrent context isolation.
- [ ] Remove `register_tool`, `ContextVar`, manifest `provides_tools`, and all managed-profile `hco_bridge` assumptions; upgrade removes stale entries while rollback restores previous bytes and service state.
- [ ] Verify installed Hermes still provides the hook, private commands, and `ctx.llm`, while actual `_get_platform_tools(config, "zulip")` returns no tools for restricted root and `codex-bridge` profiles, including unrelated plugin and non-default context-engine cases.
- [ ] Document that one logical facade invocation does not promise one physical provider request because current Hermes may retry/fallback internally and exposes no public fail-fast option.

### Task 10: End-To-End Acceptance And Independent Review

**Files:**
- Create: `test/option-c-e2e.test.js`
- Create: `docs/reviews/OPTION_C_IMPLEMENTATION_REVIEW.md`
- Modify: `.planning/2026-07-16-option-c-implementation/{task_plan,findings,progress}.md`

**Interfaces:**
- Exercises fake Zulip + real plugin contract + fake and canary App Server paths across restart boundaries.

- [ ] Prove each acceptance criterion in the approved specification, including zero/exactly-one logical Hermes facade counts, no ordinary agent-loop entry, no duplicate turns, correct topic delivery, pending interaction authorization, and explicit-only tmux fallback.
- [ ] Run `npm run verify`, all `node --test` files, Hermes venv tests, install dry-run, `git diff --check`, and secret-pattern scans.
- [ ] Run independent Claude and Gemini code reviews, adjudicate every critical/high finding, and rerun covering tests after fixes.
- [ ] Record real Codex Desktop thread visibility as an observation only, not a correctness requirement.
