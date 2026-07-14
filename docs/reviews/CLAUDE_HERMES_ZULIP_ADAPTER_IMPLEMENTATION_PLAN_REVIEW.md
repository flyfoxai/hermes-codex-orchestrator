# Claude Hermes/Zulip Adapter Implementation Plan Review

Date: 2026-07-14

## Source

Claude CLI was asked to create a Markdown implementation plan for the Hermes/Zulip adapter MVP without editing files.

Claude's draft proposed:

- adapter config loading and repository-external token file;
- Runner HTTP client;
- command parser;
- project router;
- permissions;
- JSON state store;
- same-project write gate;
- poller;
- platform interface;
- Zulip webhook and Hermes stub;
- Node-based test scripts.

## Accepted

- Modular split around config, client, commands, routing, permissions, state, write gate, poller, and handler.
- Use Node.js built-ins and avoid new runtime dependencies.
- Test with mock Runner/harness instead of a real external Runner.
- Persist task notification state and active writer state.
- Keep raw task content admin-only.

## Corrected Before Final Plan

- The first implementation phase is platform-neutral adapter core, not a Zulip webhook implementation.
- State persistence is mandatory for `bindings`, `tasks`, and `activeWriters`; in-memory-only persistence is not accepted.
- `/codex bind <projectId>` binds the current Zulip topic/Hermes conversation target.
- Project verification uses `GET /projects` and filtering; there is no current `GET /projects/:id`.
- `/codex ask <task>` is read-only by default. `/codex run <projectId> <task>` is write-intent and permission-gated.
- Shell glob-dependent checks are avoided by adding `scripts/adapter-check.js`.
- Empty placeholder tests were removed from the final plan; every implementation task starts with behavior tests.

## Final Plan

The reviewed and corrected implementation plan is:

- `docs/superpowers/plans/2026-07-14-hermes-zulip-adapter.md`

