# Option C Routing Containment Remediation Review Request

Review the current uncommitted diff on branch `codex/option-c-app-server` against:

- `docs/adr/0001-zulip-trusted-execution-scope.md`
- `docs/adr/0002-hermes-codex-context-handoff.md`
- `docs/adr/0003-zulip-channel-topic-ownership.md`
- `docs/superpowers/specs/2026-07-17-option-c-routing-containment-remediation-design.md`
- `docs/superpowers/plans/2026-07-17-option-c-routing-containment-remediation.md`

The review must inspect the real source and tests, not only the documents. Focus on correctness and regressions in:

1. route-snapshot renewal before TTL expiry;
2. numeric-stream routing and fail-closed behavior for invalid snapshots;
3. isolation of `zulip-ingress` from the default ASK profile;
4. Gateway launchd-domain discovery, PID rotation, runtime evidence, and plugin attestation, including fail-closed pre-mutation handling when the prior runtime state is missing, corrupt, stale, or structurally invalid;
5. transactional rollback, especially first install when the old plugin and attestation are absent and cross-version rollback to an attestation-capable old release;
6. complete migration of all `ZULIP_*` adapter bindings, including `export` dotenv syntax, plus root-to-ingress migration of `platforms.zulip` YAML with precedence `root < existing ingress < installer enabled=true` and recursive nested-map merging, while preserving Feishu, ASK root behavior, unrelated credentials, plugins, and configuration;
7. missing tests, security problems, unsafe assumptions, and incompatibilities with the accepted no-Hermes-core-change boundary.
8. the plugin-side compatibility wrapper for Hermes multiplexed
   `agent.secret_scope`: complete constructor-time `ZULIP_*` coverage, YAML
   precedence, idempotence, signature drift behavior, lack of process-global
   environment mutation, and equivalence for single-profile operation;
9. whether the installer probe now reproduces the real
   `_without_secondary_profile_platform_env()` plus
   `_profile_runtime_scope()` adapter startup path instead of creating a
   false positive with `load_hermes_dotenv()`.
10. transactional handling of non-owned profiles that use the ingress Zulip
    credential: effective-key precedence, strict owner/symlink validation,
    disabling only `platforms.zulip.enabled`, staged preflight equivalence,
    atomic activation, and byte-exact rollback without editing profile dotenv.

Report only actionable findings, ordered by severity, with exact file and line references. For each finding, explain a concrete failure scenario. Do not modify files. If there are no findings, say so and list residual risks or test gaps separately.
