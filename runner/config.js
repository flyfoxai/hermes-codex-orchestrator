import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let projectConfigTail = Promise.resolve();

export const ROOT_DIR = path.resolve(__dirname, "..");
export const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const TEMPLATE_DIR = path.join(ROOT_DIR, "templates");

function orchestratorConfigPath() {
  return path.resolve(process.env.HCO_ORCHESTRATOR_CONFIG || process.env.HCO_CONFIG || path.join(CONFIG_DIR, "orchestrator.json"));
}

function projectsConfigPath() {
  return path.resolve(process.env.HCO_PROJECTS_CONFIG || path.join(CONFIG_DIR, "projects.json"));
}

const DEFAULT_ORCHESTRATOR = {
  host: "127.0.0.1",
  port: 8731,
  authMode: "token",
  maxBodyBytes: 1048576,
  defaultLanguage: "zh-CN",
  codexPath: "codex",
  pathEnv: "$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  tmuxPrefix: "codex",
  taskIdPrefix: "HERMES",
  dispatchDelayMs: 1500,
  pasteSubmitDelayMs: 150,
  logLevel: "info",
  allowProjectRegistration: true
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function withProjectConfigMutex(operation) {
  const previous = projectConfigTail;
  let release;
  projectConfigTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function loadOrchestratorConfig() {
  const config = await readJson(orchestratorConfigPath(), DEFAULT_ORCHESTRATOR);
  const merged = { ...DEFAULT_ORCHESTRATOR, ...config };
  const portValue = process.env.HCO_PORT;
  if (portValue !== undefined) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error("HCO_PORT must be an integer between 1 and 65535."), {
        code: "invalid_config",
        status: 500
      });
    }
    merged.port = port;
  }
  if (process.env.HCO_HOST !== undefined) {
    if (process.env.HCO_HOST.trim() === "") {
      throw Object.assign(new Error("HCO_HOST must not be empty."), { code: "invalid_config", status: 500 });
    }
    merged.host = process.env.HCO_HOST;
  }
  const authMode = process.env.HCO_AUTH_MODE ?? "token";
  if (authMode !== "token" && authMode !== "none") {
    throw Object.assign(new Error("HCO_AUTH_MODE must be token or none."), {
      code: "invalid_config",
      status: 500
    });
  }
  if (authMode === "token" && !process.env.HCO_API_TOKEN) {
    throw Object.assign(new Error("HCO_API_TOKEN is required when HCO_AUTH_MODE=token."), {
      code: "invalid_config",
      status: 500
    });
  }
  if (authMode === "none" && merged.host !== "127.0.0.1" && merged.host !== "::1") {
    throw Object.assign(new Error("HCO_AUTH_MODE=none is allowed only on 127.0.0.1 or ::1."), {
      code: "invalid_config",
      status: 500
    });
  }
  const maxBodyValue = process.env.HCO_MAX_BODY_BYTES;
  if (maxBodyValue !== undefined) {
    if (!/^\d+$/.test(maxBodyValue)) {
      throw Object.assign(new Error("HCO_MAX_BODY_BYTES must be an integer between 1 and 16777216."), {
        code: "invalid_config",
        status: 500
      });
    }
    const maxBodyBytes = Number(maxBodyValue);
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 16777216) {
      throw Object.assign(new Error("HCO_MAX_BODY_BYTES must be an integer between 1 and 16777216."), {
        code: "invalid_config",
        status: 500
      });
    }
    merged.maxBodyBytes = maxBodyBytes;
  }
  merged.authMode = authMode;
  merged.apiToken = authMode === "token" ? process.env.HCO_API_TOKEN : null;
  return merged;
}

export async function loadProjectsConfig() {
  const config = await readJson(projectsConfigPath(), { projects: {} });
  return { projects: config.projects ?? {} };
}

export async function saveProjectsConfig(config) {
  await writeJsonAtomic(projectsConfigPath(), { projects: config.projects ?? {} });
}

export function validateProjectId(projectId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(projectId ?? "")) {
    throw Object.assign(new Error("Invalid projectId."), { code: "invalid_project_id", status: 400 });
  }
}

export function validateTaskId(taskId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(taskId ?? "")) {
    throw Object.assign(new Error("Invalid taskId."), { code: "invalid_task_id", status: 400 });
  }
}

function invalidField(field, message) {
  throw Object.assign(new Error(message), {
    code: "invalid_request",
    status: 400,
    details: { field }
  });
}

export function validateProjectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalidField("body", "Request body must be a JSON object.");
  }
  const projectPath = input.path ?? input.projectPath;
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    invalidField("path", "Project path is required.");
  }
  if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim() === "")) {
    invalidField("name", "Project name must be a non-empty string.");
  }
  for (const field of ["tmuxSession", "language", "concurrency"]) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      invalidField(field, `${field} must be a string.`);
    }
  }
  for (const field of ["allowCodeChanges", "allowNetwork"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      invalidField(field, `${field} must be a boolean.`);
    }
  }
}

export function normalizeProject(projectId, input, orchestrator) {
  validateProjectId(projectId);
  const projectPath = input.path ?? input.projectPath;
  if (!projectPath || typeof projectPath !== "string") {
    throw Object.assign(new Error("Project path is required."), { code: "invalid_project_path", status: 400 });
  }
  const tmuxSession = input.tmuxSession ?? `${orchestrator.tmuxPrefix}-${projectId}`;
  if (typeof tmuxSession !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(tmuxSession)) {
    invalidField(
      "tmuxSession",
      "tmuxSession must be 1-64 characters using letters, numbers, underscores, or hyphens."
    );
  }
  return {
    projectId,
    name: input.name ?? projectId,
    path: path.resolve(projectPath),
    tmuxSession,
    allowCodeChanges: input.allowCodeChanges !== false,
    allowNetwork: input.allowNetwork !== false,
    concurrency: input.concurrency ?? "single-writer",
    language: input.language ?? orchestrator.defaultLanguage,
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export async function upsertProject(projectId, input) {
  validateProjectInput(input);
  const orchestrator = await loadOrchestratorConfig();
  if (!orchestrator.allowProjectRegistration) {
    throw Object.assign(new Error("Project registration is disabled."), { code: "project_registration_disabled", status: 403 });
  }
  return withProjectConfigMutex(async () => {
    const config = await loadProjectsConfig();
    const project = normalizeProject(projectId, { ...(config.projects[projectId] ?? {}), ...input }, orchestrator);
    config.projects[projectId] = project;
    await saveProjectsConfig(config);
    return project;
  });
}

export async function getProject(projectId) {
  validateProjectId(projectId);
  const config = await loadProjectsConfig();
  const project = config.projects[projectId];
  if (!project) {
    throw Object.assign(new Error(`Project ${projectId} is not registered.`), { code: "project_not_found", status: 404 });
  }
  return project;
}

export function ensureProjectPathExists(project) {
  if (!existsSync(project.path)) {
    throw Object.assign(new Error(`Project path does not exist: ${project.path}`), { code: "project_path_not_found", status: 400 });
  }
}

export function projectHermesDir(project) {
  return path.join(project.path, ".hermes");
}

export function expandPathEnv(pathEnv, home = process.env.HOME || process.env.USERPROFILE || "") {
  return String(pathEnv ?? "").replaceAll("$HOME", home);
}
