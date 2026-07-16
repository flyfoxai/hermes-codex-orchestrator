const READ_VERBS = new Set(["projects", "sessions", "status", "logs", "ask", "bind"]);
const MAINTAINER_VERBS = new Set(["dispatch"]);
const ADMIN_VERBS = new Set(["raw"]);

export function checkPermission({ command, user, taskRecord } = {}) {
  const role = user?.role ?? "member";
  const verb = command?.verb;

  if (role === "admin") return { allowed: true };
  if (ADMIN_VERBS.has(verb)) return { allowed: false, reason: "admin_required" };
  if (role === "maintainer") return { allowed: true };
  if (verb === "topic") {
    return user?.id
      ? { allowed: true }
      : { allowed: false, reason: "authenticated_user_required" };
  }
  if (verb === "route") {
    return command?.action === "show"
      ? { allowed: true }
      : { allowed: false, reason: "maintainer_required" };
  }
  if (MAINTAINER_VERBS.has(verb)) return { allowed: false, reason: "maintainer_required" };
  if (verb === "run") return { allowed: false, reason: "write_permission_required" };
  if (verb === "cancel") {
    return taskRecord?.requestedByUserId === user?.id
      ? { allowed: true }
      : { allowed: false, reason: "task_owner_required" };
  }
  if (READ_VERBS.has(verb)) return { allowed: true };
  return { allowed: false, reason: "unsupported_command" };
}
