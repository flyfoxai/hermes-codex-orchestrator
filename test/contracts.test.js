import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { signContext, verifyContext } from "../hco/contracts/envelope.js";
import { zulipTargetKey } from "../hco/contracts/identity.js";
import { negotiateBridge } from "../hco/contracts/protocol.js";

const KEY = Buffer.alloc(32, 0x5a);
const NOW = 1_700_000_000;
const BINDING = Object.freeze({
  streamId: 123,
  topic: "Build",
  sourceMessageId: 456,
  senderId: 789
});

function payload(overrides = {}) {
  return {
    version: 1,
    issuedAt: NOW - 10,
    expiresAt: NOW + 110,
    nonce: "nonce-1",
    binding: { ...BINDING },
    context: { command: "run", projectId: "hco" },
    ...overrides
  };
}

function assertCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

function acceptingReplayStore() {
  return { consume: () => true };
}

function verificationOptions(overrides = {}) {
  return {
    now: () => NOW,
    expectedBinding: BINDING,
    replayStore: acceptingReplayStore(),
    ...overrides
  };
}

test("numeric stream identity produces a stable Zulip target key", () => {
  assert.equal(zulipTargetKey({ streamId: 123, topic: "Build" }), "zulip:123/Build");
});

test("invalid or display-name stream identities fail with a stable code", () => {
  for (const input of [
    { topic: "Build" },
    { streamId: "123", topic: "Build" },
    { streamId: 0, topic: "Build" },
    { streamId: -1, topic: "Build" },
    { stream: "engineering", topic: "Build" }
  ]) {
    assert.throws(() => zulipTargetKey(input), (error) => assertCode(error, "ZULIP_STREAM_ID_INVALID"));
  }

  assert.throws(
    () => zulipTargetKey({ streamId: 123, topic: "   " }),
    (error) => assertCode(error, "ZULIP_TOPIC_INVALID")
  );
});

test("bridge protocol major 1 preserves version identity and negotiates known capabilities", () => {
  assert.deepEqual(
    negotiateBridge(
      {
        protocolVersion: 1,
        pluginVersion: "0.3.0",
        capabilities: ["signed_context", "unknown", "nonce_replay"]
      },
      { supportedMajors: [1], knownCapabilities: ["signed_context", "message_binding"] }
    ),
    {
      protocolVersion: 1,
      peerPluginVersion: "0.3.0",
      capabilities: ["signed_context"]
    }
  );
});

test("bridge capabilities must be a dense array of non-empty strings", () => {
  const sparse = [];
  sparse.length = 1;
  for (const capabilities of [undefined, null, {}, "signed_context", [1], [""], ["   "], sparse]) {
    const request = { protocolVersion: 1, pluginVersion: "0.3.0" };
    if (capabilities !== undefined) request.capabilities = capabilities;
    assert.throws(
      () => negotiateBridge(request),
      (error) => assertCode(error, "BRIDGE_CAPABILITIES_INVALID")
    );
  }
});

test("valid capability arrays allow empty input and preserve filtered deduplication", () => {
  assert.deepEqual(
    negotiateBridge({ protocolVersion: 1, pluginVersion: "0.3.0", capabilities: [] }),
    { protocolVersion: 1, peerPluginVersion: "0.3.0", capabilities: [] }
  );
  assert.deepEqual(
    negotiateBridge({
      protocolVersion: 1,
      pluginVersion: "0.3.0",
      capabilities: ["unknown", "signed_context", "signed_context"]
    }),
    { protocolVersion: 1, peerPluginVersion: "0.3.0", capabilities: ["signed_context"] }
  );
});

test("an unsupported bridge major fails before reading capabilities", () => {
  let capabilityReads = 0;
  let pluginVersionReads = 0;
  const request = { protocolVersion: 2 };
  Object.defineProperty(request, "pluginVersion", {
    get() {
      pluginVersionReads += 1;
      return "0.3.0";
    }
  });
  Object.defineProperty(request, "capabilities", {
    get() {
      capabilityReads += 1;
      return ["signed_context"];
    }
  });

  assert.throws(
    () => negotiateBridge(request, { supportedMajors: [1], knownCapabilities: ["signed_context"] }),
    (error) => assertCode(error, "BRIDGE_VERSION_UNSUPPORTED")
  );
  assert.equal(pluginVersionReads, 0);
  assert.equal(capabilityReads, 0);
});

test("bridge protocol version must be the supported positive integer", () => {
  for (const protocolVersion of [undefined, "1", 0, -1, 1.5]) {
    assert.throws(
      () => negotiateBridge({ protocolVersion, pluginVersion: "0.3.0", capabilities: [] }),
      (error) => assertCode(error, "BRIDGE_VERSION_UNSUPPORTED")
    );
  }
});

test("pluginVersion must be non-empty and no more than 64 UTF-8 bytes", () => {
  for (const pluginVersion of [undefined, "", "   ", "a".repeat(65), "版".repeat(22)]) {
    assert.throws(
      () => negotiateBridge({ protocolVersion: 1, pluginVersion, capabilities: [] }),
      (error) => assertCode(error, "BRIDGE_PLUGIN_VERSION_INVALID")
    );
  }
});

