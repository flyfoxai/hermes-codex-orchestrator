function isCompletedAgentMessage(item) {
  return item !== null && typeof item === "object" &&
    item.type === "agentMessage" && (item.status === undefined || item.status === "completed") &&
    typeof item.id === "string" && item.id.length > 0 && typeof item.text === "string";
}

export function findTurnByClientId(turns, clientId) {
  if (!Array.isArray(turns) || typeof clientId !== "string" || clientId.length === 0) return null;
  return turns.find((turn) => Array.isArray(turn?.items) && turn.items.some((item) =>
    item?.type === "userMessage" && item.clientId === clientId
  )) ?? null;
}

export function findTurnById(turns, turnId) {
  if (!Array.isArray(turns) || typeof turnId !== "string" || turnId.length === 0) return null;
  return turns.find((turn) => turn?.id === turnId) ?? null;
}

export function isTerminalTurn(turn) {
  return turn?.status === "completed" || turn?.status === "failed" || turn?.status === "cancelled";
}

export function reduceTerminalOutput(turn) {
  if (turn?.status !== "completed" || turn.itemsView !== "full" || !Array.isArray(turn.items)) return null;

  const completed = turn.items.filter(isCompletedAgentMessage);
  const finalAnswers = completed.filter((item) => item.phase === "final_answer");
  if (finalAnswers.length > 0) {
    return Object.freeze({
      text: finalAnswers.map((item) => item.text).join("\n\n"),
      itemIds: finalAnswers.map((item) => item.id)
    });
  }

  const legacyCandidates = completed.filter((item) => item.phase !== "commentary");
  if (legacyCandidates.length === 0 || legacyCandidates.some((item) =>
    item.phase !== null && item.phase !== undefined && item.phase !== "unknown"
  )) {
    return null;
  }
  const selected = legacyCandidates.at(-1);
  return Object.freeze({ text: selected.text, itemIds: [selected.id] });
}
