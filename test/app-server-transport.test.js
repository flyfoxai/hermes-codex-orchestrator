import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../hco/app-server/client.js";
import { AppServerRpcClient, DEFER_SERVER_REQUEST } from "../hco/app-server/rpc-client.js";
import { DEFAULT_MAX_FRAME_BYTES, NdjsonTransport } from "../hco/app-server/transport.js";

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function within(promise, ms) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Test deadline exceeded.")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function createHarness(options = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  writable.resume();
  const transport = new NdjsonTransport({ readable, writable, ...options });
  const messages = [];
  transport.on("message", (message) => messages.push(message));
  return { messages, readable, transport, writable };
}

class ControlledWritable extends EventEmitter {
  constructor(backpressureAt = 1) {
    super();
    this.writable = true;
    this.writableEnded = false;
    this.frames = [];
    this.endCalls = 0;
    this.backpressureAt = backpressureAt;
  }

  write(frame) {
    this.frames.push(String(frame));
    return this.frames.length !== this.backpressureAt;
  }

  end() {
    this.endCalls += 1;
    this.writableEnded = true;
    this.emit("finish");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRpcHarness(options = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const sent = [];
  const sentFrames = [];
  let output = "";
  writable.on("data", (chunk) => {
    output += chunk.toString("utf8");
    let lineFeed;
    while ((lineFeed = output.indexOf("\n")) !== -1) {
      const frame = output.slice(0, lineFeed);
      sentFrames.push(frame);
      sent.push(JSON.parse(frame));
      output = output.slice(lineFeed + 1);
    }
  });
  const transport = new NdjsonTransport({ readable, writable });
  const diagnostics = [];
  const notifications = [];
  const rpc = new AppServerRpcClient({
    transport,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onNotification: (notification) => notifications.push(notification),
    ...options
  });
  return { diagnostics, notifications, readable, rpc, sent, sentFrames, transport, writable };
}

class InjectedChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }
}

function createClientHarness(options = {}) {
  const child = options.childProcess ?? new InjectedChild();
  const sent = [];
  const sentFrames = [];
  let output = "";
  child.stdin.on("data", (chunk) => {
    output += chunk.toString("utf8");
    let lineFeed;
    while ((lineFeed = output.indexOf("\n")) !== -1) {
      const frame = output.slice(0, lineFeed);
      sentFrames.push(frame);
      sent.push(JSON.parse(frame));
      output = output.slice(lineFeed + 1);
    }
  });
  const diagnostics = [];
  const notifications = [];
  const client = new CodexAppServerClient({
    childProcess: child,
    clientInfo: { name: "hco-test", version: "1.2.3" },
    onDiagnostic: (event) => diagnostics.push(event),
    onNotification: (event) => notifications.push(event),
    ...options
  });
  return { child, client, diagnostics, notifications, sent, sentFrames };
}

async function initializeHarness(harness, metadata = {
  userAgent: "fake/0.142.3",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "test"
}) {
  const promise = harness.client.initialize();
  await immediate();
  const request = harness.sent.at(-1);
  harness.child.stdout.write(`${JSON.stringify({ id: request.id, result: metadata })}\n`);
  return promise;
}

async function callAndRespond(harness, call, expected, result = { ok: true }) {
  const pending = call();
  await immediate();
  const request = harness.sent.at(-1);
  assert.deepEqual(request, expected);
  harness.child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  assert.deepEqual(await pending, result);
}

function sampleModel(overrides = {}) {
  return {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    serviceTiers: ["default"],
    defaultServiceTier: "default",
    isDefault: false,
    ...overrides
  };
}

test("reassembles fragmented frames before dispatch", async () => {
  const { messages, readable } = createHarness();
  readable.write('{"value"');
  readable.write(":1}\n");
  await immediate();
  assert.deepEqual(messages, [{ value: 1 }]);
});

