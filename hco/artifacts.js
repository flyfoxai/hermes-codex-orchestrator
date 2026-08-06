import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { stateError } from "./state/reducer.js";

export const LEGACY_ARTIFACT_CAPABILITY = "artifact_manifest";
// Compatibility alias. This project-directory protocol is not managed file exchange and has no physical seal.
export const ARTIFACT_CAPABILITY = LEGACY_ARTIFACT_CAPABILITY;

const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS_PER_DIRECTION = 16;
const MAX_PATH_BYTES = 4096;
const MAX_TOKEN_BYTES = 128;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-fA-F0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MANIFEST_KEYS = Object.freeze(["input", "output"]);
const COMMON_KEYS = Object.freeze(["artifactId", "path", "kind", "mimeType", "maxBytes", "required", "sha256"]);
const PROJECT_LOCAL_PREFIX = ".hco/exchanges/v1/";
const PROJECT_LOCAL_TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain"]);

function artifactError(code, message) {
  throw stateError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function boundedText(value, maximum = MAX_TOKEN_BYTES) {
  return typeof value === "string" && value.trim().length > 0 &&
    byteLength(value) <= maximum && !CONTROL_CHARACTER.test(value);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeSha256(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !HASH.test(value)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact sha256 must be a 64-character hex digest.");
  }
  return value.toLowerCase();
}

function normalizeMaxBytes(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ARTIFACT_BYTES) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact maxBytes is invalid.");
  }
  return value;
}

function assertManifestList(value, direction) {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS_PER_DIRECTION ||
      Object.keys(value).length !== value.length) {
    artifactError("ARTIFACT_MANIFEST_INVALID", `Artifact ${direction} list is invalid.`);
  }
}

function assertSafePathText(value) {
  if (typeof value !== "string" || value.trim().length === 0 || byteLength(value) > MAX_PATH_BYTES ||
      CONTROL_CHARACTER.test(value)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact path is invalid.");
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "..")) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact path must stay within the project cwd.");
  }
}

function assertInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact path must stay within the project cwd.");
  }
}

function normalizeBaseDir(baseDir) {
  if (typeof baseDir !== "string" || baseDir.trim().length === 0 || !path.isAbsolute(baseDir)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact base directory is invalid.");
  }
  let realBase;
  try {
    realBase = realpathSync(baseDir);
    const status = lstatSync(realBase);
    if (!status.isDirectory()) {
      artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact base directory must be a directory.");
    }
  } catch (error) {
    if (error?.code === "ARTIFACT_MANIFEST_INVALID") throw error;
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact base directory is unavailable.");
  }
  return realBase;
}

function normalizeArtifactPath(rawPath, baseDir) {
  assertSafePathText(rawPath);
  const rawResolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(baseDir, rawPath);
  assertInside(baseDir, rawResolved);
  const relativePath = path.relative(baseDir, rawResolved);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact path must name a file inside the project cwd.");
  }
  return {
    path: relativePath.split(path.sep).join("/"),
    absolutePath: rawResolved
  };
}

function normalizeArtifactEntry(entry, direction, baseDir) {
  if (!isPlainObject(entry) || !exactKeys(entry, COMMON_KEYS)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact manifest entry is invalid.");
  }
  if (typeof entry.artifactId !== "string" || !ARTIFACT_ID.test(entry.artifactId)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact artifactId is invalid.");
  }
  if (!boundedText(entry.kind) || !boundedText(entry.mimeType)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact kind or mimeType is invalid.");
  }
  if (entry.required !== undefined && typeof entry.required !== "boolean") {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact required flag is invalid.");
  }
  const normalizedPath = normalizeArtifactPath(entry.path, baseDir);
  return Object.freeze({
    artifactId: entry.artifactId,
    direction,
    path: normalizedPath.path,
    absolutePath: normalizedPath.absolutePath,
    kind: entry.kind,
    mimeType: entry.mimeType,
    required: entry.required ?? true,
    maxBytes: normalizeMaxBytes(entry.maxBytes),
    expectedSha256: normalizeSha256(entry.sha256),
    observedSha256: null,
    observedBytes: null,
    state: "declared"
  });
}

function assertUniqueArtifactIds(entries, direction) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.artifactId)) {
      artifactError("ARTIFACT_MANIFEST_INVALID", `Duplicate ${direction} artifactId is invalid.`);
    }
    ids.add(entry.artifactId);
  }
}

