# Hermes/Zulip Adapter MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use TDD for every behavior change.

**Goal:** Build a platform-neutral Hermes/Zulip adapter MVP that turns normalized chat commands into Runner HTTP API calls, preserves notification state, and enforces adapter-side permissions and same-project write serialization.

**Architecture:** The MVP is an adapter core plus a local message harness. Platform transports normalize Zulip/Hermes messages into a shared `NormalizedMessage`, and the core parses commands, resolves a `projectId`, authorizes the action, calls the Runner HTTP API, writes adapter state, and returns reply objects. The adapter does not read project source, run shell commands, operate `tmux`, or drive Codex directly.

**Tech Stack:** Node.js 20+ ESM, built-in `fetch`, `node:test`, `node:http`, `node:fs/promises`, atomic JSON file persistence.

## Global Constraints

- The authority for integration behavior is `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`.
- Do not change `runner/` contracts unless a later plan explicitly requires it.
- Current Runner APIs are: `GET /health`, `GET /projects`, `GET /sessions`, `POST|PUT /projects/:projectId`, `POST /tasks`, `GET /tasks`, `GET /tasks/:taskId`, `GET /tasks/:taskId/raw`, `GET /tasks/:taskId/logs`, `POST /tasks/:taskId/dispatch`, and `POST /tasks/:taskId/cancel`.
- `POST /tasks/:taskId/dispatch` sends no request body.
- Runner task summaries do not include `allowCodeChanges`, `allowNetwork`, `requestedBy`, `constraints`, or `acceptanceCriteria`.
- Same-project write serialization must use adapter-owned persisted state in the MVP.
- Raw task access is admin-only.
- Tests must not require a real external Runner, real Zulip, real Hermes, `tmux`, or Codex.
- Token material must be loaded from a repository-external `0600` file and must not be logged or persisted.
- This repository has no Git metadata; do not require commits or worktrees during implementation.

---

## Reviewed Claude Plan Disposition

Claude's draft correctly proposed a modular adapter with config, Runner client, command parser, routing, permissions, state, write gate, poller, handlers, and tests.

Codex changes applied in this final plan:

- Use a platform-neutral core first; real Zulip/Hermes transport is deferred behind a normalized message interface.
- Require persisted `bindings`, `tasks`, and `activeWriters`; in-memory-only state is not acceptable.
- Use `/codex bind <projectId>` for the current conversation target, not `bind <stream> <topic> <projectId>`.
- Do not assume `GET /projects/:id`; verify project IDs via `GET /projects`.
- Treat `/codex ask <task>` as route-derived read-only and `/codex run <projectId> <task>` as explicit write-intent, subject to permissions.
- Keep adapter tests self-contained with mock Runner/harnesses.
- Avoid shell glob-dependent check scripts by adding a Node-based adapter syntax checker.

---

## File Map

Create:

- `adapter/types.js` — JSDoc typedefs for normalized messages, users, replies, commands, config, state, and Runner summaries.
- `adapter/errors.js` — stable adapter error helpers and user-facing error formatting.
- `adapter/config.js` — adapter config loading, defaults, validation, and token-file permission checks.
- `adapter/runner-client.js` — Runner HTTP API client using Bearer Token.
- `adapter/state-store.js` — atomic JSON state load/save for bindings, tasks, and active writers.
- `adapter/commands.js` — `/codex` command parser and input normalization.
- `adapter/router.js` — `projectId` resolution from explicit command, Zulip route, Hermes binding, or default.
- `adapter/permissions.js` — role/action authorization.
- `adapter/write-gate.js` — single-instance same-project write gate using adapter state.
- `adapter/handler.js` — platform-neutral command dispatcher.
- `adapter/poller.js` — task status polling with backoff, timeout, final notification, and write-gate release.
- `adapter/index.js` — minimal CLI/harness entry point for local adapter checks.
- `scripts/adapter-check.js` — explicit syntax check for adapter and adapter test files.
- `scripts/adapter-foundation-test.js` — Phase 1 self-contained tests for config, client, commands, routing, permissions, state, and write gate.
- `scripts/adapter-handler-test.js` — Phase 2 handler tests with a mock Runner client.
- `scripts/adapter-poller-test.js` — Phase 3 polling/recovery tests with fake timers or short intervals.
- `config/adapter.json.example` — safe example config without secrets.

