import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  executionBackendError,
  requestMayHaveBeenWritten,
  validateExecutionBackend
} from "../hco/execution/backend.js";
import { createAppServerBackend } from "../hco/execution/app-server-backend.js";
import { createTmuxBackend } from "../hco/execution/tmux-backend.js";
import { reduceTerminalOutput } from "../hco/recovery.js";
import { isStateError } from "../hco/state/reducer.js";
import { openStore } from "../hco/state/store.js";
import { TurnController } from "../hco/turn-controller.js";

const START_MS = 1_700_000_000_000;

function assertCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

function fakeBackend(overrides = {}) {
  return validateExecutionBackend({
    startObjective: async () => ({ threadId: "thread-1" }),
    startTurn: async () => ({ turnId: "turn-1" }),
    interruptTurn: async () => ({ ok: true }),
    readObjective: async () => ({ thread: { id: "thread-1", turns: [] } }),
    reconcileObjective: async () => ({ thread: { id: "thread-1", turns: [] } }),
    respondToInteraction: async () => undefined,
    getCapabilities: () => ({
      backend: "app-server",
      durableThreadContinuity: true,
      reverseInteractions: true
    }),
    ...overrides
  });
}

function controllerFixture(t, { appServerBackend = fakeBackend(), tmuxBackend, legacyArtifactsEnabled = true } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-controller-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: START_MS };
  const counters = new Map();
  const idFactory = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${next}`;
  };
  const store = openStore({ databasePath, now: () => clock.value, idFactory });
  const controller = new TurnController({
    store,
    appServerBackend,
    tmuxBackend,
    legacyArtifactsEnabled,
    leaseOwner: "controller-1"
  });
  t.after(() => store.close());
  return { clock, controller, databasePath, store };
}

function intent(overrides = {}) {
  return {
    sourceType: "zulip",
    sourceId: "message-1",
    objectiveId: "objective-1",
    backend: "app-server",
    text: "Implement the objective.",
    targetSnapshot: { streamId: 42, topic: "Build" },
    ...overrides
  };
}

async function completedObjectiveFixture(t) {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());
  const running = fixture.store.readObjectiveExecution("objective-1");
  const submissionId = running.activeSubmission.submissionId;
  const turnId = running.activeSubmission.turnId;
  await fixture.controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: turnId,
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-terminal-invariant",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "immutable terminal output"
      }]
    },
    sourceType: "app-server",
    sourceId: "terminal-invariant-completion"
  });
  return { ...fixture, submissionId, turnId };
}

test("validates the complete ExecutionBackend contract with an owned public error", () => {
  assert.throws(
    () => validateExecutionBackend({ startObjective() {} }),
    (error) => {
      assertCode(error, "EXECUTION_BACKEND_INVALID");
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test("App Server backend maps lifecycle operations without retry or tmux selection", async () => {
  const calls = [];
  const client = {
    startThread: async (options) => (calls.push(["startThread", options]), { thread: { id: "thread-1" } }),
    startTurn: async (options) => (calls.push(["startTurn", options]), { turn: { id: "turn-1" } }),
    interruptTurn: async (options) => (calls.push(["interruptTurn", options]), { ok: true }),
    readThread: async (options) => (calls.push(["readThread", options]), { thread: { id: "thread-1", turns: [] } }),
    respond: async (id, result) => calls.push(["respond", id, result]),
    respondError: async (id, error) => calls.push(["respondError", id, error])
  };
  const backend = createAppServerBackend({ client });

  assert.deepEqual(await backend.startObjective({
    threadOptions: { model: "gpt-5", modelReasoningEffort: "high" }
  }), { threadId: "thread-1" });
  assert.deepEqual(await backend.startTurn({
    threadId: "thread-1",
    text: "continue",
    clientUserMessageId: "client-1"
  }), { turnId: "turn-1" });
  assert.deepEqual(await backend.readObjective({ threadId: "thread-1" }), {
    thread: { id: "thread-1", turns: [] }
  });
  assert.deepEqual(await backend.reconcileObjective({ threadId: "thread-1" }), {
    thread: { id: "thread-1", turns: [] }
  });
  assert.deepEqual(await backend.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), { ok: true });
  await backend.respondToInteraction({ wireRequestId: "request-1", result: { decision: "accept" } });
  await backend.respondToInteraction({
    wireRequestId: 7,
    error: { code: -32_000, message: "Request rejected." }
  });
  assert.deepEqual(backend.getCapabilities(), {
    backend: "app-server",
    durableThreadContinuity: true,
    reverseInteractions: true,
    fileExchange: {
      profile: "local_single_broker_exchange/v1",
      supported: false,
      physicalSeal: false,
      enforcedUploadLimits: false,
      anchoredUploadDirectories: false,
      capabilityRevision: null,
      limitProfileDigest: null,
      maxDepth: null,
      maximumFilesPerAttempt: null,
      maximumBytesPerAttempt: null,
      maximumBytesPerWork: null,
      hcoReserveBytes: null,
      maximumRetentionMs: null,
      maxEffectivePathUnits: null,
      pathUnits: null
    }
  });
  assert.deepEqual(calls, [
    ["startThread", { model: "gpt-5", modelReasoningEffort: "high" }],
    ["startTurn", { threadId: "thread-1", text: "continue", clientUserMessageId: "client-1" }],
    ["readThread", { threadId: "thread-1", includeTurns: true }],
    ["readThread", { threadId: "thread-1", includeTurns: true }],
    ["interruptTurn", { threadId: "thread-1", turnId: "turn-1" }],
    ["respond", "request-1", { decision: "accept" }],
    ["respondError", 7, { code: -32_000, message: "Request rejected." }]
  ]);
});

test("App Server backend classifies only the exact requested missing thread as proven absent", async () => {
  const remote = new Error("App Server request failed.");
  remote.code = "APP_SERVER_RPC_REMOTE_ERROR";
  remote.rpcCode = -32600;
  Object.defineProperty(remote, "rpcMessage", {
    configurable: false,
    enumerable: false,
    value: "thread not loaded: thread-missing",
    writable: false
  });
  const client = {
    startThread: async () => ({ thread: { id: "thread-new" } }),
    startTurn: async () => { throw remote; },
    interruptTurn: async () => ({ ok: true }),
    readThread: async () => ({ thread: { id: "thread-missing", turns: [] } }),
    respond: async () => undefined,
    respondError: async () => undefined
  };
  const backend = createAppServerBackend({ client });

  await assert.rejects(
    backend.startTurn({ threadId: "thread-missing", text: "continue", clientUserMessageId: "client-1" }),
    (error) => {
      assertCode(error, "EXECUTION_BACKEND_OBJECTIVE_MISSING");
      assert.equal(error.message, "Execution backend objective does not exist.");
      assert.equal(requestMayHaveBeenWritten(error), false);
      return true;
    }
  );
});

test("App Server backend keeps near-miss and transport failures uncertain", async () => {
  const failures = [
    { code: "APP_SERVER_RPC_REMOTE_ERROR", rpcCode: -32600, rpcMessage: "thread not loaded: thread-other" },
    { code: "APP_SERVER_RPC_REMOTE_ERROR", rpcCode: -32600, rpcMessage: "thread not loaded: thread-missing " },
    { code: "APP_SERVER_RPC_REMOTE_ERROR", rpcCode: -32601, rpcMessage: "thread not loaded: thread-missing" },
    { code: "APP_SERVER_RPC_TIMEOUT" },
    { code: "APP_SERVER_TRANSPORT_CLOSED" },
    { code: "APP_SERVER_RPC_REMOTE_ERROR", rpcCode: -32000, rpcMessage: "ordinary failure" }
  ];

  for (const failure of failures) {
    const remote = new Error("public failure");
    Object.assign(remote, failure);
    const backend = createAppServerBackend({ client: {
      startThread: async () => ({ thread: { id: "thread-new" } }),
      startTurn: async () => { throw remote; },
      interruptTurn: async () => ({ ok: true }),
      readThread: async () => ({ thread: { id: "thread-missing", turns: [] } }),
      respond: async () => undefined,
      respondError: async () => undefined
    } });

    await assert.rejects(
      backend.startTurn({ threadId: "thread-missing", text: "continue", clientUserMessageId: "client-1" }),
      (error) => {
        assertCode(error, "EXECUTION_BACKEND_REQUEST_UNCERTAIN");
        assert.equal(requestMayHaveBeenWritten(error), true);
        return true;
      }
    );
  }
});

test("tmux backend is inert until explicitly called and never claims App Server continuity", async () => {
  const calls = [];
  const executor = {
    startObjective: async (options) => (calls.push(["startObjective", options]), { objectiveRef: "tmux-1" }),
    startTurn: async (options) => (calls.push(["startTurn", options]), { turnId: "tmux-turn-1" }),
    interruptTurn: async (options) => (calls.push(["interruptTurn", options]), { ok: true }),
    readObjective: async (options) => (calls.push(["readObjective", options]), { turns: [] }),
    reconcileObjective: async (options) => (calls.push(["reconcileObjective", options]), { turns: [] }),
    respondToInteraction: async (options) => calls.push(["respondToInteraction", options])
  };
  const backend = createTmuxBackend({ executor });
  assert.deepEqual(calls, []);
  assert.deepEqual(backend.getCapabilities(), {
    backend: "tmux",
    durableThreadContinuity: false,
    reverseInteractions: false,
    fileExchange: {
      profile: "local_single_broker_exchange/v1",
      supported: false,
      physicalSeal: false,
      enforcedUploadLimits: false,
      anchoredUploadDirectories: false,
      capabilityRevision: null,
      limitProfileDigest: null,
      maxDepth: null,
      maximumFilesPerAttempt: null,
      maximumBytesPerAttempt: null,
      maximumBytesPerWork: null,
      hcoReserveBytes: null,
      maximumRetentionMs: null,
      maxEffectivePathUnits: null,
      pathUnits: null
    }
  });
  assert.deepEqual(await backend.startObjective({ objectiveId: "objective-1" }), { objectiveRef: "tmux-1" });
  assert.deepEqual(calls, [["startObjective", { objectiveId: "objective-1" }]]);
});

test("legacy project artifacts are rejected unless explicitly enabled", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-gate-"));
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: false });
  await assert.rejects(
    controller.acceptIntent(intent({
      artifactBaseDir: projectDirectory,
      artifacts: { input: [], output: [] }
    })),
    (error) => assertCode(error, "FILE_EXCHANGE_UNSUPPORTED")
  );
  assert.equal(store.readObjectiveExecution("objective-1"), null);
});

test("managed artifact mode fails closed before creating an execution intent", async (t) => {
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: true });
  await assert.rejects(
    controller.acceptIntent(intent({ artifactMode: "managed" })),
    (error) => assertCode(error, "FILE_EXCHANGE_UNSUPPORTED")
  );
  assert.equal(store.readObjectiveExecution("objective-1"), null);
});

test("project-local artifacts are accepted independently of the legacy artifact compatibility gate", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-project-local-gate-"));
  const inputDirectory = path.join(projectDirectory, ".hco", "exchanges", "v1", "work-1", "exchange-1", "input");
  mkdirSync(inputDirectory, { recursive: true });
  const contextText = "project-local context\n";
  writeFileSync(path.join(inputDirectory, "context.md"), contextText);
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: false });

  const result = await controller.acceptIntent(intent({
    artifactMode: "project_local",
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [{
        artifactId: "hco-context",
        path: ".hco/exchanges/v1/work-1/exchange-1/input/context.md",
        kind: "context",
        mimeType: "text/markdown",
        maxBytes: 1024,
        sha256: createHash("sha256").update(contextText).digest("hex")
      }],
      output: []
    }
  }));

  assert.equal(result.status, "started");
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "running");
});

test("acceptIntent persists submission intent before one backend call and binds objective, thread, and turn", async (t) => {
  let store;
  const calls = [];
  const backend = fakeBackend({
    startObjective: async () => (calls.push("thread"), { threadId: "thread-real" }),
    startTurn: async (options) => {
      calls.push("turn");
      const durable = store.readObjectiveExecution("objective-1");
      assert.equal(durable.executionStatus, "submitting");
      assert.equal(durable.threadId, "thread-real");
      assert.equal(durable.activeSubmission.clientUserMessageId, options.clientUserMessageId);
      assert.equal(durable.activeSubmission.leaseOwner, "controller-1");
      return { turnId: "turn-real" };
    }
  });
  ({ store } = controllerFixture(t, { appServerBackend: backend }));
  const controller = new TurnController({ store, appServerBackend: backend, leaseOwner: "controller-1" });

  const result = await controller.acceptIntent(intent());
  assert.deepEqual(calls, ["thread", "turn"]);
  assert.equal(result.status, "started");
  assert.equal(result.threadId, "thread-real");
  assert.equal(result.turnId, "turn-real");
  const durable = store.readObjectiveExecution("objective-1");
  assert.equal(durable.executionStatus, "running");
  assert.equal(durable.activeSubmission.turnId, "turn-real");
});

test("duplicate immutable inbound identity makes zero additional backend calls", async (t) => {
  let calls = 0;
  const backend = fakeBackend({
    startObjective: async () => (calls += 1, { threadId: "thread-1" }),
    startTurn: async () => (calls += 1, { turnId: "turn-1" })
  });
  const { controller } = controllerFixture(t, { appServerBackend: backend });
  const first = await controller.acceptIntent(intent());
  const duplicate = await controller.acceptIntent(intent());
  assert.equal(first.status, "started");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.submissionId, first.submissionId);
  assert.equal(calls, 2);
});

test("continuation checks durable source identity before busy state and preserves a new busy intent for retry", async (t) => {
  let turnCalls = 0;
  const backend = fakeBackend({
    startTurn: async () => ({ turnId: `turn-${++turnCalls}` })
  });
  const { controller, databasePath, store } = controllerFixture(t, { appServerBackend: backend });
  const first = await controller.acceptIntent(intent());

  const replay = await controller.continueObjective(intent({ backend: undefined }));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.submissionId, first.submissionId);
  assert.equal(turnCalls, 1);

  const queued = intent({ sourceId: "message-2", backend: undefined, text: "Run after the active turn." });
  assert.equal((await controller.continueObjective(queued)).status, "busy");
  const db = new Database(databasePath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM inbound_intents").get().count, 2);
  } finally {
    db.close();
  }

  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: first.turnId,
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-first",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "first output"
      }]
    },
    sourceType: "app-server",
    sourceId: "completion-1"
  });
  const retried = await controller.continueObjective(queued);
  assert.equal(retried.status, "started");
  assert.equal(retried.turnId, "turn-2");
  assert.equal(turnCalls, 2);
  assert.equal(store.readObjectiveExecution("objective-1").activeSubmission.turnId, "turn-2");
});

test("concurrent lazy objective creation yields one thread and one active turn", async (t) => {
  let releaseThread;
  const gate = new Promise((resolve) => { releaseThread = resolve; });
  const calls = [];
  const backend = fakeBackend({
    startObjective: async () => {
      calls.push("thread");
      await gate;
      return { threadId: "thread-one" };
    },
    startTurn: async () => (calls.push("turn"), { turnId: "turn-one" })
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  const firstPromise = controller.acceptIntent(intent({ sourceId: "message-a" }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await controller.acceptIntent(intent({ sourceId: "message-b" }));
  assert.equal(second.status, "busy");
  releaseThread();
  const first = await firstPromise;
  assert.equal(first.status, "started");
  assert.deepEqual(calls, ["thread", "turn"]);
  assert.equal(store.readObjectiveExecution("objective-1").activeSubmission.turnId, "turn-one");
});

test("uncertain turn submission is durable and is never automatically resent", async (t) => {
  let turnCalls = 0;
  const backend = fakeBackend({
    startTurn: async () => {
      turnCalls += 1;
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    }
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  const result = await controller.acceptIntent(intent());
  assert.equal(result.status, "submission_unknown");
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "submission_unknown");
  const continued = await controller.continueObjective({
    objectiveId: "objective-1",
    text: "do not resend",
    targetSnapshot: { streamId: 42, topic: "Build" }
  });
  assert.equal(continued.status, "busy");
  assert.equal(turnCalls, 1);
});

test("uncertain thread start requires explicit binding and never reads a null thread ID", async (t) => {
  let startCalls = 0;
  const reads = [];
  const backend = fakeBackend({
    startObjective: async () => {
      startCalls += 1;
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    },
    reconcileObjective: async (options) => {
      reads.push(options);
      return { thread: { id: options.threadId, turns: [] } };
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });

  assert.equal((await fixture.controller.acceptIntent(intent())).status, "reconciliation_needed");
  const unresolved = await fixture.controller.reconcileObjective({ objectiveId: "objective-1" });
  assert.deepEqual(unresolved, {
    status: "manual_thread_binding_required",
    objectiveId: "objective-1"
  });
  assert.deepEqual(reads, []);
  assert.equal(startCalls, 1);

  const bound = await fixture.controller.resolveObjectiveThread({
    objectiveId: "objective-1",
    threadId: "thread-operator-bound",
    sourceType: "operator",
    sourceId: "thread-binding-1"
  });
  assert.equal(bound.status, "ready");
  assert.equal(bound.threadId, "thread-operator-bound");
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const reconciled = await reopenedController.reconcileObjective({ objectiveId: "objective-1" });

  assert.equal(reconciled.status, "ready");
  assert.deepEqual(reads, [{ threadId: "thread-operator-bound" }]);
  assert.equal(reopenedStore.readObjectiveExecution("objective-1").threadId, "thread-operator-bound");
  assert.equal(startCalls, 1);
});

test("accepted intent resumes exactly once after restart and explicit uncertain thread binding", async (t) => {
  let startObjectiveCalls = 0;
  const startTurnCalls = [];
  const backend = fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    },
    startTurn: async (options) => {
      startTurnCalls.push(options);
      return { turnId: "turn-recovered" };
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  const accepted = intent();

  assert.equal((await fixture.controller.acceptIntent(accepted)).status, "reconciliation_needed");
  assert.equal(fixture.store.readObjectiveExecution("objective-1").activeSubmission, null);
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const bound = await reopenedController.resolveObjectiveThread({
    objectiveId: "objective-1",
    threadId: "thread-operator-bound",
    sourceType: "operator",
    sourceId: "thread-binding-resume"
  });
  assert.equal(bound.status, "ready");

  const resumed = await reopenedController.acceptIntent(accepted);
  const replay = await reopenedController.acceptIntent(accepted);
  const durable = reopenedStore.readObjectiveExecution("objective-1");

  assert.equal(resumed.status, "started");
  assert.equal(resumed.threadId, "thread-operator-bound");
  assert.equal(resumed.turnId, "turn-recovered");
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.submissionId, resumed.submissionId);
  assert.equal(replay.clientUserMessageId, resumed.clientUserMessageId);
  assert.equal(durable.activeSubmission.submissionId, resumed.submissionId);
  assert.equal(durable.activeSubmission.clientUserMessageId, resumed.clientUserMessageId);
  assert.equal(durable.activeSubmission.text, accepted.text);
  assert.equal(startObjectiveCalls, 1);
  assert.deepEqual(startTurnCalls, [{
    threadId: "thread-operator-bound",
    text: accepted.text,
    clientUserMessageId: resumed.clientUserMessageId
  }]);

  const db = new Database(fixture.databasePath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM objective_execution").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM inbound_intents").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM turn_submissions").get().count, 1);
  } finally {
    db.close();
  }
});

test("explicit thread resolution rejects objectives outside uncertain App Server start recovery", async (t) => {
  const { controller } = controllerFixture(t);
  await controller.acceptIntent(intent());

  await assert.rejects(
    controller.resolveObjectiveThread({
      objectiveId: "objective-1",
      threadId: "thread-other",
      sourceType: "operator",
      sourceId: "thread-binding-invalid"
    }),
    (error) => assertCode(error, "OBJECTIVE_THREAD_RESOLUTION_INVALID")
  );
});

test("App Server unavailability never selects or executes tmux", async (t) => {
  let tmuxCalls = 0;
  const appServerBackend = fakeBackend({
    startObjective: async () => {
      throw executionBackendError("EXECUTION_BACKEND_UNAVAILABLE", "Execution backend is unavailable.");
    }
  });
  const tmuxBackend = createTmuxBackend({ executor: {
    startObjective: async () => (tmuxCalls += 1, {}),
    startTurn: async () => (tmuxCalls += 1, {}),
    interruptTurn: async () => (tmuxCalls += 1, {}),
    readObjective: async () => (tmuxCalls += 1, {}),
    reconcileObjective: async () => (tmuxCalls += 1, {}),
    respondToInteraction: async () => (tmuxCalls += 1, {})
  } });
  const { controller, store } = controllerFixture(t, { appServerBackend, tmuxBackend });
  const result = await controller.acceptIntent(intent());
  assert.equal(result.status, "backend_unavailable");
  assert.equal(store.readObjectiveExecution("objective-1").backend, "app-server");
  assert.equal(tmuxCalls, 0);
});

test("tmux executes only for an explicit persisted selection and receives no App Server thread ID", async (t) => {
  const calls = [];
  const tmuxBackend = createTmuxBackend({ executor: {
    startObjective: async (options) => (calls.push(["objective", options]), { objectiveRef: "tmux-objective" }),
    startTurn: async (options) => (calls.push(["turn", options]), { turnId: "tmux-turn" }),
    interruptTurn: async () => ({}),
    readObjective: async () => ({ turns: [] }),
    reconcileObjective: async () => ({ turns: [] }),
    respondToInteraction: async () => undefined
  } });
  const { controller, store } = controllerFixture(t, { tmuxBackend });
  const result = await controller.acceptIntent(intent({ backend: "tmux" }));
  assert.equal(result.status, "started");
  assert.equal(store.readObjectiveExecution("objective-1").backend, "tmux");
  assert.equal(store.readObjectiveExecution("objective-1").threadId, null);
  assert.equal(Object.hasOwn(calls[1][1], "threadId"), false);
  assert.deepEqual(calls.map(([method]) => method), ["objective", "turn"]);
});

test("restart reconciliation binds an unknown submission by durable clientId without resubmitting", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-reconcile-restart-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  let startCalls = 0;
  let clientId;
  const firstBackend = fakeBackend({
    startTurn: async (options) => {
      startCalls += 1;
      clientId = options.clientUserMessageId;
      throw executionBackendError("EXECUTION_BACKEND_REQUEST_UNCERTAIN", "Uncertain.", { mayHaveBeenWritten: true });
    }
  });
  const firstStore = openStore({ databasePath, now: () => START_MS });
  const firstController = new TurnController({ store: firstStore, appServerBackend: firstBackend, leaseOwner: "first" });
  assert.equal((await firstController.acceptIntent(intent())).status, "submission_unknown");
  firstStore.close();

  const secondBackend = fakeBackend({
    reconcileObjective: async () => ({
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-recovered",
          status: "inProgress",
          itemsView: "full",
          items: [{ id: "user-1", type: "userMessage", clientId, status: "completed" }]
        }]
      }
    })
  });
  const secondStore = openStore({ databasePath, now: () => START_MS + 1 });
  const secondController = new TurnController({ store: secondStore, appServerBackend: secondBackend, leaseOwner: "second" });
  const reconciled = await secondController.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(reconciled.status, "running");
  assert.equal(reconciled.turnId, "turn-recovered");
  assert.equal(secondStore.readObjectiveExecution("objective-1").activeSubmission.turnId, "turn-recovered");
  assert.equal(startCalls, 1);
  secondStore.close();
});

test("one reconciliation read without the clientId retains submission_unknown and its lease", async (t) => {
  let startCalls = 0;
  const backend = fakeBackend({
    startTurn: async () => {
      startCalls += 1;
      throw executionBackendError("EXECUTION_BACKEND_REQUEST_UNCERTAIN", "Uncertain.", { mayHaveBeenWritten: true });
    },
    reconcileObjective: async () => ({ thread: { id: "thread-1", turns: [] } })
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const lease = store.readObjectiveExecution("objective-1").activeSubmission.leaseToken;
  const result = await controller.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(result.status, "submission_unknown");
  assert.equal(store.readObjectiveExecution("objective-1").activeSubmission.leaseToken, lease);
  assert.equal(startCalls, 1);
});

test("terminal output reduction prefers final_answer, excludes commentary, and has a deterministic all-null fallback", () => {
  assert.deepEqual(reduceTerminalOutput({
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    items: [
      { id: "a", type: "agentMessage", status: "completed", phase: "commentary", text: "ignore" },
      { id: "b", type: "agentMessage", status: "completed", phase: "final_answer", text: "first final" },
      { id: "c", type: "agentMessage", status: "completed", phase: "final_answer", text: "second final" }
    ]
  }), { text: "first final\n\nsecond final", itemIds: ["b", "c"] });

  assert.deepEqual(reduceTerminalOutput({
    id: "turn-legacy",
    status: "completed",
    itemsView: "full",
    items: [
      { id: "legacy-a", type: "agentMessage", status: "completed", phase: null, text: "older" },
      { id: "legacy-b", type: "agentMessage", status: "completed", text: "byte-for-byte\r\nlatest" }
    ]
  }), { text: "byte-for-byte\r\nlatest", itemIds: ["legacy-b"] });
});

test("terminal output reduction accepts current App Server agent messages without item status", () => {
  assert.deepEqual(reduceTerminalOutput({
    id: "turn-current-app-server",
    status: "completed",
    itemsView: "full",
    items: [
      { id: "commentary", type: "agentMessage", phase: "commentary", text: "ignore" },
      { id: "final", type: "agentMessage", phase: "final_answer", text: "current protocol output" }
    ]
  }), { text: "current protocol output", itemIds: ["final"] });
});

test("terminal output reduction rejects agent messages with an explicit non-completed status", () => {
  for (const status of [null, "inProgress", "failed", "cancelled"]) {
    assert.equal(reduceTerminalOutput({
      id: `turn-agent-${status}`,
      status: "completed",
      itemsView: "full",
      items: [{
        id: `agent-${status}`,
        type: "agentMessage",
        status,
        phase: "final_answer",
        text: "must not be emitted"
      }]
    }), null);
  }
});

for (const itemsView of ["full", "summary", "notLoaded"]) {
  test(`${itemsView} terminal path stores raw output before rendering and replays idempotently`, async (t) => {
    let readCalls = 0;
    let store;
    const fullTurn = {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "agent-final",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "raw\r\ntechnical output"
      }]
    };
    const backend = fakeBackend({
      readObjective: async () => {
        readCalls += 1;
        return { thread: { id: "thread-1", turns: [fullTurn] } };
      }
    });
    const fixture = controllerFixture(t, { appServerBackend: backend });
    store = fixture.store;
    const rendererCalls = [];
    const controller = new TurnController({
      store,
      appServerBackend: backend,
      leaseOwner: "controller-1",
      renderer(input) {
        rendererCalls.push(input);
        assert.equal(store.readTurnOutput("objective-1", "turn-1").rawText, "raw\r\ntechnical output");
        return [{
          content: "rendered chunk verbatim",
          semanticKey: "renderer-owned-key",
          contentHash: "hash",
          index: 1,
          total: 1,
          rendererVersion: 1
        }];
      }
    });
    await controller.acceptIntent(intent());
    const turn = itemsView === "full" ? fullTurn : { ...fullTurn, itemsView, items: [] };
    const completed = await controller.handleTurnCompleted({
      objectiveId: "objective-1",
      turn,
      sourceType: "app-server",
      sourceId: `terminal-${itemsView}`
    });
    assert.equal(completed.status, "completed");
    assert.equal(readCalls, itemsView === "full" ? 0 : 1);
    assert.deepEqual(rendererCalls, [{ objectiveId: "objective-1", text: "raw\r\ntechnical output" }]);
    assert.equal(store.readTurnOutput("objective-1", "turn-1").rawText, "raw\r\ntechnical output");
    const replay = await controller.handleTurnCompleted({
      objectiveId: "objective-1",
      turn: fullTurn,
      sourceType: "reconciliation",
      sourceId: `replay-${itemsView}`
    });
    assert.equal(replay.duplicate, true);
    assert.equal(rendererCalls.length, 1);
    const claimed = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].semanticKey, "renderer-owned-key");
    assert.equal(claimed[0].payload.content, "rendered chunk verbatim");
  });
}

test("terminal completion without authoritative output durably requires reconciliation", async (t) => {
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent());

  const result = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "commentary-only",
        type: "agentMessage",
        status: "completed",
        phase: "commentary",
        text: "not authoritative final output"
      }]
    },
    sourceType: "app-server",
    sourceId: "terminal-without-output"
  });

  assert.equal(result.status, "reconciliation_needed");
  const execution = store.readObjectiveExecution("objective-1");
  assert.equal(execution.executionStatus, "reconciliation_needed");
  assert.equal(execution.activeSubmission.state, "reconciliation_needed");
  assert.equal(execution.activeSubmission.reconciliationRequired, true);
  assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
  assert.equal(store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 0);
});

test("required output artifact missing keeps the turn in reconciliation without final outbox", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-project-"));
  mkdirSync(path.join(projectDirectory, "docs"));
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent({
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "result",
        path: "docs/result.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    }
  }));

  const result = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-without-artifact",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "I wrote the requested artifact."
      }]
    },
    sourceType: "app-server",
    sourceId: "missing-artifact-completion"
  });

  assert.equal(result.status, "reconciliation_needed");
  assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "reconciliation_needed");
  assert.equal(store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 0);
});

test("project-local completion fails deterministically when Codex changes a staged input", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-project-local-input-change-"));
  const exchangeRoot = path.join(projectDirectory, ".hco", "exchanges", "v1", "work-1", "exchange-1");
  mkdirSync(path.join(exchangeRoot, "input"), { recursive: true });
  mkdirSync(path.join(exchangeRoot, "output"), { recursive: true });
  const inputPath = path.join(exchangeRoot, "input", "context.md");
  const outputPath = path.join(exchangeRoot, "output", "result.md");
  const originalInput = "trusted staged input\n";
  writeFileSync(inputPath, originalInput);
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: false });
  await controller.acceptIntent(intent({
    artifactMode: "project_local",
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [{
        artifactId: "hco-context",
        path: ".hco/exchanges/v1/work-1/exchange-1/input/context.md",
        kind: "context",
        mimeType: "text/markdown",
        maxBytes: 1024,
        sha256: createHash("sha256").update(originalInput).digest("hex")
      }],
      output: [{
        artifactId: "result",
        path: ".hco/exchanges/v1/work-1/exchange-1/output/result.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    }
  }));
  writeFileSync(inputPath, "Codex changed the staged input.\n");
  writeFileSync(outputPath, "result\n");

  const completed = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", status: "completed", phase: "final_answer", text: "Done." }]
    },
    sourceType: "app-server",
    sourceId: "project-local-input-changed"
  });

  assert.equal(completed.status, "reconciliation_needed");
  assert.equal(completed.errorCode, "PROJECT_LOCAL_INPUT_CHANGED");
  assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
});

test("project-local completion rejects malformed JSON output", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-project-local-json-"));
  const outputDirectory = path.join(projectDirectory, ".hco", "exchanges", "v1", "work-1", "exchange-1", "output");
  mkdirSync(outputDirectory, { recursive: true });
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: false });
  await controller.acceptIntent(intent({
    artifactMode: "project_local",
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "evidence",
        path: ".hco/exchanges/v1/work-1/exchange-1/output/evidence.json",
        kind: "evidence",
        mimeType: "application/json",
        maxBytes: 1024,
        required: true
      }]
    }
  }));
  writeFileSync(path.join(outputDirectory, "evidence.json"), "{not-json}\n");

  const completed = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", status: "completed", phase: "final_answer", text: "Done." }]
    },
    sourceType: "app-server",
    sourceId: "project-local-invalid-json"
  });

  assert.equal(completed.status, "reconciliation_needed");
  assert.equal(completed.errorCode, "PROJECT_LOCAL_OUTPUT_INVALID");
  assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
});

test("project-local completion publishes verified output and records AVAILABLE status", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-project-local-success-"));
  const exchangeRoot = path.join(projectDirectory, ".hco", "exchanges", "v1", "work-1", "exchange-1");
  const outputDirectory = path.join(exchangeRoot, "output");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path.join(exchangeRoot, "status.json"), `${JSON.stringify({
    schemaVersion: 1,
    exchangeMode: "project_local/v1",
    workId: "work-1",
    exchangeId: "exchange-1",
    projectId: "alpha",
    state: "READY",
    updatedAtMs: START_MS
  }, null, 2)}\n`);
  const outputText = "verified project-local result\n";
  writeFileSync(path.join(outputDirectory, "result.md"), outputText);
  const { controller, store } = controllerFixture(t, { legacyArtifactsEnabled: false });
  await controller.acceptIntent(intent({
    artifactMode: "project_local",
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "result",
        path: ".hco/exchanges/v1/work-1/exchange-1/output/result.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    }
  }));

  const completed = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", status: "completed", phase: "final_answer", text: "Done." }]
    },
    sourceType: "app-server",
    sourceId: "project-local-success"
  });

  assert.equal(completed.status, "completed");
  assert.equal(JSON.parse(readFileSync(path.join(exchangeRoot, "status.json"), "utf8")).state, "AVAILABLE");
  const [delivery] = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(delivery.payload.artifacts.output[0].state, "verified");
  assert.equal(delivery.payload.artifacts.output[0].sha256, createHash("sha256").update(outputText).digest("hex"));
});

test("project-local completion rejects oversized, invalid UTF-8, and symlink outputs", async (t) => {
  const scenarios = [
    {
      name: "oversized",
      write(outputPath) { writeFileSync(outputPath, "too large\n"); },
      maxBytes: 4
    },
    {
      name: "invalid-utf8",
      write(outputPath) { writeFileSync(outputPath, Buffer.from([0xc3, 0x28])); },
      maxBytes: 1024
    },
    {
      name: "symlink",
      write(outputPath, outputDirectory) {
        const target = path.join(outputDirectory, "real-result.md");
        writeFileSync(target, "target\n");
        symlinkSync(target, outputPath, "file");
      },
      maxBytes: 1024
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const projectDirectory = mkdtempSync(path.join(tmpdir(), `hco-project-local-${scenario.name}-`));
      const exchangeRoot = path.join(projectDirectory, ".hco", "exchanges", "v1", "work-1", "exchange-1");
      const outputDirectory = path.join(exchangeRoot, "output");
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(path.join(exchangeRoot, "status.json"), `${JSON.stringify({
        schemaVersion: 1,
        exchangeMode: "project_local/v1",
        workId: "work-1",
        exchangeId: "exchange-1",
        projectId: "alpha",
        state: "READY",
        updatedAtMs: START_MS
      }, null, 2)}\n`);
      const outputPath = path.join(outputDirectory, "result.md");
      try {
        scenario.write(outputPath, outputDirectory);
      } catch (error) {
        if (scenario.name === "symlink" && ["EPERM", "EACCES"].includes(error?.code)) {
          subtest.skip("file symlinks are unavailable on this host");
          return;
        }
        throw error;
      }
      const { controller, store } = controllerFixture(subtest, { legacyArtifactsEnabled: false });
      await controller.acceptIntent(intent({
        artifactMode: "project_local",
        artifactBaseDir: projectDirectory,
        artifacts: {
          input: [],
          output: [{
            artifactId: "result",
            path: ".hco/exchanges/v1/work-1/exchange-1/output/result.md",
            kind: "document",
            mimeType: "text/markdown",
            maxBytes: scenario.maxBytes,
            required: true
          }]
        }
      }));

      const completed = await controller.handleTurnCompleted({
        objectiveId: "objective-1",
        turn: {
          id: "turn-1",
          status: "completed",
          itemsView: "full",
          items: [{ id: "final", type: "agentMessage", status: "completed", phase: "final_answer", text: "Done." }]
        },
        sourceType: "app-server",
        sourceId: `project-local-${scenario.name}`
      });

      assert.equal(completed.status, "reconciliation_needed");
      assert.equal(completed.errorCode, "PROJECT_LOCAL_OUTPUT_INVALID");
      assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
      assert.deepEqual(JSON.parse(readFileSync(path.join(exchangeRoot, "status.json"), "utf8")), {
        schemaVersion: 1,
        exchangeMode: "project_local/v1",
        workId: "work-1",
        exchangeId: "exchange-1",
        projectId: "alpha",
        state: "ERROR",
        updatedAtMs: START_MS,
        errorCode: "PROJECT_LOCAL_OUTPUT_INVALID"
      });
    });
  }
});

test("required output artifact completion can retry with the original source after the file appears", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-project-"));
  mkdirSync(path.join(projectDirectory, "docs"));
  const outputPath = path.join(projectDirectory, "docs", "result.md");
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent({
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "result",
        path: "docs/result.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    }
  }));
  const completion = {
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-artifact-retry",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "Done."
      }]
    },
    sourceType: "app-server",
    sourceId: "artifact-retry-completion"
  };

  assert.equal((await controller.handleTurnCompleted(completion)).status, "reconciliation_needed");
  writeFileSync(outputPath, "result after retry\n");

  const retried = await controller.handleTurnCompleted(completion);
  assert.equal(retried.status, "completed");
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "completed");
  assert.equal(store.readTurnOutput("objective-1", "turn-1").rawText, "Done.");
  const claimed = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].payload.artifacts.output[0].state, "verified");
});

test("missing optional output artifacts do not block completion", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-project-"));
  mkdirSync(path.join(projectDirectory, "docs"));
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent({
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "supplement",
        path: "docs/supplement.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: false
      }]
    }
  }));

  const result = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-without-optional-artifact",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "Done without the optional supplement."
      }]
    },
    sourceType: "app-server",
    sourceId: "optional-artifact-completion"
  });

  assert.equal(result.status, "completed");
  const claimed = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0].payload.artifacts.output[0], {
    artifactId: "supplement",
    path: "docs/supplement.md",
    kind: "document",
    mimeType: "text/markdown",
    required: false,
    maxBytes: 1024,
    state: "missing"
  });
});

test("verified output artifacts are attached to final outbox payloads", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-project-"));
  mkdirSync(path.join(projectDirectory, "docs"));
  const outputText = "artifact result\n";
  const outputPath = path.join(projectDirectory, "docs", "result.md");
  const outputSha256 = createHash("sha256").update(outputText, "utf8").digest("hex");
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent({
    artifactBaseDir: projectDirectory,
    artifacts: {
      input: [],
      output: [{
        artifactId: "result",
        path: "docs/result.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    }
  }));
  writeFileSync(outputPath, outputText);

  const result = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "final-with-artifact",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "Done."
      }]
    },
    sourceType: "app-server",
    sourceId: "verified-artifact-completion"
  });

  assert.equal(result.status, "completed");
  const claimed = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].payload.artifacts.output[0].artifactId, "result");
  assert.equal(claimed[0].payload.artifacts.output[0].path, "docs/result.md");
  assert.equal(claimed[0].payload.artifacts.output[0].sha256, outputSha256);
  assert.equal(claimed[0].payload.artifacts.output[0].bytes, Buffer.byteLength(outputText, "utf8"));
  assert.match(claimed[0].payload.content, /Artifact manifest:/);
  assert.match(claimed[0].payload.content, /docs\/result\.md/);
});

test("known-turn reconciliation reaches terminal state idempotently without replacement", async (t) => {
  let startCalls = 0;
  const terminalTurn = {
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    items: [{ id: "final", type: "agentMessage", status: "completed", phase: "final_answer", text: "done" }]
  };
  const backend = fakeBackend({
    startTurn: async () => (startCalls += 1, { turnId: "turn-1" }),
    reconcileObjective: async () => ({ thread: { id: "thread-1", turns: [terminalTurn] } })
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  assert.equal((await controller.reconcileObjective({ objectiveId: "objective-1" })).status, "completed");
  const replay = await controller.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(replay.duplicate, true);
  assert.equal(startCalls, 1);
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "completed");
  assert.equal(store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 1);
});

test("restart reconciliation confirms an uncertain interrupt as cancelled exactly once", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-cancel-reconcile-restart-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  let startTurnCalls = 0;
  let interruptCalls = 0;
  const firstBackend = fakeBackend({
    startTurn: async () => ({ turnId: `turn-${++startTurnCalls}` }),
    interruptTurn: async () => {
      interruptCalls += 1;
      throw executionBackendError("EXECUTION_BACKEND_REQUEST_UNCERTAIN", "Uncertain.", { mayHaveBeenWritten: true });
    }
  });
  const firstStore = openStore({ databasePath, now: () => START_MS });
  const firstController = new TurnController({ store: firstStore, appServerBackend: firstBackend, leaseOwner: "first" });
  await firstController.acceptIntent(intent());
  const beforeSubmission = firstStore.readTurnSubmission("objective-1", "turn-1");
  const beforeIntentDb = new Database(databasePath, { readonly: true });
  const beforeIntent = beforeIntentDb.prepare(`
    SELECT source_type, source_id, payload_hash, objective_id, submission_id, created_at_ms
    FROM inbound_intents WHERE source_type = 'zulip' AND source_id = 'message-1'
  `).get();
  beforeIntentDb.close();
  assert.equal((await firstController.cancelObjective({
    objectiveId: "objective-1",
    sourceType: "zulip",
    sourceId: "cancel-message-1"
  })).status, "reconciliation_needed");
  firstStore.close();

  const cancelledTurn = { id: "turn-1", status: "cancelled", itemsView: "full", items: [] };
  const secondBackend = fakeBackend({
    startTurn: async () => ({ turnId: `unexpected-${++startTurnCalls}` }),
    reconcileObjective: async () => ({ thread: { id: "thread-1", turns: [cancelledTurn] } })
  });
  const secondStore = openStore({ databasePath, now: () => START_MS + 1 });
  const secondController = new TurnController({ store: secondStore, appServerBackend: secondBackend, leaseOwner: "second" });

  const reconciled = await secondController.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(reconciled.status, "cancelled");
  const replay = await secondController.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(replay.status, "cancelled");
  assert.equal(startTurnCalls, 1);
  assert.equal(interruptCalls, 1);

  const execution = secondStore.readObjectiveExecution("objective-1");
  const submission = secondStore.readTurnSubmission("objective-1", "turn-1");
  assert.equal(execution.executionStatus, "cancelled");
  assert.equal(execution.activeSubmission, null);
  assert.equal(submission.state, "cancelled");
  assert.equal(submission.terminalStatus, "cancelled");
  assert.equal(submission.reconciliationRequired, false);
  assert.equal(submission.leaseOwner, "");
  assert.deepEqual(
    {
      clientUserMessageId: submission.clientUserMessageId,
      objectiveId: submission.objectiveId,
      targetSnapshot: submission.targetSnapshot,
      text: submission.text,
      turnId: submission.turnId
    },
    {
      clientUserMessageId: beforeSubmission.clientUserMessageId,
      objectiveId: beforeSubmission.objectiveId,
      targetSnapshot: beforeSubmission.targetSnapshot,
      text: beforeSubmission.text,
      turnId: beforeSubmission.turnId
    }
  );
  assert.equal(secondStore.readTurnOutput("objective-1", "turn-1"), null);
  const facts = secondStore.readTurnAuditFacts("objective-1");
  assert.equal(facts.filter((fact) => fact.fact.kind === "terminal_reconciled").length, 1);
  assert.equal(facts.some((fact) =>
    fact.sourceType === "reconciliation" &&
    fact.sourceId === "turn-turn-1-cancelled" &&
    fact.fact.remoteStatus === "cancelled" &&
    fact.fact.localStatus === "cancelled"
  ), true);
  const claimed = secondStore.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].semanticKey, "turn:turn-1:cancelled");
  assert.deepEqual(claimed[0].payload, { content: "Turn cancelled.", kind: "turn_cancelled" });

  const afterIntentDb = new Database(databasePath, { readonly: true });
  const afterIntent = afterIntentDb.prepare(`
    SELECT source_type, source_id, payload_hash, objective_id, submission_id, created_at_ms
    FROM inbound_intents WHERE source_type = 'zulip' AND source_id = 'message-1'
  `).get();
  afterIntentDb.close();
  assert.deepEqual(afterIntent, beforeIntent);
  secondStore.close();
});

test("restart reconciliation maps a remote failed turn to durable terminal_error", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-failed-reconcile-restart-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  let startTurnCalls = 0;
  const firstBackend = fakeBackend({
    startTurn: async () => ({ turnId: `turn-${++startTurnCalls}` })
  });
  const firstStore = openStore({ databasePath, now: () => START_MS });
  const firstController = new TurnController({ store: firstStore, appServerBackend: firstBackend, leaseOwner: "first" });
  await firstController.acceptIntent(intent());
  const beforeSubmission = firstStore.readTurnSubmission("objective-1", "turn-1");
  firstStore.close();

  const failedTurn = { id: "turn-1", status: "failed", itemsView: "full", items: [] };
  const secondBackend = fakeBackend({
    startTurn: async () => ({ turnId: `unexpected-${++startTurnCalls}` }),
    reconcileObjective: async () => ({ thread: { id: "thread-1", turns: [failedTurn] } })
  });
  const secondStore = openStore({ databasePath, now: () => START_MS + 1 });
  const secondController = new TurnController({ store: secondStore, appServerBackend: secondBackend, leaseOwner: "second" });

  const reconciled = await secondController.reconcileObjective({ objectiveId: "objective-1" });
  assert.equal(reconciled.status, "terminal_error");
  assert.equal((await secondController.reconcileObjective({ objectiveId: "objective-1" })).status, "terminal_error");
  assert.equal(startTurnCalls, 1);

  const execution = secondStore.readObjectiveExecution("objective-1");
  const submission = secondStore.readTurnSubmission("objective-1", "turn-1");
  assert.equal(execution.executionStatus, "terminal_error");
  assert.equal(execution.activeSubmission, null);
  assert.equal(submission.state, "terminal_error");
  assert.equal(submission.terminalStatus, "terminal_error");
  assert.equal(submission.reconciliationRequired, false);
  assert.equal(submission.leaseOwner, "");
  assert.equal(submission.clientUserMessageId, beforeSubmission.clientUserMessageId);
  assert.equal(submission.text, beforeSubmission.text);
  assert.deepEqual(submission.targetSnapshot, beforeSubmission.targetSnapshot);
  assert.equal(submission.turnId, beforeSubmission.turnId);
  assert.equal(secondStore.readTurnOutput("objective-1", "turn-1"), null);
  assert.deepEqual(secondStore.readTurnAuditFacts("objective-1").map((fact) => ({
    sourceType: fact.sourceType,
    sourceId: fact.sourceId,
    fact: fact.fact
  })), [{
    sourceType: "reconciliation",
    sourceId: "turn-turn-1-failed",
    fact: {
      kind: "terminal_reconciled",
      localStatus: "terminal_error",
      remoteStatus: "failed",
      turnId: "turn-1"
    }
  }]);
  assert.equal(secondStore.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 0);
  secondStore.close();
});

test("cancellation intent is durable before interrupt and confirmed cancellation delivers once", async (t) => {
  let store;
  let interruptCalls = 0;
  let startTurnCalls = 0;
  const backend = fakeBackend({
    startTurn: async () => (startTurnCalls += 1, { turnId: `turn-${startTurnCalls}` }),
    interruptTurn: async ({ threadId, turnId }) => {
      interruptCalls += 1;
      assert.equal(threadId, "thread-1");
      assert.equal(turnId, "turn-1");
      assert.equal(store.readObjectiveExecution("objective-1").activeSubmission.cancellationRequested, true);
      return { ok: true };
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  store = fixture.store;
  await fixture.controller.acceptIntent(intent());

  const cancelled = await fixture.controller.cancelObjective({
    objectiveId: "objective-1",
    sourceType: "zulip",
    sourceId: "cancel-message-1"
  });
  assert.equal(cancelled.status, "cancelled");
  const replay = await fixture.controller.cancelObjective({
    objectiveId: "objective-1",
    sourceType: "zulip",
    sourceId: "cancel-message-1"
  });
  assert.equal(replay.duplicate, true);
  assert.equal(interruptCalls, 1);
  const rejectedContinuation = await fixture.controller.acceptIntent(intent({
    sourceId: "after-cancel",
    text: "must not reopen"
  }));
  assert.deepEqual(rejectedContinuation, { status: "cancelled", objectiveId: "objective-1" });
  assert.equal(startTurnCalls, 1);
  assert.equal(store.readObjectiveExecution("objective-1").executionStatus, "cancelled");
  const claimed = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].semanticKey, "turn:turn-1:cancelled");
  assert.deepEqual(claimed[0].payload, { content: "Turn cancelled.", kind: "turn_cancelled" });
});

test("confirmed cancellation suppresses late final delivery and retains the server fact for audit", async (t) => {
  const { controller, store } = controllerFixture(t);
  await controller.acceptIntent(intent());
  await controller.cancelObjective({
    objectiveId: "objective-1",
    sourceType: "zulip",
    sourceId: "cancel-message-1"
  });
  const late = await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "late-final",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "must not be delivered"
      }]
    },
    sourceType: "app-server",
    sourceId: "late-completion-1"
  });
  assert.deepEqual(late, {
    status: "cancelled",
    objectiveId: "objective-1",
    turnId: "turn-1",
    suppressed: true
  });
  assert.equal(store.readTurnOutput("objective-1", "turn-1"), null);
  assert.equal(store.readTurnAuditFacts("objective-1").some((fact) =>
    fact.sourceType === "app-server" && fact.sourceId === "late-completion-1" && fact.fact.kind === "late_completion"
  ), true);
  assert.equal(store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 1);
});

function interactionRequest(overrides = {}) {
  return {
    connectionId: "connection-1",
    wireRequestId: 7,
    method: "item/commandExecution/requestApproval",
    objectiveId: "objective-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    approvalId: null,
    request: { command: "npm test" },
    allowedResponderIds: [101],
    targetSnapshot: { streamId: 42, topic: "Build" },
    ...overrides
  };
}

function claimInteractionPrompt(store) {
  const detailContents = [];
  for (let index = 0; index < 20; index += 1) {
    const [delivery] = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
    assert.ok(delivery, "expected the next ordered interaction delivery");
    if (delivery.payload.kind === "interaction_request") {
      return { prompt: delivery, detailContent: detailContents.join("\n") };
    }
    assert.equal(delivery.payload.kind, "interaction_detail");
    detailContents.push(delivery.payload.content);
    store.ackOutbox({
      deliveryId: delivery.deliveryId,
      leaseToken: delivery.leaseToken,
      zulipMessageId: 10_000 + index
    });
  }
  assert.fail("interaction prompt was not released after its details");
}

test("default approval renderer provides fallback accept and cancel commands", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.match(prompt.payload.content, /⚠️ \*\*审批请求\*\*/);
  assert.match(prompt.payload.content, new RegExp(pending.interactionId));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
  assert.match(detailContent, /npm test/);
  assert.equal(fixture.store.readInteractionDetail(pending.interactionId).state, "delivered");
  assert.deepEqual(prompt.payload.ui.actionIds, prompt.payload.interaction.actions.map(({ actionId }) => actionId));
});

test("action prompt remains blocked until every ordered detail chunk is acknowledged", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: { command: "x".repeat(60_000), availableDecisions: ["accept", "cancel"] }
  }));

  const [firstDetail] = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(firstDetail.payload.kind, "interaction_detail");
  assert.equal(fixture.store.readInteractionDetail(pending.interactionId).state, "detail_pending");
  assert.deepEqual(fixture.store.claimOutbox({ workerId: "other", limit: 10, leaseMs: 1_000 }), []);
  fixture.store.ackOutbox({
    deliveryId: firstDetail.deliveryId,
    leaseToken: firstDetail.leaseToken,
    zulipMessageId: 20_001
  });
  const [secondDetail] = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(secondDetail.payload.kind, "interaction_detail");
  fixture.store.ackOutbox({
    deliveryId: secondDetail.deliveryId,
    leaseToken: secondDetail.leaseToken,
    zulipMessageId: 20_002
  });
  const [prompt] = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(prompt.payload.kind, "interaction_request");
  assert.equal(fixture.store.readInteractionDetail(pending.interactionId).state, "delivered");
});

test("natural replies cannot settle an interaction before all details are delivered", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: { command: "x".repeat(60_000), availableDecisions: ["accept", "cancel"] },
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build" }
  }));
  const naturalReply = {
    binding: { streamId: 42, topic: "Build", sourceMessageId: 601, senderId: 101 },
    intent: "allow",
    normalizedAlias: "ok"
  };

  assert.deepEqual(fixture.store.resolveNaturalInteraction(naturalReply), {
    status: "not_applicable",
    duplicate: false
  });
  assert.equal(fixture.store.readInteraction(pending.interactionId).state, "pending");

  claimInteractionPrompt(fixture.store);
  const settled = fixture.store.resolveNaturalInteraction({
    ...naturalReply,
    binding: { ...naturalReply.binding, sourceMessageId: 602 }
  });

  assert.equal(settled.status, "selected");
  assert.equal(settled.interactionId, pending.interactionId);
  assert.equal(fixture.store.readInteraction(pending.interactionId).state, "answered");
  assert.equal(
    fixture.store.readInteractionSettlementAudit(pending.interactionId).resolutionSource,
    "natural_alias"
  );
});

test("details beyond the chunk budget use a verified Markdown document before actions", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: { command: "文档命令".repeat(100_000), availableDecisions: ["accept", "cancel"] }
  }));

  const [documentDelivery] = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(documentDelivery.payload.kind, "interaction_document");
  const { document } = documentDelivery.payload;
  assert.equal(Buffer.byteLength(document.textContent, "utf8"), document.bytes);
  assert.equal(createHash("sha256").update(document.textContent, "utf8").digest("hex"), document.sha256);
  assert.equal(fixture.store.readInteractionDetail(pending.interactionId).mode, "document");
  fixture.store.ackOutbox({
    deliveryId: documentDelivery.deliveryId,
    leaseToken: documentDelivery.leaseToken,
    zulipMessageId: 20_101
  });
  const [prompt] = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(prompt.payload.kind, "interaction_request");
  assert.equal(prompt.payload.interaction.detail.mode, "document");
});

test("default approval renderer exposes policy decisions only through opaque action IDs", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      command: "npm test",
      availableDecisions: [
        "decline",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }
      ]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} acceptWithExecpolicyAmendment`));
  assert.match(detailContent, /execpolicy_amendment/);
  const policyAction = prompt.payload.interaction.actions.find((action) => action.class === "policy_change");
  assert.ok(policyAction);
  assert.match(prompt.payload.content, new RegExp(`/codex interact ${pending.interactionId} ${policyAction.actionId}`));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept$`, "m"));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
});

test("default approval renderer keeps accepting choices when commandActions is present", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      command: "npm test",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      commandActions: [{ command: "npm test" }]
    }
  }));
  const { prompt } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /扩展权限/);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} acceptForSession`));
  assert.ok(prompt.payload.interaction.actions.some((action) => action.class === "policy_change"));
});

