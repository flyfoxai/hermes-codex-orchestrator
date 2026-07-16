# Zulip Trusted Project Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task by task. Use strict
> RED/GREEN TDD and record commands and results in
> `.planning/2026-07-15-zulip-project-enforcement/progress.md`.

**Goal:** Ensure every project-capable action originating in a Zulip stream is
bound to that stream's explicitly registered HCO project and never falls back
to ASK or another project's cwd; preserve same-topic entity-Codex continuity.

**Architecture:** HCO owns numeric Zulip route state and the project registry.
An independently installed Hermes plugin resolves a stream through HCO's
authenticated loopback API. Hermes core validates a platform-neutral execution
scope, binds it to task-local context, and enforces it at all tool entry points.
HCO dispatches topic conversations with explicit Codex session IDs rather than
using tmux as conversation identity.

**Tech stack:** Node.js 20 ESM, Python 3.11+, Hermes plugin API, built-in Node
assert tests, pytest through `scripts/run_tests.sh`, Codex CLI JSONL.

**Architecture record:**
`docs/adr/0001-zulip-trusted-execution-scope.md` (`Status: proposed`; only the
project owner may mark it accepted).

## Non-negotiable invariants

- Numeric Zulip `stream_id` selects the route. Stream name is metadata/legacy
  alias. Topic never selects a project.
- Project paths only come from HCO `loadProjectsConfig()` and must be absolute,
  canonical, existing directories at execution time.
- Required-scope platforms fail closed when the resolver is missing, throws,
  times out, conflicts, or returns malformed/unknown scope.
- `generic` means chat-only. It must not mean "use default cwd".
- No Zulip scope may inherit `TERMINAL_CWD`, `/Users/hula/workspace/ASK`, or a
  default project.
- Hermes core is platform-neutral and contains no HCO import, endpoint,
  plugin name, project ID, or local machine path.
- Plugin callbacks remain untrusted/fail-open; the core gate is authoritative.
- Feishu, native Hermes, CLI, cron, and non-configured platforms retain current
  behavior.
- Codex prompts go through stdin. Continuation uses a stored session ID; never
  `--last`. tmux is display-only.
- Never print or persist the HCO bearer token in logs, tests, review files, or
  errors. Render any unavoidable secret as `***MASKED***`.
- Preserve the user's existing HCO edits to `README.md` and the untracked
  `docs/JARVIS_HERMES_QUICKSTART.md`.

## Public contracts

### Identity domains

These values are deliberately separate and are never substituted for one
another:

| Identity | Format | Owner and use |
|---|---|---|
| Delivery `targetKey` | existing `zulip:<stream-name>/<topic>` | Adapter replies, polling, and durable notification bindings; unchanged |
| Route key | `zulip:<decimal-stream-id>` | HCO project-route decision; topic is excluded |
| Conversation key | `zulip:<decimal-stream-id>:<lowercase-full-sha256>` | HCO entity-Codex continuity; digest input is UTF-8 `NFC(trim(topic))` |

`streamId` is added to inbound message validation and provenance but never to
the existing delivery `targetKey`. `adapter/poller.js` remains compatible with
previously stored delivery keys.

### HCO route state, version 2

Default path: `${HCO_STATE_DIR:-~/.hco}/zulip-routes.json`. Writes use a temp
file plus rename under an in-process mutation queue.

```json
{
  "version": 2,
  "streams": {
    "42": {
      "streamId": "42",
      "streamName": "量化交易stockProfits",
      "mode": "mapped",
      "projectId": "stockprofits",
      "updatedAt": "2026-07-15T00:00:00.000Z"
    }
  },
  "legacyNameRoutes": {
    "量化交易stockProfits": {
      "mode": "mapped",
      "projectId": "stockprofits"
    },
    "闲聊": {
      "mode": "generic"
    }
  },
  "migrationMarkers": {
    "adapterStateV1": {
      "sourceRealpath": "/configured/adapter-state.json",
      "sourceSha256": "<sha256-of-imported-bytes>",
      "completedAt": "2026-07-15T00:00:00.000Z"
    }
  },
  "conversations": {
    "zulip:42:<topic-sha256>": {
      "streamId": "42",
      "topicDigest": "<topic-sha256>",
      "projectId": "stockprofits",
      "projectPath": "/Users/hula/Projects/stockprofits",
      "codexSessionId": "<uuid-or-null>",
      "activeRun": {
        "runId": "<uuid>",
        "runnerInstanceId": "<uuid>",
        "pid": 12345,
        "processGroupId": 12345,
        "startedAt": "2026-07-15T00:00:00.000Z"
      },
      "updatedAt": "2026-07-15T00:00:00.000Z"
    }
  }
}
```

Valid route modes are `mapped` and `generic`; absence means
`confirmation_required`. `projectId` is required only for `mapped`.
`activeRun` is `null` when idle. State normalization rejects corrupt mapped,
generic, session, and ownership records rather than silently weakening them.

The version-2 store performs a non-destructive one-time import from the
Adapter's configured `adapterStatePath`. It copies old mapped records to
`{mode:"mapped", projectId}` and old generic records to `{mode:"generic"}`,
then persists the source realpath, content digest, and completion time. It
never rewrites/deletes the old file and never invents numeric IDs. A legacy
alias can be promoted only when an authenticated real inbound event supplies a
validated numeric ID; HCO revalidates the project before writing the numeric
record. A completed marker prevents repeated imports; a changed source digest
is reported for an explicit operator migration rather than merged silently.

### HCO API

All endpoints use the existing bearer authentication and body-size limits.

`GET /zulip/routes/:streamId?streamName=<name>`:

```json
{
  "scope": {
    "mode": "mapped",
    "routeKey": "zulip:42",
    "streamId": "42",
    "streamName": "量化交易stockProfits",
    "projectId": "stockprofits",
    "projectPath": "/Users/hula/Projects/stockprofits",
    "registryRevision": "<sha256>"
  }
}
```

Unknown response is HTTP 200 with `mode=confirmation_required`, no project
path, and a bounded `suggestions` list. Similar names never change state.
Runner/unavailable registry errors use existing structured errors and 5xx.
`registryRevision` is lowercase SHA-256 over the sorted UTF-8 sequence of
`projectId + NUL + canonicalRealpath + LF`; dispatch and revision calculation
use the same execution-time `realpath` values.

