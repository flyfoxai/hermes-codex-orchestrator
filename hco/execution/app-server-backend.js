import { executionBackendError, validateExecutionBackend } from "./backend.js";

const PREWRITE_CODES = new Set([
  "APP_SERVER_CLIENT_ARGUMENT_INVALID",
  "APP_SERVER_CLIENT_CLOSED",
  "APP_SERVER_CLIENT_NOT_INITIALIZED"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredMethod(client, method) {
  if (typeof client?.[method] !== "function") {
    throw executionBackendError("EXECUTION_BACKEND_INVALID", "Execution backend is invalid.");
  }
}

async function callClient(operation) {
  try {
    return await operation();
  } catch (error) {
    throw executionBackendError(
      PREWRITE_CODES.has(error?.code) ? "EXECUTION_BACKEND_UNAVAILABLE" : "EXECUTION_BACKEND_REQUEST_UNCERTAIN",
      PREWRITE_CODES.has(error?.code) ? "Execution backend is unavailable." : "Execution backend request outcome is uncertain.",
      { mayHaveBeenWritten: !PREWRITE_CODES.has(error?.code) }
    );
  }
}

function resultId(result, container, kind) {
  const id = result?.[container]?.id ?? result?.[`${kind}Id`];
  if (typeof id !== "string" || id.length === 0) {
    throw executionBackendError("EXECUTION_BACKEND_RESPONSE_INVALID", "Execution backend returned an invalid response.", {
      mayHaveBeenWritten: true
    });
  }
  return id;
}

export function createAppServerBackend({ client } = {}) {
  for (const method of ["startThread", "startTurn", "interruptTurn", "readThread", "respond", "respondError"]) {
    requiredMethod(client, method);
  }

  return validateExecutionBackend(Object.freeze({
    async startObjective({ threadOptions = {} } = {}) {
      const result = await callClient(() => client.startThread(threadOptions));
      return Object.freeze({ threadId: resultId(result, "thread", "thread") });
    },
    async startTurn({ threadId, text, clientUserMessageId }) {
      const result = await callClient(() => client.startTurn({ threadId, text, clientUserMessageId }));
      return Object.freeze({ turnId: resultId(result, "turn", "turn") });
    },
    interruptTurn({ threadId, turnId }) {
      return callClient(() => client.interruptTurn({ threadId, turnId }));
    },
    readObjective({ threadId }) {
      return callClient(() => client.readThread({ threadId, includeTurns: true }));
    },
    reconcileObjective({ threadId }) {
      return callClient(() => client.readThread({ threadId, includeTurns: true }));
    },
    respondToInteraction({ wireRequestId, result, error }) {
      if ((result === undefined) === (error === undefined) || !isObject(result ?? error)) {
        throw executionBackendError("EXECUTION_INTERACTION_RESPONSE_INVALID", "Interaction response is invalid.");
      }
      return callClient(() => error === undefined
        ? client.respond(wireRequestId, result)
        : client.respondError(wireRequestId, error));
    },
    getCapabilities() {
      return Object.freeze({
        backend: "app-server",
        durableThreadContinuity: true,
        reverseInteractions: true
      });
    }
  }));
}
