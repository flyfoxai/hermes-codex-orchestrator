import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { supportsTmux } = await import("../runner/tmux.js");
if (!supportsTmux()) {
  console.log(`dispatch skipped on ${process.platform}`);
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "hco-dispatch-"));
const projectPath = await mkdtemp(path.join(root, "project-"));
const port = 19731 + Math.floor(Math.random() * 1000);
const session = `hco-test-${process.pid}`;
process.env.HCO_API_TOKEN = "dispatch-secret";
process.env.HCO_HOST = "127.0.0.1";
process.env.HCO_PORT = String(port);
process.env.HCO_ORCHESTRATOR_CONFIG = path.join(root, "orchestrator.json");
process.env.HCO_PROJECTS_CONFIG = path.join(root, "projects.json");

await writeFile(
  process.env.HCO_ORCHESTRATOR_CONFIG,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    codexPath: path.join(root, "missing-codex"),
    pathEnv: "/usr/bin:/bin",
    tmuxPrefix: "hco-test",
    dispatchDelayMs: 50
  }, null, 2),
  "utf8"
);
await writeFile(
  process.env.HCO_PROJECTS_CONFIG,
  JSON.stringify({ projects: {} }, null, 2),
  "utf8"
);

const { startServer } = await import("../runner/http.js");

function httpJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request({
      method,
      hostname: "127.0.0.1",
      port,
      path: pathname,
      headers: {
        Authorization: "Bearer dispatch-secret",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const server = await startServer();
try {
  await httpJson("POST", "/projects/dispatch", {
    name: "Dispatch Project",
    path: projectPath,
    tmuxSession: session
  });
  const response = await httpJson("POST", "/tasks", {
    projectId: "dispatch",
    goal: "验证 Codex 不可用时的失败状态。",
    dispatch: true
  });
  if (response.status !== 500 || response.body.error.code !== "codex_not_found") {
    throw new Error(`Dispatch failure was not reported: ${JSON.stringify(response)}`);
  }
  const taskId = response.body.error.details.taskId;
  if (!taskId) throw new Error(`Dispatch failure omitted taskId: ${JSON.stringify(response)}`);
  const status = await httpJson("GET", `/tasks/${taskId}`);
  if (status.body.status !== "failed") {
    throw new Error(`Task was not marked failed: ${JSON.stringify(status)}`);
  }
  console.log("dispatch failure contract ok");
} finally {
  server.close();
  await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