Modify:

- `package.json` — add adapter check/test/verify scripts; do not replace existing Runner verification scripts.
- `.planning/2026-07-14-hardening-implementation/task_plan.md` — add Phase 9 for adapter implementation.
- `.planning/2026-07-14-hardening-implementation/progress.md` — log plan creation and development progress.
- `.planning/2026-07-14-hardening-implementation/findings.md` — record Claude plan review corrections.

Do not modify in this MVP unless a test proves it is unavoidable:

- `runner/http.js`
- `runner/config.js`
- `runner/task-store.js`
- `runner/codex.js`
- `runner/tmux.js`

---

## Public Interfaces

### Normalized message

```js
/**
 * @typedef {Object} NormalizedUser
 * @property {string} id
 * @property {'admin'|'maintainer'|'member'} role
 * @property {string[]} [projectIds]
 */

/**
 * @typedef {Object} NormalizedMessage
 * @property {'zulip'|'hermes'|'harness'} platform
 * @property {string} text
 * @property {NormalizedUser} user
 * @property {string} [stream]
 * @property {string} [topic]
 * @property {string} [conversationId]
 * @property {string} [messageId]
 * @property {string} receivedAt
 */
```

### Adapter state

```js
/**
 * @typedef {Object} AdapterState
 * @property {{ [targetKey: string]: string }} bindings
 * @property {{ [taskId: string]: TaskNotificationRecord }} tasks
 * @property {{ [projectId: string]: ActiveWriterRecord }} activeWriters
 * @property {string} updatedAt
 */
```

Target keys:

- Zulip: `zulip:<stream>/<topic>`
- Hermes: `hermes:<conversationId>`
- Harness: `harness:<conversationId>`

### Commands

Supported MVP commands:

- `/codex projects`
- `/codex bind <projectId>`
- `/codex ask <task>`
- `/codex run <projectId> <task>`
- `/codex status <taskId>`
- `/codex logs <taskId>`
- `/codex raw <taskId>`
- `/codex cancel <taskId>`
- `/codex dispatch <taskId>`
- `/codex sessions`

Command semantics:

- `projects`, `sessions`, `status`, and `logs` are read actions.
- `ask` creates a read-only task with `allowCodeChanges: false`.
- `run` creates a write-intent task with `allowCodeChanges: true` only when the user is authorized.
- `raw` is admin-only.
- `cancel` is allowed for admins, maintainers, or the original requester.
- `dispatch` is maintainer/admin-only.

---

## Task 1: Adapter Foundation

**Files:**

- Create: `adapter/types.js`
- Create: `adapter/errors.js`
- Create: `adapter/config.js`
- Create: `adapter/runner-client.js`
- Create: `adapter/state-store.js`
- Create: `adapter/commands.js`
- Create: `adapter/router.js`
- Create: `adapter/permissions.js`
- Create: `adapter/write-gate.js`
- Create: `scripts/adapter-check.js`
- Create: `scripts/adapter-foundation-test.js`
- Create: `config/adapter.json.example`
- Modify: `package.json`

**Interfaces produced:**

- `loadAdapterConfig(configPath)`
- `createRunnerClient({ baseUrl, token, fetchImpl })`
- `loadState(statePath)`
- `saveState(statePath, state)`
- `parseCommand(text)`
- `targetKeyFromMessage(message)`
- `resolveProjectId({ command, message, config, state })`
- `checkPermission({ command, user, taskRecord })`
- `checkWriteGate(state, projectId)`
- `reserveActiveWriter(state, projectId, taskId, owner)`
- `releaseActiveWriter(state, projectId, taskId)`

- [x] **Step 1: Write failing foundation tests**

  Add `scripts/adapter-foundation-test.js` using `node:assert/strict`, temporary directories, a mock `fetchImpl`, and isolated token/state files. Required assertions:

  - token file is read and trimmed;
  - token file must be outside the repository root;
  - token file mode rejects group/world readable files when the platform exposes mode bits;
  - Runner client sends `Authorization: Bearer <token>`;
  - Runner client maps non-2xx JSON errors to `{ code, status }`;
  - command parser handles all MVP commands;
  - `/codex ask` without a task is rejected as `invalid_command`;
  - `/codex run` requires `projectId` and a non-empty goal;
  - route priority is explicit project, Zulip route, conversation binding, default project, then `route_unbound`;
  - member cannot run write tasks, dispatch, or raw;
  - admin can raw;
  - same-project active writer blocks another write and different projects do not block each other;
  - state survives save/load.

