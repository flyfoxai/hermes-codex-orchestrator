export function adapterError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function permissionDenied(reason = "Permission denied.") {
  return adapterError("permission_denied", reason);
}

export function formatErrorForUser(error) {
  const code = error?.code ?? "adapter_error";
  if (code === "permission_denied") return "权限不足，无法执行该操作。";
  if (code === "route_unbound") return "当前对话没有绑定项目，请先使用 /codex bind <projectId>。";
  if (code === "project_busy") return "当前项目已有活跃写任务，请稍后再试。";
  if (code === "unauthorized") return "Runner Token 无效或未加载，请联系运维。";
  return error?.message ?? "Adapter error.";
}
