# Hermes/Zulip adapter plan review synthesis

## Review inputs

- Claude returned a usable Markdown review and judged the plan `NEEDS_DOCUMENTATION_CHANGES`.
- Gemini CLI was called multiple times. A minimal health check succeeded, but all substantive review attempts either failed during request streaming or returned an empty invalid stream. No Gemini-specific findings were accepted.
- Codex rechecked the findings against the local implementation files.

## Accepted changes for the final plan

1. Clearly distinguish current Runner API contracts from proposed Hermes adapter behavior.
2. Add `POST /tasks/:taskId/dispatch` to the endpoint list and state that it takes no request body.
3. Document `POST` and `PUT` project upsert, with `PUT` preferred for idempotent adapter startup synchronization.
4. Add the current `taskSummary` response fields.
5. State that task list summaries do not expose `allowCodeChanges`; a same-project write gate cannot depend on `GET /tasks` alone.
6. Add a safe MVP write-gate design: single adapter instance plus adapter-owned active-write registry; or fetch raw task metadata for tasks created outside the adapter; or add a Runner enhancement later.
7. Add `project_registration_disabled`, `task_exists`, and adapter-generated `project_busy`/`project_locked` handling.
8. Add `tmuxSession` uniqueness checks.
9. Add stale `queued` recovery guidance.
10. Add polling timeout, backoff, and notification routing state.
11. Add stronger security notes for static token scope, raw endpoint exposure, user input flowing into Codex, and advisory-only `allowCodeChanges`.
12. Add Tailscale HTTPS guidance for cross-machine deployment.

## Rejected or reframed findings

- No Runner code change is required before writing a basic adapter. The gaps are implementation constraints the adapter must account for.
- `project_locked` should not be listed as a Runner error. It can be used as an adapter-local error or user-facing state.
- The plan should not require webhook delivery because Runner currently has no webhook mechanism.

## Final verdict

After the accepted changes are merged into `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`, the plan is suitable as the basis for the next-stage Hermes/Zulip adapter development.
