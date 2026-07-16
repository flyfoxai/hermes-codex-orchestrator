const METHODS = Object.freeze([
  "startObjective",
  "startTurn",
  "interruptTurn",
  "readObjective",
  "reconcileObjective",
  "respondToInteraction",
  "getCapabilities"
]);

const OWNED_ERRORS = new WeakSet();
const WRITE_UNCERTAINTY = new WeakMap();

export function executionBackendError(code, message, { mayHaveBeenWritten = false } = {}) {
  const error = new Error(message);
  error.code = code;
  OWNED_ERRORS.add(error);
  WRITE_UNCERTAINTY.set(error, mayHaveBeenWritten);
  return error;
}

export function isExecutionBackendError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

export function requestMayHaveBeenWritten(error) {
  return WRITE_UNCERTAINTY.get(error) === true;
}

export function validateExecutionBackend(backend) {
  if (backend === null || typeof backend !== "object" || METHODS.some((method) => typeof backend[method] !== "function")) {
    throw executionBackendError("EXECUTION_BACKEND_INVALID", "Execution backend is invalid.");
  }
  const capabilities = backend.getCapabilities();
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    !["app-server", "tmux"].includes(capabilities.backend) ||
    typeof capabilities.durableThreadContinuity !== "boolean" ||
    typeof capabilities.reverseInteractions !== "boolean"
  ) {
    throw executionBackendError("EXECUTION_BACKEND_INVALID", "Execution backend is invalid.");
  }
  return backend;
}
