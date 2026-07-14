import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = await mkdtemp(path.join(os.tmpdir(), "hco-hardening-"));
const projectPath = await mkdtemp(path.join(root, "project-"));
const port = 22731 + Math.floor(Math.random() * 1000);

process.env.HCO_HOST = "127.0.0.1";
process.env.HCO_PORT = String(port);
process.env.HCO_ORCHESTRATOR_CONFIG = path.join(root, "orchestrator.json");
process.env.HCO_PROJECTS_CONFIG = path.join(root, "projects.json");

await writeFile(process.env.HCO_ORCHESTRATOR_CONFIG, "{}\n", "utf8");
await writeFile(process.env.HCO_PROJECTS_CONFIG, "{\"projects\":{}}\n", "utf8");

const { loadOrchestratorConfig, normalizeProject, upsertProject } = await import("../runner/config.js");
const { startServer } = await import("../runner/http.js");
const { createTask, findTask, updateTaskStatus } = await import("../runner/task-store.js");
const { ensureSession, hasSession, isDuplicateSessionError, supportsTmux } = await import("../runner/tmux.js");

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function expectStartFailure(code) {
  let server;
  try {
    server = await startServer();
  } catch (error) {
    assert.equal(error.code, code);
    return;
  }
  await closeServer(server);
  assert.fail(`Server unexpectedly started; expected ${code}.`);
}

function httpRequest(method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.payload ?? "";
    const headers = { ...(options.headers ?? {}) };
    if (options.token !== null) {
      headers.Authorization = `Bearer ${options.token ?? process.env.HCO_API_TOKEN}`;
    }
    if (options.contentLength !== false && payload) {
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = request({ method, hostname: "127.0.0.1", port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (error) {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${text}`));
            return;
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, body, text });
      });
    });
    req.on("error", reject);
    if (options.chunks) {
      for (const chunk of options.chunks) req.write(chunk);
    } else if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function captureConsole() {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

async function sendAbortedRequest(pathname) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write([
        `POST ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${process.env.HCO_API_TOKEN}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: close",
        "",
        "{\"path\":\"partial"
      ].join("\r\n"));
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function waitForRunnerReady(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Runner did not become ready: ${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("Runner HTTP API listening.")) {
        clearTimeout(timer);
        resolve(() => output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Runner exited before ready (${code ?? signal}): ${output}`));
    });
  });
}

function waitForChildExit(child, getOutput, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Runner did not exit after signal: ${getOutput()}`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: getOutput() });
    });
  });
}

async function spawnRunner(portNumber, shutdownTimeoutMs, keepAliveHandle = false) {
  const childRoot = await mkdtemp(path.join(root, "runner-child-"));
  const childProjects = path.join(childRoot, "projects.json");
  const childOrchestrator = path.join(childRoot, "orchestrator.json");
  await writeFile(childProjects, "{\"projects\":{}}\n", "utf8");
  await writeFile(childOrchestrator, "{}\n", "utf8");
  const childArgs = keepAliveHandle
    ? [
        "--input-type=module",
        "--eval",
        'setInterval(() => {}, 60000); await import("./runner/index.js");'
      ]
    : [path.resolve("runner/index.js"), "serve"];
  const child = spawn(process.execPath, childArgs, {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HCO_AUTH_MODE: "token",
      HCO_API_TOKEN: "shutdown-secret",
      HCO_HOST: "127.0.0.1",
      HCO_PORT: String(portNumber),
      HCO_MAX_BODY_BYTES: "1048576",
      HCO_PROJECTS_CONFIG: childProjects,
      HCO_ORCHESTRATOR_CONFIG: childOrchestrator,
      HCO_SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const getOutput = await waitForRunnerReady(child);
  return { child, getOutput };
}

function openPartialProjectRequest(portNumber, projectId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: projectPath, name: "Shutdown Project" });
    const splitAt = Math.floor(body.length / 2);
    const socket = net.createConnection({ host: "127.0.0.1", port: portNumber }, () => {
      socket.write([
        `POST /projects/${projectId} HTTP/1.1`,
        `Host: 127.0.0.1:${portNumber}`,
        "Authorization: Bearer shutdown-secret",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body.slice(0, splitAt)
      ].join("\r\n"));
      resolve({ socket, rest: body.slice(splitAt) });
    });
    socket.once("error", reject);
  });
}

function collectSocketResponse(socket) {
  return new Promise((resolve) => {
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(response));
  });
}

