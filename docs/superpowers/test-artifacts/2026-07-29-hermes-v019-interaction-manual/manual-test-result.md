# Hermes v0.19.0 交互功能人工验收结果

> 本文保留 2026-07-29 06:18 部署版本的失败证据。12:14 修复部署后的自动验证结果见 [automated-test-result.md](../2026-07-29-hermes-v019-interaction-fix-auto/automated-test-result.md)；原 FAIL 结论不能直接改成 PASS，按钮和 Android 项仍需按更新后的人工方案复测。

## 结论

- 执行日期：2026-07-29（Asia/Shanghai）
- 总体结论：**FAIL**
- 浏览器：Google Chrome 150.0.0.0，Windows 10 x64
- 授权发送账号：`boss`；Jarvis Bot：`Jarvis PM`
- PC 基础入站可用，但原生交互、状态查询、交互消费和 Agent/Codex 分层协调均未达到方案要求。
- Android、断网和服务重启故障注入未执行，原因分别为无 Android 设备，以及未获授权影响网络或重启服务。

所有正式消息均由已登录 Boss 的 Zulip Web UI 发送。API 只用于只读回查。消息 `642`、`644`、`660`、`662`、`665`、`667`、`669`、`671`、`674`、`675`、`679` 的 rendered HTML 均包含 `user-mention`，不是普通文本 mention。

## PC 用例

| 用例 | 结果 | Zulip 消息 ID | 关键事实 |
|---|---|---|---|
| PC-00 | PARTIAL PASS | `636-645` | 零 mention `636 -> 637` 正常；非 Jarvis mention `638`、`641` 未触发 Jarvis；显式 Jarvis `642 -> 643`、Jarvis+Boss `644 -> 645` 均只回复一次。误选 SpecPlanner/Builder 的 `639 -> 640` 不计正式非 Jarvis 样本。未在第二个频道完整重复五组，因此不能记全通过。 |
| PC-01 | FAIL | `646 -> 647/648` | 生成的是 legacy Zulip `zform`。按钮 short name 为 `1/2/3`，long name 才是“选项 A/选项 B/取消”，不满足按钮标签完全一致。 |
| PC-02 | FAIL | `650`，按钮 `647` | 点击“选项 A”仅生成一条 Boss mention 消息；没有确认回复，原按钮未删除且可继续点击。 |
| PC-03 | FAIL / PARTIAL | `650`、`656` | 同一按钮随后仍可提交“选项 B”，未返回已处理/已失效。受测试窗口必须保持单标签限制，双标签竞态未执行；zform 未暴露有效 interaction/action ID，命令重放部分 BLOCKED。 |
| PC-04 | FAIL | `651 -> 652/653`，点击 `655` | 点击取消后没有取消确认，按钮 `652` 仍存在，后续仍显示 clarify 工作状态 `657`。 |
| PC-05 | FAIL | `660 -> 661` | 带尾随中文的 status 指令未返回 `Invalid /codex command`，但只返回 `Codex bridge protocol error.`，没有 objective、执行、验证或等待输入状态。 |
| PC-06 | FAIL / BLOCKED | `660 -> 661` | 无法用 App Server 或持久化 submission 终态校准；回复没有提供真实后端状态，未满足防过期 running 要求。 |
| PC-07 | BLOCKED | `647/652` | 本轮只有 legacy zform，HCO 没有与其对应的可用 interaction/action ID，无法构造真实跨话题 `/codex interact`。 |

PC-01/04 的 API submessage 均为 `widget_type=zform`：

```text
short_name=1, long_name=选项 A
short_name=2, long_name=选项 B
short_name=3, long_name=取消
```

HCO 取证时共有 6 条 `pending_interactions` 和 12 条 `interaction_actions`，但它们不是本轮 legacy zform 消息 `647/652` 可用的交互标识。

## 协调用例

