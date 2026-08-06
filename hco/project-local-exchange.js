import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync
} from "node:fs";
import path from "node:path";

import {
  normalizeArtifactManifest,
  validateArtifactManifestShape,
  verifyInputArtifacts
} from "./artifacts.js";
import { stateError } from "./state/reducer.js";

export const PROJECT_LOCAL_EXCHANGE_CAPABILITY = "project_local_exchange_v1";
export const PROJECT_LOCAL_EXCHANGE_PROFILE = "project_local/v1";
export const PROJECT_LOCAL_MAXIMUM_BYTES_PER_EXCHANGE = 64 * 1024 * 1024;
export const PROJECT_LOCAL_MAXIMUM_FILES_PER_EXCHANGE = 8;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const MAX_EXCHANGE_ATTEMPTS = 8;
const MAX_TOTAL_INPUT_BYTES = PROJECT_LOCAL_MAXIMUM_BYTES_PER_EXCHANGE;
const MAX_STATUS_BYTES = 64 * 1024;
const TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain"]);
const JSON_MIME_TYPE = "application/json";
const LOCAL_IGNORE_ROOTS = new Set();

function exchangeError(code, message) {
  throw stateError(code, message);
}

function assertToken(value, field) {
  if (typeof value !== "string" || !TOKEN.test(value) || WINDOWS_RESERVED_NAME.test(value)) {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", `Project-local ${field} is invalid.`);
  }
  return value;
}

function assertInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange escaped the canonical project root.");
  }
}

function canonicalDirectory(directory) {
  try {
    const real = realpathSync(directory);
    const status = lstatSync(real);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("not a directory");
    return real;
  } catch {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Canonical project root is unavailable.");
  }
}

function ensureDirectory(parent, name, canonicalRoot) {
  const target = path.join(parent, name);
  assertInside(canonicalRoot, target);
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange directory cannot be created.");
    }
  }
  try {
    const status = lstatSync(target);
    const real = realpathSync(target);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe directory");
    assertInside(canonicalRoot, real);
    return real;
  } catch (error) {
    if (error?.code === "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE") throw error;
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange directory is unsafe.");
  }
}

function createExchangeDirectory(canonicalRoot, workId, exchangeIdFactory) {
  const hco = ensureDirectory(canonicalRoot, ".hco", canonicalRoot);
  const exchanges = ensureDirectory(hco, "exchanges", canonicalRoot);
  const version = ensureDirectory(exchanges, "v1", canonicalRoot);
  const work = ensureDirectory(version, assertToken(workId, "work ID"), canonicalRoot);

  for (let attempt = 0; attempt < MAX_EXCHANGE_ATTEMPTS; attempt += 1) {
    const exchangeId = assertToken(exchangeIdFactory(), "exchange ID");
    const exchangeRoot = path.join(work, exchangeId);
    assertInside(canonicalRoot, exchangeRoot);
    try {
      mkdirSync(exchangeRoot, { mode: 0o700 });
      const inputRoot = ensureDirectory(exchangeRoot, "input", canonicalRoot);
      const outputRoot = ensureDirectory(exchangeRoot, "output", canonicalRoot);
      return { exchangeId, exchangeRoot: realpathSync(exchangeRoot), inputRoot, outputRoot };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (error?.code === "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE") throw error;
        exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange directory cannot be created.");
      }
    }
  }
  exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "A unique project-local exchange directory could not be allocated.");
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange file could not be written.");
    }
    offset += written;
  }
}

function publishExclusive(filePath, bytes, maximumBytes = MAX_TOTAL_INPUT_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange payload is outside the configured size limit.");
  }
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size !== bytes.length) throw new Error("short publication");
  } catch (error) {
    if (error?.code === "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE") throw error;
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange file cannot be published without replacement.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitEnvironment() {
  const environment = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete environment[key];
  }
  return environment;
}

function gitPath(root, ...arguments_) {
  const output = execFileSync("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000
  }).trim();
  if (!output || output.includes("\0") || output.includes("\n") || output.includes("\r")) throw new Error("invalid git path");
  return output;
}

