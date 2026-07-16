import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFER_SERVER_REQUEST } from "../hco/app-server/rpc-client.js";
import { createHcoRuntime } from "../hco/index.js";

const REVERSE_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);

const BACKEND_METHODS = Object.freeze([
  "startObjective",
  "startTurn",
  "interruptTurn",
  "readObjective",
  "reconcileObjective",
  "respondToInteraction"
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

function runtimeConfig(overrides = {}) {
  return Object.freeze({
    version: 1,
    codexExecutablePath: "/runtime/bin/codex",
    databasePath: "/runtime/hco.sqlite",
    bridge: Object.freeze({
      tokenPath: "/runtime/token",
      contextKeyPath: "/runtime/context-key",
      socketPath: "/runtime/hco.sock",
      routeSnapshotPath: "/runtime/routes.json"
    }),
    snapshot: Object.freeze({ ttlMs: 60_000, maxBytes: 262_144 }),
    admins: Object.freeze([]),
    projects: Object.freeze([]),
    ...overrides
  });
}

function harness(overrides = {}) {
  const calls = [];
  const diagnostics = [];
  const backendCalls = [];
  const reverseRequests = [];
  const notifications = [];
  const serviceRequests = [];
  const serviceNotifications = [];
  const config = overrides.config ?? runtimeConfig();
  const store = {
    close() { calls.push("store:close"); },
    ...(overrides.store ?? {})
  };
  const client = {
    async initialize() { calls.push("client:initialize"); return { userAgent: "fake" }; },
    close() { calls.push("client:close"); },
    ...(overrides.client ?? {})
  };
  const backend = overrides.backend ?? Object.freeze({
    ...Object.fromEntries(BACKEND_METHODS.map((method) => [method, async (input) => {
      backendCalls.push([method, input]);
      return { method };
    }])),
    getCapabilities() {
      return Object.freeze({
        backend: "app-server",
        durableThreadContinuity: true,
        reverseInteractions: true
      });
    }
  });
  const controller = {
    handleConnectionLost(input) { calls.push(["controller:connection-lost", input]); return { status: "recorded" }; },
    ...(overrides.controller ?? {})
  };
  const service = {
    async handleBridgeEvent(event) { calls.push(["service:event", event]); return { accepted: true }; },
    async handleAppServerRequest(input) { serviceRequests.push(input); },
    async handleAppServerNotification(input) { serviceNotifications.push(input); },
    async start() { calls.push("service:start"); },
    close() { calls.push("service:close"); return Promise.resolve(); },
    ...(overrides.service ?? {})
  };
  const listener = {
    address: { transport: "unix", path: config.bridge.socketPath },
    close() { calls.push("listener:close"); return Promise.resolve(); },
    ...(overrides.listener ?? {})
  };
  const bridge = {
    async start(options) { calls.push(["bridge:start", options]); return listener; },
    ...(overrides.bridge ?? {})
  };
  let clientOptions;
  let controllerOptions;
  let serviceOptions;
  let bridgeOptions;
  let createBackendCalls = 0;
  let createClientCalls = 0;

  const dependencies = {
    configPath: "/runtime/config.json",
    env: Object.freeze({ HCO_CONFIG_PATH: "/ignored" }),
    loadConfig(options) {
      calls.push(["config:load", options]);
      return config;
    },
    loadSecret(options) {
      calls.push(["secret:load", options]);
      return options.path === config.bridge.tokenPath
        ? Buffer.from("runtime-bridge-token", "ascii")
        : Buffer.alloc(32, 7);
    },
    openStore(options) {
      calls.push(["store:open", options]);
      return store;
    },
    createClient(options) {
      createClientCalls += 1;
      calls.push("client:create");
      clientOptions = options;
      if (overrides.createClientError) throw overrides.createClientError;
      return client;
    },
    createBackend(options) {
      createBackendCalls += 1;
      calls.push(["backend:create", options]);
      if (overrides.createBackendError) throw overrides.createBackendError;
      return backend;
    },
    createController(options) {
      calls.push("controller:create");
      controllerOptions = options;
      return controller;
    },
    createService(options) {
      calls.push("service:create");
      serviceOptions = options;
      return service;
    },
    createBridge(options) {
      calls.push("bridge:create");
      bridgeOptions = options;
      return bridge;
    },
    idFactory(kind) { return `${kind}-1`; },
    now: () => 1_700_000_000_000,
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
    async onReverseRequest(input) { reverseRequests.push(input); },
    async onNotification(input) { notifications.push(input); }
  };

  return {
    backend,
    backendCalls,
    bridge,
    calls,
    client,
    config,
    controller,
    dependencies,
    diagnostics,
    get bridgeOptions() { return bridgeOptions; },
    get clientOptions() { return clientOptions; },
    get controllerOptions() { return controllerOptions; },
    get createBackendCalls() { return createBackendCalls; },
    get createClientCalls() { return createClientCalls; },
    get serviceOptions() { return serviceOptions; },
    listener,
    notifications,
    reverseRequests,
    serviceNotifications,
    serviceRequests,
    service,
    store
  };
}

test("starts an injectable frozen runtime after one config and two secret loads", async () => {
  const fixture = harness();
  const runtime = await createHcoRuntime(fixture.dependencies);

  assert.ok(Object.isFrozen(runtime));
  assert.equal(runtime.appServerAvailable, true);
  assert.equal(runtime.config, fixture.config);
  assert.equal(runtime.store, fixture.store);
  assert.equal(runtime.controller, fixture.controller);
  assert.equal(runtime.service, fixture.service);
  assert.equal(runtime.listener, fixture.listener);
  assert.equal(runtime.client, fixture.client);
  assert.deepEqual(fixture.calls.slice(0, 4), [
    ["config:load", { configPath: "/runtime/config.json", env: fixture.dependencies.env }],
    ["secret:load", { path: "/runtime/token", minBytes: 1, maxBytes: 4096 }],
    ["secret:load", { path: "/runtime/context-key", minBytes: 32, maxBytes: 4096 }],
    ["store:open", {
      databasePath: "/runtime/hco.sqlite",
      idFactory: fixture.dependencies.idFactory,
      now: fixture.dependencies.now
    }]
  ]);
  assert.ok(fixture.calls.indexOf("service:start") < fixture.calls.findIndex((call) => Array.isArray(call) && call[0] === "bridge:start"));
  assert.ok(fixture.calls.findIndex((call) => Array.isArray(call) && call[0] === "bridge:start") < fixture.calls.indexOf("client:initialize"));
  assert.equal(fixture.serviceOptions.contextKey.equals(Buffer.alloc(32, 7)), true);
  assert.equal(fixture.clientOptions.executablePath, "/runtime/bin/codex");
  assert.equal(fixture.bridgeOptions.store, fixture.store);
  assert.equal(fixture.bridgeOptions.authenticator.authenticate("Bearer runtime-bridge-token"), true);
  assert.deepEqual(await fixture.bridgeOptions.eventHandler({ event: 1 }), { accepted: true });
  assert.deepEqual(fixture.calls.at(-1), ["service:event", { event: 1 }]);

  await runtime.close();
});

test("default client construction starts the configured absolute Codex executable", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-runtime-codex-"));
  const executablePath = path.join(directory, "configured-codex");
  const markerPath = path.join(directory, "started");
  writeFileSync(executablePath, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(91);
fs.writeFileSync(${JSON.stringify(markerPath)}, "started");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const message = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        userAgent: "configured-fake/1.0", codexHome: "/tmp/configured-fake",
        platformFamily: "unix", platformOs: "test"
      } }) + "\\n");
    }
  }
});
`, { mode: 0o700 });
  chmodSync(executablePath, 0o700);

  const fixture = harness({ config: runtimeConfig({ codexExecutablePath: executablePath }) });
  const dependencies = { ...fixture.dependencies };
  delete dependencies.createClient;
  const runtime = await createHcoRuntime(dependencies);

  assert.equal(existsSync(markerPath), true);
  await runtime.close();
});

test("hco/index.js starts its configured absolute Codex executable through the real runtime", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-entry-codex-"));
  const executablePath = path.join(directory, "configured-codex");
  const markerPath = path.join(directory, "started.json");
  const tokenPath = path.join(directory, "bridge-token");
  const contextKeyPath = path.join(directory, "context-key");
  const configPath = path.join(directory, "hco.json");
  const socketPath = path.join(directory, "hco.sock");
  writeFileSync(executablePath, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const message = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        userAgent: "entry-fake/1.0", codexHome: "/tmp/entry-fake",
        platformFamily: "unix", platformOs: "test"
      } }) + "\\n");
    }
  }
});
`, { mode: 0o700 });
  writeFileSync(tokenPath, "owner-only-token", { mode: 0o600 });
  writeFileSync(contextKeyPath, Buffer.alloc(32, 9), { mode: 0o600 });
  writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    codexExecutablePath: executablePath,
    databasePath: path.join(directory, "hco.sqlite3"),
    bridge: {
      tokenPath,
      contextKeyPath,
      socketPath,
      routeSnapshotPath: path.join(directory, "routes.json")
    },
    snapshot: { ttlMs: 60_000, maxBytes: 262_144 },
    admins: [],
    projects: []
  })}\n`, { mode: 0o600 });
  for (const ownerPath of [executablePath, tokenPath, contextKeyPath, configPath]) {
    chmodSync(ownerPath, ownerPath === executablePath ? 0o700 : 0o600);
  }

  const entry = spawn(process.execPath, [path.resolve("hco/index.js")], {
    cwd: path.resolve("."),
    env: { HCO_CONFIG_PATH: configPath },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  entry.stderr.setEncoding("utf8");
  entry.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitUntil(() => existsSync(markerPath) && existsSync(socketPath));
    assert.deepEqual(JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(markerPath, "utf8"))), ["app-server", "--stdio"]);
  } finally {
    entry.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => entry.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`HCO entry did not stop: ${stderr}`)), 5_000))
    ]);
  }
});

test("binds adapters before initialize and keeps supported reverse requests deferred", async () => {
  const fixture = harness();
  const runtime = await createHcoRuntime(fixture.dependencies);

  assert.deepEqual(Object.keys(fixture.clientOptions.requestHandlers).sort(), [...REVERSE_METHODS].sort());
  for (const [index, method] of REVERSE_METHODS.entries()) {
    const message = { id: index + 1, method, params: { untrusted: true } };
    assert.equal(await fixture.clientOptions.requestHandlers[method](message), DEFER_SERVER_REQUEST);
  }
  assert.equal(fixture.reverseRequests.length, 3);
  assert.equal(fixture.serviceRequests.length, 3);
  for (const request of fixture.reverseRequests) {
    assert.equal(request.controller, fixture.controller);
    assert.equal(request.connectionId, "connection-1");
  }

  await fixture.clientOptions.onNotification({ method: "turn/completed", params: { untrusted: true } });
  assert.deepEqual(fixture.serviceNotifications, [{
    message: { method: "turn/completed", params: { untrusted: true } }
  }]);
  assert.deepEqual(fixture.notifications, [{
    controller: fixture.controller,
    connectionId: "connection-1",
    message: { method: "turn/completed", params: { untrusted: true } }
  }]);
  await fixture.clientOptions.onTerminal(new Error("lost"));
  await fixture.clientOptions.onTerminal(new Error("duplicate terminal callback"));
  assert.deepEqual(fixture.calls.filter((call) => Array.isArray(call) && call[0] === "controller:connection-lost"), [
    ["controller:connection-lost", { connectionId: "connection-1" }]
  ]);

  await runtime.close();
});

test("built-in App Server adapters and observers run independently with bounded diagnostics", async () => {
  const fixture = harness({
    service: {
      async handleAppServerRequest() { throw new Error("private request failure"); },
      async handleAppServerNotification(input) { fixture.serviceNotifications.push(input); }
    }
  });
  fixture.dependencies.onNotification = async () => { throw new Error("private observer failure"); };
  const runtime = await createHcoRuntime(fixture.dependencies);

  const request = { id: 1, method: REVERSE_METHODS[0], params: { threadId: "thread", turnId: "turn" } };
  assert.equal(await fixture.clientOptions.requestHandlers[REVERSE_METHODS[0]](request), DEFER_SERVER_REQUEST);
  assert.equal(fixture.reverseRequests.length, 1);
  assert.ok(fixture.diagnostics.some((entry) => entry.code === "HCO_REVERSE_REQUEST_ADAPTER_FAILED"));

  const notification = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } };
  await fixture.clientOptions.onNotification(notification);
  assert.deepEqual(fixture.serviceNotifications, [{ message: notification }]);
  assert.ok(fixture.diagnostics.some((entry) => entry.code === "HCO_NOTIFICATION_ADAPTER_FAILED"));
  assert.equal(JSON.stringify(fixture.diagnostics).includes("private"), false);

  await runtime.close();
});

test("keeps every App Server backend method unavailable while initialize is pending", async () => {
  const initialization = deferred();
  const initializeStarted = deferred();
  const fixture = harness({
    client: {
      initialize() {
        fixture.calls.push("client:initialize");
        initializeStarted.resolve();
        return initialization.promise;
      },
      close() { fixture.calls.push("client:close"); }
    }
  });

  const runtimePromise = createHcoRuntime(fixture.dependencies);
  await initializeStarted.promise;

  for (const method of BACKEND_METHODS) {
    await assert.rejects(
      fixture.controllerOptions.appServerBackend[method]({}),
      { code: "EXECUTION_BACKEND_UNAVAILABLE" }
    );
  }
  assert.deepEqual(fixture.backendCalls, []);

  initialization.resolve({ userAgent: "fake" });
  const runtime = await runtimePromise;
  await fixture.controllerOptions.appServerBackend.startObjective({ objective: 1 });
  assert.deepEqual(fixture.backendCalls, [["startObjective", { objective: 1 }]]);

  await runtime.close();
});

test("degrades initialize failure without closing control or selecting tmux", async () => {
  const fixture = harness({
    client: {
      async initialize() { fixture.calls.push("client:initialize"); throw new Error("private initialize failure"); },
      close() { fixture.calls.push("client:close"); }
    }
  });
  const runtime = await createHcoRuntime(fixture.dependencies);

  assert.equal(runtime.appServerAvailable, false);
  assert.equal(runtime.listener, fixture.listener);
  assert.notEqual(fixture.controllerOptions.appServerBackend, fixture.backend);
  await assert.rejects(
    fixture.controllerOptions.appServerBackend.startObjective({ objective: 1 }),
    { code: "EXECUTION_BACKEND_UNAVAILABLE" }
  );
  assert.deepEqual(fixture.backendCalls, []);
  assert.equal(fixture.controllerOptions.tmuxBackend, undefined);
  assert.ok(fixture.diagnostics.some((entry) => entry.code === "HCO_APP_SERVER_UNAVAILABLE"));
  assert.equal(JSON.stringify(fixture.diagnostics).includes("private initialize failure"), false);

  await runtime.close();
});

test("degrades synchronous client creation to a pre-write unavailable backend", async () => {
  const fixture = harness({ createClientError: new Error("private spawn failure") });
  const runtime = await createHcoRuntime(fixture.dependencies);

  assert.equal(runtime.appServerAvailable, false);
  assert.equal(runtime.client, null);
  assert.equal(fixture.createBackendCalls, 0);
  await assert.rejects(
    fixture.controllerOptions.appServerBackend.startObjective({}),
    { code: "EXECUTION_BACKEND_UNAVAILABLE" }
  );
  assert.equal(fixture.controllerOptions.tmuxBackend, undefined);
  assert.ok(fixture.diagnostics.some((entry) => entry.code === "HCO_APP_SERVER_UNAVAILABLE"));

  await runtime.close();
});

test("passes tmux only when explicitly injected", async () => {
  const tmuxBackend = Object.freeze({ kind: "explicit-tmux" });
  const fixture = harness();
  const runtime = await createHcoRuntime({ ...fixture.dependencies, tmuxBackend });
  assert.equal(fixture.controllerOptions.tmuxBackend, tmuxBackend);
  await runtime.close();
});

test("failed initial snapshot prevents listener start and rolls startup back", async () => {
  const fixture = harness({
    service: {
      async start() { fixture.calls.push("service:start"); throw new Error("snapshot failed"); },
      close() { fixture.calls.push("service:close"); return Promise.resolve(); }
    }
  });

  await assert.rejects(() => createHcoRuntime(fixture.dependencies), /snapshot failed/);
  assert.equal(fixture.calls.some((call) => Array.isArray(call) && call[0] === "bridge:start"), false);
  assert.deepEqual(fixture.calls.slice(-3), ["service:close", "client:close", "store:close"]);
});

test("listener startup failure rolls service, owned client, and store back in reverse order", async () => {
  const fixture = harness({
    bridge: {
      async start(options) {
        fixture.calls.push(["bridge:start", options]);
        throw new Error("listen failed");
      }
    }
  });

  await assert.rejects(() => createHcoRuntime(fixture.dependencies), /listen failed/);
  assert.deepEqual(fixture.calls.slice(-3), ["service:close", "client:close", "store:close"]);
});

test("close uses one promise and shuts down listener, service, owned client, then store", async () => {
  const fixture = harness();
  const runtime = await createHcoRuntime(fixture.dependencies);

  const first = runtime.close();
  const second = runtime.close();
  assert.equal(first, second);
  await first;
  assert.deepEqual(fixture.calls.slice(-4), ["listener:close", "service:close", "client:close", "store:close"]);
});