`PUT /zulip/routes/:streamId` accepts exactly one of:

```json
{"streamName":"name","mode":"mapped","projectId":"stockprofits"}
{"streamName":"name","mode":"generic"}
```

It revalidates project existence for `mapped` and returns the resolved scope.
`DELETE /zulip/routes/:streamId` removes the numeric decision and returns 204.

`POST /codex/conversations/dispatch` accepts:

```json
{
  "streamId":"42",
  "topic":"strategy review",
  "projectId":"stockprofits",
  "prompt":"...",
  "allowCodeChanges":true
}
```

The server independently re-resolves the route and registry path. A supplied
project ID is an equality assertion, never an authority. It returns a run ID,
conversation key, project ID, status, and (after start) session ID. It rejects
an active conversation with 409 and rejects any persisted project/path/session
conflict before spawning Codex.

`POST /codex/conversations/:runId/cancel` re-resolves the conversation owner,
signals the recorded process group, waits a bounded grace period, escalates to
SIGKILL if needed, and clears state only with a matching
`runId + runnerInstanceId` compare-and-set after the group is confirmed dead.
Cancellation is terminal for both public promises: `completion` resolves with
`status="cancelled"`, while `session` rejects with stable code
`codex_cancelled` if no valid `thread.started` event was attached first.
Concurrent cancellation requests for the same locally owned run are
idempotent and return the same cancelled result.

`POST /codex/conversations/reset` is an authenticated operator endpoint and
accepts exactly:

```json
{"streamId":"42"}
```

Inside one serialized route-state mutation it inspects every persisted
conversation whose `streamId` matches. If any matching conversation has an
`activeRun`, it returns HTTP 409 `conversation_busy` and deletes nothing.
Otherwise it removes all conversations for the stream and returns
`{"streamId":"42","resetCount":<integer>}`. The endpoint rejects unknown
fields, invalid stream IDs, oversized bodies, and missing/invalid bearer
authentication. It is not exposed as an LLM tool or natural-language Zulip
command because reset intentionally discards Codex continuity for every topic
in that stream.

### Hermes post-authorization dispatch result

The HCO plugin registers only `post_auth_gateway_dispatch` for route work and
returns one of:

```python
{
    "action": "execution_scope",
    "scope": {
        "version": 1,
        "mode": "mapped",
        "route_key": "zulip:42",
        "resolver": "hco-zulip-project-router",
        "project_id": "stockprofits",
        "cwd": "/absolute/registered/path",
        "registry_revision": "sha256"
    }
}
```

```python
{"action": "respond", "text": "...", "reason": "confirmation_required"}
```

The resolver string is audit metadata, not trust by name. Hermes trusts only a
valid result collected in the current hook invocation. It never restores an
execution scope from model/session history.

The existing `pre_gateway_dispatch` continues to run before authorization for
backward compatibility, but this plugin does not use it for HCO I/O or route
mutation. Hermes invokes `post_auth_gateway_dispatch` only after authorization
and before built-in commands, session creation, or the model. Unauthorized
messages therefore invoke neither HCO lookup nor route mutation. `respond`
sends exactly one reply to the original target and exits before session/model
work. A `generic` route returns an `execution_scope` with mode `generic` and
continues to ordinary model chat; it is not converted into `respond`.

The exact insertion point is in `GatewayRunner._handle_message()` in
`gateway/run.py`: after both existing user-authorization branches have either
returned or succeeded (currently immediately after the unauthorized branch's
`return None` at line 8169), and before the pending-update/built-in processing
that currently starts at line 8171. The post-auth hook is invoked only for
non-internal messages. No lookup, state mutation, session creation, or model
work may be placed in either authorization branch or before this shared point.

### Hermes shared tool-gate API

`agent/execution_scope.py` owns the private ContextVar and exposes an immutable
contract. These are the frozen version-1 types; implementation may use
`MappingProxyType` or an equivalent immutable-copy representation but may not
weaken the field or mode rules:

```python
from dataclasses import dataclass
from typing import Any, Literal, Mapping

@dataclass(frozen=True)
class ExecutionScope:
    version: Literal[1]
    mode: Literal["mapped", "generic"]
    route_key: str
    resolver: str
    project_id: str | None
    cwd: str | None
    registry_revision: str | None

@dataclass(frozen=True)
class ExecutionScopePolicy:
    required_platforms: frozenset[str]
    chat_only_tools: frozenset[str]

@dataclass(frozen=True)
class ToolScopeDecision:
    allowed: bool
    tool_name: str
    arguments: Mapping[str, Any]
    error_code: str | None
    user_message: str | None
    audit: Mapping[str, str]

def evaluate_tool_execution_scope(
    *,
    scope: ExecutionScope | None,
    policy: ExecutionScopePolicy,
    tool_name: str,
    arguments: Mapping[str, Any],
) -> ToolScopeDecision: ...

def get_current_execution_scope() -> ExecutionScope | None: ...

def enforce_current_tool_execution_scope(
    *,
    tool_name: str,
    arguments: Mapping[str, Any],
) -> ToolScopeDecision: ...
```

Strict validation is mode-dependent:

| Input | Required fields | Forbidden/invalid fields |
|---|---|---|
| `mapped` | `version=1`; `route_key=zulip:<decimal stream_id>` matching the authenticated source; non-empty bounded `resolver` and `project_id`; absolute canonical existing-directory `cwd`; 64-character lowercase-hex `registry_revision` | Missing/extra fields, booleans as IDs, relative/non-canonical/missing cwd, route/source mismatch |
| `generic` | `version=1`; matching route key; non-empty bounded `resolver` | `project_id`, `cwd`, and `registry_revision` must all be `None`; any project authority is rejected |
| `confirmation_required` | Never an `ExecutionScope`; plugin must return authenticated `respond` | Binding it, treating it as generic, or reaching model/tool execution |
| unbound | Internal getter returns `None`; valid only when policy does not require scope for this source | On a required Zulip stream it blocks; it never means generic or default cwd |

