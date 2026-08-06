# Hermes v0.19 PC-03 原子去重复测结果

- 执行时间：2026-07-30 10:12-10:37 CST
- 频道：`量化交易stockProfits`（stream 5）
- 话题：`hermes-v019-pc03-atomic-20260730-100608`
- 客户端：Chrome Web，两个标签页；结束后已恢复为单标签
- 总体结论：**严格 PC-03 FAIL；原子首次结算子项 PASS**

## 结论

修复后的原子竞态保护已生效。两个标签页分别提交选项 A 和选项 B，服务端只结算一次，后到请求收到固定提示，提示包含首次选择和服务端时间。两个回答使用相同 `clarify_id=64062259af`，选项序号分别为 1 和 2；没有创建 HCO work、Codex call 或 inbound intent，也没有第二次 clarify 完成或第二次 Agent turn。

按完整人工方案仍不能判定 PC-03 通过。首次选择进入模型续跑后，模型供应商最终失败，未产生正常的选择确认；Zulip 随后出现两条内容相同的 provider failure 告警（消息 `713/714`）。Gateway 日志只有一次 `response ready` 和一次 Zulip send 记录，因此这两条消息不是第二条 HCO/Agent 工作记录，但它们仍违反“只有一条正常确认”的严格页面结果要求，需要单独排查重复投递或发送确认重试。

## 操作与消息证据

1. Boss 通过 Web UI 发送请求 `708`；API rendered HTML 确认 `@Jarvis PM` 是 `user-mention`。
2. Jarvis 生成 prompt `709`，页面显示可用按钮“选项 A / 选项 B / 取消”。点击前已截图。
3. 标签一在 `2026-07-30 10:19:37.773 CST` 点击 A；标签二在 `10:19:38.081 CST` 点击 B。
4. Zulip 创建 Boss 回复 `710` 和 `711`，时间戳均为 `10:19:38 CST`：
   - `710`: `[hermes-clarify:64062259af:1]`，选项 A。
   - `711`: `[hermes-clarify:64062259af:2]`，选项 B。
5. 服务端以选项 B 为首次写入。Jarvis 消息 `712`：
   `这个选择已由另一客户端或标签页在 2026-07-30 10:19:38 CST 先行提交（首次选择：选项 B）。首次选择继续有效，本次重复选择已忽略。`
6. `GET /api/v1/messages/709` 返回 HTTP 400 `Invalid message(s)`，确认 prompt 已删除。
7. `713/714` 是两条相同的模型供应商失败告警，时间分别为 `10:22:16/10:22:17 CST`。

浏览器本地点击先后不等于服务端写入先后。本用例以服务端记录为准，因此首次选择 B 是允许的测试结果。

## 服务端审计

- Gateway clarify intercept：2。
- session `20260730_101300_66014a3f` 的 `agent.turn_context`：1（原请求）。
- 同一 session 的 `tool clarify completed`：1。
- 同一话题的 `response ready`：1。
- 同一话题的 Zulip send 日志：1。
- HCO `work_requests`：0。
- HCO `codex_calls`：0。
- HCO `inbound_intents`：0。

日志证明失败分支没有进入第二次 Agent/Codex 工作流程。供应商失败重试属于首次选择对应的同一次模型续跑。

## Android

**NOT RUN / BLOCKED**。本机没有 `adb`，没有 Android emulator/qemu 进程，也没有可控真机。未使用移动网页冒充 Android Zulip App。

仍需使用真实 Android App 执行：按钮显示与点击、PC/Android 同框竞态、返回话题后的按钮状态，以及弱网重复点击。

## 证据文件

- `zulip-api-evidence.json`：消息 `708`、`710-714` 的原文、rendered HTML、sender 和 UTC 时间。
- `server-audit-evidence.json`：prompt 删除、Gateway 计数和 HCO 零记录计数。
- `pc03-atomic-before-click-20260730-100608_2026-07-30T02-15-20-354Z.png`：点击前按钮。
- `pc03-atomic-after-double-click-20260730-100608_2026-07-30T02-21-23-427Z.png`：固定重复选择提示。
- `pc03-atomic-final-20260730-100608_2026-07-30T02-37-17-718Z.png`：最终页面和重复告警。

证据不包含 Zulip API key、Authorization header、MCP session ID、按钮签名 token 或完整日志。
