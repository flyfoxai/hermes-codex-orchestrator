import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createAcl } from "../hco/acl.js";
import { validateArtifactManifestShape } from "../hco/artifacts.js";
import { loadHcoConfig, loadOwnerSecret } from "../hco/config.js";
import { signContext } from "../hco/contracts/envelope.js";
import { createRouteResolver, publishRouteSnapshot, validateRouteSnapshot } from "../hco/routes.js";
import { createHcoService } from "../hco/service.js";
import { MIGRATIONS } from "../hco/state/migrations.js";
import { isStateError } from "../hco/state/reducer.js";
import { openStore } from "../hco/state/store.js";
import { TurnController } from "../hco/turn-controller.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function snapshotMutation(bytes, mutate) {
  const snapshot = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
  mutate(snapshot);
  const { integrity, ...payload } = snapshot;
  integrity.canonicalPayloadSha256 = createHash("sha256").update(canonical(payload), "utf8").digest("hex");
  return Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
}

test("exports its control-plane surface and registers migrations contiguously", () => {
  assert.equal(typeof loadHcoConfig, "function");
  assert.equal(typeof loadOwnerSecret, "function");
  assert.equal(typeof createAcl, "function");
  assert.equal(typeof createRouteResolver, "function");
  assert.equal(typeof publishRouteSnapshot, "function");
  assert.equal(typeof validateRouteSnapshot, "function");
  assert.equal(typeof createHcoService, "function");
  assert.equal(MIGRATIONS.at(-1).name, "managed_document_access_hardening");
  assert.equal(MIGRATIONS.at(-2).name, "managed_file_exchange");
  assert.equal(MIGRATIONS.at(-1).version, MIGRATIONS.at(-2).version + 1);
});

function configFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-config-"));
  const project = path.join(directory, "project-link");
  const configPath = path.join(directory, "hco.json");
  const tokenPath = path.join(directory, "token");
  const keyPath = path.join(directory, "key");
  const socketPath = path.join(directory, "hco.sock");
  const snapshotPath = path.join(directory, "routes.json");
  const databasePath = path.join(directory, "hco.sqlite");
  const projectDirectory = path.join(directory, "project-link-target");
  mkdirSync(projectDirectory);
  symlinkSync(projectDirectory, project);
  return { directory, project, projectDirectory, configPath, tokenPath, keyPath, socketPath, snapshotPath, databasePath };
}

function writeConfig(fixture, overrides = {}) {
  const value = {
    version: 1,
    codexExecutablePath: "/opt/hco/bin/codex",
    databasePath: fixture.databasePath,
    bridge: {
      tokenPath: fixture.tokenPath,
      contextKeyPath: fixture.keyPath,
      socketPath: fixture.socketPath,
      routeSnapshotPath: fixture.snapshotPath
    },
    admins: [1],
    projects: [{
      projectId: "alpha",
      cwd: fixture.project,
      staticStreamIds: [42],
      acl: { viewers: [2], contributors: [3], maintainers: [4] },
      threadOptions: { model: "gpt-5", modelReasoningEffort: "high", baseInstructions: "Use tests." }
    }],
    ...overrides
  };
  writeFileSync(fixture.configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(fixture.configPath, 0o600);
  return value;
}

test("loads a deeply immutable project registry and only canonical registered cwd", () => {
  const fixture = configFixture();
  const source = writeConfig(fixture);
  const config = loadHcoConfig({ configPath: fixture.configPath });

  assert.equal(config.projects[0].cwd, realpathSync(fixture.projectDirectory));
  assert.equal(config.projects[0].backend, "app-server");
  assert.deepEqual(config.snapshot, { ttlMs: 60_000, maxBytes: 262_144 });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.projects[0].acl.viewers));
  source.projects[0].acl.viewers.push(999);
  assert.deepEqual(config.projects[0].acl.viewers, [2]);
  assert.deepEqual(config.projects[0].threadOptions, {
    model: "gpt-5",
    modelReasoningEffort: "high",
    baseInstructions: "Use tests."
  });
});

test("config and secret loading fail closed on untrusted files and registry ambiguity", () => {
  const fixture = configFixture();
  writeConfig(fixture);
  chmodSync(fixture.configPath, 0o640);
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_FILE_INVALID" });

  chmodSync(fixture.configPath, 0o600);
  const link = path.join(fixture.directory, "config-link.json");
  symlinkSync(fixture.configPath, link);
  assert.throws(() => loadHcoConfig({ configPath: link }), { code: "HCO_CONFIG_FILE_INVALID" });

  writeConfig(fixture, { unexpected: true });
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_INVALID" });

  writeConfig(fixture, {
    projects: [
      { projectId: "a", cwd: fixture.projectDirectory, staticStreamIds: [42], acl: { viewers: [], contributors: [], maintainers: [] } },
      { projectId: "b", cwd: fixture.project, staticStreamIds: [43], acl: { viewers: [], contributors: [], maintainers: [] } }
    ]
  });
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_INVALID" });

  writeFileSync(fixture.tokenPath, Buffer.alloc(32, 7), { mode: 0o600 });
  assert.deepEqual(loadOwnerSecret({ path: fixture.tokenPath }), Buffer.alloc(32, 7));
  chmodSync(fixture.tokenPath, 0o644);
  assert.throws(() => loadOwnerSecret({ path: fixture.tokenPath }), { code: "HCO_SECRET_FILE_INVALID" });
});

test("config requires an absolute Codex executable path", () => {
  const fixture = configFixture();
  const source = writeConfig(fixture);
  delete source.codexExecutablePath;
  writeFileSync(fixture.configPath, `${JSON.stringify(source)}\n`, { mode: 0o600 });
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_INVALID" });

  writeConfig(fixture, { codexExecutablePath: "bin/codex" });
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_INVALID" });
});

test("config rejects an empty model reasoning effort", () => {
  const fixture = configFixture();
  const source = writeConfig(fixture);
  source.projects[0].threadOptions.modelReasoningEffort = "";
  writeFileSync(fixture.configPath, `${JSON.stringify(source)}\n`, { mode: 0o600 });
  assert.throws(() => loadHcoConfig({ configPath: fixture.configPath }), { code: "HCO_CONFIG_INVALID" });
});

test("ACL grants are immutable, numeric-ID-only, and enforce responder membership", () => {
  const source = {
    admins: [1],
    projects: [{ projectId: "alpha", acl: { viewers: [2, 3], contributors: [3, 4], maintainers: [4] } }]
  };
  const acl = createAcl(source);
  source.admins.push(9);
  source.projects[0].acl.maintainers.push(9);

  assert.equal(acl.roleFor({ userId: 1, projectId: "alpha" }), "admin");
  assert.equal(acl.roleFor({ userId: 2, projectId: "alpha" }), "viewer");
  assert.equal(acl.roleFor({ userId: 3, projectId: "alpha" }), "contributor");
  assert.equal(acl.roleFor({ userId: 4, projectId: "alpha" }), "maintainer");
  assert.equal(acl.roleFor({ userId: 9, projectId: "alpha" }), null);
  assert.throws(() => acl.roleFor({ userId: 2, projectId: "alpha", role: "admin" }), { code: "ACL_REQUEST_INVALID" });
  assert.throws(() => acl.require({ userId: 2, projectId: "alpha", permission: "objective.create" }), { code: "ACL_FORBIDDEN" });
  assert.throws(() => acl.require({ userId: 3, projectId: "alpha", permission: "interaction.answer", responderIds: [4] }), { code: "ACL_FORBIDDEN" });
  assert.deepEqual(acl.require({ userId: 3, projectId: "alpha", permission: "interaction.answer", responderIds: [3] }), {
    userId: 3, projectId: "alpha", permission: "interaction.answer", role: "contributor"
  });
  assert.ok(Object.isFrozen(acl.require({ userId: 4, projectId: "alpha", permission: "route.manage" })));
});

test("numeric runtime routes override static routes and default exclusively to Hermes", () => {
  const resolver = createRouteResolver({
    projects: [{ projectId: "alpha", staticStreamIds: [42] }, { projectId: "beta", staticStreamIds: [43] }],
    runtimeRoutes: [
      { streamId: 42, kind: "hermes", projectId: null },
      { streamId: 44, kind: "project", projectId: "beta" }
    ]
  });
  assert.deepEqual(resolver.resolve(42), { streamId: 42, owner: "HERMES", projectId: null, source: "runtime" });
  assert.deepEqual(resolver.resolve(43), { streamId: 43, owner: "PROJECT", projectId: "beta", source: "static" });
  assert.deepEqual(resolver.resolve(44), { streamId: 44, owner: "PROJECT", projectId: "beta", source: "runtime" });
  assert.deepEqual(resolver.resolve(99), { streamId: 99, owner: "HERMES", projectId: null, source: "default" });
  assert.throws(() => resolver.resolve("engineering"), { code: "ROUTE_STREAM_INVALID" });
});

test("snapshot v1 is deterministic, owner-only, minimal, integrity checked, and stale snapshots fail closed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-snapshot-"));
  const snapshotPath = path.join(directory, "routes.json");
  const published = publishRouteSnapshot({
    snapshotPath,
    generation: 7,
    now: () => 1_000_000,
    ttlMs: 5_000,
    routes: [
      { streamId: 43, owner: "HERMES", projectId: null, source: "runtime", cwd: "/secret" },
      { streamId: 42, owner: "PROJECT", projectId: "alpha", source: "static", acl: [1] }
    ],
    topicModes: [
      { streamId: 42, topic: "zeta", mode: "CODEX_BOUND", objectiveId: "hidden", threadId: "hidden" },
      { streamId: 42, topic: "alpha", mode: "HERMES_ONLY" },
      { streamId: 42, topic: "auto", mode: "AUTO" }
    ]
  });
  const bytes = readFileSync(snapshotPath);
  assert.equal(bytes.at(-1), 10);
  assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
  assert.equal(published.bytes, bytes.length);
  const validated = validateRouteSnapshot(bytes, { now: () => 1_001_000 });
  assert.deepEqual(validated.routes.map((route) => route.streamId), [42, 43]);
  assert.deepEqual(validated.routes[0].topics, [
    { topic: "alpha", mode: "HERMES_ONLY" },
    { topic: "zeta", mode: "CODEX_BOUND" }
  ]);
  assert.equal(bytes.includes(Buffer.from("/secret")), false);
  assert.equal(bytes.includes(Buffer.from("hidden")), false);
  assert.ok(Object.isFrozen(validated.routes[0].topics));
  assert.ok(Object.isFrozen(validated.routes[0]));
  assert.ok(Object.isFrozen(validated.integrity));

  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.indexOf(Buffer.from("alpha"))] ^= 1;
  assert.throws(() => validateRouteSnapshot(corrupt, { now: () => 1_001_000 }), { code: "ROUTE_SNAPSHOT_INVALID" });
  assert.throws(() => validateRouteSnapshot(bytes, { now: () => 1_005_001 }), { code: "ROUTE_SNAPSHOT_STALE" });
});

test("snapshot v1 rejects nested extras, invalid project IDs, and topics outside the UTF-8 boundary", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-snapshot-nested-"));
  const snapshotPath = path.join(directory, "routes.json");
  publishRouteSnapshot({
    snapshotPath,
    generation: 1,
    now: () => 1_000_000,
    ttlMs: 5_000,
    routes: [{ streamId: 42, owner: "PROJECT", projectId: "alpha", source: "static" }],
    topicModes: [{ streamId: 42, topic: "Build", mode: "HERMES_ONLY" }]
  });
  const valid = readFileSync(snapshotPath);
  assert.equal(
    validateRouteSnapshot(valid, { now: () => 1_001_000 }).routes[0].projectId,
    "alpha"
  );

  const invalidMutations = [
    (snapshot) => { snapshot.routes[0].cwd = "/secret"; },
    (snapshot) => { snapshot.integrity.token = "secret"; },
    (snapshot) => { snapshot.routes[0].projectId = ""; },
    (snapshot) => { snapshot.routes[0].projectId = 123; },
    (snapshot) => { snapshot.routes[0].projectId = true; },
    (snapshot) => { snapshot.routes[0].projectId = null; },
    (snapshot) => { snapshot.routes[0].projectId = ["alpha"]; },
    (snapshot) => { snapshot.routes[0].projectId = { value: "alpha" }; },
    (snapshot) => { snapshot.routes[0].topics[0].topic = ""; },
    (snapshot) => { snapshot.routes[0].topics[0].topic = "x".repeat(257); }
  ];
  for (const mutate of invalidMutations) {
    assert.throws(
      () => validateRouteSnapshot(snapshotMutation(valid, mutate), { now: () => 1_001_000 }),
      { code: "ROUTE_SNAPSHOT_INVALID" }
    );
  }

  const boundary = snapshotMutation(valid, (snapshot) => {
    snapshot.routes[0].topics[0].topic = "x".repeat(256);
  });
  assert.equal(validateRouteSnapshot(boundary, { now: () => 1_001_000 }).routes[0].topics[0].topic.length, 256);
});

