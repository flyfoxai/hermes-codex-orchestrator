const SECRET_PATTERNS = [
  /(Authorization:\s*Bearer\s+)[^\s]+/gi,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(token["']?\s*[:=]\s*["']?)[^"',\s]+/gi
];

export function redact(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "$1[REDACTED]");
  }
  return text;
}

export function log(level, message, meta = {}) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message: redact(message),
    ...Object.fromEntries(
      Object.entries(meta).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value])
    )
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

