# Gemini Review: Option C Routing Containment

**Date:** 2026-07-17
**Reviewer:** local Gemini CLI, `gemini-3.1-pro-preview`
**Final session:** `f1e50bb3-e61a-4c7b-8562-6eb888a79f6c`
**Scope:** accepted ADRs, remediation design/plan, and complete tracked diff

## Result

Gemini reported `NO_ACTIONABLE_FINDINGS` after inspecting the complete final
bundle. It confirmed the monotonic snapshot renewal, project-neutral fail-closed
path, profile/configuration isolation, migration precedence, and no-Hermes-core
boundary.

## Residual Risks And Adjudication

1. **Hermes internal Zulip fields may change without constructor signature
   drift.** Accepted as residual upgrade risk. The staged compatibility probe
   constructs the real adapter path, and live activation requires attestation;
   an incompatible release fails installation and rolls back.
2. **The 20-second Gateway activation bound can fail on an extremely slow
   machine.** Accepted as an operational tradeoff, not a correctness defect.
   Timeout failure is transactional and fail-closed.
3. **Busy ingress queues can delay routing-unavailable responses.** Accepted as
   a documented Hermes ordering limitation. It does not permit project context
   acquisition or weaken routing authority.

No unresolved Gemini finding remains.

## Post-remediation review

Gemini session `18ff4740-2a4e-465a-abd8-22589a590f85` reviewed the
same-credential external-profile remediation and raised two compatibility
questions about optional `PlatformConfig` attributes and `extra: null`.

Both are rejected as non-defects against the installed Hermes contract:

- `PlatformConfig` is a dataclass that always defines `token`, `api_key`, and
  `extra`; the native Zulip requirements check and adapter also access those
  fields directly. An object without them is not a supported platform config.
- `extra: null` is rejected by Hermes' own `PlatformConfig.from_dict()` before
  adapter startup, while valid configs receive a mapping default. Supporting a
  value that the host config loader rejects would invent a second, inconsistent
  configuration contract in the plugin.

A direct probe of the installed Hermes classes confirmed all three fields are
present, the default `extra` is a mapping, and both invalid shapes fail in
Hermes itself with `AttributeError`. No production change is warranted.
