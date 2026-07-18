# App Server Availability Remediation Design

Date: 2026-07-17
Status: Approved as the robust Option C repair

## Problem

HCO can remain alive and accept a correctly routed Zulip request while its
Codex App Server child is unavailable. The installed Codex executable is a Node
wrapper, but the LaunchAgent does not provide the directory containing `node`.
The installer tested a different interactive environment, the live activation
gate checked only the bridge socket, and the plugin returned the resulting
internal JSON directly to the operator.

## Design

1. The installer derives a minimal LaunchAgent environment from the selected
   absolute Node executable: `PATH=<node directory>:/usr/bin:/bin:/usr/sbin:/sbin`
   plus the target user's absolute `HOME`. The App Server canary runs with that
   exact environment instead of inheriting the installer shell.
2. Activation succeeds only when the newly launched HCO reports both bridge
   protocol health and App Server readiness. A process that can route but
   cannot execute is unhealthy and causes transactional rollback.
3. HCO owns a reconnect supervisor. Initial failure or later terminal loss
   immediately disables execution, closes the failed client, and retries with
   bounded exponential backoff and one in-flight attempt. Successful initialize
   atomically installs the new backend and re-enables execution. Shutdown
   cancels timers and prevents new children.
4. Diagnostics expose only stable codes, attempt/state metadata, and bounded
   sanitized detail. Child stderr, environment values, credentials, prompts,
   and arbitrary exception text are never returned through the bridge.
5. Plugin command outcomes are rendered into concise Chinese status text.
   `backend_unavailable` states that the trusted project was recognized but the
   Codex task did not start. Accepted results include the objective identifier.
6. Natural-language and explicit route/status queries are handled
   deterministically with zero model calls. Project identity comes only from
   the fresh signed numeric-stream snapshot; canonical cwd comes only from the
   HCO registry. Missing or stale authority fails closed and asks the operator
   to retry, never to infer from channel names or conversation memory.

## Installer rollback boundary

- App Server activation receives a 40-second readiness window, longer than the
  normal 8-second bridge protocol probe. This covers a healthy Codex cold start
  without weakening the runtime client's bounded 30-second initialize deadline.
- Release migrations and ordinary file snapshots are restored independently.
  One failed migration or snapshot restoration is recorded but does not stop
  attempts to restore the remaining transaction state.
- Every restored non-socket snapshot is verified before any prior service is
  restarted. When all restoration evidence is valid, HCO, Gateway, and delivery
  return to their captured pre-transaction state.
- If any restoration or verification evidence is incomplete, the installer
  does not start services on mixed state. It stops the affected HCO, delivery,
  and Gateway services, emits a bounded aggregate error, and requires manual
  restoration.
- Python runtime caches may contain owner-controlled regular `.pyc` files
  directly below `__pycache__`; nested directories, symlinks, special files,
  and group/other-writable cache paths fail closed before service mutation.

## Common cases

- Missing Node/Codex binary, child exit during initialization, invalid
  initialize response, and post-start transport loss all disable dispatch and
  enter bounded retry.
- Repeated inbound messages during outage receive a clear non-execution reply;
  they do not create phantom threads and are not silently replayed.
- A restored backend accepts subsequent new requests. An earlier failed
  objective remains failed for auditability.
- ASK and stockprofits remain separate numeric-stream routes. No fallback cwd,
  project-name guess, topic-name guess, or model output can cross that boundary.

## Verification

Tests must first fail for the missing behavior, then pass for: generated
LaunchAgent environment, canary equivalence, activation health gating,
disconnect/reconnect gate transitions, retry bounds and shutdown cancellation,
diagnostic redaction, human-readable plugin outcomes, and deterministic route
queries. Final verification includes the complete Node, Python, installer, and
repository suites plus a live Jarvis reinstall and process/route smoke test.
