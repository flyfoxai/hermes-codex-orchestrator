# Jarvis Hermes Context Repair Implementation Plan

## 1. Generic Hermes Terminal Tools

- Add failing registry and plugin-context tests for `return_direct=False` and
  explicit propagation.
- Add failing conversation-loop tests for one API call, exact final output,
  persisted assistant/tool/assistant ordering, async handlers, tool errors,
  and mixed tool batches.
- Add `return_direct` to `ToolEntry`, `ToolRegistry.register`, and
  `PluginContext.register_tool` with a default of `False`.
- Add a small conversation-loop helper that recognizes a single opted-in call,
  extracts its persisted tool result, appends the terminal assistant message,
  flushes it, and exits.
- Run focused Hermes tests, then the surrounding plugin and run-agent suites.

## 2. Bridge And Profile Repair

- Replace contract tests that expect natural-message slash-command rewriting
  with tests for normal-agent allow, `codex-bridge` selection, ephemeral
  channel context, and registered direct-return tool metadata.
- Add tool tests for valid dispatch, async bridge submission, strict semantic
  validation, topic restrictions, expiry/replay/malformed capability rejection,
  and exact trusted HCO event construction.
- Remove the natural facade LLM call and private natural command.
- Register `hco_dispatch` as an async `return_direct=True` plugin tool.
- Keep `/codex`, route queries, invalid routes, and route-unavailable handling
  on their zero-model command paths.
- Add a managed project-neutral Jarvis PM `codex-bridge/SOUL.md` to installer
  staging, activation, compatibility probes, snapshots, and rollback.

## 3. Verification And Deployment

- Run HCO contract, installer, bridge, and route regressions.
- Inspect both repository diffs and perform the mandatory code review.
- Back up the currently installed plugin/profile artifacts through the existing
  transactional installer, install the tested build, and restart the gateway
  and bridge services.
- Verify launchd state, plugin attestation, profile files, and sanitized logs.

## 4. Live Zulip Acceptance

- Send unique ASK probes covering Jarvis identity, continuity, and executable
  project routing; retrieve and record the replies.
- Send unique stockprofits/quant probes covering identity and project isolation;
  retrieve and record the replies.
- Send a unique message in an unmapped stream/topic and verify ordinary
  `hermes-general` behavior.
- Correlate sanitized gateway/HCO logs with each unique marker and verify no
  credential or signed-capability output.
