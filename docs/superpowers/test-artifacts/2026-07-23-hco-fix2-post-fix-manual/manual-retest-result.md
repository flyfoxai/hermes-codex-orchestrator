# HCO Fix2 修复后人工复测结果

## 执行信息

- 执行时间：2026-07-23T16:44:55+0800 至 2026-07-23T17:21:51+0800
- RUN_ID：`HCO-FIX2-POSTFIX-20260723-164455`
- 计划：`docs/superpowers/plans/2026-07-23-hco-fix2-post-fix-test-plan.md`
- 代码 revision：`86642556857acddc255ecebc00ada9f3d8508392`
- 浏览器控制：Windows Chrome MCP，Streamable HTTP `http://127.0.0.1:12306/mcp`
- 授权 UI 账号：`boss`；mention 目标：`Jarvis PM`
- 工作区：执行前已有 22 个未提交条目；本轮未修改仓库代码、项目文件或生产 route
- 总体状态：`BLOCKED`。G-01A、G-05、G-06A、U-01、U-02 为 PASS；唯一剩余阻塞是 G-01B 缺少显式 HERMES 隔离 stream
- G-01A 审计关闭复测：2026-07-24 08:51:57 +08:00，RUN_ID=`G01A-AUDIT-RETEST-20260724-070422`

## 环境与路由基线

- gateway、HCO、delivery launchd 服务均存在；HCO 和 delivery 处于运行状态。
- route snapshot generation：`14`
- default owner：`HERMES`
- stream `2`（沙箱）：未显式映射，用于 G-01A。
- stream `5`（量化交易stockProfits）：显式 `PROJECT`，projectId=`stockprofits`，用于 G-05/G-06A。
- 当前 snapshot 没有显式 `HERMES` route，因此没有满足 G-01B 前置条件的隔离 stream。
- G-01A 后、G-05/G-06A 前的 HCO 只读快照：objectives=`14`、turn submissions=`13`、Zulip outbox=`11`、inbound intents=`15`。
- G-06A 完成后的 HCO 只读快照：objectives=`15`、turn submissions=`14`、Zulip outbox=`12`、inbound intents=`16`。

## 人工 Zulip 用例

统一 topic：`hco-fix2-post-fix-20260723-164455`。所有正式消息均通过已登录的 Zulip Web UI 发送，开头使用 `@**Jarvis PM**`；Zulip API 仅用于发送后的只读回查。

| 用例 | 目标 stream | 状态 | 结论 |
|---|---:|---|---|
| G-01A | 沙箱（2） | PASS | 登记提示、HCO 零派发及同步脱敏审计均已由 message `542` 关闭验证 |
| G-01B | 显式 HERMES 隔离 stream | BLOCKED | live snapshot 中不存在显式 HERMES route；按计划未修改生产 route 制造条件 |
| G-05 | 量化交易stockProfits（5） | PASS | 返回正确 projectId、canonical 工作目录和一句进度，唯一标识完整 |
| G-06A | 量化交易stockProfits（5） | PASS | 只读 Codex 任务完成，正常标识符完全保真，未修改项目文件 |

### G-01A 未映射 stream

- 时间：2026-07-23 17:05:59 +08:00
- UI 入站 message ID：`535`，sender=`boss`，stream=`沙箱`，topic 与本轮一致。
- 回复 message ID：`536`，sender=`Jarvis PM`。
- 入站原文：`@**Jarvis PM** /codex run 只做测试，不修改文件，并返回一句确认`
- 入站 rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> /codex run 只做测试，不修改文件，并返回一句确认</p>`
- 回复：当前频道尚未登记 Codex 项目，并要求确认 projectId、canonical 绝对工作目录、stream 登记和 objective 选择。
- 断言：真实 `user-mention` 存在；未映射 stream 返回登记提示；HCO 四项计数保持 `14/13/11/15`，未创建 objective 或 HCO inbound。
- gateway 可见旁证：`2026-07-23 17:05:59,916 ... Sending response ... to 2:hco-fix2-post-fix-20260723-164455`。
- 未关闭项：插件实现将 `ROUTE_UNMAPPED_REGISTRATION` JSON 写入进程 stderr，但在当前可访问的 gateway、HCO、delivery 日志中未检索到 message `535` 对应事件。当前执行机并非 Hermes 服务宿主的完整内部观测面，因此记为“审计证据不可核对”，不判定同步审计 PASS。

#### G-01A 审计关闭复测

- RUN_ID：`G01A-AUDIT-RETEST-20260724-070422`；topic：`hco-fix2-g01a-audit-retest-20260724-070422`。
- UI 入站 message ID：`542`，时间 `2026-07-24 08:51:57 +08:00`；回复 message ID：`543`，时间 `2026-07-24 08:51:58 +08:00`。
- API rendered HTML 包含真实 `user-mention`；回复为未登记 stream 的登记提示，且不含任务提交、objective ID、项目目录或执行结果。
- gateway 在 `2026-07-24 08:51:57.263 +08:00` 同步写入唯一脱敏审计记录：`event=hermes_codex_bridge.local_route_decision`、`sourceMessageId=542`、`streamId=2`、`commandType=RUN`、`resultCode=ROUTE_UNMAPPED_REGISTRATION`。
- 审计记录只包含 sender/stream/message 标识、时间、topic 字节数与 SHA-256，不含 topic 正文、命令正文、CWD、token、HMAC、bearer 或秘密答案。
- HCO 四项计数保持 `objectives=15`、`turn_submissions=14`、`zulip_outbox=12`、`inbound_intents=16`；逐表反查 message `542/543` 均为零命中。
- 结论：G-01A 的 UI、API、路由隔离、零派发和同步审计证据全部满足，状态更新为 `PASS`。先前 message `535` 的证据缺口由旧 release 未包含审计实现导致，不影响本次新 release 的关闭结论。

### G-01B 显式 HERMES route

- 未执行。
- 原因：route snapshot generation `14` 中没有显式 owner=`HERMES` 的隔离 stream。
- 安全约束：没有修改生产 route，也没有借用 default owner 的未映射 stream 代替显式 HERMES 前置条件。

### G-05 只读 route 查询

- 时间：2026-07-23 17:11:10 +08:00
- UI 入站 message ID：`537`，sender=`boss`，stream=`量化交易stockProfits`，topic 与本轮一致。
- 回复 message ID：`538`，sender=`Jarvis PM`。
- 入站原文：`@**Jarvis PM** 请回复当前 projectId、工作目录，并用一句话汇报项目进度。回显 G05-HCO-FIX2-POSTFIX-20260723-164455`
- 入站 rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> 请回复当前 projectId、工作目录，并用一句话汇报项目进度。回显 G05-HCO-FIX2-POSTFIX-20260723-164455</p>`
- 回复原文：`当前项目：stockprofits。工作目录：/Users/hula/Projects/stockprofits。项目进度：本次仅核验项目路由，未执行项目工作区进度扫描。回显：G05-HCO-FIX2-POSTFIX-20260723-164455。`
- 断言：真实 `user-mention` 存在；projectId=`stockprofits`；canonical CWD=`/Users/hula/Projects/stockprofits`；唯一标识完整；回复明确未扫描或修改项目工作区。

