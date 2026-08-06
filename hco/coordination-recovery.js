const TERMINAL_CALL_STATES = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

function requiredMethod(owner, name) {
  if (typeof owner?.[name] !== "function") {
    throw new TypeError(`Coordination recovery requires ${name}().`);
  }
}

function submissionStatus(status) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "terminal_error") return "terminal_error";
  if (status === "running") return "accepted";
  return "reconciliation_needed";
}

function callMatchesResult(store, call, result, activeForObjective) {
  if (result.turnId) {
    const bound = store.readCallForTurn({ objectiveId: call.objectiveId, turnId: result.turnId });
    if (bound) return bound.codexCallId === call.codexCallId;
    if (call.turnId) return call.turnId === result.turnId;
    return activeForObjective === 1;
  }
  return activeForObjective === 1;
}

export async function reconcileCodexCall({
  store,
  turnController,
  call,
  activeForObjective = 1,
  sourceId
}) {
  for (const method of ["readCodexCall", "readCallForTurn", "recordCodexCallSubmission"]) {
    requiredMethod(store, method);
  }
  requiredMethod(turnController, "reconcileObjective");
  if (!call || typeof call.codexCallId !== "string" || typeof call.objectiveId !== "string" ||
      !Number.isSafeInteger(activeForObjective) || activeForObjective < 1 ||
      typeof sourceId !== "string" || sourceId.length === 0) {
    throw new TypeError("Coordination recovery input is invalid.");
  }

  let result;
  try {
    result = await turnController.reconcileObjective({ objectiveId: call.objectiveId, sourceId });
  } catch {
    result = { status: "reconciliation_needed", objectiveId: call.objectiveId };
  }

  let current = store.readCodexCall(call.codexCallId);
  if (!current || TERMINAL_CALL_STATES.has(current.state)) {
    return Object.freeze({ codexCallId: call.codexCallId, result, updated: false });
  }
  const matches = callMatchesResult(store, current, result, activeForObjective);
  const status = matches ? submissionStatus(result.status) : "reconciliation_needed";
  store.recordCodexCallSubmission({
    codexCallId: current.codexCallId,
    objectiveId: current.objectiveId,
    status,
    turnId: matches ? (result.turnId ?? current.turnId ?? null) : (current.turnId ?? null),
    threadId: matches ? (result.threadId ?? null) : null
  });
  current = store.readCodexCall(call.codexCallId);
  return Object.freeze({ codexCallId: call.codexCallId, result, updated: true, state: current.state });
}

export async function reconcileActiveCodexCalls({ store, turnController, sourcePrefix = "startup-recovery" }) {
  requiredMethod(store, "listRecoverableCodexCalls");
  const calls = store.listRecoverableCodexCalls();
  if (!Array.isArray(calls)) throw new TypeError("Recoverable Codex calls must be an array.");

  const counts = new Map();
  for (const call of calls) {
    counts.set(call.objectiveId, (counts.get(call.objectiveId) ?? 0) + 1);
  }
  const outcomes = [];
  for (const call of calls) {
    outcomes.push(await reconcileCodexCall({
      store,
      turnController,
      call,
      activeForObjective: counts.get(call.objectiveId),
      sourceId: `${sourcePrefix}:${call.codexCallId}`
    }));
  }
  return Object.freeze(outcomes);
}
