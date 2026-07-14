#!/usr/bin/env node
import { loadAdapterConfig } from "./config.js";
import { createRunnerClient } from "./runner-client.js";
import { handleMessage } from "./handler.js";
import { recoverPolling } from "./poller.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--config") {
      args.config = argv[++i];
    } else if (value === "--message") {
      args.message = argv[++i];
    } else if (value === "--recover") {
      args.recover = true;
    } else {
      args._.push(value);
    }
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    throw Object.assign(new Error("Missing --config."), { code: "invalid_args", status: 1 });
  }

  const { config, token } = await loadAdapterConfig(args.config);
  const client = createRunnerClient({ baseUrl: config.runnerBaseUrl, token });

  if (args.recover) {
    const notifications = [];
    await recoverPolling({
      client,
      config,
      statePath: config.adapterStatePath,
      notify: async (payload) => notifications.push(payload)
    });
    printJson({ notifications });
    return;
  }

  if (!args.message) {
    throw Object.assign(new Error("Provide --message or --recover."), { code: "invalid_args", status: 1 });
  }

  const message = JSON.parse(args.message);
  const replies = await handleMessage(message, {
    config,
    client,
    statePath: config.adapterStatePath,
    now: () => new Date()
  });
  printJson({ replies });
}

main().catch((error) => {
  process.stderr.write(`${error.message ?? "Adapter CLI failed."}\n`);
  process.exitCode = error.status ?? 1;
});