for (const [field, value] of [
  ["networkApprovalContext", { host: "example.com" }]
]) {
  test(`default approval renderer keeps one-time approval when ${field} is present`, async (t) => {
    const fixture = controllerFixture(t);
    await fixture.controller.acceptIntent(intent());

    const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
      request: {
        command: "npm test",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        [field]: value
      }
    }));
    const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

    assert.ok(prompt);
    assert.match(detailContent, /example\.com/);
    assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
    assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} acceptForSession`));
    assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
    assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
  });
}

test("default user input renderer expands real single-question schema", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-1",
    request: {
      questions: [{
        id: "q1",
        header: "环境",
        question: "请选择发布环境",
        isOther: false,
        isSecret: false,
        options: [
          { label: "staging", description: "预发" },
          { label: "production", description: "生产" }
        ]
      }],
      autoResolutionMs: null
    }
  }));
  const { prompt } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.match(prompt.payload.content, /💬 \*\*输入请求\*\*/);
  assert.match(prompt.payload.content, /环境/);
  assert.match(prompt.payload.content, /请选择发布环境/);
  assert.match(prompt.payload.content, /q1/);
  assert.match(prompt.payload.content, /staging/);
  assert.match(prompt.payload.content, /production/);
  assert.match(prompt.payload.content, new RegExp(`/codex answer ${pending.interactionId} <你的回答>`));
  assert.doesNotMatch(prompt.payload.content, /\/codex approve/);
});

test("default user input renderer compacts oversized notifications", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-oversized",
    request: {
      questions: [{
        id: "q1",
        header: "Large question",
        question: "Choose an option",
        options: Array.from({ length: 200 }, (_, index) => ({
          label: `option-${index}`,
          description: "a".repeat(300)
        }))
      }]
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.ok(Buffer.byteLength(prompt.payload.content, "utf8") <= 60_000);
  assert.match(prompt.payload.content, /交互通知过大/);
  assert.match(prompt.payload.content, new RegExp(pending.interactionId));
  assert.match(prompt.payload.content, new RegExp(`/codex answer ${pending.interactionId} <你的回答>`));
});

test("default approval renderer chunks oversized details without losing decisions", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    itemId: "approval-item-oversized",
    request: {
      reason: "a".repeat(61_000),
      command: "npm test",
      availableDecisions: ["decline"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.ok(Buffer.byteLength(prompt.payload.content, "utf8") <= 60_000);
  assert.ok(detailContent.includes("a".repeat(10_000)));
  assert.equal(fixture.store.readInteractionDetail(pending.interactionId).chunkCount, 2);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.doesNotMatch(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
});

test("approval renderer uses extended fence for commands containing backticks", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      reason: "review ``` injected fence",
      command: "printf '```'",
      availableDecisions: ["accept", "cancel"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  // reason uses escapeMarkdownInline — backticks stay backslash-escaped in inline context
  assert.match(detailContent, /review ``` injected fence/);
  // command is verbatim inside the code fence (no backslash-escaping)
  assert.match(detailContent, /printf '```'/);
  // fence is extended to 4 backticks to prevent early close; no bare ``` fence markers
  assert.match(detailContent, /````/);
  assert.ok(!detailContent.match(/^```$/m), "no bare 3-backtick fence lines");
});

test("approval renderer uses codeSpan for cwd containing backticks", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      cwd: "/path/with`backtick/dir",
      command: "ls",
      availableDecisions: ["accept", "cancel"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  // codeSpan extends fence to 2 backticks; content is verbatim (no backslash before backtick)
  assert.match(detailContent, /\/path\/with`backtick\/dir/);
  assert.doesNotMatch(detailContent, /\/path\/with\\`backtick/);
});

test("input renderer uses codeSpan for option labels containing backticks", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    request: {
      questions: [
        {
          id: "q1",
          header: "Pick",
          question: "Choose one",
          options: [{ label: "opt`A", description: "first" }]
        }
      ]
    }
  }));
  const { prompt } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  // codeSpan uses `` fence; verbatim label (no backslash)
  assert.match(prompt.payload.content, /``opt`A``/);
  assert.doesNotMatch(prompt.payload.content, /`opt\\`A`/);
});

