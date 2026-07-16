import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const CONFIG_MAX_BYTES = 262_144;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TOP_FIELDS = new Set(["version", "codexExecutablePath", "databasePath", "bridge", "snapshot", "admins", "projects"]);
const BRIDGE_FIELDS = new Set(["tokenPath", "contextKeyPath", "socketPath", "routeSnapshotPath"]);
const SNAPSHOT_FIELDS = new Set(["ttlMs", "maxBytes"]);
const PROJECT_FIELDS = new Set(["projectId", "cwd", "backend", "staticStreamIds", "acl", "threadOptions"]);
const ACL_FIELDS = new Set(["viewers", "contributors", "maintainers"]);
const THREAD_FIELDS = new Set(["model", "approvalPolicy", "sandbox", "baseInstructions", "developerInstructions"]);

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, required = fields) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !fields.has(key))) return false;
  return [...required].every((key) => Object.hasOwn(value, key));
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateIdArray(value) {
  if (!Array.isArray(value) || value.length > 4096 || Object.keys(value).length !== value.length) return null;
  if (value.some((entry) => !positiveId(entry)) || new Set(value).size !== value.length) return null;
  return [...value];
}

function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && Buffer.byteLength(value, "utf8") <= 4096;
}

function ownerFile(filePath, maxBytes, code) {
  let status;
  try {
    status = lstatSync(filePath);
  } catch {
    throw configError(code, "Owner file is invalid.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : status.uid;
  if (!status.isFile() || status.isSymbolicLink() || status.uid !== uid ||
      (status.mode & 0o077) !== 0 || (status.mode & 0o400) === 0 || status.size > maxBytes) {
    throw configError(code, "Owner file is invalid.");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino || opened.size > maxBytes) {
      throw configError(code, "Owner file is invalid.");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalid() {
  throw configError("HCO_CONFIG_INVALID", "HCO configuration is invalid.");
}

export function loadHcoConfig({ configPath, env = process.env } = {}) {
  if (!absolutePath(configPath) || env === null || typeof env !== "object") invalid();
  const bytes = ownerFile(configPath, CONFIG_MAX_BYTES, "HCO_CONFIG_FILE_INVALID");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid();
  }
  if (!exactObject(raw, TOP_FIELDS, new Set(["version", "codexExecutablePath", "databasePath", "bridge", "admins", "projects"])) ||
      raw.version !== 1 || !absolutePath(raw.codexExecutablePath) || !absolutePath(raw.databasePath) ||
      !exactObject(raw.bridge, BRIDGE_FIELDS) ||
      [...BRIDGE_FIELDS].some((field) => !absolutePath(raw.bridge[field])) ||
      !Array.isArray(raw.projects) || raw.projects.length > 256) invalid();

  const admins = validateIdArray(raw.admins);
  if (!admins) invalid();
  const snapshot = raw.snapshot ?? { ttlMs: 60_000, maxBytes: 262_144 };
  if (!exactObject(snapshot, SNAPSHOT_FIELDS) || !Number.isSafeInteger(snapshot.ttlMs) ||
      snapshot.ttlMs < 5_000 || snapshot.ttlMs > 300_000 ||
      !Number.isSafeInteger(snapshot.maxBytes) || snapshot.maxBytes <= 0 || snapshot.maxBytes > 262_144) invalid();

  const projectIds = new Set();
  const canonicalCwds = new Set();
  const streamIds = new Set();
  let totalStreams = 0;
  const projects = raw.projects.map((project) => {
    if (!exactObject(project, PROJECT_FIELDS, new Set(["projectId", "cwd", "staticStreamIds", "acl"])) ||
        typeof project.projectId !== "string" || !PROJECT_ID.test(project.projectId) ||
        projectIds.has(project.projectId) || !absolutePath(project.cwd) ||
        (project.backend !== undefined && !["app-server", "tmux"].includes(project.backend)) ||
        !exactObject(project.acl, ACL_FIELDS)) invalid();
    const staticStreamIds = validateIdArray(project.staticStreamIds);
    const viewers = validateIdArray(project.acl.viewers);
    const contributors = validateIdArray(project.acl.contributors);
    const maintainers = validateIdArray(project.acl.maintainers);
    if (!staticStreamIds || !viewers || !contributors || !maintainers) invalid();
    totalStreams += staticStreamIds.length;
    if (totalStreams > 4096 || staticStreamIds.some((id) => streamIds.has(id))) invalid();

    let cwd;
    try {
      cwd = realpathSync(project.cwd);
      if (!lstatSync(cwd).isDirectory() || !path.isAbsolute(cwd)) invalid();
    } catch (error) {
      if (error?.code === "HCO_CONFIG_INVALID") throw error;
      invalid();
    }
    if (canonicalCwds.has(cwd)) invalid();

    const threadOptions = project.threadOptions ?? {};
    if (!exactObject(threadOptions, THREAD_FIELDS, new Set()) || Object.values(threadOptions).some((value) =>
      typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16_384)) invalid();
    projectIds.add(project.projectId);
    canonicalCwds.add(cwd);
    staticStreamIds.forEach((id) => streamIds.add(id));
    return {
      projectId: project.projectId,
      cwd,
      backend: project.backend ?? "app-server",
      staticStreamIds,
      acl: { viewers, contributors, maintainers },
      threadOptions: { ...threadOptions }
    };
  });

  return deepFreeze({
    version: 1,
    codexExecutablePath: raw.codexExecutablePath,
    databasePath: raw.databasePath,
    bridge: { ...raw.bridge },
    snapshot: { ttlMs: snapshot.ttlMs, maxBytes: snapshot.maxBytes },
    admins,
    projects
  });
}

export function loadOwnerSecret({ path: secretPath, minBytes = 32, maxBytes = 4096 } = {}) {
  if (!absolutePath(secretPath) || !Number.isSafeInteger(minBytes) || !Number.isSafeInteger(maxBytes) ||
      minBytes <= 0 || maxBytes < minBytes || maxBytes > 4096) {
    throw configError("HCO_SECRET_OPTIONS_INVALID", "Secret loading options are invalid.");
  }
  const bytes = ownerFile(secretPath, maxBytes, "HCO_SECRET_FILE_INVALID");
  if (bytes.length < minBytes || bytes.length > maxBytes) {
    throw configError("HCO_SECRET_FILE_INVALID", "Owner secret file is invalid.");
  }
  return Buffer.from(bytes);
}