test("canonical JSON makes equivalent payloads produce the same token", () => {
  const first = payload();
  const second = {
    nonce: first.nonce,
    context: { projectId: "hco", command: "run" },
    expiresAt: first.expiresAt,
    binding: {
      senderId: BINDING.senderId,
      sourceMessageId: BINDING.sourceMessageId,
      topic: BINDING.topic,
      streamId: BINDING.streamId
    },
    issuedAt: first.issuedAt,
    version: first.version
  };

  assert.equal(signContext(first, KEY), signContext(second, KEY));
});

test("verification rejects a valid HMAC over non-canonical JSON", () => {
  const nonCanonicalJson = JSON.stringify(payload());
  const encodedPayload = Buffer.from(nonCanonicalJson, "utf8").toString("base64url");
  const encodedSignature = createHmac("sha256", KEY)
    .update(encodedPayload, "ascii")
    .digest("base64url");

  assert.throws(
    () => verifyContext(`${encodedPayload}.${encodedSignature}`, KEY, verificationOptions()),
    (error) => assertCode(error, "CONTEXT_CANONICAL_INVALID")
  );
});

test("canonical JSON rejects non-JSON values and cycles", () => {
  assert.throws(
    () => signContext(payload({ context: { command: undefined } }), KEY),
    (error) => assertCode(error, "CONTEXT_PAYLOAD_INVALID")
  );

  const cyclic = payload();
  cyclic.context.self = cyclic;
  assert.throws(
    () => signContext(cyclic, KEY),
    (error) => assertCode(error, "CONTEXT_PAYLOAD_INVALID")
  );

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => signContext(payload({ context: { arguments: sparse } }), KEY),
    (error) => assertCode(error, "CONTEXT_PAYLOAD_INVALID")
  );
});