test("unsafe interactionId suppresses approval commands", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  // Inject an unsafe interactionId via the idFactory store option
  const pending = await fixture.controller.handleInteractionRequest(
    interactionRequest({ request: { command: "echo hi", availableDecisions: ["accept", "cancel"] } })
  );
  // Override the interactionId after the fact in the outbox content check
  // by checking that a normal UUID-based interactionId produces commands
  const { prompt } = claimInteractionPrompt(fixture.store);
  assert.ok(prompt);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
});

test("approval renderer suppresses all commands for an unsafe interactionId", async (t) => {
  // Use a custom idFactory that returns an unsafe id for the "interaction" kind
  const directory = mkdtempSync(path.join(tmpdir(), "hco-unsafe-id-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const counters = new Map();
  const idFactory = (kind) => {
    if (kind === "interaction") return "bad id with spaces";
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${next}`;
  };
  const store = openStore({ databasePath, idFactory });
  t.after(() => store.close());
  const controller = new TurnController({ store, appServerBackend: fakeBackend(), leaseOwner: "controller-unsafe" });
  await controller.acceptIntent(intent());
  await controller.handleInteractionRequest(
    interactionRequest({ request: { command: "echo hi", availableDecisions: ["accept", "cancel"] } })
  );
  const { prompt } = claimInteractionPrompt(store);
  assert.ok(prompt);
  // Unsafe interactionId → no approve or answer commands
  assert.doesNotMatch(prompt.payload.content, /\/codex approve/);
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
});

test("default approval renderer keeps a 401-character command complete and approvable", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      command: "x".repeat(401),
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /命令已截断/);
  assert.match(detailContent, new RegExp("x{401}"));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
});


test("default approval renderer chunks long UTF-8 details and skips malformed decisions", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    itemId: "approval-item-compact-truncated",
    request: {
      reason: "a".repeat(61_000),
      command: "x".repeat(401),
      availableDecisions: [null, "accept", "decline", "cancel"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.ok(Buffer.byteLength(prompt.payload.content, "utf8") <= 60_000);
  assert.doesNotMatch(prompt.payload.content, /交互通知过大|命令已截断/);
  assert.match(detailContent, new RegExp("x{401}"));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
});

test("default approval renderer keeps accept independent from proposed amendments and skips invalid decisions", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    request: {
      command: "npm test",
      availableDecisions: ["accept", "decline", "cancel", "bad`key", "apply/network"],
      proposedExecpolicyAmendment: ["npm", "test"]
    }
  }));
  const { prompt, detailContent } = claimInteractionPrompt(fixture.store);

  assert.ok(prompt);
  assert.match(detailContent, /命令策略变更建议/);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} accept`));
  assert.doesNotMatch(prompt.payload.content, /bad`key/);
  assert.doesNotMatch(prompt.payload.content, /apply\/network/);
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} decline`));
  assert.match(prompt.payload.content, new RegExp(`/codex approve ${pending.interactionId} cancel`));
});

test("default user input renderer escapes markdown fields and suppresses unsafe CLI IDs", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool`item",
    request: {
      toolName: "tool\n- `/codex approve fake accept`",
      questions: [{
        id: "q`1",
        header: "环境\n- `/codex approve fake accept`",
        question: "请选择 `prod`\n- fake",
        isOther: false,
        isSecret: false,
        options: [{ label: "staging`", description: "desc\n- injected" }]
      }]
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
  assert.doesNotMatch(prompt.payload.content, /^- `\/codex approve fake accept`/m);
  assert.match(prompt.payload.content, /App Server UI/);
  assert.match(prompt.payload.content, /\\`prod\\`/);
});