export function validateArtifactManifestShape(manifest) {
  if (!isPlainObject(manifest) || !exactKeys(manifest, MANIFEST_KEYS)) {
    artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact manifest is invalid.");
  }
  assertManifestList(manifest.input, "input");
  assertManifestList(manifest.output, "output");
  for (const direction of MANIFEST_KEYS) {
    const ids = new Set();
    for (const entry of manifest[direction]) {
      if (!isPlainObject(entry) || !exactKeys(entry, COMMON_KEYS) ||
          typeof entry.artifactId !== "string" || !ARTIFACT_ID.test(entry.artifactId) ||
          !boundedText(entry.kind) || !boundedText(entry.mimeType) ||
          (entry.required !== undefined && typeof entry.required !== "boolean") ||
          (entry.maxBytes !== undefined &&
            (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes <= 0 || entry.maxBytes > MAX_ARTIFACT_BYTES)) ||
          (entry.sha256 !== undefined && (typeof entry.sha256 !== "string" || !HASH.test(entry.sha256)))) {
        artifactError("ARTIFACT_MANIFEST_INVALID", "Artifact manifest entry is invalid.");
      }
      if (direction === "input" || entry.path !== undefined) assertSafePathText(entry.path);
      if (ids.has(entry.artifactId)) {
        artifactError("ARTIFACT_MANIFEST_INVALID", `Duplicate ${direction} artifactId is invalid.`);
      }
      ids.add(entry.artifactId);
    }
  }
  return manifest;
}

export function normalizeArtifactManifest(manifest, { baseDir }) {
  validateArtifactManifestShape(manifest);
  const realBaseDir = normalizeBaseDir(baseDir);
  const input = manifest.input.map((entry) => normalizeArtifactEntry(entry, "input", realBaseDir));
  const output = manifest.output.map((entry) => normalizeArtifactEntry(entry, "output", realBaseDir));
  assertUniqueArtifactIds(input, "input");
  assertUniqueArtifactIds(output, "output");
  return Object.freeze({
    schemaVersion: 1,
    baseDir: realBaseDir,
    input: Object.freeze(input),
    output: Object.freeze(output)
  });
}

function observeEntry(entry, baseDir, { invalidCode }) {
  const projectLocal = entry.path.startsWith(PROJECT_LOCAL_PREFIX);
  const directionLabel = entry.direction === "input" ? "INPUT" : "OUTPUT";
  const changedCode = `PROJECT_LOCAL_${directionLabel}_CHANGED`;
  const invalidProjectLocalCode = `PROJECT_LOCAL_${directionLabel}_INVALID`;
  let status;
  try {
    status = lstatSync(entry.absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ...entry,
        state: "missing",
        ...(projectLocal && entry.direction === "output" ? { failureCode: "PROJECT_LOCAL_OUTPUT_MISSING" } : {})
      };
    }
    artifactError(invalidCode, "Artifact file cannot be inspected.");
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {}) };
  }
  let realFile;
  try {
    realFile = realpathSync(entry.absolutePath);
  } catch {
    return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {}) };
  }
  const relative = path.relative(baseDir, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {}) };
  }
  let descriptor;
  let content;
  try {
    descriptor = openSync(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStatus = fstatSync(descriptor);
    if (!openedStatus.isFile() || openedStatus.dev !== status.dev || openedStatus.ino !== status.ino) {
      return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: changedCode } : {}) };
    }
    if (openedStatus.size > entry.maxBytes) {
      return {
        ...entry,
        state: "invalid",
        observedBytes: openedStatus.size,
        ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {})
      };
    }
    content = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const currentPathStatus = lstatSync(entry.absolutePath);
    if (!currentPathStatus.isFile() || currentPathStatus.isSymbolicLink() ||
        afterRead.dev !== openedStatus.dev || afterRead.ino !== openedStatus.ino ||
        currentPathStatus.dev !== openedStatus.dev || currentPathStatus.ino !== openedStatus.ino ||
        afterRead.size !== openedStatus.size || afterRead.mtimeMs !== openedStatus.mtimeMs ||
        afterRead.ctimeMs !== openedStatus.ctimeMs) {
      return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: changedCode } : {}) };
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ...entry,
        state: "missing",
        ...(projectLocal && entry.direction === "output" ? { failureCode: "PROJECT_LOCAL_OUTPUT_MISSING" } : {})
      };
    }
    return { ...entry, state: "invalid", ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {}) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (content.byteLength > entry.maxBytes) {
    return {
      ...entry,
      state: "invalid",
      observedBytes: content.byteLength,
      ...(projectLocal ? { failureCode: invalidProjectLocalCode } : {})
    };
  }
  if (projectLocal) {
    if (!PROJECT_LOCAL_TEXT_MIME_TYPES.has(entry.mimeType) && entry.mimeType !== "application/json") {
      return { ...entry, state: "invalid", observedBytes: content.byteLength, failureCode: invalidProjectLocalCode };
    }
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (entry.mimeType === "application/json") JSON.parse(decoded);
    } catch {
      return { ...entry, state: "invalid", observedBytes: content.byteLength, failureCode: invalidProjectLocalCode };
    }
  }
  const observedSha256 = createHash("sha256").update(content).digest("hex");
  return {
    ...entry,
    observedSha256,
    observedBytes: content.byteLength,
    state: entry.expectedSha256 && entry.expectedSha256 !== observedSha256 ? "mismatch" : "verified",
    ...(projectLocal && entry.expectedSha256 && entry.expectedSha256 !== observedSha256
      ? { failureCode: entry.direction === "input" ? changedCode : invalidProjectLocalCode }
      : {})
  };
}

