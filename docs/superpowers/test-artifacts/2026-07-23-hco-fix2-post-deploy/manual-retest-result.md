# HCO Fix2 部署后人工复测结果

## 执行信息

- 执行日期：2026-07-23（Asia/Shanghai）
- RUN_ID：`HCO-FIX2-POSTDEPLOY-20260723-112358`
- topic：`hco-fix2-postdeploy-20260723-112358`
- 浏览器身份：已登录的授权人工用户 `boss`
- 发送方式：Chrome MCP 驱动 Zulip Web UI；Zulip API 仅用于发送后只读回查
- mention 方式：每条正式消息均使用 `@**Jarvis PM**`
- 执行前 objective 数量：`14`
- 执行后 objective 数量：`14`
- 本 RUN_ID 新增 objective：`0`
- 本 RUN_ID 新增 submission：`0`
- N-01：未执行（可选负对照）

## 结果摘要

| 用例 | stream | 入站 ID | 回复 ID | 结果 | 关键结论 |
|---|---|---:|---:|---|---|
| P-00 | `量化交易stockProfits`（5） | 512 | 513 | PASS | 真实 mention、Gateway inbound 和 Jarvis 回复均确认 |
| G-01 | `沙箱`（2） | 514 | 515 | FAIL | 返回“频道尚未登记项目”，未返回 `ROUTE_HERMES_OWNED` |
| G-05 | `量化交易stockProfits`（5） | 516 | 517 | PASS | 返回稳定单行 `Objective does not exist.`，无 protocol error、无状态变更 |
| G-06 | `量化交易stockProfits`（5） | 518 | 519 | BLOCKED | 回复安全且单行，但没有回显待验证标识符，无法做标识符保真断言 |

整轮判定：`FAIL`。P-00 证明部署后的 Zulip 入站链路已恢复，G-05 证明正常项目的不存在 objective 路径可用；但 G-01 的 Hermes-owned 路由行为不符合验收要求，因此 Fix2 不能按本轮结果关闭。

## P-00：Gateway 入站烟雾测试

- stream/topic：`量化交易stockProfits`（stream ID `5`）/`hco-fix2-postdeploy-20260723-112358`
- 入站/回复 message ID：`512` / `513`
- mention：PASS。原文使用 `@**Jarvis PM**`；渲染 HTML 包含 `class="user-mention"` 和 `data-user-id="9"`。
- Gateway：PASS。`gateway.log` 在 `2026-07-23 11:28:16 +0800` 记录对应 `inbound message: platform=zulip`，并在 4.0 秒后记录回复发送。
- HCO：本用例是普通对话烟雾测试，不进入 `/codex` 命令持久化路径；`inbound_intents` 无 source ID `512`。
- objective 数量：`14 -> 14`，变化 `0`。
- raw content：`@**Jarvis PM** 请只回复：HCO-FIX2-POSTDEPLOY-20260723-112358-P00`
- rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> 请只回复：HCO-FIX2-POSTDEPLOY-20260723-112358-P00</p>`
- 回复 raw content：`HCO-FIX2-POSTDEPLOY-20260723-112358-P00`
- 回复 rendered HTML：`<p>HCO-FIX2-POSTDEPLOY-20260723-112358-P00</p>`
- 结果：`PASS`

## G-01：Hermes-owned stream 路由拒绝

- stream/topic：`沙箱`（stream ID `2`）/`hco-fix2-postdeploy-20260723-112358`
- 入站/回复 message ID：`514` / `515`
- mention：PASS，渲染 HTML 包含真实 `user-mention`。
- Gateway：有回复发送记录，但没有对应的通用 `inbound message` 日志行。
- HCO source message ID：`inbound_intents` 和 `event_journal` 均无 `514`。部署路由快照中 stream `2` 未显式列出，虽 `defaultOwner=HERMES`，插件仍在 HCO 调用前把命令改写为未登记频道提示。
- objective 数量：`14 -> 14`，本 RUN_ID objective/submission 均为 `0`。
- raw content：`@**Jarvis PM** /codex run HCO-FIX2-POSTDEPLOY-20260723-112358-G01 no-op`
- rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> /codex run HCO-FIX2-POSTDEPLOY-20260723-112358-G01 no-op</p>`
- 回复 raw content：`当前频道尚未登记 Codex 项目。请确认：1）projectId；2）canonical 绝对工作目录；3）是否将当前数字 stream 登记到该项目；4）新建 objective，还是继续已有 objective（继续时请提供 objectiveId）。如果没有 Codex thread，会在首次执行时自动创建；无法确认旧 thread 已丢失时，不会自动重建，以免重复执行。`
- 回复 rendered HTML：与上述单段文本对应的单个 `<p>`，未包含秘密、内部路径、堆栈或 protocol error。
- 预期差异：应返回 `ROUTE_HERMES_OWNED` 用户错误，实际走入 `REGISTRATION_TEXT` 分支。
- 结果：`FAIL`

