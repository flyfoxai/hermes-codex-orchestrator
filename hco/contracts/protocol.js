const DEFAULT_SUPPORTED_MAJORS = Object.freeze([1]);
const DEFAULT_KNOWN_CAPABILITIES = Object.freeze([
  "signed_context",
  "message_binding",
  "nonce_replay"
]);

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function negotiateBridge(request, options = {}) {
  const supportedMajors = options.supportedMajors ?? DEFAULT_SUPPORTED_MAJORS;
  const protocolVersion = request?.protocolVersion;

  // Version rejection deliberately precedes access to any other request field.
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0 || !supportedMajors.includes(protocolVersion)) {
    throw contractError("BRIDGE_VERSION_UNSUPPORTED", "Bridge protocol major version is unsupported.");
  }

  const pluginVersion = request.pluginVersion;
  if (
    typeof pluginVersion !== "string" ||
    pluginVersion.trim().length === 0 ||
    Buffer.byteLength(pluginVersion, "utf8") > 64
  ) {
    throw contractError("BRIDGE_PLUGIN_VERSION_INVALID", "Bridge pluginVersion is invalid.");
  }

  const requestedCapabilities = request.capabilities;
  if (!Array.isArray(requestedCapabilities)) {
    throw contractError("BRIDGE_CAPABILITIES_INVALID", "Bridge capabilities are invalid.");
  }
  for (let index = 0; index < requestedCapabilities.length; index += 1) {
    if (
      !Object.hasOwn(requestedCapabilities, index) ||
      typeof requestedCapabilities[index] !== "string" ||
      requestedCapabilities[index].trim().length === 0
    ) {
      throw contractError("BRIDGE_CAPABILITIES_INVALID", "Bridge capabilities are invalid.");
    }
  }

  const knownCapabilities = new Set(options.knownCapabilities ?? DEFAULT_KNOWN_CAPABILITIES);
  const capabilities = [...new Set(requestedCapabilities)].filter((capability) =>
    knownCapabilities.has(capability)
  );

  return { protocolVersion, peerPluginVersion: pluginVersion, capabilities };
}
