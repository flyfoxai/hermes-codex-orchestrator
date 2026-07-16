import { createHash } from "node:crypto";

const RENDERER_VERSION = 1;
const MAX_FIXED_POINT_PASSES = 10_000;

function renderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function transitionFence(activeFence, line) {
  if (activeFence) {
    const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
    if (
      close &&
      close[1][0] === activeFence.marker[0] &&
      close[1].length >= activeFence.marker.length
    ) {
      return null;
    }
    return activeFence;
  }

  const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!open) return null;
  return Object.freeze({ marker: open[1], suffix: open[2] });
}

function analyzeText(text) {
  const boundaries = [];
  let activeFence = null;
  let byteOffset = 0;
  let lineStart = 0;
  let position = 0;

  for (const scalar of text) {
    position += scalar.length;
    byteOffset += byteLength(scalar);
    if (scalar === "\n") {
      activeFence = transitionFence(activeFence, text.slice(lineStart, position - 1));
      lineStart = position;
    } else if (position === text.length) {
      activeFence = transitionFence(activeFence, text.slice(lineStart, position));
    }
    boundaries.push({ byteOffset, end: position, fence: activeFence });
  }
  return boundaries;
}

function markerFor(objectiveId, index, total) {
  const shortId = [...objectiveId].slice(0, 8).join("");
  return `[objective ${shortId} result ${index}/${total}]\n`;
}

function syntheticOpen(fence) {
  return fence ? `${fence.marker}${fence.suffix}\n` : "";
}

function syntheticClose(fence, visible) {
  if (!fence) return "";
  return `${visible.endsWith("\n") ? "" : "\n"}${fence.marker}`;
}

function syntheticCloseBytes(fence, endsWithNewline) {
  if (!fence) return 0;
  return (endsWithNewline ? 0 : 1) + fence.marker.length;
}

function renderWithTotal({ boundaries, objectiveId, normalizedText, maxBytes, total }) {
  if (normalizedText.length === 0) {
    const content = markerFor(objectiveId, 1, total);
    if (byteLength(content) > maxBytes) {
      throw renderError("RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.");
    }
    return [content];
  }

  const contents = [];
  let activeAtStart = null;
  let start = 0;
  let startBytes = 0;
  let boundaryIndex = 0;

  while (start < normalizedText.length) {
    const index = contents.length + 1;
    const header = markerFor(objectiveId, index, total);
    const reopen = syntheticOpen(activeAtStart);
    const fixedBytes = byteLength(header) + byteLength(reopen);
    if (fixedBytes > maxBytes) {
      throw renderError("RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.");
    }

    let complete = null;
    let lastParagraph = null;
    let lastLine = null;
    let lastScalar = null;
    for (let candidateIndex = boundaryIndex; candidateIndex < boundaries.length; candidateIndex += 1) {
      const boundary = boundaries[candidateIndex];
      const originalBytes = boundary.byteOffset - startBytes;
      const baseBytes = fixedBytes + originalBytes;
      if (baseBytes > maxBytes) break;

      const endsWithNewline = normalizedText[boundary.end - 1] === "\n";
      const closeFence = boundary.end < normalizedText.length ? boundary.fence : null;
      if (baseBytes + syntheticCloseBytes(closeFence, endsWithNewline) > maxBytes) continue;

      const candidate = { boundary, candidateIndex };
      lastScalar = candidate;
      if (endsWithNewline) {
        lastLine = candidate;
        if (boundary.end - start >= 2 && normalizedText[boundary.end - 2] === "\n") {
          lastParagraph = candidate;
        }
      }
      if (boundary.end === normalizedText.length) complete = candidate;
    }

    const selected = complete ?? lastParagraph ?? lastLine ?? lastScalar;
    if (!selected) {
      throw renderError("RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.");
    }

    const original = normalizedText.slice(start, selected.boundary.end);
    const visible = reopen + original;
    const closeFence = selected.boundary.end < normalizedText.length ? selected.boundary.fence : null;
    contents.push(header + visible + syntheticClose(closeFence, visible));
    activeAtStart = selected.boundary.fence;
    start = selected.boundary.end;
    startBytes = selected.boundary.byteOffset;
    boundaryIndex = selected.candidateIndex + 1;
  }
  return contents;
}

function validateInput(input) {
  if (
    !isPlainObject(input) ||
    typeof input.objectiveId !== "string" ||
    input.objectiveId.length === 0 ||
    typeof input.text !== "string" ||
    (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0))
  ) {
    throw renderError("RENDER_INPUT_INVALID", "Renderer input is invalid.");
  }
  const rendererVersion = input.rendererVersion ?? RENDERER_VERSION;
  if (rendererVersion !== RENDERER_VERSION) {
    throw renderError("RENDER_VERSION_UNSUPPORTED", "Renderer version is unsupported.");
  }
  return {
    maxBytes: input.maxBytes ?? 9_000,
    objectiveId: input.objectiveId,
    rendererVersion,
    text: input.text
  };
}

export function renderFinal(input) {
  const { maxBytes, objectiveId, rendererVersion, text } = validateInput(input);
  const normalizedText = text.replace(/\r\n?/gu, "\n");
  const boundaries = analyzeText(normalizedText);
  let total = 1;
  let contents;

  for (let pass = 0; pass < MAX_FIXED_POINT_PASSES; pass += 1) {
    contents = renderWithTotal({ boundaries, objectiveId, normalizedText, maxBytes, total });
    if (contents.length === total) break;
    if (contents.length < total) {
      throw renderError("RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.");
    }
    total = contents.length;
  }
  if (!contents || contents.length !== total) {
    throw renderError("RENDER_UNREPRESENTABLE", "Renderer byte limit cannot represent a legal chunk.");
  }

  const objectiveHash = createHash("sha256").update(objectiveId, "utf8").digest("hex");
  const chunks = contents.map((content, offset) => {
    const index = offset + 1;
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    return Object.freeze({
      index,
      total,
      content,
      contentHash,
      semanticKey: `renderer:v${rendererVersion}:objective-sha256:${objectiveHash}:${index}:${total}:${contentHash}`,
      rendererVersion
    });
  });
  return Object.freeze(chunks);
}