function appendLocalExclude(excludePath, pattern) {
  let existing = Buffer.alloc(0);
  try {
    const status = lstatSync(excludePath);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 1024 * 1024) return false;
    existing = readFileSync(excludePath);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  if (existing.toString("utf8").split(/\r?\n/u).includes(pattern)) return true;
  const addition = Buffer.from(`${existing.length > 0 && existing.at(-1) !== 10 ? "\n" : ""}${pattern}\n`, "utf8");
  let descriptor;
  try {
    descriptor = openSync(
      excludePath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return false;
    let offset = 0;
    while (offset < addition.length) {
      const written = writeSync(descriptor, addition, offset, addition.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0) return false;
      offset += written;
    }
    fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureLocalGitIgnore(root) {
  if (LOCAL_IGNORE_ROOTS.has(root)) return;
  LOCAL_IGNORE_ROOTS.add(root);
  try {
    const topLevel = canonicalDirectory(gitPath(root, "rev-parse", "--show-toplevel"));
    const projectRelative = path.relative(topLevel, root);
    if (projectRelative.startsWith("..") || path.isAbsolute(projectRelative)) return;
    const rawExclude = gitPath(root, "rev-parse", "--git-path", "info/exclude");
    const excludePath = path.isAbsolute(rawExclude) ? path.normalize(rawExclude) : path.resolve(root, rawExclude);
    const prefix = projectRelative === "" ? "" : `${projectRelative.split(path.sep).join("/")}/`;
    appendLocalExclude(excludePath, `/${prefix}.hco/exchanges/`);
  } catch {
    // Non-Git projects and unavailable Git metadata do not block the exchange protocol.
  }
}

function decodeDocument(bytes, mimeType, direction) {
  if (!TEXT_MIME_TYPES.has(mimeType) && mimeType !== JSON_MIME_TYPE) {
    exchangeError(
      direction === "input" ? "PROJECT_LOCAL_INPUT_INVALID" : "PROJECT_LOCAL_OUTPUT_INVALID",
      `Project-local ${direction} MIME type is unsupported.`
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    exchangeError(
      direction === "input" ? "PROJECT_LOCAL_INPUT_INVALID" : "PROJECT_LOCAL_OUTPUT_INVALID",
      `Project-local ${direction} must be valid UTF-8.`
    );
  }
  if (mimeType === JSON_MIME_TYPE) {
    try {
      JSON.parse(text);
    } catch {
      exchangeError(
        direction === "input" ? "PROJECT_LOCAL_INPUT_INVALID" : "PROJECT_LOCAL_OUTPUT_INVALID",
        `Project-local ${direction} JSON is invalid.`
      );
    }
  }
  return text;
}

function readStableSource(entry, manifest) {
  let bytes;
  try {
    bytes = readFileSync(entry.absolutePath);
  } catch {
    exchangeError("PROJECT_LOCAL_INPUT_INVALID", "Project-local source document cannot be read.");
  }
  if (bytes.length > entry.maxBytes || sha256(bytes) !== entry.observedSha256) {
    exchangeError("PROJECT_LOCAL_INPUT_CHANGED", "Project-local source document changed while the exchange was staged.");
  }
  let reverified;
  try {
    reverified = verifyInputArtifacts(manifest).input.find((candidate) => candidate.artifactId === entry.artifactId);
  } catch {
    exchangeError("PROJECT_LOCAL_INPUT_CHANGED", "Project-local source document changed while the exchange was staged.");
  }
  if (!reverified || reverified.observedSha256 !== entry.observedSha256) {
    exchangeError("PROJECT_LOCAL_INPUT_CHANGED", "Project-local source document changed while the exchange was staged.");
  }
  return { bytes, text: decodeDocument(bytes, entry.mimeType, "input") };
}

function outputFileNames(entries) {
  let textCount = 0;
  let jsonCount = 0;
  return entries.map((entry) => {
    if (TEXT_MIME_TYPES.has(entry.mimeType)) {
      textCount += 1;
      return textCount === 1 ? "result.md" : `result-${String(textCount).padStart(3, "0")}.md`;
    }
    if (entry.mimeType === JSON_MIME_TYPE) {
      jsonCount += 1;
      return jsonCount === 1 ? "evidence.json" : `evidence-${String(jsonCount).padStart(3, "0")}.json`;
    }
    exchangeError("PROJECT_LOCAL_OUTPUT_INVALID", "Project-local output MIME type is unsupported.");
  });
}

function artifactEntry({ artifactId, relativePath, kind, mimeType, required = true, maxBytes, digest }) {
  return {
    artifactId,
    path: relativePath,
    kind,
    mimeType,
    required,
    maxBytes,
    ...(digest ? { sha256: digest } : {})
  };
}

function composeContext(contextText, sources) {
  const sections = ["# HCO task context", "", contextText.trim()];
  for (const source of sources) {
    sections.push(
      "",
      `## Source document: ${source.artifactId}`,
      "",
      `Media type: ${source.mimeType}`,
      "",
      source.text
    );
  }
  return `${sections.join("\n")}\n`;
}

function relativeFile(canonicalRoot, absolutePath) {
  assertInside(canonicalRoot, absolutePath);
  return path.relative(canonicalRoot, absolutePath).split(path.sep).join("/");
}

export function prepareProjectLocalExchange({
  canonicalRoot,
  projectId,
  workId,
  exchangeIdFactory,
  sourceManifest,
  contextText,
  taskContract,
  now = Date.now
} = {}) {
  const timestamp = typeof now === "function" ? now() : Number.NaN;
  if (typeof exchangeIdFactory !== "function" || typeof contextText !== "string" || contextText.trim().length === 0 ||
      taskContract === null || typeof taskContract !== "object" || Array.isArray(taskContract) ||
      !Number.isSafeInteger(timestamp) || timestamp < 0) {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange request is invalid.");
  }
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local project ID is invalid.");
  }
  const safeWorkId = assertToken(workId, "work ID");
  validateArtifactManifestShape(sourceManifest);
  const root = canonicalDirectory(canonicalRoot);
  ensureLocalGitIgnore(root);
  const normalizedSourceManifest = {
    input: sourceManifest.input,
    output: sourceManifest.output.map((entry, index) => (
      entry.path === undefined
        ? { ...entry, path: `.hco/project-local-output-declaration-${String(index + 1).padStart(3, "0")}` }
        : entry
    ))
  };
  const normalized = verifyInputArtifacts(normalizeArtifactManifest(normalizedSourceManifest, { baseDir: root }));
  if (normalized.output.length + 2 > PROJECT_LOCAL_MAXIMUM_FILES_PER_EXCHANGE) {
    exchangeError("PROJECT_LOCAL_OUTPUT_INVALID", "Project-local exchange declares too many output files.");
  }
  const outputNames = outputFileNames(normalized.output);
  const sourceDocuments = normalized.input.map((entry) => ({
    artifactId: entry.artifactId,
    kind: entry.kind,
    mimeType: entry.mimeType,
    maxBytes: entry.maxBytes,
    sha256: entry.observedSha256,
    ...readStableSource(entry, normalized)
  }));
  const totalSourceBytes = sourceDocuments.reduce((total, source) => total + source.bytes.length, 0);
  if (totalSourceBytes > MAX_TOTAL_INPUT_BYTES) {
    exchangeError("PROJECT_LOCAL_INPUT_INVALID", "Project-local inputs exceed the total size limit.");
  }

  const contextBytes = Buffer.from(composeContext(contextText, sourceDocuments), "utf8");
  const outputContract = normalized.output.map((entry, index) => ({
    artifactId: entry.artifactId,
    kind: entry.kind,
    mimeType: entry.mimeType,
    required: entry.required,
    maxBytes: entry.maxBytes,
    fileName: outputNames[index],
    ...(entry.expectedSha256 ? { expectedSha256: entry.expectedSha256 } : {})
  }));
  const sourceContract = sourceDocuments.map(({ bytes, text, ...source }) => ({
    ...source,
    bytes: bytes.length
  }));
  const serializeContract = (exchangeId) => JSON.stringify({
    schemaVersion: 1,
    exchangeMode: PROJECT_LOCAL_EXCHANGE_PROFILE,
    workId: safeWorkId,
    exchangeId,
    projectId,
    task: taskContract,
    sourceDocuments: sourceContract,
    outputs: outputContract
  }, null, 2);
  const declaredOutputBytes = normalized.output.reduce((total, entry) => total + entry.maxBytes, 0);
  let maximumContractBytes;
  try {
    maximumContractBytes = Buffer.byteLength(`${serializeContract("x".repeat(192))}\n`, "utf8");
  } catch {
    exchangeError("PROJECT_LOCAL_INPUT_INVALID", "Project-local task contract is not valid JSON data.");
  }
  if (contextBytes.length + maximumContractBytes + declaredOutputBytes > PROJECT_LOCAL_MAXIMUM_BYTES_PER_EXCHANGE) {
    exchangeError("PROJECT_LOCAL_INPUT_INVALID", "Project-local exchange exceeds the total size limit.");
  }

  const allocated = createExchangeDirectory(root, safeWorkId, exchangeIdFactory);
  const relativeRoot = relativeFile(root, allocated.exchangeRoot);
  const output = normalized.output.map((entry, index) => artifactEntry({
    artifactId: entry.artifactId,
    relativePath: `${relativeRoot}/output/${outputNames[index]}`,
    kind: entry.kind,
    mimeType: entry.mimeType,
    required: entry.required,
    maxBytes: entry.maxBytes,
    digest: entry.expectedSha256
  }));
  let contractBytes;
  try {
    contractBytes = Buffer.from(`${serializeContract(allocated.exchangeId)}\n`, "utf8");
  } catch {
    exchangeError("PROJECT_LOCAL_INPUT_INVALID", "Project-local task contract is not valid JSON data.");
  }

  const contextPath = path.join(allocated.inputRoot, "context.md");
  const contractPath = path.join(allocated.inputRoot, "task-contract.json");
  publishExclusive(contextPath, contextBytes);
  publishExclusive(contractPath, contractBytes);

  const input = [
    artifactEntry({
      artifactId: "hco-context",
      relativePath: relativeFile(root, contextPath),
      kind: "context",
      mimeType: "text/markdown",
      maxBytes: contextBytes.length,
      digest: sha256(contextBytes)
    }),
    artifactEntry({
      artifactId: "hco-task-contract",
      relativePath: relativeFile(root, contractPath),
      kind: "task-contract",
      mimeType: JSON_MIME_TYPE,
      maxBytes: contractBytes.length,
      digest: sha256(contractBytes)
    })
  ];
  const status = {
    schemaVersion: 1,
    exchangeMode: PROJECT_LOCAL_EXCHANGE_PROFILE,
    workId,
    exchangeId: allocated.exchangeId,
    projectId,
    state: "READY",
    updatedAtMs: timestamp
  };
  publishExclusive(
    path.join(allocated.exchangeRoot, "status.json"),
    Buffer.from(`${JSON.stringify(status, null, 2)}\n`, "utf8"),
    MAX_STATUS_BYTES
  );

  const artifacts = Object.freeze({ input: Object.freeze(input.map(Object.freeze)), output: Object.freeze(output.map(Object.freeze)) });
  return Object.freeze({
    schemaVersion: 1,
    exchangeMode: PROJECT_LOCAL_EXCHANGE_PROFILE,
    projectId,
    workId,
    exchangeId: allocated.exchangeId,
    relativeRoot,
    absoluteRoot: allocated.exchangeRoot,
    artifacts,
    manifest: Object.freeze({
      schemaVersion: 1,
      exchangeMode: PROJECT_LOCAL_EXCHANGE_PROFILE,
      workId,
      exchangeId: allocated.exchangeId,
      projectId,
      relativeRoot,
      inputManifestDigest: sha256(Buffer.from(JSON.stringify(input), "utf8")),
      state: "AVAILABLE"
    })
  });
}

export function composeProjectLocalPrompt(exchange) {
  if (!exchange || exchange.exchangeMode !== PROJECT_LOCAL_EXCHANGE_PROFILE || typeof exchange.relativeRoot !== "string") {
    exchangeError("PROJECT_LOCAL_EXCHANGE_UNAVAILABLE", "Project-local exchange prompt cannot be composed.");
  }
  const outputs = exchange.artifacts.output.map((entry) => `Required output ${entry.artifactId}: ${entry.path}`);
  return [
    `Task context: ${exchange.relativeRoot}/input/context.md`,
    `Task contract: ${exchange.relativeRoot}/input/task-contract.json`,
    "Read both files before working.",
    exchange.artifacts.output.length === 0
      ? "Return the final answer normally; no exchange output file is required."
      : `Write only the declared exchange outputs under ${exchange.relativeRoot}/output/.`,
    ...outputs,
    "Do not modify input/ and do not create or reuse another exchange directory.",
    "This project-local exchange is not a sandbox; normal project permissions still apply."
  ].join("\n");
}

export function updateProjectLocalExchangeStatus(rows, { state, errorCode = null, now = Date.now } = {}) {
  if (!Array.isArray(rows) || !["OUTPUT_PENDING", "AVAILABLE", "ERROR"].includes(state) ||
      (errorCode !== null && (typeof errorCode !== "string" || !TOKEN.test(errorCode))) || typeof now !== "function") {
    return false;
  }
  const row = rows.find((entry) => typeof entry?.path === "string" && entry.path.startsWith(".hco/exchanges/v1/"));
  if (!row || typeof row.baseDir !== "string") return false;
  const segments = row.path.split("/");
  if (segments.length < 7 || segments[0] !== ".hco" || segments[1] !== "exchanges" || segments[2] !== "v1") {
    return false;
  }
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return false;
  try {
    const root = canonicalDirectory(row.baseDir);
    const exchangeRoot = path.join(root, ...segments.slice(0, 5));
    assertInside(root, exchangeRoot);
    const realExchangeRoot = realpathSync(exchangeRoot);
    assertInside(root, realExchangeRoot);
    const statusPath = path.join(realExchangeRoot, "status.json");
    const currentBytes = readFileSync(statusPath);
    if (currentBytes.length === 0 || currentBytes.length > MAX_STATUS_BYTES) return false;
    const current = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes));
    if (current?.schemaVersion !== 1 || current.exchangeMode !== PROJECT_LOCAL_EXCHANGE_PROFILE ||
        current.workId !== segments[3] || current.exchangeId !== segments[4]) return false;
    const updated = {
      ...current,
      state,
      updatedAtMs: timestamp,
      ...(errorCode ? { errorCode } : {})
    };
    if (!errorCode) delete updated.errorCode;
    const temporaryPath = path.join(realExchangeRoot, `.status-${randomUUID()}.tmp`);
    publishExclusive(temporaryPath, Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8"), MAX_STATUS_BYTES);
    renameSync(temporaryPath, statusPath);
    return true;
  } catch {
    return false;
  }
}
