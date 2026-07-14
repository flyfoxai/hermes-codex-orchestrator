import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterError } from "./errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const DEFAULT_CONFIG = {
  runnerBaseUrl: "http://127.0.0.1:8731",
  defaultProjectId: undefined,
  zulipStreamProjectRoutes: {},
  pollIntervalMs: 5000,
  pollMaxIntervalMs: 30000,
  taskPollTimeoutMs: 7200000,
  writeTaskPolicy: "reject_when_project_busy"
};

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw adapterError("invalid_adapter_config", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

export async function loadAdapterConfig(configPath) {
  const resolvedConfigPath = path.resolve(requireString(configPath, "configPath"));
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolvedConfigPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw adapterError("adapter_config_not_found", "Adapter config file was not found.");
    throw error;
  }

  if (Object.hasOwn(parsed, "zulipProjectRoutes")) {
    throw adapterError("invalid_adapter_config", "zulipProjectRoutes has been replaced by zulipStreamProjectRoutes. Zulip topics are conversation targets, not project routes.", {
      field: "zulipProjectRoutes"
    });
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    runnerBaseUrl: requireString(parsed.runnerBaseUrl ?? DEFAULT_CONFIG.runnerBaseUrl, "runnerBaseUrl"),
    runnerTokenFile: path.resolve(requireString(parsed.runnerTokenFile, "runnerTokenFile")),
    adapterStatePath: parsed.adapterStatePath
      ? path.resolve(requireString(parsed.adapterStatePath, "adapterStatePath"))
      : path.resolve(path.dirname(resolvedConfigPath), "adapter-state.json"),
    zulipStreamProjectRoutes: parsed.zulipStreamProjectRoutes && typeof parsed.zulipStreamProjectRoutes === "object"
      ? parsed.zulipStreamProjectRoutes
      : {}
  };

  try {
    new URL(config.runnerBaseUrl);
  } catch {
    throw adapterError("invalid_adapter_config", "runnerBaseUrl must be a valid URL.", { field: "runnerBaseUrl" });
  }

  if (config.writeTaskPolicy !== "reject_when_project_busy") {
    throw adapterError("invalid_adapter_config", "writeTaskPolicy must be reject_when_project_busy.", {
      field: "writeTaskPolicy"
    });
  }

  if (isInside(ROOT_DIR, config.runnerTokenFile)) {
    throw adapterError("token_file_in_repository", "runnerTokenFile must be outside the repository.");
  }

  let tokenStat;
  try {
    tokenStat = await stat(config.runnerTokenFile);
  } catch (error) {
    if (error.code === "ENOENT") throw adapterError("token_file_not_found", "Runner token file was not found.");
    throw error;
  }
  if ((tokenStat.mode & 0o077) !== 0) {
    throw adapterError("token_file_permissions", "Runner token file must not be group/world readable.");
  }

  const token = (await readFile(config.runnerTokenFile, "utf8")).trim();
  if (!token) throw adapterError("token_file_empty", "Runner token file is empty.");

  return { config, token };
}
