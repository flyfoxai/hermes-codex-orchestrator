# Hermes -> Codex context management synthesis

**Date:** 2026-07-15
**Scope:** previous token-efficiency review plus the follow-up context-continuity review
**Reviewers:** Codex, local Claude Code CLI, local Gemini CLI

## Executive conclusion

Hermes should be a business-context controller, not a second coding agent. It
should preserve the user's exact intent, fill genuine business omissions,
select project evidence, enforce routing and permissions, and choose the Codex
thread lifecycle. Codex should inspect the current repository, design the
implementation, edit, test, and verify.

The target handoff is not a Hermes-generated implementation brief and not a
replayed conversation. It is a compact typed intent contract plus immutable or
freshness-checked file references. Long logs, specifications, and prior
decisions travel by reference. Codex execution continuity uses its native
thread ID, resume, fork, and compact capabilities; tmux process identity is not
a context contract.

This design can exceed a single Codex App thread in organization-specific
workflow quality through cross-channel business memory, provenance, decision
versioning, stale-context detection, and objective-scoped routing. It cannot
be claimed to exceed Codex App's coding intelligence or internal compaction,
and superiority must be demonstrated by quality-weighted A/B tests.

## Previous discussion retained

The first review established four important facts:

1. The current path is `Zulip -> Hermes full agent turn -> HCO -> files/tmux -> Codex`, so simple commands can cause two model planning passes.
2. HCO's command parsing, static route lookup, HTTP calls, polling, files, and tmux are deterministic. They add latency and failure modes but are not themselves the primary LLM-token source.
3. `adapter/handler.js` forwards only `goal` while replacing `constraints` and `acceptanceCriteria` with empty arrays. Useful Hermes interpretation is therefore discarded before Codex sees it.
4. A project-level long-lived Codex TUI may accumulate unrelated history. The fix is explicit session lifecycle policy, not blindly keeping or killing tmux.

The retained priorities are an upstream deterministic fast path for explicit
`/codex` commands, provider-native end-to-end telemetry, a non-lossy task
contract for semantic routing, and explicit Codex session management. Exact
token or latency savings remain unmeasured.

## Current research result

### Codex-native capabilities to use