test("dispatches multiple frames from one chunk in order", async () => {
  const { messages, readable } = createHarness();
  readable.write('{"n":1}\n{"n":2}\n{"n":3}\n');
  await immediate();
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("preserves a UTF-8 scalar split across byte chunks", async () => {
  const { messages, readable } = createHarness();
  const frame = Buffer.from('{"text":"A🙂B"}\n');
  const scalarStart = frame.indexOf(Buffer.from("🙂"));
  readable.write(frame.subarray(0, scalarStart + 2));
  readable.write(frame.subarray(scalarStart + 2));
  await immediate();
  assert.deepEqual(messages, [{ text: "A🙂B" }]);
});

test("dispatches a final non-empty frame before clean EOF", async () => {
  const { messages, readable, transport } = createHarness();
  const terminalPromise = once(transport, "terminal");
  readable.end('{"at":"eof"}');
  const [terminal] = await terminalPromise;
  assert.deepEqual(messages, [{ at: "eof" }]);
  assert.equal(terminal.code, "APP_SERVER_TRANSPORT_EOF");
});

test("rejects blank, malformed, scalar, and array frames with owned errors", async (t) => {
  const cases = ["\n", "{\n", "1\n", "[]\n"];
  for (const frame of cases) {
    await t.test(JSON.stringify(frame), async () => {
      const { messages, readable, transport } = createHarness();
      const terminalPromise = once(transport, "terminal");
      readable.write(frame);
      const [terminal] = await terminalPromise;
      assert.equal(terminal.code, "APP_SERVER_TRANSPORT_FRAME_INVALID");
      assert.equal(terminal.message, "App Server transport received an invalid frame.");
      if (frame.trim().length > 0) assert.equal(terminal.message.includes(frame.trim()), false);
      assert.deepEqual(messages, []);
    });
  }
});

test("rejects an oversized unterminated frame before further buffering", async () => {
  const { readable, transport } = createHarness({ maxFrameBytes: 8 });
  const terminalPromise = once(transport, "terminal");
  readable.write(Buffer.alloc(9, 0x61));
  const [terminal] = await terminalPromise;
  assert.equal(terminal.code, "APP_SERVER_TRANSPORT_FRAME_TOO_LARGE");
  assert.equal(terminal.message, "App Server transport frame exceeds the configured limit.");
});

test("accepts a multi-MiB App Server tool result within the default frame limit", async () => {
  const { messages, readable, transport } = createHarness();
  const output = "x".repeat(2 * 1024 * 1024);
  const frame = `${JSON.stringify({ method: "item/completed", params: { output } })}\n`;
  assert.equal(Buffer.byteLength(frame, "utf8") > 1024 * 1024, true);
  assert.equal(Buffer.byteLength(frame, "utf8") <= DEFAULT_MAX_FRAME_BYTES, true);

  readable.end(frame);
  const [terminal] = await once(transport, "terminal");
  assert.equal(terminal.code, "APP_SERVER_TRANSPORT_EOF");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.output.length, output.length);
});

test("serializes a plain JSON object as compact JSON followed by LF", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const transport = new NdjsonTransport({ readable, writable });
  const output = [];
  writable.on("data", (chunk) => output.push(chunk));
  await transport.send({ method: "ping", params: { values: [1, true, null] } });
  assert.equal(Buffer.concat(output).toString("utf8"), '{"method":"ping","params":{"values":[1,true,null]}}\n');
});

test("rejects an oversized outbound frame before writing", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const output = [];
  writable.on("data", (chunk) => output.push(chunk));
  const transport = new NdjsonTransport({ readable, writable });
  const value = { text: "x".repeat(DEFAULT_MAX_FRAME_BYTES) };
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8") > DEFAULT_MAX_FRAME_BYTES, true);

  await assert.rejects(() => transport.send(value), (error) => {
    assert.equal(error.code, "APP_SERVER_TRANSPORT_FRAME_TOO_LARGE");
    assert.equal(error.message, "App Server transport frame exceeds the configured limit.");
    return true;
  });
  assert.equal(output.length, 0);
});

test("rejects non-plain and non-JSON outbound values before writing", async (t) => {
  const cases = [
    [],
    new Date(0),
    { missing: undefined },
    { invalid: Number.NaN },
    { invalid: 1n },
    Object.assign(Object.create({ inherited: true }), { own: true })
  ];
  for (const value of cases) {
    await t.test(Object.prototype.toString.call(value), async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const output = [];
      writable.on("data", (chunk) => output.push(chunk));
      const transport = new NdjsonTransport({ readable, writable });
      await assert.rejects(() => transport.send(value), (error) => {
        assert.equal(error.code, "APP_SERVER_TRANSPORT_VALUE_INVALID");
        return true;
      });
      assert.equal(output.length, 0);
    });
  }
});

test("serializes concurrent sends and awaits backpressure without repeating writes", async () => {
  const readable = new PassThrough();
  const writable = new ControlledWritable();
  const transport = new NdjsonTransport({ readable, writable });
  const first = transport.send({ sequence: 1 });
  const second = transport.send({ sequence: 2 });

  await immediate();
  assert.deepEqual(writable.frames, ['{"sequence":1}\n']);
  writable.emit("drain");
  await Promise.all([first, second]);
  assert.deepEqual(writable.frames, ['{"sequence":1}\n', '{"sequence":2}\n']);
});

test("terminal stream failure rejects pending sends once and later sends as closed", async () => {
  const readable = new PassThrough();
  const writable = new ControlledWritable();
  const transport = new NdjsonTransport({ readable, writable });
  const terminalEvents = [];
  transport.on("terminal", (error) => terminalEvents.push(error));
  const first = transport.send({ sequence: 1 });
  const second = transport.send({ sequence: 2 });
  await immediate();

  readable.destroy(new Error("native secret"));
  await assert.rejects(first, (error) => error.code === "APP_SERVER_TRANSPORT_STREAM_FAILED");
  await assert.rejects(second, (error) => error.code === "APP_SERVER_TRANSPORT_CLOSED");
  await assert.rejects(() => transport.send({ sequence: 3 }), (error) => {
    assert.equal(error.code, "APP_SERVER_TRANSPORT_CLOSED");
    assert.equal(error.message.includes("native secret"), false);
    return true;
  });
  assert.equal(terminalEvents.length, 1);
});

test("closed transport rejects invalid and oversized values as closed before inspecting them", async () => {
  const { transport } = createHarness({ maxFrameBytes: 8 });
  transport.close();

  for (const value of [1n, { text: "x".repeat(20) }]) {
    await assert.rejects(() => transport.send(value), (error) => {
      assert.equal(error.code, "APP_SERVER_TRANSPORT_CLOSED");
      return true;
    });
  }
});