test("default user input renderer suppresses commands for a single question with whitespace in its ID", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-whitespace-single",
    request: {
      questions: [{
        id: "deploy target",
        header: "环境",
        question: "请选择发布环境",
        isOther: false,
        isSecret: false,
        options: null
      }],
      autoResolutionMs: null
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
  assert.match(prompt.payload.content, /App Server UI/);
});

test("default user input renderer suppresses commands when any question is secret", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-2",
    request: {
      questions: [
        { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
        { id: "q2", header: "令牌", question: "输入令牌", isOther: false, isSecret: true, options: null }
      ],
      autoResolutionMs: null
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  // isSecret question makes the entire interaction non-addressable via commands
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
  assert.match(prompt.payload.content, /App Server UI/);
  assert.match(prompt.payload.content, /敏感/);
  assert.doesNotMatch(prompt.payload.content, /选择环境|输入令牌|令牌/);
});

test("default user input renderer provides per-question commands when all questions are non-secret", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-2",
    request: {
      questions: [
        { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
        { id: "q2", header: "部署", question: "选择部署", isOther: false, isSecret: false, options: null }
      ],
      autoResolutionMs: null
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.match(prompt.payload.content, new RegExp(`/codex answer ${pending.interactionId} q1 <你的回答>`));
  assert.match(prompt.payload.content, new RegExp(`/codex answer ${pending.interactionId} q2 <你的回答>`));
  assert.match(prompt.payload.content, /全部回答后自动提交/);
});

test("default user input renderer suppresses commands for duplicate question IDs", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-duplicate-ids",
    request: {
      questions: [
        { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
        { id: "q1", header: "确认", question: "是否继续", isOther: false, isSecret: false, options: null }
      ],
      autoResolutionMs: null
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
  assert.match(prompt.payload.content, /App Server UI/);
});

test("default user input renderer preserves the generic command for an empty questions list", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  const pending = await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-empty-questions",
    request: { questions: [], autoResolutionMs: null }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.match(prompt.payload.content, new RegExp(`/codex answer ${pending.interactionId} <你的回答>`));
  assert.doesNotMatch(prompt.payload.content, /App Server UI/);
});

test("default user input renderer suppresses all commands when any question ID is not addressable", async (t) => {
  const fixture = controllerFixture(t);
  await fixture.controller.acceptIntent(intent());

  await fixture.controller.handleInteractionRequest(interactionRequest({
    method: "item/tool/requestUserInput",
    itemId: "tool-item-whitespace-mixed",
    request: {
      questions: [
        { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
        {
          id: "deploy target",
          header: "确认",
          question: "是否继续",
          isOther: false,
          isSecret: false,
          options: null
        }
      ],
      autoResolutionMs: null
    }
  }));
  const prompts = fixture.store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  const prompt = prompts.find((entry) => entry.payload.kind === "interaction_request");

  assert.ok(prompt);
  assert.doesNotMatch(prompt.payload.content, /\/codex answer/);
  assert.match(prompt.payload.content, /App Server UI/);
});

test("interaction persists before prompt rendering and preserves typed wire IDs and fixed expiry", async (t) => {
  let store;
  const fixture = controllerFixture(t);
  store = fixture.store;
  await fixture.controller.acceptIntent(intent());
  const renderedIds = [];
  const controller = new TurnController({
    store,
    appServerBackend: fakeBackend(),
    leaseOwner: "controller-1",
    interactionRenderer({ interaction }) {
      const durable = store.readInteraction(interaction.interactionId);
      assert.equal(durable.state, "pending");
      assert.equal(durable.wireRequestId, interaction.wireRequestId);
      renderedIds.push(interaction.interactionId);
      return {
        semanticKey: `interaction:${interaction.interactionId}:prompt`,
        payload: { content: "Approval requested.", kind: "interaction_request" }
      };
    }
  });
  const numeric = await controller.handleInteractionRequest(interactionRequest());
  const string = await controller.handleInteractionRequest(interactionRequest({
    wireRequestId: "7",
    itemId: "item-2",
    approvalId: "approval-2"
  }));
  assert.equal(store.readInteraction(numeric.interactionId).wireRequestId, 7);
  assert.equal(store.readInteraction(string.interactionId).wireRequestId, "7");
  assert.equal(store.readInteraction(numeric.interactionId).expiresAt, START_MS + 24 * 60 * 60 * 1_000);
  const duplicate = await controller.handleInteractionRequest(interactionRequest());
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(renderedIds, [numeric.interactionId, string.interactionId]);
  const firstPrompt = store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 });
  assert.equal(firstPrompt.length, 1);
  store.ackOutbox({
    deliveryId: firstPrompt[0].deliveryId,
    leaseToken: firstPrompt[0].leaseToken,
    zulipMessageId: 1
  });
  assert.equal(store.claimOutbox({ workerId: "worker", limit: 10, leaseMs: 1_000 }).length, 1);
});

test("interaction answer authorizes immutable sender and target then commits before one backend response", async (t) => {
  let store;
  let backendCalls = 0;
  const backend = fakeBackend({
    respondToInteraction: async (options) => {
      backendCalls += 1;
      const durable = store.readInteraction(options.interactionId);
      assert.equal(durable.state, "answered");
      assert.deepEqual(durable.answer, { decision: "accept" });
      assert.deepEqual(options, {
        interactionId: durable.interactionId,
        wireRequestId: 7,
        result: { decision: "accept" }
      });
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  store = fixture.store;
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const acceptAction = store.readInteraction(pending.interactionId).actions.find(
    (action) => action.sourceKey === "accept"
  );
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" },
    audit: {
      actionId: acceptAction.actionId,
      actionClass: acceptAction.actionClass,
      resolutionSource: "explicit_action",
      sourceType: "zulip-message",
      sourceMessageId: "501"
    }
  };
  await assert.rejects(
    fixture.controller.answerInteraction({ ...answer, responderId: 999 }),
    (error) => assertCode(error, "INTERACTION_UNAUTHORIZED")
  );
  await assert.rejects(
    fixture.controller.answerInteraction({ ...answer, targetSnapshot: { streamId: 42, topic: "Other" } }),
    (error) => assertCode(error, "INTERACTION_TARGET_MISMATCH")
  );
  assert.equal(backendCalls, 0);
  const answered = await fixture.controller.answerInteraction(answer);
  assert.equal(answered.status, "answered");
  assert.equal(Object.hasOwn(store.readInteraction(pending.interactionId).answer, "policyAmendment"), false);
  assert.deepEqual(store.readInteractionSettlementAudit(pending.interactionId), {
    interactionId: pending.interactionId,
    actionId: acceptAction.actionId,
    actionClass: "one_time_allow",
    resolutionSource: "explicit_action",
    sourceType: "zulip-message",
    sourceMessageId: "501",
    detailSha256: store.readInteractionDetail(pending.interactionId).contentSha256,
    responderId: 101,
    settledAt: START_MS
  });
  const duplicate = await fixture.controller.answerInteraction(answer);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, "already_answered");
  assert.equal(backendCalls, 1);
  await assert.rejects(
    fixture.controller.answerInteraction({ ...answer, answer: { decision: "decline" } }),
    (error) => assertCode(error, "INTERACTION_ANSWER_CONFLICT")
  );
  assert.equal(backendCalls, 1);
});

test("confirmed pre-write interaction response failure is durably retryable after restart", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      if (backendCalls === 1) {
        throw executionBackendError(
          "EXECUTION_BACKEND_UNAVAILABLE",
          "Execution backend is unavailable.",
          { mayHaveBeenWritten: false }
        );
      }
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  const failed = await fixture.controller.answerInteraction(answer);
  assert.equal(failed.status, "response_retryable");
  assert.equal(fixture.store.readInteraction(pending.interactionId).responseDeliveryState, "retryable");
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const retried = await reopenedController.answerInteraction(answer);

  assert.equal(retried.status, "answered");
  assert.equal(retried.duplicate, true);
  assert.equal(reopenedStore.readInteraction(pending.interactionId).responseDeliveryState, "delivered");
  assert.equal(backendCalls, 2);
});

test("explicit orphan preserves answered interaction settlement across restart without resend", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  assert.equal((await fixture.controller.answerInteraction(answer)).status, "response_uncertain");
  const settled = fixture.store.readInteraction(pending.interactionId);
  assert.deepEqual(
    { answer: settled.answer, answeredById: settled.answeredById, answeredAt: settled.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  assert.equal(settled.responseDeliveryState, "uncertain");

  assert.equal(fixture.controller.orphanInteractions({ connectionId: "connection-1" }).orphaned, 1);
  const orphaned = fixture.store.readInteraction(pending.interactionId);
  assert.equal(orphaned.state, "orphaned");
  assert.deepEqual(
    { answer: orphaned.answer, answeredById: orphaned.answeredById, answeredAt: orphaned.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const restarted = reopenedStore.readInteraction(pending.interactionId);
  assert.deepEqual(
    { answer: restarted.answer, answeredById: restarted.answeredById, answeredAt: restarted.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  await assert.rejects(
    reopenedController.answerInteraction(answer),
    (error) => assertCode(error, "INTERACTION_ORPHANED")
  );
  assert.equal(backendCalls, 1);
});

test("connection loss preserves answered interaction settlement across restart without resend", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      if (backendCalls === 1) {
        throw executionBackendError(
          "EXECUTION_BACKEND_UNAVAILABLE",
          "Execution backend is unavailable.",
          { mayHaveBeenWritten: false }
        );
      }
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  assert.equal((await fixture.controller.answerInteraction(answer)).status, "response_retryable");
  const settled = fixture.store.readInteraction(pending.interactionId);
  assert.deepEqual(
    { answer: settled.answer, answeredById: settled.answeredById, answeredAt: settled.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  assert.equal(settled.responseDeliveryState, "retryable");

  const lost = fixture.controller.handleConnectionLost({ connectionId: "connection-1" });
  assert.equal(lost.orphanedInteractions, 1);
  const orphaned = fixture.store.readInteraction(pending.interactionId);
  assert.equal(orphaned.state, "orphaned");
  assert.deepEqual(
    { answer: orphaned.answer, answeredById: orphaned.answeredById, answeredAt: orphaned.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const restarted = reopenedStore.readInteraction(pending.interactionId);
  assert.deepEqual(
    { answer: restarted.answer, answeredById: restarted.answeredById, answeredAt: restarted.answeredAt },
    { answer: { decision: "accept" }, answeredById: 101, answeredAt: START_MS }
  );
  await assert.rejects(
    reopenedController.answerInteraction(answer),
    (error) => {
      assertCode(error, "INTERACTION_ORPHANED");
      assert.equal(error.message, "Interaction is orphaned.");
      return true;
    }
  );
  assert.equal(backendCalls, 1);
});

test("uncertain interaction response is durable across restart and is never blindly resent", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  await fixture.controller.acceptIntent(intent());
  const pending = await fixture.controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  const uncertain = await fixture.controller.answerInteraction(answer);
  assert.equal(uncertain.status, "response_uncertain");
  assert.equal(fixture.store.readInteraction(pending.interactionId).responseDeliveryState, "uncertain");
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS });
  t.after(() => reopenedStore.close());
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: backend,
    leaseOwner: "controller-restarted"
  });
  const repeated = await reopenedController.answerInteraction(answer);

  assert.equal(repeated.status, "response_uncertain");
  assert.equal(repeated.duplicate, true);
  assert.equal(backendCalls, 1);
});

test("successful interaction response delivery is persisted and repeated answers do not resend", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({ respondToInteraction: async () => { backendCalls += 1; } });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const pending = await controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  const delivered = await controller.answerInteraction(answer);
  const repeated = await controller.answerInteraction(answer);

  assert.equal(delivered.status, "answered");
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "delivered");
  assert.equal(repeated.duplicate, true);
  assert.equal(backendCalls, 1);
});

test("concurrent identical interaction answers hold one response lease and send only once", async (t) => {
  let backendCalls = 0;
  let releaseResponse;
  let responseStarted;
  const started = new Promise((resolve) => { responseStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseResponse = resolve; });
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      responseStarted();
      await blocked;
    }
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const pending = await controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  const firstPromise = controller.answerInteraction(answer);
  await started;
  const concurrent = await controller.answerInteraction(answer);

  assert.equal(concurrent.status, "response_uncertain");
  assert.equal(concurrent.duplicate, true);
  assert.equal(backendCalls, 1);
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "pending");

  releaseResponse();
  const first = await firstPromise;
  assert.equal(first.status, "answered");
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "delivered");
  assert.equal(backendCalls, 1);
});

