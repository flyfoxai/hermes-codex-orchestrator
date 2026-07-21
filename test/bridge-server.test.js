import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBearerAuthenticatorFromToken } from "../hco/bridge/auth.js";
import { createBridge } from "../hco/bridge/server.js";
import { stateError } from "../hco/state/reducer.js";
import { openStore } from "../hco/state/store.js";

const TOKEN = "bridge-test-token";
const START_MS = 1_700_000_000_000;
const META = Object.freeze({ protocolVersion: 1, pluginVersion: "test-plugin", capabilities: [] });

function fixturePaths(prefix = "hco-bridge-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  const tokenPath = path.join(directory, "token");
  writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return { databasePath: path.join(directory, "authority.sqlite3"), directory, tokenPath };
}

function countingStore(overrides = {}) {
  const calls = { ackOutbox: 0, claimOutbox: 0, ingest: 0, nackOutbox: 0 };
  const store = {};
  for (const method of Object.keys(calls)) {
    store[method] = (...args) => {
      calls[method] += 1;
      return overrides[method]?.(...args) ?? (method === "claimOutbox" ? [] : { ok: true });
    };
  }
  return { calls, store };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function startTcp(t, store, options = {}) {
  const paths = options.paths ?? fixturePaths();
  const bridge = createBridge({
    store,
    tokenPath: paths.tokenPath,
    hcoVersion: "0.1.0-test",
    ...(options.healthProvider ? { healthProvider: options.healthProvider } : {}),
    ...(options.eventHandler ? { eventHandler: options.eventHandler } : {})
  });
  const running = await bridge.start({ host: options.host ?? "127.0.0.1", port: 0 });
  t.after(() => running.close());
  assert.deepEqual(Object.keys(running).sort(), ["address", "close"]);
  assert.equal(running.address.transport, "tcp");
  return { paths, running, url: `http://${running.address.host}:${running.address.port}` };
}

test("health is authenticated, bounded, and does not touch durable state", async (t) => {
  const { calls, store } = countingStore();
  let available = false;
  const { url } = await startTcp(t, store, {
    healthProvider: () => ({ appServerAvailable: available })
  });

  const unauthorized = await fetch(`${url}/v1/health`);
  assert.equal(unauthorized.status, 401);

  assert.deepEqual(await jsonRequest(url, "/v1/health", { method: "GET" }), {
    status: 200,
    body: { status: "degraded", appServer: { available: false } }
  });
  available = true;
  assert.deepEqual(await jsonRequest(url, "/v1/health", { method: "GET" }), {
    status: 200,
    body: { status: "ok", appServer: { available: true } }
  });
  assert.deepEqual(calls, { ackOutbox: 0, claimOutbox: 0, ingest: 0, nackOutbox: 0 });
});

test("health provider failures return a stable error without leaking details", async (t) => {
  const { store } = countingStore();
  const { url } = await startTcp(t, store, {
    healthProvider() { throw new Error("private-health-secret"); }
  });

  const result = await jsonRequest(url, "/v1/health", { method: "GET" });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    error: { code: "BRIDGE_INTERNAL", message: "Bridge request failed." }
  });
  assert.equal(JSON.stringify(result).includes("private-health-secret"), false);
});

test("plain ACL_FORBIDDEN errors are not trusted or exposed", async (t) => {
  const { store } = countingStore();
  const { url } = await startTcp(t, store, {
    eventHandler() {
      const error = new Error("private-acl-secret");
      error.code = "ACL_FORBIDDEN";
      throw error;
    }
  });

  const result = await jsonRequest(url, "/v1/events", {
    body: { ...META, event: {} }
  });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    error: { code: "BRIDGE_INTERNAL", message: "Bridge request failed." }
  });
  assert.equal(JSON.stringify(result).includes("private-acl-secret"), false);
});

