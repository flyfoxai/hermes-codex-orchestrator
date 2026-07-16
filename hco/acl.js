const ROLES = Object.freeze(["viewer", "contributor", "maintainer", "admin"]);
const PERMISSIONS = Object.freeze({
  "project.read": "viewer",
  "topic.read": "viewer",
  "objective.status": "viewer",
  "objective.create": "contributor",
  "objective.continue": "contributor",
  "objective.cancel": "contributor",
  "interaction.answer": "contributor",
  "topic.manage": "maintainer",
  "route.manage": "maintainer",
  "backend.select": "maintainer"
});

function aclError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exact(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((field) => fields.includes(field)) && fields.every((field) => Object.hasOwn(value, field));
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function createAcl({ admins, projects } = {}) {
  if (!Array.isArray(admins) || !Array.isArray(projects) || admins.some((id) => !positive(id))) {
    throw aclError("ACL_CONFIG_INVALID", "ACL configuration is invalid.");
  }
  const adminSet = new Set(admins);
  const grants = new Map();
  for (const project of projects) {
    if (typeof project?.projectId !== "string" || !project.acl) throw aclError("ACL_CONFIG_INVALID", "ACL configuration is invalid.");
    const roles = new Map();
    for (const [list, role] of [["viewers", "viewer"], ["contributors", "contributor"], ["maintainers", "maintainer"]]) {
      if (!Array.isArray(project.acl[list])) throw aclError("ACL_CONFIG_INVALID", "ACL configuration is invalid.");
      for (const userId of project.acl[list]) {
        if (!positive(userId)) throw aclError("ACL_CONFIG_INVALID", "ACL configuration is invalid.");
        if ((ROLES.indexOf(roles.get(userId)) ?? -1) < ROLES.indexOf(role)) roles.set(userId, role);
      }
    }
    grants.set(project.projectId, roles);
  }

  function roleFor(input) {
    if (!exact(input, ["userId", "projectId"]) || !positive(input.userId) || typeof input.projectId !== "string") {
      throw aclError("ACL_REQUEST_INVALID", "ACL request is invalid.");
    }
    if (adminSet.has(input.userId)) return "admin";
    return grants.get(input.projectId)?.get(input.userId) ?? null;
  }

  function requirePermission(input) {
    const allowed = ["userId", "projectId", "permission"];
    if (input && Object.hasOwn(input, "responderIds")) allowed.push("responderIds");
    if (!exact(input, allowed) || !positive(input.userId) || typeof input.permission !== "string" ||
        (input.projectId !== null && typeof input.projectId !== "string")) {
      throw aclError("ACL_REQUEST_INVALID", "ACL request is invalid.");
    }
    if (input.projectId === null) {
      if (!adminSet.has(input.userId)) throw aclError("ACL_FORBIDDEN", "Permission denied.");
      return Object.freeze({ userId: input.userId, projectId: null, permission: input.permission, role: "admin" });
    }
    const minimum = PERMISSIONS[input.permission];
    if (!minimum) throw aclError("ACL_REQUEST_INVALID", "ACL request is invalid.");
    const role = roleFor({ userId: input.userId, projectId: input.projectId });
    const responderAllowed = input.permission !== "interaction.answer" ||
      (Array.isArray(input.responderIds) && input.responderIds.includes(input.userId));
    if (!role || ROLES.indexOf(role) < ROLES.indexOf(minimum) || !responderAllowed) {
      throw aclError("ACL_FORBIDDEN", "Permission denied.");
    }
    return Object.freeze({ userId: input.userId, projectId: input.projectId, permission: input.permission, role });
  }

  return Object.freeze({ roleFor, require: requirePermission });
}