test("expired interaction response lease becomes uncertain and is never blindly replayed", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({ respondToInteraction: async () => { backendCalls += 1; } });
  const { clock, controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const pending = await controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };
  assert.equal(store.commitInteractionAnswer(answer).accepted, true);
  assert.equal(store.claimInteractionResponse({
    interactionId: pending.interactionId,
    leaseOwner: "crashed-controller"
  }).acquired, true);

  clock.value += (2 * 60 * 1_000) + 1;
  const afterExpiry = await controller.answerInteraction(answer);
  const repeated = await controller.answerInteraction(answer);

  assert.equal(afterExpiry.status, "response_uncertain");
  assert.equal(afterExpiry.duplicate, true);
  assert.equal(repeated.status, "response_uncertain");
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "uncertain");
  assert.equal(backendCalls, 0);
});

test("a live response holder returns response_uncertain when its lease expires mid-flight", async (t) => {
  let backendCalls = 0;
  let releaseResponse;
  let responseStarted;
  const started = new Promise((resolve) => { responseStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseResponse = resolve; });
  const backend = fakeBackend({
    respondToInteraction: async () => {
      backendCalls += 1;
      responseStarted();
      await blocked;
    }
  });
  const { clock, controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const pending = await controller.handleInteractionRequest(interactionRequest());
  const answer = {
    interactionId: pending.interactionId,
    responderId: 101,
    targetSnapshot: { streamId: 42, topic: "Build" },
    answer: { decision: "accept" }
  };

  const holder = controller.answerInteraction(answer);
  await started;
  clock.value += (2 * 60 * 1_000) + 1;

  const observer = await controller.answerInteraction(answer);
  assert.equal(observer.status, "response_uncertain");
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "uncertain");

  releaseResponse();
  const lateHolder = await holder;
  assert.equal(lateHolder.status, "response_uncertain");
  assert.equal(store.readInteraction(pending.interactionId).responseDeliveryState, "uncertain");
  assert.equal(backendCalls, 1);
});