The local `codex-cli 0.142.3` resumes a persisted session by UUID or thread
name. The official [OpenAI Codex](https://github.com/openai/codex) app-server
protocol provides thread start, resume, fork, read/list, manual compact, turn
events, token usage, and persistent thread items. Forking can stop at a
selected turn. Codex compaction produces a model summary which remains visible
after resume or fork.

Therefore HCO should persist the real Codex `threadId` and use the app-server
or equivalent CLI lifecycle. It should not duplicate Codex's transcript store
or create a second execution-summary algorithm.

### Persistence is not the same as Codex App visibility

In the locally installed `codex-cli 0.142.3`, persisted threads record an
origin such as `cli`, `vscode`, `exec`, or `appServer`. The generated
app-server protocol also exposes these as distinct source kinds and allows
`thread/list` to filter them. A non-ephemeral app-server thread and a Codex TUI
thread can therefore both be saved and resumed without being presented as the
same kind of conversation.

The current Codex App must not be assumed to list every thread merely because
it exists in the shared Codex state database. A TUI launched inside tmux is a
CLI conversation: it is directly visible by attaching to tmux and can be
reopened through CLI session history, but it is not automatically a normal App
conversation. Likewise, a standalone HCO-owned app-server process persists an
`appServer` thread and exposes it through the protocol, but automatic insertion
into a separately running Codex App's visible conversation catalog is not a
documented contract.

If App visibility is required, treat it as an explicit integration and
acceptance test: use the same App-managed server/catalog where supported, or
add an HCO task viewer/deep link. Do not spoof a `vscode` source merely to make
an external thread resemble an App-created thread. HCO's own task log remains
the reliable cross-channel record.

### Existing projects

| Project | Decision | What is useful here |
|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex) | Directly use | Native execution thread, resume, fork, compact, events, usage |
| [Serena](https://github.com/oraios/serena) | Optional pilot after the baseline | MCP/LSP symbol retrieval and progressively loaded project memory |
| [Aider](https://github.com/Aider-AI/aider) | Borrow | Token-budgeted repo map and dependency-ranked working set |
| [Continue](https://github.com/continuedev/continue) | Borrow | Content-addressed and incremental project indexing |
| [Letta Code](https://github.com/letta-ai/letta-code) | Borrow | File-backed tiered memory, search, discovery links, telemetry |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Borrow only if workflows become multi-stage | Checkpoint ledger, durable execution, branchable state |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) | Long-term protocol reference | Distinct new/load/resume/fork semantics |

No reviewed project is a drop-in replacement for the whole HCO context layer.
The smallest useful composition is Codex app-server for execution state, a
small HCO ledger for business/task state, and optional symbol retrieval. A
full LangGraph or Letta runtime would currently duplicate responsibilities.

## Three-model review

### Agreement accepted

- Preserve the original `userIntent` beside Hermes's normalized `objective` so semantic drift is visible.
- Never summarize machine evidence such as stack traces into a weaker statement. Store it in an immutable evidence file and reference it.
- Revalidate paths and content hashes at dispatch. Repository facts and current user instructions override old memory.
- Re-inject active hard constraints and acceptance criteria on every continuation; do not trust compaction to retain every critical detail.
- Keep always-loaded memory small. Store stable rules and indexes there; load detailed evidence only when relevant.
- Return a structured Codex receipt containing outcome, artifacts, tests, unresolved issues, invalidated context, usage, and resulting thread/turn IDs.
- Fix the current adapter's field loss before attempting sophisticated memory retrieval.

### Findings corrected or rejected

- **Repository changes do not always imply fork.** A fork inherits prior
  history, so it does not erase stale assumptions. Small or expected changes
  may resume after a repository refresh. A destructive state change may need a
  new thread. Fork is primarily for history-dependent side work.
- **tmux need not be removed to improve semantics.** It may remain a display or
  process-hosting mechanism. It must not define task identity, ownership, or
  continuity.
- **HCO may request native compaction.** The correct boundary is that HCO may
  trigger Codex's compact operation using measured context pressure; it should
  not write a competing summary.
- **Control metadata is still required.** `correlationId`, provenance, hashes,
  permission policy, and freshness belong in the control-plane record even if
  some fields are omitted from the model-visible prompt.
- **Claims that Codex App lacks cross-session context, structured guidance, or
  asynchronous operation were not established by the supplied evidence.** No
  competitive claim relies on those assertions.
- **A repo map should be selective.** Injecting a full map into every task can
  recreate the same context bloat. Prefer a small index and on-demand symbol
  lookup.

## Recommended architecture

```text
Zulip / user dialogue
       |
       +-- typed command/event ---> deterministic no-model path
       |
       +-- other valid language -> one configured Hermes model call
                                      |
                                      v
                         control record + model-visible intent
                                      |
                         context manifest / evidence refs
                                      |
                     new | resume | fork | native compact
                                      |
                                 Codex thread
                                      |
                              structured receipt
```

The control record holds audit and enforcement data. The model-visible intent
contains only what Codex needs to act. This avoids the false choice between a
minimal but unauditable prompt and a large prompt containing operational
metadata.

## Lifecycle policy

| Mode | Use when | Do not use as |
|---|---|---|
| `new` | New objective; prior assumptions are materially invalid; clean-room rerun | Default for every message |
| `resume` | Same objective and execution line; new message advances or corrects it; current repo state is refreshed | Project-wide permanent chat |
| `fork` | Alternative approach, review, summary, independent investigation, or comparison needs selected history without polluting the main line | Automatic cure for stale history |
| `compact` | Measured context pressure warrants native Codex compression | Hermes-written execution summary |

Before resume or fork, compare project ID, workspace/branch, current HEAD and
working tree, objective identity, active constraints, permissions, and the
last known task checkpoint. A mismatch is classified by impact, not merely by
hash inequality. The router may resume with an explicit refresh, fork for
side work, start new when old assumptions are unsafe, or ask the user when the
intent truly cannot be determined.

## Zulip and App Server adaptation

App Server is an execution protocol, not a Zulip integration. It does not
observe topic creation, choose a thread for a topic, send Codex output to
Zulip, or guarantee that an HCO-owned thread appears in the desktop Codex App.
The current adapter preserves the source stream/topic and delivery target, but
the poller sends only terminal `resultSummary`; it has no complete-event bridge
or production `conversationKey -> threadId` registry.

HCO will create no Codex thread for an empty topic. On the first executable
request it lazily creates a stable `conversationKey`, an objective, and a
thread. Stream selects the project; topic is a mutable alias and delivery
target. Topic rename/move support requires a verified transport event plus an
alias update. Where the transport cannot provide that reliably, HCO requires
an explicit relink rather than guessing. A move across projects starts a new
conversation by default.

The required data path is:

```text
App Server events
  -> HCO durable event journal
  -> idempotent turn reducer
  -> final-result renderer
  -> Zulip outbox and delivery ledger
```

HCO assigns each received event its own `eventRecordId` and monotonic
`ingestionSeq`; the current delta protocol does not provide a documented global
event cursor. Streaming deltas are optional progress only. The completed
`agentMessage` item is the authoritative final answer and is stored verbatim
before security filtering and Markdown-aware Zulip chunking. Turn/item list
APIs are used after reconnect for reconciliation of persisted items, not as a
promise of lossless raw-event replay.

Hermes normally consumes a typed receipt, short business summary, and artifact
references. It does not reconstruct the answer from deltas and does not freely
rewrite the final Codex message. Full raw events remain restricted audit data;
only allowlisted item types and fields may reach Zulip or Hermes.

One active turn is allowed per objective. Later messages enter a FIFO queue;
approval, interactive input, interrupt, timeout, and late completion are bound
to the exact turn, original delivery target, and authorized responders. Zulip
deliveries carry stable chunk IDs, content hashes, and acknowledged message IDs
so retries cannot silently duplicate or omit part of the answer.

This makes App Server a strong long-term backend, but not a drop-in replacement
for tmux. Migration keeps both backends, starts with allowlisted read-only and
final-only traffic, tests restart and partial-delivery recovery, then adds
writes/approvals and only later optional streaming. One wrong project/topic
delivery, unauthorized decision, or silently lost final answer is a P0 rollback
condition for the rollout cohort.

## Quality-first rollout

1. Capture a short baseline with one correlation ID and provider-native usage, latency, retry, and result fields.
2. Stop dropping `constraints` and `acceptanceCriteria`; preserve raw `userIntent` and exact evidence references.
3. Add a closed no-model whitelist before Hermes inference; send every other valid free-language message through one configured Hermes model exactly once.
4. Replace project/tmux continuity with a persisted Codex thread registry and tested new/resume/fork rules.
5. Add freshness/provenance checks and a small, versioned project-memory pilot; evaluate optional Serena/symbol retrieval only afterward.
6. Run matched A/B tasks and promote the design only if quality improves without unacceptable cost or latency regression.

Primary metrics are task success, accepted-first-pass rate, requirement
omissions, regression count, human clarification turns, stale-context errors,
and recovery from interrupted tasks. Token/cache usage, model turns, wall time,
and retry count are important secondary constraints, not the sole objective.

## Hermes-mediated relay decision

The Zulip-facing speaker remains Hermes, but Hermes has two distinct parts:

1. The **Hermes gateway** is always present. It performs deterministic routing,
   authorization, state transitions, queueing, correlation, rendering, and
   Zulip delivery without an LLM call.
2. The **Hermes model** is optional per inbound message. The gateway does not
   estimate complexity or choose between model strengths. If a valid message is
   not in the closed no-model whitelist, it invokes one deployment-configured
   Hermes model once, and that call completes all required business-language
   interpretation.

This distinction resolves the apparent conflict between reliable central
mediation and token efficiency. App Server does not need to speak to Zulip, and
Hermes does not need to regenerate every App Server answer.

### Recommended relay

```text
Zulip
  -> Hermes deterministic gateway
     |-- closed whitelist ----------> typed deterministic action
     `-- other valid free language -> one Hermes call
                                       -> DISPATCH | CLARIFY
                                          | BUSINESS_REPLY | REJECT
  -> validated IntentEnvelope when DISPATCH
  -> HCO durable control record and queue
  -> Codex App Server
  -> HCO event journal and reducer
  -> ExecutionReceipt | InteractionRequest
  -> Hermes deterministic presentation
  -> DeliveryEnvelope and Zulip outbox
  -> Zulip
```

The rejected alternative is model-on-every-hop: it pays for repeated semantic
work and gives each rewrite another chance to change meaning. A fully general
multi-agent event bus is also unnecessary now. HCO should borrow its durable
journal, queue, and idempotent-consumer properties without adopting a second
agent runtime.

### Binary model gate

The decision is strictly binary: call no Hermes model, or call the single
configured Hermes model once. The gateway never calls a classifier to decide
whether another model is needed, never selects a fast/strong model per message,
and never attempts to score natural-language complexity.

The no-model path is a closed, positive whitelist:

- journal/reduce of typed App Server events;
- verbatim delivery of a persisted completed `agentMessage`;
- Zulip retry, deduplication, Markdown-aware chunking, acknowledgement, and
  other delivery-ledger transitions;
- a closed command grammar whose verb is registered, whose `objectiveId`
  exists, whose caller is authorized, and which contains no unparsed free text;
- a response bound exactly to a pending `InteractionRequest` and authorized
  responder;
- an explicit direct-to-Codex form, such as `/codex direct ...`, after
  project-level permission and input-validity checks.

Malformed encoding, broken protocol payloads, excessive input, failed
authentication, or invalid command structure are rejected deterministically;
they are not meaningful language and do not justify a model call. Every other
valid free-language message invokes the configured Hermes model once.

Direct-to-Codex bypasses Hermes semantic enrichment only. It never bypasses HCO
authorization, project hard constraints, dangerous-operation approval, journal,
or audit. Because it forgoes omission repair and business clarification, it must
be explicit rather than inferred from apparently clear prose.

The single Hermes call receives `rawText`, `objectiveBrief`, `projectBrief`,
`pendingInteractionRefs`, `callerIdentity`, `contextRefs`, and an explicit
`contextTruncated` flag. It returns exactly one typed result:

```text
DISPATCH       -> complete IntentEnvelope
CLARIFY        -> ordered business-question list
BUSINESS_REPLY -> business response that does not require Codex
REJECT         -> business or policy explanation
```

HCO then validates schema, authorization, objective/thread state, reference
freshness, and hard policy. The model interprets semantics but never grants
permission or execution validity. An invalid model result becomes an internal
`MODEL_PROTOCOL_ERROR`; HCO fails closed, sends no partial task to Codex, and
does not spend a second Hermes call repairing the output.

Codex owns repository inspection, technical planning, implementation, tests,
and technical recovery. A separate reviewer may be launched only by an explicit
user request or policy-defined high-risk workflow. That is a distinct review
task, not a hidden fast/strong branch in the Hermes gate. Humans retain
authorization and genuine business trade-offs.

### Contract directions

- `IntentEnvelope` carries immutable raw user text, optional normalized business
  intent, constraints, acceptance criteria, project/objective identity,
  provenance, and versioned context references. Caller identity may be supplied
  as model input, but permissions remain HCO-owned control data.
- HCO validates that envelope and creates an internal execution control record.
  It does not call this outbound command an `ExecutionReceipt`.
- `ExecutionReceipt` returns status, outcome, authoritative final-message
  reference and hash, artifacts, tests, unresolved items, usage, and exact
  thread/turn correlation from HCO to Hermes.
- `InteractionRequest` preserves an approval or input prompt exactly, including
  request type, choices, deadline, authorization scope, and thread/turn/item
  correlation.
- `DeliveryEnvelope` records the current resolved Zulip target, content mode,
  chunks and hashes, delivery state, idempotency key, and acknowledged Zulip
  message IDs.

Operational IDs, routing, permissions, hashes, timestamps, and delivery state
are durable but normally hidden from model prompts. Models see only the semantic
fields and context references needed for their assigned decision.

### Preservation rules

- Store raw inbound text and completed Codex output before any normalization.
- Forward final technical answers verbatim by default without another Hermes
  call. A separately requested business interpretation is a new inbound task;
  it never replaces the source answer.
- Forward approvals, user-input requests, exact errors, and machine evidence
  verbatim, subject to typed security filtering.
- Batch progress deterministically. Do not feed event deltas into a summarizer.
- Store long context as versioned, content-addressed files. A reference includes
  purpose, authority, hash, freshness, and access scope.
- Promote a summary to durable memory only when it is reusable, evidence-backed,
  and accepted by policy or a user. Never let two successive model summaries
  become the only remaining source.

### Review adjudication

In the binary-gate follow-up, Claude and Gemini both accepted the closed
whitelist and one-call design. Both required exact command grammar, explicit
direct-to-Codex syntax, deterministic post-model validation, and no Hermes call
for completed answers or downstream mechanics. Codex additionally ruled that
invalid model output is `MODEL_PROTOCOL_ERROR`, not a fabricated business
`REJECT`; clarification may contain a bounded ordered list rather than an
architecture-fixed question count; and direct-to-Codex may be project-role
authorized but cannot bypass safety or audit controls. Detailed results are in
`.planning/2026-07-15-hermes-token-efficiency-analysis/hermes-binary-gate-review-results.md`.

## Review-call trace

- Claude used a local one-shot, tool-disabled review. The initial response used
  `claude-opus-4-8[1m]`; a short same-session follow-up recovered terminal-
  truncated sections. Both calls completed without tool use or file changes.
- Gemini used `gemini-3.1-pro-preview` through the local `gemini-ttk` wrapper.
  It completed one request with no tools and no file changes.
- The binary-gate follow-up used the same tool-disabled prompt for both models:
  Claude again used `claude-opus-4-8[1m]`; Gemini again used
  `gemini-3.1-pro-preview` in one request. Neither changed files.
- The usage values of these review calls describe this research only and must
  not be treated as measurements of the production Hermes -> Codex path.

Detailed evidence and the identical review prompt are retained under
`.planning/2026-07-15-hermes-token-efficiency-analysis/`.