test("trusted objective project mismatch is user-visible while plain errors remain internal", async (t) => {
  const { store } = countingStore();
  const { url } = await startTcp(t, store, {
    eventHandler() {
      throw stateError("OBJECTIVE_PROJECT_MISMATCH", "Objective belongs to another project.");
    }
  });

  const result = await jsonRequest(url, "/v1/events", { body: { ...META, event: {} } });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: { code: "OBJECTIVE_PROJECT_MISMATCH", message: "Objective belongs to another project." }
  });

  const { url: untrustedUrl } = await startTcp(t, store, {
    eventHandler() {
      const error = new Error("private-project-secret");
      error.code = "OBJECTIVE_PROJECT_MISMATCH";
      throw error;
    }
  });
  const untrusted = await jsonRequest(untrustedUrl, "/v1/events", { body: { ...META, event: {} } });
  assert.equal(untrusted.status, 500);
  assert.equal(untrusted.body.error.code, "BRIDGE_INTERNAL");
  assert.equal(JSON.stringify(untrusted).includes("private-project-secret"), false);
});

async function jsonRequest(url, route, { body, headers = {}, method = "POST" } = {}) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { body: await response.json(), status: response.status };
}

function createdFact(objectiveId, sourceId = `created-${objectiveId}`) {
  return {
    sourceType: "bridge",
    sourceId,
    eventName: "objective.created",
    schemaVersion: 1,
    projectId: "project-1",
    deliveryTargetId: `target-${objectiveId}`,
    objectiveId,
    payload: { state: "created", title: `Objective ${objectiveId}` },
    integrity: { algorithm: "sha256", digest: `digest-${objectiveId}` }
  };
}

function deliveryFact(objectiveId, sourceId, messages) {
  return {
    sourceType: "renderer",
    sourceId,
    eventName: "zulip.delivery.requested",
    schemaVersion: 1,
    objectiveId,
    payload: { messages }
  };
}

function message(semanticKey, text) {
  return {
    semanticKey,
    payload: { type: "stream", content: text },
    targetSnapshot: { streamId: 42, topic: "Build" }
  };
}

test("authenticates every route and compatibility is negotiated without store calls", async (t) => {
  const { calls, store } = countingStore();
  const { url } = await startTcp(t, store);

  const unauthorized = await fetch(`${url}/v1/compatibility`, { headers: { authorization: "Bearer wrong" } });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: { code: "BRIDGE_AUTH_FAILED", message: "Authentication failed." } });

  const result = await jsonRequest(url, "/v1/compatibility", {
    method: "GET",
    headers: {
      "x-hco-protocol-version": "1",
      "x-hco-plugin-version": "test-plugin",
      "x-hco-capabilities": "[]"
    }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    compatibility: { protocolVersion: 1, peerPluginVersion: "test-plugin", capabilities: [] },
    hco: { version: "0.1.0-test" }
  });
  assert.deepEqual(calls, { ackOutbox: 0, claimOutbox: 0, ingest: 0, nackOutbox: 0 });
});

test("unsupported POST protocol versions are rejected before metadata, payload, or store use", async (t) => {
  const { calls, store } = countingStore();
  const { url } = await startTcp(t, store);
  const response = await jsonRequest(url, "/v1/events", {
    body: { protocolVersion: 2, pluginVersion: 7, capabilities: "bad", event: "bad", extra: true }
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: { code: "BRIDGE_VERSION_UNSUPPORTED", message: "Bridge protocol major version is unsupported." }
  });
  assert.deepEqual(calls, { ackOutbox: 0, claimOutbox: 0, ingest: 0, nackOutbox: 0 });
});

test("maps endpoint payloads exactly and rejects unexpected fields and typed store input", async (t) => {
  const seen = [];
  const { store } = countingStore({
    ingest(value) { seen.push(["ingest", value]); return { duplicate: false }; },
    claimOutbox(value) { seen.push(["claim", value]); return [{ deliveryId: "d-1" }]; },
    ackOutbox(value) { seen.push(["ack", value]); return { state: "delivered" }; },
    nackOutbox(value) { seen.push(["nack", value]); return { state: "pending" }; }
  });
  const { url } = await startTcp(t, store);

  assert.deepEqual((await jsonRequest(url, "/v1/events", { body: { ...META, event: { exact: true } } })).body,
    { result: { duplicate: false } });
  assert.deepEqual((await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker", limit: 2, leaseMs: 1000 }
  })).body, { deliveries: [{ deliveryId: "d-1" }] });
  assert.deepEqual((await jsonRequest(url, "/v1/outbox/d%2F1/ack", {
    body: { ...META, leaseToken: "lease", zulipMessageId: 12 }
  })).body, { result: { state: "delivered" } });
  assert.deepEqual((await jsonRequest(url, "/v1/outbox/d%202/nack", {
    body: { ...META, leaseToken: "lease-2", error: "temporary", retryable: true }
  })).body, { result: { state: "pending" } });
  assert.deepEqual(seen, [
    ["ingest", { exact: true }],
    ["claim", { workerId: "worker", limit: 2, leaseMs: 1000 }],
    ["ack", { deliveryId: "d/1", leaseToken: "lease", zulipMessageId: 12 }],
    ["nack", { deliveryId: "d 2", leaseToken: "lease-2", error: "temporary", retryable: true }]
  ]);

  const unexpected = await jsonRequest(url, "/v1/events", { body: { ...META, event: {}, surprise: true } });
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.body.error.code, "BRIDGE_FIELDS_INVALID");
});

