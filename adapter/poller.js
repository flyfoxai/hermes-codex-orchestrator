import { loadState, saveState } from "./state-store.js";
import { releaseActiveWriter } from "./write-gate.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function asDate(value) {
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? new Date() : result;
}

function currentDate(now) {
  return asDate(now());
}

function sleep(setTimer, delay) {
  return new Promise((resolve) => setTimer(resolve, delay));
}

function timeoutText(taskId) {
  return `任务 ${taskId} 轮询超时。请使用 /codex status ${taskId} 或 /codex logs ${taskId} 手动查看。`;
}

function terminalText(task) {
  const summary = task.resultSummary ? `\n${task.resultSummary}` : "";
  return `任务 ${task.taskId}: ${task.status}${summary}`;
}

function staleQueuedText(taskId) {
  return `任务 ${taskId} 长时间处于 queued/pending。可尝试 /codex dispatch ${taskId}、/codex cancel ${taskId}，或人工检查 tmux session。`;
}

async function updateTaskRecord(statePath, taskId, updater) {
  const state = await loadState(statePath);
  const record = state.tasks[taskId];
  if (!record) return { state, record: null };
  updater(record, state);
  await saveState(statePath, state);
  return { state, record };
}

export function createTaskPoller({
  client,
  config,
  statePath,
  notify,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const timers = new Map();

  async function pollTask(taskId) {
    let delay = config.pollIntervalMs;
    let lastStatus = null;

    while (true) {
      const state = await loadState(statePath);
      const record = state.tasks[taskId];
      if (!record || record.pollState !== "polling") return;

      const task = await client.getTask(taskId);
      const timestamp = currentDate(now);
      record.runnerStatus = task.status;
      record.updatedAt = timestamp.toISOString();

      if (TERMINAL_STATUSES.has(task.status)) {
        record.pollState = "done";
        if (record.allowCodeChanges && record.projectId) {
          releaseActiveWriter(state, record.projectId, taskId);
        }
        await saveState(statePath, state);
        await notify({
          type: "terminal",
          taskId,
          projectId: task.projectId ?? record.projectId,
          status: task.status,
          targetKey: record.targetKey,
          text: terminalText(task)
        });
        return;
      }

      const createdAt = asDate(record.createdAt);
      if (timestamp.getTime() - createdAt.getTime() >= config.taskPollTimeoutMs) {
        record.pollState = "timed_out";
        await saveState(statePath, state);
        await notify({
          type: "timeout",
          taskId,
          projectId: record.projectId,
          status: task.status,
          targetKey: record.targetKey,
          text: timeoutText(taskId)
        });
        return;
      }

      await saveState(statePath, state);
      const nextDelay = task.status === lastStatus ? Math.min(delay * 2, config.pollMaxIntervalMs) : config.pollIntervalMs;
      lastStatus = task.status;
      delay = nextDelay;
      await sleep((fn, ms) => {
        const timer = setTimer(fn, ms);
        timers.set(taskId, timer);
        return timer;
      }, delay);
    }
  }

  function stop(taskId) {
    const timer = timers.get(taskId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(taskId);
  }

  return { pollTask, stop };
}

export async function recoverPolling({ client, config, statePath, notify, now = () => new Date() }) {
  const state = await loadState(statePath);
  for (const [taskId, record] of Object.entries(state.tasks)) {
    if (record.pollState !== "polling") continue;
    const task = await client.getTask(taskId);
    const timestamp = currentDate(now);
    const ageMs = timestamp.getTime() - asDate(record.createdAt).getTime();
    const staleThresholdMs = Math.max(config.pollMaxIntervalMs * 2, config.pollIntervalMs * 3);

    if (TERMINAL_STATUSES.has(task.status)) {
      await updateTaskRecord(statePath, taskId, (latestRecord, latestState) => {
        latestRecord.runnerStatus = task.status;
        latestRecord.pollState = "done";
        latestRecord.updatedAt = timestamp.toISOString();
        if (latestRecord.allowCodeChanges && latestRecord.projectId) {
          releaseActiveWriter(latestState, latestRecord.projectId, taskId);
        }
      });
      await notify({
        type: "terminal",
        taskId,
        projectId: task.projectId ?? record.projectId,
        status: task.status,
        targetKey: record.targetKey,
        text: terminalText(task)
      });
      continue;
    }

    if ((task.status === "queued" || task.status === "pending") && ageMs >= staleThresholdMs) {
      await updateTaskRecord(statePath, taskId, (latestRecord) => {
        latestRecord.runnerStatus = task.status;
        latestRecord.updatedAt = timestamp.toISOString();
      });
      await notify({
        type: "stale_queued",
        taskId,
        projectId: record.projectId,
        status: task.status,
        targetKey: record.targetKey,
        text: staleQueuedText(taskId)
      });
    }
  }
}