test("snapshot topic ordering is exact UTF-8 byte order and independent of host locale", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-snapshot-order-"));
  const snapshotPath = path.join(directory, "routes.json");
  publishRouteSnapshot({
    snapshotPath,
    generation: 1,
    now: () => 1_000_000,
    ttlMs: 5_000,
    routes: [{ streamId: 42, owner: "PROJECT", projectId: "alpha", source: "static" }],
    topicModes: [
      { streamId: 42, topic: "\u00e4", mode: "HERMES_ONLY" },
      { streamId: 42, topic: "z", mode: "CODEX_BOUND" }
    ]
  });

  const validated = validateRouteSnapshot(readFileSync(snapshotPath), { now: () => 1_001_000 });
  assert.deepEqual(validated.routes[0].topics, [
    { topic: "z", mode: "CODEX_BOUND" },
    { topic: "\u00e4", mode: "HERMES_ONLY" }
  ]);
});

test("snapshot publication completes repeated short writes before rename", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-snapshot-write-"));
  const snapshotPath = path.join(directory, "routes.json");
  const writes = [];
  publishRouteSnapshot({
    snapshotPath,
    generation: 1,
    now: () => 1_000_000,
    ttlMs: 5_000,
    routes: [{ streamId: 42, owner: "PROJECT", projectId: "alpha", source: "static" }],
    topicModes: [],
    write(descriptor, bytes, offset, length) {
      const shortLength = Math.min(length, 7);
      writes.push({ offset, length: shortLength });
      return writeSync(descriptor, bytes, offset, shortLength);
    }
  });

  const bytes = readFileSync(snapshotPath);
  assert.ok(writes.length > 1);
  assert.deepEqual(writes.map(({ offset }) => offset), writes.map((_, index) => index * 7));
  assert.doesNotThrow(() => validateRouteSnapshot(bytes, { now: () => 1_001_000 }));
});

function storeFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-control-store-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: 1_700_000_000_000 };
  const counts = new Map();
  const store = openStore({
    databasePath,
    now: () => clock.value,
    idFactory: (kind) => {
      const value = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, value);
      return `${kind}-${value}`;
    }
  });
  t.after(() => store.close());
  return { clock, databasePath, store };
}

test("v5 control-plane migration is contiguous and preserves v4 migration history", (t) => {
  const { databasePath } = storeFixture(t);
  const db = new Database(databasePath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.at(-1).version);
  assert.equal(MIGRATIONS.at(-1).version, MIGRATIONS.at(-2).version + 1);
  assert.deepEqual(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 5").get(), {
    version: 5,
    name: "route_acl_control_plane"
  });
  for (const table of [
    "control_plane_meta", "static_registry_meta", "static_stream_routes", "runtime_stream_routes",
    "topic_aliases", "topic_modes", "objective_projects", "execution_topic_intents"
  ]) {
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM interaction_answer_settlements").get().count, 0);
  assert.ok(db.prepare("PRAGMA table_info(pending_interactions)").all().some((column) => column.name === "partial_answers_json"));
});

test("route commands are transactional, idempotent, generation-counted, and clear topic selections", (t) => {
  const { store } = storeFixture(t);
  assert.deepEqual(store.readControlGeneration(), { generation: 0, updatedAt: 0 });
  const first = store.applyRouteCommand({
    sourceType: "zulip-message", sourceId: "1", streamId: 42, action: "SET", projectId: "alpha", actorUserId: 4
  });
  assert.equal(first.changed, true);
  assert.deepEqual(store.getRuntimeRoute(42), {
    streamId: 42, kind: "project", projectId: "alpha", actorUserId: 4,
    sourceType: "zulip-message", sourceId: "1", updatedAt: 1_700_000_000_000
  });
  assert.equal(store.readControlGeneration().generation, 1);
  assert.equal(store.applyRouteCommand({
    sourceType: "zulip-message", sourceId: "1", streamId: 42, action: "SET", projectId: "alpha", actorUserId: 4
  }).duplicate, true);
  assert.throws(() => store.applyRouteCommand({
    sourceType: "zulip-message", sourceId: "1", streamId: 43, action: "NONE", actorUserId: 4
  }), { code: "CONTROL_SOURCE_CONFLICT" });

  store.setUserTopicMode({
    sourceType: "zulip-message", sourceId: "2", streamId: 42, topic: "Build", projectId: "alpha",
    mode: "HERMES_ONLY", actorUserId: 4
  });
  assert.equal(store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
  assert.equal(store.readControlGeneration().generation, 2);
  store.applyRouteCommand({
    sourceType: "zulip-message", sourceId: "3", streamId: 42, action: "NONE", actorUserId: 4
  });
  assert.deepEqual(store.readTopicState({ streamId: 42, topic: "Build" }), {
    streamId: 42, topic: "Build", mode: "AUTO", projectId: null, objectiveId: null, threadId: null
  });
  assert.equal(store.listSnapshotTopicModes().length, 0);
  assert.equal(store.readControlGeneration().generation, 3);
});

test("trusted execution registration immutably binds project and atomically promotes a real thread", (t) => {
  const { store } = storeFixture(t);
  const options = {
    sourceType: "zulip-message",
    sourceId: "10",
    objectiveId: "objective-alpha",
    projectId: "alpha",
    backend: "app-server",
    text: "Implement it.",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 10 },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  };
  const registered = store.registerExecutionIntent(options);
  assert.equal(registered.needsObjectiveStart, true);
  assert.equal(store.readObjectiveProject("objective-alpha"), "alpha");
  assert.equal(store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");
  assert.equal(store.readControlGeneration().generation, 0);

  const bound = store.bindBackendObjective({ objectiveId: "objective-alpha", backend: "app-server", threadId: "thread-real" });
  assert.equal(bound.threadId, "thread-real");
  assert.deepEqual(store.readTopicState({ streamId: 42, topic: "Build" }), {
    streamId: 42, topic: "Build", mode: "CODEX_BOUND", projectId: "alpha", objectiveId: "objective-alpha", threadId: "thread-real"
  });
  assert.equal(store.readCurrentTopicObjective({ streamId: 42, topic: "Build", projectId: "alpha" }), "objective-alpha");
  assert.equal(store.readControlGeneration().generation, 1);

  assert.throws(() => store.registerExecutionIntent({ ...options, sourceId: "11", projectId: "beta" }), {
    code: "OBJECTIVE_PROJECT_CONFLICT"
  });
});

function serviceFixture(t, {
  modelCatalog,
  modelCatalogTtlMs,
  projectCwdAlpha = "/canonical/alpha",
  reconcileResult,
  snapshotPublisher,
  turnControllerFactory,
  snapshotTtlMs = 60_000
} = {}) {
  const fixture = storeFixture(t);
  const calls = { accept: [], continue: [], bind: [], cancel: [], answer: [], interaction: [], completion: [], reconcile: [] };
  const config = Object.freeze({
    version: 1,
    databasePath: fixture.databasePath,
    bridge: Object.freeze({
      tokenPath: "/tmp/hco-token",
      contextKeyPath: "/tmp/hco-context-key",
      socketPath: "/tmp/hco.sock",
      routeSnapshotPath: "/tmp/hco-routes.json"
    }),
    snapshot: Object.freeze({ ttlMs: snapshotTtlMs, maxBytes: 262_144 }),
    admins: Object.freeze([1]),
    projects: Object.freeze([
      Object.freeze({
        projectId: "alpha", cwd: projectCwdAlpha, backend: "app-server",
        staticStreamIds: Object.freeze([42]),
        acl: Object.freeze({ viewers: Object.freeze([2]), contributors: Object.freeze([3]), maintainers: Object.freeze([4]) }),
        threadOptions: Object.freeze({ model: "gpt-5", modelReasoningEffort: "high", baseInstructions: "Use tests." })
      }),
      Object.freeze({
        projectId: "beta", cwd: "/canonical/beta", backend: "app-server",
        staticStreamIds: Object.freeze([43]),
        acl: Object.freeze({ viewers: Object.freeze([6]), contributors: Object.freeze([7]), maintainers: Object.freeze([5]) }),
        threadOptions: Object.freeze({ approvalPolicy: "never" })
      })
    ])
  });
  const fakeTurnController = Object.freeze({
    async acceptIntent(options) {
      calls.accept.push(options);
      return Object.freeze({
        status: "started", objectiveId: options.objectiveId, submissionId: `submission-${calls.accept.length}`,
        threadId: `thread-${calls.accept.length}`, turnId: `turn-${calls.accept.length}`
      });
    },
    async continueObjective(options) {
      calls.continue.push(options);
      return Object.freeze({
        status: "started", objectiveId: options.objectiveId, submissionId: `continuation-${calls.continue.length}`,
        threadId: "thread-existing", turnId: `continued-turn-${calls.continue.length}`
      });
    },
    async resolveObjectiveThread(options) {
      calls.bind.push(options);
      return Object.freeze({
        status: "started", objectiveId: options.objectiveId, submissionId: "submission-bound",
        clientUserMessageId: "client-bound", threadId: options.threadId, turnId: "turn-bound", duplicate: false
      });
    },
    async cancelObjective(options) {
      calls.cancel.push(options);
      return Object.freeze({ status: "cancelled", objectiveId: options.objectiveId, turnId: "turn-active" });
    },
    async answerInteraction(options) {
      calls.answer.push(options);
      return Object.freeze({ status: "answered", objectiveId: "objective-alpha", interactionId: options.interactionId });
    },
    async handleInteractionRequest(options) {
      calls.interaction.push(options);
      return Object.freeze({ status: "pending", objectiveId: options.objectiveId });
    },
    async handleTurnCompleted(options) {
      calls.completion.push(options);
      return Object.freeze({ status: "completed", objectiveId: options.objectiveId });
    },
    async reconcileObjective(options) {
      calls.reconcile.push(options);
      const result = typeof reconcileResult === "function"
        ? reconcileResult(options)
        : reconcileResult;
      return Object.freeze(result ?? {
        status: "running", objectiveId: options.objectiveId, turnId: "turn-active"
      });
    }
  });
  let objectiveSequence = 0;
  const key = Buffer.alloc(32, 19);
  const turnController = turnControllerFactory?.(fixture.store) ?? fakeTurnController;
  const service = createHcoService({
    config,
    store: fixture.store,
    turnController,
    contextKey: key,
    now: () => fixture.clock.value,
    idFactory: (kind) => `${kind}-service-${++objectiveSequence}`,
    snapshotPublisher: snapshotPublisher ?? (() => Object.freeze({ generation: fixture.store.readControlGeneration().generation })),
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    ...(modelCatalogTtlMs === undefined ? {} : { modelCatalogTtlMs })
  });
  function event({ kind = "COMMAND", body, streamId = 42, topic = "Build", sourceMessageId, senderId = 1, extra = {} }) {
    const binding = { streamId, topic, sourceMessageId, senderId };
    const seconds = Math.floor(fixture.clock.value / 1000);
    return {
      schemaVersion: 1,
      kind,
      contextToken: signContext({
        version: 1, issuedAt: seconds - 1, expiresAt: seconds + 60,
        nonce: `nonce-${sourceMessageId}`, binding
      }, key),
      binding,
      [kind === "COMMAND" ? "command" : "semantic"]: body,
      ...extra
    };
  }
  return { ...fixture, calls, config, event, key, service };
}

function sampleCatalogModel(overrides = {}) {
  return {
    id: "gpt-catalog",
    model: "gpt-catalog",
    displayName: "GPT Catalog",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    serviceTiers: ["default"],
    defaultServiceTier: "default",
    isDefault: true,
    ...overrides
  };
}

test("model catalog listing is read-only, immutable, cached, and TTL scoped", async (t) => {
  const sourceCalls = [];
  const model = sampleCatalogModel();
  const fixture = serviceFixture(t, {
    modelCatalogTtlMs: 1_000,
    modelCatalog: Object.freeze({
      async listModels(options) {
        sourceCalls.push(options);
        return { data: [model], nextCursor: null };
      }
    })
  });

  const first = await fixture.service.listModels({ includeHidden: true, limit: 50 });
  assert.deepEqual(first, {
    schemaVersion: 1,
    status: "ok",
    action: "models.list",
    sourceStatus: "ok",
    cached: false,
    stale: false,
    fetchedAt: fixture.clock.value,
    expiresAt: fixture.clock.value + 1_000,
    models: [model],
    nextCursor: null
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.models), true);
  assert.equal(Object.isFrozen(first.models[0]), true);
  assert.deepEqual(sourceCalls, [{ includeHidden: true, limit: 50 }]);

  fixture.clock.value += 999;
  const second = await fixture.service.listModels({ includeHidden: true, limit: 50 });
  assert.equal(second.cached, true);
  assert.equal(second.stale, false);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.deepEqual(sourceCalls, [{ includeHidden: true, limit: 50 }]);

  fixture.clock.value += 2;
  const third = await fixture.service.listModels({ includeHidden: true, limit: 50 });
  assert.equal(third.cached, false);
  assert.equal(third.fetchedAt, fixture.clock.value);
  assert.deepEqual(sourceCalls, [
    { includeHidden: true, limit: 50 },
    { includeHidden: true, limit: 50 }
  ]);
});

test("model catalog returns stale cache on source failure and fails closed without cache", async (t) => {
  let fail = false;
  const sourceCalls = [];
  const fixture = serviceFixture(t, {
    modelCatalogTtlMs: 1,
    modelCatalog: Object.freeze({
      async listModels(options) {
        sourceCalls.push(options);
        if (fail) throw new Error("private model catalog outage");
        return { data: [sampleCatalogModel({ id: "gpt-stale", model: "gpt-stale" })], nextCursor: null };
      }
    })
  });

  const first = await fixture.service.listModels();
  fixture.clock.value += 2;
  fail = true;
  const stale = await fixture.service.listModels();
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.sourceStatus, "unavailable");
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.deepEqual(stale.models, first.models);
  assert.deepEqual(sourceCalls, [{}, {}]);

  const unavailable = serviceFixture(t, {
    modelCatalog: Object.freeze({
      async listModels() { throw new Error("private first fetch failure"); }
    })
  });
  await assert.rejects(() => unavailable.service.listModels(), {
    code: "MODEL_CATALOG_UNAVAILABLE",
    message: "Codex model catalog is unavailable."
  });
});

