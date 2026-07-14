import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const files = [
  "adapter/types.js",
  "adapter/errors.js",
  "adapter/config.js",
  "adapter/runner-client.js",
  "adapter/state-store.js",
  "adapter/commands.js",
  "adapter/router.js",
  "adapter/permissions.js",
  "adapter/write-gate.js",
  "adapter/handler.js",
  "adapter/poller.js",
  "adapter/index.js",
  "scripts/adapter-check.js",
  "scripts/adapter-foundation-test.js",
  "scripts/adapter-handler-test.js",
  "scripts/adapter-poller-test.js",
  "scripts/adapter-cli-test.js"
];

for (const file of files) {
  if (!existsSync(file)) continue;
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

console.log("adapter check ok");