- [x] **Step 2: Verify red**

  Run:

  ```sh
  node scripts/adapter-foundation-test.js
  ```

  Expected before implementation: failure caused by missing adapter modules.

- [x] **Step 3: Implement foundation modules**

  Implement only the interfaces required by the failing foundation test. Do not implement handler orchestration or polling in this task.

- [x] **Step 4: Add explicit syntax checker**

  `scripts/adapter-check.js` must enumerate adapter and adapter test files and run `node --check` for each file with `spawnSync`. This avoids shell glob portability issues.

- [x] **Step 5: Wire package scripts**

  Add:

  ```json
  "adapter:check": "node scripts/adapter-check.js",
  "adapter:test": "node scripts/adapter-foundation-test.js",
  "adapter:verify": "npm run adapter:check && npm run adapter:test"
  ```

- [x] **Step 6: Verify green**

  Run:

  ```sh
  npm run adapter:verify
  npm run verify
  ```

  Expected: both exit 0.

---

## Task 2: Core Handler and Command Effects

**Files:**

- Create: `adapter/handler.js`
- Create: `scripts/adapter-handler-test.js`
- Modify: `package.json`
- Modify as needed: `adapter/state-store.js`, `adapter/permissions.js`, `adapter/write-gate.js`

**Interfaces produced:**

- `handleMessage(message, context)`
- `createHarnessContext({ config, statePath, client })`

`handleMessage()` returns an array of reply objects:

```js
[
  { targetKey: "zulip:dev/topic", text: "..." }
]
```

It does not send network messages itself.

- [x] **Step 1: Write failing handler tests**

  Required assertions:

  - non-`/codex` messages return no replies;
  - `/codex projects` calls `client.projects()` and redacts server paths in the user reply;
  - `/codex bind <projectId>` verifies the project exists via `GET /projects` result and persists the current target binding;
  - `/codex ask <task>` creates a task with `allowCodeChanges: false`, `dispatch: true`, and `requestedBy`;
  - `/codex run <projectId> <task>` by maintainer creates a write task with `allowCodeChanges: true`, reserves the active writer, persists `taskId -> notification target`, and returns the task ID;
  - `/codex run` by member returns `permission_denied`;
  - active same-project writer returns `project_busy`;
  - `/codex status`, `logs`, `cancel`, `dispatch`, `sessions` call the matching Runner client methods;
  - `/codex raw` is admin-only and never includes raw content for non-admins.

- [x] **Step 2: Verify red**

  Run:

  ```sh
  node scripts/adapter-handler-test.js
  ```

  Expected before implementation: failure caused by missing `adapter/handler.js`.

- [x] **Step 3: Implement handler**

  Keep the handler platform-neutral. Use dependency injection for `client`, `config`, `statePath`, and `now`.

- [x] **Step 4: Extend adapter test script**

  Update:

  ```json
  "adapter:test": "node scripts/adapter-foundation-test.js && node scripts/adapter-handler-test.js"
  ```

- [x] **Step 5: Verify green**

  Run:

  ```sh
  npm run adapter:verify
  npm run verify
  ```

---

## Task 3: Polling, Timeout, and Restart Recovery

**Files:**

- Create: `adapter/poller.js`
- Create: `scripts/adapter-poller-test.js`
- Modify: `adapter/state-store.js`
- Modify: `adapter/handler.js`
- Modify: `package.json`

**Interfaces produced:**

- `createTaskPoller({ client, config, statePath, notify, setTimer, clearTimer, now })`
- `recoverPolling({ client, config, statePath, notify })`