## G-05：正常项目频道只读状态查询

- stream/topic：`量化交易stockProfits`（stream ID `5`）/`hco-fix2-postdeploy-20260723-112358`
- 入站/回复 message ID：`516` / `517`
- mention：PASS，渲染 HTML 包含真实 `user-mention`。
- Gateway：`2026-07-23 11:43:02 +0800` 有向正确 stream/topic 发送 25 字符回复的记录；命令钩子路径没有通用 inbound 日志行。
- HCO source message ID：回复是 HCO `OBJECTIVE_NOT_FOUND` 的稳定用户消息，证明请求到达 HCO；该错误在 objective 查找阶段抛出，因此 `inbound_intents` 和 `event_journal` 没有 source ID `516` 的持久行。
- objective 数量：`14 -> 14`；本 RUN_ID objective/submission 均为 `0`。
- raw content：`@**Jarvis PM** /codex status HCO-FIX2-POSTDEPLOY-20260723-112358-G05-does-not-exist`
- rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> /codex status HCO-FIX2-POSTDEPLOY-20260723-112358-G05-does-not-exist</p>`
- 回复 raw content：`Objective does not exist.`
- 回复 rendered HTML：`<p>Objective does not exist.</p>`
- 安全检查：单行、无链接、无 mention、无内部路径、无 bearer/HMAC/API key、无 `Codex bridge protocol error.`。
- 结果：`PASS`

## G-06：正常标识符与 Markdown 防护

- stream/topic：`量化交易stockProfits`（stream ID `5`）/`hco-fix2-postdeploy-20260723-112358`
- 入站/回复 message ID：`518` / `519`
- mention：PASS，渲染 HTML 包含真实 `user-mention`。
- Gateway：`2026-07-23 11:43:42 +0800` 有向正确 stream/topic 发送 25 字符回复的记录；命令钩子路径没有通用 inbound 日志行。
- HCO source message ID：同 G-05，HCO 返回稳定 `OBJECTIVE_NOT_FOUND`，但错误发生在持久化 inbound intent 之前；数据库无 source ID `518`。
- objective 数量：`14 -> 14`；本 RUN_ID objective/submission 均为 `0`。
- raw content：`@**Jarvis PM** /codex status obj-1-LIVE-POSTFIX.S-001-does-not-exist`
- rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> /codex status obj-1-LIVE-POSTFIX.S-001-does-not-exist</p>`
- 回复 raw content：`Objective does not exist.`
- 回复 rendered HTML：`<p>Objective does not exist.</p>`
- 已通过断言：回复单行，无异常链接、强调、反斜杠、mention、内部信息或 protocol error。
- 未能验证：回复没有包含 `obj-1` 或 `LIVE-POSTFIX.S-001`，无法在真实回复上证明这两个标识符被原样保留。
- 结果：`BLOCKED`

## 服务与状态证据

- HCO PID `62301`，启动时间 `2026-07-23 10:45:27 +0800`。
- Hermes Gateway PID `62375`，启动时间 `2026-07-23 10:45:32 +0800`。
- delivery sidecar PID `62468`，启动时间 `2026-07-23 10:45:37 +0800`。
- route snapshot generation：`14`；stream `5` 静态映射到 `stockprofits`；stream `2` 无显式 route，快照默认 owner 为 `HERMES`。
- 数据库最终计数：objective `14`、本 RUN_ID objective `0`、本 RUN_ID submission `0`、source ID `512/514/516/518` 对应 `inbound_intents` `0` 行、`event_journal` `0` 行。
- 本轮没有重启服务，没有修改 route snapshot、topic mode、ACL 或项目映射，没有创建、取消或清理生产 objective。

## 后续处理建议

1. 修复插件对 route snapshot `defaultOwner=HERMES` 的处理：未显式列出的 stream 不应被当成“未登记项目”，G-01 应进入 HCO 并返回 `ROUTE_HERMES_OWNED`。
2. 为被插件命令钩子截获的 `/codex` 消息补充带 source message ID 的脱敏 inbound 日志或审计记录，便于严格证明 Gateway/HCO 收到的消息绑定。
3. 若 G-06 必须验证真实回复中的标识符保真，应选择一个会在用户错误中安全回显测试标识符的无副作用路径；当前 `OBJECTIVE_NOT_FOUND` 文案不包含 objective ID。

本文不包含 API key、cookie、bearer、HMAC、MCP session ID 或完整环境配置。
