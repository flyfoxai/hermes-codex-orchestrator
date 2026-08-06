# Hermes v0.19.0 交互功能人工测试结果

## 测试信息

- 执行时间：2026-07-27 20:22-20:28（Asia/Shanghai）
- 测试方案：`docs/HERMES_V019_INTERACTION_MANUAL_TEST.md`
- 客户端：Chrome 150.0.0.0 / Windows 10 x64
- Zulip：Web，授权用户 `boss`
- 频道：`量化交易stockProfits`（stream ID `5`）
- 话题：`hermes-v019-interaction-20260727-2021`
- 浏览器控制：`http://127.0.0.1:12306/mcp`
- 测试标签：window ID `1777373921`，tab ID `1777373920`
- 测试 URL：`https://zulip.dounetwork.duckdns.org:8443/#narrow/channel/5/topic/hermes-v019-interaction-20260727-2021/with/632`

正式消息均由已登录的 Zulip Web UI 发送。API 仅用于发送后的只读回查；API 凭据未写入证据。

## 结论

本轮不满足 v0.19.0 完整通过标准。

| 用例 | 结果 | 依据 |
| --- | --- | --- |
| PC-01 | FAIL | 请求消息 `632` 的 mention 有效；Jarvis 回复 `633` 未生成三个原生按钮，只说明 `user_response` 为空。等待约 40 秒无后续按钮消息。 |
| PC-02 | BLOCKED | PC-01 没有按钮，无法合法执行“选项 A”单击及验证按钮删除。 |
| PC-03 | BLOCKED | PC-01 没有 interaction/button，不能构造有效的双标签竞态和重放；未伪造 interaction ID。 |
| PC-04 | BLOCKED | PC-01 没有“取消”按钮，无法执行。 |
| PC-05 | PASS | 请求 `634` 被识别为 status；回复 `635` 没有 `Invalid /codex command`，任务 ID 未包含尾随中文，且返回 objective、项目、状态、后端和会话信息。 |
| PC-06 | BLOCKED（行为部分符合） | 回复 `635` 未机械返回过期 `running`，而是返回 `reconciliation_needed` 并明确本地缓存不能代表真实执行状态；但 App Server 当时不可确认，因此没有取得方案要求的真实后端终态，不能判为完整通过。 |
| PC-07 | BLOCKED | 本轮没有生成未处理 interaction，无法执行有效的跨话题绑定校验。 |
| Android | NOT RUN | 当前仅控制 PC Chrome；未持有 Android Zulip App、Android 版本和设备信息。 |
| NET-01 | NOT RUN | 未执行断网操作，避免影响用户其他 Chrome 窗口和会话。 |
| NET-02 | NOT RUN | 仅应在维护窗口执行；本轮未获授权重启 Gateway/HCO/delivery。 |

## PC-01 证据

请求：

- message ID：`632`
- 时间：`2026-07-27T20:22:29+08:00`
- sender：`boss`
- 原文：`@**Jarvis PM** 我需要收集一个测试选择。请让我在“选项 A”“选项 B”“取消”三个选项中选择；这只是交互测试，不执行项目操作。`
- rendered HTML 包含：`<span class="user-mention" data-user-id="9">@Jarvis PM</span>`

回复：

- message ID：`633`
- 时间：`2026-07-27T20:22:52+08:00`
- sender：`Jarvis PM`
- 原文：`已收到交互测试请求，但本次没有返回具体选择值（\`user_response\` 为空）。未执行任何项目操作。`
- 页面与 API 均未发现“选项 A”“选项 B”“取消”三个原生按钮。

复现步骤：在上述 topic 的 Web compose 中发送请求原文，等待 Jarvis 回复并继续观察约 40 秒。实际只出现消息 `633`。

## PC-05 / PC-06 证据

请求：

- message ID：`634`
- 时间：`2026-07-27T20:27:40+08:00`
- sender：`boss`
- 原文：

```text
@**Jarvis PM** /codex status objective-19d1b9fe-2a7e-44a6-8ee2-2e8cbef82cae
查询实际进度，并说明是否正在等待输入。
```

- rendered HTML 包含真实 `user-mention`，并用 `<br>` 分隔尾随说明。

回复：

- message ID：`635`
- 时间：`2026-07-27T20:27:40+08:00`
- sender：`Jarvis PM`
- 原文：`任务：objective-19d1b9fe-2a7e-44a6-8ee2-2e8cbef82cae。项目：stockprofits。状态：reconciliation_needed。后端：app-server。会话：019fa15c-6cd6-72c2-932c-8698289a3684。当前无法向执行后端确认真实状态；以上仅为本地缓存，不能据此判断任务仍在执行。请检查 App Server 连接或稍后重试。`

等待 25 秒后没有新增回复。PC-05 的命令解析通过；PC-06 因无法取得 App Server 真实终态而保守记为阻塞，而不是把降级状态误判为通过。

## 证据与剩余风险

- 完整 API 原文与 rendered HTML：同目录 `zulip-api-evidence.json`
- 没有截取截图：当前 MCP 的截图接口不支持 URL 定向，多窗口下可能截到非测试窗口；使用 URL 定向 DOM 证据和 Zulip API 回读替代，并明确保留此证据缺口。
- 未检查服务端 interaction/objective/submission/outbox 数据库与日志：执行端在另一主机，当前回话只能确认 Zulip 可见结果与 API 记录。
- 下一轮优先修复或确认 PC-01 native choice 生成链路；只有生成真实 interaction 后，PC-02/03/04/07 才有有效测试前置条件。