Wire scopes contain exactly those seven keys; optional authority fields are
present with JSON `null` in generic mode. `resolver` is 1-64 printable ASCII
characters and `project_id` is 1-128 characters using the existing HCO project
ID validator. Unknown keys, unknown modes/versions, non-string values,
blank/over-limit values, wildcard tool names, and policy values outside
normalized exact platform/tool names are rejected at startup or hook-result
validation. The two policy sets are immutable for the process lifetime.
`required_platforms={"zulip"}` applies only when the authenticated source
carries a valid decimal `stream_id`; Zulip DMs remain unscoped in version 1.

The private ContextVar uses a unique sentinel internally so an unset variable
cannot collide with an explicit generic object. The only binder used by the
gateway follows this exact token lifecycle:

```python
@contextmanager
def _bind_validated_execution_scope(scope: ExecutionScope):
    token = _CURRENT_EXECUTION_SCOPE.set(scope)
    try:
        yield
    finally:
        _CURRENT_EXECUTION_SCOPE.reset(token)
```

The gateway enters this binder only after post-auth hook collection and strict
validation, and keeps it active through session/model/tool completion. Nested
binders restore the outer token; each asyncio task has its own value; every
normal, blocked, cancelled, and exceptional exit resets in `finally`. Plugin
or model arguments never receive a setter/token. Python plugins are trusted
installed code rather than a hostile-code sandbox, but hook results remain
untrusted data and must pass validation.

The function receives a normalized underlying tool name and a defensive copy
of parsed arguments. It performs no hooks, middleware, logging, registry
dispatch, or tool calls; it never mutates inputs; returned mappings are
immutable copies. Calling it again with its own normalized output produces the
same result. Blocked calls use stable code `execution_scope_blocked` and a
redaction-safe message/audit payload.

`get_current_execution_scope()` is the only read API for execution entry
points; `None` means unbound and remains distinct from an `ExecutionScope` with
`mode="generic"`. `enforce_current_tool_execution_scope()` reads both the
current scope and startup-loaded immutable policy internally, then delegates to
the pure evaluator. None of the four tool entry points accepts a caller- or
model-supplied scope/policy parameter. Binding is restricted to the validated
gateway lifecycle and its token/reset context manager, so direct helper calls
cannot forge a mapped scope.

Callers emit audit events and translate a blocked decision to the existing tool
result shape. The evaluation order is mandatory:

| Entry path | Parse/unwrap first | Gate must precede |
|---|---|---|
| `execute_tool_calls_concurrent()` | parse arguments and resolve any `tool_call` bridge target | request middleware, plugin hooks, guardrails/checkpoints, `invoke_tool()` and all direct branches |
| `execute_tool_calls_sequential()` | same | request middleware, plugin hooks, terminal/file/memory/delegation/direct branches, registry dispatch |
| `agent_runtime_helpers.invoke_tool()` | receive normalized name/dict | request middleware, plugin hooks, todo/session/memory/read-terminal/delegation branches, `handle_function_call(...skip_pre_tool_call_hook=True)` |
| `model_tools.handle_function_call()` | coerce JSON; unwrap `tool_call` then recurse on underlying name/args | inline `tool_search`/`tool_describe`, request middleware, plugin hooks, notifications, registry dispatch |

The synthetic `tool_call` name is not the policy unit; its resolved underlying
tool is. Defense-in-depth repeats at public entry points are required and safe
because the evaluator is immutable and idempotent. `skip_pre_tool_call_hook`
and `skip_tool_request_middleware` never skip execution-scope evaluation.
The existing `propagate_context_to_thread(_run_tool)` wrapper in
`agent/tool_executor.py` must remain in place and carry the new ContextVar into
concurrent workers; focused tests must fail if that propagation is removed.

#### Deterministic path validation

The evaluator uses tool schemas, not a fuzzy scan of arbitrary argument names:

| Underlying tool | Fields and treatment |
|---|---|
| `terminal` | Validate a supplied `workdir`, then always replace it with the canonical trusted root. `command` remains opaque except for a conservative check that blocks a directly expressed `cd`/`pushd` absolute or `~` target outside the root. |
| `read_file` | Validate `path`; the full target must exist and resolve strictly inside the root. |
| `write_file` | Validate `path`; an existing target resolves strictly, while a missing target uses the missing-target algorithm below. |
| `search_files` | Validate `path`, including its default `.`; the target must exist and resolve strictly inside the root. |
| `patch` replace mode | Validate `path`; the target must exist and resolve strictly inside the root. |
| `patch` V4A mode | Call existing `tools.patch_parser.parse_v4a_patch()` before side effects. Validate Add `file_path` as a possible missing target; Update/Delete `file_path` as existing; Move source `file_path` as existing and destination `new_path` as a possible missing target. Empty operations or parser errors block. |
| `execute_code` | Top-level schema has only opaque `code`, so no false claim of static path inspection is made. Every internal RPC bridge (`path`, `workdir`, and patch calls) reaches `model_tools.handle_function_call()` and is gated as the underlying tool. |
| every other tool | No guessed path fields. Mapped scope remains available for audit/dispatch; generic/unbound-required policy still blocks by exact tool name. |

For every path-bearing field:

1. Recompute `root = Path(scope.cwd).resolve(strict=True)`, require
   `root.is_dir()`, and require `str(root) == scope.cwd`; otherwise block.
2. Require a non-empty string without NUL. Apply `expanduser()`. Resolve a
   relative value from `root`; retain an absolute value as supplied.
3. For an existing read/source target, use `resolve(strict=True)`. A broken
   symlink or resolution error blocks.
4. For a permitted missing write/destination, resolve existing prefixes and
   `.`/`..` with `resolve(strict=False)`, while walking the original components
   with `lstat()` so any broken symlink blocks. From the normalized candidate,
   walk upward to the nearest existing ancestor, resolve it strictly, then
   append only the remaining non-existent suffix. The rebuilt target must
   remain below root.
5. Prove containment by calling `candidate.relative_to(root)`. Any exception
   blocks; string prefixes such as `/project-other` never count as contained.
6. Return a newly copied argument mapping containing normalized absolute paths
   (and forced terminal workdir); never mutate the caller mapping.

Tests cover root equality, `..`, `~`, absolute paths, sibling-prefix paths,
existing and broken symlinks, missing parents, V4A Add/Update/Delete/Move, and
scope cwd disappearing between resolution and execution. This prevents the
reported wrong-project fallback and obvious direct path mistakes. It does not
claim to parse arbitrary shell/Python semantics or prevent a symlink swap after
validation; hostile-code isolation requires a container/OS sandbox.

