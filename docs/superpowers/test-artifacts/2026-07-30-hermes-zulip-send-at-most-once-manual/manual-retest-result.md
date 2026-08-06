# Hermes v0.19 PC-03 Zulip at-most-once 人工复测结果

- 执行时间：2026-07-30 13:46-14:10 CST
- 频道：`量化交易stockProfits`（stream 5）
- 话题：`hermes-v019-pc03-send-once-20260730-134602`
- 客户端：已登录 Boss 的 Chrome Web，单标签
- 总体结论：**FAIL**

## 结论

本轮严格遵守“只重新执行一次 PC-03”。Boss 通过 Zulip Web UI 发送唯一请求 `715`，API rendered HTML 确认 `@Jarvis PM` 是真实 `user-mention`。

模型供应商连续 3 次返回 HTTP 502，请求在生成选择框前失败。因此 PC-03 的双标签 A/B 竞态步骤为 **NOT RUN / BLOCKED**：页面没有 prompt 或按钮，未创建第二标签，也未发送第二条正式请求。

修复目标中的失败告警 at-most-once 子项明确 **FAIL**。Zulip API 返回两条独立消息 `716/717`，两者 sender、Unix timestamp、原文和 rendered HTML 完全相同。它们不是前端重复渲染。Gateway 日志仅有一次 `response ready` 和一次 `[Zulip] Sending response`，但 Zulip 最终持久化了两条失败告警，仍违反“供应商失败时只能有一条失败告警”的验收要求。

## 操作与消息证据

1. Boss 请求 `715`：`2026-07-30T05:47:16Z`。
2. Gateway session：`20260730_134716_7072c567`；只有 1 条 `agent.turn_context`。
3. 供应商尝试 3 次，均为 HTTP 502；没有调用 clarify，没有生成 zform prompt。
4. Jarvis 告警 `716/717`：均为 `2026-07-30T05:48:19Z`，内容相同。
5. 页面截图和 Zulip API 均显示两条告警。
6. 没有第二条正式请求，没有双标签点击，不存在 clarify winner/loser、stale 提示或 prompt 删除可供本轮核验。

## 服务端审计

- Gateway inbound：1。
- session `20260730_134716_7072c567` 的 `agent.turn_context`：1。
- provider attempt failure：3。
- clarify intercept：0。
- `tool clarify completed`：0。
- `response ready`：1。
- Zulip send 日志：1。
- HCO `work_requests`：0。
- HCO `codex_calls`：0。
- HCO `inbound_intents`：0。

日志证明没有第二次 Agent/Codex 工作，也没有进入 PC-03 选择结算；但这不能抵消 Zulip API 中确实存在的两条失败告警。

## Android

**NOT RUN / BLOCKED**。当前环境仍没有 Android 设备、模拟器或 `adb`。未使用移动网页冒充 Zulip Android App。

## 证据文件

- `zulip-api-evidence.json`：消息 `715-717` 的原文、rendered HTML、sender 和 UTC 时间。
- `server-audit-evidence.json`：Gateway、Agent 和 HCO 计数及判定。
- `pc03-send-once-provider-failure-20260730-134602_2026-07-30T06-07-11-177Z.png`：最终页面截图。
- `zulip-chrome-mcp-operation-guide-addendum.md`：本轮新增的可复用操作经验。

证据不包含 Zulip API key、Authorization header、MCP session ID、cookie、按钮 token、供应商 URL 或完整原始日志。
