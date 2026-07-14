# User Documentation Draft Request

You are reviewing `/Users/hula/Projects/hermes-codex-orchestrator`.

Write one complete Markdown candidate for the project's user-facing documentation. The candidate should be suitable to become the root `README.md` after Codex reviews and merges the Claude and Gemini drafts.

## Constraints

- Do not edit files, run deployment commands, install LaunchAgents/systemd services, expose ports, or change configuration.
- Do not print full API keys, API tokens, or secrets.
- Do not claim the project is already deployed or safe for direct public exposure.
- Keep commands consistent with the current repository, especially `package.json`, `docs/SETUP.md`, `docs/OPERATIONS.md`, and `HTTP_API_INTEGRATION.md`.
- Prefer clear, practical Chinese. English command names, file names, environment variables, and API paths should remain literal.

## Required Content

The draft must cover:

1. What Hermes Codex Orchestrator does.
2. Supported runtime model: Hermes calls Runner HTTP API, Runner writes task files and dispatches to Codex through tmux.
3. Prerequisites:
   - Node.js `>=20`.
   - macOS/Linux with `tmux` and `codex` for dispatch.
   - Windows can use API/project/task flows, but MVP does not support local tmux dispatch.
4. Install and local verification:
   - `npm install`
   - `npm run verify`
   - mention that verification uses temporary configs/projects and fake Codex where appropriate.
5. Safe Token workflow:
   - generate a repository-external token file under `~/.hco/token`.
   - permission `0600`.
   - load it with `export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"`.
   - never store real tokens in the repository, task files, service definitions, logs, or shell history.
6. Runner startup:
   - `npm start`
   - default `127.0.0.1:8731`.
   - `HCO_AUTH_MODE=token` default and fail-closed behavior.
   - `HCO_AUTH_MODE=none` only allowed for exact loopback hosts `127.0.0.1` or `::1`.
7. Register a project with `POST /projects/:projectId`.
8. Create a task, optionally with `"dispatch": true`.
9. Query health, projects, tasks, logs, raw task file, and sessions.
10. Explain generated project files:
    - `.hermes/tasks/<taskId>.md`
    - `.hermes/logs/<taskId>.log`
    - `.hermes/dispatch/<taskId>.md`
11. Operational boundaries:
    - one Runner per config root.
    - no direct public exposure.
    - Tailscale/LAN requires Token mode and separate validation.
    - LaunchAgent/systemd setup belongs in `docs/OPERATIONS.md`.
12. A short FAQ/troubleshooting section.
13. Links to:
    - `docs/SETUP.md`
    - `docs/OPERATIONS.md`
    - `HTTP_API_INTEGRATION.md`
    - `docs/STATUS.md`

## Output Format

Return only the candidate Markdown document. Do not wrap it in commentary.
