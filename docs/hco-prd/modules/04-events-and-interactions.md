# 04 事件、审批与交互

本模块负责 HCO 侧事件事实、向 Hermes external continuation adapter 的交接状态和 Codex 远端 interaction；Hermes 侧 native completion queue、wake、模型、处理状态和平台 delivery 归 [`01-hermes-integration.md`](01-hermes-integration.md)。

## App Server 事件

HCO 接收并按 backend、thread、turn、item、event type、remote revision 去重；详细 reducer 见 [`../contracts/03-state-transactions.md`](../contracts/03-state-transactions.md)。乱序、revision 缺口和终态吸收由软件 CAS 处理，不交给模型。

| 事件 | 含义 | Hermes 处理 |
| --- | --- | --- |
| `codex.progress` | 有意义的阶段进展 | 合并后按偏好续报 |
| `codex.needs_input` | 缺少继续所需信息 | 模型判断回答或向有权限主体提问 |
| `codex.approval_required` | 需要受控审批 | 展示风险并校验回答主体 |
| `codex.completed` | 获得终态证据 | 模型判断交付或恢复 |
| `codex.failed` | 明确失败 | 模型判断换法、提问或交付失败 |
| `codex.cancelled` | 远端明确取消 | Hermes 确认取消或升级不确定性 |
| `codex.unknown` | 副作用不确定 | 只对账，禁止盲目重试 |

事件先写入 `codex_events`，再调用 `hermes_external_continuation_accept/v1`。网络超时只查询或重交相同 event/request/digest；取得 acceptance 后不再创建第二个 wake。progress 可以合并，terminal/interaction 不等待合并窗口。Hermes 内部的 queue/lease 复用 native completion pipeline，HCO 不维护第二个 wake lease。

## Interaction 适配

HCO 保存 Codex 远端事实，Hermes 保存用户展示和回答状态。两者通过以下绑定连接：

```text
remote_interaction_id <-> Hermes native interaction_receipt_ref
```

流程：

```text
Codex request -> HCO 持久化 remote interaction
  -> Hermes 接收事件并创建/复用 native interaction receipt
  -> Hermes 使用 clarify/approval 向用户或 Agent 提问
  -> 模型调用 codex(action=respond, answer)
  -> runtime 补充 interaction_receipt_ref + responder invocation + reply key
  -> HCO 校验配对、权限和远端 revision
  -> App Server 按 command capability 结算；不支持远端幂等时，断线只能进入 UNKNOWN
```

`remote_interaction_id` 是 HCO 主唯一键，`interaction_receipt_ref` 由 Hermes 签发、对模型不可见并在 HCO 侧唯一绑定。重复事件必须复用已有 receipt；重复相同回答返回第一次结算，同一 key 的不同内容或冲突回答必须拒绝。没有唯一 active receipt 时，runtime 必须拒绝并让 Hermes 提问，不能猜“最近 interaction”。Hermes UI 超时不能代替 Codex 自动回答，只有远端明确过期、取消或终止才能关闭 interaction。

## 处理完成条件

每个 completed、failed、cancelled、unknown、needs_input 和 approval event 必须在 Hermes 中形成可查 handling outcome：`USER_DELIVERED`、`FALLBACK_DELIVERED`、`FOLLOWUP_STARTED`、`QUESTION_ASKED`、`REMINDER_SET`、`CANCEL_CONFIRMED`、`ESCALATED` 或 `SUPERSEDED`。`ACCEPTED` 只表示事件和 wake 已登记，不表示模型或用户已经处理；Hermes processing state 和 handling outcome 都由 Hermes 结算，HCO 只能缓存只读诊断。