test("premature close is terminal and explicit close is idempotent", async () => {
  const premature = createHarness();
  const terminalPromise = once(premature.transport, "terminal");
  premature.readable.emit("close");
  const [terminal] = await terminalPromise;
  assert.equal(terminal.code, "APP_SERVER_TRANSPORT_PREMATURE_CLOSE");

  const readable = new PassThrough();
  const writable = new ControlledWritable();
  const transport = new NdjsonTransport({ readable, writable });
  const events = [];
  transport.on("terminal", (error) => events.push(error));
  transport.close();
  transport.close();
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "APP_SERVER_TRANSPORT_CLOSED");
  assert.equal(writable.endCalls, 1);
});

test("correlates out-of-order responses by typed ID while forwarding notifications", async () => {
  const { diagnostics, notifications, readable, rpc, sent } = createRpcHarness();
  const first = rpc.request("first", { value: 1 }, { timeoutMs: 1000 });
  const second = rpc.request("second", { value: 2 }, { timeoutMs: 1000 });
  await immediate();
  assert.deepEqual(sent, [
    { id: 1, method: "first", params: { value: 1 } },
    { id: 2, method: "second", params: { value: 2 } }
  ]);

  readable.write('{"id":"1","result":"wrong type"}\n');
  readable.write('{"id":2,"result":"second result"}\n{"method":"future/event","params":{"ok":true},"emittedAtMs":1785978000000}\n');
  readable.write('{"id":1,"result":"first result"}\n');
  assert.equal(await second, "second result");
  assert.equal(await first, "first result");
  await immediate();
  assert.deepEqual(notifications, [{
    method: "future/event",
    params: { ok: true },
    emittedAtMs: 1785978000000
  }]);
  assert.equal(diagnostics.some((item) => item.code === "APP_SERVER_RPC_UNKNOWN_RESPONSE"), true);
});

test("routes RPC error responses and diagnoses malformed or ambiguous messages", async () => {
  const { diagnostics, readable, rpc } = createRpcHarness();
  const remoteFailure = rpc.request("remote/failure", {}, { timeoutMs: 1000 });
  await immediate();
  readable.write('{"id":1,"error":{"code":-32000,"message":"remote failure secret","data":{"secret":"test data secret"}}}\n');
  await assert.rejects(remoteFailure, (error) => {
    assert.equal(error.code, "APP_SERVER_RPC_REMOTE_ERROR");
    assert.equal(error.message, "App Server request failed.");
    assert.equal(error.rpcCode, -32000);
    assert.equal(error.rpcMessage, "remote failure secret");
    assert.deepEqual(error.rpcData, { secret: "test data secret" });
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "rpcMessage"), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "rpcData"), false);
    const serialized = `${error.message} ${JSON.stringify(error)}`;
    assert.equal(serialized.includes("remote failure secret"), false);
    assert.equal(serialized.includes("test data secret"), false);
    return true;
  });

  const malformed = rpc.request("malformed", {}, { timeoutMs: 1000 });
  await immediate();
  readable.write('{"id":2,"error":{"code":"bad","message":"unsafe"}}\n');
  await assert.rejects(malformed, (error) => error.code === "APP_SERVER_RPC_PROTOCOL_INVALID");
  readable.write('{"id":999,"result":true}\n');
  readable.write('{"id":3,"method":"ambiguous","result":true}\n');
  readable.write('{"id":false,"result":true}\n');
  readable.write('{"method":"bad/notification","emittedAtMs":"unsafe"}\n');
  await immediate();
  assert.equal(diagnostics.filter((item) => item.code === "APP_SERVER_RPC_PROTOCOL_INVALID").length >= 4, true);
});

test("preserves lossless int64 semantics for remote errors and callback params", async () => {
  const { notifications, readable, rpc } = createRpcHarness();
  const remoteFailure = rpc.request("remote/int64-error", {}, { timeoutMs: 1000 });
  await immediate();
  readable.write('{"id":1,"error":{"code":9223372036854775807,"message":"remote secret","data":{"secret":true}}}\n');
  await assert.rejects(remoteFailure, (error) => {
    assert.equal(error.code, "APP_SERVER_RPC_REMOTE_ERROR");
    assert.equal(error.rpcCode, 9223372036854775807n);
    assert.equal(typeof error.rpcCode, "bigint");
    assert.equal(error.rpcMessage, "remote secret");
    assert.deepEqual(error.rpcData, { secret: true });
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "rpcMessage"), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "rpcData"), false);
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes("remote secret"), false);
    assert.equal(serialized.includes("secret"), false);
    return true;
  });

  readable.write('{"method":"approval/updated","params":{"startedAtMs":-9223372036854775808,"safe":42,"ratio":1.5}}\n');
  await immediate();
  assert.deepEqual(notifications, [{
    method: "approval/updated",
    params: { startedAtMs: -9223372036854775808n, safe: 42, ratio: 1.5 }
  }]);
  assert.equal(typeof notifications[0].params.startedAtMs, "bigint");
  assert.equal(typeof notifications[0].params.safe, "number");
  assert.equal(typeof notifications[0].params.ratio, "number");
});

