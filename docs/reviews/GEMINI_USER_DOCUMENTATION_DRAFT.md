# Hermes Codex Orchestrator

Hermes Codex Orchestrator is a Runner HTTP API that bridges the Hermes chat bot and the local Codex CLI. It receives tasks via HTTP, translates them into Markdown files within a project directory, and dispatches them to Codex using `tmux`.

This allows Hermes to orchestrate tasks across remote or local development environments without directly managing source code context, API keys, or command execution.

## Supported Runtime Model

1. Hermes calls the Runner's HTTP API to register a project or create a task.
2. The Runner creates task and dispatch files in the project's `.hermes/` directory.
3. The Runner ensures a `tmux` session exists for the project, optionally starts Codex, and pastes a short read command to the Codex TUI.
4. Codex executes the task based on the Markdown file and writes the status and result back to the same file.
5. The Runner API reads the updated task file to provide status, logs, and completion summaries back to Hermes.

## Prerequisites

- Node.js: `>=20`.
- macOS or Linux: required for `tmux` and `codex` execution. `tmux` must be installed and available in your `PATH`.
- Codex CLI: must be installed, logged in (`codex login status`), and accessible.
- Windows: can run the HTTP API and handle project/task registration, but the MVP does not support local `tmux` dispatch.

## Installation and Local Verification

Clone the repository and install dependencies:

```bash
git clone <repo-url> hermes-codex-orchestrator
cd hermes-codex-orchestrator
npm install
```

Run the verification suite to ensure the environment is healthy. This suite uses temporary configurations and a mock Codex where appropriate, so it will not affect your real projects:

```bash
npm run verify
```

## Authentication: Safe Token Workflow

The Runner API requires a static Bearer token for authentication. By default, it operates in a fail-closed `token` mode (`HCO_AUTH_MODE=token`).

Generate a Token:

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
```

Load the Token:

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
```

Security rules:

- Never store real tokens in the repository, configuration files (`orchestrator.json`, `projects.json`), `.hermes` task files, service definitions, logs, or your shell history.
- The token file must be owned by the user running the Runner and have `0600` permissions.

## Starting the Runner

Once the token is loaded in your environment, start the Runner:

```bash
npm start
```

By default, the Runner listens on `127.0.0.1:8731`.

Authentication modes:

- `HCO_AUTH_MODE=token`: the default and recommended mode. Requires `HCO_API_TOKEN`.
- `HCO_AUTH_MODE=none`: only allowed for exact loopback hosts (`127.0.0.1` or `::1`). Useful for local debugging but logs a warning. `localhost` is not permitted.

## API Usage Example

Before making API calls, ensure the token is loaded in your shell:

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
```

### 1. Register a Project

Projects must be registered before tasks can be created for them.

```sh
curl -X POST http://127.0.0.1:8731/projects/stockprofits \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stock Profits",
    "path": "/Users/hula/Projects/stockprofits",
    "allowCodeChanges": true,
    "allowNetwork": true
  }'
```

### 2. Create and Dispatch a Task

Create a task and immediately dispatch it to Codex by setting `"dispatch": true`.

```sh
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
    "constraints": ["先只读检查，不修改代码。"],
    "acceptanceCriteria": ["给出当前阶段和结论。"],
    "dispatch": true
  }'
```

### 3. Query State

Check the health of the Runner, list projects, view tasks, or inspect sessions:

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/health
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/projects
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks?limit=20"
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/tasks/<taskId>
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/tasks/<taskId>/logs
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/tasks/<taskId>/raw
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
```

## Generated Project Files

When a task is created, the Runner generates the following files in the registered project's `.hermes/` directory:

- `.hermes/tasks/<taskId>.md`: the source of truth for the task. Contains the goal, constraints, and current status. Codex reads this file and writes results back to it.
- `.hermes/logs/<taskId>.log`: the Runner's operational log for this specific task.
- `.hermes/dispatch/<taskId>.md`: the rendered prompt sent to Codex via tmux to initiate the task.

## Operational Boundaries

- Run only one Runner instance per configuration root directory. The file-based concurrency model does not guarantee strong consistency across multiple Runner processes managing the same projects.
- The Runner API must not be exposed directly to the public internet.
- If accessing the API over a Tailscale network or LAN, you must use `token` mode and configure a controlled reverse proxy or Tailscale Serve.
- For long-running deployments (launchd on macOS, systemd on Linux), refer to the detailed instructions in `docs/OPERATIONS.md`.

## FAQ & Troubleshooting

- `HCO_API_TOKEN is required when HCO_AUTH_MODE=token`: ensure your `~/.hco/token` file exists, has `0600` permissions, and is correctly exported into the environment running the Runner process.
- `tmux was not found in PATH`: verify that `tmux` is installed (`tmux -V`). If running via a daemon, ensure the service's `PATH` environment variable includes the directory where `tmux` is located.
- Task created but Codex is not doing anything: check active sessions with `/sessions` or `tmux ls`. Attach to the session (`tmux attach -t codex-<projectId>`) to see if the command was pasted. If the command is visible but has not executed, try increasing `pasteSubmitDelayMs` in `config/orchestrator.json`.
- Configuration files: by default, `config/orchestrator.json` configures the Runner, and `config/projects.json` stores the registered projects.

## Further Reading

- [`docs/SETUP.md`](../SETUP.md): detailed installation and pre-flight checks.
- [`docs/OPERATIONS.md`](../OPERATIONS.md): daemon configuration (launchd/systemd), operational principles, and production deployment boundaries.
- [`HTTP_API_INTEGRATION.md`](../../HTTP_API_INTEGRATION.md): comprehensive API documentation for Hermes integration.
- [`docs/STATUS.md`](../STATUS.md): current development status and upcoming features.
