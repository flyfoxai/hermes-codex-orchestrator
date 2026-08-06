# Hermes v0.19.0 交互修复人工复测结果

## 结论

- 执行日期：2026-07-29（Asia/Shanghai）
- 总体结论：**FAIL**。PC-01、PC-02、PC-04、PC-05、PC-06 通过；PC-03 双标签重复点击失败；Android App 因没有真实设备或可控模拟器而未执行。
- 浏览器：Google Chrome `150.0.7871.187`，Windows 10 x64。
- 授权发送账号：`boss`；Jarvis Bot：`Jarvis PM`。
- Zulip：频道 `量化交易stockProfits`，话题 `hermes-v019-interaction-fix-20260729-150151`。
- 所有正式消息均由已登录 Boss 的 Zulip Web UI 发送；API 只用于只读回查。原文保留 `@**Jarvis PM**`，rendered HTML 包含 `span.user-mention[data-user-id=9]`。

## PC 用例

| 用例 | 结果 | Zulip 消息 ID | 关键事实 |
|---|---|---|---|
| PC-01 | PASS | 请求 `688`，prompt `689` | 页面出现三个可用按钮，标签精确为“选项 A / 选项 B / 取消”，不是 `1/2/3`；点击前截图已保存。正文仍列出编号，但不是仅有编号，原生按钮存在。 |
| PC-02 | PASS | 请求 `694`，prompt `695`，选择 `696`，确认 `697` | 单击“选项 A”后只有一条 Jarvis 确认；prompt `695` 从 API 消息集合删除；相关 clarify 消息没有创建 HCO work、call 或 objective。 |
| PC-03 | **FAIL** | 请求 `688`，prompt `689`，选择 `690/691`，确认 `692/693` | 标签一点击 A 后立即在标签二点击 B；两个点击都成功，同一秒生成两条 Boss 回答，随后 Jarvis 分别确认 A 和 B。首次消费没有阻止 stale tab 的第二次结算。 |
| PC-04 | PASS | 请求 `698`，prompt `699`，取消 `700`，确认 `701` | 点击“取消”后 prompt 删除，只收到一次取消确认，没有创建 HCO work/call/objective，也没有继续项目工作。 |
| PC-05 | PASS | work 查询 `704 -> 705`；objective 查询 `706 -> 707` | 两条指令都带尾随中文，均被识别；没有 `Invalid /codex command` 或 protocol error。work 回复包含状态、Codex/Agent 活动数、待处理回报和下一动作；objective 回复包含执行与后端核验状态。 |
| PC-06 | PASS | `706 -> 707` | HCO 数据显示 call、submission、objective execution 均为 `completed`；Zulip 回复明确返回 `completed`、后端 `app-server`，并说明已向执行后端核验，没有机械复述旧 `running`。 |

## PC-03 失败复现

1. 在同一窗口保留原标签，再使用带唯一 query 参数的同话题 URL 创建第二标签。
2. 两个标签均显示 prompt `689` 的“选项 A / 选项 B / 取消”按钮。
3. 激活标签一并点击“选项 A”，随即激活标签二并点击“选项 B”。
4. Chrome MCP 对两个点击都返回成功。
5. Zulip API 回读到 Boss `690=@Jarvis PM 选项 A`、`691=@Jarvis PM 选项 B`，两条时间戳相同；Jarvis 又回复 `692=已收到选项 A`、`693=已收到选项 B`。
6. prompt `689` 最终被删除，但删除没有阻止第二标签提交并再次结算。

该失败不产生 HCO work/call/objective，但违反“首次消费、重复消费拒绝、只确认一次”的验收要求。

## PC-05/PC-06 后端证据

- 只读工作入站：消息 `702`。
- Work：`work-request-d89b1475-f8b2-4925-ac94-c665348dca4d`。
- Objective：`objective-6b60124d-c1e4-4866-b5d6-d8aa13af7993`。
- Codex call：`codex-call-ddc5dfe2-24b6-4a82-b1bc-dcfa31edd7dd`，`COMPLETED`。
- Submission：`completed/completed`，不需要 reconciliation。
- Objective execution：`app-server/completed`。
- 查询时 work 为 `RUNNING/caller_review`，0 个 active call，存在待 Jarvis 处理的回报；work status 回复如实显示 `caller_review`，objective status 进一步核验为后端 completed。
- 截止取证时没有收到该只读工作的独立最终汇报消息；该残留已保留在 `hco-db-evidence.json`，不影响 PC-06 对后端终态查询的通过判定。

## Android App

结果：**NOT RUN / BLOCKED**。

- 本机没有 `adb`。
- 没有 Android emulator、qemu 或 adb 进程。
- 没有可控真实 Android 设备，也没有 Zulip App、Android 版本和设备型号信息。
- 未用移动尺寸网页冒充 Android Zulip App；因此按钮显示、点击、刷新、弱网重复点击和 PC/Android 交叉消费均不能判定。

## 运行环境

- HCO PID `8920`。
- Gateway PID `8992`；另有部署前既存 Hermes gateway PID `1525/1533`，本轮未操作。
- delivery PID `9048`。
- 当前 release：`hermes-codex-bridge-1.0.0-e0cc0301a5a7`。
- 自动验证结果：Node 345 tests、Python 453 tests、Hermes upstream 270 tests、installer 42 cases 均已通过；本轮没有重跑这些自动测试。

## 证据文件

- `zulip-api-evidence.json`：消息 `688-707` 的原文、rendered HTML、sender、topic、时间和已删除 prompt 记录。
- `hco-db-evidence.json`：clarify 消息零业务记录计数，以及 PC-05/06 work、call、objective、submission、mailbox 的只读快照。
- `pc01-buttons-before-click_2026-07-29T07-05-44-675Z.png`
- `pc02-single-click-pass_2026-07-29T07-11-42-068Z.png`
- `pc03-double-submit-failure_2026-07-29T07-09-21-470Z.png`
- `pc04-cancel-pass_2026-07-29T07-13-21-210Z.png`
- `pc05-pc06-status-pass_2026-07-29T07-16-32-257Z.png`
- `zulip-chrome-mcp-operation-guide.md`：包含本轮新增的双标签和删除前取证经验。

结果目录不包含 Zulip API key、HCO bearer、Authorization header、MCP session ID 或内部签名 token。