| 用例 | 结果 | 入站/回复 | HCO 证据与判定 |
|---|---|---|---|
| COORD-01 | FAIL | `662 -> 664` | work `work-request-e3de6913-e416-441a-8d8b-313a78612b48`，仅一个 JARVIS call `codex-call-c1cb4db7-279e-4222-8989-6ce45c6a8052`；无 Agent session、无第二个 call，停在 `WAITING_CODEX/codex_running`。 |
| COORD-02 | FAIL | `665 -> 666` | work `work-request-3ff295a2-ce2a-41ac-ab85-c2d8fe1e3c30`，仅一个 JARVIS call `codex-call-5c6ad129-bc36-4d6b-ae39-0e68fd025192`；没有同 Agent 两次调用。 |
| COORD-03 | FAIL | `667 -> 668` | work `work-request-95515afd-8bf6-40e4-9a6e-65ad8e3bc24f` 显示 `WAITING_CODEX/codex_running`，但 `agent_sessions` 全表为 0；无法证明 Agent 等待、唤醒及 REPORTED/FAILED。 |
| COORD-04 | FAIL | `669 -> 670` | work `work-request-7b1c8d8d-f8f6-4a02-bae8-07aa02f7891e` 仅一个 JARVIS call；没有 Agent A/B session，也没有 B -> A -> Jarvis 汇报链。 |
| COORD-05 | FAIL | A `674 -> 676`；B `675 -> 677`；跨话题 `679 -> 680` | A/B 有独立 topic context、conversation、work/objective/call，但两个 call 均 `FAILED`，对应 work 反而残留 `RUNNING/caller_review`。从 B 继续 A objective 返回 `Invalid /codex command.`，不是 `scope mismatch`；消息 `679` 未新增 work/call，因此没有额外 turn。 |
| COORD-06 | FAIL | `671 -> 672` | Jarvis 未启动 Agent、未收到 Hermes 原生子 Agent 汇报，也无法确认 `UNTRACKED`；HCO `agent_sessions` 总数仍为 0。 |

COORD-05 A：

- topic context：`topic-context-6e8f314a-f5b9-4a0e-9ba0-8adb20f7a350`
- work：`work-request-8cb9f936-db61-4c1d-b6b5-727f43abec3b`，`RUNNING/caller_review`
- objective：`objective-021b9954-73ad-42a5-9060-083419588802`，`created`
- call：`codex-call-b77f3d56-2608-4158-91dd-360093dbeff0`，`FAILED`

COORD-05 B：

- topic context：`topic-context-4066fe4c-7809-4ed8-ac54-a795ade28d9f`
- work：`work-request-a9fd89ac-046c-42dd-a427-9053bfa9c396`，`RUNNING/caller_review`
- objective：`objective-6765348a-98c4-40ac-ba11-ff69aa9a2ae9`，`created`
- call：`codex-call-9d90fe16-3a20-4b08-81e3-4b0f36f451d6`，`FAILED`

## 未执行项

- Android 第 4 节：**NOT RUN**，当前没有可控 Android 设备及 App 版本信息。
- NET-01：**NOT RUN**，断开网络会影响用户环境，未获明确授权。
- NET-02：**NOT RUN**，重启 Gateway/HCO/delivery 需要维护窗口，未获明确授权。
- PC-03 双标签竞态：**NOT RUN**，与“测试窗口只有一个标签”的明确约束冲突。

## 环境异常

- 测试时同时存在三个 Hermes Gateway 进程：PID `1525`、`1533`、`14176`。
- HCO PID `14160`；delivery PID `14228`。
- delivery 运行 release：`hermes-codex-bridge-1.0.0-18c91b8dc930`。
- 静态 route：stream `5 -> project stockprofits`；运行时 override：stream `6 -> hermes`。
- COORD-01 至 COORD-04 的 call 仍为 `RUNNING`，work 为 `WAITING_CODEX/codex_running`；COORD-05 两个 call 已 `FAILED`，但 work 仍为 `RUNNING/caller_review`。
- 多个 Jarvis 回复报告 `Codex bridge protocol error.`，与 HCO 残留状态一致，属于本轮主要阻断。

## 证据文件

- `zulip-api-evidence.json`：消息 `636-680` 的原始 content、rendered HTML、sender、stream/topic、时间和 submessages。
- `hco-db-evidence.json`：相关 work、call、objective、topic context、agent session、pending interaction/action 快照。
- `server-audit-evidence.md`：进程、route、release 和数据库状态摘要。
- `coord05-failure.png`：COORD-05 B 话题截图，Chrome MCP 明确返回目标 tab ID `1777374382`。
- `zulip-chrome-mcp-operation-guide.md`：更新后的可复用浏览器操作经验。

结果目录中不包含 Zulip API key、HCO bearer、Authorization header 或完整未脱敏日志。