test("AppServerRpcClient emits exact outbound signed-int64 error codes and rejects unsafe Numbers before writing", async () => {
  const gate = deferred();
  const { readable, rpc, sentFrames } = createRpcHarness({
    requestHandlers: { "manual/error": () => gate.promise }
  });
  readable.write('{"id":"rpc-min","method":"manual/error"}\n' +
    '{"id":"rpc-max","method":"manual/error"}\n' +
    '{"id":"rpc-unsafe","method":"manual/error"}\n');
  await immediate();

  await rpc.respondError("rpc-min", { code: -9223372036854775808n, message: "min" });
  await rpc.respondError("rpc-max", { code: 9223372036854775807n, message: "max" });
  assert.deepEqual(sentFrames, [
    '{"id":"rpc-min","error":{"code":-9223372036854775808,"message":"min"}}',
    '{"id":"rpc-max","error":{"code":9223372036854775807,"message":"max"}}'
  ]);

  const frameCount = sentFrames.length;
  await assert.rejects(
    () => rpc.respondError("rpc-unsafe", { code: Number.MAX_SAFE_INTEGER + 1, message: "unsafe" }),
    (error) => error.code === "APP_SERVER_RPC_ARGUMENT_INVALID"
  );
  await immediate();
  assert.equal(sentFrames.length, frameCount);
});

test("CodexAppServerClient passes through exact outbound signed-int64 error codes and rejects unsafe Numbers before writing", async () => {
  const gate = deferred();
  const harness = createClientHarness({
    requestHandlers: { "manual/error": () => gate.promise }
  });
  harness.child.stdout.write('{"id":"client-min","method":"manual/error"}\n' +
    '{"id":"client-max","method":"manual/error"}\n' +
    '{"id":"client-unsafe","method":"manual/error"}\n');
  await immediate();

  await harness.client.respondError("client-min", { code: -9223372036854775808n, message: "min" });
  await harness.client.respondError("client-max", { code: 9223372036854775807n, message: "max" });
  assert.deepEqual(harness.sentFrames, [
    '{"id":"client-min","error":{"code":-9223372036854775808,"message":"min"}}',
    '{"id":"client-max","error":{"code":9223372036854775807,"message":"max"}}'
  ]);

  const frameCount = harness.sentFrames.length;
  await assert.rejects(
    () => harness.client.respondError("client-unsafe", {
      code: Number.MAX_SAFE_INTEGER + 1,
      message: "unsafe"
    }),
    (error) => error.code === "APP_SERVER_RPC_ARGUMENT_INVALID"
  );
  await immediate();
  assert.equal(harness.sentFrames.length, frameCount);
});

test("times out only one request and diagnoses its late response without ID reuse", async () => {
  const { diagnostics, readable, rpc, sent } = createRpcHarness();
  const timedOut = rpc.request("slow", {}, { timeoutMs: 10 });
  await assert.rejects(timedOut, (error) => error.code === "APP_SERVER_RPC_TIMEOUT");
  readable.write('{"id":1,"result":"late"}\n');

  const next = rpc.request("next", {}, { timeoutMs: 1000 });
  await immediate();
  assert.equal(sent.at(-1).id, 2);
  readable.write('{"id":2,"result":"current"}\n');
  assert.equal(await next, "current");
  await immediate();
  assert.equal(diagnostics.some((item) => item.code === "APP_SERVER_RPC_LATE_RESPONSE"), true);
});

test("times out a committed request even when its backpressure never drains", async () => {
  const readable = new PassThrough();
  const writable = new ControlledWritable();
  const transport = new NdjsonTransport({ readable, writable });
  const rpc = new AppServerRpcClient({ transport });
  const request = rpc.request("committed/no-drain", {}, { timeoutMs: 10 });
  const timedOut = assert.rejects(
    within(request, 60),
    (error) => error.code === "APP_SERVER_RPC_TIMEOUT"
  );
  await immediate();
  assert.deepEqual(writable.frames, [
    '{"id":1,"method":"committed/no-drain","params":{}}\n'
  ]);

  await timedOut;
  assert.equal(writable.frames.length, 1);
  rpc.close();
  await immediate();
});

test("cancels a timed-out request queued behind backpressure before writing", async () => {
  const readable = new PassThrough();
  const writable = new ControlledWritable();
  const transport = new NdjsonTransport({ readable, writable });
  const rpc = new AppServerRpcClient({ transport });
  const blocker = transport.send({ method: "blocker" });
  await immediate();

  const request = rpc.request("must/not/send", {}, { timeoutMs: 10 });
  await assert.rejects(within(request, 60), (error) => error.code === "APP_SERVER_RPC_TIMEOUT");
  assert.deepEqual(writable.frames, ['{"method":"blocker"}\n']);

  writable.emit("drain");
  await blocker;
  await immediate();
  await immediate();
  assert.deepEqual(writable.frames, ['{"method":"blocker"}\n']);
  rpc.close();
});

test("preserves and responds with numeric int64 boundary reverse request IDs", async () => {
  const observedIds = [];
  const { readable, sentFrames } = createRpcHarness({
    requestHandlers: {
      "boundary/id": (request) => {
        observedIds.push(request.id);
        return { ok: true };
      }
    }
  });
  readable.write('{"id":9223372036854775807,"method":"boundary/id"}\n' +
    '{"id":-9223372036854775808,"method":"boundary/id"}\n');
  await immediate();
  await immediate();
  assert.deepEqual(observedIds, [9223372036854775807n, -9223372036854775808n]);
  assert.deepEqual(sentFrames, [
    '{"id":9223372036854775807,"result":{"ok":true}}',
    '{"id":-9223372036854775808,"result":{"ok":true}}'
  ]);
});

