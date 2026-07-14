import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "hco-contract-"));
const projectPath = await mkdtemp(path.join(root, "project-"));
const port = 18731 + Math.floor(Math.random() * 1000);
process.env.HCO_API_TOKEN = "contract-secret";
process.env.HCO_HOST = "127.0.0.1";
process.env.HCO_PORT = String(port);
process.env.HCO_ORCHESTRATOR_CONFIG = path.join(root, "orchestrator.json");
process.env.HCO_PROJECTS_CONFIG = path.join(root, "projects.json");

await writeFile(
  process.env.HCO_ORCHESTRATOR_CONFIG,
  JSON.stringify({ host: "127.0.0.1", port: port + 1000, allowProjectRegistration: true }, null, 2),
  "utf8"
);
await writeFile(process.env.HCO_PROJECTS_CONFIG, JSON.stringify({ projects: {} }, null, 2), "utf8");

const { startServer } = await import("../runner/http.js");
const { appendTaskLog, findTask } = await import("../runner/task-store.js");

function httpJson(method, pathname, body, token = "contract-secret") {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = request({ method, hostname: "127.0.0.1", port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON response (${res.statusCode}): ${text}`));
          return;
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const server = await startServer();
try {
  const missingTaskField = await httpJson("POST", "/tasks", { projectId: "missing" });
  if (missingTaskField.status !== 400 || missingTaskField.body.error.code !== "invalid_request") {
    throw new Error(`Missing task fields were not rejected: ${JSON.stringify(missingTaskField)}`);
  }

  const invalidProject = await httpJson("POST", "/projects/bad", { name: "Bad" });
  if (invalidProject.status !== 400 || invalidProject.body.error.code !== "invalid_request") {
    throw new Error(`Invalid project was not rejected: ${JSON.stringify(invalidProject)}`);
  }
  const blankProjectPath = await httpJson("POST", "/projects/blank", { path: "   " });
  if (blankProjectPath.status !== 400 || blankProjectPath.body.error.code !== "invalid_request") {
    throw new Error(`Blank project path was not rejected: ${JSON.stringify(blankProjectPath)}`);
  }

  const registered = await httpJson("POST", "/projects/contract", {
    name: "Contract Project",
    path: projectPath,
    allowCodeChanges: false,
    allowNetwork: false
  });
  if (registered.status !== 201) throw new Error(`Project registration failed: ${JSON.stringify(registered)}`);

  const created = await httpJson("POST", "/tasks", {
    projectId: "contract",
    goal: "验证 API 合约。",
    constraints: ["不修改代码。"],
    acceptanceCriteria: ["任务原文可读取。"]
  });
  if (created.status !== 201) throw new Error(`Task creation failed: ${JSON.stringify(created)}`);

  const storedTask = await findTask(created.body.taskId);
  await appendTaskLog(storedTask.metadata, "error", "Authorization: Bearer log-secret api_key=key-secret");
  const redactedLogs = await httpJson("GET", `/tasks/${created.body.taskId}/logs`);
  const redactedText = JSON.stringify(redactedLogs.body);
  if (redactedText.includes("log-secret") || redactedText.includes("key-secret") || !redactedText.includes("[REDACTED]")) {
    throw new Error(`Task log secrets were not redacted: ${redactedText}`);
  }

  const raw = await httpJson("GET", `/tasks/${created.body.taskId}/raw`);
  if (raw.status !== 200 || !raw.body.content.includes("验证 API 合约。")) {
    throw new Error(`Raw task endpoint failed: ${JSON.stringify(raw)}`);
  }

  const completedContent = raw.body.content
    .replace(/^Status: pending$/m, "Status: completed")
    .replace("## Codex Execution Log\n\n待执行。", "## Codex Execution Log\n\n- 已完成只读验证。")
    .replace("## Result\n\n待填写。", "## Result\n\n任务文件回写链路可用。");
  await writeFile(created.body.taskFile, completedContent, "utf8");
  const completed = await httpJson("GET", `/tasks/${created.body.taskId}`);
  if (completed.body.status !== "completed" || completed.body.resultSummary !== "任务文件回写链路可用。") {
    throw new Error(`Codex task-file writeback was not reflected: ${JSON.stringify(completed)}`);
  }

  const badLimit = await httpJson("GET", "/tasks?limit=not-a-number");
  if (badLimit.status !== 400 || badLimit.body.error.code !== "invalid_request") {
    throw new Error(`Invalid limit was not rejected: ${JSON.stringify(badLimit)}`);
  }

  const unauthorized = await httpJson("GET", "/health", undefined, "wrong-secret");
  if (unauthorized.status !== 401 || unauthorized.body.error.code !== "unauthorized") {
    throw new Error(`Unauthorized request was not rejected: ${JSON.stringify(unauthorized)}`);
  }

  const configText = await readFile(process.env.HCO_PROJECTS_CONFIG, "utf8");
  if (configText.includes("contract-secret")) throw new Error("Token leaked into projects config.");
  console.log("contract ok");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
