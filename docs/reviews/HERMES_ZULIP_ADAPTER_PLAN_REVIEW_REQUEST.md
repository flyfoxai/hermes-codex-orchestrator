# Hermes/Zulip adapter integration plan review request

Review `/Users/hula/Projects/hermes-codex-orchestrator/docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`.

Use the repository as context, especially:

- `runner/http.js`
- `runner/config.js`
- `runner/task-store.js`
- `config/projects.json`
- `HTTP_API_INTEGRATION.md`
- `docs/OPERATIONS.md`
- `README.md`

Do not edit files and do not write code. Return a Markdown review with:

1. Accuracy findings, especially mismatches with the current Runner implementation.
2. Security gaps in the Hermes/Zulip adapter plan.
3. Multi-project and same-project concurrency risks.
4. Missing fields or API usage details Hermes needs.
5. Specific improvements to make the document actionable for implementation.
6. A readiness verdict:
   - `READY_FOR_IMPLEMENTATION_PLANNING`
   - `NEEDS_DOCUMENTATION_CHANGES`
   - `BLOCKED_BY_RUNNER_GAP`

Do not include secrets or full tokens.
