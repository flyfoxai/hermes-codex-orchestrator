# Hermes v0.19.0 真实链路人工复测结果

## 执行信息

- 执行时间：2026-07-30 16:44-16:54 CST
- 浏览器：Google Chrome 150.0.7871.187，已登录 `boss` 用户
- Zulip 频道：stream ID `5`，`量化交易stockProfits`
- 唯一话题：`hermes-v019-terminal-error-single-send-20260730-164133`
- 正式请求：仅通过 Zulip Web UI 发送一次，没有重发
- 请求正文：`@**Jarvis PM** 我需要收集一个测试选择。请让我在“选项 A”“选项 B”“取消”三个选项中选择；这只是交互测试，不执行项目操作。`

## 结论

| 检查项 | 结果 | 说明 |
|---|---|---|
| 真实 502 终态单告警 | NOT EXERCISED | 本次供应商正常返回选择框并完成续跑，没有出现 502 或失败告警。按要求未重发，不能把该项误判为通过。 |
| PC-01 三选一按钮生成 | PASS | Jarvis 生成原生 zform 选择框，消息 ID `719`，按钮为“选项 A”“选项 B”“取消”。 |
| PC-03 双标签竞态 | PASS | 两次点击约相隔 1 秒；A 首次生效，B 收到固定 stale 提示；仅一次正常确认。 |
| 原按钮删除 | PASS | 稳定 API 列表中已无 `719`；单独 GET `719` 返回 HTTP 400 `Invalid message(s)`。 |
| 第二次 Agent/Codex 工作 | PASS | 仅 1 次 `agent.turn_context` 和 1 次正常 response send；HCO work/call/intent 相关计数均为 0。 |
| Android 真机 | NOT RUN / BLOCKED | 当前环境没有 Android 设备、模拟器或 adb。 |

## Zulip 消息证据

1. `718`，2026-07-30T08:45:21Z，Boss 正式请求。API rendered HTML 含真实 `user-mention`，证明 `Jarvis PM` mention 有效。
2. `719`，2026-07-30T08:45:33Z，Jarvis 原生选择框。点击后删除。
3. `720`，2026-07-30T08:53:14Z，Boss 选择 A，标记 `[hermes-clarify:9071d0e5d1:1]`。
4. `721`，2026-07-30T08:53:15Z，Boss 选择 B，标记 `[hermes-clarify:9071d0e5d1:2]`。
5. `722`，2026-07-30T08:53:15Z，Jarvis 固定 stale 提示，明确首次选择 A 继续有效。
6. `723`，2026-07-30T08:53:20Z，Jarvis 唯一正常确认：已收到选项 A。

两条 Boss 点击回复使用相同 `clarify_id=9071d0e5d1`、不同选项序号 `1/2`。最终稳定回查共 5 条可见消息，没有第二条普通确认或失败告警。

## 服务端审计

- topic inbound：`1`
- 对应 Hermes session 的 `agent.turn_context`：`1`
- clarify response intercept：`2`
- response ready：`1`
- Zulip 正常 response send：`1`
- HCO `work_requests` / `codex_calls` / `inbound_intents` / `execution_topic_intents` 相关计数：全部 `0`
- Gateway PID `85264` 在复测结束时仍存活。

## 文件

- `zulip-api-evidence.json`：API rendered HTML、时间和删除探测
- `server-audit-evidence.json`：服务端日志计数、关键日志和 HCO 只读查询
- `pre-send.png`：发送前 compose 与真实 mention 文本
- `pc03-prompt.png`：选择框及三个按钮
- `pc03-result.png`：两个 Boss 回复、stale 提示和唯一正常确认
- `browser-operation-notes.md`：可复用的 Chrome MCP / Zulip 操作经验

本次未读取或保存 cookie、API key、Authorization header、供应商 URL或完整敏感日志；未重启服务、未修改路由、未创建项目工作。
