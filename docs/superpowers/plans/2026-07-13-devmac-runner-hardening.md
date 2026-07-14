# Devmac Runner Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Runner MVP 推进到可验证的 devmac 远程执行链路，并让 HTTP API、任务文件、tmux dispatch 和文档保持一致。

**Architecture:** 保留 Node.js HTTP Runner、项目目录任务文件和 tmux/Codex dispatch 的边界。通过集中式请求校验和任务原文读取接口补足 API 契约；dispatch 使用可配置命令、临时 prompt 文件和明确的失败状态，避免把错误静默留在 tmux 中。

**Tech Stack:** Node.js 20+、Node built-in `http`/`fs`/`child_process`、tmux（macOS/Linux）、Codex CLI。

## Global Constraints

- 项目路径只能通过 API/配置注册，不能写死到代码。
- Runner 默认只监听 `127.0.0.1:8731`。
- Windows 支持 HTTP API 和任务文件，不支持 MVP tmux dispatch。
- 日志和错误响应不得泄露 token、API key 或 Authorization header。
- 项目文件和 `<project>/.hermes/tasks/*.md` 是事实源。
- 取消任务不得杀掉整台机器上的 Codex 或 tmux 进程。

### Task 1: Add failing API contract tests

**Files:**
- Create: `scripts/contract-test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runner/http.js` via `startServer()` and temporary `HCO_*` configuration.
- Produces: repeatable contract checks for validation, raw task reads, auth, and dispatch error responses.

- [x] **Step 1: Write failing tests** for missing `projectId`/`goal`, invalid project registration, `GET /tasks/:taskId/raw`, and token redaction.
- [x] **Step 2: Run `node scripts/contract-test.js` and verify it fails on the missing endpoints/validation.**
- [x] **Step 3: Keep tests isolated with a temporary projects config and temporary project directory.**

### Task 2: Harden request validation and task APIs

**Files:**
- Modify: `runner/config.js`
- Modify: `runner/task-store.js`
- Modify: `runner/http.js`

**Interfaces:**
- Consumes: JSON request bodies and existing task metadata.
- Produces: 400 `invalid_request` responses, `GET /tasks/:taskId/raw`, bounded numeric query parameters, and consistent task summaries including result fields.

- [x] **Step 1: Implement explicit validation helpers for project and task payloads.**
- [x] **Step 2: Add raw task file reading without exposing unrelated files.**
- [x] **Step 3: Normalize limit parsing and route errors through the existing error envelope.**
- [x] **Step 4: Run the contract test and existing smoke test.**

### Task 3: Make tmux/Codex dispatch observable and robust

**Files:**
- Modify: `runner/tmux.js`
- Modify: `runner/codex.js`
- Modify: `runner/task-store.js`
- Modify: `config/orchestrator.json`

**Interfaces:**
- Consumes: registered project metadata and rendered dispatch prompt.
- Produces: deterministic tmux session startup, configurable Codex command, safe prompt-file dispatch, and `failed` task state plus log entry when dispatch fails.

- [x] **Step 1: Add a failing dispatch integration case using a temporary fake Codex executable.**
- [x] **Step 2: Implement prompt-file based dispatch and explicit readiness/error handling.**
- [x] **Step 3: Verify queued state, task file updates, session discovery, and failure behavior.**

### Task 4: Align documentation and run devmac-equivalent verification

**Files:**
- Modify: `HTTP_API_INTEGRATION.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/STATUS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: final implemented routes and response shapes.
- Produces: documented raw task endpoint, validation behavior, dispatch diagnostics, and reproducible verification commands.

- [x] **Step 1: Update API tables/examples to match implementation.**
- [x] **Step 2: Run `npm run check`, `npm run smoke`, `node scripts/contract-test.js`, and a temporary tmux dispatch verification.**
- [x] **Step 3: Confirm the real `config/projects.json` remains unchanged.**
