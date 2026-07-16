import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const MAX_ROUTES = 4096;
const MAX_TOPICS = 2048;
const MAX_SNAPSHOT_BYTES = 262_144;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeNonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createRouteResolver({ projects, runtimeRoutes } = {}) {
  if (!Array.isArray(projects) || !Array.isArray(runtimeRoutes)) throw routeError("ROUTE_CONFIG_INVALID", "Route configuration is invalid.");
  const knownProjects = new Set();
  const staticRoutes = new Map();
  for (const project of projects) {
    if (typeof project?.projectId !== "string" || !Array.isArray(project.staticStreamIds) || knownProjects.has(project.projectId)) {
      throw routeError("ROUTE_CONFIG_INVALID", "Route configuration is invalid.");
    }
    knownProjects.add(project.projectId);
    for (const streamId of project.staticStreamIds) {
      if (!positive(streamId) || staticRoutes.has(streamId)) throw routeError("ROUTE_CONFIG_INVALID", "Route configuration is invalid.");
      staticRoutes.set(streamId, project.projectId);
    }
  }
  const runtime = new Map();
  for (const row of runtimeRoutes) {
    const kind = row?.kind ?? row?.overrideKind;
    if (!positive(row?.streamId) || runtime.has(row.streamId) || !["project", "hermes"].includes(kind) ||
        (kind === "project" && !knownProjects.has(row.projectId)) || (kind === "hermes" && row.projectId != null)) {
      throw routeError("ROUTE_CONFIG_INVALID", "Route configuration is invalid.");
    }
    runtime.set(row.streamId, { kind, projectId: row.projectId ?? null });
  }
  return Object.freeze({
    resolve(streamId) {
      if (!positive(streamId)) throw routeError("ROUTE_STREAM_INVALID", "Numeric stream ID is invalid.");
      const override = runtime.get(streamId);
      if (override) return Object.freeze({
        streamId,
        owner: override.kind === "project" ? "PROJECT" : "HERMES",
        projectId: override.projectId,
        source: "runtime"
      });
      const projectId = staticRoutes.get(streamId);
      if (projectId) return Object.freeze({ streamId, owner: "PROJECT", projectId, source: "static" });
      return Object.freeze({ streamId, owner: "HERMES", projectId: null, source: "default" });
    }
  });
}

function validatePayload(payload, now) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !== "defaultOwner,generatedAtMs,generation,routes,schemaVersion,validUntilMs" ||
      payload.schemaVersion !== 1 || payload.defaultOwner !== "HERMES" || !safeNonNegative(payload.generation) ||
      !safeNonNegative(payload.generatedAtMs) || !safeNonNegative(payload.validUntilMs) ||
      payload.validUntilMs <= payload.generatedAtMs || payload.generatedAtMs > now + 30_000 || now > payload.validUntilMs ||
      !Array.isArray(payload.routes) || payload.routes.length > MAX_ROUTES) {
    throw routeError(now > payload?.validUntilMs ? "ROUTE_SNAPSHOT_STALE" : "ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
  }
  let topicCount = 0;
  let priorStream = 0;
  for (const route of payload.routes) {
    if (route === null || typeof route !== "object" || Array.isArray(route) ||
        Object.keys(route).sort().join(",") !== "owner,projectId,source,streamId,topics" ||
        !positive(route.streamId) || route.streamId <= priorStream || !["PROJECT", "HERMES"].includes(route.owner) ||
        !["runtime", "static", "default"].includes(route.source) || !Array.isArray(route.topics) ||
        (route.owner === "PROJECT"
          ? typeof route.projectId !== "string" || !PROJECT_ID.test(route.projectId)
          : route.projectId !== null)) {
      throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
    }
    priorStream = route.streamId;
    let priorTopic = null;
    for (const topic of route.topics) {
      if (typeof topic?.topic !== "string" || topic.topic.length === 0 || Buffer.byteLength(topic.topic, "utf8") > 256 ||
          !["HERMES_ONLY", "CODEX_BOUND"].includes(topic.mode) ||
          Object.keys(topic).sort().join(",") !== "mode,topic" ||
          (priorTopic !== null && compareUtf8(priorTopic, topic.topic) >= 0)) {
        throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
      }
      priorTopic = topic.topic;
      topicCount += 1;
    }
  }
  if (topicCount > MAX_TOPICS) throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
}

