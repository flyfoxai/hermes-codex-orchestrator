import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadAdapterConfig } from "../adapter/config.js";
import { parseCommand } from "../adapter/commands.js";
import { createRunnerClient } from "../adapter/runner-client.js";
import { resolveProjectId, targetKeyFromMessage } from "../adapter/router.js";
import { checkPermission } from "../adapter/permissions.js";
import { checkWriteGate, releaseActiveWriter, reserveActiveWriter } from "../adapter/write-gate.js";
import { loadState, saveState } from "../adapter/state-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "hco-adapter-foundation-"));
const repoTokenFile = path.join(process.cwd(), ".adapter-test-token-inside-repo");

function assertCode(error, code) {
  assert.equal(error?.code, code, `expected error code ${code}, got ${error?.code}: ${error?.message}`);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

try {
  const tokenFile = path.join(os.tmpdir(), `hco-token-${process.pid}`);
  await writeFile(tokenFile, " foundation-secret \n", "utf8");
  await chmod(tokenFile, 0o600).catch(() => {});

  const statePath = path.join(root, "adapter-state.json");
  const configPath = path.join(root, "adapter.json");
  await writeJson(configPath, {
    runnerBaseUrl: "http://127.0.0.1:8731",
    runnerTokenFile: tokenFile,
    defaultProjectId: "fallback",
    zulipStreamProjectRoutes: {
      "stockprofits": "stockprofits",
      "hermes-runner": "hermes-codex-orchestrator"
    },
    adapterStatePath: statePath
  });

  const loaded = await loadAdapterConfig(configPath);
  assert.equal(loaded.token, "foundation-secret");
  assert.equal(loaded.config.runnerBaseUrl, "http://127.0.0.1:8731");
  assert.equal(loaded.config.pollIntervalMs, 5000);
  assert.equal(loaded.config.pollMaxIntervalMs, 30000);
  assert.equal(loaded.config.taskPollTimeoutMs, 7200000);
  assert.equal(loaded.config.writeTaskPolicy, "reject_when_project_busy");
  assert(!JSON.stringify(loaded.config).includes("foundation-secret"), "token leaked into serializable config");

  const oldZulipConfigPath = path.join(root, "old-zulip-adapter.json");
  await writeJson(oldZulipConfigPath, {
    runnerBaseUrl: "http://127.0.0.1:8731",
    runnerTokenFile: tokenFile,
    zulipProjectRoutes: {
      "dev/stockprofits": "stockprofits"
    }
  });
  await assert.rejects(() => loadAdapterConfig(oldZulipConfigPath), (error) => {
    assertCode(error, "invalid_adapter_config");
    assert.equal(error.details?.field, "zulipProjectRoutes");
    return true;
  });

  await writeFile(repoTokenFile, "bad", "utf8");
  await chmod(repoTokenFile, 0o600).catch(() => {});
  const badConfigPath = path.join(root, "bad-adapter.json");
  await writeJson(badConfigPath, { runnerBaseUrl: "http://127.0.0.1:8731", runnerTokenFile: repoTokenFile });
  await assert.rejects(() => loadAdapterConfig(badConfigPath), (error) => {
    assertCode(error, "token_file_in_repository");
    return true;
  });

  const looseTokenFile = path.join(os.tmpdir(), `hco-token-loose-${process.pid}`);
  await writeFile(looseTokenFile, "loose", "utf8");
  await chmod(looseTokenFile, 0o644).catch(() => {});
  const looseConfigPath = path.join(root, "loose-adapter.json");
  await writeJson(looseConfigPath, { runnerBaseUrl: "http://127.0.0.1:8731", runnerTokenFile: looseTokenFile });
  const looseMode = (await stat(looseTokenFile)).mode & 0o777;
  if ((looseMode & 0o077) !== 0) {
    await assert.rejects(() => loadAdapterConfig(looseConfigPath), (error) => {
      assertCode(error, "token_file_permissions");
      return true;
    });
  }

  let capturedRequest;
  const client = createRunnerClient({
    baseUrl: "http://runner.local",
    token: "foundation-secret",
    fetchImpl: async (url, options) => {
      capturedRequest = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(capturedRequest.url, "http://runner.local/health");
  assert.equal(capturedRequest.options.headers.Authorization, "Bearer foundation-secret");

  const failingClient = createRunnerClient({
    baseUrl: "http://runner.local/",
    token: "foundation-secret",
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "task_not_found", message: "missing" } }), { status: 404 })
  });
  await assert.rejects(() => failingClient.getTask("TASK-1"), (error) => {
    assert.equal(error.status, 404);
    assertCode(error, "task_not_found");
    assert.equal(error.message, "missing");
    return true;
  });

  const unreachableClient = createRunnerClient({
    baseUrl: "http://runner.local",
    token: "foundation-secret",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED foundation-secret");
    }
  });
  await assert.rejects(() => unreachableClient.health(), (error) => {
    assertCode(error, "runner_unreachable");
    assert(!error.message.includes("foundation-secret"), "token leaked into unreachable error");
    return true;
  });

  assert.deepEqual(parseCommand("/codex projects"), { verb: "projects", raw: "/codex projects" });
  assert.deepEqual(parseCommand("/Codex bind stockprofits"), {
    verb: "bind",
    projectId: "stockprofits",
    raw: "/Codex bind stockprofits"
  });
  assert.deepEqual(parseCommand("/codex route show"), {
    verb: "route",
    action: "show",
    raw: "/codex route show"
  });
  assert.deepEqual(parseCommand("/codex route set stockprofits"), {
    verb: "route",
    action: "set",
    projectId: "stockprofits",
    raw: "/codex route set stockprofits"
  });
  assert.deepEqual(parseCommand("/codex route confirm hermes-codex-orchestrator"), {
    verb: "route",
    action: "confirm",
    projectId: "hermes-codex-orchestrator",
    raw: "/codex route confirm hermes-codex-orchestrator"
  });
  assert.deepEqual(parseCommand("/codex route unset"), {
    verb: "route",
    action: "unset",
    raw: "/codex route unset"
  });
  assert.deepEqual(parseCommand("/codex route none"), {
    verb: "route",
    action: "none",
    raw: "/codex route none"
  });
  assert.deepEqual(parseCommand("/codex topic show"), {
    verb: "topic",
    action: "show",
    raw: "/codex topic show"
  });
  assert.deepEqual(parseCommand("/codex topic auto"), {
    verb: "topic",
    action: "auto",
    raw: "/codex topic auto"
  });
  assert.deepEqual(parseCommand("/codex topic hermes"), {
    verb: "topic",
    action: "hermes",
    raw: "/codex topic hermes"
  });
  assert.deepEqual(parseCommand("/codex ask 检查测试失败"), {
    verb: "ask",
    goal: "检查测试失败",
    raw: "/codex ask 检查测试失败"
  });
  assert.deepEqual(parseCommand("/codex run proj-a 修复 bug"), {
    verb: "run",
    projectId: "proj-a",
    goal: "修复 bug",
    raw: "/codex run proj-a 修复 bug"
  });
  assert.deepEqual(parseCommand("/codex run 修复 bug", { inferProjectForRun: true }), {
    verb: "run",
    goal: "修复 bug",
    raw: "/codex run 修复 bug"
  });
  assert.deepEqual(parseCommand("/codex run --project proj-a 修复 bug", { inferProjectForRun: true }), {
    verb: "run",
    projectId: "proj-a",
    goal: "修复 bug",
    raw: "/codex run --project proj-a 修复 bug"
  });
  assert.deepEqual(parseCommand("/codex status HERMES-20260714-X-AB3C"), {
    verb: "status",
    taskId: "HERMES-20260714-X-AB3C",
    raw: "/codex status HERMES-20260714-X-AB3C"
  });
  assert.deepEqual(parseCommand("普通消息"), null);
  assert.equal(parseCommand(`/codex ask ${"a".repeat(3000)}`).goal.length, 2000);
  assert.equal(parseCommand("/codex ask \u0000\u001b[31m注入").goal, "[31m注入");
  assert.throws(() => parseCommand("/codex ask"), (error) => {
    assertCode(error, "invalid_command");
    return true;
  });
  assert.throws(() => parseCommand("/codex run proj-a"), (error) => {
    assertCode(error, "invalid_command");
    return true;
  });
  assert.throws(() => parseCommand("/codex topic"), (error) => {
    assertCode(error, "invalid_command");
    return true;
  });
  assert.throws(() => parseCommand("/codex topic auto extra"), (error) => {
    assertCode(error, "invalid_command");
    return true;
  });

  const state = await loadState(statePath);
  assert.deepEqual(state.bindings, {});
  assert.deepEqual(state.zulipStreamProjectRoutes, {});
  assert.deepEqual(state.zulipGenericStreams, {});
  assert.deepEqual(state.zulipTopicModes, {});
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.activeWriters, {});

  state.bindings["hermes:conv-1"] = "bound-project";
  state.zulipStreamProjectRoutes["调用工作"] = "stockprofits";
  state.zulipGenericStreams["闲聊"] = true;
  await saveState(statePath, state);
  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.bindings["hermes:conv-1"], "bound-project");
  assert.equal(reloadedState.zulipStreamProjectRoutes["调用工作"], "stockprofits");
  assert.equal(reloadedState.zulipGenericStreams["闲聊"], true);
  assert.match(await readFile(statePath, "utf8"), /"updatedAt"/);

  assert.equal(targetKeyFromMessage({ platform: "zulip", stream: "stockprofits", topic: "需求讨论" }), "zulip:stockprofits/需求讨论");
  assert.equal(targetKeyFromMessage({ platform: "hermes", conversationId: "conv-1" }), "hermes:conv-1");
  assert.equal(targetKeyFromMessage({ platform: "feishu", conversationId: "chat-1" }), "feishu:chat-1");

  const routingConfig = loaded.config;
  assert.equal(resolveProjectId({ command: { projectId: "explicit" }, message: {}, config: routingConfig, state: reloadedState }), "explicit");
  assert.equal(
    resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "stockprofits", topic: "需求讨论" },
      config: routingConfig,
      state: reloadedState
    }),
    "stockprofits"
  );
  assert.equal(
    resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "hermes-runner", topic: "发布验证" },
      config: routingConfig,
      state: reloadedState
    }),
    "hermes-codex-orchestrator"
  );
  assert.equal(
    resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "调用工作", topic: "需求讨论" },
      config: routingConfig,
      state: reloadedState
    }),
    "stockprofits"
  );
  assert.throws(
    () => resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "闲聊", topic: "随便聊" },
      config: routingConfig,
      state: reloadedState,
      projects: [{ projectId: "stockprofits" }]
    }),
    (error) => {
      assertCode(error, "route_hermes_owned");
      assert.equal(error.details?.stream, "闲聊");
      return true;
    }
  );
  assert.throws(
    () => resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "abc d", topic: "需求讨论" },
      config: { ...routingConfig, defaultProjectId: undefined },
      state: reloadedState,
      projects: [{ projectId: "abcd" }, { projectId: "stockprofits" }]
    }),
    (error) => {
      assertCode(error, "route_hermes_owned");
      assert.equal(error.details?.stream, "abc d");
      return true;
    }
  );
  assert.throws(
    () => resolveProjectId({
      command: {},
      message: { platform: "zulip", stream: "abc d", topic: "需求讨论" },
      config: { ...routingConfig, defaultProjectId: undefined },
      state: reloadedState,
      projects: []
    }),
    (error) => {
      assertCode(error, "route_hermes_owned");
      assert.equal(error.details?.stream, "abc d");
      return true;
    }
  );
  assert.equal(
    resolveProjectId({
      command: { projectId: "stockprofits" },
      message: { platform: "zulip", stream: "stockprofits", topic: "需求讨论" },
      config: routingConfig,
      state: reloadedState
    }),
    "stockprofits"
  );
  assert.throws(
    () => resolveProjectId({
      command: { projectId: "other" },
      message: { platform: "zulip", stream: "stockprofits", topic: "需求讨论" },
      config: routingConfig,
      state: reloadedState
    }),
    (error) => {
      assertCode(error, "route_project_mismatch");
      assert.equal(error.details?.mappedProjectId, "stockprofits");
      assert.equal(error.details?.requestedProjectId, "other");
      return true;
    }
  );
  assert.equal(
    resolveProjectId({
      command: {},
      message: { platform: "hermes", conversationId: "conv-1" },
      config: { ...routingConfig, defaultProjectId: undefined },
      state: reloadedState
    }),
    "bound-project"
  );
  reloadedState.bindings["feishu:chat-1"] = "feishu-bound";
  assert.equal(
    resolveProjectId({
      command: {},
      message: { platform: "feishu", conversationId: "chat-1" },
      config: { ...routingConfig, defaultProjectId: undefined },
      state: reloadedState
    }),
    "feishu-bound"
  );
  assert.equal(resolveProjectId({ command: {}, message: {}, config: routingConfig, state: reloadedState }), "fallback");
  assert.throws(
    () => resolveProjectId({ command: {}, message: {}, config: { ...routingConfig, defaultProjectId: undefined }, state: { bindings: {} } }),
    (error) => {
      assertCode(error, "route_unbound");
      return true;
    }
  );

  assert.equal(checkPermission({ command: { verb: "raw" }, user: { role: "member", id: "u1" } }).allowed, false);
  assert.equal(checkPermission({ command: { verb: "run" }, user: { role: "member", id: "u1" } }).allowed, false);
  assert.equal(checkPermission({ command: { verb: "topic", action: "hermes" }, user: { role: "member", id: "u1" } }).allowed, true);
  assert.equal(checkPermission({ command: { verb: "raw" }, user: { role: "maintainer", id: "u1" } }).allowed, false);
  assert.equal(checkPermission({ command: { verb: "raw" }, user: { role: "admin", id: "u1" } }).allowed, true);
  assert.equal(
    checkPermission({ command: { verb: "cancel" }, user: { role: "member", id: "u1" }, taskRecord: { requestedByUserId: "u1" } }).allowed,
    true
  );
  assert.equal(
    checkPermission({ command: { verb: "cancel" }, user: { role: "member", id: "u1" }, taskRecord: { requestedByUserId: "u2" } }).allowed,
    false
  );

  const gateState = { bindings: {}, tasks: {}, activeWriters: {}, updatedAt: new Date().toISOString() };
  assert.deepEqual(checkWriteGate(gateState, "proj-a"), { blocked: false });
  reserveActiveWriter(gateState, "proj-a", "TASK-1", { userId: "u1" });
  assert.deepEqual(checkWriteGate(gateState, "proj-a"), { blocked: true, activeTaskId: "TASK-1" });
  assert.deepEqual(checkWriteGate(gateState, "proj-b"), { blocked: false });
  releaseActiveWriter(gateState, "proj-a", "TASK-1");
  assert.deepEqual(checkWriteGate(gateState, "proj-a"), { blocked: false });

  console.log("adapter foundation ok");
} finally {
  await rm(repoTokenFile, { force: true });
  await rm(root, { recursive: true, force: true });
}
