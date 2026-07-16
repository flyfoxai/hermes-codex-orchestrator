# Zulip Channel And Topic Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deterministic Zulip stream ownership, persistent topic modes, explicit topic commands, and the structured Hermes `CONTROL` receiving contract.

**Architecture:** Stream routing remains in `adapter/router.js`; a focused `adapter/topic-mode.js` owns the pure state machine; `adapter/semantic-control.js` validates and persists upstream Hermes control decisions. `adapter/handler.js` connects commands and successful Runner task creation to those APIs without claiming App Server continuation.

**Tech Stack:** Node.js 20 ESM, `node:assert/strict`, JSON state files, existing Adapter/Runner HTTP client.

## Global Constraints

- A project mapping must be explicit; stream-name similarity never selects a project.
- Unmapped Zulip streams are Hermes-owned and cannot dispatch Codex work.
- Natural language is interpreted upstream exactly once; HCO accepts only structured `CONTROL` data.
- Store only real Runner task IDs. Do not create `threadId` or claim context continuation.
- Preserve unrelated changes in the dirty worktree and do not create a commit.

---

### Task 1: Lock the command, routing, and state contracts with failing tests

**Files:**
- Modify: `scripts/adapter-foundation-test.js`
- Modify: `scripts/adapter-handler-test.js`
- Create: `scripts/adapter-topic-mode-test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `parseCommand`, `resolveProjectId`, `loadState`, and `handleMessage` APIs.
- Produces: executable expectations for `getTopicMode`, `setTopicMode`, `bindTopicTask`, and `applySemanticControl`.

- [ ] **Step 1: Add parser and route expectations**

Add assertions for all three `/codex topic` commands, mapped-project assertion,
cross-project rejection, no stream-name inference, and `route_hermes_owned`.

- [ ] **Step 2: Add topic state-machine expectations**

Create `scripts/adapter-topic-mode-test.js` with `AUTO` default, task binding,
Hermes-only preservation, idempotency, stale-project isolation, and invalid
transition cases.

- [ ] **Step 3: Add handler and semantic-control expectations**

Cover explicit show/auto/hermes, member access to the current topic, dispatch
blocking, `CODEX_BOUND` persistence after task creation, strict structured
control validation, and Hermes-owned stream rejection.

- [ ] **Step 4: Run the tests and verify RED**

Run: `node scripts/adapter-foundation-test.js`

Run: `node scripts/adapter-topic-mode-test.js`

Run: `node scripts/adapter-handler-test.js`

Expected: failures caused by missing topic APIs and old routing behavior.

### Task 2: Implement strict routing and the topic state machine

**Files:**
- Modify: `adapter/router.js`
- Modify: `adapter/state-store.js`
- Modify: `adapter/types.js`
- Create: `adapter/topic-mode.js`
- Modify: `adapter/commands.js`
- Modify: `adapter/permissions.js`

**Interfaces:**
- Produces: `resolveZulipStreamProjectId`, `getTopicMode`, `setTopicMode`, `bindTopicTask`, `clearTopicModesForStream`, and parsed `{ verb: "topic", action }` commands.

- [ ] **Step 1: Add normalized topic state storage**

Load missing `zulipTopicModes` as `{}` and document the record in JSDoc.

- [ ] **Step 2: Add pure topic transitions**

Implement `AUTO`, `CODEX_BOUND`, and `HERMES_ONLY` with real task references,
audit metadata, idempotency, and stale-project isolation.

- [ ] **Step 3: Make Zulip routing explicit**

Resolve only configured/persisted mappings, preserve the explicit generic
override, and reject mismatched `--project` assertions.

- [ ] **Step 4: Add commands and permissions**

Parse `topic show|auto|hermes`; allow authenticated members to control only the
current message topic while preserving existing task permissions.

- [ ] **Step 5: Run foundation and topic tests and verify GREEN**

Run: `node scripts/adapter-foundation-test.js && node scripts/adapter-topic-mode-test.js`

Expected: both scripts print their `ok` line and exit 0.

### Task 3: Add semantic control and handler integration

**Files:**
- Create: `adapter/semantic-control.js`
- Modify: `adapter/handler.js`
- Modify: `scripts/adapter-check.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `applySemanticControl({ control, message, config, statePath, now }) -> Promise<TopicControlResult>`.
- Consumes: topic-mode transitions, strict stream routing, permission checks, and state persistence.

- [ ] **Step 1: Implement fail-closed structured control validation**

Accept only `CONTROL + SET_TOPIC_MODE + AUTO|HERMES_ONLY`; return a structured
previous/new mode result and throw `model_protocol_error` for malformed input.

- [ ] **Step 2: Connect explicit commands**

Show the effective topic mode and use the same semantic transition path for
`topic auto|hermes`, including the non-cancellation warning.

- [ ] **Step 3: Guard task dispatch and bind successful tasks**

Reject ask/run in `HERMES_ONLY` or Hermes-owned streams. After successful task
creation, persist both the task record and `CODEX_BOUND` with the real task ID.

- [ ] **Step 4: Clear stale topic modes on route changes**

When a runtime route is set, removed, or marked Hermes-owned, remove topic
records belonging to that stream.

- [ ] **Step 5: Run all adapter tests and verify GREEN**

Run: `npm run adapter:verify`

Expected: syntax checks and all adapter scripts exit 0.

### Task 4: Update operator and architecture documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/JARVIS_HERMES_QUICKSTART.md`
- Modify: `docs/adr/0001-zulip-trusted-execution-scope.md`
- Modify: `docs/adr/0002-hermes-codex-context-handoff.md`
- Modify: `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`

**Interfaces:**
- Documents: the commands, natural-language caller contract, migration, and current Runner/App Server boundary.

- [ ] **Step 1: Replace confirmation and cross-project guidance**

State that unmapped streams are Hermes-owned and that `--project` can only
assert the existing stream mapping.

- [ ] **Step 2: Document topic modes and both control paths**

Include the three commands, example natural-language `CONTROL` object, and the
fact that entering Hermes-only does not cancel work.

- [ ] **Step 3: Record the backend limitation**

Explain that `taskId` is persisted today while `threadId` and true context
continuation wait for App Server integration.

### Task 5: Final verification and diff audit

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces: fresh evidence for completion claims.

- [ ] **Step 1: Run complete checks**

Run: `npm run adapter:verify && npm run verify`

Expected: every command exits 0.

- [ ] **Step 2: Check patch hygiene**

Run: `git diff --check`

Run: `rg -n "threadId|route_confirmation_required|临时跨项目|相似项目" README.md docs adapter scripts`

Expected: no whitespace errors; any remaining matches are historical analysis
or explicitly marked deferred behavior rather than active instructions.

- [ ] **Step 3: Review the final diff**

Run: `git diff --stat && git status --short`

Expected: only scoped implementation/docs plus pre-existing user changes; no
secret values or generated runtime state.