### Hermes configuration

```yaml
gateway:
  execution_scope:
    required_platforms:
      - zulip
    chat_only_tools: []
```

Only Zulip stream messages require scope in this release. Zulip DMs have no
stream route and remain general chat, unless the operator later adds a separate
policy. The validator keys this distinction from canonical `stream_id`, not
from mutable `chat_type` strings alone.

Plugin configuration is separate:

```yaml
plugins:
  enabled:
    - project-task-guard
    - provider-stability-guard
    - hco-zulip-project-router
  entries:
    hco-zulip-project-router:
      runner_base_url: http://127.0.0.1:8731
      token_file: /Users/hula/.hco/token
      timeout_seconds: 2
```

## Phase 0: Review gate and isolated baselines

### Task 0.1: Review this plan before production edits

**Files:**

- Review: `docs/adr/0001-zulip-trusted-execution-scope.md`
- Review: `docs/superpowers/plans/2026-07-15-zulip-project-enforcement.md`
- Create: `docs/reviews/ZULIP_PROJECT_ENFORCEMENT_PLAN_REVIEW_REQUEST.md`
- Create: `docs/reviews/CLAUDE_ZULIP_PROJECT_ENFORCEMENT_PLAN_REVIEW.md`
- Create: `docs/reviews/GEMINI_ZULIP_PROJECT_ENFORCEMENT_PLAN_REVIEW.md`
- Create: `docs/reviews/ZULIP_PROJECT_ENFORCEMENT_PLAN_REVIEW_SYNTHESIS.md`

- [x] Ask Claude and Gemini independently to inspect both repositories and the
  ADR/plan. Require Critical/High/Medium/Low findings and an exact final
  `APPROVED` or `CHANGES_REQUIRED` verdict.
- [x] Codex verifies every cited finding against source. Revise the ADR/plan for
  valid findings.
- [x] Repeat review until both engines have zero Critical and zero High. Medium
  findings must be fixed or explicitly deferred with rationale in synthesis.
- [x] Do not touch production files until this gate passes.

### Task 0.2: Create clean isolated worktrees and baseline evidence

**HCO worktree:** `/Users/hula/Projects/.worktrees/hco-zulip-enforcement`

**Hermes worktree:** `/Users/hula/Projects/.worktrees/hermes-zulip-enforcement`

- [x] Create branches `codex/zulip-project-enforcement` in each repository using
  the worktree workflow. Never move or discard the user's HCO dirty files.
- [x] In HCO worktree run `npm run adapter:verify` and `npm run verify`.
- [x] In Hermes worktree run focused existing baselines through
  `scripts/run_tests.sh tests/gateway/test_pre_gateway_dispatch.py tests/hermes_cli/test_plugins.py -q`.
- [ ] After the RED test file exists, include
  `tests/gateway/test_post_auth_gateway_dispatch.py` in every focused gateway
  verification command. The old pre-dispatch tests remain regression coverage;
  they are not the new authorization boundary.
- [x] Record HEADs, commands, exit codes, and any pre-existing failure before
  writing tests.

## Phase 1: HCO numeric route source of truth

### Task 1.1: RED - route store schema and migration tests

**Files:**

- Create: `runner/zulip-routes.js`
- Create: `scripts/zulip-routes-test.js`
- Modify: `runner/config.js`
- Modify: `adapter/config.js`
- Modify: `package.json`

- [ ] Write failing tests for empty v2 state, atomic persistence, numeric ID
  validation, `mapped|generic` validation, and concurrent serialized mutations.
- [ ] Write failing migration tests that use the Adapter's configured
  `adapterStatePath` as the explicit source of current fields
  `zulipStreamProjectRoutes` and `zulipGenericStreams`. Import mapped aliases as
  `{mode:"mapped",projectId}` and generic aliases as `{mode:"generic"}`.
- [ ] Prove the import records `sourceRealpath + sourceSha256 + completedAt`, is
  idempotent, reports a changed source after completion, never edits the old
  Adapter file, and never invents numeric IDs. A real observed numeric ID is
  required before alias promotion.
- [ ] Write failing tests proving numeric records win over name aliases, a
  renamed stream keeps its numeric mapping, and similar whitespace/case names
  produce suggestions only.
- [ ] Run `node scripts/zulip-routes-test.js`; capture the expected failure.

### Task 1.2: GREEN - route store and registry-backed resolution

- [ ] Implement strict state normalization without silently converting corrupt
  mapped records to generic/unknown.
- [ ] Resolve mapped project paths only by calling `loadProjectsConfig()`.
- [ ] Canonicalize with `realpath` at execution/dispatch time, require an
  existing directory, and compute a deterministic registry revision as
  lowercase SHA-256 of sorted UTF-8
  `projectId + NUL + canonicalPath + LF` records.
- [ ] Return `confirmation_required` for absence and bounded project suggestions
  for exact compact-name matches. Never auto-write a suggested mapping.
- [ ] Make the Task 1.1 test green.

### Task 1.3: RED/GREEN - authenticated route API

**Files:**

- Modify: `runner/http.js`
- Modify: `scripts/contract-test.js`
- Modify: `adapter/runner-client.js`
- Modify: `scripts/adapter-foundation-test.js`

- [ ] Add failing contract tests for GET, PUT mapped, PUT generic, DELETE,
  invalid ID/body/mode/project, unknown stream, auth rejection, and registry
  unavailable/path missing.
- [ ] Implement endpoints through the route module; do not expose state file
  paths, token values, or raw internal errors.
- [ ] Extend the adapter client with typed route methods and make all tests
  green.

### Task 1.4: RED/GREEN - adapter uses numeric IDs first

**Files:**

- Modify: `adapter/types.js`
- Modify: `adapter/router.js`
- Modify: `adapter/handler.js`
- Modify: `adapter/state-store.js`
- Modify: `adapter/poller.js`
- Modify: `scripts/adapter-foundation-test.js`
- Modify: `scripts/adapter-handler-test.js`

- [ ] Add a validated decimal-string `streamId` to Zulip message input and
  provenance. Keep `targetKeyFromMessage()` byte-compatible as
  `zulip:<stream-name>/<topic>`; never replace it with the route or conversation
  key.