for (const scenario of [
  {
    label: "explicit orphaning",
    orphan(controller) {
      const result = controller.orphanInteractions({ connectionId: "connection-1" });
      assert.equal(result.orphaned, 1);
    }
  },
  {
    label: "connection loss",
    orphan(controller) {
      const result = controller.handleConnectionLost({ connectionId: "connection-1" });
      assert.equal(result.orphanedInteractions, 1);
    }
  }
]) {
  test(`${scenario.label} clears a mid-flight response lease and stabilizes the holder`, async (t) => {
    let releaseResponse;
    let responseStarted;
    const started = new Promise((resolve) => { responseStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseResponse = resolve; });
    const backend = fakeBackend({
      respondToInteraction: async () => {
        responseStarted();
        await blocked;
      }
    });
    const { controller, databasePath, store } = controllerFixture(t, { appServerBackend: backend });
    const db = new Database(databasePath, { readonly: true });
    t.after(() => db.close());
    await controller.acceptIntent(intent());
    const pending = await controller.handleInteractionRequest(interactionRequest());
    const answer = {
      interactionId: pending.interactionId,
      responderId: 101,
      targetSnapshot: { streamId: 42, topic: "Build" },
      answer: { decision: "accept" }
    };

    const holder = controller.answerInteraction(answer);
    await started;
    const leaseCount = () => db.prepare(`
      SELECT count(*) AS count FROM resource_leases
      WHERE resource_type = 'interaction_response' AND resource_id = ?
    `).get(pending.interactionId).count;
    assert.equal(leaseCount(), 1);

    scenario.orphan(controller);
    assert.equal(store.readInteraction(pending.interactionId).state, "orphaned");
    assert.equal(leaseCount(), 0);

    releaseResponse();
    const lateHolder = await holder;
    assert.equal(lateHolder.status, "response_uncertain");
    assert.equal(store.readInteraction(pending.interactionId).state, "orphaned");
  });
}