test("payload or signature tampering fails authentication", () => {
  const token = signContext(payload(), KEY);
  const [encodedPayload, encodedSignature] = token.split(".");
  const flip = (value) => `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;

  for (const tampered of [
    `${flip(encodedPayload)}.${encodedSignature}`,
    `${encodedPayload}.${flip(encodedSignature)}`
  ]) {
    assert.throws(
      () => verifyContext(tampered, KEY, verificationOptions()),
      (error) => assertCode(error, "CONTEXT_SIGNATURE_INVALID")
    );
  }
});

test("signature decoding rejects non-canonical base64url", () => {
  const token = signContext(payload(), KEY);

  assert.throws(
    () => verifyContext(`${token}=`, KEY, verificationOptions()),
    (error) => assertCode(error, "CONTEXT_SIGNATURE_INVALID")
  );
});

test("a token lifetime over 120 seconds fails", () => {
  const token = signContext(payload({ expiresAt: NOW + 111 }), KEY);

  assert.throws(
    () => verifyContext(token, KEY, verificationOptions()),
    (error) => assertCode(error, "CONTEXT_LIFETIME_INVALID")
  );
});

test("context envelope version is required and only integer version 1 is supported", () => {
  for (const version of [undefined, "1", 0, 2, 1.5]) {
    const candidate = payload({ version });
    if (version === undefined) delete candidate.version;
    const token = signContext(candidate, KEY);

    assert.throws(
      () => verifyContext(token, KEY, verificationOptions()),
      (error) => assertCode(error, "CONTEXT_VERSION_UNSUPPORTED")
    );
  }
});

test("expired and more-than-30-seconds-future tokens fail under an injected clock", () => {
  const expired = signContext(payload({ issuedAt: NOW - 151, expiresAt: NOW - 31 }), KEY);
  const future = signContext(payload({ issuedAt: NOW + 31, expiresAt: NOW + 120 }), KEY);

  assert.throws(
    () => verifyContext(expired, KEY, verificationOptions()),
    (error) => assertCode(error, "CONTEXT_EXPIRED")
  );
  assert.throws(
    () => verifyContext(future, KEY, verificationOptions()),
    (error) => assertCode(error, "CONTEXT_NOT_YET_VALID")
  );
});

test("exactly 30 seconds of clock skew is accepted and larger configuration is rejected", () => {
  const expiredAtBoundary = signContext(
    payload({ issuedAt: NOW - 150, expiresAt: NOW - 30, nonce: "expired-boundary" }),
    KEY
  );
  const futureAtBoundary = signContext(
    payload({ issuedAt: NOW + 30, expiresAt: NOW + 120, nonce: "future-boundary" }),
    KEY
  );

  assert.equal(verifyContext(expiredAtBoundary, KEY, verificationOptions()).nonce, "expired-boundary");
  assert.equal(verifyContext(futureAtBoundary, KEY, verificationOptions()).nonce, "future-boundary");
  assert.throws(
    () => verifyContext(futureAtBoundary, KEY, verificationOptions({ clockSkewSeconds: 31 })),
    (error) => assertCode(error, "CONTEXT_OPTIONS_INVALID")
  );
});

test("stream, topic, source message, and sender binding mismatches fail", () => {
  const token = signContext(payload(), KEY);
  const mismatches = [
    { streamId: 999 },
    { topic: "Release" },
    { sourceMessageId: 999 },
    { senderId: 999 }
  ];

  for (const mismatch of mismatches) {
    assert.throws(
      () => verifyContext(token, KEY, verificationOptions({ expectedBinding: { ...BINDING, ...mismatch } })),
      (error) => assertCode(error, "CONTEXT_BINDING_MISMATCH")
    );
  }
});

test("payload and expected bindings must contain correctly typed identity fields", () => {
  const invalidBindings = [
    { topic: "Build", sourceMessageId: 456, senderId: 789 },
    { streamId: 0, topic: "Build", sourceMessageId: 456, senderId: 789 },
    { streamId: 123, topic: " ", sourceMessageId: 456, senderId: 789 },
    { streamId: 123, topic: "Build", sourceMessageId: "456", senderId: 789 },
    { streamId: 123, topic: "Build", sourceMessageId: 456, senderId: -1 }
  ];

  for (const binding of invalidBindings) {
    const tokenWithInvalidBinding = signContext(payload({ binding }), KEY);
    assert.throws(
      () => verifyContext(tokenWithInvalidBinding, KEY, verificationOptions()),
      (error) => assertCode(error, "CONTEXT_BINDING_INVALID")
    );

    const validToken = signContext(payload(), KEY);
    assert.throws(
      () => verifyContext(validToken, KEY, verificationOptions({ expectedBinding: binding })),
      (error) => assertCode(error, "CONTEXT_BINDING_INVALID")
    );
  }
});

test("replay store atomically consumes nonce and expiry exactly once", () => {
  const calls = [];
  const replayStore = {
    consume(candidate) {
      calls.push(candidate);
      return true;
    }
  };
  const token = signContext(payload(), KEY);

  verifyContext(token, KEY, verificationOptions({ replayStore }));
  assert.deepEqual(calls, [{ nonce: "nonce-1", expiresAt: NOW + 110 }]);
});

test("replay store false result rejects the nonce as replayed", () => {
  const token = signContext(payload(), KEY);

  assert.throws(
    () => verifyContext(token, KEY, verificationOptions({ replayStore: { consume: () => false } })),
    (error) => assertCode(error, "CONTEXT_NONCE_REPLAYED")
  );
});

test("missing, malformed, and non-boolean replay stores fail closed", () => {
  const token = signContext(payload(), KEY);
  for (const replayStore of [undefined, {}, { has: () => false, add: () => {} }, { consume: () => 1 }, { consume: () => Promise.resolve(true) }]) {
    const options = { now: () => NOW, expectedBinding: BINDING };
    if (replayStore !== undefined) options.replayStore = replayStore;
    assert.throws(
      () => verifyContext(token, KEY, options),
      (error) => assertCode(error, "CONTEXT_REPLAY_STORE_INVALID")
    );
  }
});

test("replay store exceptions fail closed without leaking internal details", () => {
  const internalSecret = "database-secret-detail";
  const token = signContext(payload(), KEY);

  assert.throws(
    () => verifyContext(token, KEY, verificationOptions({
      replayStore: {
        consume() {
          throw new Error(internalSecret);
        }
      }
    })),
    (error) => {
      assertCode(error, "CONTEXT_REPLAY_STORE_FAILED");
      assert.equal(error.message.includes(internalSecret), false);
      return true;
    }
  );
});

test("the same token fails on its second atomic nonce consumption", () => {
  const consumed = new Set();
  const replayStore = {
    consume({ nonce }) {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    }
  };
  const token = signContext(payload(), KEY);
  const options = verificationOptions({ replayStore });

  verifyContext(token, KEY, options);
  assert.throws(
    () => verifyContext(token, KEY, options),
    (error) => assertCode(error, "CONTEXT_NONCE_REPLAYED")
  );
});

test("oversized encoded tokens fail before parsing payload content", () => {
  const oversizedMalformedToken = `${"!".repeat(129)}.signature`;

  assert.throws(
    () => verifyContext(oversizedMalformedToken, KEY, { maxTokenBytes: 128, now: () => NOW }),
    (error) => assertCode(error, "CONTEXT_TOKEN_TOO_LARGE")
  );
});

test("keys shorter than 32 bytes fail without leaking key material", () => {
  const shortKey = "short-secret-material";

  for (const operation of [
    () => signContext(payload(), shortKey),
    () => verifyContext("payload.signature", shortKey, { now: () => NOW })
  ]) {
    assert.throws(operation, (error) => {
      assertCode(error, "CONTEXT_KEY_TOO_SHORT");
      assert.equal(error.message.includes(shortKey), false);
      return true;
    });
  }
});

test("verification returns a deeply immutable payload", () => {
  const token = signContext(payload(), KEY);
  const verified = verifyContext(token, KEY, verificationOptions());

  assert.deepEqual(verified, payload());
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.binding), true);
  assert.equal(Object.isFrozen(verified.context), true);
  assert.throws(() => {
    verified.context.command = "ask";
  }, TypeError);
});