export function verifyInputArtifacts(manifest) {
  const verifiedInput = manifest.input.map((entry) => {
    const verified = observeEntry(entry, manifest.baseDir, { invalidCode: "ARTIFACT_INPUT_INVALID" });
    if (verified.state === "missing") {
      artifactError("ARTIFACT_INPUT_MISSING", "Declared input artifact is missing.");
    }
    if (verified.state === "invalid") {
      artifactError("ARTIFACT_INPUT_INVALID", "Declared input artifact is invalid.");
    }
    if (verified.state === "mismatch") {
      artifactError("ARTIFACT_INPUT_HASH_MISMATCH", "Declared input artifact sha256 does not match.");
    }
    return Object.freeze(verified);
  });
  return Object.freeze({
    ...manifest,
    input: Object.freeze(verifiedInput)
  });
}

export function verifyOutputArtifactRows(rows) {
  if (rows.length === 0) {
    return Object.freeze({ ok: true, rows: Object.freeze([]), failures: Object.freeze([]) });
  }
  const baseDir = rows[0].baseDir;
  const verifiedRows = rows.map((entry) => Object.freeze(observeEntry(entry, baseDir, {
    invalidCode: "ARTIFACT_OUTPUT_INVALID"
  })));
  const failures = verifiedRows.filter((entry) =>
    entry.required && entry.state !== "verified"
  );
  return Object.freeze({
    ok: failures.length === 0,
    rows: Object.freeze(verifiedRows),
    failures: Object.freeze(failures)
  });
}

export function verifyInputArtifactRows(rows) {
  if (rows.length === 0) {
    return Object.freeze({ ok: true, rows: Object.freeze([]), failures: Object.freeze([]) });
  }
  const baseDir = rows[0].baseDir;
  const verifiedRows = rows.map((entry) => {
    const baselineSha256 = entry.expectedSha256 ?? entry.observedSha256;
    const verified = observeEntry(
      { ...entry, expectedSha256: baselineSha256 },
      baseDir,
      { invalidCode: "ARTIFACT_INPUT_INVALID" }
    );
    if (entry.path.startsWith(PROJECT_LOCAL_PREFIX) && verified.state !== "verified" && !verified.failureCode) {
      return Object.freeze({ ...verified, failureCode: "PROJECT_LOCAL_INPUT_CHANGED" });
    }
    return Object.freeze(verified);
  });
  const failures = verifiedRows.filter((entry) => entry.required && entry.state !== "verified");
  return Object.freeze({
    ok: failures.length === 0,
    rows: Object.freeze(verifiedRows),
    failures: Object.freeze(failures)
  });
}

export function manifestFromRows(rows) {
  if (rows.length === 0) return null;
  const baseDir = rows[0].baseDir;
  const result = {
    schemaVersion: 1,
    baseDir,
    input: [],
    output: []
  };
  for (const row of rows) {
    result[row.direction].push({
      artifactId: row.artifactId,
      path: row.path,
      kind: row.kind,
      mimeType: row.mimeType,
      required: row.required,
      maxBytes: row.maxBytes,
      state: row.state,
      ...(row.expectedSha256 ? { expectedSha256: row.expectedSha256 } : {}),
      ...(row.observedSha256 ? { sha256: row.observedSha256 } : {}),
      ...(row.observedBytes !== null && row.observedBytes !== undefined ? { bytes: row.observedBytes } : {})
    });
  }
  return Object.freeze({
    schemaVersion: result.schemaVersion,
    baseDir: result.baseDir,
    input: Object.freeze(result.input.map(Object.freeze)),
    output: Object.freeze(result.output.map(Object.freeze))
  });
}

export function appendArtifactSummary(text, manifest) {
  if (!manifest || (manifest.input.length === 0 && manifest.output.length === 0)) return text;
  const lines = ["", "", "Artifact manifest:"];
  for (const direction of ["input", "output"]) {
    for (const artifact of manifest[direction]) {
      const details = [
        artifact.state,
        artifact.bytes === undefined ? null : `${artifact.bytes} bytes`,
        artifact.sha256 ? `sha256 ${artifact.sha256}` : null
      ].filter(Boolean).join(", ");
      lines.push(`- ${direction} ${artifact.artifactId}: ${artifact.path}${details ? ` (${details})` : ""}`);
    }
  }
  return `${text}${lines.join("\n")}`;
}

export function composeArtifactPromptSection(manifest) {
  if (!manifest || !isPlainObject(manifest) ||
      ((!Array.isArray(manifest.input) || manifest.input.length === 0) &&
        (!Array.isArray(manifest.output) || manifest.output.length === 0))) {
    return [];
  }
  const lines = [];
  for (const direction of ["input", "output"]) {
    for (const artifact of manifest[direction]) {
      const details = [
        artifact.kind,
        artifact.mimeType,
        artifact.required === false ? "optional" : "required",
        artifact.sha256 ? `sha256 ${artifact.sha256}` : null,
        artifact.maxBytes ? `max ${artifact.maxBytes} bytes` : null
      ].filter(Boolean).join(", ");
      lines.push(`${direction} ${artifact.artifactId}: ${artifact.path}${details ? ` (${details})` : ""}`);
    }
  }
  return lines;
}