- [ ] Replace local route authority with Runner route methods. Retain a
  read-only migration path for legacy state and remove it only after the
  numeric decision is persisted.
- [ ] Test that `/codex route set|confirm|none|show|unset` uses the observed
  numeric ID, revalidates the project, and cannot route a different ID supplied
  in message text.
- [ ] Test that ordinary non-command adapter messages keep existing behavior;
  native Hermes enforcement is handled by the plugin in Phase 3.
- [ ] Add a poller compatibility test proving old/in-flight delivery target
  keys still produce replies after numeric routing is enabled.
- [ ] Run `npm run adapter:verify`.

## Phase 2: Hermes platform-neutral execution scope

All files in this phase are in the isolated Hermes worktree.

### Task 2.1: RED/GREEN - carry canonical stream identity

**Files:**

- Modify: `gateway/session.py`
- Modify: `gateway/platforms/base.py`
- Modify: `gateway/platforms/zulip.py`
- Modify: `tests/gateway/test_zulip.py` or the existing Zulip adapter test file
- Modify: `tests/gateway/test_session.py`

- [ ] Add failing serialization round-trip tests for optional `stream_id` as a
  decimal string. Reject booleans, negatives, empty values, and non-digits at
  the execution-scope validator; old serialized sessions without the field
  remain readable.
- [ ] Add a failing real inbound-event test proving stream ID, stream name, and
  topic remain separate. DM source has no stream ID.
- [ ] Implement `SessionSource.stream_id`, base builder propagation, and Zulip
  inbound population. Do not parse it back out of composite `chat_id`.
- [ ] Run the focused tests through `scripts/run_tests.sh ... -q`.

### Task 2.2: RED/GREEN - scope value, validation, and task-local binding

**Files:**

- Create: `agent/execution_scope.py`
- Modify: `gateway/session.py`
- Modify: `gateway/session_context.py`
- Modify: `gateway/run.py`
- Create: `tests/agent/test_execution_scope.py`
- Modify: `tests/gateway/test_session_context.py`

- [ ] Write failing tests for `mapped`, `generic`, and
  `confirmation_required`; malformed modes; missing project/cwd; relative cwd;
  symlink canonicalization; cwd disappearance; empty required scope; and
  cleanup between concurrent asyncio tasks.
- [ ] Define an immutable `ExecutionScope` with version, mode, route key,
  resolver audit name, optional project ID/cwd, and registry revision exactly
  as frozen in the public contract. Add strict mode/field-combination tests and
  prove `confirmation_required` cannot be bound as a scope.
- [ ] Implement a ContextVar whose unset value is distinct from generic and is
  independent from the existing session ContextVars. Bind it with the token
  returned by `ContextVar.set()` and restore it with `reset(token)` in the
  gateway `finally` path; do not copy the existing `""` cleanup convention.
- [ ] Expose `get_current_execution_scope()` as the sole read API and a scoped
  token/reset binder for validated gateway code. Do not expose a setter or add
  a scope/policy argument to any tool-dispatch entry point.
- [ ] Prove nested binding restores the caller's outer scope, concurrent asyncio
  tasks cannot observe one another's scope, and normal return plus every
  exception path performs token reset. An unset scope must remain distinct from
  an explicitly bound generic scope before, during, and after a turn.
- [ ] Extend `SessionContext` with a wire-invisible current-turn scope. Do not
  serialize it into durable session history.
- [ ] Pass only a validated mapped cwd to existing `set_session_vars(cwd=...)`;
  required generic/confirmation scopes pass an explicit empty cwd so no
  environment fallback occurs.

### Task 2.3: RED/GREEN - post-authorization scope collection and `respond`

**Files:**

- Modify: `gateway/run.py`
- Create: `tests/gateway/test_post_auth_gateway_dispatch.py`
- Modify: `tests/gateway/test_pre_gateway_dispatch.py`

- [ ] Add failing ordering tests proving `post_auth_gateway_dispatch` runs only
  after `_is_user_authorized(source)` succeeds and before built-in command
  handling, session creation, model construction, or model execution.
- [ ] Place the invocation at the single shared point in
  `GatewayRunner._handle_message()`: immediately after the existing no-user-ID
  and identified-user authorization branches (currently after line 8169) and
  before pending-update interception (currently line 8171). Assert both
  authorized branch shapes reach it and every unauthorized return bypasses it.
- [ ] Prove an unauthorized sender causes zero post-auth hook invocations, zero
  HCO/network calls, zero route-state mutations, zero session/model work, and
  only the existing unauthorized response behavior.
- [ ] Add failing tests proving scope results are collected from the complete
  post-auth hook result list even when another plugin returns `allow` or
  `rewrite`.
- [ ] Add tests for no resolver, one valid resolver, duplicate identical
  results, conflicting results, resolver exception/empty result, and malformed
  scope on a required platform.
- [ ] Add tests that only Zulip stream messages (valid `stream_id`) require the
  scope under initial config; Zulip DM, Feishu, native, internal events, and an
  empty required-platform config keep existing behavior.
- [ ] Add `respond` tests for confirmation/error/management-command results:
  each sends exactly one reply to the original stream/topic after authorization
  and exits before built-in command, session, or model processing.
- [ ] Add a generic-scope test proving `mode=generic` is bound as an explicit
  chat-only execution scope and continues through ordinary session/model chat;
  it is never translated to `respond` and cannot inherit a default cwd.
- [ ] Add `post_auth_gateway_dispatch` to the public hook registry and implement
  a two-pass result processor: collect/validate scopes first, then apply one
  response/skip/rewrite/allow decision. Conflicting response actions fail closed
  rather than choosing by plugin order. Preserve the existing pre-auth hook
  behavior for other plugins, but this HCO plugin never uses it.
- [ ] Return user-safe scope errors; put resolver diagnostics in structured
  logs without secrets or raw token/HTTP bodies.

### Task 2.4: RED/GREEN - non-bypassable tool gate

**Files:**

- Modify: `agent/execution_scope.py`
- Modify: `model_tools.py`
- Modify: `agent/tool_executor.py`
- Modify: `agent/agent_runtime_helpers.py`
- Create: `tests/agent/test_execution_scope_tool_entrypoints.py`

