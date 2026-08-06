# Hermes v0.20 cross-device browser acceptance result

## Run metadata

- case: `INGRESS-01`
- run_id: `20260807-010234-iyr8`
- started_at: `2026-08-07T01:38:53+08:00`
- final_readback_at: `2026-08-07T01:48:13+08:00`
- stream: `量化交易stockProfits` (stream 5)
- topic: `hermes-v020-browser-INGRESS-01-20260807-010234-iyr8`
- source_message_id: `740`
- reply_message_ids: `741`
- work_request_id: `work-request-dc9a0024-fe01-47f7-9bc9-354b4c7cdc39`
- objective_id: `objective-64a869f1-b49f-4746-9c72-a8d548613efb`
- result: **FAIL**

## Expected

Within 180 seconds, the single real website message must produce one Jarvis final reply that reports the actual framework installation status, current version, and next work. The run must use `gpt-5.6-sol`, avoid provider failures, and create no duplicate Gateway, HCO, outbox, or Zulip records.

## Actual

The Boss request was sent once through the Zulip Web UI with a native Jarvis PM mention. Zulip stored source message `740`; the Gateway accepted one inbound, used `gpt-5.6-sol`, made three provider calls, dispatched HCO once, and sent one Jarvis message `741`.

Message `741` only says that a strict read-only check was submitted and is still executing. It explicitly says there is no result evidence and therefore gives no installation or version conclusion. No later message appeared by the final API readback, more than 180 seconds after the source message.

HCO contains exactly one work request, objective, Codex call, turn submission, and inbound intent. The work remains `WAITING_CODEX`; objective execution and the turn submission are both `reconciliation_needed`; the Codex call remains `RUNNING`. There is no matching HCO Zulip outbox row or pending interaction.

No matching HTTP 403, HTTP 502, provider-failure, retry, duplicate inbound, duplicate HCO work, duplicate response-ready, duplicate Zulip send, or duplicate Zulip reply was found.

## Verdict

`INGRESS-01` fails because the only Jarvis response within the acceptance window is an acknowledgement/progress message, not the required final result. The earlier authorization rejection is fixed for this run, but the downstream HCO/Codex work entered `reconciliation_needed` and never produced a completion reply.

Per the plan's blocking gate, no message was resent and `PC-00` through `PC-04` were not started.

| Case | Result | Reason |
| --- | --- | --- |
| INGRESS-01 | FAIL | No completed installation/version/next-step result within 180 seconds; HCO execution is `reconciliation_needed`. |
| PC-00 | NOT RUN | Stopped after blocking INGRESS-01 failure. |
| PC-01/02 | NOT RUN | Stopped after blocking INGRESS-01 failure. |
| PC-03 | NOT RUN | Stopped after blocking INGRESS-01 failure. |
| PC-04 | NOT RUN | Stopped after blocking INGRESS-01 failure. |
| PC-05 to PC-07 | NOT RUN | Extended desktop scope was not entered. |
| COORD-01 to COORD-06 | NOT RUN | Extended coordination scope was not entered. |
| Android | BLOCKED | A real Android device or controllable emulator was not available, and desktop Chrome was not used as a substitute. |

## Evidence files

- `browser-evidence.md`
- `zulip-api-evidence.json`
- `server-audit-evidence.json`
- `v020-jarvis-candidate-highlight.png`
- `v020-jarvis-candidate-selected.png`
- `v020-ingress-compose-before-send.png`
- `v020-ingress-after-single-enter.png`
- `v020-ingress-final-reply.png`