test("rejects every pending request exactly once on EOF or stream failure", async (t) => {
  await t.test("EOF", async () => {
    const { readable, rpc } = createRpcHarness();
    const first = rpc.request("one", {}, { timeoutMs: 1000 });
    const second = rpc.request("two", {}, { timeoutMs: 1000 });
    readable.end();
    await assert.rejects(first, (error) => error.code === "APP_SERVER_TRANSPORT_EOF");
    await assert.rejects(second, (error) => error.code === "APP_SERVER_TRANSPORT_EOF");
  });
  await t.test("stream error", async () => {
    const { readable, rpc } = createRpcHarness();
    const pending = rpc.request("one", {}, { timeoutMs: 1000 });
    readable.destroy(new Error("native secret"));
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "APP_SERVER_TRANSPORT_STREAM_FAILED");
      assert.equal(error.message.includes("native secret"), false);
      return true;
    });
  });
});

test("handles async reverse requests without blocking later response traffic", async () => {
  const gate = deferred();
  const observed = [];
  const { readable, rpc, sent } = createRpcHarness({
    requestHandlers: {
      "approval/wait": async (request) => {
        observed.push(request);
        return gate.promise;
      }
    }
  });
  const pending = rpc.request("client/call", {}, { timeoutMs: 1000 });
  await immediate();
  readable.write('{"id":"server-1","method":"approval/wait","params":{"itemId":"i-1"}}\n' +
    '{"id":1,"result":"continued"}\n');
  assert.equal(await pending, "continued");
  assert.deepEqual(observed, [{ id: "server-1", method: "approval/wait", params: { itemId: "i-1" } }]);
  assert.equal(sent.some((message) => message.id === "server-1"), false);

  gate.resolve({ decision: "decline" });
  await immediate();
  assert.deepEqual(sent.find((message) => message.id === "server-1"), {
    id: "server-1",
    result: { decision: "decline" }
  });
});

test("explicitly deferred reverse requests remain pending until manually settled", async () => {
  const observed = [];
  const { readable, rpc, sent } = createRpcHarness({
    requestHandlers: {
      "approval/persist": (request) => {
        observed.push(request);
        return DEFER_SERVER_REQUEST;
      }
    }
  });
  readable.write('{"id":"approval-1","method":"approval/persist","params":{"itemId":"i-1"}}\n');
  await immediate();
  await immediate();

  assert.deepEqual(observed, [{
    id: "approval-1",
    method: "approval/persist",
    params: { itemId: "i-1" }
  }]);
  assert.equal(sent.some((message) => message.id === "approval-1"), false);

  await rpc.respond("approval-1", { decision: "decline" });
  assert.deepEqual(sent.find((message) => message.id === "approval-1"), {
    id: "approval-1",
    result: { decision: "decline" }
  });
});

test("answers unknown reverse requests with -32601 without blocking later traffic", async () => {
  const { readable, rpc, sent } = createRpcHarness();
  const pending = rpc.request("still/works", {}, { timeoutMs: 1000 });
  await immediate();
  readable.write('{"id":77,"method":"unknown/reverse","params":{}}\n' +
    '{"id":1,"result":"ok"}\n');
  assert.equal(await pending, "ok");
  await immediate();
  assert.deepEqual(sent.find((message) => message.id === 77), {
    id: 77,
    error: { code: -32601, message: "Method not supported." }
  });
});

test("uses safe handler errors and settles a reverse request only once", async () => {
  const gate = deferred();
  const { diagnostics, readable, rpc, sent } = createRpcHarness({
    requestHandlers: {
      "manual/settle": () => gate.promise,
      "handler/fails": () => { throw new Error("handler secret"); }
    }
  });
  readable.write('{"id":"manual","method":"manual/settle"}\n');
  await immediate();
  await rpc.respond("manual", { manual: true });
  gate.resolve({ automatic: true });
  readable.write('{"id":"failure","method":"handler/fails"}\n');
  await immediate();
  await immediate();
  assert.equal(sent.filter((message) => message.id === "manual").length, 1);
  assert.deepEqual(sent.find((message) => message.id === "failure"), {
    id: "failure",
    error: { code: -32603, message: "Server request handler failed." }
  });
  await assert.rejects(() => rpc.respond("manual", {}), (error) => error.code === "APP_SERVER_RPC_ALREADY_SETTLED");
  assert.equal(JSON.stringify(sent).includes("handler secret"), false);
  assert.equal(diagnostics.some((item) => item.code === "APP_SERVER_RPC_HANDLER_FAILED"), true);
});

test("sends one safe error when a reverse handler result cannot be serialized", async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const { diagnostics, readable, rpc, sent } = createRpcHarness({
    requestHandlers: {
      "result/undefined": () => undefined,
      "result/cyclic": () => cyclic
    }
  });
  readable.write('{"id":"undefined","method":"result/undefined"}\n' +
    '{"id":"cyclic","method":"result/cyclic"}\n');
  await immediate();
  await immediate();
  await immediate();

  for (const id of ["undefined", "cyclic"]) {
    assert.deepEqual(sent.filter((message) => message.id === id), [{
      id,
      error: { code: -32603, message: "Server request handler failed." }
    }]);
    await assert.rejects(() => rpc.respond(id, {}),
      (error) => error.code === "APP_SERVER_RPC_ALREADY_SETTLED");
  }
  assert.equal(diagnostics.filter((item) => item.code === "APP_SERVER_RPC_HANDLER_FAILED").length, 2);
});

