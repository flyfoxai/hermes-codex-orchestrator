import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TEMPLATE_DIR, ensureProjectPathExists, getProject, loadOrchestratorConfig, loadProjectsConfig, projectHermesDir, validateTaskId } from "./config.js";
import { redact } from "./logger.js";

const METADATA_START = "<!-- hco:metadata";
const METADATA_END = "-->";
const taskMutexes = new Map();
let applicationSequence = 0;

function slugDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("");
}

function generateTaskId(prefix) {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${slugDate()}-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

function renderList(items) {
  if (!Array.isArray(items) || items.length === 0) return "- 无";
  return items.map((item) => `- ${item}`).join("\n");
}

async function loadTemplate(name) {
  return readFile(path.join(TEMPLATE_DIR, name), "utf8");
}

function renderTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? ""));
}

function taskPaths(project, taskId) {
  validateTaskId(taskId);
  const baseDir = projectHermesDir(project);
  return {
    baseDir,
    taskDir: path.join(baseDir, "tasks"),
    logDir: path.join(baseDir, "logs"),
    taskFile: path.join(baseDir, "tasks", `${taskId}.md`),
    logFile: path.join(baseDir, "logs", `${taskId}.log`)
  };
}

function serializeTask(metadata, body) {
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}\n\n${body}`;
}

function parseTaskFile(content) {
  if (!content.startsWith(METADATA_START)) {
    throw Object.assign(new Error("Task metadata block is missing."), { code: "invalid_task_file", status: 500 });
  }
  const endIndex = content.indexOf(METADATA_END);
  if (endIndex === -1) {
    throw Object.assign(new Error("Task metadata block is not closed."), { code: "invalid_task_file", status: 500 });
  }
  const jsonText = content.slice(METADATA_START.length, endIndex).trim();
  const remainder = content.slice(endIndex + METADATA_END.length);
  const separator = remainder.startsWith("\r\n\r\n") ? "\r\n\r\n" : remainder.startsWith("\n\n") ? "\n\n" : null;
  if (!separator) {
    throw Object.assign(new Error("Task metadata separator is invalid."), { code: "invalid_task_file", status: 500 });
  }
  const metadata = JSON.parse(jsonText);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw Object.assign(new Error("Task metadata must be a JSON object."), { code: "invalid_task_file", status: 500 });
  }
  return { metadata, body: remainder.slice(separator.length) };
}

function extractBodyField(body, field) {
  const match = body.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || null;
}

function extractBodySection(body, heading) {
  const marker = `## ${heading}`;
  const markerIndex = body.indexOf(marker);
  if (markerIndex === -1) return null;
  const contentStart = markerIndex + marker.length;
  const nextSection = body.indexOf("\n## ", contentStart);
  const value = body.slice(contentStart, nextSection === -1 ? body.length : nextSection).trim();
  return value || null;
}

function reconcileTaskMetadata(metadata, body) {
  const visibleStatus = extractBodyField(body, "Status");
  const visibleUpdatedAt = extractBodyField(body, "UpdatedAt");
  const result = extractBodySection(body, "Result");
  const resultSummary = result && result !== "待填写。"
    ? result.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 500) ?? null
    : metadata.resultSummary ?? null;
  return {
    ...metadata,
    status: TASK_STATUSES.has(visibleStatus) ? visibleStatus : metadata.status,
    updatedAt: visibleUpdatedAt && !Number.isNaN(Date.parse(visibleUpdatedAt)) ? visibleUpdatedAt : metadata.updatedAt,
    resultSummary
  };
}

