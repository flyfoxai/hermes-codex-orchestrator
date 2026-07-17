# Option C Completion Plan

## Goal

Finish the hardened Option C bridge without modifying Hermes core, install it
into the local Jarvis instance, verify real Zulip routing, then commit and push
`codex/option-c-app-server`.

## Phases

- [completed] Reproduce and fix rollback verification of HCO-owned runtime files.
- [completed] Trace and fix the real `zulip-ingress` activation failure with tests.
- [completed] Run focused and complete repository verification.
- [completed] Obtain fresh Gemini and Claude reviews and adjudicate findings.
- [completed] Transactionally disable same-credential Zulip pollers in external profiles, with RED/GREEN and rollback coverage.
- [completed] Reinstall into `/Users/hula/.hermes` and verify live routing/renewal/attestation.
- [completed] Update final evidence, review changes, commit, and push.

## Constraints

- Do not modify Hermes core source.
- Preserve unrelated user changes.
- Never expose Zulip credentials or other secrets in logs or documentation.
- Production changes require a failing regression test first.

## Errors Encountered

- First live install rolled back because a renewed route snapshot was compared
  byte-for-byte after the restored HCO had resumed ownership of it.
- The outer rollback error masked the original activation exception; inspect the
  ingress adapter contract before retrying deployment.
- The second live activation correctly failed attestation because the existing
  `ask-jarvis-pm` profile sorted before `zulip-ingress` and claimed the same
  Zulip bot credential. Hermes then refused to serve the ingress duplicate.
- The first residual-finding probe was intercepted by JavaScript template
  interpolation before Python started; the escaped retry then failed because a
  relative-import plugin cannot be loaded as an isolated file module. Reuse the
  repository's package-aware test loader for the next probe.
- A temporary-home `PluginManager` probe did not install the compatibility
  wrapper because the synthetic home lacked the full installed-plugin metadata.
  After three harness failures, stop emulating plugin discovery and verify the
  decisive real contracts directly: scoped `get_secret()` and YAML loading.
- A long, truncated review output visually repeated
  `rollback_produced_valid_attestation`; the attempted cleanup patch did not
  apply. Direct numbered source inspection confirmed the file contains only one
  condition, so no production change was required.