test("shares one initialize handshake and sends initialized before becoming ready", async () => {
  const harness = createClientHarness();
  const first = harness.client.initialize();
  const second = harness.client.initialize();
  assert.equal(first, second);
  await immediate();
  assert.deepEqual(harness.sent, [{
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "hco-test", version: "1.2.3" },
      capabilities: { experimentalApi: false }
    }
  }]);
  await assert.rejects(() => harness.client.readThread({ threadId: "too-early", includeTurns: true }),
    (error) => error.code === "APP_SERVER_CLIENT_NOT_INITIALIZED");

  const metadata = {
    userAgent: "fake/0.142.3",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "test"
  };
  harness.child.stdout.write(`${JSON.stringify({ id: 1, result: metadata })}\n`);
  assert.deepEqual(await first, metadata);
  assert.deepEqual(await second, metadata);
  assert.deepEqual(harness.sent.at(-1), { method: "initialized" });
  assert.deepEqual(await harness.client.initialize(), metadata);
  assert.equal(harness.sent.filter((message) => message.method === "initialize").length, 1);
});

test("times out an unresponsive initialize and closes without retry", async () => {
  const harness = createClientHarness({ initializeTimeoutMs: 10 });
  const first = harness.client.initialize();
  const second = harness.client.initialize();

  assert.equal(first, second);
  await assert.rejects(within(first, 100),
    (error) => error.code === "APP_SERVER_CLIENT_INITIALIZE_FAILED");
  await assert.rejects(second,
    (error) => error.code === "APP_SERVER_CLIENT_INITIALIZE_FAILED");
  await assert.rejects(() => harness.client.initialize(),
    (error) => error.code === "APP_SERVER_CLIENT_CLOSED");
  assert.equal(harness.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(harness.child.killCalls, 0);
});

test("bounds the full initialize handshake when initialized notification backpressure never drains", async () => {
  const child = new InjectedChild();
  child.stdin = new ControlledWritable(2);
  const client = new CodexAppServerClient({
    childProcess: child,
    clientInfo: { name: "hco-test", version: "1.2.3" },
    initializeTimeoutMs: 10
  });
  const initialization = client.initialize();
  await immediate();
  assert.deepEqual(child.stdin.frames.map((frame) => JSON.parse(frame)), [{
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "hco-test", version: "1.2.3" },
      capabilities: { experimentalApi: false }
    }
  }]);

  child.stdout.write(`${JSON.stringify({
    id: 1,
    result: {
      userAgent: "fake/0.142.3",
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "test"
    }
  })}\n`);
  await immediate();
  assert.deepEqual(child.stdin.frames.map((frame) => JSON.parse(frame)).at(-1), { method: "initialized" });
  await assert.rejects(within(initialization, 100),
    (error) => error.code === "APP_SERVER_CLIENT_INITIALIZE_FAILED");
  await assert.rejects(() => client.initialize(),
    (error) => error.code === "APP_SERVER_CLIENT_CLOSED");
  assert.equal(child.stdin.frames.length, 2);
  assert.equal(child.stdin.endCalls, 1);
});

test("maps supported thread and turn methods exactly after initialization", async () => {
  const harness = createClientHarness();
  await initializeHarness(harness);

  await callAndRespond(harness, () => harness.client.startThread({
    cwd: "/tmp/project",
    model: "gpt-test",
    modelReasoningEffort: "high",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    baseInstructions: "base",
    developerInstructions: "developer"
  }), {
    id: 2,
    method: "thread/start",
    params: {
      cwd: "/tmp/project",
      model: "gpt-test",
      config: { model_reasoning_effort: "high" },
      approvalPolicy: "never",
      sandbox: "workspace-write",
      baseInstructions: "base",
      developerInstructions: "developer",
      ephemeral: false
    }
  });
  await callAndRespond(harness, () => harness.client.resumeThread({ threadId: "thread-1" }), {
    id: 3,
    method: "thread/resume",
    params: { threadId: "thread-1" }
  });
  await callAndRespond(harness, () => harness.client.readThread({ threadId: "thread-1", includeTurns: true }), {
    id: 4,
    method: "thread/read",
    params: { threadId: "thread-1", includeTurns: true }
  });
  await callAndRespond(harness, () => harness.client.startTurn({
    threadId: "thread-1",
    text: "Run the task",
    clientUserMessageId: "submission-1"
  }), {
    id: 5,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Run the task" }],
      clientUserMessageId: "submission-1"
    }
  });
  await callAndRespond(harness, () => harness.client.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), {
    id: 6,
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" }
  });
});

