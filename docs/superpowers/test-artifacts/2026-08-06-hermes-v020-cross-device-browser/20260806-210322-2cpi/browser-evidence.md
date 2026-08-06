# Browser evidence

## Environment

- Browser host: `FLYFOX`
- OS: Microsoft Windows 11 Home China, version `10.0.26200`
- Chrome: `150.0.7871.187`
- Codex CLI: `0.146.0-alpha.3.1`
- Browser driver: approved `ChromeMcpServer 1.0.0` connection to the existing Chrome session
- Zulip user visible in the dedicated window: `boss`
- Starting layout: one dedicated Chrome window containing one logged-in Zulip tab

## Formal UI action

- Case: `INGRESS-01`
- RUN_ID: `20260806-210322-2cpi`
- Stream: `量化交易stockProfits` (stream ID `5`)
- Topic: `hermes-v020-browser-INGRESS-01-20260806-210322-2cpi`
- Source message ID: `739`
- Sent at: `2026-08-06T21:17:52+08:00`
- Narrow URL: `https://zulip.dounetwork.duckdns.org:8443/#narrow/channel/5/topic/hermes-v020-browser-INGRESS-01-20260806-210322-2cpi/with/739`

The composer first received `@Jar`. Zulip displayed its native user candidate list, and `Jarvis PM` was selected from that list. The composer was read back before sending and contained the native mention markup, the intended stream, the intended topic, and the complete text:

```text
@**Jarvis PM** 请检查现在框架的安装情况、当前版本和下一步工作。只做只读检查。测试标识：20260806-210322-2cpi
```

Enter was pressed exactly once in `#compose-textarea`. The page displayed the Boss message as message `739`. No retry or second formal message was sent.

## Observed result

- At the final browser/API evidence point, more than 180 seconds after sending, the topic still contained only Boss message `739` from this run.
- No Jarvis reply appeared.
- Screenshot: `INGRESS-01-final-20260806-210322-2cpi.png`
- The dedicated Zulip tab was left open to preserve the failure scene.
- No temporary second tab was needed for this case. Earlier accidentally created temporary tabs were closed immediately without sending messages; no user-owned tab was closed.

