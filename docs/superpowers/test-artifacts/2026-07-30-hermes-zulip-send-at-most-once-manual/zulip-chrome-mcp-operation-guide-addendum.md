# Zulip Chrome MCP 操作经验补充：选择框生成前失败

本文补充 `2026-07-30-hermes-v019-interaction-atomic-manual/zulip-chrome-mcp-operation-guide.md`。

## PC-03 前置条件

双标签竞态必须等到同一 prompt 的实际 A/B 按钮已经出现后再创建第二标签。请求文本包含“选项 A/B”不代表按钮已经生成；应使用交互元素查询确认实际 `button`、enabled 状态和坐标。

如果 Jarvis 在 prompt 生成前返回供应商失败告警：

1. 不创建第二标签，不点击请求文本，也不伪造 `clarify_id` 或 action。
2. 不自动重发正式请求。测试要求“只执行一次”时，供应商失败就是本轮真实结果。
3. 同时用页面和 Zulip API 回查告警。页面出现两次可能是渲染问题；只有两个独立 message ID 才能证明重复持久化。
4. 分开记录两个结论：失败告警 at-most-once 是否通过，以及 PC-03 双标签竞态是否实际执行。
5. 即使 Gateway 只有一次 send 日志，API 中存在两个独立消息仍应判重复投递 FAIL；单次业务日志只能证明没有第二次 Agent/HCO 工作。

## 最小取证集合

- 正式请求 ID、真实 mention 的 rendered HTML。
- 所有告警 ID、sender、Unix timestamp、原文和 rendered HTML。
- Gateway inbound、`agent.turn_context`、provider attempts、`response ready`、Zulip send 计数。
- clarify intercept/completion 计数；没有 prompt 时两者应为 0。
- HCO work/call/inbound intent 计数。
- 最终页面截图和 SHA-256。

证据中不要保存 API key、Authorization header、cookie、MCP session ID、供应商 URL、完整原始日志或按钮签名 token。
