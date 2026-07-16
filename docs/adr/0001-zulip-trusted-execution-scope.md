# 0001 - Trusted execution scope for Zulip project work

**Status:** accepted
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

Run exactly one Zulip adapter and two Hermes profiles:

- the default profile is the restricted project-bridge profile;
- the allowlisted named `hermes-general` profile owns explicitly Hermes-managed
  streams;
- the standalone bridge plugin is loaded in the default profile;
- both profiles use the same Zulip adapter and credentials.

The local `pre_gateway_dispatch` hook reads only a bounded local route snapshot.
For a numeric stream ID explicitly marked Hermes-managed it sets
`event.source.profile = "hermes-general"`. For a mapped project stream, missing
entry, stale/corrupt snapshot, unsupported source, or callback error, it leaves
the event in the restricted default profile. The hook may write only profile
names from a fixed local allowlist.

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
- Unmapped or damaged routing fails toward fewer capabilities, not more.
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
