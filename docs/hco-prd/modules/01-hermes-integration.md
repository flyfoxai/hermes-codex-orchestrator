# 01 Hermes 集成与续接

## 职责

Hermes 是用户消息、会话、Agent 生命周期、提醒/cron、交互展示、模型调用和最终平台投递的唯一权威。HCO 通过插件或受信 bridge 向 Hermes 注册一个压缩的 `codex` 工具，并通过公开的 external continuation adapter 把 Codex 事件交回 Hermes。

本模块只定义 Hermes 侧接收和续接合同；HCO 侧事件持久化和远端 interaction 归 [`04-events-and-interactions.md`](04-events-and-interactions.md)。

可实施的请求/响应、错误码、digest 和 lease 规则见 [`../contracts/01-hermes-bridge-api.md`](../contracts/01-hermes-bridge-api.md)。本模块的接口名不能被实现方重新解释。

HCO 不解析 Hermes transcript、session key、`chat_type` 或 Agent 父子树，也不直接写 Hermes 数据库或调用 Zulip API。插件不得调用 Hermes 私有方法；若 Hermes 尚无需要的公开入口，先增加薄的、版本化的 extension API。

## 调用合同

模型可见工具只有 `codex`，其动作是 `start`、`check`、`respond`、`cancel`。文档上传、结果读取、列表查询、执行路径和 `project_local/managed` 文档模式选择由 Hermes runtime/HCO 内部自动完成；用户显式查询列表仍可通过 Hermes 原生命令或受信诊断入口完成，不加入模型默认 schema。action 的必填、可选和禁止字段由 runtime 确定性校验，模型不构造 API envelope。

Hermes 插件在模型不可见的 envelope 中注入：

- `invocation_ref`：本次调用的主体、来源、项目候选、操作、请求摘要和有效期；HCO 可通过单一 introspection 入口取得最小声明。
- `continuation_ref`：覆盖 work 生命周期的 Hermes 逻辑返回目标；Hermes 自己解析当前 Agent、父/根回退、真实 session source 和平台投递。
- capability revision 和调用幂等键。

Hermes 必须把模型参数摘要、operation、tool call/request ID、两个引用和 capability revision 签成 `invocation_ref` receipt；HCO 验证该单一组合后才创建 work。模型不能填写或覆盖这些字段。`invocation_ref` 是短期授权，`continuation_ref` 的保留期必须覆盖 work、interaction 和未处理事件的生命周期。

模型可以回传工具此前返回的、限定来源和项目范围的 opaque `work_ref`，以便查询、继续和取消；回答 interaction 时只提交答案，当前 Hermes interaction receipt 由 runtime 根据 continuation/work 上下文注入。模型不能传 Hermes session key、平台目标或 App Server thread/turn ID。runtime/HCO 每次使用都重新校验 invocation、scope、interaction 和对象归属。

HCO 加密保存 `continuation_ref` 原值，日志只保存摘要。Hermes 负责逻辑目标的 Agent 回退；引用被撤销或目标不存在时返回稳定错误，HCO 进入 `TARGET_UNDELIVERABLE` 并告警，不自行选择新会话。

## 事件接收

HCO 使用单一原子接口：`hermes_external_continuation_accept/v1`。该接口是 Hermes 对现有 completion/event pipeline 的正式扩展，不是 HCO 自己的 mailbox worker；它一次完成事件登记、逻辑目标解析和一次 native continuation wake，不允许拆成 `accept` 后再由 HCO 单独 `wake`。

```text
event_id + work binding + continuation_ref + payload/document refs
  -> Hermes 校验并持久化 external continuation event
  -> 按 event_id 登记一次 native continuation wake
  -> interaction 事件创建/复用 Hermes native interaction receipt
  -> 提交事务后返回 acceptance_id
```

同一 `event_id + event_fact_digest + continuation binding digest` 只返回原 acceptance；不同事实或 work/continuation 绑定必须冲突拒绝。digest 不含发送时间、trace、重试次数等传输字段。Hermes 负责保留真实 platform、chat ID、`chat_type`、thread 和 profile。HCO 不得用 synthetic `MessageEvent` 重建来源。Hermes extension 可以内部复用 synthetic event 的既有实现，但该细节不能成为 HCO 合同，也不能由插件直接调用。

Hermes 还要核对事件的 work、origin invocation receipt 和 continuation binding。当前 `continuation_ref` 即使本身有效，只要不属于该 work 的原始绑定，就必须拒绝，避免把 A work 的结果交给 B 会话。

Hermes 还必须提供 `hermes_external_continuation_status/v1(acceptance_id)`，至少返回 `ACCEPTED | PROCESSING | HANDLED | FAILED_FINAL`，用于发现“事件已接收但没有后续处理”。处理 lease、session queue、模型重试、fallback 和平台 delivery 全部复用 Hermes 原生实现；HCO 只查询和告警，不建立第二个 wake worker。

## 结果续接

对 `needs_input`、`approval_required`、`completed`、`failed`、`cancelled` 和 `unknown`，Hermes 按 `event_id` 创建 continuation turn。软件先把内部状态映射为模型可见的最小 `assistant_view`：`accepted | working | needs_input | completed | failed | uncertain`，并提供有界目标、验收条件、证据摘要、稳定原因、是否可重试和允许动作。模型不读取 HCO 内部状态机；task contract 无法授权读取时，Hermes 确定性 `ASK/ESCALATE`，不能只凭 digest 判断成功。

模型可选：

| 决策 | Hermes 行为 |
| --- | --- |
| `DELIVER` | 组织结果并通过原生消息层投递 |
| `FOLLOW_UP_CODEX` | 软件先预留预算，再按 `relationship=continue` 创建后续 work |
| `ASK` | 向有权限主体提问 |
| `WAIT` | 使用 Hermes 原生 reminder/cron |
| `ESCALATE` | 说明失败、风险或不确定性 |

模型不可用、Hermes 模型调用预算不足或连续失败时，Hermes 使用 `assistant_view.fallback_message` 通过原生 delivery 发送确定性降级消息。摘要只能由结构化状态、稳定错误码、retryability 和经过长度限制/脱敏的证据片段确定性生成，不能把 Codex 原文直接当平台消息。内部错误到 `assistant_view` 的映射由软件完成；模型既不接收内部错误目录，也不决定底层重试算法。HCO 提供事实，不提供第二套用户消息层。每个关键事件必须有 Hermes 原生 handling outcome。

Hermes 在执行模型动作前先持久化 `continuation_decision_id + decision_generation + action_kind + payload_digest`。同一 acceptance/generation 只能执行一个 action；动作已执行但回执不确定时查询原 action，不重新让模型生成第二个动作。

## 不变量

- Hermes 接受事件不等于用户已经看到；Hermes 自己负责模型处理、delivery 和失败告警。
- HCO 不自行挑选 Agent 回退目标；`continuation_ref` 失效时等待 Hermes 解析或人工修复。
- 普通 progress 可合并，不为每个 delta 调用模型。
- 新事件在模型处理期间到达时递增 snapshot generation；旧模型候选提交必须 CAS，过期候选标记 SUPERSEDED。
- `WAIT` 创建 Hermes 原生 reminder，并指向同一逻辑 continuation。reminder 与 Codex 事件都进入 Hermes 原生 session queue；同一 event snapshot generation 只允许一个 handling intent，过期候选被标记 SUPERSEDED。后到的 Codex 新事实开启新的 snapshot generation，因此等待提醒不会吞掉后续终态；每个 terminal event 仍只允许一次终态投递。
