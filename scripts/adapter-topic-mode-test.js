import assert from "node:assert/strict";

const topicMode = await import("../adapter/topic-mode.js").catch(() => null);
assert(topicMode, "adapter/topic-mode.js must exist");

const {
  TOPIC_MODES,
  bindTopicTask,
  clearTopicModesForStream,
  getTopicMode,
  getTopicRecord,
  setTopicMode
} = topicMode;

const message = {
  platform: "zulip",
  stream: "stockprofits",
  topic: "需求讨论",
  messageId: "m1",
  user: { id: "u1", role: "member" }
};
const state = { zulipTopicModes: {} };
const actor = { userId: "u1", source: "zulip", messageId: "m1" };

assert.deepEqual(TOPIC_MODES, {
  AUTO: "AUTO",
  CODEX_BOUND: "CODEX_BOUND",
  HERMES_ONLY: "HERMES_ONLY"
});
assert.equal(getTopicMode(state, { message, projectId: "stockprofits" }), "AUTO");
assert.equal(getTopicRecord(state, { message, projectId: "stockprofits" }), null);

let result = bindTopicTask(state, {
  message,
  projectId: "stockprofits",
  taskId: "TASK-1",
  actor,
  now: "2026-07-15T10:00:00.000Z"
});
assert.equal(result.previousMode, "AUTO");
assert.equal(result.record.mode, "CODEX_BOUND");
assert.equal(result.record.taskId, "TASK-1");
assert.equal(result.record.lastTaskId, "TASK-1");
assert.equal(result.record.updatedBy.userId, "u1");
assert.equal(result.record.threadId, undefined);

result = setTopicMode(state, {
  message,
  projectId: "stockprofits",
  mode: "HERMES_ONLY",
  actor,
  now: "2026-07-15T10:01:00.000Z"
});
assert.equal(result.previousMode, "CODEX_BOUND");
assert.equal(result.previousTaskId, "TASK-1");
assert.equal(result.changed, true);
assert.equal(result.record.mode, "HERMES_ONLY");
assert.equal(result.record.taskId, undefined);
assert.equal(result.record.lastTaskId, "TASK-1");

const unchangedAt = result.record.updatedAt;
result = setTopicMode(state, {
  message,
  projectId: "stockprofits",
  mode: "HERMES_ONLY",
  actor: { ...actor, messageId: "m2" },
  now: "2026-07-15T10:02:00.000Z"
});
assert.equal(result.changed, false);
assert.equal(result.record.updatedAt, unchangedAt);

assert.throws(
  () => bindTopicTask(state, {
    message,
    projectId: "stockprofits",
    taskId: "TASK-2",
    actor,
    now: "2026-07-15T10:03:00.000Z"
  }),
  (error) => error?.code === "topic_hermes_only"
);

result = setTopicMode(state, {
  message,
  projectId: "stockprofits",
  mode: "AUTO",
  actor,
  now: "2026-07-15T10:04:00.000Z"
});
assert.equal(result.record.mode, "AUTO");
assert.equal(result.record.lastTaskId, "TASK-1");
assert.equal(getTopicMode(state, { message, projectId: "other" }), "AUTO", "stale project topic state must be ignored");

assert.throws(
  () => setTopicMode(state, { message, projectId: "stockprofits", mode: "CODEX_BOUND", actor }),
  (error) => error?.code === "invalid_topic_mode"
);
assert.throws(
  () => bindTopicTask(state, { message, projectId: "stockprofits", taskId: "", actor }),
  (error) => error?.code === "invalid_task_reference"
);

state.zulipTopicModes["zulip:other/topic"] = {
  mode: "HERMES_ONLY",
  projectId: "other",
  stream: "other",
  topic: "topic"
};
assert.equal(clearTopicModesForStream(state, " STOCKPROFITS "), 1);
assert.equal(state.zulipTopicModes["zulip:stockprofits/需求讨论"], undefined);
assert.equal(state.zulipTopicModes["zulip:other/topic"].mode, "HERMES_ONLY");

console.log("adapter topic mode ok");