test("expired and orphaned interactions reject answers without a backend response", async (t) => {
  let backendCalls = 0;
  const backend = fakeBackend({ respondToInteraction: async () => { backendCalls += 1; } });
  const { clock, controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  const expired = await controller.handleInteractionRequest(interactionRequest());
  clock.value += 24 * 60 * 60 * 1_000;
  await assert.rejects(
    controller.answerInteraction({
      interactionId: expired.interactionId,
      responderId: 101,
      targetSnapshot: { streamId: 42, topic: "Build" },
      answer: { decision: "accept" }
    }),
    (error) => {
      assert.equal(isStateError(error), true);
      return assertCode(error, "INTERACTION_EXPIRED");
    }
  );
  assert.equal(store.readInteraction(expired.interactionId).state, "expired");

  clock.value = START_MS;
  const orphaned = await controller.handleInteractionRequest(interactionRequest({
    wireRequestId: "orphan-1",
    itemId: "item-orphan",
    approvalId: "approval-orphan"
  }));
  assert.equal(controller.orphanInteractions({ connectionId: "connection-1" }).orphaned, 1);
  await assert.rejects(
    controller.answerInteraction({
      interactionId: orphaned.interactionId,
      responderId: 101,
      targetSnapshot: { streamId: 42, topic: "Build" },
      answer: { decision: "accept" }
    }),
    (error) => assertCode(error, "INTERACTION_ORPHANED")
  );
  await assert.rejects(
    controller.handleInteractionRequest(interactionRequest({ method: "unknown/request", wireRequestId: 99 })),
    (error) => assertCode(error, "INTERACTION_REQUEST_UNSUPPORTED")
  );
  assert.equal(backendCalls, 0);
});

test("connection loss marks active App Server work for reconciliation and orphans its interactions without tmux fallback", async (t) => {
  let tmuxCalls = 0;
  const tmuxBackend = createTmuxBackend({ executor: {
    startObjective: async () => (tmuxCalls += 1, {}),
    startTurn: async () => (tmuxCalls += 1, {}),
    interruptTurn: async () => (tmuxCalls += 1, {}),
    readObjective: async () => (tmuxCalls += 1, {}),
    reconcileObjective: async () => (tmuxCalls += 1, {}),
    respondToInteraction: async () => (tmuxCalls += 1, undefined)
  } });
  const { controller, store } = controllerFixture(t, { tmuxBackend });
  await controller.acceptIntent(intent());
  const pending = await controller.handleInteractionRequest(interactionRequest());

  const lost = controller.handleConnectionLost({ connectionId: "connection-1" });

  assert.deepEqual(lost, {
    status: "reconciliation_needed",
    affectedObjectives: 1,
    orphanedInteractions: 1
  });
  const execution = store.readObjectiveExecution("objective-1");
  assert.equal(execution.backend, "app-server");
  assert.equal(execution.executionStatus, "reconciliation_needed");
  assert.equal(execution.activeSubmission.state, "reconciliation_needed");
  assert.equal(execution.activeSubmission.reconciliationRequired, true);
  assert.equal(store.readInteraction(pending.interactionId).state, "orphaned");
  assert.equal(tmuxCalls, 0);
});

test("two objectives keep leases, threads, turns, outputs, and interactions isolated", async (t) => {
  const backend = fakeBackend({
    startObjective: async ({ objectiveId }) => ({ threadId: `thread-${objectiveId}` }),
    startTurn: async ({ threadId }) => ({ turnId: `turn-${threadId}` })
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  await controller.acceptIntent(intent({
    sourceId: "message-2",
    objectiveId: "objective-2",
    targetSnapshot: { streamId: 42, topic: "Review" }
  }));

  const firstExecution = store.readObjectiveExecution("objective-1");
  const secondExecution = store.readObjectiveExecution("objective-2");
  assert.equal(firstExecution.threadId, "thread-objective-1");
  assert.equal(secondExecution.threadId, "thread-objective-2");
  assert.equal(firstExecution.activeSubmission.turnId, "turn-thread-objective-1");
  assert.equal(secondExecution.activeSubmission.turnId, "turn-thread-objective-2");
  assert.notEqual(firstExecution.activeSubmission.leaseToken, secondExecution.activeSubmission.leaseToken);

  const firstInteraction = await controller.handleInteractionRequest(interactionRequest({
    threadId: firstExecution.threadId,
    turnId: firstExecution.activeSubmission.turnId
  }));
  const secondInteraction = await controller.handleInteractionRequest(interactionRequest({
    connectionId: "connection-2",
    objectiveId: "objective-2",
    threadId: secondExecution.threadId,
    turnId: secondExecution.activeSubmission.turnId,
    itemId: "item-2",
    targetSnapshot: { streamId: 42, topic: "Review" }
  }));

  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: firstExecution.activeSubmission.turnId,
      status: "completed",
      itemsView: "full",
      items: [{ id: "final-1", type: "agentMessage", status: "completed", phase: "final_answer", text: "first" }]
    },
    sourceType: "app-server",
    sourceId: "terminal-objective-1"
  });
  await controller.handleTurnCompleted({
    objectiveId: "objective-2",
    turn: {
      id: secondExecution.activeSubmission.turnId,
      status: "completed",
      itemsView: "full",
      items: [{ id: "final-2", type: "agentMessage", status: "completed", phase: "final_answer", text: "second" }]
    },
    sourceType: "app-server",
    sourceId: "terminal-objective-2"
  });

  assert.equal(store.readTurnOutput("objective-1", firstExecution.activeSubmission.turnId).rawText, "first");
  assert.equal(store.readTurnOutput("objective-2", secondExecution.activeSubmission.turnId).rawText, "second");
  assert.equal(store.readInteraction(firstInteraction.interactionId).objectiveId, "objective-1");
  assert.equal(store.readInteraction(secondInteraction.interactionId).objectiveId, "objective-2");
  assert.notEqual(firstInteraction.interactionId, secondInteraction.interactionId);
});

test("terminal transition invariant rejects marking a completed submission unknown", async (t) => {
  const { store, submissionId, turnId } = await completedObjectiveFixture(t);
  const before = {
    execution: store.readObjectiveExecution("objective-1"),
    submission: store.readTurnSubmission("objective-1", turnId),
    output: store.readTurnOutput("objective-1", turnId)
  };

  assert.throws(
    () => store.markSubmissionUnknown({ submissionId }),
    (error) => assertCode(error, "SUBMISSION_TRANSITION_INVALID")
  );

  assert.deepEqual(store.readObjectiveExecution("objective-1"), before.execution);
  assert.deepEqual(store.readTurnSubmission("objective-1", turnId), before.submission);
  assert.deepEqual(store.readTurnOutput("objective-1", turnId), before.output);
});

test("terminal transition invariant rejects reconciling a completed submission back to running", async (t) => {
  const { store, submissionId, turnId } = await completedObjectiveFixture(t);
  const before = {
    execution: store.readObjectiveExecution("objective-1"),
    submission: store.readTurnSubmission("objective-1", turnId),
    output: store.readTurnOutput("objective-1", turnId)
  };

  assert.throws(
    () => store.reconcileTurnSubmission({ submissionId, turnId }),
    (error) => assertCode(error, "SUBMISSION_TRANSITION_INVALID")
  );

  assert.deepEqual(store.readObjectiveExecution("objective-1"), before.execution);
  assert.deepEqual(store.readTurnSubmission("objective-1", turnId), before.submission);
  assert.deepEqual(store.readTurnOutput("objective-1", turnId), before.output);
});

test("terminal transition invariant rejects recording backend failure after completion", async (t) => {
  const { store, submissionId, turnId } = await completedObjectiveFixture(t);
  const before = {
    execution: store.readObjectiveExecution("objective-1"),
    submission: store.readTurnSubmission("objective-1", turnId),
    output: store.readTurnOutput("objective-1", turnId)
  };

  assert.throws(
    () => store.markBackendFailure({ objectiveId: "objective-1", submissionId, uncertain: false }),
    (error) => assertCode(error, "SUBMISSION_TRANSITION_INVALID")
  );

  assert.deepEqual(store.readObjectiveExecution("objective-1"), before.execution);
  assert.deepEqual(store.readTurnSubmission("objective-1", turnId), before.submission);
  assert.deepEqual(store.readTurnOutput("objective-1", turnId), before.output);
});

test("completed objective accepts new-source turns on its existing thread without reopening old submissions", async (t) => {
  let startObjectiveCalls = 0;
  let startTurnCalls = 0;
  const backend = fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      return { threadId: "thread-1" };
    },
    startTurn: async () => {
      startTurnCalls += 1;
      return { turnId: `turn-${startTurnCalls}` };
    }
  });
  const { controller, databasePath, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "terminal-no-reopen",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "terminal output"
      }]
    },
    sourceType: "app-server",
    sourceId: "terminal-no-reopen-completion"
  });
  const firstSubmission = store.readTurnSubmission("objective-1", "turn-1");
  const firstOutput = store.readTurnOutput("objective-1", "turn-1");

  const replayed = await controller.acceptIntent(intent());
  assert.equal(replayed.status, "duplicate");
  assert.equal(replayed.turnId, "turn-1");

  const continued = await controller.continueObjective({
    sourceType: "zulip",
    sourceId: "terminal-continuation",
    objectiveId: "objective-1",
    text: "continue after completion",
    targetSnapshot: { streamId: 42, topic: "Build" }
  });
  assert.equal(continued.status, "started");
  assert.equal(continued.threadId, "thread-1");
  assert.equal(continued.turnId, "turn-2");
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-2",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "continued-output",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "continued output"
      }]
    },
    sourceType: "app-server",
    sourceId: "continued-completion"
  });
  const accepted = await controller.acceptIntent(intent({
    sourceId: "terminal-new-accept",
    text: "new accept after completion"
  }));

  assert.equal(accepted.status, "started");
  assert.equal(accepted.threadId, "thread-1");
  assert.equal(accepted.turnId, "turn-3");
  assert.equal(startObjectiveCalls, 1);
  assert.equal(startTurnCalls, 3);
  const execution = store.readObjectiveExecution("objective-1");
  assert.equal(execution.executionStatus, "running");
  assert.equal(execution.activeSubmission.turnId, "turn-3");
  assert.deepEqual(store.readTurnSubmission("objective-1", "turn-1"), firstSubmission);
  assert.deepEqual(store.readTurnOutput("objective-1", "turn-1"), firstOutput);

  const db = new Database(databasePath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM inbound_intents").get().count, 3);
    assert.equal(db.prepare("SELECT count(*) AS count FROM turn_submissions").get().count, 3);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM turn_submissions WHERE submission_state = 'completed'").get().count,
      2
    );
  } finally {
    db.close();
  }
});

test("completion source identity conflict is owned and rolls back the second turn", async (t) => {
  const backend = fakeBackend({
    startObjective: async ({ objectiveId }) => ({ threadId: `thread-${objectiveId}` }),
    startTurn: async ({ threadId }) => ({ turnId: `turn-${threadId}` })
  });
  const { controller, databasePath, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  await controller.acceptIntent(intent({ sourceId: "message-2", objectiveId: "objective-2" }));
  const firstTurnId = store.readObjectiveExecution("objective-1").activeSubmission.turnId;
  const secondTurnId = store.readObjectiveExecution("objective-2").activeSubmission.turnId;
  const completedTurn = (turnId, text) => ({
    id: turnId,
    status: "completed",
    itemsView: "full",
    items: [{ id: `final-${turnId}`, type: "agentMessage", status: "completed", phase: "final_answer", text }]
  });

  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: completedTurn(firstTurnId, "first output"),
    sourceType: "app-server",
    sourceId: "shared-terminal-source"
  });
  await assert.rejects(
    controller.handleTurnCompleted({
      objectiveId: "objective-2",
      turn: completedTurn(secondTurnId, "second output"),
      sourceType: "app-server",
      sourceId: "shared-terminal-source"
    }),
    (error) => {
      assertCode(error, "TURN_COMPLETION_SOURCE_CONFLICT");
      assert.equal(error.message.includes("SQLITE"), false);
      assert.equal(error.message.includes("UNIQUE"), false);
      assert.equal(error.message.includes("event_journal"), false);
      assert.equal(error.message.includes("turn_audit_facts"), false);
      return true;
    }
  );

  const secondExecution = store.readObjectiveExecution("objective-2");
  assert.equal(secondExecution.executionStatus, "running");
  assert.equal(secondExecution.activeSubmission.state, "running");
  assert.equal(store.readTurnOutput("objective-2", secondTurnId), null);
  assert.deepEqual(store.readTurnAuditFacts("objective-2"), []);
  const db = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM zulip_outbox WHERE objective_id = 'objective-2'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test("continueObjective preserves trusted project and topic binding for an existing real thread", async (t) => {
  const { controller, store } = controllerFixture(t);
  store.registerExecutionIntent(intent({
    sourceId: "controlled-bootstrap",
    projectId: "alpha",
    topicBinding: { streamId: 42, topic: "Original", actorUserId: 3 }
  }));
  store.bindBackendObjective({ objectiveId: "objective-1", backend: "app-server", threadId: "thread-1" });

  const result = await controller.continueObjective({
    sourceType: "zulip-message",
    sourceId: "controlled-continuation",
    objectiveId: "objective-1",
    projectId: "alpha",
    text: "Continue on the selected topic.",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Selected", sourceMessageId: 99 },
    threadOptions: { cwd: "/registered/project" },
    topicBinding: { streamId: 42, topic: "Selected", actorUserId: 3 }
  });

  assert.equal(result.status, "started");
  assert.equal(store.readObjectiveProject("objective-1"), "alpha");
  assert.deepEqual(store.readTopicState({ streamId: 42, topic: "Selected" }), {
    streamId: 42,
    topic: "Selected",
    mode: "CODEX_BOUND",
    projectId: "alpha",
    objectiveId: "objective-1",
    threadId: "thread-1"
  });
});

test("proven missing legacy thread is replaced once and the original continuation is submitted unchanged", async (t) => {
  let startObjectiveCalls = 0;
  const startTurnCalls = [];
  const backend = fakeBackend({
    startObjective: async () => ({ threadId: ++startObjectiveCalls === 1 ? "thread-old" : "thread-replacement" }),
    startTurn: async (options) => {
      startTurnCalls.push(options);
      if (startTurnCalls.length === 1) return { turnId: "turn-initial" };
      if (startTurnCalls.length === 2) return { turnId: "turn-second-topic" };
      if (options.threadId === "thread-old") {
        throw executionBackendError(
          "EXECUTION_BACKEND_OBJECTIVE_MISSING",
          "Execution backend objective does not exist."
        );
      }
      return { turnId: "turn-replacement" };
    }
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent({
    projectId: "alpha",
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  }));
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "initial-final",
        type: "agentMessage",
        status: "completed",
        phase: "final_answer",
        text: "initial complete"
      }]
    },
    sourceType: "app-server",
    sourceId: "initial-completion"
  });
  const secondTopic = await controller.continueObjective({
    sourceType: "zulip-message",
    sourceId: "second-topic-continuation",
    objectiveId: "objective-1",
    projectId: "alpha",
    text: "Bind a second topic to this objective.",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Follow-up", sourceMessageId: 954 },
    topicBinding: { streamId: 42, topic: "Follow-up", actorUserId: 3 }
  });
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: secondTopic.turnId,
      status: "completed",
      itemsView: "full",
      items: [{ id: "second-final", type: "agentMessage", phase: "final_answer", text: "second complete" }]
    },
    sourceType: "app-server",
    sourceId: "second-topic-completion"
  });

  const continuation = {
    sourceType: "zulip-message",
    sourceId: "legacy-continuation",
    objectiveId: "objective-1",
    projectId: "alpha",
    text: "Assess the current project in exactly 1000 Chinese characters.",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Legacy", sourceMessageId: 955 },
    threadOptions: { cwd: "/registered/project" },
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  };
  const result = await controller.continueObjective(continuation);

  assert.equal(result.status, "started");
  assert.equal(result.threadId, "thread-replacement");
  assert.equal(result.turnId, "turn-replacement");
  assert.equal(startObjectiveCalls, 2);
  assert.equal(startTurnCalls.length, 4);
  assert.deepEqual(startTurnCalls[3], {
    threadId: "thread-replacement",
    text: continuation.text,
    clientUserMessageId: startTurnCalls[2].clientUserMessageId
  });
  assert.equal(store.readObjectiveExecution("objective-1").threadId, "thread-replacement");
  assert.deepEqual(store.readTopicState({ streamId: 42, topic: "Legacy" }), {
    streamId: 42,
    topic: "Legacy",
    mode: "CODEX_BOUND",
    projectId: "alpha",
    objectiveId: "objective-1",
    threadId: "thread-replacement"
  });
  assert.equal(store.readTopicState({ streamId: 42, topic: "Follow-up" }).threadId,
    "thread-replacement");
  const replacementFact = store.readTurnAuditFacts("objective-1")
    .find(({ fact }) => fact.kind === "app_server_thread_replaced");
  assert.deepEqual(replacementFact?.fact, {
    kind: "app_server_thread_replaced",
    newThreadId: "thread-replacement",
    oldThreadId: "thread-old",
    reason: "proven_missing_thread"
  });
  assert.equal(replacementFact?.submissionId, result.submissionId);
});

