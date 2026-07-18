import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { signContext } from "../hco/contracts/envelope.js";
import { executionBackendError, validateExecutionBackend } from "../hco/execution/backend.js";
import { createHcoService } from "../hco/service.js";
import { openStore } from "../hco/state/store.js";
import { TurnController } from "../hco/turn-controller.js";

test("release syntax verification includes the Option C acceptance harness", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(packageJson.scripts.check, /node --check test\/option-c-e2e\.test\.js(?:\s|$)/);
});

const START_MS = 1_700_000_000_000;
const CONTEXT_KEY = Buffer.alloc(32, 71);

function config(databasePath) {
  const project = ({ projectId, cwd, backend, streamId }) => Object.freeze({
    projectId,
    cwd,
    backend,
    staticStreamIds: Object.freeze([streamId]),
    acl: Object.freeze({
      viewers: Object.freeze([2]),
      contributors: Object.freeze([3]),
      maintainers: Object.freeze([4])
    }),
    threadOptions: Object.freeze({ approvalPolicy: "never" })
  });
  return Object.freeze({
    version: 1,
    databasePath,
    bridge: Object.freeze({
      tokenPath: "/tmp/hco-e2e-token",
      contextKeyPath: "/tmp/hco-e2e-context-key",
      socketPath: "/tmp/hco-e2e.sock",
      routeSnapshotPath: "/tmp/hco-e2e-routes.json"
    }),
    snapshot: Object.freeze({ ttlMs: 60_000, maxBytes: 262_144 }),
    admins: Object.freeze([1]),
    projects: Object.freeze([
      project({ projectId: "alpha", cwd: "/canonical/alpha", backend: "app-server", streamId: 42 }),
      project({ projectId: "beta", cwd: "/canonical/beta", backend: "tmux", streamId: 43 })
    ])
  });
}

function acceptanceFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-option-c-e2e-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: START_MS };
  const counters = new Map();
  const calls = { app: [], tmux: [] };
  const behaviors = { "app-server": {}, tmux: {} };
  const nextId = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-e2e-${next}`;
  };
  const backend = (kind, callList) => validateExecutionBackend({
    async startObjective(options) {
      callList.push(["startObjective", options]);
      if (behaviors[kind].startObjective) return behaviors[kind].startObjective(options, { calls, nextId });
      return kind === "app-server" ? { threadId: nextId("thread") } : { objectiveRef: nextId("tmux-objective") };
    },
    async startTurn(options) {
      callList.push(["startTurn", options]);
      if (behaviors[kind].startTurn) return behaviors[kind].startTurn(options, { calls, nextId });
      return { turnId: nextId(kind === "app-server" ? "turn" : "tmux-turn") };
    },
    async interruptTurn(options) {
      callList.push(["interruptTurn", options]);
      if (behaviors[kind].interruptTurn) return behaviors[kind].interruptTurn(options, { calls, nextId });
      return { ok: true };
    },
    async readObjective(options) {
      callList.push(["readObjective", options]);
      if (behaviors[kind].readObjective) return behaviors[kind].readObjective(options, { calls, nextId });
      return { thread: { id: options.threadId, turns: [] } };
    },
    async reconcileObjective(options) {
      callList.push(["reconcileObjective", options]);
      if (behaviors[kind].reconcileObjective) return behaviors[kind].reconcileObjective(options, { calls, nextId });
      return { thread: { id: options.threadId, turns: [] } };
    },
    async respondToInteraction(options) {
      callList.push(["respondToInteraction", options]);
      return behaviors[kind].respondToInteraction?.(options, { calls, nextId });
    },
    getCapabilities() {
      return {
        backend: kind,
        durableThreadContinuity: kind === "app-server",
        reverseInteractions: kind === "app-server"
      };
    }
  });
  const appServerBackend = backend("app-server", calls.app);
  const tmuxBackend = backend("tmux", calls.tmux);
  let runtime = null;
  let sourceMessageId = 100;

  async function open() {
    const store = openStore({ databasePath, now: () => clock.value, idFactory: nextId });
    const controller = new TurnController({
      store,
      appServerBackend,
      tmuxBackend,
      leaseOwner: nextId("controller")
    });
    const service = createHcoService({
      config: config(databasePath),
      store,
      turnController: controller,
      contextKey: CONTEXT_KEY,
      now: () => clock.value,
      idFactory: nextId,
      snapshotPublisher: ({ generation }) => Object.freeze({ generation })
    });
    await service.start();
    runtime = { controller, service, store };
    return runtime;
  }

  async function close() {
    if (!runtime) return;
    await runtime.service.close();
    runtime.store.close();
    runtime = null;
  }

  async function restart() {
    await close();
    return open();
  }

  function event({ command, semantic, streamId = 42, topic = "Build", senderId = 3, messageId } = {}) {
    const sourceId = messageId ?? sourceMessageId++;
    const binding = { streamId, topic, sourceMessageId: sourceId, senderId };
    const seconds = Math.floor(clock.value / 1_000);
    const kind = command ? "COMMAND" : "SEMANTIC";
    return {
      schemaVersion: 1,
      kind,
      contextToken: signContext({
        version: 1,
        binding,
        issuedAt: seconds - 1,
        expiresAt: seconds + 60,
        nonce: nextId("nonce")
      }, CONTEXT_KEY),
      binding,
      [kind === "COMMAND" ? "command" : "semantic"]: command ?? semantic
    };
  }

  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { behaviors, calls, clock, event, open, restart };
}

function completedTurn(turnId, text) {
  return {
    id: turnId,
    status: "completed",
    itemsView: "full",
    items: [{
      id: `final-${turnId}`,
      type: "agentMessage",
      phase: "final_answer",
      text
    }]
  };
}

test("completed objective resumes its App Server thread after restart while NEW gets a fresh thread", async (t) => {
  const fixture = acceptanceFixture(t);
  let runtime = await fixture.open();
  const first = await runtime.service.handleBridgeEvent(fixture.event({
    command: { type: "RUN", instruction: "Implement the parser." }
  }));
  await runtime.service.handleAppServerNotification({
    message: {
      method: "turn/completed",
      params: { threadId: first.threadId, turn: completedTurn(first.turnId, "first immutable output") }
    }
  });
  const firstOutput = runtime.store.readTurnOutput(first.objectiveId, first.turnId);

  runtime = await fixture.restart();
  const continued = await runtime.service.handleBridgeEvent(fixture.event({
    command: {
      type: "OBJECTIVE_CONTINUE",
      objectiveId: first.objectiveId,
      instruction: "Continue with the formatter."
    }
  }));
  assert.equal(continued.status, "accepted");
  assert.equal(continued.threadId, first.threadId);
  assert.notEqual(continued.turnId, first.turnId);
  assert.deepEqual(runtime.store.readTurnOutput(first.objectiveId, first.turnId), firstOutput);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startObjective").length, 1);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 2);

  const fresh = await runtime.service.handleBridgeEvent(fixture.event({
    command: { type: "OBJECTIVE_NEW", instruction: "Start an unrelated objective." }
  }));
  assert.notEqual(fresh.objectiveId, first.objectiveId);
  assert.notEqual(fresh.threadId, first.threadId);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startObjective").length, 2);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 3);
});

test("numeric routing lazily creates project objectives and keeps Hermes-owned streams out of execution", async (t) => {
  const fixture = acceptanceFixture(t);
  const runtime = await fixture.open();
  assert.deepEqual(runtime.store.readTopicState({ streamId: 42, topic: "Lazy" }), {
    streamId: 42, topic: "Lazy", mode: "AUTO", projectId: null, objectiveId: null, threadId: null
  });

  const sourceMessageId = 201;
  const first = await runtime.service.handleBridgeEvent(fixture.event({
    messageId: sourceMessageId,
    topic: "Lazy",
    command: { type: "RUN", instruction: "Implement numeric routing." }
  }));
  assert.equal(first.status, "accepted");
  assert.equal(first.projectId, "alpha");
  assert.equal(fixture.calls.app.filter(([method]) => method === "startObjective").length, 1);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 1);

  const replay = await runtime.service.handleBridgeEvent(fixture.event({
    messageId: sourceMessageId,
    topic: "Lazy",
    command: { type: "RUN", instruction: "Implement numeric routing." }
  }));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.objectiveId, first.objectiveId);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 1);

  const semantic = await runtime.service.handleBridgeEvent(fixture.event({
    streamId: 42,
    topic: "Semantic",
    semantic: {
      type: "DISPATCH",
      instruction: "Ship it.",
      constraints: ["Keep compatibility."],
      acceptanceCriteria: ["Focused tests pass."],
      reminders: ["Do not retry uncertain writes."],
      objective: { mode: "NEW" },
      topicModeAction: null
    }
  }));
  assert.equal(semantic.status, "accepted");
  assert.equal(semantic.projectId, "alpha");

  const beta = await runtime.service.handleBridgeEvent(fixture.event({
    streamId: 43,
    topic: "Tmux",
    command: { type: "RUN", instruction: "Use the configured backend." }
  }));
  assert.equal(beta.status, "accepted");
  assert.equal(beta.projectId, "beta");
  assert.equal(fixture.calls.tmux.filter(([method]) => method === "startTurn").length, 1);

  const callCount = fixture.calls.app.length + fixture.calls.tmux.length;
  await assert.rejects(() => runtime.service.handleBridgeEvent(fixture.event({
    streamId: 99,
    topic: "Hermes",
    command: { type: "RUN", instruction: "Must remain Hermes-owned." }
  })), { code: "ROUTE_HERMES_OWNED" });
  assert.equal(fixture.calls.app.length + fixture.calls.tmux.length, callCount);
});

test("completed output and its immutable Zulip target survive a lost delivery acknowledgement", async (t) => {
  const fixture = acceptanceFixture(t);
  let runtime = await fixture.open();
  const started = await runtime.service.handleBridgeEvent(fixture.event({
    messageId: 301,
    topic: "Delivery",
    command: { type: "RUN", instruction: "Produce the final output." }
  }));
  const rawText = "raw\r\ntechnical output";
  await runtime.service.handleAppServerNotification({
    message: {
      method: "turn/completed",
      params: { threadId: started.threadId, turn: completedTurn(started.turnId, rawText) }
    }
  });

  assert.equal(runtime.store.readTurnOutput(started.objectiveId, started.turnId).rawText, rawText);
  const [firstClaim] = runtime.store.claimOutbox({ workerId: "zulip-worker-1", limit: 1, leaseMs: 1_000 });
  assert.deepEqual(firstClaim.targetSnapshot, {
    platform: "zulip", streamId: 42, topic: "Delivery", sourceMessageId: 301
  });

  fixture.clock.value += 1_001;
  runtime = await fixture.restart();
  const [recoveredClaim] = runtime.store.claimOutbox({ workerId: "zulip-worker-2", limit: 1, leaseMs: 1_000 });
  for (const field of ["deliveryId", "semanticKey", "objectiveId", "objectiveSequence", "payload", "targetSnapshot"]) {
    assert.deepEqual(recoveredClaim[field], firstClaim[field]);
  }
  assert.equal(recoveredClaim.attemptCount, 2);
  assert.notEqual(recoveredClaim.leaseToken, firstClaim.leaseToken);

  runtime.store.ackOutbox({
    deliveryId: recoveredClaim.deliveryId,
    leaseToken: recoveredClaim.leaseToken,
    zulipMessageId: 9_001
  });
  assert.deepEqual(runtime.store.claimOutbox({ workerId: "zulip-worker-3", limit: 1, leaseMs: 1_000 }), []);
});

test("pending App Server approval survives restart and only its authorized bound Zulip topic can answer", async (t) => {
  const fixture = acceptanceFixture(t);
  let runtime = await fixture.open();
  const started = await runtime.service.handleBridgeEvent(fixture.event({
    topic: "Approval",
    command: { type: "RUN", instruction: "Request approval." }
  }));
  const pending = await runtime.service.handleAppServerRequest({
    connectionId: "app-server-connection-1",
    message: {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: started.threadId,
        turnId: started.turnId,
        itemId: "command-item-1",
        approvalId: "approval-1",
        command: "npm test"
      }
    }
  });

  await assert.rejects(() => runtime.service.handleBridgeEvent(fixture.event({
    topic: "Approval",
    senderId: 2,
    command: { type: "APPROVE", replyToken: pending.interactionId, choice: "accept" }
  })), { code: "ACL_FORBIDDEN" });
  await assert.rejects(() => runtime.service.handleBridgeEvent(fixture.event({
    topic: "Other",
    senderId: 3,
    command: { type: "APPROVE", replyToken: pending.interactionId, choice: "accept" }
  })), { code: "INTERACTION_TARGET_MISMATCH" });
  assert.equal(fixture.calls.app.filter(([method]) => method === "respondToInteraction").length, 0);

  runtime = await fixture.restart();
  const answered = await runtime.service.handleBridgeEvent(fixture.event({
    topic: "Approval",
    senderId: 3,
    command: { type: "APPROVE", replyToken: pending.interactionId, choice: "accept" }
  }));
  assert.equal(answered.status, "answered");
  assert.deepEqual(fixture.calls.app.filter(([method]) => method === "respondToInteraction"), [[
    "respondToInteraction",
    { interactionId: pending.interactionId, wireRequestId: 7, result: { choice: "accept" } }
  ]]);
});

test("an uncertain App Server turn submission reconciles by durable clientId without a replacement turn", async (t) => {
  const fixture = acceptanceFixture(t);
  let remoteClientId;
  fixture.behaviors["app-server"].startTurn = async (options) => {
    remoteClientId = options.clientUserMessageId;
    throw executionBackendError(
      "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
      "Execution backend request outcome is uncertain.",
      { mayHaveBeenWritten: true }
    );
  };
  let runtime = await fixture.open();
  const sourceMessageId = 401;
  const uncertain = await runtime.service.handleBridgeEvent(fixture.event({
    messageId: sourceMessageId,
    topic: "Uncertain",
    command: { type: "RUN", instruction: "Submit exactly once." }
  }));
  assert.equal(uncertain.status, "submission_unknown");
  assert.equal(uncertain.clientUserMessageId, remoteClientId);

  const replay = await runtime.service.handleBridgeEvent(fixture.event({
    messageId: sourceMessageId,
    topic: "Uncertain",
    command: { type: "RUN", instruction: "Submit exactly once." }
  }));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.clientUserMessageId, remoteClientId);
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 1);

  fixture.behaviors["app-server"].reconcileObjective = async ({ threadId }) => ({
    thread: {
      id: threadId,
      turns: [{
        id: "remote-turn-401",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "remote-user-401", type: "userMessage", clientId: remoteClientId, status: "completed" }]
      }]
    }
  });
  runtime = await fixture.restart();
  const reconciled = await runtime.controller.reconcileObjective({ objectiveId: uncertain.objectiveId });
  assert.equal(reconciled.status, "running");
  assert.equal(reconciled.turnId, "remote-turn-401");
  assert.equal(runtime.store.readObjectiveExecution(uncertain.objectiveId).activeSubmission.turnId, "remote-turn-401");
  assert.equal(fixture.calls.app.filter(([method]) => method === "startTurn").length, 1);
});

test("App Server failure never falls back to tmux and invalid capability data reaches no execution backend", async (t) => {
  const fixture = acceptanceFixture(t);
  fixture.behaviors["app-server"].startObjective = async () => {
    throw executionBackendError(
      "EXECUTION_BACKEND_UNAVAILABLE",
      "Execution backend is unavailable.",
      { mayHaveBeenWritten: false }
    );
  };
  const runtime = await fixture.open();
  const unavailable = await runtime.service.handleBridgeEvent(fixture.event({
    topic: "No fallback",
    command: { type: "RUN", instruction: "Stay on App Server." }
  }));
  assert.equal(unavailable.status, "backend_unavailable");
  assert.equal(fixture.calls.tmux.length, 0);
  const callCount = fixture.calls.app.length + fixture.calls.tmux.length;

  const forged = fixture.event({ command: { type: "STATUS" } });
  const [encodedPayload, encodedSignature] = forged.contextToken.split(".");
  const signatureIndex = Math.floor(encodedSignature.length / 2);
  const changed = encodedSignature[signatureIndex] === "A" ? "B" : "A";
  forged.contextToken = `${encodedPayload}.${encodedSignature.slice(0, signatureIndex)}${changed}${encodedSignature.slice(signatureIndex + 1)}`;
  await assert.rejects(() => runtime.service.handleBridgeEvent(forged), { code: "CONTEXT_SIGNATURE_INVALID" });

  const expired = fixture.event({ command: { type: "STATUS" } });
  fixture.clock.value += 91_000;
  await assert.rejects(() => runtime.service.handleBridgeEvent(expired), { code: "CONTEXT_EXPIRED" });

  const replayed = fixture.event({ command: { type: "TOPIC", action: "SHOW" } });
  await runtime.service.handleBridgeEvent(replayed);
  await assert.rejects(() => runtime.service.handleBridgeEvent(replayed), { code: "CONTEXT_NONCE_REPLAYED" });

  const mismatched = fixture.event({ topic: "Signed topic", command: { type: "STATUS" } });
  mismatched.binding = { ...mismatched.binding, topic: "Changed topic" };
  await assert.rejects(() => runtime.service.handleBridgeEvent(mismatched), { code: "CONTEXT_BINDING_MISMATCH" });

  const malformed = fixture.event({ command: { type: "STATUS" } });
  malformed.binding = { ...malformed.binding, senderId: 0 };
  await assert.rejects(() => runtime.service.handleBridgeEvent(malformed), { code: "BRIDGE_EVENT_INVALID" });
  assert.equal(fixture.calls.app.length + fixture.calls.tmux.length, callCount);
});