- [ ] Write parameterized failing tests for all four public/real entry paths,
  using the shared `evaluate_tool_execution_scope(...) -> ToolScopeDecision`
  contract defined above. Cover
  `skip_pre_tool_call_hook=True`, direct agent-loop tools (`terminal`, file
  read/write/patch/search, `execute_code`, `delegate_task`, `read_terminal`,
  memory/project plugin tools), and the `tool_call` bridge.
- [ ] Required scope absent/malformed, generic, and confirmation-required block
  every tool unless its exact name is in configured `chat_only_tools`.
- [ ] Implement the frozen schema-specific path matrix and deterministic
  `Path.resolve`/nearest-existing-ancestor/`relative_to` algorithm. Do not use a
  fuzzy `cwd|workdir|workspace|root|path|file_path|directory` scan as a claim of
  complete coverage.
- [ ] Confirm that tools with no filesystem fields still carry project ID/cwd
  in task-local context for audit and HCO dispatch.
- [ ] Every entry path obtains scope only through
  `get_current_execution_scope()` (via
  `enforce_current_tool_execution_scope()`); tests must prove a tool argument,
  helper parameter, session-history value, or model payload cannot inject a
  mapped scope.
- [ ] In `execute_tool_calls_concurrent()` and
  `execute_tool_calls_sequential()`, parse arguments and unwrap the `tool_call`
  bridge, then gate the underlying call before request middleware, plugin hooks,
  guardrails/checkpoints, runtime helpers, or direct tool branches.
- [ ] In `agent_runtime_helpers.invoke_tool()`, gate the normalized name/dict
  before its `apply_tool_request_middleware()` call, plugin hooks, and every
  direct todo/session/memory/terminal/delegation branch; the fallback call with
  `skip_pre_tool_call_hook=True` must still be gated.
- [ ] In `model_tools.handle_function_call()`, coerce JSON first; gate
  `tool_search`/`tool_describe` before inline reads, unwrap `tool_call` and recurse
  on its underlying name/arguments, and gate ordinary calls before
  `apply_tool_request_middleware()`, plugin callbacks, notifications, or registry
  dispatch. Never treat the synthetic bridge name as the policy unit.
- [ ] For each of the four entry paths, add an instrumented call-order test
  whose middleware and plugin-hook spies would record a call or raise. A
  blocked decision must return before either spy runs; an allowed decision must
  record `gate` before `middleware`, `plugin_hook`, and the first tool-specific
  side effect.
- [ ] Repeated defense-in-depth calls must return the same decision/normalized
  arguments and create no side effects. `skip_pre_tool_call_hook` and
  `skip_tool_request_middleware` cannot bypass the gate. Return a stable
  structured `execution_scope_blocked` tool error and emit only sanitized audit
  fields after the pure decision returns.
- [ ] Preserve `propagate_context_to_thread(_run_tool)` around concurrent worker
  submission and add a regression test proving the mapped/generic/unset scope
  observed by each worker matches its submitting turn without leakage.
- [ ] Explicitly document/test the residual boundary: opaque shell text is not
  an OS sandbox. Add regression tests for the incident form (missing workdir)
  and obvious explicit cross-root `cd`/absolute-path tokens; do not claim
  protection from deliberately obfuscated commands.

### Task 2.5: Hermes E2E resolution-chain test

**Files:**

- Create: `tests/e2e/test_gateway_execution_scope.py`

- [ ] Use real imports, a temporary `HERMES_HOME`, a fake local resolver plugin,
  two temporary git project directories, and the real gateway hook processor.
- [ ] Prove mapped stream A executes relative paths in A, stream B in B,
  unknown/generic execute no project tool, simultaneous turns do not exchange
  ContextVars, a plugin failure blocks, and Feishu remains unchanged.
- [ ] Run with `scripts/run_tests.sh tests/e2e/test_gateway_execution_scope.py -q`.

## Phase 3: HCO Zulip router plugin

The source lives in HCO; installation copies it to Jarvis only after review.

### Task 3.1: RED/GREEN - plugin resolver and management commands

**Files:**

- Create: `integrations/hermes/plugins/hco-zulip-project-router/plugin.yaml`
- Create: `integrations/hermes/plugins/hco-zulip-project-router/__init__.py`
- Create: `scripts/hermes-plugin-test.py`
- Modify: `package.json`

- [ ] Load Runner URL, token-file path, and timeout from the plugin entry config.
  Require loopback URL by default, regular-file token with no group/world bits,
  and a bounded 0.1-5 second timeout. Never log the token.
- [ ] Ignore all non-Zulip messages and Zulip DMs.
- [ ] For a mapped stream, return exactly one execution-scope result from the
  live Runner response; never accept a path from incoming message/model text.
- [ ] For an unknown route or resolver error, return `respond` with a concise
  Chinese explanation before model work. Unknown responses include exact route
  commands and safe suggestions. For `generic`, return a valid
  `execution_scope(mode="generic")` and allow ordinary model chat to continue;
  do not return `respond` merely because the stream is generic.
- [ ] Deterministically intercept exact `/codex route
  set|confirm|none|show|unset` forms, call authenticated HCO endpoints, and
  return `respond` from the post-authorization hook. Reject extra/ambiguous text
  and never ask the model to infer a route mutation. Tests prove unauthorized
  messages never invoke this plugin and therefore make no HCO request or state
  change.
- [ ] Tests use a local fake HTTP server and cover timeouts, non-JSON, 401/500,
  malformed scope, mismatched stream ID, bad project/path, command validation,
  secret redaction, and successful Unicode stream/topic metadata.
- [ ] Run `python3 scripts/hermes-plugin-test.py` and HCO verification.

### Task 3.2: RED/GREEN - trusted HCO dispatch tool

**Files:**

- Modify: `integrations/hermes/plugins/hco-zulip-project-router/__init__.py`
- Modify: `scripts/hermes-plugin-test.py`

- [ ] Register `hco_codex_dispatch` without overriding a built-in. Its schema
  accepts goal/prompt and allow-code-change intent, but not project path. It
  reads stream ID/topic/project ID/cwd from the validated current execution
  scope/session ContextVars.
- [ ] Reject calls outside a mapped Zulip stream and reject any Runner response
  whose route/project differs from current scope.
