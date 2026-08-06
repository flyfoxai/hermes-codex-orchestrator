# Hermes Turn Coordinator Necessity Review Synthesis

Date: 2026-07-30

Reviewers:

- Claude Opus 4.8 via local Claude Code CLI
- Gemini 3.1 Pro Preview via local Gemini TTK CLI

## Verdict

Both reviewers returned `PARTIALLY_NECESSARY`.

The incident exposes a real architectural gap: Hermes has no durable entity
that records the outcome of one inbound message-processing turn. `sessions` is
conversation-level state, and `messages` is semantic transcript state. Neither
can tell the Gateway that a provider-failed turn is closed and must not be
implicitly resumed from a dangling tool result.

The reviewers also agree that native clarify settlement is currently
process-local and should become durable if one-shot behavior must survive a
Gateway restart.

## Consensus

1. Keep the Zulip topic/session open after a provider failure.
2. Add a small Hermes-owned durable turn record with an idempotency key and an
   explicit outcome such as `completed`, `provider_failed`, or `abandoned`.
3. Make the next ordinary message create a new turn. It may bind to an older
   turn only through an exact, authorized interaction or work reference.
4. Move or mirror native clarify settlements into durable Hermes state, storing
   the submitting account, answer and settlement time. A later prompt must
   never reopen a settled interaction, including after restart.
5. Treat transcript content as history/projection, not as the execution state
   machine. A dangling tool result may remain in the audit transcript, but it
   must not be treated as an active operation.
6. Keep HCO work requests, Agent sessions, Codex calls and HCO interactions in
   HCO. Do not duplicate or merge those state machines into Hermes.
7. Isolate the implementation in a new Hermes Gateway module and make only
   narrow lifecycle-hook changes in `gateway/run.py` to reduce future Hermes
   upgrade conflicts.

## Scope To Defer

The following are not required to close the demonstrated failure and should
not be added to the first implementation:

- a shared Hermes/HCO interaction schema or database;
- a second copy of the full HCO Work/Codex lifecycle in Hermes;
- complex Hermes delivery-outcome tracking unless a concrete routing rule
  depends on it;
- speculative `WAITING_ASYNC` and multi-agent states in the generic Hermes
  turn table;
- broad transcript rewriting or automatic deletion of old tool results.

## Required Semantics

```text
Conversation/session: ACTIVE until explicit reset/archive/close
Turn: RECEIVED -> RUNNING -> COMPLETED | PROVIDER_FAILED | ABANDONED
Clarify: PENDING -> SETTLED | EXPIRED | CANCELLED
HCO work: owned by HCO and independent of the Hermes turn
Delivery: independent of execution; never re-executes a closed turn
```

The word `terminal` should be avoided unless qualified. A provider error is a
terminal outcome for the current execution attempt, not for the conversation.

## Required Tests Before Implementation Is Accepted

- Reproduce the incident: accepted clarify, provider failure, then unrelated
  greeting. Assert no implicit replay or claim of a fresh user choice.
- Restart after clarify settlement and prove a second answer is rejected.
- Submit the same inbound platform message twice and prove one turn record and
  one execution.
- Submit an unrelated message while another turn is waiting and verify the
  routing policy: new turn or explicit busy response, never accidental clarify
  consumption.
- Verify that a failed provider turn does not close the topic session and does
  not alter HCO work state.
- Verify attribution wording uses the authenticated submitting account, not an
  unproven claim about which human operated that account.

## Review Caveat

Claude's CLI session could not directly read the Hermes repository because of
its own path permission boundary; its Hermes-specific conclusions were based on
the supplied incident evidence and schema facts. Gemini inspected the shared
parent workspace but attempted a write tool despite the read-only request. A
post-review `git status` check found no relevant source changes from that
attempt. The consensus should therefore be treated as an architecture review,
not as a substitute for a final implementation-level review.
