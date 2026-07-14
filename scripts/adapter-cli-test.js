import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "hco-adapter-cli-"));
const tokenFile = path.join(root, "runner-token");
const configPath = path.join(root, "adapter.json");
const statePath = path.join(root, "adapter-state.json");
const projectPath = path.join(root, "project");
await writeFile(tokenFile, "cli-secret\n", "utf8");
await chmod(tokenFile, 0o600);
await writeFile(projectPath, "", "utf8").catch(() => {});

const calls = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/projects") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          projects: [
            {
              projectId: "stockprofits",
              name: "Stock Profits",
              path: projectPath,
              tmuxSession: "codex-stockprofits"
            }
          ]
        })
      );
    }
    if (req.url === "/tasks" && req.method === "POST") {
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ taskId: "TASK-CLI", projectId: "stockprofits", status: "queued" }));
    }
    if (req.url === "/tasks/TASK-CLI" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ taskId: "TASK-CLI", projectId: "stockprofits", status: "completed", resultSummary: "done" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await writeFile(
  configPath,
  `${JSON.stringify({
    runnerBaseUrl: `http://127.0.0.1:${port}`,
    runnerTokenFile: tokenFile,
    adapterStatePath: statePath,
    zulipProjectRoutes: { "dev/stockprofits": "stockprofits" }
  }, null, 2)}\n`,
  "utf8"
);

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["adapter/index.js", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

try {
  const messageResult = await runCli(["--config", configPath, "--message", JSON.stringify({
    platform: "zulip",
    stream: "dev",
    topic: "stockprofits",
    text: "/codex projects",
    user: { id: "u1", role: "member" },
    receivedAt: "2026-07-14T12:00:00.000Z"
  })]);
  assert.equal(messageResult.status, 0, messageResult.stderr);
  assert.match(messageResult.stdout, /Stock Profits/);

  const askResult = await runCli(["--config", configPath, "--message", JSON.stringify({
    platform: "zulip",
    stream: "dev",
    topic: "stockprofits",
    text: "/codex ask 检查测试失败",
    user: { id: "u1", role: "member" },
    receivedAt: "2026-07-14T12:00:00.000Z"
  })]);
  assert.equal(askResult.status, 0, askResult.stderr);
  assert.match(askResult.stdout, /TASK-CLI/);
  assert(calls.some((call) => call.url === "/tasks" && call.method === "POST"));

  await writeFile(
    statePath,
    `${JSON.stringify({
      bindings: {},
      tasks: {
        "TASK-CLI": {
          taskId: "TASK-CLI",
          projectId: "stockprofits",
          pollState: "polling",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
          targetKey: "zulip:dev/stockprofits"
        }
      },
      activeWriters: {},
      updatedAt: "2026-07-14T12:00:00.000Z"
    }, null, 2)}\n`,
    "utf8"
  );

  const recoverResult = await runCli(["--config", configPath, "--recover"]);
  assert.equal(recoverResult.status, 0, recoverResult.stderr);
  assert.match(recoverResult.stdout, /completed|done/);

  console.log("adapter cli ok");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