test("a replacement turn failure never creates another replacement thread", async (t) => {
  let startObjectiveCalls = 0;
  const startTurnCalls = [];
  const backend = fakeBackend({
    startObjective: async () => ({ threadId: `thread-${++startObjectiveCalls}` }),
    startTurn: async (options) => {
      startTurnCalls.push(options);
      if (startTurnCalls.length === 1) return { turnId: "turn-initial" };
      throw executionBackendError(
        "EXECUTION_BACKEND_OBJECTIVE_MISSING",
        "Execution backend objective does not exist."
      );
    }
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }]
    },
    sourceType: "app-server",
    sourceId: "replacement-failure-initial-completion"
  });

  const result = await controller.continueObjective({
    objectiveId: "objective-1",
    sourceId: "replacement-turn-missing",
    text: "Create only one replacement.",
    targetSnapshot: { streamId: 42, topic: "Build" }
  });

  assert.equal(result.status, "backend_unavailable");
  assert.equal(result.threadId, "thread-2");
  assert.equal(startObjectiveCalls, 2);
  assert.equal(startTurnCalls.length, 3);
  assert.equal(store.readObjectiveExecution("objective-1").threadId, "thread-2");
  assert.equal(store.readTurnAuditFacts("objective-1")
    .filter(({ fact }) => fact.kind === "app_server_thread_replaced").length, 1);
});

test("an uncertain continuation never replaces its durable thread", async (t) => {
  let startObjectiveCalls = 0;
  let startTurnCalls = 0;
  const backend = fakeBackend({
    startObjective: async () => ({ threadId: `thread-${++startObjectiveCalls}` }),
    startTurn: async () => {
      startTurnCalls += 1;
      if (startTurnCalls === 1) return { turnId: "turn-initial" };
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    }
  });
  const { controller, store } = controllerFixture(t, { appServerBackend: backend });
  await controller.acceptIntent(intent());
  await controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }]
    },
    sourceType: "app-server",
    sourceId: "uncertain-initial-completion"
  });

  const result = await controller.continueObjective({
    objectiveId: "objective-1",
    sourceId: "uncertain-continuation",
    text: "Do not replace this thread.",
    targetSnapshot: { streamId: 42, topic: "Build" }
  });

  assert.equal(result.status, "submission_unknown");
  assert.equal(result.threadId, "thread-1");
  assert.equal(startObjectiveCalls, 1);
  assert.equal(store.readObjectiveExecution("objective-1").threadId, "thread-1");
  assert.equal(store.readTurnAuditFacts("objective-1")
    .some(({ fact }) => fact.kind === "app_server_thread_replaced"), false);
});

test("uncertain replacement thread creation is durable and resumes only after explicit binding", async (t) => {
  let startObjectiveCalls = 0;
  const startTurnCalls = [];
  const backend = fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      if (startObjectiveCalls === 1) return { threadId: "thread-old" };
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    },
    startTurn: async (options) => {
      startTurnCalls.push(options);
      if (startTurnCalls.length === 1) return { turnId: "turn-initial" };
      throw executionBackendError(
        "EXECUTION_BACKEND_OBJECTIVE_MISSING",
        "Execution backend objective does not exist."
      );
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: backend });
  await fixture.controller.acceptIntent(intent({
    projectId: "alpha",
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  }));
  await fixture.controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial",
      status: "completed",
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }]
    },
    sourceType: "app-server",
    sourceId: "replacement-uncertain-initial-completion"
  });

  const accepted = await fixture.controller.continueObjective({
    sourceType: "zulip-message",
    sourceId: "replacement-uncertain-continuation",
    objectiveId: "objective-1",
    projectId: "alpha",
    text: "Resume only after explicit replacement binding.",
    targetSnapshot: { streamId: 42, topic: "Legacy" },
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  });
  assert.equal(accepted.status, "manual_thread_binding_required");
  const uncertain = fixture.store.readObjectiveExecution("objective-1");
  assert.equal(uncertain.executionStatus, "reconciliation_needed");
  assert.equal(uncertain.threadStartUncertain, true);
  assert.equal(uncertain.threadId, "thread-old");
  assert.equal(uncertain.activeSubmission.state, "reconciliation_needed");
  assert.equal(startObjectiveCalls, 2);
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS + 1 });
  t.after(() => reopenedStore.close());
  const reboundTurnCalls = [];
  const reopenedBackend = fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      return { threadId: "thread-must-not-be-created" };
    },
    startTurn: async (options) => {
      reboundTurnCalls.push(options);
      return { turnId: "turn-after-operator-binding" };
    }
  });
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: reopenedBackend,
    leaseOwner: "controller-restarted"
  });
  assert.deepEqual(await reopenedController.reconcileObjective({ objectiveId: "objective-1" }), {
    status: "manual_thread_binding_required",
    objectiveId: "objective-1"
  });

  const rebound = await reopenedController.resolveObjectiveThread({
    objectiveId: "objective-1",
    threadId: "thread-operator-confirmed",
    sourceType: "operator",
    sourceId: "replacement-binding-1"
  });
  assert.equal(rebound.status, "started");
  assert.equal(rebound.threadId, "thread-operator-confirmed");
  assert.equal(rebound.turnId, "turn-after-operator-binding");
  assert.equal(startObjectiveCalls, 2);
  assert.deepEqual(reboundTurnCalls, [{
    threadId: "thread-operator-confirmed",
    text: "Resume only after explicit replacement binding.",
    clientUserMessageId: uncertain.activeSubmission.clientUserMessageId
  }]);
  assert.equal(reopenedStore.readObjectiveExecution("objective-1").threadStartUncertain, false);
  assert.deepEqual(reopenedStore.readTopicState({ streamId: 42, topic: "Legacy" }).threadId,
    "thread-operator-confirmed");
  const duplicateBinding = await reopenedController.resolveObjectiveThread({
    objectiveId: "objective-1",
    threadId: "thread-operator-confirmed",
    sourceType: "operator",
    sourceId: "replacement-binding-1"
  });
  assert.equal(duplicateBinding.duplicate, true);
  assert.equal(duplicateBinding.status, "running");
  assert.equal(reboundTurnCalls.length, 1);
});

test("duplicate operator binding resumes only a durable known-never-sent intent", async (t) => {
  let startObjectiveCalls = 0;
  let initialStartTurnCalls = 0;
  const initialBackend = fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      if (startObjectiveCalls === 1) return { threadId: "thread-old" };
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
        "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    },
    startTurn: async () => {
      initialStartTurnCalls += 1;
      if (initialStartTurnCalls === 1) return { turnId: "turn-initial" };
      throw executionBackendError("EXECUTION_BACKEND_OBJECTIVE_MISSING", "Execution backend objective does not exist.");
    }
  });
  const fixture = controllerFixture(t, { appServerBackend: initialBackend });
  await fixture.controller.acceptIntent(intent({
    projectId: "alpha", topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  }));
  await fixture.controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial", status: "completed", itemsView: "full",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }]
    },
    sourceType: "app-server", sourceId: "binding-crash-initial-completion"
  });
  assert.equal((await fixture.controller.continueObjective({
    sourceType: "zulip-message", sourceId: "binding-crash-continuation", objectiveId: "objective-1",
    projectId: "alpha", text: "Preserve this exact text.",
    targetSnapshot: { streamId: 42, topic: "Legacy" },
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  })).status, "manual_thread_binding_required");

  const preCrash = fixture.store.readObjectiveExecution("objective-1").activeSubmission;
  const firstBinding = fixture.store.resolveObjectiveThread({
    objectiveId: "objective-1", threadId: "thread-operator-confirmed",
    sourceType: "zulip-message", sourceId: "230"
  });
  assert.equal(firstBinding.duplicate, false);
  assert.equal(fixture.store.readObjectiveExecution("objective-1").activeSubmission.state, "intent");
  fixture.store.close();

  const reopenedStore = openStore({ databasePath: fixture.databasePath, now: () => START_MS + 1 });
  t.after(() => reopenedStore.close());
  const startTurnCalls = [];
  const reopenedController = new TurnController({
    store: reopenedStore,
    appServerBackend: fakeBackend({
      startTurn: async (options) => {
        const fenced = reopenedStore.readObjectiveExecution("objective-1");
        assert.equal(fenced.executionStatus, "submission_unknown");
        assert.equal(fenced.activeSubmission.state, "submission_unknown");
        startTurnCalls.push(options);
        return { turnId: "turn-resumed-after-crash" };
      }
    }),
    leaseOwner: "controller-after-binding-crash"
  });

  const resumed = await reopenedController.resolveObjectiveThread({
    objectiveId: "objective-1", threadId: "thread-operator-confirmed",
    sourceType: "zulip-message", sourceId: "230"
  });
  assert.equal(resumed.status, "started");
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.turnId, "turn-resumed-after-crash");
  assert.deepEqual(startTurnCalls, [{
    threadId: "thread-operator-confirmed", text: "Preserve this exact text.",
    clientUserMessageId: preCrash.clientUserMessageId
  }]);
});

test("duplicate operator binding never resends after the durable uncertainty fence", async (t) => {
  let startObjectiveCalls = 0;
  let initialStartTurnCalls = 0;
  const fixture = controllerFixture(t, { appServerBackend: fakeBackend({
    startObjective: async () => {
      startObjectiveCalls += 1;
      if (startObjectiveCalls === 1) return { threadId: "thread-old" };
      throw executionBackendError(
        "EXECUTION_BACKEND_REQUEST_UNCERTAIN", "Execution backend request outcome is uncertain.",
        { mayHaveBeenWritten: true }
      );
    },
    startTurn: async () => {
      initialStartTurnCalls += 1;
      if (initialStartTurnCalls === 1) return { turnId: "turn-initial" };
      throw executionBackendError("EXECUTION_BACKEND_OBJECTIVE_MISSING", "Execution backend objective does not exist.");
    }
  }) });
  await fixture.controller.acceptIntent(intent({
    projectId: "alpha", topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  }));
  await fixture.controller.handleTurnCompleted({
    objectiveId: "objective-1",
    turn: {
      id: "turn-initial", status: "completed", itemsView: "full",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }]
    },
    sourceType: "app-server", sourceId: "binding-fence-initial-completion"
  });
  await fixture.controller.continueObjective({
    sourceType: "zulip-message", sourceId: "binding-fence-continuation", objectiveId: "objective-1",
    projectId: "alpha", text: "Do not resend me.", targetSnapshot: { streamId: 42, topic: "Legacy" },
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  });
  const bound = fixture.store.resolveObjectiveThread({
    objectiveId: "objective-1", threadId: "thread-operator-confirmed",
    sourceType: "zulip-message", sourceId: "231"
  });
  fixture.store.markSubmissionUnknown({ submissionId: bound.submission.submissionId });
  let startTurnCalls = 0;
  const controller = new TurnController({
    store: fixture.store,
    appServerBackend: fakeBackend({ startTurn: async () => (startTurnCalls += 1, { turnId: "forbidden" }) }),
    leaseOwner: "controller-after-uncertainty-fence"
  });

  const replay = await controller.resolveObjectiveThread({
    objectiveId: "objective-1", threadId: "thread-operator-confirmed",
    sourceType: "zulip-message", sourceId: "231"
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, "submission_unknown");
  assert.equal(startTurnCalls, 0);
});
