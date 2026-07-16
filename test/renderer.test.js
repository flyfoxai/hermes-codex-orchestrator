import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renderFinal } from "../hco/delivery/renderer.js";
import { openStore } from "../hco/state/store.js";

function assertCode(error, code, message) {
  assert.equal(error?.code, code);
  if (message !== undefined) assert.equal(error?.message, message);
  return true;
}

function marker(objectiveId, index, total) {
  return `[objective ${[...objectiveId].slice(0, 8).join("")} result ${index}/${total}]`;
}

function semanticKey(rendererVersion, objectiveId, index, total, contentHash) {
  const objectiveHash = createHash("sha256").update(objectiveId, "utf8").digest("hex");
  return `renderer:v${rendererVersion}:objective-sha256:${objectiveHash}:${index}:${total}:${contentHash}`;
}

test("renders empty and normalized technical text with immutable hashed identities", () => {
  const objectiveId = "alpha-🚀-bravo";
  const chunks = renderFinal({ objectiveId, text: "one\r\ntwo\rthree", maxBytes: 200 });

  assert.equal(Object.isFrozen(chunks), true);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    index: 1,
    total: 1,
    content: `${marker(objectiveId, 1, 1)}\none\ntwo\nthree`,
    contentHash: createHash("sha256").update(`${marker(objectiveId, 1, 1)}\none\ntwo\nthree`, "utf8").digest("hex"),
    semanticKey: semanticKey(
      1,
      objectiveId,
      1,
      1,
      createHash("sha256").update(`${marker(objectiveId, 1, 1)}\none\ntwo\nthree`, "utf8").digest("hex")
    ),
    rendererVersion: 1
  });
  assert.equal(Object.getPrototypeOf(chunks[0]), Object.prototype);
  assert.equal(Object.isFrozen(chunks[0]), true);

  const empty = renderFinal({ objectiveId: "short", text: "", maxBytes: 100 });
  assert.equal(empty[0].content, "[objective short result 1/1]\n");
});

test("uses a bounded full-objective digest semantic key accepted by the real store", (t) => {
  const objectiveId = "o".repeat(512);
  const [chunk] = renderFinal({ objectiveId, text: "boundary result" });
  const expectedKey = semanticKey(1, objectiveId, 1, 1, chunk.contentHash);

  assert.equal(chunk.semanticKey, expectedKey);
  assert.ok(Buffer.byteLength(chunk.semanticKey, "utf8") <= 512);

  const directory = mkdtempSync(path.join(tmpdir(), "hco-renderer-"));
  const store = openStore({ databasePath: path.join(directory, "authority.sqlite3") });
  t.after(() => store.close());
  store.ingest({
    sourceType: "renderer-test",
    sourceId: "objective-boundary",
    eventName: "objective.created",
    schemaVersion: 1,
    objectiveId,
    payload: { state: "created" }
  });
  const ingested = store.ingest({
    sourceType: "renderer-test",
    sourceId: "delivery-boundary",
    eventName: "zulip.delivery.requested",
    schemaVersion: 1,
    objectiveId,
    payload: {
      messages: [{
        semanticKey: chunk.semanticKey,
        payload: { type: "stream", content: chunk.content },
        targetSnapshot: { streamId: 42, topic: "Boundary" }
      }]
    }
  });
  assert.equal(ingested.outbox[0].semanticKey, expectedKey);
});

test("splits at paragraph, line, then Unicode scalar boundaries without exceeding UTF-8 limits", () => {
  const objectiveId = "obj";
  const headerBytes = Buffer.byteLength(`${marker(objectiveId, 1, 2)}\n`, "utf8");

  const paragraphs = renderFinal({
    objectiveId,
    text: "first paragraph\n\nsecond paragraph",
    maxBytes: headerBytes + Buffer.byteLength("first paragraph\n\n", "utf8")
  });
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].content.endsWith("first paragraph\n\n"), true);

  const lines = renderFinal({ objectiveId, text: "first line\nsecond line", maxBytes: headerBytes + 11 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].content.endsWith("first line\n"), true);

  const scalars = renderFinal({ objectiveId, text: "🚀🚀🚀", maxBytes: headerBytes + 4 });
  assert.equal(scalars.length, 3);
  assert.deepEqual(scalars.map((chunk) => chunk.content.slice(chunk.content.indexOf("\n") + 1)), ["🚀", "🚀", "🚀"]);
  assert.ok(scalars.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= headerBytes + 4));

  const word = renderFinal({ objectiveId, text: "abcdefghijk", maxBytes: headerBytes + 3 });
  assert.deepEqual(word.map((chunk) => chunk.content.slice(chunk.content.indexOf("\n") + 1)), ["abc", "def", "ghi", "jk"]);
});