test("model catalog validates options and rejects calls after service close", async (t) => {
  const fixture = serviceFixture(t, {
    modelCatalog: Object.freeze({
      async listModels() { return { data: [], nextCursor: null }; }
    })
  });

  await assert.rejects(() => fixture.service.listModels({ limit: 0 }), { code: "MODEL_LIST_OPTIONS_INVALID" });
  await assert.rejects(() => fixture.service.listModels({ includeHidden: "yes" }), { code: "MODEL_LIST_OPTIONS_INVALID" });
  await fixture.service.close();
  await assert.rejects(() => fixture.service.listModels(), { code: "HCO_SERVICE_CLOSED" });
});

function registryConfig(databasePath, assignments) {
  const project = (projectId) => Object.freeze({
    projectId,
    cwd: `/canonical/${projectId}`,
    backend: "app-server",
    staticStreamIds: Object.freeze([...(assignments[projectId] ?? [])]),
    acl: Object.freeze({ viewers: Object.freeze([]), contributors: Object.freeze([]), maintainers: Object.freeze([]) }),
    threadOptions: Object.freeze({})
  });
  return Object.freeze({
    version: 1,
    databasePath,
    bridge: Object.freeze({
      tokenPath: "/tmp/hco-token",
      contextKeyPath: "/tmp/hco-context-key",
      socketPath: "/tmp/hco.sock",
      routeSnapshotPath: "/tmp/hco-routes.json"
    }),
    snapshot: Object.freeze({ ttlMs: 60_000, maxBytes: 262_144 }),
    admins: Object.freeze([1]),
    projects: Object.freeze([project("alpha"), project("beta")])
  });
}

const registryTurnController = Object.freeze({
  async acceptIntent() { throw new Error("unexpected execution"); },
  async continueObjective() { throw new Error("unexpected continuation"); },
  async resolveObjectiveThread() { throw new Error("unexpected binding"); },
  async cancelObjective() { throw new Error("unexpected cancellation"); },
  async answerInteraction() { throw new Error("unexpected answer"); },
  async handleInteractionRequest() { throw new Error("unexpected interaction"); },
  async handleTurnCompleted() { throw new Error("unexpected completion"); }
});

async function withRegistryRestart({ databasePath, assignments, clock }, use) {
  const store = openStore({ databasePath, now: () => clock.value });
  const service = createHcoService({
    config: registryConfig(databasePath, assignments),
    store,
    turnController: registryTurnController,
    contextKey: Buffer.alloc(32, 23),
    now: () => clock.value,
    snapshotPublisher: ({ generation }) => Object.freeze({ generation })
  });
  try {
    await service.start();
    return await use({ service, store });
  } finally {
    await service.close();
    store.close();
  }
}

