import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function execFileWithInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${file} ${args.join(" ")} failed with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

export function supportsTmux(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export async function assertTmuxAvailable() {
  if (!supportsTmux()) {
    throw Object.assign(new Error("tmux dispatch is supported on macOS/Linux only in MVP."), {
      code: "tmux_unsupported_platform",
      status: 501
    });
  }
  try {
    await execFileAsync("tmux", ["-V"]);
  } catch {
    throw Object.assign(new Error("tmux was not found in PATH."), { code: "tmux_not_found", status: 500 });
  }
}

export async function hasSession(sessionName) {
  await assertTmuxAvailable();
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export function isDuplicateSessionError(stderr, sessionName) {
  const message = String(stderr ?? "").trim();
  return message === `duplicate session: ${sessionName}` || message === `session '${sessionName}' already exists`;
}

export async function ensureSession(sessionName, cwd) {
  await assertTmuxAvailable();
  try {
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd]);
    return true;
  } catch (error) {
    if (isDuplicateSessionError(error.stderr, sessionName) && await hasSession(sessionName)) {
      return false;
    }
    throw error;
  }
}

export async function sendKeys(sessionName, text) {
  await assertTmuxAvailable();
  await execFileAsync("tmux", ["send-keys", "-t", sessionName, text, "C-m"]);
}

export async function currentCommand(sessionName) {
  await assertTmuxAvailable();
  const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_current_command}"]);
  return stdout.trim();
}

export async function pasteText(sessionName, text, submitDelayMs = 0) {
  await assertTmuxAvailable();
  const bufferName = `hco-${process.pid}-${Date.now()}`;
  try {
    await execFileWithInput("tmux", ["load-buffer", "-b", bufferName, "-"], text);
    await execFileAsync("tmux", ["paste-buffer", "-b", bufferName, "-t", sessionName]);
    await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, "C-m"]);
  } finally {
    await execFileAsync("tmux", ["delete-buffer", "-b", bufferName]).catch(() => {});
  }
}
