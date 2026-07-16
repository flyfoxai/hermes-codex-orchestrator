import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CodexAppServerClient } from "./app-server/client.js";
import { DEFER_SERVER_REQUEST } from "./app-server/rpc-client.js";
import { createBearerAuthenticatorFromToken } from "./bridge/auth.js";
import { createBridge as defaultCreateBridge } from "./bridge/server.js";
import { loadHcoConfig, loadOwnerSecret } from "./config.js";
import { createAppServerBackend } from "./execution/app-server-backend.js";
import { executionBackendError, validateExecutionBackend } from "./execution/backend.js";
import { createHcoService } from "./service.js";
import { openStore as defaultOpenStore } from "./state/store.js";
import { TurnController } from "./turn-controller.js";

const REVERSE_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);

const DIAGNOSTICS = Object.freeze({
  HCO_APP_SERVER_UNAVAILABLE: "Codex App Server is unavailable.",
  HCO_CONNECTION_LOSS_FAILED: "App Server connection loss could not be persisted.",
  HCO_NOTIFICATION_ADAPTER_FAILED: "App Server notification adapter failed.",
  HCO_REVERSE_REQUEST_ADAPTER_FAILED: "App Server reverse request adapter failed."
});

async function unavailable() {
  throw executionBackendError("EXECUTION_BACKEND_UNAVAILABLE", "Execution backend is unavailable.");
}

function createUnavailableAppServerBackend() {
  return validateExecutionBackend(Object.freeze({
    startObjective: unavailable,
    startTurn: unavailable,
    interruptTurn: unavailable,
    readObjective: unavailable,
    reconcileObjective: unavailable,
    respondToInteraction: unavailable,
    getCapabilities() {
      return Object.freeze({
        backend: "app-server",
        durableThreadContinuity: true,
        reverseInteractions: true
      });
    }
  }));
}

function createAppServerAvailabilityGate(backend) {
  const target = validateExecutionBackend(backend);
  let available = false;
  const gated = Object.fromEntries([
    "startObjective",
    "startTurn",
    "interruptTurn",
    "readObjective",
    "reconcileObjective",
    "respondToInteraction"
  ].map((method) => [method, async (...args) => {
    if (!available) return unavailable();
    return target[method](...args);
  }]));
  gated.getCapabilities = () => target.getCapabilities();
  return Object.freeze({
    backend: validateExecutionBackend(Object.freeze(gated)),
    enable() { available = true; }
  });
}

function validFunction(value) {
  return typeof value === "function";
}