function buildSnapshot({ generation, routes, topicModes, now, ttlMs }) {
  const generatedAtMs = now();
  if (!safeNonNegative(generation) || !safeNonNegative(generatedAtMs) || !Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
    throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot options are invalid.");
  }
  const grouped = new Map();
  for (const row of topicModes) {
    if (row.mode === "AUTO") continue;
    if (!grouped.has(row.streamId)) grouped.set(row.streamId, []);
    grouped.get(row.streamId).push({ topic: row.topic, mode: row.mode });
  }
  const cleanRoutes = routes.map((route) => ({
    streamId: route.streamId,
    owner: route.owner,
    projectId: route.owner === "PROJECT" ? route.projectId : null,
    source: route.source,
    topics: (grouped.get(route.streamId) ?? []).sort((a, b) => compareUtf8(a.topic, b.topic))
  })).sort((a, b) => a.streamId - b.streamId);
  const payload = {
    schemaVersion: 1,
    generation,
    generatedAtMs,
    validUntilMs: generatedAtMs + ttlMs,
    defaultOwner: "HERMES",
    routes: cleanRoutes
  };
  validatePayload(payload, generatedAtMs);
  const digest = createHash("sha256").update(canonical(payload), "utf8").digest("hex");
  return { ...payload, integrity: { algorithm: "sha256", canonicalPayloadSha256: digest } };
}

export function publishRouteSnapshot({
  snapshotPath,
  generation,
  routes,
  topicModes,
  now = Date.now,
  ttlMs = 60_000,
  maxBytes = MAX_SNAPSHOT_BYTES,
  write = writeSync
} = {}) {
  if (typeof snapshotPath !== "string" || !path.isAbsolute(snapshotPath) || !Array.isArray(routes) || !Array.isArray(topicModes) ||
      typeof now !== "function" || typeof write !== "function" ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SNAPSHOT_BYTES) {
    throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot options are invalid.");
  }
  let target;
  try { target = lstatSync(snapshotPath); } catch (error) { if (error?.code !== "ENOENT") throw routeError("ROUTE_SNAPSHOT_PUBLISH_FAILED", "Route snapshot publication failed."); }
  if (target && (!target.isFile() || target.isSymbolicLink())) throw routeError("ROUTE_SNAPSHOT_PUBLISH_FAILED", "Route snapshot publication failed.");
  const snapshot = buildSnapshot({ generation, routes, topicModes, now, ttlMs });
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  if (bytes.length > maxBytes) throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot exceeds the size limit.");
  const directory = path.dirname(snapshotPath);
  const temporary = path.join(directory, `.${path.basename(snapshotPath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = write(descriptor, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw routeError("ROUTE_SNAPSHOT_PUBLISH_FAILED", "Route snapshot publication failed.");
      }
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, snapshotPath);
    const directoryFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw routeError("ROUTE_SNAPSHOT_PUBLISH_FAILED", "Route snapshot publication failed.");
  }
  return Object.freeze({ generation, generatedAtMs: snapshot.generatedAtMs, validUntilMs: snapshot.validUntilMs, bytes: bytes.length });
}

export function validateRouteSnapshot(bytes, { now = Date.now, maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  const data = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
  if (!data || data.length === 0 || data.length > maxBytes || data.at(-1) !== 10 || typeof now !== "function") {
    throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
  }
  let snapshot;
  try { snapshot = JSON.parse(data.subarray(0, -1).toString("utf8")); } catch { throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid."); }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      Object.keys(snapshot).sort().join(",") !== "defaultOwner,generatedAtMs,generation,integrity,routes,schemaVersion,validUntilMs" ||
      snapshot.integrity === null || typeof snapshot.integrity !== "object" || Array.isArray(snapshot.integrity) ||
      Object.keys(snapshot.integrity).sort().join(",") !== "algorithm,canonicalPayloadSha256" ||
      snapshot.integrity?.algorithm !== "sha256" || !/^[0-9a-f]{64}$/u.test(snapshot.integrity?.canonicalPayloadSha256 ?? "")) {
    throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot is invalid.");
  }
  const { integrity, ...payload } = snapshot;
  const digest = createHash("sha256").update(canonical(payload), "utf8").digest("hex");
  if (digest !== integrity.canonicalPayloadSha256) throw routeError("ROUTE_SNAPSHOT_INVALID", "Route snapshot integrity check failed.");
  validatePayload(payload, now());
  return deepFreeze(snapshot);
}
