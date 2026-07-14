import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TEMPLATE_DIR, expandPathEnv, loadOrchestratorConfig } from "./config.js";
import { currentCommand, pasteText, sendKeys, ensureSession } from "./tmux.js";
import { appendTaskLog, updateTaskStatus } from "./task-store.js";

const execFileAsync = promisify(execFile);

function render(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? ""));
}

export async function dispatchTask(task) {
  const orchestrator = await loadOrchestratorConfig();
  try {
    await assertCodexAvailable(orchestrator);
    const created = await ensureSession(task.tmuxSession, task.projectPath);
    const command = created ? "" : await currentCommand(task.tmuxSession);
    if (created || isShellCommand(command)) {
      const pathEnv = expandPathEnv(orchestrator.pathEnv);
      await sendKeys(task.tmuxSession, `export PATH=${shellQuote(pathEnv)}`);
      await sendKeys(task.tmuxSession, `cd ${shellQuote(task.projectPath)}`);
      await sendKeys(task.tmuxSession, shellQuote(orchestrator.codexPath));
      await new Promise((resolve) => setTimeout(resolve, orchestrator.dispatchDelayMs));
    }

    const template = await readFile(path.join(TEMPLATE_DIR, "codex-dispatch-prompt.md"), "utf8");
    const prompt = render(template, {
      projectPath: task.projectPath,
      taskFile: task.taskFile
    });
    const dispatchDir = path.join(task.projectPath, ".hermes", "dispatch");
    const dispatchFile = path.join(dispatchDir, `${task.taskId}.md`);
    await mkdir(dispatchDir, { recursive: true });
    await writeFile(dispatchFile, prompt, "utf8");
    await pasteText(
      task.tmuxSession,
      `Read and execute the dispatch instructions in ${dispatchFile}. Then update ${task.taskFile}.`,
      orchestrator.pasteSubmitDelayMs
    );
    const updated = await updateTaskStatus(task.taskId, "queued", { dispatchPromptFile: dispatchFile });
    await appendTaskLog(updated, "info", `Task dispatched to tmux session ${task.tmuxSession}.`);
    await appendTaskLog(updated, "warn", "Codex may require interactive confirmation on first launch.");
    return updated;
  } catch (error) {
    let failed;
    try {
      failed = await updateTaskStatus(task.taskId, "failed", {
        failureCode: error.code ?? "dispatch_failed",
        failureReason: error.message
      });
      await appendTaskLog(failed, "error", `Task dispatch failed: ${error.message}`);
    } catch {
      // Preserve the original dispatch error when task persistence also fails.
    }
    error.details = { ...(error.details ?? {}), taskId: task.taskId };
    throw error;
  }
}

async function assertCodexAvailable(orchestrator) {
  const pathEnv = expandPathEnv(orchestrator.pathEnv);
  try {
    await execFileAsync(orchestrator.codexPath, ["--version"], {
      env: { ...process.env, PATH: pathEnv },
      windowsHide: true
    });
  } catch (error) {
    const code = error.code === "ENOENT" ? "codex_not_found" : "codex_unavailable";
    throw Object.assign(new Error(`Codex CLI is unavailable: ${orchestrator.codexPath}.`), {
      code,
      status: 500,
      details: { codexPath: orchestrator.codexPath }
    });
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isShellCommand(command) {
  return new Set(["bash", "dash", "fish", "ksh", "sh", "tcsh", "zsh", "login"]).has(command);
}