let server;
try {
  delete process.env.HCO_AUTH_MODE;
  delete process.env.HCO_API_TOKEN;
  delete process.env.HCO_MAX_BODY_BYTES;
  await expectStartFailure("invalid_config");

  process.env.HCO_AUTH_MODE = "none";
  process.env.HCO_HOST = "127.0.0.1";
  server = await startServer();
  await closeServer(server);
  server = undefined;

  process.env.HCO_HOST = "0.0.0.0";
  await expectStartFailure("invalid_config");
  process.env.HCO_HOST = "127.0.0.1";
  process.env.HCO_AUTH_MODE = "invalid";
  await expectStartFailure("invalid_config");

  process.env.HCO_AUTH_MODE = "token";
  process.env.HCO_API_TOKEN = "hardening-secret";
  for (const invalidValue of ["", "0", "-1", "1.5", "abc", "16777217"]) {
    process.env.HCO_MAX_BODY_BYTES = invalidValue;
    await assert.rejects(loadOrchestratorConfig(), (error) => error.code === "invalid_config");
  }

  const exactPayload = JSON.stringify({ path: projectPath, name: "Body Limit" });
  process.env.HCO_MAX_BODY_BYTES = String(Buffer.byteLength(exactPayload));
  server = await startServer();

  const authCaptured = captureConsole();
  try {
    const missingToken = await httpRequest("GET", "/health", { token: null });
    assert.equal(missingToken.status, 401);
    assert.equal(missingToken.body.error.code, "unauthorized");

    const wrongToken = await httpRequest("GET", "/health", { token: "wrong-secret" });
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.body.error.code, "unauthorized");
  } finally {
    authCaptured.restore();
  }
  const authLogText = authCaptured.lines.join("\n");
  assert.ok(!authLogText.includes(process.env.HCO_API_TOKEN));
  assert.ok(!authLogText.includes("wrong-secret"));

  const health = await httpRequest("GET", "/health");
  assert.equal(health.status, 200);

  const exact = await httpRequest("POST", "/projects/body-limit", {
    payload: exactPayload,
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(exact.status, 201);

  const concurrentProjectIds = Array.from({ length: 10 }, (_, index) => `config-race-${index}`);
  const originalDateNow = Date.now;
  let concurrentProjectResults;
  try {
    Date.now = () => 1720000000000;
    concurrentProjectResults = await Promise.allSettled(concurrentProjectIds.map((projectId) =>
      upsertProject(projectId, { path: projectPath, name: `Config Race ${projectId}` })
    ));
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(
    concurrentProjectResults.filter((result) => result.status === "rejected").length,
    0,
    `Concurrent project registrations failed: ${concurrentProjectResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.code ?? result.reason?.message)
      .join(", ")}`
  );
  const concurrentProjectsConfig = JSON.parse(await readFile(process.env.HCO_PROJECTS_CONFIG, "utf8"));
  for (const projectId of concurrentProjectIds) {
    assert.equal(concurrentProjectsConfig.projects[projectId]?.projectId, projectId);
  }

  const overContentLength = await httpRequest("POST", "/projects/over-content-length", {
    payload: `${exactPayload} `,
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(overContentLength.status, 413);
  assert.equal(overContentLength.body.error.code, "payload_too_large");
  assert.equal(overContentLength.headers.connection, "close");

  const overChunked = await httpRequest("POST", "/projects/over-chunked", {
    contentLength: false,
    chunks: [exactPayload.slice(0, 10), `${exactPayload.slice(10)} `],
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(overChunked.status, 413);
  assert.equal(overChunked.body.error.code, "payload_too_large");

  const created = await httpRequest("POST", "/tasks", {
    payload: JSON.stringify({ projectId: "body-limit", goal: "small" }),
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(created.status, 201);
  await appendFile(created.body.taskFile, `\n${"x".repeat(Number(process.env.HCO_MAX_BODY_BYTES) * 2)}\n`, "utf8");
  const raw = await httpRequest("GET", `/tasks/${created.body.taskId}/raw`);
  assert.equal(raw.status, 200);
  assert.ok(Buffer.byteLength(raw.text) > Number(process.env.HCO_MAX_BODY_BYTES));

  const captured = captureConsole();
  try {
    await sendAbortedRequest("/projects/aborted");
  } finally {
    captured.restore();
  }
  const abortedLogs = captured.lines.filter((line) => line.includes('"code":"request_aborted"'));
  assert.equal(abortedLogs.length, 1);
  assert.ok(abortedLogs[0].includes('"level":"warn"'));
  assert.ok(!captured.lines.some((line) => line.includes('"level":"error"')));
  const projects = await httpRequest("GET", "/projects");
  assert.ok(!projects.body.projects.some((project) => project.projectId === "aborted"));

  const projectsConfigBackup = await readFile(process.env.HCO_PROJECTS_CONFIG, "utf8");
  await writeFile(process.env.HCO_PROJECTS_CONFIG, "{not-json\n", "utf8");
  const internalError = await httpRequest("GET", "/projects");
  assert.equal(internalError.status, 500);
  assert.equal(internalError.body.error.code, "internal_error");
  assert.equal(internalError.body.error.message, "Internal server error.");
  assert.ok(!internalError.text.includes(root));
  await writeFile(process.env.HCO_PROJECTS_CONFIG, projectsConfigBackup, "utf8");

  const projectsConfigPath = process.env.HCO_PROJECTS_CONFIG;
  process.env.HCO_PROJECTS_CONFIG = root;
  const codedInternalError = await httpRequest("GET", "/projects");
  assert.equal(codedInternalError.status, 500);
  assert.equal(codedInternalError.body.error.code, "internal_error");
  assert.equal(codedInternalError.body.error.message, "Internal server error.");
  assert.ok(!codedInternalError.text.includes(root));
  process.env.HCO_PROJECTS_CONFIG = projectsConfigPath;

  const logText = captured.lines.join("\n");
  assert.ok(!logText.includes(process.env.HCO_API_TOKEN));
  console.log("hardening phase 1 ok");

  const duplicateInput = {
    taskId: "HARDEN-DUPLICATE",
    projectId: "body-limit",
    goal: "first duplicate task"
  };
  const duplicate = await createTask(duplicateInput);
  const duplicateBefore = await readFile(duplicate.taskFile, "utf8");
  await assert.rejects(
    createTask({ ...duplicateInput, goal: "must not overwrite" }),
    (error) => error.code === "task_exists" && error.status === 409
  );
  assert.equal(await readFile(duplicate.taskFile, "utf8"), duplicateBefore);

  const concurrentInput = {
    taskId: "HARDEN-CONCURRENT-CREATE",
    projectId: "body-limit",
    goal: "concurrent create"
  };
  const concurrentCreates = await Promise.allSettled(
    Array.from({ length: 5 }, () => createTask(concurrentInput))
  );
  assert.equal(concurrentCreates.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    concurrentCreates.filter((result) => result.status === "rejected" && result.reason.code === "task_exists").length,
    4
  );

  const concurrentTask = await createTask({
    taskId: "HARDEN-CONCURRENT-STATUS",
    projectId: "body-limit",
    goal: "concurrent status"
  });
  const statuses = [
    "queued", "running", "waiting_user", "running", "verifying",
    "running", "waiting_user", "verifying", "completed", "cancelled"
  ];
  const applied = [];
  const updateResults = await Promise.allSettled(statuses.map((status, index) =>
    updateTaskStatus(concurrentTask.taskId, status, { resultSummary: `result-${index}` }, {
      applicationObserver: (event) => applied.push(event)
    })
  ));
  assert.equal(updateResults.filter((result) => result.status === "rejected").length, 0);
  assert.equal(applied.length, statuses.length);
  for (let index = 1; index < applied.length; index += 1) {
    assert.ok(applied[index].sequence > applied[index - 1].sequence);
  }
  const concurrentFinal = await findTask(concurrentTask.taskId);
  const latestApplied = applied.at(-1);
  assert.equal(concurrentFinal.metadata.status, latestApplied.status);
  assert.equal(concurrentFinal.metadata.updatedAt, latestApplied.updatedAt);
  const concurrentRaw = await readFile(concurrentTask.taskFile, "utf8");
  assert.match(concurrentRaw, new RegExp(`^Status: ${concurrentFinal.metadata.status}$`, "m"));
  assert.match(concurrentRaw, new RegExp(`^UpdatedAt: ${concurrentFinal.metadata.updatedAt}$`, "m"));
  assert.ok(!concurrentRaw.includes('"sequence"'));

  const replayTask = await createTask({
    taskId: "HARDEN-EXTERNAL-REPLAY",
    projectId: "body-limit",
    goal: "external replay"
  });
  let externalWriteAt;
  const replayed = await updateTaskStatus(replayTask.taskId, "running", { resultSummary: "merged" }, {
    beforeVersionCheck: async ({ attempt, taskFile }) => {
      if (attempt !== 0) return;
      const content = await readFile(taskFile, "utf8");
      const end = content.indexOf("-->");
      const metadata = JSON.parse(content.slice("<!-- hco:metadata".length, end).trim());
      metadata.externalFlag = "preserve-me";
      const body = content.slice(end + 3).replace(/^\s+/, "");
      externalWriteAt = new Date();
      await writeFile(
        taskFile,
        `<!-- hco:metadata\n${JSON.stringify(metadata, null, 2)}\n-->\n\n${body}\nExternal note must survive.\n`,
        "utf8"
      );
    }
  });
  const replayRaw = await readFile(replayTask.taskFile, "utf8");
  assert.equal(replayed.externalFlag, "preserve-me");
  assert.ok(replayRaw.includes("External note must survive."));
  assert.ok(new Date(replayed.updatedAt) >= externalWriteAt);

  const conflictTask = await createTask({
    taskId: "HARDEN-PERSISTENT-CONFLICT",
    projectId: "body-limit",
    goal: "persistent conflict"
  });
  await assert.rejects(
    updateTaskStatus(conflictTask.taskId, "completed", {}, {
      beforeVersionCheck: async ({ attempt, taskFile }) => {
        await appendFile(taskFile, `\nExternal conflict ${attempt}.\n`, "utf8");
      }
    }),
    (error) => error.code === "task_conflict" && error.status === 409
  );
  const conflicted = await findTask(conflictTask.taskId);
  const conflictRaw = await readFile(conflictTask.taskFile, "utf8");
  assert.equal(conflicted.metadata.status, "pending");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.ok(conflictRaw.includes(`External conflict ${attempt}.`));
  }
  console.log("hardening phase 2 ok");

  assert.equal(typeof isDuplicateSessionError, "function");
  assert.equal(isDuplicateSessionError("duplicate session: target", "target"), true);
  assert.equal(isDuplicateSessionError("session 'target' already exists", "target"), true);
  assert.equal(isDuplicateSessionError("duplicate session: other", "target"), false);
  assert.equal(isDuplicateSessionError("server exited unexpectedly", "target"), false);

  const orchestrator = { tmuxPrefix: "codex", defaultLanguage: "zh-CN" };
  const exactSession = "s".repeat(64);
  assert.equal(normalizeProject("tmux-project", { path: projectPath, tmuxSession: exactSession }, orchestrator).tmuxSession, exactSession);
  assert.throws(
    () => normalizeProject("tmux-project", { path: projectPath, tmuxSession: "s".repeat(65) }, orchestrator),
    (error) => error.code === "invalid_request" && error.status === 400 && error.details.field === "tmuxSession"
  );
  assert.throws(
    () => normalizeProject("p".repeat(64), { path: projectPath }, orchestrator),
    (error) => error.code === "invalid_request" && error.details.field === "tmuxSession"
  );

  if (supportsTmux()) {
    const session = `hco-hardening-${process.pid}`;
    await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => {});
    try {
      const created = await Promise.all(Array.from({ length: 10 }, () => ensureSession(session, projectPath)));
      assert.equal(created.filter(Boolean).length, 1);
      assert.equal(await hasSession(session), true);
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => {});
    }
  }
  console.log("hardening phase 3 ok");

  const gracefulPort = port + 1100;
  const gracefulRunner = await spawnRunner(gracefulPort, 1000);
  const gracefulRequest = await openPartialProjectRequest(gracefulPort, "graceful");
  const gracefulResponse = collectSocketResponse(gracefulRequest.socket);
  const gracefulExit = waitForChildExit(gracefulRunner.child, gracefulRunner.getOutput);
  await new Promise((resolve) => setTimeout(resolve, 50));
  gracefulRunner.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 50));
  gracefulRequest.socket.write(gracefulRequest.rest);
  const [gracefulResult, responseText] = await Promise.all([gracefulExit, gracefulResponse]);
  assert.equal(gracefulResult.code, 0);
  assert.match(responseText, /HTTP\/1\.1 201/, gracefulResult.output);

  const forcedPort = port + 1200;
  const forcedRunner = await spawnRunner(forcedPort, 100, true);
  const forcedRequest = await openPartialProjectRequest(forcedPort, "forced");
  const forcedExit = waitForChildExit(forcedRunner.child, forcedRunner.getOutput);
  await new Promise((resolve) => setTimeout(resolve, 50));
  forcedRunner.child.kill("SIGTERM");
  const forcedResult = await forcedExit;
  forcedRequest.socket.destroy();
  assert.equal(forcedResult.code, 1);
  assert.match(forcedResult.output, /shutdown timeout/i);
  console.log("hardening phase 4 ok");
} finally {
  if (server?.listening) await closeServer(server);
  await rm(root, { recursive: true, force: true });
}
