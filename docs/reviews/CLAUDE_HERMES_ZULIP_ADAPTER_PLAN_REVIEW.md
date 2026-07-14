# Claude review: Hermes/Zulip adapter integration plan

Reviewed document: `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`

Reviewed against:

- `runner/http.js`
- `runner/config.js`
- `runner/task-store.js`
- `config/projects.json`
- `HTTP_API_INTEGRATION.md`
- `docs/OPERATIONS.md`
- `README.md`

## Accuracy findings

1. Task ID examples should use the actual generated form `HERMES-YYYYMMDD-<base36>-<XXXX>`, not sequential counter examples.
2. `POST /tasks/:taskId/dispatch` accepts no documented request body. Any `mode` example would be misleading.
3. `taskSummary()` returns these fields: `taskId`, `projectId`, `status`, `goal`, `taskFile`, `createdAt`, `updatedAt`, `tmuxSession`, `resultSummary`, `dispatchPromptFile`, `failureReason`, `cancellationReason`.
4. `/health` uses `new Date().toISOString()` and therefore returns UTC ISO timestamps.
5. `HCO_TOKEN_FILE` is not consumed by Runner. Token-file loading is wrapper/operator responsibility; Runner reads `HCO_API_TOKEN`.
6. Project registration may return `403 project_registration_disabled` when `orchestrator.allowProjectRegistration` is false.
7. `project_locked` is not emitted by Runner. It should be documented only as an adapter-generated condition.
8. `task_exists` is a real `409` error for caller-supplied duplicate task IDs.
9. The write-task gate should prefer `limit=500` rather than `limit=50`, and the adapter must filter active statuses client-side or issue separate status-filtered requests.
10. Project upsert accepts both `POST` and `PUT`; adapter startup sync should prefer idempotent `PUT`.

## Security gaps

1. Token possession gives full Runner access across all projects in the MVP.
2. User-controlled `goal`, `constraints`, `acceptanceCriteria`, and `requestedBy` are written into task files that Codex reads. The adapter must treat them as untrusted input and apply length/character validation.
3. `GET /tasks/:taskId/raw` can expose absolute server paths and full task content. Do not forward raw content to ordinary Zulip users.
4. `allowCodeChanges` is advisory metadata for Codex, not a Runner-enforced permission boundary.
5. Polling needs timeout, backoff, and stuck-task handling.
6. Cross-machine access should prefer HTTPS over Tailscale, for example through `tailscale serve`, in addition to Bearer Token auth.

## Concurrency and operational risks

1. The adapter-side write gate has a TOCTOU race in multi-instance deployments because checking active tasks and creating a task are separate API calls.
2. Runner does not validate that `tmuxSession` values are unique across projects.
3. Tasks can remain stale in `queued` after Runner restart or dispatch interruption; the plan needs a recovery runbook.
4. Polling `GET /tasks/:taskId` scans registered projects to find the task, so aggressive polling across many tasks can become expensive.

## Missing adapter details

1. `GET /projects` examples should include `concurrency`.
2. The plan should state that `GET /tasks` summaries do not currently include `allowCodeChanges`; the adapter cannot reliably enforce write gates from summary rows alone unless it maintains its own state or fetches raw task data.
3. `status` query filtering is single-value. Fetch all and filter, or issue separate calls.
4. `requestedBy.messageId` is stored in raw task metadata but is not enough for robust Zulip notification routing. The adapter should keep its own `taskId -> message target` state.
5. `dispatchPromptFile` and `taskFile` are server paths and should not be relayed to ordinary users.

## Verdict

`NEEDS_DOCUMENTATION_CHANGES`

The architecture is usable for implementation planning after documentation corrections. No immediate Runner blocker is required for an MVP, but the adapter plan must clearly separate current Runner contracts from adapter-side policies and future enhancements.