test("awaits an injected async event handler while outbox methods remain on the store", async (t) => {
  const gate = deferred();
  const events = [];
  const store = {
    claimOutbox() { return []; },
    ackOutbox() { return { state: "delivered" }; },
    nackOutbox() { return { state: "pending" }; }
  };
  const bridge = createBridge({
    store,
    authenticator: Object.freeze({ authenticate: (authorization) => authorization === `Bearer ${TOKEN}` }),
    async eventHandler(event) {
      events.push(event);
      await gate.promise;
      return { accepted: true };
    }
  });
  const running = await bridge.start({ host: "127.0.0.1", port: 0 });
  t.after(() => running.close());
  const url = `http://${running.address.host}:${running.address.port}`;
  let completed = false;
  const request = jsonRequest(url, "/v1/events", {
    body: { ...META, event: { exact: true } }
  }).then((result) => {
    completed = true;
    return result;
  });

  while (events.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(events, [{ exact: true }]);
  gate.resolve();
  assert.deepEqual(await request, { status: 200, body: { result: { accepted: true } } });
});

test("returns stable JSON statuses for routes, methods, media types, parsing, size, and untrusted failures", async (t) => {
  const { store } = countingStore({
    ingest() {
      const error = new Error("native secret");
      error.code = "BRIDGE_VERSION_UNSUPPORTED";
      throw error;
    }
  });
  const { url } = await startTcp(t, store);

  const cases = [
    [await jsonRequest(url, "/unknown", { method: "GET" }), 404, "BRIDGE_ROUTE_NOT_FOUND"],
    [await jsonRequest(url, "/v1/events", { method: "GET" }), 405, "BRIDGE_METHOD_NOT_ALLOWED"],
    [await jsonRequest(url, "/v1/events", { body: META, headers: { "content-type": "text/plain" } }), 415, "BRIDGE_CONTENT_TYPE_INVALID"]
  ];
  const malformed = await fetch(`${url}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{"
  });
  cases.push([{ status: malformed.status, body: await malformed.json() }, 400, "BRIDGE_JSON_INVALID"]);
  const oversized = await jsonRequest(url, "/v1/events", { body: { ...META, event: "x".repeat(1024 * 1024) } });
  cases.push([oversized, 413, "BRIDGE_BODY_TOO_LARGE"]);
  const internal = await jsonRequest(url, "/v1/events", { body: { ...META, event: {} } });
  cases.push([internal, 500, "BRIDGE_INTERNAL"]);

  for (const [response, status, code] of cases) {
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes("native secret"), false);
    assert.equal(JSON.stringify(response.body).includes("BRIDGE_VERSION_UNSUPPORTED"), false);
  }
});

test("rejects duplicate content length with a JSON parser error response", async (t) => {
  const { store } = countingStore();
  const { running } = await startTcp(t, store);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(running.address.port, running.address.host);
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw));
    socket.on("connect", () => socket.end(
      "POST /v1/events HTTP/1.1\r\n" +
      `Host: ${running.address.host}\r\n` +
      `Authorization: Bearer ${TOKEN}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 2\r\n" +
      "Content-Length: 2\r\n" +
      "Connection: close\r\n\r\n{}"
    ));
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /application\/json/);
  assert.match(response, /"code":"BRIDGE_REQUEST_INVALID"/);
});

