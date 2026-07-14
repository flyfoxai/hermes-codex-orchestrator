import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { supportsTmux } = await import("../runner/tmux.js");
if (!supportsTmux()) {
  console.log(`dispatch success skipped on ${process.platform}`);
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "hco-dispatch-success-"));
const projectPath = await mkdtemp(path.join(root, "project-"));
const fakeLog = path.join(root, "fake-codex.log");
const fakeCodex = path.join(root, "fake-codex.sh");
const session = `hco-success-${process.pid}`;
const port = 20731 + Math.floor(Math.random() * 1000);
await writeFile(
  fakeCodex,
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'fake-codex 1.0\\n'
  exit 0
fi
printf 'fake-codex-ready\\n' >> '${fakeLog}'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> '${fakeLog}'
done
`,
  "utf8"
);
await chmod(fakeCodex, 0o755);
process.env.HCO_API_TOKEN = "dispatch-success-secret";
process.env.HCO_HOST = "127.0.0.1";
process.env.HCO_PORT = String(port);
process.env.HCO_ORCHESTRATOR_CONFIG = path.join(root, "orchestrator.json");
process.env.HCO_PROJECTS_CONFIG = path.join(root, "projects.json");
await writeFile(
  process.env.HCO_ORCHESTRATOR_CONFIG,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    codexPath: fakeCodex,
    pathEnv: "/usr/bin:/bin",
    dispatchDelayMs: 100,
    pasteSubmitDelayMs: 1500
  }, null, 2),
  "utf8"
);
await writeFile(process.env.HCO_PROJECTS_CONFIG, JSON.stringify({ projects: {} }, null, 2), "utf8");

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
        Authorization: "Bearer dispatch-success-secret",
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
  await httpJson("POST", "/projects/success", { name: "Success Project", path: projectPath, tmuxSession: session });
  const dispatchStartedAt = Date.now();
  const created = await httpJson("POST", "/tasks", {
    projectId: "success",
    goal: "验证 tmux dispatch。",
    constraints: ["不要修改代码。"],
    acceptanceCriteria: ["Codex 收到短指令。"],
    dispatch: true
  });
  if (created.status !== 201 || created.body.status !== "queued") {
    throw new Error(`Dispatch did not queue task: ${JSON.stringify(created)}`);
  }
  if (Date.now() - dispatchStartedAt < 1400) {
    throw new Error("pasteSubmitDelayMs was not applied before submitting the Codex prompt.");
  }
  const raw = await httpJson("GET", `/tasks/${created.body.taskId}/raw`);
  if (raw.body.task.status !== "queued" || !raw.body.task.dispatchPromptFile) {
    throw new Error(`Dispatch metadata was not persisted: ${JSON.stringify(raw)}`);
  }
  const sessions = await httpJson("GET", "/sessions");
  if (!sessions.body.sessions.some((entry) => entry.tmuxSession === session && entry.exists === true)) {
    throw new Error(`tmux session was not discovered: ${JSON.stringify(sessions)}`);
  }
  const tasks = await httpJson("GET", "/tasks");
  if (tasks.status !== 200 || tasks.body.tasks.length !== 1) {
    throw new Error(`Dispatch prompt polluted task listing: ${JSON.stringify(tasks)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const log = await readFile(fakeLog, "utf8");
  if (!log.includes("Read and execute the dispatch instructions")) {
    throw new Error(`Codex did not receive dispatch instruction: ${log}`);
  }
  console.log("dispatch success ok");
} finally {
  server.close();
  await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