- [ ] Submit to `/codex/conversations/dispatch`; return run/session/status data
  without the bearer token or unrestricted local paths.

## Phase 4: Explicit Codex conversation continuity

### Task 4.1: RED - conversation key/store/locking tests

**Files:**

- Create: `runner/codex-conversations.js`
- Create: `scripts/codex-conversations-test.js`
- Modify: `package.json`

- [ ] Test key stability for same numeric stream/topic, Unicode NFC, topic trim,
  different topics, different streams, and collision-resistant full SHA-256.
- [ ] Test atomic persistence and one-active-run compare-and-set behavior.
- [ ] Test persisted project ID/path mismatch, invalid session ID, stale active
  run recovery policy, and route changes. A route change must not resume the old
  project's Codex session; it requires explicit reset/new conversation state.

### Task 4.2: GREEN - JSONL Codex executor

**Files:**

- Modify: `runner/codex-conversations.js`
- Modify: `runner/http.js`
- Modify: `scripts/dispatch-test.js`
- Modify: `scripts/dispatch-success-test.js`
- Modify: `scripts/contract-test.js`

- [ ] Implement a separate exported
  `dispatchCodexConversation(...)` in `runner/codex-conversations.js`.
  `runner/codex.js::dispatchTask()` and the existing `POST /tasks` tmux path
  remain byte/behavior compatible; add a regression test proving
  `POST /tasks` with `dispatch:true` still calls the tmux executor.
- [ ] Run a sanitized Codex preflight for the configured executable and required
  `exec --json` plus `exec resume` interfaces before accepting conversation
  work. Errors expose only stable categories, never the raw executable path,
  environment, prompt, token, or unrestricted stderr.
- [ ] Spawn with argv arrays and stdin; never shell interpolation. First run:
  `<codexPath> exec --json --cd <registeredPath> -`. Resume:
  `<codexPath> exec resume <sessionId> --json -`, with child `cwd` set to the
  same canonical registered path.
- [ ] Before dispatch, require the registered canonical directory to be a valid
  Git working tree using a bounded sanitized `git -C <path> rev-parse` check.
  Production must fail closed; never add `--skip-git-repo-check`.
- [ ] Parse stdout JSONL incrementally. The only session event is a top-level
  object with `type == "thread.started"`; read its top-level `thread_id`, require
  a UUID, and reject zero or conflicting IDs. Never interpret a nested event
  path as the session ID. Keep stderr on a separate bounded channel and never
  parse it as JSONL.
- [ ] Acquire the conversation by a UUID `runId` and per-process UUID
  `runnerInstanceId` compare-and-set before spawn. Only that owner may attach
  PID/process-group metadata, persist a session ID/status, or clear `activeRun`.
  Do not persist a session ID until the matching process has started and emitted
  it; every finally cleanup is a matching-owner CAS.
- [ ] Use fixed version-1 limits: 30 seconds from spawn to the first valid
  `thread.started`, 1,800 seconds total execution, 5 seconds after SIGTERM, and
  5 seconds after SIGKILL to confirm death; stdout maximum 8 MiB, each JSONL
  line 1 MiB, at most 4,096 events, and retained sanitized stderr 64 KiB. Any
  timeout/overflow/malformed line terminates the group and returns a stable
  category without raw prompt, environment, executable path, or stderr.
- [ ] Launch a dedicated process group with explicit minimal environment/PATH.
  Cancellation marks the owner `cancelling`, signals the group, waits the TERM
  grace, escalates to SIGKILL, confirms death, and reaps the child before an
  owner-matched cleanup. Normal completion also awaits close/reap before cleanup.
- [ ] If cancellation wins before a valid session event, reject the public
  `session` promise with `codex_cancelled`; never leave it pending after the
  child closes. Prove two concurrent cancellation requests are idempotent,
  both return `cancelled`, and ownership cleanup occurs once without conflict.
- [ ] On Runner startup, examine persisted active runs without adopting them.
  Clear a stale record only after confirming its recorded process group is dead;
  a live group continues to block a second dispatch. PID reuse or unverifiable
  ownership fails closed and requires operator recovery. Reap child processes
  so cancellation and normal completion leave no zombies.
- [ ] Add the authenticated dispatch endpoint and independently resolve route
  plus registry before spawning.
- [ ] Add the authenticated operator-only stream reset endpoint. Its store
  mutation checks all conversations for the stream before deleting any, blocks
  atomically with `conversation_busy` when one is active, and otherwise returns
  the exact reset count. Cover empty, multi-topic, active, invalid-body,
  unknown-field, and unauthenticated cases.
- [ ] New Zulip entity-session dispatch must not use tmux as correctness state.
  Add every new JS source/test script to `package.json` syntax checking and keep
  both `npm run adapter:verify` and `npm run verify` green.

The persisted active-run state machine is normative:

| Transition | Required compare-and-set precondition | Persisted effect |
|---|---|---|
| idle -> claimed | `activeRun is null`; conversation route/project/canonical path match current resolution | Store UUID `runId`, current UUID `runnerInstanceId`, `status="claimed"`, null PID/PGID, start time |
| claimed -> running | same exact owner and conversation identity immediately after spawn | Attach positive PID/PGID and set `status="running"` |
| running -> running/session-known | same owner; exactly one valid top-level thread event; persisted session is null or equal | Persist `codexSessionId`; never overwrite a different ID |
| claimed/running -> cancelling | cancel request resolves run ID to the same owner record | Set `status="cancelling"`; do not clear before confirmed death |
| owned active -> idle | same owner; child has exited and been reaped, or its group is confirmed dead | Clear only `activeRun`; retain the matching session ID and conversation identity |
| restart recovery -> idle | stored record still exactly matches the inspected owner and `kill(-pgid, 0)` proves ESRCH | Recovery CAS clears the stale record |
| any conflict/unverifiable state | owner, route, project, path, session, PID/PGID, or liveness cannot be proven | No mutation; return conflict/operator-recovery error |

A crash between claim and verified PID attachment is intentionally
unverifiable and fails closed. A live PGID, permission error, PID reuse, or
ambiguous liveness is never killed/adopted/cleared by a new Runner instance.
The implementation must test every transition, late events from a superseded
run, double cancellation, spawn failure, startup timeout, output overflow,
normal non-zero exit, Runner restart, and owner-mismatched cleanup.

