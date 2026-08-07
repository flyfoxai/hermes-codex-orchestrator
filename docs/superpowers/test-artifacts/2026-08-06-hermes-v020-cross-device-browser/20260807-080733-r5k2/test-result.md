# Hermes v0.20 cross-device browser acceptance result

## Run metadata

- case: `INGRESS-01`
- run_id: `20260807-080733-r5k2`
- started_at: `2026-08-07T08:20:11+08:00`
- gateway_response_at: `2026-08-07T08:20:56+08:00`
- stream: `量化交易stockProfits` (stream 5)
- topic: `hermes-v020-browser-INGRESS-01-20260807-080733-r5k2`
- source_message_id: `742`
- reply_message_id: `743`
- browser_driver: Chrome extension connected through the configured 12306 bridge

## Expected

Within 180 seconds, one native-Jarvis Zulip message must produce one final reply containing the actual framework installation status, current version, and next work. The run must use `gpt-5.6-sol`, avoid provider failures, and create no duplicate Gateway, HCO, outbox, or Zulip records.

## Actual

The request was sent exactly once through the Zulip Web UI after selecting `Jarvis PM` from the native mention candidate list. The page showed source message `742` and reply `743`.

The only reply in the acceptance window was an intermediate acknowledgement. It states that a strict read-only audit was submitted, gives `work-request-83a3dadb-de5d-4f2e-a91e-ef4de2a74613` and `objective-fffbfcc3-3382-48b7-84a4-0bd02f8f4470`, and says execution has not yet produced final command/path/exit-code evidence. It therefore does not satisfy the required installation, version, and next-step final result.

Gateway evidence shows one inbound, profile `codex-bridge`, one `response ready` after 44.9 seconds, and one Zulip send. No matching 403, 502, provider-failure, duplicate response-ready, or duplicate send was found in the inspected log window.

The inspected `codex-bridge` state database did not contain a matching session or message row for this RUN_ID; this is recorded as an evidence gap rather than treated as proof that no HCO work existed.

## Verdict

`INGRESS-01`: **FAIL**. The authorization path is working, but the downstream read-only audit did not return the required final evidence within 180 seconds.

Per the plan's blocking gate, no message was resent and `PC-00` through `PC-04` were not started. Extended desktop cases `PC-05` to `PC-07` and `COORD-01` to `COORD-06` are `NOT RUN`. Android is `BLOCKED` because no real Android device or controllable emulator is available.

## Case summary

| Case | Result | Reason |
| --- | --- | --- |
| INGRESS-01 | FAIL | Only an acknowledgement/progress reply; no completed installation/version/next-step evidence within 180 seconds. |
| PC-00 | NOT RUN | Blocking ingress gate failed. |
| PC-01/02 | NOT RUN | Blocking ingress gate failed. |
| PC-03 | NOT RUN | Blocking ingress gate failed. |
| PC-04 | NOT RUN | Blocking ingress gate failed. |
| PC-05 to PC-07 | NOT RUN | Extended scope was not entered. |
| COORD-01 to COORD-06 | NOT RUN | Extended scope was not entered. |
| Android | BLOCKED | No real device or emulator. |

## Evidence files

- `browser-evidence.md`
- `zulip-api-evidence.json`
- `server-audit-evidence.json`
