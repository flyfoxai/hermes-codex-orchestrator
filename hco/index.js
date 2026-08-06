import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CodexAppServerClient } from "./app-server/client.js";
import { DEFER_SERVER_REQUEST } from "./app-server/rpc-client.js";
import { createBearerAuthenticatorFromToken } from "./bridge/auth.js";
import { createBridge as defaultCreateBridge } from "./bridge/server.js";
import { loadHcoConfig, loadOwnerSecret } from "./config.js";
import { reconcileActiveCodexCalls } from "./coordination-recovery.js";
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
  HCO_REVERSE_REQUEST_ADAPTER_FAILED: "App Server reverse request adapter failed.",
  HCO_STARTUP_RECONCILIATION_FAILED: "Active Codex calls could not be reconciled after connection."
});

function modelCatalogUnavailable() {
  const error = new Error("Codex model catalog is unavailable.");
  error.code = "MODEL_CATALOG_UNAVAILABLE";
  return error;
}

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

function createAppServerAvailabilityGate() {
  const unavailableBackend = createUnavailableAppServerBackend();
  let target = null;
  const gated = Object.fromEntries([
    "startObjective",
    "startTurn",
    "interruptTurn",
    "readObjective",
    "reconcileObjective",
    "respondToInteraction"
  ].map((method) => [method, async (...args) => {
    if (target === null) return unavailable();
    return target[method](...args);
  }]));
  gated.getCapabilities = () => (target ?? unavailableBackend).getCapabilities();
  return Object.freeze({
    backend: validateExecutionBackend(Object.freeze(gated)),
    install(backend) { target = validateExecutionBackend(backend); },
    disable() { target = null; },
    isAvailable() { return target !== null; }
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
  scheduleRetry = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelRetry = (handle) => clearTimeout(handle),
  onDiagnostic = () => undefined,
  onReverseRequest = () => undefined,
  onNotification = () => undefined
} = {}) {
  if (
    env === null || typeof env !== "object" ||
    ![loadConfig, loadSecret, openStore, createClient, createBackend, createController,
      createService, createBridge, idFactory, now, scheduleRetry, cancelRetry,
      onDiagnostic, onReverseRequest, onNotification].every(validFunction)
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

    const leaseOwner = idFactory("controller");
    if (typeof leaseOwner !== "string" || leaseOwner.length === 0) {
      throw new TypeError("HCO runtime identifiers are invalid.");
    }
    const appServerGate = createAppServerAvailabilityGate();
    const modelCatalog = Object.freeze({
      async listModels(options) {
        if (!client || !appServerGate.isAvailable()) throw modelCatalogUnavailable();
        return client.listModels(options);
      }
    });
    controller = createController({
      store,
      appServerBackend: appServerGate.backend,
      tmuxBackend,
      leaseOwner
    });
    service = createService({ config, store, turnController: controller, contextKey, modelCatalog, idFactory, now });
    const bridge = createBridge({
      store,
      authenticator,
      eventHandler: (event) => service.handleBridgeEvent(event),
      healthProvider: () => ({ appServerAvailable: appServerGate.isAvailable() }),
      modelProvider: (options) => service.listModels(options)
    });

    await service.start();
    listener = await bridge.start({ socketPath: config.bridge.socketPath });

    let appServerAvailable = false;
    let closing = false;
    let connectionId = null;
    let connection = null;
    let connectionGeneration = 0;
    let connectPromise = null;
    let retryHandle = null;
    let retryNeeded = false;
    let retryAttempt = 0;
    const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

    const closeCandidate = async (candidate) => {
      if (!candidate?.client || candidate.closed) return;
      candidate.closed = true;
      await candidate.client.close();
    };

    const scheduleReconnect = () => {
      if (closing || retryHandle !== null) return;
      if (connectPromise !== null) {
        retryNeeded = true;
        return;
      }
      const delayMs = retryDelays[Math.min(retryAttempt, retryDelays.length - 1)];
      retryAttempt += 1;
      retryHandle = scheduleRetry(() => {
        retryHandle = null;
        return connect();
      }, delayMs);
    };

    const disconnect = async (candidate) => {
      if (candidate.terminal) return;
      candidate.terminal = true;
      if (connection !== candidate) return;
      const wasAvailable = appServerGate.isAvailable();
      appServerGate.disable();
      appServerAvailable = false;
      connection = null;
      client = null;
      if (wasAvailable) {
        try {
          await controller.handleConnectionLost({ connectionId: candidate.connectionId });
        } catch {
          emitDiagnostic("HCO_CONNECTION_LOSS_FAILED");
        }
      }
      try { await closeCandidate(candidate); } catch { /* reconnect remains authoritative */ }
      scheduleReconnect();
    };

    const connect = () => {
      if (closing) return Promise.resolve();
      if (connectPromise !== null) return connectPromise;
      connectPromise = (async () => {
        const candidate = {
          client: null,
          connectionId: idFactory("connection"),
          generation: ++connectionGeneration,
          closed: false,
          terminal: false
        };
        if (typeof candidate.connectionId !== "string" || candidate.connectionId.length === 0) {
          throw new TypeError("HCO runtime identifiers are invalid.");
        }
        try {
          const handleNotification = async (message) => {
            if (connection !== candidate || candidate.terminal) return;
            const outcomes = await Promise.allSettled([
              Promise.resolve().then(() => service.handleAppServerNotification({ message })),
              Promise.resolve().then(() => onNotification({
                controller, connectionId: candidate.connectionId, message
              }))
            ]);
            if (outcomes.some((outcome) => outcome.status === "rejected")) {
              emitDiagnostic("HCO_NOTIFICATION_ADAPTER_FAILED");
            }
          };
          const requestHandlers = Object.fromEntries(REVERSE_METHODS.map((method) => [method, async (message) => {
            if (connection !== candidate || candidate.terminal) return DEFER_SERVER_REQUEST;
            const outcomes = await Promise.allSettled([
              Promise.resolve().then(() => service.handleAppServerRequest({
                connectionId: candidate.connectionId, message
              })),
              Promise.resolve().then(() => onReverseRequest({
                controller, connectionId: candidate.connectionId, message
              }))
            ]);
            if (outcomes.some((outcome) => outcome.status === "rejected")) {
              emitDiagnostic("HCO_REVERSE_REQUEST_ADAPTER_FAILED");
            }
            return DEFER_SERVER_REQUEST;
          }]));
          candidate.client = createClient({
            executablePath: config.codexExecutablePath,
            requestHandlers,
            onDiagnostic,
            onNotification: handleNotification,
            onTerminal: () => disconnect(candidate)
          });
          ownsClient = true;
          connection = candidate;
          client = candidate.client;
          connectionId = candidate.connectionId;
          const backend = createBackend({ client: candidate.client });
          await candidate.client.initialize();
          if (closing || connection !== candidate || candidate.terminal) {
            throw new Error("connection superseded");
          }
          appServerGate.install(backend);
          appServerAvailable = true;
          retryAttempt = 0;
          try {
            await reconcileActiveCodexCalls({
              store,
              turnController: controller,
              sourcePrefix: `connection-recovery:${candidate.connectionId}`
            });
          } catch {
            emitDiagnostic("HCO_STARTUP_RECONCILIATION_FAILED");
          }
        } catch {
          if (connection === candidate) {
            connection = null;
            client = null;
          }
          appServerGate.disable();
          appServerAvailable = false;
          if (candidate.client && !candidate.terminal) {
            try { await closeCandidate(candidate); } catch { /* degraded startup remains usable */ }
          }
          emitDiagnostic("HCO_APP_SERVER_UNAVAILABLE");
          scheduleReconnect();
        }
      })().finally(() => {
        connectPromise = null;
        if (retryNeeded) {
          retryNeeded = false;
          scheduleReconnect();
        }
      });
      return connectPromise;
    };

    await connect();

    let closePromise;
    const close = () => {
      if (!closePromise) {
        closing = true;
        if (retryHandle !== null) {
          cancelRetry(retryHandle);
          retryHandle = null;
        }
        appServerGate.disable();
        appServerAvailable = false;
        const activeConnection = connection;
        connection = null;
        client = null;
        closePromise = closeResources([
          () => listener.close(),
          () => service.close(),
          ownsClient && activeConnection ? () => closeCandidate(activeConnection) : null,
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
      get client() { return client; },
      get connectionId() { return connectionId; },
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
