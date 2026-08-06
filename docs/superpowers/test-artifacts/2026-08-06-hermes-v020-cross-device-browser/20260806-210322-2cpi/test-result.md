# Hermes v0.20 cross-device browser manual acceptance result

- Plan: `docs/superpowers/plans/2026-08-06-hermes-v020-cross-device-browser-manual-acceptance.md`
- Execution date: 2026-08-06 (Asia/Shanghai)
- RUN_ID: `20260806-210322-2cpi`
- Blocking-scope conclusion: **FAIL**
- Stop reason: `INGRESS-01` failed. The positive request was rejected by the Gateway authorization check and received no Jarvis reply within 180 seconds. Per the plan, the same request was not resent and subsequent blocking cases were not started.

## Case results

| Case | Expected | Actual | Status |
|---|---|---|---|
| INGRESS-01 | One website-originated Boss message, one accepted inbound, `gpt-5.6-sol`, and one final Jarvis reply within 180 seconds | Boss message `739` was stored once with a native Jarvis mention. Gateway logged `Unauthorized user: user8@zulip.dounetwork.duckdns.org (boss) on zulip`. No HCO business record and no Jarvis reply existed at the final API check. The provider/model was not invoked. | **FAIL** |
| PC-00 | Default-recipient and native-mention cases pass | Not started after blocking case failure | **NOT RUN** |
| PC-01/02 | Native three-option prompt and single consumption pass | Not started after blocking case failure | **NOT RUN** |
| PC-03 | Two-tab atomic selection accepts one winner only | Not started after blocking case failure | **NOT RUN** |
| PC-04 | Cancel consumes the prompt once without continuing work | Not started after blocking case failure | **NOT RUN** |
| PC-05 to PC-07 | Extended desktop interaction cases pass | Outside this stopped run | **NOT RUN** |
| COORD-01 to COORD-06 | Extended coordination cases pass | Outside this stopped run | **NOT RUN** |
| Android | Real App/device display and click pass | No Android device, emulator, or controllable App was available in this environment | **BLOCKED** |
| NET-02 | Restart-window case passes | No maintenance-window restart was authorized or performed | **NOT RUN** |

## INGRESS-01 details

```text
case_id: INGRESS-01
run_id: 20260806-210322-2cpi
started_at: 2026-08-06T21:17:52+08:00
final_api_check_at: 2026-08-06T21:52:11+08:00
browser_host/browser_version/codex_version: FLYFOX / Chrome 150.0.7871.187 / codex-cli 0.146.0-alpha.3.1
zulip_stream/topic: 量化交易stockProfits / hermes-v020-browser-INGRESS-01-20260806-210322-2cpi
source_message_id: 739
prompt_message_id: null
reply_message_ids: []
work_request_id: null
objective_id: null
expected: One accepted inbound and one Jarvis final reply within 180 seconds using gpt-5.6-sol.
actual: Website message stored once; Gateway rejected boss as unauthorized; no HCO business records; no provider call; no Jarvis reply.
evidence_files: browser-evidence.md, zulip-api-evidence.json, server-audit-evidence.json, INGRESS-01-final-20260806-210322-2cpi.png
status: FAIL
```

## Safety and evidence boundaries

- The formal request was sent once through the logged-in Zulip Web UI by pressing Enter once.
- The request was not resent after timeout or failure.
- No project write, database write, service restart, message deletion, or bot-API send was performed.
- Evidence is sanitized and contains no API key, cookie, Authorization header, MCP session ID, provider URL, button token, or complete log.