test("loads a bounded owner-only regular token once and rejects unsafe token sources", async (t) => {
  const paths = fixturePaths("hco-token-");
  const { store } = countingStore();
  const bridge = createBridge({ store, tokenPath: paths.tokenPath });
  writeFileSync(paths.tokenPath, "changed-after-construction", { mode: 0o600 });
  const running = await bridge.start({ host: "127.0.0.1", port: 0 });
  t.after(() => running.close());
  const original = await fetch(`http://${running.address.host}:${running.address.port}/missing`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(original.status, 404);

  const unsafe = [
    ["group-readable", () => { const p = fixturePaths(); chmodSync(p.tokenPath, 0o640); return p.tokenPath; }],
    ["symlink", () => { const p = fixturePaths(); const link = `${p.tokenPath}.link`; symlinkSync(p.tokenPath, link); return link; }],
    ["whitespace", () => { const p = fixturePaths(); writeFileSync(p.tokenPath, "two tokens", { mode: 0o600 }); return p.tokenPath; }],
    ["oversized", () => { const p = fixturePaths(); writeFileSync(p.tokenPath, "x".repeat(4097), { mode: 0o600 }); return p.tokenPath; }]
  ];
  for (const [, tokenPathFactory] of unsafe) {
    assert.throws(() => createBridge({ store, tokenPath: tokenPathFactory() }), (error) => {
      assert.equal(error.code, "BRIDGE_TOKEN_INVALID");
      assert.equal(error.message, "Bridge token file is invalid.");
      return true;
    });
  }
});

test("builds an immutable bearer authenticator from startup-loaded token bytes", () => {
  const token = Buffer.from(TOKEN, "ascii");
  const authenticator = createBearerAuthenticatorFromToken(token);
  token.fill(0);

  assert.equal(authenticator.authenticate(`Bearer ${TOKEN}`), true);
  assert.equal(authenticator.authenticate("Bearer wrong"), false);
  for (const invalid of [Buffer.alloc(0), Buffer.from("two tokens"), Buffer.alloc(4097, 0x78)]) {
    assert.throws(() => createBearerAuthenticatorFromToken(invalid), { code: "BRIDGE_TOKEN_INVALID" });
  }
});

test("restricts TCP binds and creates owner-only Unix sockets without following symlinks", async (t) => {
  const paths = fixturePaths("hco-bind-");
  const { store } = countingStore();
  const bridge = createBridge({ store, tokenPath: paths.tokenPath });
  await assert.rejects(() => bridge.start({ host: "0.0.0.0", port: 0 }), (error) => error.code === "BRIDGE_BIND_INVALID");

  const socketPath = path.join(paths.directory, "bridge.sock");
  const unix = await bridge.start({ socketPath });
  t.after(() => unix.close());
  assert.deepEqual(unix.address, { transport: "unix", path: socketPath });
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);

  const target = path.join(paths.directory, "target");
  const link = path.join(paths.directory, "linked.sock");
  writeFileSync(target, "do not remove");
  symlinkSync(target, link);
  await assert.rejects(() => bridge.start({ socketPath: link }), (error) => error.code === "BRIDGE_SOCKET_INVALID");
});

test("real bridge ingestion is idempotent and does not enqueue duplicate source identity twice", async (t) => {
  const paths = fixturePaths("hco-idempotency-");
  const store = openStore({ databasePath: paths.databasePath });
  t.after(() => store.close());
  const { url } = await startTcp(t, store, { paths });
  const objectiveId = "objective-idempotent";
  await jsonRequest(url, "/v1/events", { body: { ...META, event: createdFact(objectiveId) } });
  const event = deliveryFact(objectiveId, "delivery-source", [message("stable-key", "payload")]);
  const first = await jsonRequest(url, "/v1/events", { body: { ...META, event } });
  const duplicate = await jsonRequest(url, "/v1/events", { body: { ...META, event } });
  assert.equal(first.body.result.duplicate, false);
  assert.equal(first.body.result.outbox.length, 1);
  assert.equal(duplicate.body.result.duplicate, true);
  const claim = await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker", limit: 10, leaseMs: 1000 }
  });
  assert.equal(claim.body.deliveries.length, 1);
});

