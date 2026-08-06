# HCO Fix2 浏览器测试执行记录

## 执行信息

- 日期：2026-07-23（Asia/Shanghai）
- 浏览器身份：已登录的授权用户 `boss`
- 测试频道：stream ID `2`，`沙箱`
- 测试话题：`hco-browser-20260722T221238Z-a6410c7b`
- 操作方式：Chrome MCP 驱动 Zulip Web UI，devmac Zulip API 只读回查

## 发送与回查结果

| 项目 | 消息 | Zulip message ID | 页面验证 | API 回查 |
|---|---|---:|---|---|
| UI 发送验证 | `[UI发送验证] hco-ui-20260723T0852+0800` | 504 | PASS，上午 8:53 出现在中间消息流 | PASS，sender=`boss`、stream=`沙箱`、topic 正确 |
| G-01 正式最小指令 | `/codex run hco-browser-20260723T005649Z-3e4a528e-G01 no-op` | 505 | PASS，上午 8:56 出现在中间消息流 | PASS，sender=`boss`、content 完整 |
| 正常项目 G-05 对照 | `/codex status hco-browser-20260723T010333Z-39c9e501-G05-does-not-exist` | 507 | PASS，上午 9:03 出现在 `量化交易stockProfits` 消息流 | PASS，sender=`boss`、content 完整 |

历史同话题消息 `502` 为 `/codex run hco-browser-20260722T221238Z-a6410c7b-G01 no-op`，本次检查时同样没有 Hermes 回复。

## G-01 预期与实际

预期：Hermes-owned stream 返回稳定的 `ROUTE_HERMES_OWNED` 用户错误，不返回 protocol error，不创建 objective。

实际：消息 `505` 已由授权用户通过 Zulip UI 成功发送并由 Zulip API 回读；等待 30 秒后，该话题中没有 `505` 之后的新消息，因此没有 reply message ID，无法验证 `ROUTE_HERMES_OWNED` 的回复渲染。

## 正常项目频道对照

为排除 `沙箱`频道自身限制，进入已映射项目 `量化交易stockProfits` 的同名专用测试话题，通过 UI 发送只读 G-05 状态查询，消息 ID 为 `507`。预期应快速返回 `OBJECTIVE_NOT_FOUND`，且不创建任务。

等待 20 秒后，该话题中仍只有用户消息 `507`，没有 Hermes 回复；gateway 日志和 HCO 数据库均无 `507` 入站。因此无回复并非 `沙箱`限制，也不是大型 Codex 工作耗时。

## 服务端诊断证据

- HCO PID `35249`：启动于 2026-07-19 17:06:00。
- Hermes gateway PID `35335`：启动于 2026-07-19 17:06:05。
- delivery sidecar PID `35459`：启动于 2026-07-19 17:06:10。
- 三个进程在检查时仍存活。
- `~/.hermes/logs/gateway.log` 最后更新时间为 2026-07-21 00:09；日志中没有消息 `505` 的 inbound 记录。
- `~/.hco/hco.sqlite3` 的 `inbound_intents` 最新 Zulip source ID 为 `468`，没有 source ID `505`。
- 正常项目对照消息 source ID `507` 也不存在于 `inbound_intents`。
- 本次 RUN_ID 片段 `3e4a528e` 对应的 objective 数量为 `0`。

## 判定

- Chrome MCP 窗口识别和 Zulip UI 操作：PASS。
- 授权用户消息发送、页面显示和 Zulip API 回读：PASS。
- G-01 端到端业务断言：BLOCKED。
- 正常项目 G-05 端到端业务断言：BLOCKED。
- 阻塞点：Hermes gateway 未消费 `沙箱`消息 `505` 或项目频道消息 `507`，发生在 Codex 任务启动之前；本次指令分别为 `no-op` 和只读 `status`，不是大型任务耗时问题。

## 后续复测条件

先恢复 Hermes gateway 的 Zulip 入站消费能力。恢复后使用新的 RUN_ID 重发 G-01，要求同时取得：

1. gateway inbound 日志；
2. `ROUTE_HERMES_OWNED` 回复及 reply message ID；
3. API 原文和渲染 HTML 断言；
4. 未创建 objective 的 SQLite 证据。

本次未重启 gateway、未修改 route/topic mode、未创建或清理生产 objective，也未在证据中保存密码、cookie、API key、token 或 MCP session ID。
