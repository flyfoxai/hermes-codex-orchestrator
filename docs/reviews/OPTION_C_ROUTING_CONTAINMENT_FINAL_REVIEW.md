# Final Review: Option C Routing Containment

**Date:** 2026-07-17
**Decision owner:** Codex
**Independent reviewers:** Gemini CLI, Claude Code CLI, and a read-only Codex reviewer

## Verdict

No unresolved Critical, High, Medium, or Low findings remain in the final diff.
Hardened Option C passed the final verification and runtime smoke matrix and is
approved for local Jarvis deployment.

## Verified Review Decisions

- Snapshot renewal is TTL-derived and scheduled with monotonic elapsed time.
- Invalid snapshot authority is distinct from a trusted unmatched stream and
  returns the fixed project-neutral response with zero Hermes model/HCO calls.
- Zulip polling and credentials live only in project-neutral `zulip-ingress`;
  root ASK behavior and non-Zulip platforms remain separate.
- Numeric stream ID plus a fresh integrity-checked snapshot is the sole project
  authority. Channel name, topic text, cwd, memory, Task Guard, and model output
  cannot select a project.
- Installation requires trustworthy pre-install Gateway runtime evidence. A
  missing, malformed, structurally invalid, or PID-stale baseline aborts before
  mutation rather than silently dropping prior capabilities.
- Activation requires Gateway PID rotation and live release/hook/profile/runtime
  attestation. First install, legacy-plugin rollback, attestation-capable
  cross-version rollback, and failed activation are covered transactionally.
- Complete Zulip adapter configuration and dotenv bindings migrate without
  changing unrelated root configuration or requiring a Hermes core patch.
- Dotenv migration precedence is `root < existing ingress < installer-owned
  overrides`, so installation does not erase operator-maintained ingress
  values.
- The fresh final Claude and Gemini reviews both returned
  `NO_ACTIONABLE_FINDINGS`. Their residual risks are upgrade compatibility,
  bounded activation timeout, and ingress queue latency; all fail closed and do
  not weaken numeric-stream routing authority.

## Post-remediation adjudication

- Gemini session `18ff4740-2a4e-465a-abd8-22589a590f85` raised two unsupported
  `PlatformConfig` shapes. Installed Hermes source and a direct probe show both
  are rejected by the host contract itself; they are not bridge regressions.
- Claude session `77ac249d-62c5-4f38-9a95-f9458e87e444` raised a possible
  pre-override client construction. Installed Hermes source shows the native
  constructor explicitly leaves `_client = None`; all clients are created only
  after the scoped fields have been applied. The finding is not reachable.
- Codex therefore finds no unresolved review finding in the same-credential
  external-profile remediation. The implementation remains approved for the
  live transactional installation gate.

## Verification Before Deployment

Fresh verification evidence is collected immediately before installation and
publication; prior results are not reused as the final release gate.

## Live Deployment Gate

The Jarvis installation committed release
`hermes-codex-bridge-1.0.0-7d9368baa347`. Gateway PID `17655`, HCO PID `17315`,
and delivery PID `18003` are running; Gateway reports Zulip and Feishu connected.
The owner-only live attestation names the same release, Gateway PID, hook, and
project-neutral ingress profile.

The running HCO renewed the integrity-protected route snapshot across multiple
TTL windows. Its authoritative numeric routes are stream `4 -> ASK` and stream
`5 -> stockprofits`. Loading the exact installed release in an isolated
temporary Hermes home and invoking `pre_gateway_dispatch` with a real
Zulip-shaped event for stream `5` rewrote the request to `codex-bridge`; the
signed payload selected `stockprofits` and contained no ASK project value. The
production registry independently canonicalized the target cwd as
`/Users/hula/Projects/stockprofits`, distinct from
`/Users/hula/workspace/ASK`.

The former same-credential `ask-jarvis-pm` Zulip poller is disabled, while its
dotenv hash and unrelated YAML settings remain unchanged. `zulip-ingress` owns
the only active Zulip adapter and has no project cwd or model, with context depth
fixed at zero.

The post-install release gate was repeated from fresh processes: installer
`28/28`, Hermes plugin contracts `198/198`, Node tests `223/223`, and the full
`npm run verify` pipeline all passed. ASK and stockprofits remain separate
routing domains: stream `4` resolves only to ASK at
`/Users/hula/workspace/ASK`, while stream `5` resolves only to stockprofits at
`/Users/hula/Projects/stockprofits`.

The independent Codex closure review also returned `NO_FINDINGS`. Its fresh
focused evidence was HCO service `40/40`, Hermes plugin contracts `198/198`,
and a clean `git diff --check`; the main release gate supplied the reviewer's
remaining installer coverage with the fresh `28/28` run.
