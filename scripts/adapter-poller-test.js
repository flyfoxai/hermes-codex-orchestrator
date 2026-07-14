import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTaskPoller, recoverPolling } from "../adapter/poller.js";
import { loadState } from "../adapter/state-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "hco-adapter-poller-"));
const statePath = path.join(root, "adapter-state.json");

function iso(ms) {
  return new Date(ms).toISOString();
}

function createTimers() {
  const delays = [];
  return {
    delays,
    setTimer: (fn, delay) => {
      delays.push(delay);
      queueMicrotask(fn);
      return delay;
    },
    clearTimer: () => {}
  };
}

function createClient(statuses) {
  let index = 0;
  const calls = [];
  return {
    calls,
    getTask: async (taskId) => {
      calls.push(taskId);
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return { taskId, projectId: "stockprofits", status, resultSummary: status === "completed" ? "done" : null };
    }
  };
}

try {
  const start = Date.parse("2026-07-14T12:00:00.000Z");
  const firstState = {
    bindings: {},
    tasks: {
      "TASK-1": {
        taskId: "TASK-1",
        projectId: "stockprofits",
        allowCodeChanges: true,
        pollState: "polling",
        createdAt: iso(start),
        updatedAt: iso(start),
        targetKey: "zulip:dev/stockprofits"
      }
    },
    activeWriters: {
      stockprofits: { taskId: "TASK-1", userId: "u1" }
    },
    updatedAt: iso(start)
  };
  await writeFile(statePath, `${JSON.stringify(firstState, null, 2)}\n`, "utf8");

  const timers = createTimers();
  const notify = [];
  const poller = createTaskPoller({
    client: createClient(["queued", "queued", "completed"]),
    config: {
      pollIntervalMs: 10,
      pollMaxIntervalMs: 40,
      taskPollTimeoutMs: 1000
    },
    statePath,
    notify: async (payload) => notify.push(payload),
    now: (() => {
      let value = start;
      return () => {
        value += 100;
        return new Date(value);
      };
    })(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  await poller.pollTask("TASK-1");
  const completedState = await loadState(statePath);
  assert.equal(completedState.tasks["TASK-1"].pollState, "done");
  assert.equal(completedState.tasks["TASK-1"].runnerStatus, "completed");
  assert.equal(completedState.activeWriters.stockprofits, undefined);
  assert(timers.delays.length >= 2, "poller should schedule backoff delays");
  assert.match(JSON.stringify(notify.at(-1)), /completed/);

  const timeoutState = {
    bindings: {},
    tasks: {
      "TASK-2": {
        taskId: "TASK-2",
        projectId: "stockprofits",
        allowCodeChanges: true,
        pollState: "polling",
        createdAt: iso(start - 10_000),
        updatedAt: iso(start - 10_000),
        targetKey: "zulip:dev/stockprofits"
      }
    },
    activeWriters: {
      stockprofits: { taskId: "TASK-2", userId: "u1" }
    },
    updatedAt: iso(start - 10_000)
  };
  await writeFile(statePath, `${JSON.stringify(timeoutState, null, 2)}\n`, "utf8");

  const timeoutNotify = [];
  const timeoutPoller = createTaskPoller({
    client: createClient(["running", "running", "running", "running"]),
    config: {
      pollIntervalMs: 10,
      pollMaxIntervalMs: 40,
      taskPollTimeoutMs: 150
    },
    statePath,
    notify: async (payload) => timeoutNotify.push(payload),
    now: (() => {
      let value = start;
      return () => {
        value += 100;
        return new Date(value);
      };
    })(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await timeoutPoller.pollTask("TASK-2");
  const timedOutState = await loadState(statePath);
  assert.equal(timedOutState.tasks["TASK-2"].pollState, "timed_out");
  assert.match(JSON.stringify(timeoutNotify.at(-1)), /status|logs/);

  const recoveryState = {
    bindings: {},
    tasks: {
      "TASK-3": {
        taskId: "TASK-3",
        projectId: "stockprofits",
        allowCodeChanges: true,
        pollState: "polling",
        createdAt: iso(start - 10_000),
        updatedAt: iso(start - 10_000),
        targetKey: "zulip:dev/stockprofits"
      }
    },
    activeWriters: {
      stockprofits: { taskId: "TASK-3", userId: "u1" }
    },
    updatedAt: iso(start - 10_000)
  };
  await writeFile(statePath, `${JSON.stringify(recoveryState, null, 2)}\n`, "utf8");
  const recoveryNotify = [];
  await recoverPolling({
    client: createClient(["queued"]),
    config: {
      pollIntervalMs: 10,
      pollMaxIntervalMs: 40,
      taskPollTimeoutMs: 1000
    },
    statePath,
    notify: async (payload) => recoveryNotify.push(payload)
  });
  assert.match(JSON.stringify(recoveryNotify.at(-1)), /dispatch|cancel|queued/);

  console.log("adapter poller ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
