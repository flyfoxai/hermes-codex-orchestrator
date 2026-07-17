# Option C Routing Containment Remediation Design

## Problem

Zulip stream `stockprofits` is correctly mapped in HCO, but a long-running Jarvis gateway did not load the bridge plugin and the unchanged route snapshot expired. Hermes then handled the event in its default profile, whose cwd, memory, prompt, and Task Guard identify the ASK project. A routing outage therefore became a false ASK answer instead of an explicit routing failure.

## Correctness Boundary

Numeric Zulip stream ID plus a fresh, integrity-checked HCO snapshot are the only project-route authority. Channel names, topic text, cwd, memory, Task Guard, and model inference must never create or change project identity.

The system must distinguish these states:

1. A fresh explicit PROJECT route selects `codex-bridge` and the snapshot project ID.
2. A fresh explicit HERMES route selects `hermes-general`.
3. A fresh unmatched stream uses the snapshot's trusted `defaultOwner=HERMES` and selects `hermes-general`.
4. When the bridge hook runs, a missing, stale, corrupt, oversized, structurally invalid, or integrity-invalid snapshot selects `zulip-ingress` and rewrites the event to a private fixed rejection command. The response is `项目路由暂不可用，请稍后重试。` with no Hermes model or HCO call.
5. If the bridge hook is absent or throws, the original event remains in `zulip-ingress`. It can never inherit root ASK context, project memory, Task Guard, MCP configuration, or root credentials. Without modifying Hermes core, this containment does not prove that the ingress Agent makes zero internal model-call attempts; the isolated profile intentionally lacks model credentials, so such an attempt fails rather than falling back to the root profile. Deployment is unhealthy until the live gateway proves the hook is loaded.

## Architecture

### Route authority renewal

HCO records the last successful snapshot publication time. Its retry timer republishes when state is dirty or when the remaining snapshot lifetime reaches a renewal margin derived from the configured TTL. Renewal scheduling uses a monotonic clock, so a backward system-clock adjustment cannot postpone renewal; snapshot `generatedAt` remains wall-clock time for cross-process validation. A failed renewal leaves the service dirty so the existing retry loop keeps trying. Renewal uses the current committed generation and does not mutate route state.

### Authoritative snapshot result

The Python snapshot reader returns an explicit authority object containing validity and the trusted default owner. A valid unmatched stream is represented separately from an invalid snapshot. The bridge hook fail-closes invalid authority through a registered private rejection command.

### Zulip ingress isolation

The installer creates a minimal `zulip-ingress` Hermes profile and enables `gateway.multiplex_profiles` in the default profile. It moves the complete Zulip polling adapter configuration and every `ZULIP_*` dotenv binding from the default Jarvis profile into `zulip-ingress`, and disables Zulip in the default profile. Migration merges with an existing ingress profile on reinstall and uses Hermes-compatible dotenv parsing and serialization, including `export KEY=value`, quoted values, comments, backslash escapes, and true multiline bindings. The canonical Hermes credential names are `ZULIP_BOT_EMAIL`, `ZULIP_API_KEY`, and `ZULIP_SITE_URL`; legacy `ZULIP_EMAIL` and `ZULIP_SITE` aliases are accepted only as migration fallbacks. The ingress profile forces `ZULIP_CONTEXT_DEPTH=0`. Feishu and the default ASK cwd, prompt, memory, plugins, and other credentials remain unchanged.

Hermes multiplexing loads a secondary profile's dotenv into `agent.secret_scope` and deliberately removes process-global `ZULIP_*` values, while the current built-in Zulip adapter still reads `os.getenv()`. The standalone bridge therefore installs a narrowly scoped compatibility wrapper during plugin registration. The wrapper preserves YAML precedence, resolves dotenv-only Zulip credentials and behavior settings through Hermes' `get_secret()`, never mutates `os.environ`, and retains legacy single-profile fallback behavior. It validates the expected Zulip requirement-check and adapter constructor signatures before patching; an incompatible Hermes upgrade prevents bridge registration and live attestation instead of silently polling with the wrong identity. No Hermes core file is modified.

