import { adapterError } from "./errors.js";

function joinUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function withQuery(pathname, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${pathname}?${text}` : pathname;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw adapterError("runner_bad_response", "Runner returned a non-JSON response.");
  }
}

export function createRunnerClient({ baseUrl, token, fetchImpl = fetch }) {
  async function requestJson(method, pathname, body) {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, pathname), { method, headers, body: payload });
    } catch {
      throw adapterError("runner_unreachable", "Runner is unreachable.");
    }
    const json = await parseJsonResponse(response);
    if (!response.ok) {
      const runnerError = json?.error ?? {};
      const error = adapterError(runnerError.code ?? "runner_error", runnerError.message ?? "Runner request failed.");
      error.status = response.status;
      error.details = runnerError.details ?? {};
      throw error;
    }
    return json;
  }

  return {
    health: () => requestJson("GET", "health"),
    projects: () => requestJson("GET", "projects"),
    sessions: () => requestJson("GET", "sessions"),
    putProject: (projectId, body) => requestJson("PUT", `projects/${encodeURIComponent(projectId)}`, body),
    createTask: (body) => requestJson("POST", "tasks", body),
    listTasks: ({ projectId, status, limit } = {}) => requestJson("GET", withQuery("tasks", { projectId, status, limit })),
    getTask: (taskId) => requestJson("GET", `tasks/${encodeURIComponent(taskId)}`),
    getLogs: (taskId, { limit } = {}) => requestJson("GET", withQuery(`tasks/${encodeURIComponent(taskId)}/logs`, { limit })),
    getRaw: (taskId) => requestJson("GET", `tasks/${encodeURIComponent(taskId)}/raw`),
    dispatch: (taskId) => requestJson("POST", `tasks/${encodeURIComponent(taskId)}/dispatch`),
    cancel: (taskId, body = {}) => requestJson("POST", `tasks/${encodeURIComponent(taskId)}/cancel`, body)
  };
}