test("maps model list requests and freezes validated model catalog responses", async () => {
  const harness = createClientHarness();
  await initializeHarness(harness);

  const first = harness.client.listModels({ includeHidden: true, limit: 100 });
  await immediate();
  assert.deepEqual(harness.sent.at(-1), {
    id: 2,
    method: "model/list",
    params: { includeHidden: true, limit: 100 }
  });
  const firstPayload = { data: [sampleModel()], nextCursor: "cursor-2" };
  harness.child.stdout.write(`${JSON.stringify({ id: 2, result: firstPayload })}\n`);
  const firstResult = await first;
  assert.deepEqual(firstResult, firstPayload);
  assert.equal(Object.isFrozen(firstResult), true);
  assert.equal(Object.isFrozen(firstResult.data), true);
  assert.equal(Object.isFrozen(firstResult.data[0]), true);
  assert.equal(Object.isFrozen(firstResult.data[0].supportedReasoningEfforts), true);

  const second = harness.client.listModels({ cursor: "cursor-2" });
  await immediate();
  assert.deepEqual(harness.sent.at(-1), {
    id: 3,
    method: "model/list",
    params: { cursor: "cursor-2" }
  });
  const secondPayload = { data: [sampleModel({ id: "gpt-next", model: "gpt-next" })], nextCursor: null };
  harness.child.stdout.write(`${JSON.stringify({ id: 3, result: secondPayload })}\n`);
  assert.deepEqual(await second, secondPayload);
});

test("normalizes Codex 0.145 model catalog object metadata", async () => {
  const harness = createClientHarness();
  await initializeHarness(harness);

  const pending = harness.client.listModels({ includeHidden: true });
  await immediate();
  const request = harness.sent.at(-1);
  harness.child.stdout.write(`${JSON.stringify({
    id: request.id,
    result: {
      data: [sampleModel({
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" }
        ],
        serviceTiers: [
          { id: "priority", name: "Fast", description: "Increased usage" }
        ],
        defaultServiceTier: null
      })],
      nextCursor: null
    }
  })}\n`);

  const result = await pending;
  assert.deepEqual(result.data[0].supportedReasoningEfforts, ["low", "high"]);
  assert.deepEqual(result.data[0].serviceTiers, ["priority"]);
  assert.equal(Object.isFrozen(result.data[0].supportedReasoningEfforts), true);
  assert.equal(Object.isFrozen(result.data[0].serviceTiers), true);
});

test("rejects invalid model list options without sending a request", async (t) => {
  const cases = [
    { includeHidden: "true" },
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { cursor: "" },
    { cursor: "x".repeat(4097) },
    { unexpected: true },
    []
  ];

  for (const value of cases) {
    await t.test(JSON.stringify(value).slice(0, 80), async () => {
      const harness = createClientHarness();
      await initializeHarness(harness);
      const sentBefore = harness.sent.length;
      await assert.rejects(() => harness.client.listModels(value),
        (error) => error.code === "APP_SERVER_CLIENT_ARGUMENT_INVALID");
      assert.equal(harness.sent.length, sentBefore);
    });
  }
});

test("rejects invalid model list responses as owned App Server response errors", async (t) => {
  const cases = [
    { data: "bad", nextCursor: null },
    { data: [], nextCursor: 7 },
    { data: [sampleModel({ id: "" })], nextCursor: null },
    { data: [sampleModel({ supportedReasoningEfforts: [""] })], nextCursor: null },
    { data: [sampleModel({ supportedReasoningEfforts: [{ description: "missing effort" }] })], nextCursor: null },
    { data: [sampleModel({ serviceTiers: [{ name: "missing id" }] })], nextCursor: null },
    { data: [sampleModel({ defaultReasoningEffort: 1 })], nextCursor: null }
  ];

  for (const payload of cases) {
    await t.test(JSON.stringify(payload).slice(0, 80), async () => {
      const harness = createClientHarness();
      await initializeHarness(harness);
      const pending = harness.client.listModels();
      await immediate();
      const request = harness.sent.at(-1);
      assert.equal(request.method, "model/list");
      harness.child.stdout.write(`${JSON.stringify({ id: request.id, result: payload })}\n`);
      await assert.rejects(pending, (error) => error.code === "APP_SERVER_CLIENT_RESPONSE_INVALID");
    });
  }
});

test("maps long instruction and text content below the transport byte limit", async () => {
  const harness = createClientHarness();
  await initializeHarness(harness);
  const baseInstructions = "b".repeat(5000);
  const developerInstructions = "d".repeat(5000);
  const thread = harness.client.startThread({ baseInstructions, developerInstructions });
  await immediate();
  const threadRequest = harness.sent.at(-1);
  assert.equal(threadRequest.params.baseInstructions, baseInstructions);
  assert.equal(threadRequest.params.developerInstructions, developerInstructions);
  assert.equal(Buffer.byteLength(JSON.stringify(threadRequest), "utf8") < DEFAULT_MAX_FRAME_BYTES, true);
  harness.child.stdout.write(`${JSON.stringify({ id: threadRequest.id, result: { threadId: "thread-long" } })}\n`);
  await thread;

  const text = "界".repeat(5000);
  const turn = harness.client.startTurn({ threadId: "thread-long", text });
  await immediate();
  const turnRequest = harness.sent.at(-1);
  assert.equal(turnRequest.params.input[0].text, text);
  assert.equal(Buffer.byteLength(JSON.stringify(turnRequest), "utf8") < DEFAULT_MAX_FRAME_BYTES, true);
  harness.child.stdout.write(`${JSON.stringify({ id: turnRequest.id, result: { turnId: "turn-long" } })}\n`);
  await turn;
});