The bridge hook rewrites trusted events from `zulip-ingress` into `codex-bridge` or `hermes-general`. Without the hook, Zulip stays quarantined in a project-neutral profile with no project cwd, project memory, Task Guard projection, MCP servers, or model credentials.

### Deployment lifecycle

Installation snapshots every mutated path and the prior `ai.hermes.gateway` launchd state. After atomic activation it restarts the actual gateway, requires a different PID, waits for readiness, and attests that the live process loaded the bridge hook and serves `zulip-ingress`. Required connected platforms and served profiles are derived from the actual pre-install configuration and service state, so Zulip-only installations are valid and existing enabled adapters remain required. Any failure restores files and the former gateway loaded/running intent, then verifies restoration. A previously running gateway is restarted with a new PID; PID identity itself is not restorable. When the prior plugin supports attestation, rollback validates the restored release against that release's captured version rather than the version being installed. A pre-remediation plugin without attestation is verified only against the capabilities it previously exposed. On a first install where no prior plugin link or attestation exists, rollback restores both paths to absent and verifies the project-neutral gateway is running without requiring a nonexistent old-plugin attestation.

Both staged and installed compatibility probes reproduce the real multiplexer startup contexts. They hide conflicting process-global Zulip values, enter the ingress profile runtime/secret scope, call the real Zulip requirement check, construct the effective adapter, and verify the scoped API key and zero context depth without exporting ingress secrets into the process environment.

The pre-install Gateway preservation baseline is itself fail-closed. The
installer must read an owner-controlled regular `gateway_state.json` whose PID
matches the discovered running launchd process and whose served-profile and
platform structures are trustworthy. A missing, unreadable, malformed, stale,
or structurally invalid state aborts before any launchd or filesystem mutation;
otherwise the installer could silently lose a previously served profile or
connected platform during activation or rollback.

### Hermes busy-session boundary

Hermes applies its busy-session guard before `pre_gateway_dispatch`. Therefore an exact `/codex` command that arrives while the Zulip ingress session is busy can be queued before the bridge sees it. The standalone Option C plugin guarantees no model fallthrough after the hook executes, but it cannot make busy exact commands execute immediately without a Hermes core extension point. This is an accepted, tested latency limitation, not a routing-authority fallback.

## Defense In Depth

Installed profile instructions state the numeric stream/project mapping and explicitly forbid deriving project identity from names or cwd. These reminders improve model behavior but are not part of the route authority or fail-closed guarantee.

## Acceptance Matrix

| Condition | Expected owner/profile | Model calls | HCO calls |
| --- | --- | ---: | ---: |
| Fresh ASK stream | `codex-bridge` / ASK | as required by natural-language dispatch | as required |
| Fresh stockprofits stream | `codex-bridge` / stockprofits | as required by natural-language dispatch | as required |
| Fresh explicit/default Hermes stream | `hermes-general` | normal Hermes behavior | 0 |
| Missing/stale/corrupt/integrity-invalid snapshot | `zulip-ingress`, fixed rejection | 0 | 0 |
| Plugin absent or hook exception | `zulip-ingress`, no ASK context | no successful root-model call; an isolated ingress attempt is not excluded | 0 |

Installation is accepted only after focused fault-injection tests, complete repository verification, gateway PID rotation, live hook/profile attestation, and real route smoke tests pass.

## Upgrade And Rollback

No Hermes source file is modified. The design uses public profile multiplexing, plugin hooks, profile configuration, and launchd lifecycle operations. Hermes upgrades can replace core code without a merge conflict; the installer remains responsible for compatibility gates. Rollback restores all profile/config/plugin paths and the prior gateway loaded/running intent. If the gateway was running, restoration necessarily starts a new process rather than recovering its old PID.
