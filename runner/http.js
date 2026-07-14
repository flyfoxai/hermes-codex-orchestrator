import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { loadOrchestratorConfig, loadProjectsConfig, upsertProject } from "./config.js";
import { createTask, findTask, listTasks, readTaskLog, readTaskRaw, updateTaskStatus } from "./task-store.js";
import { dispatchTask } from "./codex.js";
import { hasSession, supportsTmux } from "./tmux.js";
import { log } from "./logger.js";

function requestError(message, code, status, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

function payloadTooLarge() {
  return requestError("Request body exceeds the configured limit.", "payload_too_large", 413, {
    headers: { Connection: "close" }
  });
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let byteLength = 0;
  let tooLarge = false;
  let aborted = false;
  const contentLength = req.headers["content-length"];
  const onClose = () => {
    if (!req.complete) aborted = true;
  };
  req.on("close", onClose);
  try {
    if (typeof contentLength === "string" && /^\d+$/.test(contentLength) && Number(contentLength) > maxBodyBytes) {
      throw payloadTooLarge();
    }
    try {
      for await (const chunk of req) {
        byteLength += chunk.length;
        if (byteLength > maxBodyBytes) {
          tooLarge = true;
        } else if (!tooLarge) {
          chunks.push(chunk);
        }
      }
    } catch (error) {
      if (aborted || (req.destroyed && !req.complete)) {
        throw requestError("Request body upload was aborted.", "request_aborted", 400);
      }
      throw error;
    }
    if (aborted || (req.destroyed && !req.complete)) {
      throw requestError("Request body upload was aborted.", "request_aborted", 400);
    }
    if (tooLarge) throw payloadTooLarge();
  } finally {
    req.off("close", onClose);
  }
  if (chunks.length === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Request body must be a JSON object.");
    }
    return body;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object."), { code: "invalid_request", status: 400 });
  }
}

function parseLimit(value, fallback, maximum = 500) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw Object.assign(new Error(`limit must be an integer between 1 and ${maximum}.`), {
      code: "invalid_request",
      status: 400,
      details: { field: "limit" }
    });
  }
  return parsed;
}

function sendJson(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function errorResponse(error) {
  if (!error.code || !Number.isInteger(error.status)) {
    return {
      error: {
        code: "internal_error",
        message: "Internal server error.",
        details: {}
      }
    };
  }
  return {
    error: {
      code: error.code ?? "runner_error",
      message: error.message ?? "Runner error.",
      details: error.details ?? {}
    }
  };
}

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
}

async function requireAuth(req, config) {
  if (config.authMode === "none") return;
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!timingSafeEqual(tokenDigest(actual), tokenDigest(config.apiToken))) {
    throw requestError("Unauthorized.", "unauthorized", 401, {
      headers: { "WWW-Authenticate": "Bearer" }
    });
  }
}

function taskSummary(task) {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    status: task.status,
    goal: task.goal,
    taskFile: task.taskFile,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    tmuxSession: task.tmuxSession,
    resultSummary: task.resultSummary ?? null,
    dispatchPromptFile: task.dispatchPromptFile ?? null,
    failureReason: task.failureReason ?? null,
    cancellationReason: task.cancellationReason ?? null
  };
}

async function route(req, res, config) {
  await requireAuth(req, config);
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "hermes-codex-orchestrator",
      version: "0.1.0",
      time: new Date().toISOString()
    });
  }

  if (method === "GET" && url.pathname === "/projects") {
    const projects = await loadProjectsConfig();
    return sendJson(res, 200, { projects: Object.values(projects.projects) });
  }

  if (method === "GET" && url.pathname === "/sessions") {
    const projects = await loadProjectsConfig();
    const tmuxSupported = supportsTmux();
    const sessions = [];
    for (const project of Object.values(projects.projects)) {
      sessions.push({
        projectId: project.projectId,
        projectPath: project.path,
        tmuxSession: project.tmuxSession,
        exists: tmuxSupported ? await hasSession(project.tmuxSession) : null,
        status: tmuxSupported ? "checked" : "unsupported_platform"
      });
    }
    return sendJson(res, 200, { platform: process.platform, tmuxSupported, sessions });
  }

  if ((method === "POST" || method === "PUT") && parts[0] === "projects" && parts[1]) {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const project = await upsertProject(parts[1], body);
    return sendJson(res, method === "POST" ? 201 : 200, { project });
  }

  if (method === "POST" && url.pathname === "/tasks") {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const task = await createTask(body);
    const result = body.dispatch ? await dispatchTask(task) : task;
    return sendJson(res, 201, taskSummary(result));
  }

  if (method === "GET" && url.pathname === "/tasks") {
    const filters = {
      projectId: url.searchParams.get("projectId") || undefined,
      status: url.searchParams.get("status") || undefined,
      limit: parseLimit(url.searchParams.get("limit"), 50)
    };
    const tasks = await listTasks(filters);
    return sendJson(res, 200, { tasks: tasks.map(taskSummary) });
  }

  if (parts[0] === "tasks" && parts[1]) {
    const taskId = parts[1];
    if (method === "GET" && parts.length === 2) {
      const task = await findTask(taskId);
      return sendJson(res, 200, taskSummary(task.metadata));
    }
    if (method === "GET" && parts[2] === "raw") {
      const result = await readTaskRaw(taskId);
      return sendJson(res, 200, { task: taskSummary(result.task), content: result.content });
    }
    if (method === "GET" && parts[2] === "logs") {
      const limit = parseLimit(url.searchParams.get("limit"), 200);
      const result = await readTaskLog(taskId, limit);
      return sendJson(res, 200, {
        task: taskSummary(result.task),
        logs: result.logs
      });
    }
    if (method === "POST" && parts[2] === "dispatch") {
      const task = await findTask(taskId);
      const result = await dispatchTask(task.metadata);
      return sendJson(res, 200, taskSummary(result));
    }
    if (method === "POST" && parts[2] === "cancel") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const result = await updateTaskStatus(taskId, "cancelled", {
        cancellationReason: body.reason ?? null
      });
      return sendJson(res, 200, taskSummary(result));
    }
  }

  return sendJson(res, 404, {
    error: {
      code: "not_found",
      message: "Route not found.",
      details: { method, path: url.pathname }
    }
  });
}

export async function startServer() {
  const config = await loadOrchestratorConfig();
  if (config.authMode === "none") {
    log("warn", "Runner authentication is disabled on loopback.", { code: "auth_disabled", host: config.host });
  }
  const server = http.createServer((req, res) => {
    route(req, res, config).catch((error) => {
      if (error.code === "request_aborted") {
        log("warn", error.message, { code: "request_aborted", path: req.url });
        return;
      }
      const status = error.status ?? 500;
      log("error", error.message, { code: error.code ?? "internal_error", path: req.url });
      sendJson(res, status, errorResponse(error), error.headers);
    });
  });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  log("info", "Runner HTTP API listening.", { host: config.host, port: config.port });
  return server;
}
