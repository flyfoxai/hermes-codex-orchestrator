# Browser evidence

## Environment

- browser host: Windows 11 Home Chinese, version `10.0.26200`
- Chrome: `150.0.7871.187`
- Codex desktop: `26.730.7989.0`
- browser driver: approved Chrome MCP connected to the already logged-in dedicated Chrome window
- Zulip user: `boss`
- stream/topic: `量化交易stockProfits` / `hermes-v020-browser-INGRESS-01-20260807-010234-iyr8`
- final narrow URL: `https://zulip.dounetwork.duckdns.org:8443/#narrow/channel/5/topic/hermes-v020-browser-INGRESS-01-20260807-010234-iyr8/with/740`

The MCP session identifier is intentionally omitted from evidence.

## Operation record

1. Used the dedicated Chrome window and its existing logged-in Zulip tab.
2. Opened stream 5 and the unique INGRESS-01 topic.
3. Entered `@`, triggered Zulip's candidate list, navigated to `Jarvis PM`, and selected it from the list.
4. Confirmed the compose field contained the native `@**Jarvis PM**` mention plus the exact test text.
5. Pressed Enter once at approximately `2026-08-07T01:38:53+08:00`.
6. Confirmed Boss message `740` appeared in the message pane.
7. Observed Jarvis message `741` at `2026-08-07T01:39:45+08:00`.
8. Did not resend after the incomplete result. A later Zulip API readback at `2026-08-07T01:48:13+08:00` confirmed the topic still contained only messages `740` and `741`.

## Native mention proof

The candidate-list screenshots show Jarvis PM highlighted and selected. Zulip API rendered HTML for message `740` contains:

```html
<span class="user-mention" data-user-id="9">@Jarvis PM</span>
```

This proves the formal message used a native mention rather than plain `@Jarvis PM` text.

## Reusable Chrome MCP operation notes

On this Chrome/MCP combination, sending `@` as a direct keyboard key was unreliable. The repeatable sequence was:

1. Fill the compose field with `@`.
2. Click the compose field.
3. Send `J` to trigger the candidate menu. In this run the key opened the list even though it did not insert a visible `J`.
4. The candidates appeared as `all`, `topic`, `boss`, and `Jarvis PM`.
5. Send ArrowDown three times and capture a screenshot confirming `Jarvis PM` is highlighted.
6. Click the highlighted fourth candidate and confirm the compose field renders `@**Jarvis PM**`.
7. Fill the remaining message, reread the topic and compose content, then press Enter exactly once.

Clicking the fourth candidate before moving the keyboard highlight selected the currently highlighted `all` entry, so the highlight confirmation is required for future runs.

## Screenshots

- `v020-jarvis-candidate-highlight.png`: Jarvis PM highlighted in the live candidate list.
- `v020-jarvis-candidate-selected.png`: native Jarvis PM mention inserted.
- `v020-ingress-compose-before-send.png`: final exact compose content before the single Enter.
- `v020-ingress-after-single-enter.png`: Boss message visible after send.
- `v020-ingress-final-reply.png`: Jarvis acknowledgement/progress reply visible.

No cookies, credentials, local storage, network trace, authorization headers, API keys, or button signature tokens were captured.
