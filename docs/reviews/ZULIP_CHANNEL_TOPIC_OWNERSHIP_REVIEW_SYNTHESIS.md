# Zulip Channel And Topic Ownership: Codex Synthesis

Date: 2026-07-15

Reviewed inputs:

- `ZULIP_CHANNEL_TOPIC_OWNERSHIP_REVIEW_REQUEST.md`
- `CLAUDE_ZULIP_CHANNEL_TOPIC_OWNERSHIP_REVIEW.md`
- `GEMINI_ZULIP_CHANNEL_TOPIC_OWNERSHIP_REVIEW.md`

## Accepted decisions

1. Project ownership comes only from configured or persisted stream routing.
   A matching stream name, exact or fuzzy, does not create a project binding.
2. An unmapped Zulip stream is Hermes-owned. Project dispatch commands and
   project topic controls are rejected there with an explanation of how an
   authorized user can bind the stream.
3. Zulip `--project` is a compatibility assertion, not an override. It is
   accepted when equal to the stream's mapping and rejected otherwise.
4. A project topic defaults to `AUTO`. `HERMES_ONLY` blocks later project
   dispatch. Successful task creation records `CODEX_BOUND` with a real
   `taskId`.
5. Explicit controls are `/codex topic show`, `/codex topic auto`, and
   `/codex topic hermes`.
6. Natural-language control is supported through a structured semantic entry
   point. Hermes performs the one permitted model call and passes HCO a
   `CONTROL` object; HCO does not parse raw natural language.
7. Repeated mode changes are idempotent. Audit fields record the initiating
   user, source, message ID, and update time.
8. Entering `HERMES_ONLY` never cancels work implicitly and must say so when a
   task reference exists.

## Corrected or rejected advice

- Atomic file replacement is not a concurrency lock. This increment will make
  each adapter call deterministic and idempotent, but safe multi-process
  read-modify-write requires a future lock or transactional store.
- `CODEX_BOUND` does not mean that Runner/tmux can continue model context. It
  means only that the topic has a real last Runner task reference. App Server
  integration is required for true thread continuation.
- A state record may retain `lastTaskId` when returning to `AUTO`; retaining a
  historical reference must not be described as an active binding.
- Existing `zulipGenericStreams` remains readable for compatibility, but the
  canonical rule is simpler: absence of a project route means Hermes-owned.

## Implementation boundary

This repository will implement parsing, state transitions, permissions,
dispatch guards, task binding, and an exported structured-control function.
It cannot complete the upstream Hermes model loop because that code is not in
this repository. The integration requirement is documented as an explicit
caller contract instead of being presented as completed end-to-end behavior.
