function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function zulipTargetKey({ streamId, topic } = {}) {
  if (!Number.isSafeInteger(streamId) || streamId <= 0) {
    throw identityError("ZULIP_STREAM_ID_INVALID", "Zulip streamId must be a positive numeric ID.");
  }
  if (typeof topic !== "string" || topic.trim().length === 0) {
    throw identityError("ZULIP_TOPIC_INVALID", "Zulip topic must be a non-empty string.");
  }

  return `zulip:${streamId}/${topic}`;
}
