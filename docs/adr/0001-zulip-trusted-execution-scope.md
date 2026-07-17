# 0001 - Trusted execution scope for Zulip project work

**Status:** accepted; amended 2026-07-17 by the routing-containment remediation
**Date:** 2026-07-16
**Supersedes:** the 2026-07-15 proposal to modify Hermes core
**Related:** ADR 0002, ADR 0003, `docs/superpowers/specs/2026-07-16-hermes-codex-option-c-design.md`
**Deciders:** project owner, Codex; reviewers: Claude CLI and Gemini CLI

## Context

A project-channel message must never inherit Hermes' process-wide working
directory or obtain unrestricted shell/file tools. Prompt instructions and
fail-open plugin callbacks cannot enforce that boundary. At the same time, the
selected Option C must remain an independent Hermes plugin and survive Hermes
upgrades without a core fork.

Hermes supports one Zulip adapter with multiplexed profiles. A pre-dispatch
hook runs before session/profile runtime selection and can select a profile on
the event. Hermes also rejects a second poller that reuses the same Zulip bot
credentials.

## Decision

Run exactly one Zulip adapter and three Hermes profiles:

- the default/root profile retains non-Zulip Jarvis behavior and never polls Zulip;
- the project-neutral `zulip-ingress` profile owns the single Zulip adapter;
- the restricted `codex-bridge` profile owns mapped project execution;
- the allowlisted named `hermes-general` profile owns explicitly Hermes-managed
  streams;
- the standalone bridge plugin is loaded by the Zulip ingress process and may
  select only the two named destination profiles;
- only `zulip-ingress` contains the Zulip adapter and its credentials.

The bridge plugin adapts the current Hermes Zulip implementation to multiplexed
secret scopes at registration time. It reads profile bindings through Hermes'
`agent.secret_scope.get_secret()` while preserving explicit YAML values, and it
does not copy profile secrets into process-global environment variables. The
wrapper validates the upstream function and constructor shape before activation;
an incompatible Hermes upgrade fails the plugin attestation gate. This keeps the
change outside Hermes core while making the upgrade dependency explicit.

The local `pre_gateway_dispatch` hook reads only a bounded local route snapshot.
For a numeric stream ID explicitly marked Hermes-managed, or an unmatched stream
under a fresh snapshot whose trusted default owner is Hermes, it sets
`event.source.profile = "hermes-general"`. For a mapped project stream it selects
`codex-bridge`. A missing, stale, corrupt, oversized, structurally invalid, or
integrity-invalid snapshot is rewritten to a fixed private rejection command
while remaining under `zulip-ingress`; it cannot acquire project identity. The
hook may write only profile names from a fixed local allowlist.

If the hook is absent or throws, the event remains in project-neutral
`zulip-ingress`, which has no project cwd, project memory, Task Guard projection,
MCP configuration, or model credentials. Deployment remains unhealthy until
the live Gateway PID attests the expected plugin release, hook, and ingress
profile. This profile boundary contains project semantics even though a
standalone plugin cannot prevent Hermes from attempting an internal model call
before failing for absent ingress credentials.

The hook performs no network I/O, durable mutation, HCO request, or untracked
background task. Exact command execution occurs later in an awaited async
plugin command handler. Natural-language project dispatch occurs in one Hermes
model turn through an awaited async HCO tool.

The restricted profile's configured toolset is the real isolation boundary.
Project-channel Hermes turns cannot use general shell or file tools outside the
HCO bridge. Hook output and injected prompt text provide routing and protocol
guidance but are not security controls. HCO remains authoritative for numeric
stream-to-project routing and project-to-canonical-cwd registration; messages,
model output, and plugin arguments never supply an executable cwd.

Public `/codex` messages are rewritten by the hook to a private command with a
short versioned HMAC-authenticated context envelope. The envelope binds numeric
stream ID, topic, sender, source message ID, arguments, issue/expiry time, and a
nonce. The handler rejects invalid, expired, replayed, or directly forged
envelopes. Shared mutable request context is forbidden.

If the installed-Hermes contract tests show that hook profile mutation no
longer precedes session namespace, profile home, and platform toolset
resolution, deployment stops. Prompt-only blocking or `pre_tool_call` blocking
must not be substituted for this isolation boundary.

## Consequences

- No Hermes core source modification or fork is required.
- Fresh unmatched routing follows the trusted snapshot default; damaged or
  unavailable routing returns a fixed project-neutral failure.
- One bot credential has one poller, avoiding duplicate consumption.
- General Hermes conversation remains available in explicitly Hermes-managed
  streams through its separate profile/session namespace.
- Route snapshot publication and installed-Hermes compatibility tests become
  mandatory deployment gates.

## Rejected alternatives

- Two Zulip adapters with the same credentials: Hermes rejects the duplicate
  poller and it risks duplicate message consumption.
- A new Hermes core execution-scope API: stronger in theory but violates the
  no-core-modification requirement and raises upgrade cost.
- Prompt-only or hook-only tool restriction: callback failure can fail open and
  text cannot enforce an execution boundary.
- A network lookup in `pre_gateway_dispatch`: it runs on the synchronous hot
  path and would make routing availability depend on HCO latency.

## Rollback

Disable the bridge plugin and keep the default restricted profile until the
route/profile contract is revalidated. Do not switch project streams to the
general profile as an emergency bypass.
