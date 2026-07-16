import readline from "node:readline";

const flags = new Set(process.argv.slice(2));
let initialized = false;

if (flags.has("--stderr")) {
  process.stderr.write('fixture warning SECRET=value {"id":999,"result":"not stdout"}\n');
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    lines.close();
    return;
  }

  if (message.method === "initialize" && Object.hasOwn(message, "id")) {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        userAgent: "fake-app-server/0.142.3",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "test"
      }
    })}\n`);
    return;
  }
  if (message.method === "initialized" && !Object.hasOwn(message, "id")) {
    initialized = true;
    return;
  }
  if (!initialized) {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32002, message: "Not initialized." }
    })}\n`);
    return;
  }
  if (flags.has("--exit-on-read") && message.method === "thread/read") {
    process.exit(17);
  }
  if (Object.hasOwn(message, "id")) {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { method: message.method, params: message.params } })}\n`);
  }
});