### Task 4.3: Integration continuity test

- [ ] Run a fake Codex executable that emits deterministic JSONL. Prove two
  messages in stream 42/topic A use first+resume with one session ID, topic B
  creates another, stream 43 creates another, and no path/session crosses.
- [ ] Prove prompt bytes are supplied only on stdin and arguments/logs do not
  contain prompt contents or secrets.

## Phase 5: Documentation and full pre-install verification

### Task 5.1: Documentation

**Files:**

- Modify carefully: `README.md` (merge, do not overwrite user edits)
- Modify: `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`
- Modify: `docs/OPERATIONS.md`
- Modify/merge: `docs/JARVIS_HERMES_QUICKSTART.md`
- Create: `docs/ZULIP_PROJECT_ROUTING.md`

- [ ] Document stream ID vs name vs topic vs Hermes session vs Codex session.
- [ ] Document route commands, unknown/generic behavior, renamed streams,
  Runner outage behavior, same-topic continuity, concurrency, audit logs,
  recovery, and the terminal-shell residual boundary.
- [ ] Include install, health check, rollback order, state backup, and incident
  response. Do not include bearer tokens.

### Task 5.2: Full local verification

- [ ] HCO: `npm run adapter:verify`.
- [ ] HCO: `npm run verify`.
- [ ] HCO: new route, plugin, and conversation tests.
- [ ] Hermes: all changed/focused tests through `scripts/run_tests.sh ... -q`.
- [ ] Hermes: broader gateway/tool/plugin suites selected by changed imports.
- [ ] Check both worktrees with `git diff --check` and `git status --short`.
- [ ] Inspect diffs for secrets, hard-coded ASK fallback, HCO imports in Hermes,
  and accidental changes outside the plan.

## Phase 6: Dual implementation review and remediation

**Files:**

- Create: `docs/reviews/ZULIP_PROJECT_ENFORCEMENT_IMPLEMENTATION_REVIEW_REQUEST.md`
- Create: `docs/reviews/CLAUDE_ZULIP_PROJECT_ENFORCEMENT_IMPLEMENTATION_REVIEW.md`
- Create: `docs/reviews/GEMINI_ZULIP_PROJECT_ENFORCEMENT_IMPLEMENTATION_REVIEW.md`
- Create: `docs/reviews/ZULIP_PROJECT_ENFORCEMENT_IMPLEMENTATION_REVIEW_SYNTHESIS.md`

- [ ] Run the ADR gate and include the ADR, plan, both repository diffs, test
  evidence, and deployment files in both review prompts.
- [ ] Require reviewers to check auth/secret handling, fail-closed behavior,
  hook ordering, every tool entry, path/cwd handling, concurrency, state
  migration, Codex JSONL/session parsing, cancellation, compatibility, and test
  realism.
- [ ] Codex independently verifies findings. Fix all valid Critical/High and
  rerun affected plus full tests. Resolve or explicitly defer Medium/Low.
- [ ] Repeat external review if a fix changes the architecture or security
  boundary. Do not install with any open Critical/High.

## Phase 7: Jarvis installation, restart, and acceptance

### Task 7.1: Preflight and backup

- [ ] Confirm HCO Runner health, canonical project registry entries, Codex CLI
  version, Hermes Python environment, and clean review state.
- [ ] Back up `~/.hco` route/conversation state, the plugin directory, and
  `/Users/hula/.hermes/config.yaml` with restrictive permissions. Do not copy
  secrets into the repository.

### Task 7.2: Coordinated rollout

Order prevents an unguarded interval:

- [ ] Deploy/start reviewed HCO with route endpoints first.
- [ ] Install plugin atomically to
  `/Users/hula/.hermes/plugins/hco-zulip-project-router/`.
- [ ] Append the plugin to the existing enabled list; preserve
  `project-task-guard` and `provider-stability-guard`.
- [ ] Add plugin settings and Hermes required-scope config.
- [ ] Restart the Jarvis Hermes service using its actual service manager; verify
  a single healthy process and inspect sanitized startup logs.

### Task 7.3: Live acceptance matrix

- [ ] `量化交易stockProfits` numeric stream resolves to `stockprofits` and its
  registered canonical path, never ASK.
- [ ] `ASK项目进度` and `ASK项目频道` resolve to ASK only after their own numeric
  IDs are mapped.
- [ ] A brand-new stream prompts for association and cannot run terminal/file/
  delegate/HCO dispatch tools before confirmation.
- [ ] `/codex route none` makes that stream generic and chat-only; route show and
  unset behave deterministically.
- [ ] A renamed mapped stream retains its route by numeric ID.
- [ ] Similar/whitespace names only suggest; they do not auto-map.
- [ ] Same stream/topic produces the same Codex session ID on two dispatches;
  another topic and another stream produce different IDs.
- [ ] Concurrent messages in two mapped streams use their own cwd. Kill/restart
  during a dispatch does not create a cross-project resume.
- [ ] Runner/plugin outage blocks scoped Zulip project tools with a useful
  response. Feishu and native Hermes still behave as before.
- [ ] Audit/log inspection contains stream ID, route key, project ID, outcome,
  and sanitized reason, but no token or prompt secret.

### Task 7.4: Rollback drill and handoff

- [ ] Verify rollback order: remove `zulip` from required platforms, restart,
  then disable/remove plugin, then roll back HCO if required. State backups are
  retained.
- [ ] State clearly that emergency rollback restores unsafe legacy behavior and
  must not be represented as protected operation.
- [ ] Update `.planning/.../task_plan.md`, `findings.md`, and `progress.md` with
  final evidence, review verdicts, installation paths, process health, and any
  residual risks.

## Definition of done

- Both plan reviewers and both implementation reviewers report zero open
  Critical/High findings.
- All HCO and affected Hermes verification commands pass from the reviewed
  worktrees.
- Live acceptance proves route isolation, generic/unknown blocking, same-topic
  Codex continuity, concurrency isolation, and non-Zulip compatibility.
- Jarvis is running the reviewed artifacts and configuration; secrets are not
  present in repository diffs or review documents.
- The ADR remains `proposed` until the project owner explicitly accepts it.