- [x] **Step 1: Write failing poller tests**

  Required assertions:

  - polling calls `client.getTask(taskId)` until terminal status;
  - `completed`, `failed`, and `cancelled` mark task `pollState: "done"`;
  - terminal write tasks release `activeWriters[projectId]`;
  - repeated unchanged status backs off up to `pollMaxIntervalMs`;
  - timeout marks `pollState: "timed_out"` and sends a manual status/logs instruction;
  - recovery reloads persisted polling tasks and releases already terminal active writers;
  - stale queued tasks produce a notification recommending `/codex dispatch <taskId>`, `/codex cancel <taskId>`, or manual session inspection.

- [x] **Step 2: Verify red**

  Run:

  ```sh
  node scripts/adapter-poller-test.js
  ```

- [x] **Step 3: Implement poller and recovery**

  Avoid long sleeps in tests. Inject timer functions or use short intervals.

- [x] **Step 4: Extend adapter test script**

  Update:

  ```json
  "adapter:test": "node scripts/adapter-foundation-test.js && node scripts/adapter-handler-test.js && node scripts/adapter-poller-test.js"
  ```

- [x] **Step 5: Verify green**

  Run:

  ```sh
  npm run adapter:verify
  npm run verify
  ```

---

## Task 4: Local Harness CLI and Documentation

**Files:**

- Create: `adapter/index.js`
- Modify: `README.md`
- Modify: `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md` only if the implemented MVP differs from the plan and the spec must be clarified.
- Modify: `package.json`

**Interfaces produced:**

- `node adapter/index.js --config <path> --message '<command-json>'`
- `node adapter/index.js --config <path> --recover`

- [x] **Step 1: Write failing harness tests or scripted checks**

  Use temporary config/state/token files and a mock client mode. Required checks:

  - CLI rejects missing config;
  - CLI accepts a normalized message JSON and prints reply JSON;
  - CLI recovery mode loads state and invokes recovery without needing Zulip/Hermes credentials.

- [x] **Step 2: Implement harness CLI**

  This is not a production daemon. It exists to make adapter core testable before real Zulip/Hermes transport is wired.

- [x] **Step 3: Document MVP use**

  Add a short README section explaining:

  - adapter is not yet deployed;
  - token file requirements;
  - normalized message harness usage;
  - real Zulip/Hermes transport remains a later integration step.

- [x] **Step 4: Verify**

  Run:

  ```sh
  npm run adapter:verify
  npm run verify
  ```

---

## Verification Gates

Run before claiming each task complete:

```sh
npm run adapter:verify
```

Run before claiming the adapter development phase complete:

```sh
npm run adapter:verify
npm run verify
```

Manual checks before any real deployment:

- Token file is outside the repository and mode `0600`.
- Real Runner uses `HCO_AUTH_MODE=token`.
- `GET /tasks/:taskId/raw` is available only through admin-controlled adapter paths.
- Same-project write serialization is tested with two back-to-back `/codex run` commands.
- Multi-project routing is tested with at least two distinct `projectId` values and distinct target bindings.

---

## Non-Goals

- No real Zulip outgoing webhook service in this MVP.
- No real Hermes bot transport in this MVP.
- No distributed lock for multiple adapter instances.
- No Runner-side project write lock.
- No direct source reading or prompt context assembly in the adapter.
- No shell execution, `tmux` control, or direct Codex invocation by the adapter.
- No deployment, LaunchAgent/systemd installation, Tailscale changes, or public exposure.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Adapter and Runner disagree on API shape | Keep Runner client tests pinned to the documented endpoints and run full `npm run verify`. |
| Token leakage | Token is returned separately from config, never serialized, and tests assert no token in user-facing errors. |
| Same-project write race | MVP assumes one adapter instance and persists `activeWriters`; multi-instance deployment remains a non-goal. |
| Wrong project routing | Never infer project from natural language; require explicit route, binding, or configured default. |
| Raw task exposure | Enforce admin-only raw command in adapter tests. |
| Stale writer lock after restart | Recovery checks persisted active writers and releases terminal tasks. |
| Real Zulip/Hermes assumptions | Use normalized message harness first; transport-specific code is deferred. |

---

## Rollback

Because the adapter is additive and Runner files should remain unchanged:

1. Remove `adapter/`.
2. Remove adapter scripts from `package.json`.
3. Remove `config/adapter.json.example` if not needed.
4. Keep `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md` and this plan as design history.
