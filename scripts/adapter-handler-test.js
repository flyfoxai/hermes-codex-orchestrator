import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { handleMessage } from "../adapter/handler.js";
import { loadState, saveState } from "../adapter/state-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "hco-adapter-handler-"));
const statePath = path.join(root, "adapter-state.json");

function message(text, overrides = {}) {
  return {
    platform: "zulip",
    stream: "stockprofits",
    topic: "需求讨论",
    text,
    user: { id: "u1", role: "member" },
    messageId: "m1",
    receivedAt: "2026-07-14T12:00:00.000Z",
    ...overrides
  };
}

function createMockClient(options = {}) {
  const calls = [];
  const projects = options.projects ?? [
    {
      projectId: "stockprofits",
      name: "Stock Profits",
      path: "/Users/hula/Projects/stockprofits",
      tmuxSession: "codex-stockprofits"
    },
    {
      projectId: "other",
      name: "Other",
      path: "/Users/hula/Projects/other",
      tmuxSession: "codex-other"
    },
    {
      projectId: "abcd",
      name: "ABC D",
      path: "/Users/hula/Projects/abcd",
      tmuxSession: "codex-abcd"
    },
    {
      projectId: "abc",
      name: "ABC",
      path: "/Users/hula/Projects/abc",
      tmuxSession: "codex-abc"
    }
  ];
  const client = {
    calls,
    projects: async () => {
      calls.push({ method: "projects" });
      return { projects };
    },
    createTask: async (body) => {
      calls.push({ method: "createTask", body });
      return {
        taskId: body.allowCodeChanges ? "TASK-WRITE" : "TASK-READ",
        projectId: body.projectId,
        status: "queued",
        goal: body.goal
      };
    },
    getTask: async (taskId) => {
      calls.push({ method: "getTask", taskId });
      return { taskId, projectId: "stockprofits", status: "running", resultSummary: null };
    },
    getLogs: async (taskId, params) => {
      calls.push({ method: "getLogs", taskId, params });
      return { task: { taskId, projectId: "stockprofits", status: "running" }, logs: [{ level: "info", message: "ok" }] };
    },
    getRaw: async (taskId) => {
      calls.push({ method: "getRaw", taskId });
      return { content: "raw-secret-content" };
    },
    cancel: async (taskId, body) => {
      calls.push({ method: "cancel", taskId, body });
      return { taskId, projectId: "stockprofits", status: "cancelled" };
    },
    dispatch: async (taskId) => {
      calls.push({ method: "dispatch", taskId });
      return { taskId, projectId: "stockprofits", status: "queued" };
    },
    sessions: async () => {
      calls.push({ method: "sessions" });
      return { sessions: [{ projectId: "stockprofits", tmuxSession: "codex-stockprofits", exists: true }] };
    }
  };
  return client;
}

function context(client = createMockClient()) {
  return {
    client,
    statePath,
    config: {
      defaultProjectId: undefined,
      zulipStreamProjectRoutes: { stockprofits: "stockprofits" },
      writeTaskPolicy: "reject_when_project_busy"
    },
    now: () => "2026-07-14T12:00:00.000Z"
  };
}