test("static registry synchronization tracks current A-B-A, add, and remove transitions across restarts", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-static-registry-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: 1_700_000_000_000 };
  let source = 0;
  let generation;

  await withRegistryRestart({ databasePath, assignments: { alpha: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, 1);
    store.setUserTopicMode({
      sourceType: "test", sourceId: `topic-${++source}`, streamId: 42, topic: "Build",
      projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 1
    });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { alpha: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
  });

  await withRegistryRestart({ databasePath, assignments: { beta: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation + 1);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");
    store.setUserTopicMode({
      sourceType: "test", sourceId: `topic-${++source}`, streamId: 42, topic: "Build",
      projectId: "beta", mode: "HERMES_ONLY", actorUserId: 1
    });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { alpha: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation + 1);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");
    store.setUserTopicMode({
      sourceType: "test", sourceId: `topic-${++source}`, streamId: 43, topic: "Added",
      projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 1
    });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { alpha: [42, 43] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation + 1);
    assert.equal(store.readTopicState({ streamId: 43, topic: "Added" }).mode, "AUTO");
    store.setUserTopicMode({
      sourceType: "test", sourceId: `topic-${++source}`, streamId: 43, topic: "Removed",
      projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 1
    });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { alpha: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation + 1);
    assert.equal(store.readTopicState({ streamId: 43, topic: "Removed" }).mode, "AUTO");
    const db = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT initialized, revision FROM static_registry_meta WHERE singleton = 1
      `).get(), { initialized: 1, revision: 5 });
      const evidence = db.prepare(`
        SELECT source_id, payload_json FROM event_journal
        WHERE source_type = 'hco-static-registry' ORDER BY ingestion_seq
      `).all();
      assert.equal(evidence.length, 5);
      assert.ok(evidence.every((row) => Buffer.byteLength(row.source_id, "utf8") < 128));
      assert.ok(evidence.every((row) => !row.payload_json.includes("/canonical/")));
    } finally {
      db.close();
    }
  });
});

test("static registry changes hidden by a runtime override persist without generation or topic cleanup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-static-hidden-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: 1_700_000_000_000 };
  let generation;

  await withRegistryRestart({ databasePath, assignments: { alpha: [42] }, clock }, ({ store }) => {
    store.applyRouteCommand({
      sourceType: "test", sourceId: "runtime-hidden", streamId: 42,
      action: "SET", projectId: "alpha", actorUserId: 1
    });
    store.setUserTopicMode({
      sourceType: "test", sourceId: "topic-hidden-only", streamId: 42, topic: "Hidden",
      projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 1
    });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { beta: [42] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Hidden" }).mode, "HERMES_ONLY");
    const db = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT stream_id, project_id FROM static_stream_routes").get(), {
        stream_id: 42,
        project_id: "beta"
      });
    } finally {
      db.close();
    }
  });
});

test("static registry synchronization respects runtime effective routes and clears both topic modes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hco-static-effective-"));
  const databasePath = path.join(directory, "authority.sqlite3");
  const clock = { value: 1_700_000_000_000 };
  let generation;

  await withRegistryRestart({ databasePath, assignments: { alpha: [42, 43] }, clock }, ({ store }) => {
    store.applyRouteCommand({
      sourceType: "test", sourceId: "runtime-alpha", streamId: 42,
      action: "SET", projectId: "alpha", actorUserId: 1
    });
    store.setUserTopicMode({
      sourceType: "test", sourceId: "topic-hidden", streamId: 42, topic: "Hidden",
      projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 1
    });
    store.registerExecutionIntent({
      sourceType: "test", sourceId: "codex-intent", objectiveId: "objective-codex", projectId: "alpha",
      backend: "app-server", text: "seed", targetSnapshot: {
        platform: "zulip", streamId: 43, topic: "Codex", sourceMessageId: 1
      },
      topicBinding: { streamId: 43, topic: "Codex", actorUserId: 1 }
    });
    store.bindBackendObjective({ objectiveId: "objective-codex", backend: "app-server", threadId: "thread-codex" });
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { beta: [42, 43] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation + 1);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Hidden" }).mode, "HERMES_ONLY");
    assert.equal(store.readTopicState({ streamId: 43, topic: "Codex" }).mode, "AUTO");
    const db = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT stream_id, project_id FROM static_stream_routes ORDER BY stream_id").all(), [
        { stream_id: 42, project_id: "beta" },
        { stream_id: 43, project_id: "beta" }
      ]);
    } finally {
      db.close();
    }
    generation = store.readControlGeneration().generation;
  });

  await withRegistryRestart({ databasePath, assignments: { beta: [42, 43] }, clock }, ({ store }) => {
    assert.equal(store.readControlGeneration().generation, generation);
    assert.equal(store.readTopicState({ streamId: 42, topic: "Hidden" }).mode, "HERMES_ONLY");
  });
});

function seedAppServerAdapterContext(fixture) {
  const targetSnapshot = Object.freeze({
    platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 901
  });
  fixture.store.registerExecutionIntent({
    sourceType: "test", sourceId: "adapter-context", objectiveId: "objective-adapter", projectId: "alpha",
    backend: "app-server", text: "seed", targetSnapshot,
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  fixture.store.bindBackendObjective({
    objectiveId: "objective-adapter", backend: "app-server", threadId: "thread-adapter"
  });
  const prepared = fixture.store.prepareTurnSubmission({
    sourceType: "test", sourceId: "adapter-context", objectiveId: "objective-adapter",
    text: "seed", targetSnapshot, leaseOwner: "service-test"
  });
  fixture.store.acknowledgeTurnSubmission({
    submissionId: prepared.submission.submissionId, turnId: "turn-adapter"
  });
  return targetSnapshot;
}

test("App Server reverse requests derive delivery and responder authority from durable state and config", async (t) => {
  const fixture = serviceFixture(t);
  const targetSnapshot = seedAppServerAdapterContext(fixture);
  const params = {
    threadId: "thread-adapter", turnId: "turn-adapter", itemId: "item-1", approvalId: "approval-1",
    objectiveId: "objective-forged", projectId: "beta", allowedResponderIds: [999],
    targetSnapshot: { platform: "zulip", streamId: 999, topic: "Forged", sourceMessageId: 999 }
  };

  await fixture.service.handleAppServerRequest({
    connectionId: "connection-1",
    message: { id: 41, method: "item/commandExecution/requestApproval", params }
  });

  assert.deepEqual(fixture.calls.interaction, [{
    connectionId: "connection-1", wireRequestId: 41,
    method: "item/commandExecution/requestApproval", objectiveId: "objective-adapter",
    threadId: "thread-adapter", turnId: "turn-adapter", itemId: "item-1", approvalId: "approval-1",
    request: params, allowedResponderIds: [3, 4, 1], targetSnapshot
  }]);
});

test("App Server reverse requests reject malformed or unknown durable correlation without controller calls", async (t) => {
  const fixture = serviceFixture(t);
  seedAppServerAdapterContext(fixture);

  await assert.rejects(
    () => fixture.service.handleAppServerRequest({ connectionId: "connection-1", message: { id: 1, method: "unknown", params: {} } }),
    { code: "APP_SERVER_REQUEST_INVALID" }
  );
  await assert.rejects(
    () => fixture.service.handleAppServerRequest({
      connectionId: "connection-1",
      message: { id: 2, method: "item/tool/requestUserInput", params: { threadId: "thread-adapter", turnId: "turn-missing" } }
    }),
    { code: "APP_SERVER_TURN_CONTEXT_UNKNOWN" }
  );
  assert.deepEqual(fixture.calls.interaction, []);
});

test("turn completion derives objective and a stable bounded source identity from durable correlation", async (t) => {
  const fixture = serviceFixture(t);
  seedAppServerAdapterContext(fixture);
  const turn = { id: "turn-adapter", status: "completed", items: [], objectiveId: "objective-forged" };

  await fixture.service.handleAppServerNotification({
    message: { method: "turn/completed", params: { threadId: "thread-adapter", turn, projectId: "beta" } }
  });

  assert.equal(fixture.calls.completion.length, 1);
  assert.equal(fixture.calls.completion[0].objectiveId, "objective-adapter");
  assert.equal(fixture.calls.completion[0].turn, turn);
  assert.equal(fixture.calls.completion[0].sourceType, "app-server");
  assert.match(fixture.calls.completion[0].sourceId, /^app-server-turn-sha256:[a-f0-9]{64}$/);
});

test("turn completion rejects malformed or mismatched durable correlation without controller calls", async (t) => {
  const fixture = serviceFixture(t);
  seedAppServerAdapterContext(fixture);

  await assert.rejects(
    () => fixture.service.handleAppServerNotification({ message: { method: "other", params: {} } }),
    { code: "APP_SERVER_NOTIFICATION_INVALID" }
  );
  await assert.rejects(
    () => fixture.service.handleAppServerNotification({
      message: { method: "turn/completed", params: { threadId: "thread-missing", turn: { id: "turn-adapter" } } }
    }),
    { code: "APP_SERVER_TURN_CONTEXT_UNKNOWN" }
  );
  assert.deepEqual(fixture.calls.completion, []);
});

test("bridge events validate exact fields, verify signed numeric bindings, and reject replay before execution", async (t) => {
  const fixture = serviceFixture(t);
  const valid = fixture.event({ sourceMessageId: 100, senderId: 2, body: { type: "ROUTE", action: "SHOW" } });
  assert.deepEqual(await fixture.service.handleBridgeEvent(valid), {
    schemaVersion: 1, status: "ok", action: "route.show",
    route: {
      streamId: 42, owner: "PROJECT", projectId: "alpha", source: "static",
      cwd: "/canonical/alpha"
    }
  });
  assert.equal(Object.isFrozen(await fixture.service.handleBridgeEvent(
    fixture.event({ sourceMessageId: 101, senderId: 2, body: { type: "TOPIC", action: "SHOW" } })
  )), true);
  await assert.rejects(() => fixture.service.handleBridgeEvent(valid), { code: "CONTEXT_NONCE_REPLAYED" });

  await assert.rejects(() => fixture.service.handleBridgeEvent(
    fixture.event({ sourceMessageId: 102, senderId: 2, body: { type: "RUN", instruction: "work", cwd: "/forged" } })
  ), { code: "BRIDGE_EVENT_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(
    fixture.event({ sourceMessageId: 103, senderId: 2, body: { type: "ROUTE", action: "SHOW" }, extra: { role: "admin" } })
  ), { code: "BRIDGE_EVENT_INVALID" });

  const mismatch = fixture.event({ sourceMessageId: 104, senderId: 2, body: { type: "ROUTE", action: "SHOW" } });
  mismatch.binding = { ...mismatch.binding, streamId: 43 };
  await assert.rejects(() => fixture.service.handleBridgeEvent(mismatch), { code: "CONTEXT_BINDING_MISMATCH" });
  assert.deepEqual(fixture.calls, {
    accept: [], continue: [], bind: [], cancel: [], answer: [], interaction: [], completion: [], reconcile: []
  });
});

test("numeric route and topic commands enforce affected-project ACLs and publish committed generations", async (t) => {
  const publications = [];
  const fixture = serviceFixture(t, {
    snapshotPublisher: (options) => (publications.push(options), { generation: options.generation })
  });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 110, senderId: 4,
    body: { type: "ROUTE", action: "SET", projectId: "beta" }
  })), { code: "ACL_FORBIDDEN" });
  assert.equal(fixture.store.getRuntimeRoute(42), null);

  const set = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 111, senderId: 1,
    body: { type: "ROUTE", action: "SET", projectId: "beta" }
  }));
  assert.equal(set.action, "route.set");
  assert.equal(set.route.projectId, "beta");
  assert.equal(publications.at(-1).generation, 1);

  assert.deepEqual(await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 112, senderId: 5,
    body: { type: "TOPIC", action: "HERMES" }
  })), { schemaVersion: 1, status: "ok", action: "topic.set", mode: "HERMES_ONLY" });
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
  assert.equal(publications.at(-1).generation, 2);

  const none = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 113, senderId: 5,
    body: { type: "ROUTE", action: "NONE" }
  }));
  assert.equal(none.route.owner, "HERMES");
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");
  assert.equal(publications.at(-1).generation, 3);
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 114, senderId: 5,
    body: { type: "TOPIC", action: "AUTO" }
  })), { code: "ROUTE_HERMES_OWNED" });
  assert.deepEqual(fixture.calls.accept, []);
});

test("exact and semantic dispatch select objectives lazily and build only registered execution options", async (t) => {
  const fixture = serviceFixture(t);
  const exact = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 120, senderId: 3,
    body: { type: "RUN", instruction: "Implement the parser." }
  }));
  assert.equal(exact.action, "dispatch");
  assert.equal(fixture.calls.accept.length, 1);
  assert.deepEqual(fixture.calls.accept[0], {
    sourceType: "zulip-message", sourceId: "120", objectiveId: "objective-service-1",
    projectId: "alpha", backend: "app-server", text: "Implement the parser.",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 120 },
    threadOptions: {
      model: "gpt-5",
      modelReasoningEffort: "high",
      baseInstructions: "Use tests.",
      cwd: "/canonical/alpha"
    },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });

  const semantic = await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 121, senderId: 3,
    body: {
      type: "DISPATCH",
      instruction: "Compare with beta at /canonical/beta, then ship it.",
      constraints: ["Keep compatibility."],
      acceptanceCriteria: ["Focused tests pass."],
      reminders: ["Do not retry uncertain writes."],
      objective: { mode: "NEW" },
      topicModeAction: null
    }
  }));
  assert.equal(semantic.action, "dispatch");
  assert.equal(fixture.calls.accept.length, 2);
  assert.equal(fixture.calls.accept[1].text,
    "Instruction:\nCompare with beta at /canonical/beta, then ship it.\n\nConstraints:\n- Keep compatibility.\n\nAcceptance criteria:\n- Focused tests pass.\n\nReminders:\n- Do not retry uncertain writes.");
  assert.equal(fixture.calls.accept[1].projectId, "alpha");
  assert.equal(fixture.calls.accept[1].threadOptions.cwd, "/canonical/alpha");
  assert.equal(Object.hasOwn(fixture.calls.accept[1], "role"), false);
});

test("semantic dispatch stages caller artifacts into a project-local exchange before execution", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-artifact-project-"));
  mkdirSync(path.join(projectDirectory, "docs"));
  const requestPath = path.join(projectDirectory, "docs", "request.md");
  const requestText = "# Request\nShip the artifact protocol.\n";
  writeFileSync(requestPath, requestText);
  const requestSha256 = createHash("sha256").update(requestText, "utf8").digest("hex");
  const fixture = serviceFixture(t, { projectCwdAlpha: projectDirectory });

  const result = await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 122, senderId: 3,
    body: {
      type: "DISPATCH",
      instruction: "Read the request and write the result.",
      constraints: [],
      acceptanceCriteria: ["The result artifact is written."],
      reminders: [],
      objective: { mode: "NEW" },
      topicModeAction: null,
      artifacts: {
        input: [{
          artifactId: "request",
          path: "docs/request.md",
          kind: "document",
          mimeType: "text/markdown",
          sha256: requestSha256,
          maxBytes: 1024
        }],
        output: [{
          artifactId: "result",
          kind: "document",
          mimeType: "text/markdown",
          maxBytes: 2048,
          required: true
        }]
      }
    }
  }));

  assert.equal(result.action, "dispatch");
  assert.equal(fixture.calls.accept.length, 1);
  assert.match(fixture.calls.accept[0].text, /\.hco\/exchanges\/v1\/objective-service-1\/exchange-service-2\/input\/context\.md/u);
  assert.match(fixture.calls.accept[0].text, /output\/result\.md/u);
  assert.doesNotMatch(fixture.calls.accept[0].text, /docs\/request\.md|docs\/result\.md/u);
  assert.equal(fixture.calls.accept[0].artifactMode, "project_local");
  assert.equal(fixture.calls.accept[0].artifactBaseDir, projectDirectory);
  assert.deepEqual(fixture.calls.accept[0].artifacts.input.map((entry) => entry.artifactId), [
    "hco-context",
    "hco-task-contract"
  ]);
  assert.equal(
    fixture.calls.accept[0].artifacts.output[0].path,
    ".hco/exchanges/v1/objective-service-1/exchange-service-2/output/result.md"
  );
  const exchangeRoot = path.join(
    projectDirectory,
    ".hco", "exchanges", "v1", "objective-service-1", "exchange-service-2"
  );
  assert.match(readFileSync(path.join(exchangeRoot, "input", "context.md"), "utf8"), /Ship the artifact protocol\./u);
  assert.doesNotMatch(
    readFileSync(path.join(exchangeRoot, "input", "task-contract.json"), "utf8"),
    /docs\/request\.md|docs\/result\.md/u
  );
});

test("project-local semantic dispatch crosses the production controller gate without enabling legacy paths", async (t) => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "hco-project-local-service-controller-"));
  const sourceText = "trusted source\n";
  writeFileSync(path.join(projectDirectory, "source.md"), sourceText);
  const backendCalls = [];
  const fixture = serviceFixture(t, {
    projectCwdAlpha: projectDirectory,
    turnControllerFactory(store) {
      const appServerBackend = {
        async startObjective() { return { threadId: "thread-project-local" }; },
        async startTurn(options) {
          backendCalls.push(options);
          return { turnId: "turn-project-local" };
        },
        async interruptTurn() { return { ok: true }; },
        async readObjective() { return { thread: { id: "thread-project-local", turns: [] } }; },
        async reconcileObjective() { return { thread: { id: "thread-project-local", turns: [] } }; },
        async respondToInteraction() {},
        getCapabilities() {
          return { backend: "app-server", durableThreadContinuity: true, reverseInteractions: true };
        }
      };
      return new TurnController({ store, appServerBackend, leaseOwner: "project-local-controller" });
    }
  });

  const result = await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 129, senderId: 3,
    body: {
      type: "DISPATCH",
      instruction: "Read the staged source.",
      constraints: [],
      acceptanceCriteria: [],
      reminders: [],
      objective: { mode: "NEW" },
      topicModeAction: null,
      artifacts: {
        input: [{
          artifactId: "source",
          path: "source.md",
          kind: "document",
          mimeType: "text/markdown",
          maxBytes: 1024,
          sha256: createHash("sha256").update(sourceText).digest("hex")
        }],
        output: []
      }
    }
  }));

  assert.equal(result.status, "accepted");
  assert.equal(backendCalls.length, 1);
  assert.match(backendCalls[0].text, /\.hco\/exchanges\/v1\//u);
  assert.doesNotMatch(backendCalls[0].text, /source\.md/u);
  assert.equal(fixture.store.readObjectiveExecution(result.objectiveId).executionStatus, "running");
});

test("trusted Jarvis and Agent dispatches bind fresh call tokens and exact mailbox owners", async (t) => {
  const fixture = serviceFixture(t);
  const semantic = {
    type: "DISPATCH",
    instruction: "Run the delegated check.",
    constraints: [],
    acceptanceCriteria: ["Report evidence."],
    reminders: [],
    objective: { mode: "NEW" },
    topicModeAction: null
  };
  const coordinatedEvent = ({ sourceMessageId, caller }) => {
    const event = fixture.event({
      kind: "SEMANTIC",
      sourceMessageId,
      senderId: 3,
      body: semantic,
      extra: { caller }
    });
    const seconds = Math.floor(fixture.clock.value / 1000);
    event.contextToken = signContext({
      version: 1,
      purpose: "codex-coordination-dispatch",
      codexCallId: caller.codexCallId,
      issuedAt: seconds - 1,
      expiresAt: seconds + 60,
      nonce: `coordinated-${sourceMessageId}-${caller.codexCallId}`,
      binding: event.binding
    }, fixture.key);
    return event;
  };

  const jarvisCaller = {
    invocationOrigin: "JARVIS",
    callerPrincipalId: "jarvis:hermes-topic-session",
    callerHermesSessionId: "hermes-topic-session",
    codexCallId: "call-jarvis-1",
    originalRequest: "Run the delegated check."
  };
  const jarvis = await fixture.service.handleBridgeEvent(coordinatedEvent({
    sourceMessageId: 123,
    caller: jarvisCaller
  }));
  assert.equal(jarvis.invocationOrigin, "JARVIS");
  assert.deepEqual(jarvis.mailboxTarget, {
    kind: "JARVIS_MAILBOX",
    id: jarvis.topicContextId
  });
  assert.equal(fixture.store.readCodexCall(jarvis.codexCallId).callerPrincipalId,
    "jarvis:hermes-topic-session");
  assert.equal(fixture.store.readTopicContext({ streamId: 42, topic: "Build" }).jarvisSessionId,
    "hermes-topic-session");

  const secondJarvis = await fixture.service.handleBridgeEvent(coordinatedEvent({
    sourceMessageId: 123,
    caller: { ...jarvisCaller, codexCallId: "call-jarvis-2" }
  }));
  assert.equal(secondJarvis.workRequestId, jarvis.workRequestId);
  assert.notEqual(secondJarvis.codexCallId, jarvis.codexCallId);
  assert.notEqual(secondJarvis.objectiveId, jarvis.objectiveId);
  assert.equal(fixture.store.readWorkStatus(jarvis.workRequestId).codexCalls.length, 2);

  const agentCaller = {
    invocationOrigin: "AGENT",
    callerPrincipalId: "agent:hermes-child-1",
    codexCallId: "call-agent-1",
    agentHermesSessionId: "hermes-child-1",
    parentHermesSessionId: "hermes-topic-session",
    agentRole: "reviewer",
    agentGoal: "Review the delegated change",
    newConversation: true,
    originalRequest: "Run the delegated check."
  };
  const agent = await fixture.service.handleBridgeEvent(coordinatedEvent({
    sourceMessageId: 124,
    caller: agentCaller
  }));
  const agentCall = fixture.store.readCodexCall(agent.codexCallId);
  assert.equal(agent.invocationOrigin, "AGENT");
  assert.equal(agent.mailboxTarget.kind, "AGENT_MAILBOX");
  assert.equal(agent.mailboxTarget.id, agentCall.agentSessionId);
  assert.equal(agentCall.callerPrincipalId, `agent:${agentCall.agentSessionId}`);
  assert.equal(fixture.store.readAgentScopeByHermesSession("hermes-child-1").agentSession.role,
    "reviewer");

  const forgedAgent = coordinatedEvent({
    sourceMessageId: 126,
    caller: {
      ...agentCaller,
      codexCallId: "call-agent-forged-parent",
      agentHermesSessionId: "hermes-child-forged",
      parentHermesSessionId: "unknown-parent-session"
    }
  });
  await assert.rejects(() => fixture.service.handleBridgeEvent(forgedAgent), {
    code: "AGENT_PARENT_SCOPE_MISMATCH"
  });
  assert.equal(fixture.store.readAgentScopeByHermesSession("hermes-child-forged"), null);

  const mismatched = coordinatedEvent({
    sourceMessageId: 125,
    caller: { ...jarvisCaller, codexCallId: "call-event-id" }
  });
  const seconds = Math.floor(fixture.clock.value / 1000);
  mismatched.contextToken = signContext({
    version: 1,
    purpose: "codex-coordination-dispatch",
    codexCallId: "call-token-id",
    issuedAt: seconds - 1,
    expiresAt: seconds + 60,
    nonce: "coordinated-mismatch",
    binding: mismatched.binding
  }, fixture.key);
  await assert.rejects(() => fixture.service.handleBridgeEvent(mismatched), {
    code: "BRIDGE_EVENT_INVALID"
  });
});

test("work status reconciles completed, failed, and unverified Codex calls before replying", async (t) => {
  const cases = [
    {
      name: "completed",
      backendStatus: "completed",
      callState: "COMPLETED",
      workState: "RUNNING",
      nextAction: "jarvis_finalize"
    },
    {
      name: "failed",
      backendStatus: "terminal_error",
      callState: "FAILED",
      workState: "RUNNING",
      nextAction: "caller_review"
    },
    {
      name: "unverified",
      backendStatus: "reconciliation_needed",
      callState: "STATUS_UNVERIFIED",
      workState: "STATUS_UNVERIFIED",
      nextAction: "verify_backend"
    }
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = serviceFixture(subtest, {
        reconcileResult: ({ objectiveId }) => ({
          status: scenario.backendStatus,
          objectiveId,
          turnId: scenario.name === "unverified" ? "turn-mismatched" : "turn-1"
        })
      });
      const sourceMessageId = 700 + index;
      const caller = {
        invocationOrigin: "JARVIS",
        callerPrincipalId: `jarvis:status-${scenario.name}`,
        callerHermesSessionId: `status-${scenario.name}`,
        codexCallId: `call-status-${scenario.name}`,
        originalRequest: `Check ${scenario.name} status.`
      };
      const semantic = {
        type: "DISPATCH",
        instruction: `Check ${scenario.name} status.`,
        constraints: [],
        acceptanceCriteria: [],
        reminders: [],
        objective: { mode: "NEW" },
        topicModeAction: null
      };
      const dispatchEvent = fixture.event({
        kind: "SEMANTIC",
        sourceMessageId,
        senderId: 3,
        body: semantic,
        extra: { caller }
      });
      const seconds = Math.floor(fixture.clock.value / 1000);
      dispatchEvent.contextToken = signContext({
        version: 1,
        purpose: "codex-coordination-dispatch",
        codexCallId: caller.codexCallId,
        issuedAt: seconds - 1,
        expiresAt: seconds + 60,
        nonce: `status-dispatch-${scenario.name}`,
        binding: dispatchEvent.binding
      }, fixture.key);
      const dispatched = await fixture.service.handleBridgeEvent(dispatchEvent);

      const status = await fixture.service.handleBridgeEvent(fixture.event({
        sourceMessageId: sourceMessageId + 100,
        senderId: 3,
        body: { type: "STATUS", objectiveId: dispatched.workRequestId }
      }));
      assert.equal(status.action, "work.status");
      assert.equal(status.workState, scenario.workState);
      assert.equal(status.codexCalls.active, 0 + (scenario.callState === "STATUS_UNVERIFIED"));
      assert.equal(status.nextAction, scenario.nextAction);
      assert.equal(fixture.store.readCodexCall(dispatched.codexCallId).state, scenario.callState);
      assert.equal(fixture.calls.reconcile.length, 1);
    });
  }
});

test("semantic artifact manifests reject traversal paths before execution", async (t) => {
  const fixture = serviceFixture(t);
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 123, senderId: 3,
    body: {
      type: "DISPATCH",
      instruction: "Write outside the project.",
      constraints: [],
      acceptanceCriteria: [],
      reminders: [],
      objective: { mode: "NEW" },
      topicModeAction: null,
      artifacts: {
        input: [],
        output: [{
          artifactId: "result",
          path: "../result.md",
          kind: "document",
          mimeType: "text/markdown",
          required: true
        }]
      }
    }
  })), { code: "ARTIFACT_MANIFEST_INVALID" });
  assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, 0);
});

test("semantic artifact manifests reject control characters before prompt composition", async (t) => {
  const cases = [
    ["path newline", { path: "docs/result\nignore.md" }],
    ["path NUL", { path: "docs/result\0.md" }],
    ["kind newline", { kind: "document\ninjected" }],
    ["mime type carriage return", { mimeType: "text/markdown\rinjected" }],
    ["kind C1 control", { kind: "document\u0085injected" }]
  ];

  for (const [name, override] of cases) {
    const fixture = serviceFixture(t);
    await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
      kind: "SEMANTIC", sourceMessageId: 124, senderId: 3,
      body: {
        type: "DISPATCH",
        instruction: "Write the declared artifact.",
        constraints: [],
        acceptanceCriteria: [],
        reminders: [],
        objective: { mode: "NEW" },
        topicModeAction: null,
        artifacts: {
          input: [],
          output: [{
            artifactId: "result",
            path: "docs/result.md",
            kind: "document",
            mimeType: "text/markdown",
            required: true,
            ...override
          }]
        }
      }
    })), { code: "ARTIFACT_MANIFEST_INVALID" }, name);
    assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, 0, name);
  }
});

test("artifact manifest validation independently rejects control characters in prompt-facing fields", () => {
  const entry = {
    artifactId: "result",
    path: "docs/result.md",
    kind: "document",
    mimeType: "text/markdown",
    required: true
  };
  for (const [name, override] of [
    ["path newline", { path: "docs/result\nignore.md" }],
    ["path NUL", { path: "docs/result\0.md" }],
    ["kind newline", { kind: "document\ninjected" }],
    ["mime type carriage return", { mimeType: "text/markdown\rinjected" }],
    ["kind C1 control", { kind: "document\u0085injected" }]
  ]) {
    assert.throws(
      () => validateArtifactManifestShape({ input: [], output: [{ ...entry, ...override }] }),
      { code: "ARTIFACT_MANIFEST_INVALID" },
      name
    );
  }
});

test("semantic protocol errors and unauthorized AUTO dispatch leave HERMES_ONLY unchanged with zero execution calls", async (t) => {
  const fixture = serviceFixture(t);
  await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 130, senderId: 4,
    body: { type: "CONTROL", action: "SET_TOPIC_MODE", mode: "HERMES_ONLY" }
  }));
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 131, senderId: 3,
    body: {
      type: "DISPATCH", instruction: "work", constraints: [], acceptanceCriteria: [], reminders: [],
      objective: null, topicModeAction: "AUTO"
    }
  })), { code: "ACL_FORBIDDEN" });
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 132, senderId: 4,
    body: { type: "BUSINESS_REPLY", text: "no" }
  })), { code: "MODEL_PROTOCOL_ERROR" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 133, senderId: 4,
    body: {
      type: "DISPATCH", instruction: "x", constraints: [], acceptanceCriteria: [], reminders: [],
      objective: null, topicModeAction: "HERMES_ONLY"
    }
  })), { code: "MODEL_PROTOCOL_ERROR" });
  assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, 0);
});

test("post-commit snapshot failure remains dirty and explicit publication retries the committed generation", async (t) => {
  let attempts = 0;
  const fixture = serviceFixture(t, {
    snapshotPublisher(options) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("private path and native failure");
        error.code = "EIO";
        throw error;
      }
      return { generation: options.generation };
    }
  });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 140, senderId: 4,
    body: { type: "TOPIC", action: "HERMES" }
  })), { code: "ROUTE_SNAPSHOT_PUBLISH_FAILED", message: "Route snapshot publication failed." });
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
  assert.equal(fixture.store.readControlGeneration().generation, 1);

  assert.deepEqual(await fixture.service.publishSnapshot(), { generation: 1 });
  assert.equal(attempts, 2);
  await fixture.service.close();
});

test("Hermes route inspection is public to an authenticated numeric actor and UNSET authorizes both affected projects", async (t) => {
  const fixture = serviceFixture(t);
  assert.equal((await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 150, streamId: 99, senderId: 99,
    body: { type: "ROUTE", action: "SHOW" }
  }))).route.owner, "HERMES");

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 151, senderId: 1,
    body: { type: "ROUTE", action: "SET", projectId: "beta" }
  }));
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 152, senderId: 5,
    body: { type: "ROUTE", action: "UNSET" }
  })), { code: "ACL_FORBIDDEN" });
  assert.equal(fixture.service.resolveRoute(42).projectId, "beta");
  assert.equal((await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 153, senderId: 1,
    body: { type: "ROUTE", action: "UNSET" }
  }))).route.projectId, "alpha");
});

test("UNSET preserves topic state when a runtime override falls back to the same project", async (t) => {
  const fixture = serviceFixture(t);
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 154, senderId: 4,
    body: { type: "ROUTE", action: "SET", projectId: "alpha" }
  }));
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 155, senderId: 4,
    body: { type: "TOPIC", action: "HERMES" }
  }));

  const result = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 156, senderId: 4,
    body: { type: "ROUTE", action: "UNSET" }
  }));

  assert.equal(result.route.projectId, "alpha");
  assert.equal(fixture.store.getRuntimeRoute(42), null);
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
});

test("UNSET from Hermes ownership to a static project requires its maintainer without deployment admin", async (t) => {
  const fixture = serviceFixture(t);
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 157, senderId: 1,
    body: { type: "ROUTE", action: "NONE" }
  }));

  const result = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 158, senderId: 4,
    body: { type: "ROUTE", action: "UNSET" }
  }));

  assert.equal(result.route.owner, "PROJECT");
  assert.equal(result.route.projectId, "alpha");
});

test("semantic AUTO is committed atomically with the trusted execution intent", (t) => {
  const fixture = storeFixture(t);
  fixture.store.setUserTopicMode({
    sourceType: "zulip-message", sourceId: "160", streamId: 42, topic: "Build", projectId: "alpha",
    mode: "HERMES_ONLY", actorUserId: 4
  });
  const options = {
    sourceType: "zulip-message", sourceId: "161", objectiveId: "objective-auto", projectId: "alpha",
    backend: "app-server", text: "work",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 161 },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 4 },
    topicModeAction: "AUTO"
  };
  fixture.store.registerExecutionIntent(options);
  assert.equal(fixture.store.readObjectiveProject("objective-auto"), "alpha");
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");

  fixture.store.setUserTopicMode({
    sourceType: "zulip-message", sourceId: "162", streamId: 42, topic: "Other", projectId: "alpha",
    mode: "HERMES_ONLY", actorUserId: 4
  });
  assert.throws(() => fixture.store.registerExecutionIntent({
    ...options, sourceId: "163", projectId: "beta",
    topicBinding: { streamId: 42, topic: "Other", actorUserId: 4 }
  }), { code: "OBJECTIVE_PROJECT_CONFLICT" });
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Other" }).mode, "HERMES_ONLY");
});

test("dispatch continues the topic objective, isolates NEW, and rejects cross-topic continuations", async (t) => {
  const fixture = serviceFixture(t);
  let relinkMessageId = 700;
  const seed = (objectiveId, sourceId, topic = "Build", projectId = "alpha", streamId = 42, actorUserId = 3) => {
    fixture.store.registerExecutionIntent({
      sourceType: "seed", sourceId, objectiveId, projectId, backend: "app-server", text: "seed",
      targetSnapshot: { platform: "zulip", streamId, topic, sourceMessageId: 1 },
      topicBinding: { streamId, topic, actorUserId }
    });
    fixture.store.bindBackendObjective({ objectiveId, backend: "app-server", threadId: `thread-${objectiveId}` });
    relinkMessageId += 1;
    fixture.store.relinkLegacyObjectiveTopic({
      objectiveId,
      streamId,
      topic,
      projectId,
      requesterUserId: actorUserId,
      originalZulipMessageId: relinkMessageId,
      sourceType: "test-objective-topic-relink",
      sourceId: `relink-${sourceId}`
    });
  };
  seed("objective-current", "current");
  seed("objective-older", "older", "Other");
  seed("objective-beta", "beta", "Beta", "beta", 43, 7);

  const continued = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 170, senderId: 3, body: { type: "RUN", instruction: "Continue current." }
  }));
  assert.equal(continued.objectiveId, "objective-current");
  assert.equal(fixture.calls.continue.at(-1).objectiveId, "objective-current");

  const fresh = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 171, senderId: 3, body: { type: "OBJECTIVE_NEW", instruction: "Start fresh." }
  }));
  assert.notEqual(fresh.objectiveId, "objective-current");
  assert.equal(fixture.calls.accept.at(-1).objectiveId, fresh.objectiveId);

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 172, senderId: 3,
    body: { type: "OBJECTIVE_CONTINUE", objectiveId: "objective-older", instruction: "Resume older." }
  })), { code: "OBJECTIVE_TOPIC_MISMATCH" });

  const callCount = fixture.calls.accept.length + fixture.calls.continue.length;
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 173, senderId: 3,
    body: { type: "OBJECTIVE_CONTINUE", objectiveId: "objective-missing", instruction: "No." }
  })), { code: "OBJECTIVE_NOT_FOUND" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 174, senderId: 3,
    body: { type: "OBJECTIVE_CONTINUE", objectiveId: "objective-beta", instruction: "No." }
  })), { code: "OBJECTIVE_PROJECT_MISMATCH" });
  assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, callCount);
});

test("legacy objective continuation fails closed until an authorized topic relink", async (t) => {
  const fixture = serviceFixture(t);
  fixture.store.registerExecutionIntent({
    sourceType: "seed",
    sourceId: "legacy-unscoped",
    objectiveId: "objective-legacy-unscoped",
    projectId: "alpha",
    backend: "app-server",
    text: "seed",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  fixture.store.bindBackendObjective({
    objectiveId: "objective-legacy-unscoped",
    backend: "app-server",
    threadId: "thread-legacy-unscoped"
  });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 175,
    senderId: 3,
    body: { type: "RUN", instruction: "Do not infer a legacy scope." }
  })), { code: "OBJECTIVE_TOPIC_MIGRATION_REQUIRED" });
  assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, 0);
});

test("STATUS, CANCEL, APPROVE, and ANSWER enforce durable authority and remain available in HERMES_ONLY", async (t) => {
  const fixture = serviceFixture(t);
  fixture.store.registerExecutionIntent({
    sourceType: "seed", sourceId: "commands", objectiveId: "objective-commands", projectId: "alpha",
    backend: "app-server", text: "seed",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  fixture.store.bindBackendObjective({
    objectiveId: "objective-commands", backend: "app-server", threadId: "thread-commands"
  });
  fixture.store.relinkLegacyObjectiveTopic({
    objectiveId: "objective-commands",
    streamId: 42,
    topic: "Build",
    projectId: "alpha",
    requesterUserId: 3,
    originalZulipMessageId: 650,
    sourceType: "test-objective-topic-relink",
    sourceId: "relink-objective-commands"
  });
  const prepared = fixture.store.prepareTurnSubmission({
    sourceType: "seed", sourceId: "commands", objectiveId: "objective-commands", text: "running",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    leaseOwner: "service-test"
  });
  fixture.store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId: "turn-commands" });
  const createInteraction = (wireRequestId, method, request) => fixture.store.createInteraction({
    connectionId: "connection-commands", wireRequestId, method,
    objectiveId: "objective-commands", threadId: "thread-commands", turnId: "turn-commands",
    itemId: `item-${wireRequestId}`, approvalId: null, request,
    allowedResponderIds: [3],
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    renderer: ({ interaction }) => ({
      semanticKey: `interaction:${interaction.interactionId}:prompt`,
      payload: { content: "Respond.", kind: "interaction_request" }
    })
  }).interaction;
  const approval = createInteraction(1, "item/commandExecution/requestApproval", {
    command: "npm test",
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
      "cancel"
    ]
  });
  const fallbackApproval = createInteraction(2, "item/commandExecution/requestApproval", { command: "npm test" });
  const nullApproval = createInteraction(5, "item/commandExecution/requestApproval", {
    command: "npm test", availableDecisions: null
  });
  const question = createInteraction(3, "item/tool/requestUserInput", {
    questions: [{
      id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false,
      options: [{ label: "staging", description: "预发" }, { label: "production", description: "生产" }]
    }],
    autoResolutionMs: null
  });
  const multipleQuestions = createInteraction(4, "item/tool/requestUserInput", {
    questions: [
      { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
      { id: "q2", header: "确认", question: "是否继续", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const whitespaceQuestions = createInteraction(6, "item/tool/requestUserInput", {
    questions: [
      { id: "deploy target", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const mixedQuestionIds = createInteraction(7, "item/tool/requestUserInput", {
    questions: [
      { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
      { id: "deploy target", header: "确认", question: "是否继续", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const emptyQuestionId = createInteraction(8, "item/tool/requestUserInput", {
    questions: [
      { id: "", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const mixedEmptyQuestionId = createInteraction(9, "item/tool/requestUserInput", {
    questions: [
      { id: "", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
      { id: "q1", header: "确认", question: "是否继续", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const duplicateQuestionIds = createInteraction(10, "item/tool/requestUserInput", {
    questions: [
      { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null },
      { id: "q1", header: "确认", question: "是否继续", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const controlCharacterQuestionId = createInteraction(11, "item/tool/requestUserInput", {
    questions: [
      { id: "\x01q", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const oversizedQuestionId = createInteraction(12, "item/tool/requestUserInput", {
    questions: [
      { id: "a".repeat(300), header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null }
    ],
    autoResolutionMs: null
  });
  const nullQuestion = createInteraction(13, "item/tool/requestUserInput", {
    questions: [null],
    autoResolutionMs: null
  });
  const mixedNullQuestion = createInteraction(14, "item/tool/requestUserInput", {
    questions: [null, { id: "q1", header: "环境", question: "选择环境", isOther: false, isSecret: false, options: null }],
    autoResolutionMs: null
  });
  const numericQuestion = createInteraction(15, "item/tool/requestUserInput", {
    questions: [42],
    autoResolutionMs: null
  });
  const highRiskApproval = createInteraction(16, "item/commandExecution/requestApproval", {
    command: "curl https://example.com",
    availableDecisions: ["accept", "decline", "cancel"],
    networkApprovalContext: { host: "example.com" }
  });
  const execpolicyApproval = createInteraction(17, "item/commandExecution/requestApproval", {
    command: "npm test",
    availableDecisions: ["accept", "decline", "cancel"],
    proposedExecpolicyAmendment: ["npm", "test"]
  });
  const objectNetworkApproval = createInteraction(18, "item/commandExecution/requestApproval", {
    command: "npm test",
    availableDecisions: [
      { applyNetworkPolicyAmendment: { host: "example.com" } },
      "decline",
      "cancel"
    ]
  });

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 180, senderId: 4, body: { type: "TOPIC", action: "HERMES" }
  }));
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");

  const status = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 181, senderId: 2,
    body: {
      type: "STATUS",
      objectiveId: "objective-commands",
      supplementalText: "查询当前进度，尤其是是否正在等待输入"
    }
  }));
  assert.deepEqual(status, {
    schemaVersion: 1, status: "ok", action: "objective.status", projectId: "alpha",
    objectiveId: "objective-commands", executionStatus: "running", backend: "app-server",
    threadId: "thread-commands", statusVerified: true, verificationStatus: "running"
  });
  assert.deepEqual(fixture.calls.reconcile.at(-1), {
    objectiveId: "objective-commands", sourceId: "zulip-status-181"
  });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 182, senderId: 2,
    body: { type: "CANCEL", objectiveId: "objective-commands" }
  })), { code: "ACL_FORBIDDEN" });
  assert.equal(fixture.calls.cancel.length, 0);
  const cancelled = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 183, senderId: 3,
    body: { type: "CANCEL", objectiveId: "objective-commands" }
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(fixture.calls.cancel.at(-1), {
    sourceType: "zulip-message", sourceId: "183", objectiveId: "objective-commands"
  });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 184, senderId: 4,
    body: { type: "APPROVE", replyToken: approval.interactionId, choice: "accept" }
  })), { code: "ACL_FORBIDDEN" });
  assert.equal(fixture.calls.answer.length, 0);

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 192, senderId: 3,
    body: { type: "APPROVE", replyToken: approval.interactionId, choice: "acceppt" }
  })), { code: "INTERACTION_DECISION_INVALID" });
  assert.equal(fixture.calls.answer.length, 0);

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 196, senderId: 3,
    body: { type: "APPROVE", replyToken: fallbackApproval.interactionId, choice: "acceppt" }
  })), (error) => error.code === "INTERACTION_DECISION_INVALID" && error.message.includes("acceptForSession"));
  assert.equal(fixture.calls.answer.length, 0);

  const highRiskAccepted = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 301, senderId: 3,
    body: { type: "APPROVE", replyToken: highRiskApproval.interactionId, choice: "accept" }
  }));
  assert.equal(highRiskAccepted.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });
  const execpolicyAccepted = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 303, senderId: 3,
    body: { type: "APPROVE", replyToken: execpolicyApproval.interactionId, choice: "accept" }
  }));
  assert.equal(execpolicyAccepted.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 304, senderId: 3,
    body: { type: "APPROVE", replyToken: objectNetworkApproval.interactionId, choice: "applyNetworkPolicyAmendment" }
  })), { code: "INTERACTION_ACTION_EXPLICIT_REQUIRED" });
  const networkAction = objectNetworkApproval.actions.find((action) => action.actionClass === "network_policy_change");
  assert.ok(networkAction);
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 305, senderId: 3,
    body: { type: "INTERACT", replyToken: objectNetworkApproval.interactionId, actionId: networkAction.actionId }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, networkAction.answer);

  const callsBeforeMismatches = fixture.calls.answer.length;
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 193, senderId: 3,
    body: { type: "ANSWER", replyToken: approval.interactionId, text: "accept" }
  })), { code: "INTERACTION_COMMAND_MISMATCH" });
  assert.equal(fixture.calls.answer.length, callsBeforeMismatches);

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 194, senderId: 3,
    body: { type: "APPROVE", replyToken: question.interactionId, choice: "accept" }
  })), { code: "INTERACTION_COMMAND_MISMATCH" });
  assert.equal(fixture.calls.answer.length, callsBeforeMismatches);

  const stagingAction = question.actions.find((action) => action.sourceKey === "staging");
  assert.ok(stagingAction);
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 307, senderId: 3,
    body: { type: "INTERACT", replyToken: question.interactionId, actionId: stagingAction.actionId }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, {
    answers: { q1: { answers: ["staging"] } }
  });

  const approved = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 185, senderId: 3,
    body: { type: "APPROVE", replyToken: approval.interactionId, choice: "accept" }
  }));
  assert.equal(approved.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 186,
    senderId: 3,
    body: {
      type: "APPROVE",
      replyToken: approval.interactionId,
      choice: "acceptWithExecpolicyAmendment"
    }
  })), { code: "INTERACTION_ACTION_EXPLICIT_REQUIRED" });
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });
  const policyAction = approval.actions.find((action) => action.actionClass === "policy_change");
  assert.ok(policyAction);
  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 306,
    senderId: 3,
    body: { type: "INTERACT", replyToken: approval.interactionId, actionId: policyAction.actionId }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, policyAction.answer);

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 187, senderId: 3,
    body: { type: "APPROVE", replyToken: fallbackApproval.interactionId, choice: "accept" }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });

  const answered = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 188, senderId: 3,
    body: { type: "ANSWER", replyToken: question.interactionId, text: "staging" }
  }));
  assert.equal(answered.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { answers: { q1: { answers: ["staging"] } } });

  const callsBeforeInvalidQuestionIds = fixture.calls.answer.length;
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 198, senderId: 3,
    body: { type: "ANSWER", replyToken: whitespaceQuestions.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 199, senderId: 3,
    body: { type: "ANSWER", replyToken: mixedQuestionIds.interactionId, text: "q1 staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 200, senderId: 3,
    body: { type: "ANSWER", replyToken: emptyQuestionId.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 201, senderId: 3,
    body: { type: "ANSWER", replyToken: mixedEmptyQuestionId.interactionId, text: "q1 staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 202, senderId: 3,
    body: { type: "ANSWER", replyToken: duplicateQuestionIds.interactionId, text: "q1 staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 203, senderId: 3,
    body: { type: "ANSWER", replyToken: controlCharacterQuestionId.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 204, senderId: 3,
    body: { type: "ANSWER", replyToken: oversizedQuestionId.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 205, senderId: 3,
    body: { type: "ANSWER", replyToken: nullQuestion.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 206, senderId: 3,
    body: { type: "ANSWER", replyToken: mixedNullQuestion.interactionId, text: "q1 staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 207, senderId: 3,
    body: { type: "ANSWER", replyToken: numericQuestion.interactionId, text: "staging" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });
  assert.equal(fixture.calls.answer.length, callsBeforeInvalidQuestionIds);
  assert.equal(fixture.store.readInteraction(whitespaceQuestions.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(mixedQuestionIds.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(emptyQuestionId.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(mixedEmptyQuestionId.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(duplicateQuestionIds.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(controlCharacterQuestionId.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(oversizedQuestionId.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(nullQuestion.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(mixedNullQuestion.interactionId).partialAnswers, null);
  assert.equal(fixture.store.readInteraction(numericQuestion.interactionId).partialAnswers, null);

  const partial = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 189, senderId: 3,
    body: { type: "ANSWER", replyToken: multipleQuestions.interactionId, text: "q1 staging" }
  }));
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.missingQuestionIds, ["q2"]);
  assert.equal(fixture.calls.answer.length, callsBeforeInvalidQuestionIds);
  assert.deepEqual(fixture.store.readInteraction(multipleQuestions.interactionId).partialAnswers, {
    q1: { answers: ["staging"] }
  });

  const completed = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 190, senderId: 3,
    body: { type: "ANSWER", replyToken: multipleQuestions.interactionId, text: "q2 yes" }
  }));
  assert.equal(completed.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, {
    answers: { q1: { answers: ["staging"] }, q2: { answers: ["yes"] } }
  });

  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 191, senderId: 3,
    body: { type: "ANSWER", replyToken: multipleQuestions.interactionId, text: "missing nope" }
  })), { code: "INTERACTION_QUESTION_ID_INVALID" });

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 197, senderId: 3,
    body: { type: "APPROVE", replyToken: nullApproval.interactionId, choice: "decline" }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "decline" });

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 302, senderId: 3,
    body: { type: "APPROVE", replyToken: highRiskApproval.interactionId, choice: "decline" }
  }));
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "decline" });
});

test("APPROVE exposes a missing interaction as a user-facing state error", async (t) => {
  const fixture = serviceFixture(t);

  await assert.rejects(
    () => fixture.service.handleBridgeEvent(fixture.event({
      sourceMessageId: 300,
      senderId: 3,
      body: { type: "APPROVE", replyToken: "missing-interaction", choice: "accept" }
    })),
    (error) => {
      assert.equal(isStateError(error), true);
      assert.equal(error.code, "INTERACTION_NOT_FOUND");
      assert.match(error.message, /does not exist/);
      return true;
    }
  );
});

test("natural approval replies select only one eligible action and never guess across pending interactions", async (t) => {
  const fixture = serviceFixture(t);
  fixture.store.registerExecutionIntent({
    sourceType: "seed", sourceId: "natural", objectiveId: "objective-natural", projectId: "alpha",
    backend: "app-server", text: "seed",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    topicBinding: { streamId: 42, topic: "Build", actorUserId: 3 }
  });
  fixture.store.bindBackendObjective({
    objectiveId: "objective-natural", backend: "app-server", threadId: "thread-natural"
  });
  const prepared = fixture.store.prepareTurnSubmission({
    sourceType: "seed", sourceId: "natural", objectiveId: "objective-natural", text: "running",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    leaseOwner: "service-test"
  });
  fixture.store.acknowledgeTurnSubmission({ submissionId: prepared.submission.submissionId, turnId: "turn-natural" });
  const createApproval = (wireRequestId) => fixture.store.createInteraction({
    connectionId: "connection-natural", wireRequestId,
    method: "item/commandExecution/requestApproval",
    objectiveId: "objective-natural", threadId: "thread-natural", turnId: "turn-natural",
    itemId: `item-natural-${wireRequestId}`, approvalId: null,
    request: { command: "npm test", availableDecisions: ["accept", "cancel"] },
    allowedResponderIds: [3],
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Build", sourceMessageId: 1 },
    renderer: ({ interaction }) => ({
      semanticKey: `interaction:${interaction.interactionId}:prompt`,
      payload: { content: "Respond.", kind: "interaction_request" }
    })
  }).interaction;

  const none = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 401, senderId: 3,
    body: { type: "NATURAL_INTERACTION_REPLY", normalizedAlias: "ok" }
  }));
  assert.deepEqual(none, {
    schemaVersion: 1, action: "interaction.natural_reply", status: "not_applicable"
  });

  const first = createApproval(1);
  const selected = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 402, senderId: 3,
    body: { type: "NATURAL_INTERACTION_REPLY", normalizedAlias: "可以" }
  }));
  assert.equal(selected.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "accept" });
  assert.equal(fixture.calls.answer.at(-1).audit.resolutionSource, "natural_alias");
  assert.equal(fixture.calls.answer.at(-1).interactionId, first.interactionId);
  assert.deepEqual(
    {
      state: fixture.store.readInteraction(first.interactionId).state,
      answer: fixture.store.readInteraction(first.interactionId).answer,
      responseDeliveryState: fixture.store.readInteraction(first.interactionId).responseDeliveryState
    },
    { state: "answered", answer: { decision: "accept" }, responseDeliveryState: "pending" }
  );
  assert.deepEqual(fixture.store.readInteractionSettlementAudit(first.interactionId), {
    interactionId: first.interactionId,
    actionId: fixture.store.readInteraction(first.interactionId).actions.find(
      (action) => action.sourceKey === "accept"
    ).actionId,
    actionClass: "one_time_allow",
    resolutionSource: "natural_alias",
    sourceType: "zulip-interaction-reply",
    sourceMessageId: "402",
    detailSha256: fixture.store.readInteractionDetail(first.interactionId).contentSha256,
    responderId: 3,
    settledAt: fixture.clock.value
  });

  const second = createApproval(2);

  const denied = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 404, senderId: 3,
    body: { type: "NATURAL_INTERACTION_REPLY", normalizedAlias: "取消" }
  }));
  assert.equal(denied.status, "answered");
  assert.deepEqual(fixture.calls.answer.at(-1).answer, { decision: "cancel" });
  assert.equal(fixture.store.readInteraction(second.interactionId).state, "answered");

  createApproval(3);
  createApproval(4);
  const ambiguous = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 403, senderId: 3,
    body: { type: "NATURAL_INTERACTION_REPLY", normalizedAlias: "ok" }
  }));
  assert.equal(ambiguous.action, "interaction.natural_reply");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidateInteractionIds.length, 2);
});

test("THREAD_BIND requires the numeric route objective project and maintainer authority in HERMES_ONLY", async (t) => {
  const fixture = serviceFixture(t);
  fixture.store.registerExecutionIntent({
    sourceType: "seed", sourceId: "thread-bind-objective", objectiveId: "objective-thread-bind",
    projectId: "alpha", backend: "app-server", text: "seed",
    targetSnapshot: { platform: "zulip", streamId: 42, topic: "Legacy", sourceMessageId: 1 },
    topicBinding: { streamId: 42, topic: "Legacy", actorUserId: 3 }
  });
  fixture.store.setUserTopicMode({
    sourceType: "seed", sourceId: "thread-bind-hermes-only", streamId: 42, topic: "Legacy",
    projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 4
  });

  for (const [sourceMessageId, senderId] of [[210, 2], [211, 3]]) {
    await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
      sourceMessageId, senderId, topic: "Legacy",
      body: { type: "THREAD_BIND", objectiveId: "objective-thread-bind", threadId: "thread-recovered" }
    })), { code: "ACL_FORBIDDEN" });
  }
  await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 212, senderId: 5, streamId: 43, topic: "Legacy",
    body: { type: "THREAD_BIND", objectiveId: "objective-thread-bind", threadId: "thread-recovered" }
  })), { code: "OBJECTIVE_PROJECT_MISMATCH" });
  assert.deepEqual(fixture.calls.bind, []);

  const maintained = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 213, senderId: 4, topic: "Legacy",
    body: { type: "THREAD_BIND", objectiveId: "objective-thread-bind", threadId: "thread-recovered" }
  }));
  assert.deepEqual(maintained, {
    schemaVersion: 1, status: "started", action: "objective.thread.bind", projectId: "alpha",
    objectiveId: "objective-thread-bind", submissionId: "submission-bound",
    clientUserMessageId: "client-bound", threadId: "thread-recovered", turnId: "turn-bound", duplicate: false
  });
  assert.deepEqual(fixture.calls.bind, [{
    objectiveId: "objective-thread-bind", threadId: "thread-recovered",
    sourceType: "zulip-message", sourceId: "213"
  }]);

  await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 214, senderId: 1, topic: "Legacy",
    body: { type: "THREAD_BIND", objectiveId: "objective-thread-bind", threadId: "thread-recovered" }
  }));
  assert.equal(fixture.calls.bind.length, 2);
});

test("THREAD_BIND rejects malformed command objects before controller execution", async (t) => {
  const fixture = serviceFixture(t);
  for (const [index, body] of [
    { type: "THREAD_BIND", objectiveId: "objective-1" },
    { type: "THREAD_BIND", objectiveId: "objective-1", threadId: "thread-1", extra: true },
    { type: "THREAD_BIND", objectiveId: "objective 1", threadId: "thread-1" },
    { type: "THREAD_BIND", objectiveId: "objective-1", threadId: "thread 1" }
  ].entries()) {
    await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
      sourceMessageId: 220 + index, senderId: 4, body
    })), { code: "BRIDGE_EVENT_INVALID" });
  }
  assert.deepEqual(fixture.calls.bind, []);
});

test("semantic tagged unions and byte/count limits fail closed without changing topic or execution state", async (t) => {
  const fixture = serviceFixture(t);
  await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 190, senderId: 4,
    body: { type: "CONTROL", action: "SET_TOPIC_MODE", mode: "HERMES_ONLY" }
  }));
  const valid = {
    type: "DISPATCH", instruction: "work", constraints: [], acceptanceCriteria: [], reminders: [],
    objective: null, topicModeAction: null
  };
  const invalid = [
    { ...valid, extra: true },
    { ...valid, instruction: "x".repeat(16 * 1024 + 1) },
    { ...valid, constraints: Array.from({ length: 17 }, () => "x") },
    { ...valid, acceptanceCriteria: ["x".repeat(2 * 1024 + 1)] },
    { ...valid, reminders: Array.from({ length: 9 }, () => "x") },
    { ...valid, instruction: "x".repeat(16 * 1024), constraints: Array.from({ length: 8 }, () => "y".repeat(2 * 1024)) },
    { ...valid, objective: { mode: "NEW", objectiveId: "forbidden" } },
    { ...valid, objective: { mode: "CONTINUE" } },
    { type: "CONTROL", action: "SET_TOPIC_MODE", mode: "AUTO", objectiveId: "forbidden" },
    { type: "CLARIFY", question: "What next?" },
    { type: "REJECT", reason: "No." }
  ];
  for (const [index, body] of invalid.entries()) {
    await assert.rejects(() => fixture.service.handleBridgeEvent(fixture.event({
      kind: "SEMANTIC", sourceMessageId: 191 + index, senderId: 4, body
    })), { code: "MODEL_PROTOCOL_ERROR" });
  }
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "HERMES_ONLY");
  assert.equal(fixture.calls.accept.length + fixture.calls.continue.length, 0);
});

test("authorized semantic AUTO crosses the real controller/store boundary atomically", async (t) => {
  const backendCalls = { startObjective: 0, startTurn: 0 };
  const fixture = serviceFixture(t, {
    turnControllerFactory(store) {
      const appServerBackend = {
        async startObjective() {
          backendCalls.startObjective += 1;
          assert.equal(fixture?.store.readTopicState({ streamId: 42, topic: "Build" }).mode, "AUTO");
          return { threadId: "thread-semantic-auto" };
        },
        async startTurn() {
          backendCalls.startTurn += 1;
          return { turnId: "turn-semantic-auto" };
        },
        async interruptTurn() { return { ok: true }; },
        async readObjective() { return { thread: { id: "thread-semantic-auto", turns: [] } }; },
        async reconcileObjective() { return { thread: { id: "thread-semantic-auto", turns: [] } }; },
        async respondToInteraction() {},
        getCapabilities() {
          return { backend: "app-server", durableThreadContinuity: true, reverseInteractions: true };
        }
      };
      return new TurnController({ store, appServerBackend, leaseOwner: "service-real-controller" });
    }
  });
  await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 210, senderId: 4,
    body: { type: "CONTROL", action: "SET_TOPIC_MODE", mode: "HERMES_ONLY" }
  }));

  const result = await fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 211, senderId: 4,
    body: {
      type: "DISPATCH", instruction: "Run atomically.", constraints: [], acceptanceCriteria: [], reminders: [],
      objective: { mode: "NEW" }, topicModeAction: "AUTO"
    }
  }));
  assert.equal(result.status, "accepted");
  assert.deepEqual(backendCalls, { startObjective: 1, startTurn: 1 });
  const topic = fixture.store.readTopicState({ streamId: 42, topic: "Build" });
  assert.deepEqual(topic, {
    streamId: 42, topic: "Build", mode: "CODEX_BOUND", projectId: "alpha",
    objectiveId: result.objectiveId, threadId: "thread-semantic-auto"
  });
  assert.equal(fixture.store.readObjectiveProject(result.objectiveId), "alpha");
});

test("mapped legacy topic lazily creates a thread and promotes only after durable binding", async (t) => {
  let releaseThread;
  let markThreadStarted;
  const threadStarted = new Promise((resolve) => { markThreadStarted = resolve; });
  const fixture = serviceFixture(t, {
    turnControllerFactory(store) {
      const appServerBackend = {
        async startObjective() {
          assert.deepEqual(fixture.store.readTopicState({ streamId: 42, topic: "general chat" }), {
            streamId: 42, topic: "general chat", mode: "AUTO", projectId: null,
            objectiveId: null, threadId: null
          });
          markThreadStarted();
          await new Promise((resolve) => { releaseThread = resolve; });
          return { threadId: "thread-legacy-topic" };
        },
        async startTurn() { return { turnId: "turn-legacy-topic" }; },
        async interruptTurn() { return { ok: true }; },
        async readObjective() { return { thread: { id: "thread-legacy-topic", turns: [] } }; },
        async reconcileObjective() { return { thread: { id: "thread-legacy-topic", turns: [] } }; },
        async respondToInteraction() {},
        getCapabilities() {
          return { backend: "app-server", durableThreadContinuity: true, reverseInteractions: true };
        }
      };
      return new TurnController({ store, appServerBackend, leaseOwner: "legacy-topic-controller" });
    }
  });
  const dispatch = fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", topic: "general chat", sourceMessageId: 445, senderId: 3,
    body: {
      type: "DISPATCH", instruction: "Evaluate project progress.", constraints: [],
      acceptanceCriteria: [], reminders: [], objective: null, topicModeAction: null
    }
  }));

  await threadStarted;
  assert.equal(fixture.store.readTopicState({ streamId: 42, topic: "general chat" }).mode, "AUTO");
  releaseThread();
  const result = await dispatch;

  assert.equal(result.status, "accepted");
  assert.deepEqual(fixture.store.readTopicState({ streamId: 42, topic: "general chat" }), {
    streamId: 42, topic: "general chat", mode: "CODEX_BOUND", projectId: "alpha",
    objectiveId: result.objectiveId, threadId: "thread-legacy-topic"
  });
});

test("accepted route and topic mutations serialize before later dispatch admission", async (t) => {
  const routeFixture = serviceFixture(t);
  const route = routeFixture.service.handleBridgeEvent(routeFixture.event({
    sourceMessageId: 212, senderId: 1, body: { type: "ROUTE", action: "NONE" }
  }));
  const routedDispatch = routeFixture.service.handleBridgeEvent(routeFixture.event({
    sourceMessageId: 213, senderId: 3, body: { type: "RUN", instruction: "Must not start." }
  }));
  await route;
  await assert.rejects(routedDispatch, { code: "ROUTE_HERMES_OWNED" });
  assert.equal(routeFixture.calls.accept.length, 0);

  const topicFixture = serviceFixture(t);
  const topic = topicFixture.service.handleBridgeEvent(topicFixture.event({
    sourceMessageId: 214, senderId: 4, body: { type: "TOPIC", action: "HERMES" }
  }));
  const topicDispatch = topicFixture.service.handleBridgeEvent(topicFixture.event({
    sourceMessageId: 215, senderId: 3, body: { type: "RUN", instruction: "Must not start." }
  }));
  await topic;
  await assert.rejects(topicDispatch, { code: "TOPIC_HERMES_ONLY" });
  assert.equal(topicFixture.calls.accept.length, 0);
});

test("construction is inert and start retries a failed initial snapshot publication", async (t) => {
  let attempts = 0;
  const fixture = serviceFixture(t, {
    snapshotPublisher(options) {
      attempts += 1;
      if (attempts === 1) throw new Error("initial publication failed");
      return { generation: options.generation };
    }
  });
  assert.equal(attempts, 0);
  assert.equal(fixture.store.readControlGeneration().generation, 0);

  await assert.rejects(() => fixture.service.start(), {
    code: "ROUTE_SNAPSHOT_PUBLISH_FAILED",
    message: "Route snapshot publication failed."
  });
  assert.equal(fixture.store.readControlGeneration().generation, 1);
  assert.equal(attempts, 1);

  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(attempts, 2);
  await fixture.service.close();
});

test("start renews unchanged route snapshots before their configured TTL expires", async (t) => {
  const publications = [];
  const fixture = serviceFixture(t, {
    snapshotTtlMs: 5_000,
    snapshotPublisher(options) {
      publications.push({ generation: options.generation, at: Date.now() });
      return { generation: options.generation };
    }
  });

  await fixture.service.start();
  assert.equal(publications.length, 1);
  const initialGeneration = publications[0].generation;
  await new Promise((resolve) => setTimeout(resolve, 4_200));
  assert.ok(publications.length >= 2, "an unchanged snapshot must renew before its five-second TTL");
  assert.ok(publications.every(({ generation }) => generation === initialGeneration));

  await fixture.service.close();
  const afterClose = publications.length;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(publications.length, afterClose);
});

test("snapshot renewal is not delayed when the wall clock moves backward", async (t) => {
  let publications = 0;
  const fixture = serviceFixture(t, {
    snapshotTtlMs: 5_000,
    snapshotPublisher(options) {
      publications += 1;
      return { generation: options.generation };
    }
  });
  const originalDateNow = Date.now;
  t.after(() => { Date.now = originalDateNow; });

  await fixture.service.start();
  assert.equal(publications, 1);
  Date.now = () => originalDateNow() - 60_000;
  await new Promise((resolve) => setTimeout(resolve, 4_200));
  assert.ok(publications >= 2, "snapshot renewal must use elapsed time rather than wall-clock time");
  await fixture.service.close();
});

test("concurrent execution and route mutations cannot publish an older generation after a newer one", async (t) => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const completed = [];
  const fixture = serviceFixture(t, {
    snapshotPublisher(options) {
      if (options.generation === 1) {
        markFirstStarted();
        return new Promise((resolve) => {
          releaseFirst = () => {
            completed.push(options.generation);
            resolve({ generation: options.generation });
          };
        });
      }
      completed.push(options.generation);
      return { generation: options.generation };
    },
    turnControllerFactory(store) {
      return Object.freeze({
        async acceptIntent(options) {
          store.setUserTopicMode({
            sourceType: "controller", sourceId: "publish-1", streamId: 42, topic: "Build",
            projectId: "alpha", mode: "HERMES_ONLY", actorUserId: 4
          });
          return Object.freeze({
            status: "started", objectiveId: options.objectiveId, submissionId: "submission-publish",
            threadId: "thread-publish", turnId: "turn-publish"
          });
        },
        async continueObjective() { throw new Error("unexpected continuation"); },
        async resolveObjectiveThread() { throw new Error("unexpected thread binding"); },
        async cancelObjective() { throw new Error("unexpected cancellation"); },
        async answerInteraction() { throw new Error("unexpected answer"); },
        async handleInteractionRequest() { throw new Error("unexpected interaction"); },
        async handleTurnCompleted() { throw new Error("unexpected completion"); }
      });
    }
  });

  const dispatch = fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 220, senderId: 3,
    body: {
      type: "DISPATCH", instruction: "Publish once.", constraints: [], acceptanceCriteria: [], reminders: [],
      objective: { mode: "NEW" }, topicModeAction: null
    }
  }));
  await firstStarted;
  const route = fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 221, senderId: 1,
    body: { type: "ROUTE", action: "SET", projectId: "beta" }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([dispatch, route]);

  assert.deepEqual(completed, [1, 2]);
});

test("close rejects new work and drains admitted execution through its queued publication", async (t) => {
  let releaseExecution;
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  const publications = [];
  const fixture = serviceFixture(t, {
    snapshotPublisher(options) {
      publications.push(options.generation);
      return { generation: options.generation };
    },
    turnControllerFactory() {
      return Object.freeze({
        async acceptIntent(options) {
          markExecutionStarted();
          await new Promise((resolve) => { releaseExecution = resolve; });
          return Object.freeze({
            status: "started", objectiveId: options.objectiveId, submissionId: "submission-close",
            threadId: "thread-close", turnId: "turn-close"
          });
        },
        async continueObjective() { throw new Error("unexpected continuation"); },
        async resolveObjectiveThread() { throw new Error("unexpected thread binding"); },
        async cancelObjective() { throw new Error("unexpected cancellation"); },
        async answerInteraction() { throw new Error("unexpected answer"); },
        async handleInteractionRequest() { throw new Error("unexpected interaction"); },
        async handleTurnCompleted() { throw new Error("unexpected completion"); }
      });
    }
  });

  const dispatch = fixture.service.handleBridgeEvent(fixture.event({
    kind: "SEMANTIC", sourceMessageId: 230, senderId: 3,
    body: {
      type: "DISPATCH", instruction: "Finish before close.", constraints: [], acceptanceCriteria: [], reminders: [],
      objective: { mode: "NEW" }, topicModeAction: null
    }
  }));
  await executionStarted;
  let closeResolved = false;
  const closing = fixture.service.close().then(() => { closeResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const resolvedBeforeRelease = closeResolved;
  const eventError = await fixture.service.handleBridgeEvent(fixture.event({
    sourceMessageId: 231, senderId: 2, body: { type: "ROUTE", action: "SHOW" }
  })).then(() => null, (error) => error);
  const publicationError = await fixture.service.publishSnapshot().then(() => null, (error) => error);

  releaseExecution();
  await Promise.all([dispatch, closing]);

  assert.equal(resolvedBeforeRelease, false);
  assert.equal(eventError?.code, "HCO_SERVICE_CLOSED");
  assert.equal(publicationError?.code, "HCO_SERVICE_CLOSED");
  assert.deepEqual(publications, [0]);
});

test("legacy stream-name routes and Runner task IDs have no HCO authority", (t) => {
  const fixture = serviceFixture(t);
  const legacyPath = path.join(path.dirname(fixture.databasePath), "state.json");
  writeFileSync(legacyPath, JSON.stringify({
    defaultProjectId: "alpha",
    zulipStreamProjectRoutes: { "alpha team": "alpha" },
    zulipGenericStreams: ["general"],
    zulipTopicModes: {
      "Alpha Team/Build": { mode: "CODEX_BOUND", taskId: "runner-task-legacy" }
    },
    bindings: {
      "Alpha Team/Build": { projectId: "alpha", taskId: "runner-task-legacy" }
    }
  }));

  assert.deepEqual(fixture.service.resolveRoute(777), {
    streamId: 777, owner: "HERMES", projectId: null, source: "default"
  });
  assert.deepEqual(fixture.service.readTopic({ streamId: 777, topic: "Build" }), {
    streamId: 777, topic: "Build", mode: "AUTO", projectId: null, objectiveId: null, threadId: null
  });
  assert.equal(fixture.store.readObjectiveProject("runner-task-legacy"), null);
  assert.equal(fixture.store.readObjectiveExecution("runner-task-legacy"), null);
  assert.deepEqual(fixture.calls, {
    accept: [], continue: [], bind: [], cancel: [], answer: [], interaction: [], completion: [], reconcile: []
  });
});