async function closeResources(resources) {
  let firstError;
  for (const close of resources) {
    if (!close) continue;
    try {
      await close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function createHcoRuntime({
  configPath,
  env = process.env,
  loadConfig = loadHcoConfig,
  loadSecret = loadOwnerSecret,
  openStore = defaultOpenStore,
  createClient = (options) => new CodexAppServerClient(options),
  createBackend = createAppServerBackend,
  createController = (options) => new TurnController(options),
  createService = createHcoService,
  createBridge = defaultCreateBridge,
  tmuxBackend,
  idFactory = (kind) => `${kind}-${randomUUID()}`,
  now = Date.now,
  onDiagnostic = () => undefined,
  onReverseRequest = () => undefined,
  onNotification = () => undefined
} = {}) {
  if (
    env === null || typeof env !== "object" ||
    ![loadConfig, loadSecret, openStore, createClient, createBackend, createController,
      createService, createBridge, idFactory, now, onDiagnostic, onReverseRequest, onNotification].every(validFunction)
  ) {
    throw new TypeError("HCO runtime options are invalid.");
  }

  const emitDiagnostic = (code) => {
    try { onDiagnostic(Object.freeze({ code, message: DIAGNOSTICS[code] })); } catch { /* diagnostics are observational */ }
  };
  let store;
  let client = null;
  let controller;
  let service;
  let listener;
  let ownsClient = false;

  try {
    const config = await loadConfig({ configPath, env });
    const token = await loadSecret({ path: config.bridge.tokenPath, minBytes: 1, maxBytes: 4096 });
    const contextKey = await loadSecret({ path: config.bridge.contextKeyPath, minBytes: 32, maxBytes: 4096 });
    const authenticator = createBearerAuthenticatorFromToken(token);
    store = await openStore({ databasePath: config.databasePath, idFactory, now });

    const connectionId = idFactory("connection");
    const leaseOwner = idFactory("controller");
    if (typeof connectionId !== "string" || connectionId.length === 0 ||
        typeof leaseOwner !== "string" || leaseOwner.length === 0) {
      throw new TypeError("HCO runtime identifiers are invalid.");
    }

    let terminalHandled = false;
    const handleTerminal = async () => {
      if (terminalHandled) return;
      terminalHandled = true;
      try {
        await controller?.handleConnectionLost({ connectionId });
      } catch {
        emitDiagnostic("HCO_CONNECTION_LOSS_FAILED");
      }
    };
    const handleNotification = async (message) => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => service.handleAppServerNotification({ message })),
        Promise.resolve().then(() => onNotification({ controller, connectionId, message }))
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        emitDiagnostic("HCO_NOTIFICATION_ADAPTER_FAILED");
      }
    };
    const requestHandlers = Object.fromEntries(REVERSE_METHODS.map((method) => [method, async (message) => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => service.handleAppServerRequest({ connectionId, message })),
        Promise.resolve().then(() => onReverseRequest({ controller, connectionId, message }))
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        emitDiagnostic("HCO_REVERSE_REQUEST_ADAPTER_FAILED");
      }
      return DEFER_SERVER_REQUEST;
    }]));

    let appServerBackend;
    let appServerUsable = false;
    try {
      client = createClient({
        executablePath: config.codexExecutablePath,
        requestHandlers,
        onDiagnostic,
        onNotification: handleNotification,
        onTerminal: handleTerminal
      });
      ownsClient = true;
      appServerBackend = createBackend({ client });
      appServerUsable = true;
    } catch {
      emitDiagnostic("HCO_APP_SERVER_UNAVAILABLE");
      appServerBackend = createUnavailableAppServerBackend();
    }

    const appServerGate = createAppServerAvailabilityGate(appServerBackend);
    controller = createController({
      store,
      appServerBackend: appServerGate.backend,
      tmuxBackend,
      leaseOwner
    });
    service = createService({ config, store, turnController: controller, contextKey, idFactory, now });
    const bridge = createBridge({
      store,
      authenticator,
      eventHandler: (event) => service.handleBridgeEvent(event)
    });

    await service.start();
    listener = await bridge.start({ socketPath: config.bridge.socketPath });

    let appServerAvailable = false;
    if (client !== null && appServerUsable) {
      try {
        await client.initialize();
        appServerGate.enable();
        appServerAvailable = true;
      } catch {
        emitDiagnostic("HCO_APP_SERVER_UNAVAILABLE");
      }
    }

    let closePromise;
    const close = () => {
      if (!closePromise) {
        closePromise = closeResources([
          () => listener.close(),
          () => service.close(),
          ownsClient && client ? () => client.close() : null,
          () => store.close()
        ]);
      }
      return closePromise;
    };

    return Object.freeze({
      config,
      store,
      controller,
      service,
      listener,
      client,
      connectionId,
      get appServerAvailable() { return appServerAvailable; },
      close
    });
  } catch (error) {
    try {
      await closeResources([
        listener ? () => listener.close() : null,
        service ? () => service.close() : null,
        ownsClient && client ? () => client.close() : null,
        store ? () => store.close() : null
      ]);
    } catch {
      // Preserve the startup failure rather than replacing it with rollback failure.
    }
    throw error;
  }
}

function isDirectEntry() {
  return typeof process.argv[1] === "string" &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  if (process.argv.length !== 2) {
    console.error("HCO does not accept command-line arguments.");
    process.exitCode = 1;
  } else {
    const runtimePromise = createHcoRuntime({ configPath: process.env.HCO_CONFIG_PATH });
    let shutdownPromise;
    const shutdown = () => {
      if (shutdownPromise) return;
      const shutdownGuard = setInterval(() => {}, 1_000);
      shutdownPromise = runtimePromise
        .then((runtime) => runtime.close())
        .catch(() => { process.exitCode = 1; })
        .finally(() => clearInterval(shutdownGuard));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    runtimePromise.catch(() => {
      console.error("HCO startup failed.");
      process.exitCode = 1;
    });
  }
}
