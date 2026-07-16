import { randomUUID } from "node:crypto";

import { renderFinal } from "./delivery/renderer.js";
import { requestMayHaveBeenWritten, validateExecutionBackend } from "./execution/backend.js";
import { findTurnByClientId, findTurnById, isTerminalTurn, reduceTerminalOutput } from "./recovery.js";

const OWNED_ERRORS = new WeakSet();
const INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
]);

function controllerError(code, message) {
  const error = new Error(message);
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isTurnControllerError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

function requireText(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096;
}

function validateIntent(input) {
  if (
    input === null || typeof input !== "object" ||
    !requireText(input.sourceType) || !requireText(input.sourceId) ||
    !requireText(input.objectiveId) || !["app-server", "tmux"].includes(input.backend) ||
    typeof input.text !== "string" ||
    input.targetSnapshot === null || typeof input.targetSnapshot !== "object" || Array.isArray(input.targetSnapshot) ||
    (input.threadOptions !== undefined && (input.threadOptions === null || typeof input.threadOptions !== "object" || Array.isArray(input.threadOptions)))
  ) {
    throw controllerError("TURN_INTENT_INVALID", "Turn intent is invalid.");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defaultInteractionRenderer({ interaction }) {
  return {
    semanticKey: `interaction:${interaction.interactionId}:prompt`,
    payload: { content: "Approval or input requested.", kind: "interaction_request" }
  };
}

function validateInteractionRequest(input) {
  if (!isPlainObject(input) || !requireText(input.connectionId) ||
      !["string", "number", "bigint"].includes(typeof input.wireRequestId) ||
      !requireText(input.objectiveId) || !requireText(input.threadId) || !requireText(input.turnId) ||
      (input.itemId !== null && input.itemId !== undefined && !requireText(input.itemId)) ||
      (input.approvalId !== null && input.approvalId !== undefined && !requireText(input.approvalId)) ||
      !isPlainObject(input.request) || !Array.isArray(input.allowedResponderIds) ||
      !isPlainObject(input.targetSnapshot)) {
    throw controllerError("INTERACTION_REQUEST_INVALID", "Interaction request is invalid.");
  }
  if (!INTERACTION_METHODS.has(input.method)) {
    throw controllerError("INTERACTION_REQUEST_UNSUPPORTED", "Interaction request method is unsupported.");
  }
}

function validateInteractionAnswer(input) {
  if (!isPlainObject(input) || !requireText(input.interactionId) ||
      !Number.isSafeInteger(input.responderId) || input.responderId <= 0 ||
      !isPlainObject(input.targetSnapshot) || !isPlainObject(input.answer)) {
    throw controllerError("INTERACTION_ANSWER_INVALID", "Interaction answer is invalid.");
  }
}

export class TurnController {
  #appServerBackend;
  #leaseOwner;
  #interactionRenderer;
  #renderer;
  #store;
  #tmuxBackend;

  constructor({
    store,
    appServerBackend,
    tmuxBackend,
    leaseOwner = `controller-${randomUUID()}`,
    renderer = renderFinal,
    interactionRenderer = defaultInteractionRenderer
  } = {}) {
    if (
      store === null || typeof store !== "object" ||
      typeof store.registerExecutionIntent !== "function" ||
      typeof store.bindBackendObjective !== "function" ||
      typeof store.prepareTurnSubmission !== "function" ||
      typeof store.acknowledgeTurnSubmission !== "function" ||
      typeof store.markSubmissionUnknown !== "function" ||
      typeof store.resolveObjectiveThread !== "function" ||
      typeof store.markTurnReconciliationNeeded !== "function" ||
      typeof store.markBackendFailure !== "function" ||
      typeof store.markConnectionLost !== "function" ||
      typeof store.reconcileTerminalTurn !== "function" ||
      typeof store.reconcileTurnSubmission !== "function" ||
      typeof store.completeTurn !== "function" ||
      typeof store.readTurnOutput !== "function" ||
      typeof store.requestCancellation !== "function" ||
      typeof store.confirmCancellation !== "function" ||
      typeof store.recordTurnAuditFact !== "function" ||
      typeof store.createInteraction !== "function" ||
      typeof store.commitInteractionAnswer !== "function" ||
      typeof store.recordInteractionResponseDelivery !== "function" ||
      typeof store.orphanInteractions !== "function" ||
      typeof store.readInteraction !== "function" ||
      typeof store.readTurnSubmission !== "function" ||
      typeof store.readObjectiveExecution !== "function" ||
      !requireText(leaseOwner) || typeof renderer !== "function" || typeof interactionRenderer !== "function"
    ) {
      throw controllerError("TURN_CONTROLLER_OPTIONS_INVALID", "Turn controller options are invalid.");
    }
    this.#store = store;
    this.#appServerBackend = validateExecutionBackend(appServerBackend);
    this.#tmuxBackend = tmuxBackend === undefined ? null : validateExecutionBackend(tmuxBackend);
    if (this.#appServerBackend.getCapabilities().backend !== "app-server" ||
        (this.#tmuxBackend && this.#tmuxBackend.getCapabilities().backend !== "tmux")) {
      throw controllerError("TURN_CONTROLLER_OPTIONS_INVALID", "Turn controller options are invalid.");
    }
    this.#leaseOwner = leaseOwner;
    this.#renderer = renderer;
    this.#interactionRenderer = interactionRenderer;
  }

  async acceptIntent(input) {
    validateIntent(input);
    const registered = this.#store.registerExecutionIntent(input);
    if (registered.duplicate) {
      return Object.freeze({
        status: "duplicate",
        objectiveId: registered.objectiveId,
        submissionId: registered.submissionId,
        clientUserMessageId: registered.clientUserMessageId,
        turnId: registered.turnId,
        threadId: registered.execution?.threadId ?? null
      });
    }
    if (registered.terminal) {
      return Object.freeze({
        status: registered.execution.executionStatus,
        objectiveId: registered.objectiveId
      });
    }
    if (registered.busy) return Object.freeze({ status: "busy", objectiveId: input.objectiveId });

    const backend = this.#selectedBackend(input.backend);
    if (!backend) {
      this.#store.markBackendFailure({ objectiveId: input.objectiveId, uncertain: false });
      return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
    }

    let execution = registered.execution;
    if (registered.needsObjectiveStart) {
      try {
        const started = input.backend === "app-server"
          ? await backend.startObjective({ objectiveId: input.objectiveId, threadOptions: input.threadOptions ?? {} })
          : await backend.startObjective({ objectiveId: input.objectiveId });
        execution = this.#store.bindBackendObjective({
          objectiveId: input.objectiveId,
          backend: input.backend,
          threadId: input.backend === "app-server" ? started.threadId : null
        });
      } catch (error) {
        const uncertain = requestMayHaveBeenWritten(error);
        this.#store.markBackendFailure({ objectiveId: input.objectiveId, uncertain });
        return Object.freeze({
          status: uncertain ? "reconciliation_needed" : "backend_unavailable",
          objectiveId: input.objectiveId
        });
      }
    }

    const prepared = this.#store.prepareTurnSubmission({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      objectiveId: input.objectiveId,
      text: input.text,
      targetSnapshot: input.targetSnapshot,
      leaseOwner: this.#leaseOwner
    });
    if (prepared.duplicate) {
      return Object.freeze({
        status: "duplicate",
        objectiveId: input.objectiveId,
        submissionId: prepared.submission.submissionId,
        clientUserMessageId: prepared.submission.clientUserMessageId,
        turnId: prepared.submission.turnId,
        threadId: execution.threadId
      });
    }
    if (prepared.busy) return Object.freeze({ status: "busy", objectiveId: input.objectiveId });
    const submission = prepared.submission;

    try {
      const started = input.backend === "app-server"
        ? await backend.startTurn({
            threadId: execution.threadId,
            text: submission.text,
            clientUserMessageId: submission.clientUserMessageId
          })
        : await backend.startTurn({
            objectiveId: input.objectiveId,
            text: submission.text,
            clientUserMessageId: submission.clientUserMessageId
          });
      const acknowledged = this.#store.acknowledgeTurnSubmission({
        submissionId: submission.submissionId,
        turnId: started.turnId
      }).submission;
      return Object.freeze({
        status: "started",
        objectiveId: input.objectiveId,
        backend: input.backend,
        submissionId: acknowledged.submissionId,
        clientUserMessageId: acknowledged.clientUserMessageId,
        threadId: execution.threadId,
        turnId: acknowledged.turnId
      });
    } catch (error) {
      const uncertain = requestMayHaveBeenWritten(error);
      if (uncertain) {
        this.#store.markSubmissionUnknown({ submissionId: submission.submissionId });
      } else {
        this.#store.markBackendFailure({
          objectiveId: input.objectiveId,
          submissionId: submission.submissionId,
          uncertain: false
        });
      }
      return Object.freeze({
        status: uncertain ? "submission_unknown" : "backend_unavailable",
        objectiveId: input.objectiveId,
        submissionId: submission.submissionId,
        clientUserMessageId: submission.clientUserMessageId,
        threadId: execution.threadId
      });
    }
  }

  async continueObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        typeof input.text !== "string" || input.targetSnapshot === null ||
        typeof input.targetSnapshot !== "object" || Array.isArray(input.targetSnapshot)) {
      throw controllerError("TURN_INTENT_INVALID", "Turn intent is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    return this.acceptIntent({
      sourceType: input.sourceType ?? "controller",
      sourceId: input.sourceId ?? `continuation-${randomUUID()}`,
      objectiveId: input.objectiveId,
      backend: execution.backend,
      text: input.text,
      targetSnapshot: input.targetSnapshot,
      threadOptions: input.threadOptions,
      projectId: input.projectId,
      topicBinding: input.topicBinding
    });
  }

  async reconcileObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId)) {
      throw controllerError("RECONCILIATION_INVALID", "Objective reconciliation is invalid.");
    }
    let execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    if (execution.backend === "app-server" && !requireText(execution.threadId)) {
      return Object.freeze({
        status: execution.threadStartUncertain ? "manual_thread_binding_required" : "reconciliation_needed",
        objectiveId: input.objectiveId
      });
    }
    const backend = this.#selectedBackend(execution.backend);
    if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });

    const read = execution.backend === "app-server"
      ? await backend.reconcileObjective({ threadId: execution.threadId })
      : await backend.reconcileObjective({ objectiveId: input.objectiveId });
    const turns = read?.thread?.turns ?? read?.turns ?? [];
    let submission = execution.activeSubmission;
    if (!submission) {
      const completedTurn = turns.find((turn) =>
        requireText(turn?.id) && this.#store.readTurnOutput(input.objectiveId, turn.id)
      );
      if (completedTurn) {
        return Object.freeze({
          status: "completed",
          objectiveId: input.objectiveId,
          turnId: completedTurn.id,
          duplicate: true
        });
      }
      return Object.freeze({ status: execution.executionStatus, objectiveId: input.objectiveId });
    }

    let turn = submission.turnId
      ? findTurnById(turns, submission.turnId)
      : findTurnByClientId(turns, submission.clientUserMessageId);
    if (!turn) {
      return Object.freeze({
        status: submission.turnId ? "reconciliation_needed" : "submission_unknown",
        objectiveId: input.objectiveId,
        turnId: submission.turnId
      });
    }
    if (!submission.turnId) {
      submission = this.#store.reconcileTurnSubmission({
        submissionId: submission.submissionId,
        turnId: turn.id
      }).submission;
      execution = this.#store.readObjectiveExecution(input.objectiveId);
    }
    if (isTerminalTurn(turn)) {
      if (turn.status !== "completed") {
        const reconciled = this.#store.reconcileTerminalTurn({
          objectiveId: input.objectiveId,
          submissionId: submission.submissionId,
          turnId: turn.id,
          remoteStatus: turn.status,
          sourceType: "reconciliation",
          sourceId: input.sourceId ?? `turn-${turn.id}-${turn.status}`
        });
        return Object.freeze({
          status: reconciled.status,
          objectiveId: input.objectiveId,
          turnId: turn.id,
          duplicate: reconciled.duplicate
        });
      }
      return this.handleTurnCompleted({
        objectiveId: input.objectiveId,
        turn,
        sourceType: "reconciliation",
        sourceId: input.sourceId ?? `turn-${turn.id}-completed`
      });
    }
    return Object.freeze({ status: "running", objectiveId: input.objectiveId, turnId: submission.turnId });
  }

  async reconcile(input) {
    return this.reconcileObjective(input);
  }

  resolveObjectiveThread(input) {
    if (!isPlainObject(input) || !requireText(input.objectiveId) || !requireText(input.threadId) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("OBJECTIVE_THREAD_RESOLUTION_INVALID", "Objective thread resolution is invalid.");
    }
    const resolved = this.#store.resolveObjectiveThread(input);
    return Object.freeze({
      status: resolved.execution.executionStatus,
      objectiveId: resolved.execution.objectiveId,
      threadId: resolved.execution.threadId,
      duplicate: resolved.duplicate
    });
  }

  async handleTurnCompleted(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        input.turn === null || typeof input.turn !== "object" || !requireText(input.turn.id) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("TURN_COMPLETION_INVALID", "Turn completion is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const durableSubmission = this.#store.readTurnSubmission(input.objectiveId, input.turn.id);
    if (durableSubmission?.cancellationRequested && durableSubmission.state === "cancelled") {
      this.#store.recordTurnAuditFact({
        objectiveId: input.objectiveId,
        turnId: input.turn.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        fact: { kind: "late_completion", turn: input.turn }
      });
      return Object.freeze({
        status: "cancelled",
        objectiveId: input.objectiveId,
        turnId: input.turn.id,
        suppressed: true
      });
    }
    if (this.#store.readTurnOutput(input.objectiveId, input.turn.id)) {
      return Object.freeze({ status: "completed", objectiveId: input.objectiveId, turnId: input.turn.id, duplicate: true });
    }

    let turn = input.turn;
    if (turn.itemsView !== "full") {
      const backend = this.#selectedBackend(execution.backend);
      if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
      const read = execution.backend === "app-server"
        ? await backend.readObjective({ threadId: execution.threadId })
        : await backend.readObjective({ objectiveId: input.objectiveId });
      turn = findTurnById(read?.thread?.turns ?? read?.turns ?? [], input.turn.id);
    }
    const output = reduceTerminalOutput(turn);
    if (!output || output.text.length === 0) {
      this.#store.markTurnReconciliationNeeded({ objectiveId: input.objectiveId, turnId: input.turn.id });
      return Object.freeze({ status: "reconciliation_needed", objectiveId: input.objectiveId, turnId: input.turn.id });
    }
    const completed = this.#store.completeTurn({
      objectiveId: input.objectiveId,
      turnId: input.turn.id,
      rawText: output.text,
      itemIds: output.itemIds,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      renderer: this.#renderer
    });
    return Object.freeze({
      status: "completed",
      objectiveId: input.objectiveId,
      turnId: input.turn.id,
      duplicate: completed.duplicate
    });
  }

  async cancelObjective(input) {
    if (input === null || typeof input !== "object" || !requireText(input.objectiveId) ||
        !requireText(input.sourceType) || !requireText(input.sourceId)) {
      throw controllerError("TURN_CANCELLATION_INVALID", "Turn cancellation request is invalid.");
    }
    const execution = this.#store.readObjectiveExecution(input.objectiveId);
    if (!execution) throw controllerError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
    const requested = this.#store.requestCancellation(input);
    if (requested.duplicate) {
      return Object.freeze({
        status: requested.confirmed ? "cancelled" : "reconciliation_needed",
        objectiveId: input.objectiveId,
        turnId: requested.submission.turnId,
        duplicate: true
      });
    }
    const backend = this.#selectedBackend(execution.backend);
    if (!backend) return Object.freeze({ status: "backend_unavailable", objectiveId: input.objectiveId });
    try {
      if (execution.backend === "app-server") {
        await backend.interruptTurn({ threadId: execution.threadId, turnId: requested.submission.turnId });
      } else {
        await backend.interruptTurn({ objectiveId: input.objectiveId, turnId: requested.submission.turnId });
      }
    } catch (error) {
      return Object.freeze({
        status: requestMayHaveBeenWritten(error) ? "reconciliation_needed" : "backend_unavailable",
        objectiveId: input.objectiveId,
        turnId: requested.submission.turnId
      });
    }
    const confirmed = this.#store.confirmCancellation({
      objectiveId: input.objectiveId,
      submissionId: requested.submission.submissionId,
      sourceType: input.sourceType,
      sourceId: input.sourceId
    });
    return Object.freeze({
      status: "cancelled",
      objectiveId: input.objectiveId,
      turnId: requested.submission.turnId,
      duplicate: confirmed.duplicate
    });
  }

  async handleInteractionRequest(input) {
    validateInteractionRequest(input);
    const created = this.#store.createInteraction({ ...input, renderer: this.#interactionRenderer });
    return Object.freeze({
      status: created.interaction.state,
      objectiveId: created.interaction.objectiveId,
      interactionId: created.interaction.interactionId,
      expiresAt: created.interaction.expiresAt,
      duplicate: created.duplicate
    });
  }

  async answerInteraction(input) {
    validateInteractionAnswer(input);
    const committed = this.#store.commitInteractionAnswer(input);
    if (!committed.accepted) {
      const failures = {
        not_found: ["INTERACTION_NOT_FOUND", "Interaction does not exist."],
        orphaned: ["INTERACTION_ORPHANED", "Interaction is orphaned."],
        expired: ["INTERACTION_EXPIRED", "Interaction has expired."],
        unauthorized: ["INTERACTION_UNAUTHORIZED", "Interaction responder is not authorized."],
        target_mismatch: ["INTERACTION_TARGET_MISMATCH", "Interaction target does not match."],
        conflict: ["INTERACTION_ANSWER_CONFLICT", "Interaction already has a different answer."]
      };
      const [code, message] = failures[committed.reason] ?? ["INTERACTION_ANSWER_INVALID", "Interaction answer is invalid."];
      throw controllerError(code, message);
    }
    const interaction = committed.interaction;
    if (committed.duplicate && interaction.responseDeliveryState !== "retryable") {
      return Object.freeze({
        status: interaction.responseDeliveryState === "delivered" ? "answered" : "response_uncertain",
        objectiveId: interaction.objectiveId,
        interactionId: interaction.interactionId,
        duplicate: true
      });
    }
    const execution = this.#store.readObjectiveExecution(interaction.objectiveId);
    const backend = execution ? this.#selectedBackend(execution.backend) : null;
    if (!backend) throw controllerError("INTERACTION_BACKEND_UNAVAILABLE", "Interaction backend is unavailable.");
    try {
      await backend.respondToInteraction({
        interactionId: interaction.interactionId,
        wireRequestId: interaction.wireRequestId,
        result: interaction.answer
      });
    } catch (error) {
      const uncertain = requestMayHaveBeenWritten(error);
      this.#store.recordInteractionResponseDelivery({
        interactionId: interaction.interactionId,
        state: uncertain ? "uncertain" : "retryable"
      });
      return Object.freeze({
        status: uncertain ? "response_uncertain" : "response_retryable",
        objectiveId: interaction.objectiveId,
        interactionId: interaction.interactionId,
        duplicate: committed.duplicate
      });
    }
    this.#store.recordInteractionResponseDelivery({ interactionId: interaction.interactionId, state: "delivered" });
    return Object.freeze({
      status: "answered",
      objectiveId: interaction.objectiveId,
      interactionId: interaction.interactionId,
      duplicate: committed.duplicate
    });
  }

  orphanInteractions(input) {
    if (!isPlainObject(input) || !requireText(input.connectionId)) {
      throw controllerError("INTERACTION_ORPHAN_INVALID", "Interaction orphan request is invalid.");
    }
    return Object.freeze(this.#store.orphanInteractions(input));
  }

  handleConnectionLost(input) {
    if (!isPlainObject(input) || !requireText(input.connectionId)) {
      throw controllerError("CONNECTION_LOSS_INVALID", "Connection loss record is invalid.");
    }
    const lost = this.#store.markConnectionLost(input);
    return Object.freeze({ status: "reconciliation_needed", ...lost });
  }

  #selectedBackend(selection) {
    if (selection === "app-server") return this.#appServerBackend;
    if (selection === "tmux") return this.#tmuxBackend;
    return null;
  }
}