test("leases and immutable delivery identity survive bridge/store restart until expiry", async () => {
  const paths = fixturePaths("hco-crash-");
  const clock = { value: START_MS };
  let id = 0;
  const idFactory = (kind) => `${kind}-${++id}`;
  let store = openStore({ databasePath: paths.databasePath, now: () => clock.value, idFactory });
  let bridge = createBridge({ store, tokenPath: paths.tokenPath });
  let running = await bridge.start({ host: "127.0.0.1", port: 0 });
  let url = `http://${running.address.host}:${running.address.port}`;
  const objectiveId = "objective-crash";
  await jsonRequest(url, "/v1/events", { body: { ...META, event: createdFact(objectiveId) } });
  await jsonRequest(url, "/v1/events", {
    body: { ...META, event: deliveryFact(objectiveId, "delivery-crash", [message("semantic-crash", "payload")]) }
  });
  const first = (await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-1", limit: 1, leaseMs: 1000 }
  })).body.deliveries[0];
  await running.close();
  store.close();

  store = openStore({ databasePath: paths.databasePath, now: () => clock.value, idFactory });
  bridge = createBridge({ store, tokenPath: paths.tokenPath });
  running = await bridge.start({ host: "127.0.0.1", port: 0 });
  url = `http://${running.address.host}:${running.address.port}`;
  assert.deepEqual((await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-2", limit: 1, leaseMs: 1000 }
  })).body.deliveries, []);
  clock.value += 1001;
  const recovered = (await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-2", limit: 1, leaseMs: 1000 }
  })).body.deliveries[0];
  for (const field of ["deliveryId", "objectiveId", "semanticKey", "objectiveSequence", "payload", "targetSnapshot"]) {
    assert.deepEqual(recovered[field], first[field]);
  }
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  await running.close();
  store.close();
});

test("ack and nack expose Task 2 duplicate, conflict, ownership, retry, and ordering rules", async (t) => {
  const paths = fixturePaths("hco-ack-");
  const store = openStore({ databasePath: paths.databasePath });
  t.after(() => store.close());
  const { url } = await startTcp(t, store, { paths });
  const objectiveId = "objective-ack";
  await jsonRequest(url, "/v1/events", { body: { ...META, event: createdFact(objectiveId) } });
  await jsonRequest(url, "/v1/events", {
    body: { ...META, event: deliveryFact(objectiveId, "deliver-two", [message("one", "first"), message("two", "second")]) }
  });
  const first = (await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-1", limit: 2, leaseMs: 1000 }
  })).body.deliveries[0];
  const ackBody = { ...META, leaseToken: first.leaseToken, zulipMessageId: 777 };
  assert.equal((await jsonRequest(url, `/v1/outbox/${first.deliveryId}/ack`, { body: ackBody })).body.result.duplicate, false);
  assert.equal((await jsonRequest(url, `/v1/outbox/${first.deliveryId}/ack`, { body: ackBody })).body.result.duplicate, true);
  assert.equal((await jsonRequest(url, `/v1/outbox/${first.deliveryId}/ack`, {
    body: { ...ackBody, zulipMessageId: 778 }
  })).status, 409);
  assert.equal((await jsonRequest(url, `/v1/outbox/${first.deliveryId}/ack`, {
    body: { ...ackBody, leaseToken: "foreign" }
  })).status, 409);

  const second = (await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-2", limit: 1, leaseMs: 1000 }
  })).body.deliveries[0];
  const retry = await jsonRequest(url, `/v1/outbox/${second.deliveryId}/nack`, {
    body: { ...META, leaseToken: second.leaseToken, error: "temporary", retryable: true }
  });
  assert.deepEqual(retry.body.result, { deliveryId: second.deliveryId, state: "pending", retryable: true });
  const reclaimed = (await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-3", limit: 1, leaseMs: 1000 }
  })).body.deliveries[0];
  assert.equal(reclaimed.deliveryId, second.deliveryId);
  const permanent = await jsonRequest(url, `/v1/outbox/${reclaimed.deliveryId}/nack`, {
    body: { ...META, leaseToken: reclaimed.leaseToken, error: "permanent", retryable: false }
  });
  assert.deepEqual(permanent.body.result, { deliveryId: second.deliveryId, state: "failed", retryable: false });
  assert.deepEqual((await jsonRequest(url, "/v1/outbox/claim", {
    body: { ...META, workerId: "worker-4", limit: 1, leaseMs: 1000 }
  })).body.deliveries, []);
});