test("rejects an empty model reasoning effort without sending a lifecycle request", async () => {
  const harness = createClientHarness();
  await initializeHarness(harness);
  const sentBefore = harness.sent.length;
  await assert.rejects(() => harness.client.startThread({ modelReasoningEffort: "" }),
    (error) => error.code === "APP_SERVER_CLIENT_ARGUMENT_INVALID");
  assert.equal(harness.sent.length, sentBefore);
});

test("rejects invalid lifecycle inputs and failed initialize is closed without retry", async () => {
  const harness = createClientHarness();
  await assert.rejects(() => harness.client.startThread({ cwd: "relative/path" }),
    (error) => error.code === "APP_SERVER_CLIENT_NOT_INITIALIZED");
  const first = harness.client.initialize();
  const second = harness.client.initialize();
  await immediate();
  harness.child.stdout.write('{"id":1,"result":{"userAgent":"missing metadata"}}\n');
  await assert.rejects(first, (error) => error.code === "APP_SERVER_CLIENT_INITIALIZE_FAILED");
  await assert.rejects(second, (error) => error.code === "APP_SERVER_CLIENT_INITIALIZE_FAILED");
  await assert.rejects(() => harness.client.initialize(), (error) => error.code === "APP_SERVER_CLIENT_CLOSED");
  assert.equal(harness.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(harness.child.killCalls, 0);
});

test("validates owned and injected child streams without terminating an injected child", () => {
  const injected = new EventEmitter();
  injected.killCalls = 0;
  injected.kill = () => { injected.killCalls += 1; };
  assert.throws(() => new CodexAppServerClient({ childProcess: injected }), (error) => {
    assert.equal(error.code, "APP_SERVER_CLIENT_PROCESS_INVALID");
    return true;
  });
  assert.equal(injected.killCalls, 0);

  const owned = new EventEmitter();
  owned.killCalls = 0;
  owned.kill = () => { owned.killCalls += 1; };
  assert.throws(() => new CodexAppServerClient({ spawn: () => owned }), (error) => {
    assert.equal(error.code, "APP_SERVER_CLIENT_PROCESS_INVALID");
    return true;
  });
  assert.equal(owned.killCalls, 1);
});

test("contains rejected observer promises without changing client protocol state", async () => {
  let rejectionObserved = false;
  const observerFailure = Promise.reject(new Error("private observer failure"));
  observerFailure.then(undefined, () => undefined);
  const nativeCatch = observerFailure.catch.bind(observerFailure);
  observerFailure.catch = (...args) => {
    rejectionObserved = true;
    return nativeCatch(...args);
  };
  const harness = createClientHarness({ onDiagnostic: () => observerFailure });

  harness.child.stderr.write("diagnostic input");
  await immediate();
  await immediate();
  assert.equal(rejectionObserved, true);

  const metadata = await initializeHarness(harness);
  assert.equal(metadata.userAgent, "fake/0.142.3");
});

test("real fake child keeps stderr out of protocol parsing and closes without retry", async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.js");
  const diagnostics = [];
  const notifications = [];
  const spawned = [];
  let child;
  const client = new CodexAppServerClient({
    executablePath: "/configured/codex",
    clientInfo: { name: "real-fixture-test", version: "1.0.0" },
    spawn(executablePath, args, options) {
      spawned.push({ executablePath, args, stdio: options.stdio });
      child = spawnProcess(process.execPath, [fixture, "--stderr"], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    },
    onDiagnostic: (event) => diagnostics.push(event),
    onNotification: (event) => notifications.push(event)
  });
  const metadata = await client.initialize();
  assert.equal(metadata.userAgent, "fake-app-server/0.142.3");
  assert.deepEqual(spawned, [{
    executablePath: "/configured/codex",
    args: ["app-server", "--stdio"],
    stdio: ["pipe", "pipe", "pipe"]
  }]);
  await immediate();
  assert.equal(diagnostics.some((event) => event.code === "APP_SERVER_CLIENT_STDERR"), true);
  assert.equal(JSON.stringify(diagnostics).includes("SECRET=value"), false);
  assert.deepEqual(notifications, []);

  const exited = once(child, "exit");
  client.close();
  client.close();
  await exited;
  assert.equal(spawned.length, 1);
});

test("real child exit rejects a pending call and never respawns or retries", async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.js");
  const diagnostics = [];
  let spawnCount = 0;
  let child;
  const client = new CodexAppServerClient({
    spawn() {
      spawnCount += 1;
      child = spawnProcess(process.execPath, [fixture, "--exit-on-read"], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    },
    onDiagnostic: (event) => diagnostics.push(event)
  });
  await client.initialize();
  const exited = once(child, "exit");
  await assert.rejects(() => client.readThread({ threadId: "thread-1", includeTurns: true }), (error) =>
    error.code === "APP_SERVER_CLIENT_CHILD_EXITED" || error.code === "APP_SERVER_TRANSPORT_EOF");
  await exited;
  await immediate();
  assert.equal(spawnCount, 1);
  assert.equal(diagnostics.filter((event) => event.code === "APP_SERVER_CLIENT_CHILD_EXITED").length, 1);
  await assert.rejects(() => client.readThread({ threadId: "thread-1" }),
    (error) => error.code === "APP_SERVER_CLIENT_CLOSED");
  assert.equal(spawnCount, 1);
});
