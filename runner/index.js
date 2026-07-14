import { startServer } from "./http.js";
import { createTask, findTask } from "./task-store.js";
import { upsertProject } from "./config.js";
import { dispatchTask } from "./codex.js";
import { log } from "./logger.js";

function shutdownTimeoutMs() {
  const value = process.env.HCO_SHUTDOWN_TIMEOUT_MS;
  if (value === undefined) return 10000;
  if (!/^\d+$/.test(value)) {
    throw Object.assign(new Error("HCO_SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000."), {
      code: "invalid_config",
      status: 500
    });
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw Object.assign(new Error("HCO_SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000."), {
      code: "invalid_config",
      status: 500
    });
  }
  return timeoutMs;
}

export function installGracefulShutdown(server, timeoutMs = shutdownTimeoutMs()) {
  let shutdownStarted = false;
  const shutdown = (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log("info", "Runner shutdown started.", { signal, timeoutMs });
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.exitCode = code;
    };
    const timer = setTimeout(() => {
      log("error", "Runner shutdown timeout exceeded.", { code: "shutdown_timeout", timeoutMs });
      server.closeAllConnections();
      finish(1);
      process.stderr.write("", () => process.exit(1));
    }, timeoutMs);
    server.close((error) => {
      if (error) {
        log("error", error.message, { code: "shutdown_failed" });
        finish(1);
        return;
      }
      log("info", "Runner shutdown completed.", { signal });
      finish(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "serve":
    case undefined: {
      const server = await startServer();
      installGracefulShutdown(server);
      break;
    }
    case "register-project": {
      const project = await upsertProject(args.project, {
        name: args.name,
        path: args.path,
        tmuxSession: args.tmuxSession,
        allowCodeChanges: args.allowCodeChanges !== "false",
        allowNetwork: args.allowNetwork !== "false"
      });
      console.log(JSON.stringify({ project }, null, 2));
      break;
    }
    case "create-task": {
      const task = await createTask({
        projectId: args.project,
        goal: args.goal,
        allowCodeChanges: args.allowCodeChanges === "true",
        allowNetwork: args.allowNetwork !== "false"
      });
      console.log(JSON.stringify(task, null, 2));
      break;
    }
    case "dispatch-task": {
      const task = await findTask(args.task);
      const result = await dispatchTask(task.metadata);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
