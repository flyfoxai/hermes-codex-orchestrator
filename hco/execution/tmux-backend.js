import { executionBackendError, validateExecutionBackend } from "./backend.js";
import { UNSUPPORTED_FILE_EXCHANGE_CAPABILITY } from "../file-exchange/contracts.js";

const EXECUTOR_METHODS = Object.freeze([
  "startObjective",
  "startTurn",
  "interruptTurn",
  "readObjective",
  "reconcileObjective",
  "respondToInteraction"
]);

export function createTmuxBackend({ executor } = {}) {
  if (executor === null || typeof executor !== "object" ||
      EXECUTOR_METHODS.some((method) => typeof executor?.[method] !== "function")) {
    throw executionBackendError("EXECUTION_BACKEND_INVALID", "Execution backend is invalid.");
  }

  return validateExecutionBackend(Object.freeze({
    startObjective(options) {
      return executor.startObjective(options);
    },
    startTurn(options) {
      return executor.startTurn(options);
    },
    interruptTurn(options) {
      return executor.interruptTurn(options);
    },
    readObjective(options) {
      return executor.readObjective(options);
    },
    reconcileObjective(options) {
      return executor.reconcileObjective(options);
    },
    respondToInteraction(options) {
      return executor.respondToInteraction(options);
    },
    getCapabilities() {
      return Object.freeze({
        backend: "tmux",
        durableThreadContinuity: false,
        reverseInteractions: false,
        fileExchange: UNSUPPORTED_FILE_EXCHANGE_CAPABILITY
      });
    }
  }));
}
