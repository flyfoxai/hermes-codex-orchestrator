import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function emptyState() {
  return {
    bindings: {},
    zulipStreamProjectRoutes: {},
    zulipGenericStreams: {},
    tasks: {},
    activeWriters: {},
    updatedAt: new Date().toISOString()
  };
}

function normalizeState(value) {
  return {
    bindings: value?.bindings && typeof value.bindings === "object" ? value.bindings : {},
    zulipStreamProjectRoutes: value?.zulipStreamProjectRoutes && typeof value.zulipStreamProjectRoutes === "object" ? value.zulipStreamProjectRoutes : {},
    zulipGenericStreams: value?.zulipGenericStreams && typeof value.zulipGenericStreams === "object" ? value.zulipGenericStreams : {},
    tasks: value?.tasks && typeof value.tasks === "object" ? value.tasks : {},
    activeWriters: value?.activeWriters && typeof value.activeWriters === "object" ? value.activeWriters : {},
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
}

export async function loadState(statePath) {
  try {
    return normalizeState(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(statePath, state) {
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tempPath, statePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
