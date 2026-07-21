# Jarvis Hermes Context Repair Design

## Problem

The bridge rewrites every natural-language message in a project-owned Zulip
stream to a private slash command. That command invokes a fixed structured LLM
facade and returns the result directly. The request therefore never enters the
normal Hermes conversation loop and cannot use the selected profile's
`SOUL.md`, session history, memory, skills, or tools.

## Design

Project natural-language turns run through the ordinary Hermes agent under the
`codex-bridge` profile. The bridge contributes one tool, `hco_dispatch`, whose
result may end the turn without a second model call.

Hermes adds generic registration metadata named `return_direct`, defaulting to
`False`. A turn terminates directly only when the model emits exactly one tool
call and that tool is registered with `return_direct=True`. Hermes executes and
persists the call normally, then appends the tool result as the final assistant
message and exits the loop. Mixed batches and every existing tool keep the
ordinary follow-up-model behavior.

The persisted sequence is:

1. `user(original request)`
2. `assistant(tool_calls=[hco_dispatch])`
3. `tool(hco_dispatch result)`
4. `assistant(the same result)`

Tool failures use the same terminal path, so they remain one-model-call turns
and produce a visible error rather than triggering an unconstrained recovery
call.

## Trusted Context

The Zulip pre-dispatch hook continues to validate raw numeric `sender_id`,
`stream_id`, and `message_id`, and resolves project ownership solely from the
signed route snapshot. For a valid project turn it mints the existing bounded,
single-use capability and retains the exact user request in the in-process
pending vault.

The installed Zulip adapter currently owns the triggering ID on
`MessageEvent.message_id` but leaves `SessionSource.message_id` empty. After
the raw event and source have passed strict provenance checks and the signed
snapshot has selected a project-owned natural-language turn, the compatibility
hook copies that already-verified ID only into an empty source field. It never
touches general/Hermes traffic or overwrites a conflicting source ID. Assignment
failure is route-unavailable, not an uncaught Gateway hook exception. Gateway
then propagates the source ID through task-local `HERMES_SESSION_MESSAGE_ID`,
allowing `pre_llm_call` to bind the capability to the exact
`session_key + sourceMessageId + request + turn`.

The hook does not rewrite the user message. Instead, it sets a bounded
per-event `channel_prompt` containing the capability and instructions for the
bridge tool. Channel prompts are ephemeral API context: they are not written to
the transcript and are appended after the stable cached system-prompt prefix.
The original user text therefore remains the persisted and remembered turn.

`hco_dispatch` accepts the capability plus one strict semantic object. It
consumes and verifies the capability, checks the semantic schema and topic-mode
constraints, and sends the HCO event using the project and provenance recovered
from the signed capability and pending vault. The model cannot choose project
identity, cwd, credentials, permissions, or route ownership.

## Identity

The installer owns a project-neutral `codex-bridge/SOUL.md` identifying the
assistant as Jarvis PM. It describes coordination, honest evidence-based status
reporting, and use of `hco_dispatch` for executable project work. It contains no
ASK-specific cwd, memory, project identifier, or credential material.

Unmapped/default-Hermes streams continue to use `hermes-general`. Commands and
invalid routes continue to short-circuit before any model call.

## Compatibility And Failure Rules

- `return_direct=False` is byte-for-byte behavior-compatible for existing tools.
- Async plugin handlers continue to use the registry's existing async bridge.
- Direct return is disabled for mixed tool-call batches.
- Missing, expired, replayed, malformed, or mismatched capabilities fail closed.
- Route snapshot failure returns the existing route-unavailable command response.
- HCO unavailable/protocol failures become the direct visible result.
- No capability, token, credential, or bridge bearer is logged or returned.
- Stream/topic session keys and profile isolation remain owned by the gateway.

## Acceptance

Offline tests must prove registration propagation, default compatibility,
single-call termination, persistence ordering, async success, terminal failure,
mixed-call fallback, trusted routing, exact adapter-to-Gateway message-ID
handoff, read-only-source failure closure, profile staging, and rollback.

After review and installation, unique live Zulip messages must be sent and their
actual replies retrieved in the ASK stream, the stockprofits quantitative
stream, and an unmapped/general stream. Logs must confirm selected profiles,
route ownership, one model call for project natural-language turns, and no
cross-stream session leakage without printing secret values.
