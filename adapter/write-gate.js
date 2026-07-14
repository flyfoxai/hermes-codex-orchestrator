export function checkWriteGate(state, projectId) {
  const active = state?.activeWriters?.[projectId];
  if (!active) return { blocked: false };
  return { blocked: true, activeTaskId: active.taskId ?? active };
}

export function reserveActiveWriter(state, projectId, taskId, owner = {}) {
  state.activeWriters ??= {};
  state.activeWriters[projectId] = {
    taskId,
    userId: owner.userId ?? null,
    reservedAt: new Date().toISOString()
  };
  return state.activeWriters[projectId];
}

export function releaseActiveWriter(state, projectId, taskId) {
  if (!state?.activeWriters?.[projectId]) return false;
  const activeTaskId = state.activeWriters[projectId].taskId ?? state.activeWriters[projectId];
  if (activeTaskId !== taskId) return false;
  delete state.activeWriters[projectId];
  return true;
}