test("closes and reopens backtick and tilde fences with the original info suffix", () => {
  const backticks = renderFinal({
    objectiveId: "fence",
    text: "```js title=x\nconst alpha = 1;\nconst beta = 2;\n```",
    maxBytes: 67
  });
  assert.ok(backticks.length > 1);
  assert.equal(backticks[0].content.endsWith("\n```"), true);
  assert.match(backticks[1].content, /result 2\/\d+\]\n```js title=x\n/);
  assert.ok(backticks.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= 67));

  const tildes = renderFinal({
    objectiveId: "fence",
    text: "~~~~python\nprint('alpha')\nprint('beta')\n~~~~",
    maxBytes: 65
  });
  assert.ok(tildes.length > 1);
  assert.equal(tildes[0].content.endsWith("\n~~~~"), true);
  assert.match(tildes[1].content, /result 2\/\d+\]\n~~~~python\n/);
  assert.ok(tildes.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= 65));
});

test("retries are deeply equal and fixed-point totals survive the 9-to-10 transition", () => {
  const input = { objectiveId: "digits", text: "x".repeat(80), maxBytes: 33 };
  const first = renderFinal(input);
  const second = renderFinal(input);

  assert.deepEqual(first, second);
  assert.ok(first.length >= 10);
  assert.ok(first.every((chunk, index) => {
    const expectedMarker = `${marker(input.objectiveId, index + 1, first.length)}\n`;
    return chunk.total === first.length && chunk.index === index + 1 && chunk.content.startsWith(expectedMarker);
  }));
  assert.ok(first.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= input.maxBytes));
  assert.ok(first.every((chunk) => chunk.contentHash === createHash("sha256").update(chunk.content, "utf8").digest("hex")));
});

test("long text with small chunks stays within a linear UTF-8 measurement budget", () => {
  const sourceLength = 1_000;
  const originalByteLength = Buffer.byteLength;
  let measurements = 0;
  Buffer.byteLength = function measuredByteLength(...args) {
    measurements += 1;
    return originalByteLength(...args);
  };

  try {
    const chunks = renderFinal({ objectiveId: "scale", text: "x".repeat(sourceLength), maxBytes: 40 });
    assert.ok(chunks.length > 100);
    assert.ok(
      measurements <= sourceLength * 20,
      `expected at most ${sourceLength * 20} UTF-8 measurements, received ${measurements}`
    );
  } finally {
    Buffer.byteLength = originalByteLength;
  }
});

test("rejects malformed inputs, unsupported versions, and impossible limits without reflecting input", () => {
  const secret = "do-not-reflect-this";
  for (const input of [null, {}, { objectiveId: secret, text: 1 }, { objectiveId: "", text: secret }]) {
    assert.throws(
      () => renderFinal(input),
      (error) => {
        assertCode(error, "RENDER_INPUT_INVALID", "Renderer input is invalid.");
        assert.equal(error.message.includes(secret), false);
        return true;
      }
    );
  }
  assert.throws(
    () => renderFinal({ objectiveId: "obj", text: secret, rendererVersion: 2 }),
    (error) => assertCode(error, "RENDER_VERSION_UNSUPPORTED", "Renderer version is unsupported.")
  );
  assert.throws(
    () => renderFinal({ objectiveId: "obj", text: secret, maxBytes: 5 }),
    (error) => assertCode(error, "RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.")
  );
});