async function writeTaskFile(taskFile, metadata, body) {
  const tempPath = `${taskFile}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await writeFile(tempPath, serializeTask(metadata, body), "utf8");
    await rename(tempPath, taskFile);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function withTaskMutex(taskId, operation) {
  const previous = taskMutexes.get(taskId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  taskMutexes.set(taskId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (taskMutexes.get(taskId) === current) taskMutexes.delete(taskId);
  }
}

function taskExistsError(taskId) {
  return Object.assign(new Error(`Task ${taskId} already exists.`), {
    code: "task_exists",
    status: 409,
    details: { taskId }
  });
}

function taskConflictError(taskId) {
  return Object.assign(new Error(`Task ${taskId} could not be updated because its file changed.`), {
    code: "task_conflict",
    status: 409,
    details: { taskId }
  });
}

function contentVersion(content) {
  return createHash("sha256").update(content).digest("hex");
}

function updateBodyState(body, status, updatedAt, taskId) {
  if (!/^Status:\s*.+$/m.test(body) || !/^UpdatedAt:\s*.+$/m.test(body)) {
    throw taskConflictError(taskId);
  }
  return body
    .replace(/^Status:\s*.*$/m, `Status: ${status}`)
    .replace(/^UpdatedAt:\s*.*$/m, `UpdatedAt: ${updatedAt}`);
}

async function locateTaskFile(taskId) {
  validateTaskId(taskId);
  const projectsConfig = await loadProjectsConfig();
  for (const project of Object.values(projectsConfig.projects)) {
    const paths = taskPaths(project, taskId);
    try {
      const content = await readFile(paths.taskFile, "utf8");
      return { project, paths, content };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error(`Task ${taskId} was not found.`), { code: "task_not_found", status: 404 });
}

export async function createTask(input) {
  validateTaskInput(input);
  const orchestrator = await loadOrchestratorConfig();
  const project = await getProject(input.projectId);
  ensureProjectPathExists(project);

  const taskId = input.taskId ?? generateTaskId(orchestrator.taskIdPrefix);
  const now = new Date().toISOString();
  const paths = taskPaths(project, taskId);
  await mkdir(paths.taskDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });

  const metadata = {
    taskId,
    projectId: project.projectId,
    projectPath: project.path,
    status: "pending",
    goal: input.goal,
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    allowCodeChanges: input.allowCodeChanges ?? project.allowCodeChanges,
    allowNetwork: input.allowNetwork ?? project.allowNetwork,
    requestedBy: input.requestedBy ?? null,
    createdAt: now,
    updatedAt: now,
    taskFile: paths.taskFile,
    logFile: paths.logFile,
    tmuxSession: project.tmuxSession
  };

  const template = await loadTemplate("task.md");
  const body = renderTemplate(template, {
    taskId,
    projectId: project.projectId,
    projectPath: project.path,
    status: metadata.status,
    createdAt: now,
    updatedAt: now,
    allowCodeChanges: metadata.allowCodeChanges,
    allowNetwork: metadata.allowNetwork,
    goal: metadata.goal,
    constraints: renderList(metadata.constraints),
    acceptanceCriteria: renderList(metadata.acceptanceCriteria)
  });

  return withTaskMutex(taskId, async () => {
    try {
      await readFile(paths.taskFile, "utf8");
      throw taskExistsError(taskId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeTaskFile(paths.taskFile, metadata, body);
    await appendTaskLog(metadata, "info", "Task created.");
    return metadata;
  });
}

export async function readTask(project, taskId) {
  const paths = taskPaths(project, taskId);
  const content = await readFile(paths.taskFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error(`Task ${taskId} was not found.`), { code: "task_not_found", status: 404 });
    }
    throw error;
  });
  const parsed = parseTaskFile(content);
  return { metadata: reconcileTaskMetadata(parsed.metadata, parsed.body), body: parsed.body, paths };
}

export async function readTaskRaw(taskId) {
  const task = await findTask(taskId);
  const content = await readFile(task.paths.taskFile, "utf8");
  return { task: task.metadata, content };
}

export async function findTask(taskId) {
  const projectsConfig = await loadProjectsConfig();
  for (const project of Object.values(projectsConfig.projects)) {
    try {
      return { project, ...(await readTask(project, taskId)) };
    } catch (error) {
      if (error.code !== "task_not_found") throw error;
    }
  }
  throw Object.assign(new Error(`Task ${taskId} was not found.`), { code: "task_not_found", status: 404 });
}

export async function updateTaskStatus(taskId, status, patch = {}, testHooks = {}) {
  validateTaskStatus(status);
  return withTaskMutex(taskId, async () => {
    const located = await locateTaskFile(taskId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const content = attempt === 0 ? located.content : await readFile(located.paths.taskFile, "utf8");
      const version = contentVersion(content);
      let parsed;
      try {
        parsed = parseTaskFile(content);
      } catch {
        throw taskConflictError(taskId);
      }
      const updatedAt = new Date().toISOString();
      const metadata = {
        ...parsed.metadata,
        ...patch,
        status,
        updatedAt
      };
      const body = updateBodyState(parsed.body, status, updatedAt, taskId);
      await testHooks.beforeVersionCheck?.({ attempt, taskId, taskFile: located.paths.taskFile, status, updatedAt });
      const latestContent = await readFile(located.paths.taskFile, "utf8");
      if (contentVersion(latestContent) !== version) {
        if (attempt === 3) throw taskConflictError(taskId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      await writeTaskFile(located.paths.taskFile, metadata, body);
      const sequence = ++applicationSequence;
      testHooks.applicationObserver?.({ sequence, taskId, status, updatedAt });
      await appendTaskLog(metadata, "info", `Task status changed to ${status}.`);
      return metadata;
    }
    throw taskConflictError(taskId);
  });
}

const TASK_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "waiting_user",
  "verifying",
  "completed",
  "failed",
  "cancelled"
]);

function validateTaskStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw Object.assign(new Error(`Invalid task status: ${status}.`), {
      code: "invalid_request",
      status: 400,
      details: { field: "status" }
    });
  }
}

function validateTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("Request body must be a JSON object."), {
      code: "invalid_request",
      status: 400,
      details: { field: "body" }
    });
  }
  if (typeof input.projectId !== "string" || input.projectId.trim() === "") {
    throw Object.assign(new Error("projectId is required."), {
      code: "invalid_request",
      status: 400,
      details: { field: "projectId" }
    });
  }
  if (typeof input.goal !== "string" || input.goal.trim() === "") {
    throw Object.assign(new Error("goal is required."), {
      code: "invalid_request",
      status: 400,
      details: { field: "goal" }
    });
  }
  if (input.taskId !== undefined) validateTaskId(input.taskId);
  for (const field of ["constraints", "acceptanceCriteria"]) {
    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].some((item) => typeof item !== "string"))) {
      throw Object.assign(new Error(`${field} must be an array of strings.`), {
        code: "invalid_request",
        status: 400,
        details: { field }
      });
    }
  }
  for (const field of ["allowCodeChanges", "allowNetwork"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw Object.assign(new Error(`${field} must be a boolean.`), {
        code: "invalid_request",
        status: 400,
        details: { field }
      });
    }
  }
}

export async function appendTaskLog(task, level, message) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`;
  await mkdir(path.dirname(task.logFile), { recursive: true });
  await writeFile(task.logFile, line, { encoding: "utf8", flag: "a" });
}

export async function readTaskLog(taskId, limit = 200) {
  const task = await findTask(taskId);
  const content = await readFile(task.metadata.logFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.split(/\r?\n/).filter(Boolean);
  return {
    task: task.metadata,
    logs: lines.slice(-limit).map((line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+(.*)$/);
      return match
        ? { time: match[1], level: match[2].toLowerCase(), message: match[3] }
        : { time: null, level: "info", message: line };
    })
  };
}

export async function listTasks(filters = {}) {
  const projectsConfig = await loadProjectsConfig();
  const results = [];
  for (const project of Object.values(projectsConfig.projects)) {
    if (filters.projectId && filters.projectId !== project.projectId) continue;
    const dir = path.join(projectHermesDir(project), "tasks");
    let files = [];
    try {
      files = await readdir(dir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".md"))) {
      const taskId = path.basename(file, ".md");
      const task = await readTask(project, taskId);
      if (filters.status && filters.status !== task.metadata.status) continue;
      results.push(task.metadata);
    }
  }
  results.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return results.slice(0, filters.limit ?? 50);
}
