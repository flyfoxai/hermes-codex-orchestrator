# 03 Codex 执行与状态

## 执行路径

| 路径 | 适用场景 | 状态权威 |
| --- | --- | --- |
| `HERMES_NATIVE_TURN` | 未绑定项目、同一 Hermes turn 内完成、无需项目文件/HCO 文档/反向 interaction/恢复的短期 Codex 调用 | Hermes 原生 runtime |
| `HCO_MANAGED_WORK` | 已绑定的 Zulip/非 Zulip 项目来源，或 Agent 发起的项目/长期委派，以及任何需要恢复、反向交互或项目内文档交换的工作 | App Server 事实 + HCO 投影 |

所有 `PROJECT_BOUND` 来源，包括已映射 Zulip 频道和已解析项目的非 Zulip Agent/DM，请求 Codex 项目执行时都必须进入 `HCO_MANAGED_WORK`。`HERMES_NATIVE_TURN` 只用于没有项目绑定、无需长期恢复/反向交互/项目内文档交换的短期调用。普通 native turn 不能被 HCO 从 transcript 猜测接管；需要长期执行时由 Hermes runtime 重新路由 `codex(action=start)`，创建新的 work 和 scope。两条路径不能静默互相转换。

判定顺序固定为：`HERMES_ONLY` 先拒绝该 topic 的任何 Codex 执行；其次 `PROJECT_BOUND` 一律进入 managed；未绑定来源若需要项目文件、持久 handle、反向 interaction、HCO 文档或跨 turn 恢复，必须先解析项目再进入 managed，无法解析则拒绝；只有其余真正的无项目短调用才进入 native。该判定由 Hermes runtime 的单一 `codex` 工具 facade 完成，模型不选择路径；发起者是用户还是 Agent 也不能单独决定路径。

`HERMES_NATIVE_TURN` 的 thread/turn/interaction 状态完全由 Hermes 原生 runtime 管理，不写入 HCO `codex_works` 或 `codex_events`；HCO 只管理 `HCO_MANAGED_WORK`。

文档模式和执行隔离是两个独立判断。当前的 `project_local/v1` 使用项目目录内 `.hco/exchanges/v1/<work_id>/<exchange_id>/`，不要求 `local_single_broker_exchange/v1` enforcement，但必须执行输入/输出 manifest、哈希、大小、类型和单写 lane 校验。`managed/v1` 仍要求真实 enforcement；当调用明确要求强隔离且 capability 不支持时，在写入 execution intent 前返回 `FILE_EXCHANGE_UNSUPPORTED`，不能静默退回项目内模式。旧的任意 `artifact_manifest + project cwd` 路径仍然不是 managed execution；测试或迁移期如需保留，必须由构造参数显式打开，不能由模型或请求字段自行切换。

## Work

`codex_work` 至少包含：`work_request_id`、topic/context binding、thread/turn 引用、发起方类型、origin invocation receipt digest、continuation binding digest、加密 `continuation_ref`、不可变 `ExecutionScope`、不可变且有界的 `task_contract`（目标、验收条件、关键约束及其 digest/文档引用）、输入/输出 manifest、幂等键、远端状态投影和终态证据。

每个 work 同时最多一个有效启动命令；每个 Codex thread 同时最多一个活跃 turn。主 thread 使用 topic FIFO 队列；`NEW/CONTINUE` 默认排队，`FORK` 必须有 parent/main-thread mapping。独立写工作只能使用 topic 内隔离 worktree/container，不能借用其他 topic 的 thread 或直接并写同一 root。

## Transport 前置条件

现有只向 `thread/start` 传 `cwd` 的 Hermes `CodexAppServerSession` 可以支持 `project_local/v1`，前提是项目目录已经是可信的 canonical root，且 HCO 在 turn 前后完成文档校验。它不足以支持 `managed/v1` 写执行；只有后者必须扩展共享 transport 或增加兼容 adapter，声明 [`../contracts/02-codex-transport-api.md`](../contracts/02-codex-transport-api.md) 定义的 `managed_execution_scope/v1` 能力协议，并实现执行端点：

```text
start_or_resume_managed_turn/v1(
  command_id,
  idempotency_key,
  execution_scope,
  expected_thread_id?,
  input_manifest,
  operation: START | RESUME | FORK
)
```

对 `managed/v1`，transport 必须真实落实 cwd、sandbox、read roots、write roots、exchange root、document grants、input manifest digest 和 write fencing，并返回 `effective_scope_attestation`（实际 cwd、sandbox/profile、读写根、交换目录、manifest、隔离实例、thread ID、scope digest）。HCO 核对一致后才把 managed work 标为 ACTIVE。`project_local/v1` 不生成这类强隔离 attestation，只记录 canonical root identity、exchange manifest 和普通项目 turn 引用；它不能被描述为隔离执行。

对 `managed/v1`，capability 不存在、权限配置被拒或 attestation 不一致时，强隔离任务确定性拒绝；这不阻止满足 `project_local/v1` policy 的普通项目任务。两种模式的远端 command 断线都进入 command `UNKNOWN` 并按原 command ID 对账，不能自动换 key 或换后端重跑。

## 状态投影

```text
SUBMITTING -> ACTIVE -> WAITING_INTERACTION -> ACTIVE
      |          |               |
      +----------+---------------+-> RECONCILING
      +----------+---------------+-> TERMINAL
```

App Server 的 `remote_status`、revision 和终态原因必须保留。`UNKNOWN` 只投影为 `RECONCILING`，不能当成普通 FAILED。超 SLA 可以本地标记 `ABANDONED_UNRESOLVED` 并告警，但不改写远端事实。Hermes wake、模型综合、用户消息和 reminder 不属于 HCO work 状态。

## 语义关系与软件映射

模型只表达 `relationship=auto|continue|separate`，并可附一个受限 `work_ref`。Hermes 根据同一话题的目标、验收条件和当前 work 判断语义关系；无法唯一判断时使用原生 clarify。软件再把语义关系映射为内部 `NEW/CONTINUE/FORK/REVIEW/CANCEL_AND_REPLACE/RECOVER`，并负责队列、worktree、预算和幂等。HCO 只验证 scope、并发和权限，不建立通用 workflow graph，也不让模型直接选择恢复或 fork 机制。