try {
  assert.deepEqual(await handleMessage(message("普通消息"), context()), []);

  let client = createMockClient();
  let replies = await handleMessage(message("/codex projects"), context(client));
  assert.equal(client.calls[0].method, "projects");
  assert.match(replies[0].text, /stockprofits/);
  assert(!replies[0].text.includes("/Users/hula/Projects"), "project paths must not be shown in project list reply");

  client = createMockClient();
  replies = await handleMessage(message("/codex bind stockprofits"), context(client));
  assert.match(replies[0].text, /频道映射项目|无需.*bind/);
  assert.equal((await loadState(statePath)).bindings["zulip:stockprofits/需求讨论"], undefined);

  client = createMockClient();
  replies = await handleMessage(message("/codex ask 检查新频道", { stream: "abc d" }), context(client));
  assert.equal(client.calls.at(-1).method, "projects");
  assert.equal(client.calls.some((call) => call.method === "createTask"), false);
  assert.match(replies[0].text, /没有关联到已注册项目/);
  assert.match(replies[0].text, /abcd/);
  assert.match(replies[0].text, /\/codex route confirm abcd/);

  client = createMockClient();
  replies = await handleMessage(message("/codex route confirm abcd", { stream: "abc d" }), context(client));
  assert.equal(client.calls.length, 0);
  assert.match(replies[0].text, /权限不足/);

  client = createMockClient();
  replies = await handleMessage(message("/codex route confirm abcd", { stream: "abc d", user: { id: "maintainer-1", role: "maintainer" } }), context(client));
  assert.match(replies[0].text, /已将 Zulip 频道.*abc d.*关联到 projectId=abcd/);
  assert.equal((await loadState(statePath)).zulipStreamProjectRoutes["abc d"], "abcd");

  client = createMockClient();
  replies = await handleMessage(message("/codex ask 检查已确认频道", { stream: "abc d" }), context(client));
  assert.equal(client.calls.at(-1).method, "createTask");
  assert.equal(client.calls.at(-1).body.projectId, "abcd");
  assert.match(replies[0].text, /TASK-READ/);

  client = createMockClient();
  replies = await handleMessage(message("/codex route set abc", { stream: "调用工作", user: { id: "maintainer-1", role: "maintainer" } }), context(client));
  assert.match(replies[0].text, /已将 Zulip 频道.*调用工作.*关联到 projectId=abc/);
  assert.equal((await loadState(statePath)).zulipStreamProjectRoutes["调用工作"], "abc");

  client = createMockClient();
  replies = await handleMessage(message("/codex route none", { stream: "闲聊", user: { id: "maintainer-1", role: "maintainer" } }), context(client));
  assert.match(replies[0].text, /通用对话|不关联项目/);
  assert.equal((await loadState(statePath)).zulipGenericStreams["闲聊"], true);

  client = createMockClient();
  replies = await handleMessage(message("/codex ask 不需要项目", { stream: "闲聊" }), context(client));
  assert.equal(client.calls.some((call) => call.method === "createTask"), false);
  assert.match(replies[0].text, /通用对话|不会创建 Codex Runner 任务/);

  client = createMockClient();
  replies = await handleMessage(
    message("/codex bind stockprofits", { platform: "feishu", conversationId: "chat-1", stream: undefined, topic: undefined }),
    context(client)
  );
  assert.match(replies[0].text, /已绑定/);
  assert.equal((await loadState(statePath)).bindings["feishu:chat-1"], "stockprofits");

  client = createMockClient();
  replies = await handleMessage(message("/codex ask 检查测试失败"), context(client));
  assert.equal(client.calls.at(-1).method, "createTask");
  assert.equal(client.calls.at(-1).body.allowCodeChanges, false);
  assert.equal(client.calls.at(-1).body.dispatch, true);
  assert.equal(client.calls.at(-1).body.requestedBy.source, "zulip");
  assert.match(replies[0].text, /TASK-READ/);

  client = createMockClient();
  replies = await handleMessage(
    message("/codex run 修复 bug", { user: { id: "maintainer-1", role: "maintainer" } }),
    context(client)
  );
  assert.equal(client.calls.at(-1).body.allowCodeChanges, true);
  assert.equal(client.calls.at(-1).body.projectId, "stockprofits");
  assert.match(replies[0].text, /TASK-WRITE/);
  assert.equal((await loadState(statePath)).activeWriters.stockprofits.taskId, "TASK-WRITE");

  client = createMockClient();
  replies = await handleMessage(
    message("/codex run --project other 修复另一个项目", { user: { id: "maintainer-1", role: "maintainer" } }),
    context(client)
  );
  assert.equal(client.calls.at(-1).body.allowCodeChanges, true);
  assert.equal(client.calls.at(-1).body.projectId, "other");
  assert.equal(client.calls.at(-1).body.goal, "修复另一个项目");

  client = createMockClient();
  replies = await handleMessage(
    message("/codex run abcd 修复 Feishu bug", {
      platform: "feishu",
      conversationId: "chat-2",
      stream: undefined,
      topic: undefined,
      user: { id: "maintainer-1", role: "maintainer" }
    }),
    context(client)
  );
  assert.equal(client.calls.at(-1).body.projectId, "abcd");
  assert.equal(client.calls.at(-1).body.goal, "修复 Feishu bug");
  assert.equal(replies[0].targetKey, "feishu:chat-2");

  client = createMockClient({ projects: [{ projectId: "stockprofits" }] });
  replies = await handleMessage(
    message("/codex run nonexistent-project 修复未知项目", {
      platform: "feishu",
      conversationId: "chat-3",
      stream: undefined,
      topic: undefined,
      user: { id: "maintainer-1", role: "maintainer" }
    }),
    context(client)
  );
  assert.equal(client.calls.some((call) => call.method === "createTask"), false);
  assert.match(replies[0].text, /找不到项目 nonexistent-project/);

  replies = await handleMessage(message("/codex run stockprofits 再修一个 bug"), context(createMockClient()));
  assert.match(replies[0].text, /权限不足|permission/i);

  replies = await handleMessage(
    message("/codex run 第二个写任务", { user: { id: "maintainer-2", role: "maintainer" } }),
    context(createMockClient())
  );
  assert.match(replies[0].text, /已有活跃写任务|project_busy/);

  client = createMockClient();
  replies = await handleMessage(message("/codex status TASK-READ"), context(client));
  assert.equal(client.calls.at(-1).method, "getTask");
  assert.match(replies[0].text, /running/);

  client = createMockClient();
  replies = await handleMessage(message("/codex logs TASK-READ"), context(client));
  assert.equal(client.calls.at(-1).method, "getLogs");
  assert.match(replies[0].text, /ok/);

  client = createMockClient();
  replies = await handleMessage(message("/codex raw TASK-READ"), context(client));
  assert.equal(client.calls.length, 0);
  assert.match(replies[0].text, /权限不足/);

  client = createMockClient();
  replies = await handleMessage(message("/codex raw TASK-READ", { user: { id: "admin-1", role: "admin" } }), context(client));
  assert.equal(client.calls.at(-1).method, "getRaw");
  assert.match(replies[0].text, /raw-secret-content/);

  await saveState(statePath, {
    ...(await loadState(statePath)),
    tasks: { "TASK-READ": { requestedByUserId: "u1", projectId: "stockprofits" } }
  });

  client = createMockClient();
  replies = await handleMessage(message("/codex cancel TASK-READ"), context(client));
  assert.equal(client.calls.at(-1).method, "cancel");
  assert.match(replies[0].text, /cancelled/);

  client = createMockClient();
  replies = await handleMessage(message("/codex dispatch TASK-READ", { user: { id: "maintainer-1", role: "maintainer" } }), context(client));
  assert.equal(client.calls.at(-1).method, "dispatch");
  assert.match(replies[0].text, /queued/);

  client = createMockClient();
  replies = await handleMessage(message("/codex sessions"), context(client));
  assert.equal(client.calls.at(-1).method, "sessions");
  assert.match(replies[0].text, /codex-stockprofits/);

  console.log("adapter handler ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