### G-06A 正常标识符

- UI 入站 message ID：`539`，时间 2026-07-23 17:12:24 +08:00，sender=`boss`。
- 提交确认 message ID：`540`，时间 17:12:48，sender=`Jarvis PM`。
- 最终结果 message ID：`541`，时间 17:15:33，sender=`Jarvis PM`。
- 入站原文：`@**Jarvis PM** 请执行只读 route 查询，并原样回显 obj-1-LIVE-POSTFIX.S-001`
- 入站 rendered HTML：`<p><span class="user-mention" data-user-id="9">@Jarvis PM</span> 请执行只读 route 查询，并原样回显 obj-1-LIVE-POSTFIX.S-001</p>`
- 提交确认：project=`stockprofits`，objective=`objective-616a97ce-b4f5-487b-924a-0e78f7fe4795`。
- 最终结果原文：`[objective objectiv result 1/1]\nRead-only route/query smoke check completed.\n\nobj-1-LIVE-POSTFIX.S-001`
- 最终 rendered HTML：`<p>[objective objectiv result 1/1]<br>\nRead-only route/query smoke check completed.</p>\n<p>obj-1-LIVE-POSTFIX.S-001</p>`
- HCO 状态：objective=`completed`；submission=`completed`，terminal_status=`completed`，reconciliation_required=`0`。
- delivery 状态：outbox=`delivered`，attempt_count=`1`，acknowledged_zulip_message_id=`541`。
- 断言：真实 `user-mention` 存在；`obj-1-LIVE-POSTFIX.S-001` 在入站、最终原文、HTML 和浏览器页面中字符完全保真；没有自动重试或 reconciliation。

## U-01/U-02 隔离故障注入

使用临时目录和临时 Unix socket 调用当前 `BridgeClient`。该 harness 不连接生产 HCO、不读取生产 token、不访问 HCO 数据库，也不发送 Zulip 消息。

| 用例 | 注入点 | 分类 | 接收请求数 | 自动重试 | 状态 |
|---|---|---|---:|---:|---|
| U-01 | 建连前 socket 不存在 | `BridgeUnavailableError` | 0 | 0 | PASS |
| U-02 | 服务端完整读取一次请求后不返回响应 | `BridgeUncertainError` | 1 | 0 | PASS |

用户提示合同另以三项针对性测试验证：

- 写入前失败包含“请求未提交、稍后重试”，不包含“不确定”语义。
- 写入后响应不可用包含“可能已经写入、先查询状态、确认后再重试”。
- CONTINUE 场景仅在不确定提示中保留安全 objectiveId；明确未提交提示不回显 objectiveId。

验证结果：`3 passed in 0.37s`。

## 自动化旁证

- post-fix Zulip API 结果：`docs/superpowers/test-artifacts/2026-07-23-hco-fix2-post-fix-api/result.json`，整体 `PASS`；B-01 至 B-06 均通过，B-06 已验证真实 mention HTML。
- 路由、审计和 Markdown 的 16 项针对性合同测试通过：`16 passed in 1.06s`。
- `git diff --check` 通过。
- 这些结果只作为旁证，不替代人工 UI 与 API 回读证据。

## 浏览器执行与清理

- 正确控制通道为 `http://127.0.0.1:12306/mcp`；另一套 Chrome 控制通道不是本轮测试会话。
- 测试 Chrome 窗口已是 Zulip 登录后的对话状态，没有执行登录、密码或 2FA 操作。
- G-05、G-06A 在同一 Zulip 页面连续发送；结束时测试窗口恢复为单标签，保留目标项目 topic。
- Chrome 不需要位于前台。指定 URL 回读用于避免全局活动焦点落到另一个 Chrome 窗口。
- 本地临时故障注入脚本、临时结果副本和 devmac `/tmp` 脚本在文档同步验证后清理。

## 剩余发布阻塞

1. 提供一个已经显式配置为 `HERMES` 的隔离 stream，执行 G-01B；不得临时修改生产 route。

本文不包含 API key、cookie、bearer、HMAC、MCP session ID、命令正文秘密或完整环境变量。
