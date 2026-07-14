import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hco-smoke-root-"));
const port = 17731 + Math.floor(Math.random() * 1000);
process.env.HCO_PROJECTS_CONFIG = path.join(tempRoot, "projects.json");
process.env.HCO_ORCHESTRATOR_CONFIG = path.join(tempRoot, "orchestrator.json");
process.env.HCO_API_TOKEN = "smoke-secret";
process.env.HCO_HOST = "127.0.0.1";
process.env.HCO_PORT = String(port);

import { startServer } from "../runner/http.js";

function httpJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          Authorization: "Bearer smoke-secret",
          ...(payload ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const json = text ? JSON.parse(text) : null;
          if (res.statusCode >= 400) {
            reject(new Error(`${res.statusCode}: ${text}`));
          } else {
            resolve(json);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

await writeFile(
  process.env.HCO_ORCHESTRATOR_CONFIG,
  JSON.stringify({ host: "127.0.0.1", port, allowProjectRegistration: true }, null, 2),
  "utf8"
);
await writeFile(process.env.HCO_PROJECTS_CONFIG, JSON.stringify({ projects: {} }, null, 2), "utf8");

const tempDir = await mkdtemp(path.join(tempRoot, "project-"));
const server = await startServer();
try {
  const health = await httpJson("GET", "/health");
  if (!health.ok) throw new Error("Health check failed.");

  await httpJson("POST", "/projects/smoke", {
    name: "Smoke Project",
    path: tempDir,
    allowCodeChanges: false,
    allowNetwork: false
  });

  const task = await httpJson("POST", "/tasks", {
    projectId: "smoke",
    goal: "验证任务创建。",
    constraints: ["不修改代码。"],
    acceptanceCriteria: ["任务文件已创建。"]
  });
  if (!task.taskId || task.status !== "pending") {
    throw new Error("Task creation failed.");
  }

  const fetched = await httpJson("GET", `/tasks/${task.taskId}`);
  if (fetched.taskId !== task.taskId) {
    throw new Error("Task lookup failed.");
  }

  const logs = await httpJson("GET", `/tasks/${task.taskId}/logs`);
  if (!Array.isArray(logs.logs) || logs.logs.length === 0) {
    throw new Error("Task logs lookup failed.");
  }

  const sessions = await httpJson("GET", "/sessions");
  if (!Array.isArray(sessions.sessions)) {
    throw new Error("Session lookup failed.");
  }

  console.log("smoke ok");
} finally {
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
}
