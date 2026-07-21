# Hermes Adaptive Topic Dispatch Implementation Plan

1. Add RED plugin contract tests for internal-only capabilities, semantic-only
   tool arguments, strict same-turn authorization, replay rejection, and
   concurrent session isolation.
2. Move capability authorization and consumption into `PendingVault`; derive a
   canonical semantic digest and preserve the untouched signed token internally.
3. Remove `topicModeAction` from the model contract and derive the compatible
   HCO wire field from trusted topic state.
4. Add HCO regressions for mapped legacy-topic lazy creation, post-thread
   promotion, unmapped-route containment, and proven-missing-thread recovery.
5. Update installer upgrade assertions and the support guide.
6. Run focused tests, all repository gates, mandatory code review, and fresh
   verification.
7. Install transactionally, then verify authorized ASK, stockprofits, General,
   legacy-topic, missing-thread, and unmapped-stream Zulip behavior against
   replies, logs, and durable HCO state.
8. Add the authenticated `/codex thread bind <objectiveId> <threadId>` recovery
   command with strict grammar, mapped-stream project ownership, maintainer ACL,
   trusted Zulip source-message idempotency, and `HERMES_ONLY` availability.
9. Prove crash replay behavior on both sides of external `turn/start`: a durable
   pre-send `intent` resumes once, while `submission_unknown` or reconciliation
   state never triggers a second send.
10. Record the command, closed renderer statuses, uncertainty fence, Codex
    upgrade probe, and live acceptance evidence in the ADR and support guide.
