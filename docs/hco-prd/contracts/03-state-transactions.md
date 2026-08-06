# 状态、事务与资源合同

适用主 PRD：0.9

## 1. 聚合和子记录

HCO 保持六个业务聚合，不增加通用 workflow graph：

| 聚合 | 可包含的必要子记录 |
| --- | --- |
| project route/policy | source mapping、suspension mode、project admission counter、canonical-root write lease |
| topic binding | main thread、fork mapping、FIFO queue、thread lease |
| Codex work | ExecutionScope、origin invocation/continuation binding、command attempts、lineage budget、parent snapshot、remote projection；`managed/v1` 额外包含 FileAttemptBinding 和 work owner/file broker epoch |
| interaction binding | remote interaction、Hermes native receipt、reply command attempt、远端结算证据 |
| Codex event | immutable event fact/revision、origin/continuation binding、Hermes acceptance、document access attempts |
| document manifest | canonical provenance、ACL grant、version/hash、file state/broker receipt、retention、delete status、access receipts |

这些子记录只服务本聚合的原子性和恢复，不拥有 Hermes 的 Agent、message、reminder 或 continuation 状态。

## 2. Work 创建和幂等

普通 work 的幂等 payload digest 覆盖：

```text
origin invocation receipt digest + source identity/continuation binding digest + project/scope digest
  immutable bounded task_contract (objective + acceptance criteria + key constraints) and its digest/reference
execution intent + target work/thread
input manifest digest
```

同一 Hermes request key 与相同 payload 返回原 work；同一 key 与不同 objective、scope 或 manifest 返回 `IDEMPOTENCY_CONFLICT`。调用方要提交新版本必须生成新的 request key，并显式引用旧 work；系统不静默替换输入。

`task_contract` 使用 canonical JSON 保存有界的 objective、acceptance criteria 和关键约束；默认内联上限 16 KiB、系统硬上限 32 KiB。超过内联上限时必须作为 manifest 中的必需 `task_contract` 文档保存，work 只保存 version/hash/digest；该文档从 admission 起 append-only，且 retention 不短于 work、恢复子 work、continuation 和未处理事件的生命周期。模型候选或后续摘要不能原地改写父 work 的 task contract。

恢复 work 唯一键：`parent_work_request_id + caused_by_event_id + continuation_decision_id`。子 work 保存父级目标、scope digest、终态/unknown 原因的不可变快照。父 work 至少保留到所有子 work、事件和文档均超过审计保留期。

## 3. 事件 reducer

HCO 对每个远端 thread/turn 使用单写 reducer 和 CAS：

1. 有稳定 remote revision 时，只接受大于当前 revision 的事件；重复 revision/digest 忽略，不同 digest 冲突告警。
2. revision 出现缺口时先持久化事件但不推进可见状态，触发只读 snapshot reconciliation。
3. terminal 是吸收事实；较旧 progress/interaction 不能把 work 拉回 ACTIVE。后到的不同 terminal 即使 revision 更高也进入 `TERMINAL_CONFLICT` 和只读对账，不能静默覆盖第一个终态。
4. terminal 到达时，尚未结算 interaction 标记为 `SUPERSEDED_BY_TERMINAL` 并通知 Hermes 关闭展示。
5. 没有稳定 revision 时，以 remote snapshot digest 对账；不能假造顺序。

`codex_events` 只保存 HCO 到 Hermes 的交接状态：

```text
PENDING_HERMES | ACCEPTED_BY_HERMES | TARGET_UNDELIVERABLE
```

Hermes 对外只提供 `ACCEPTED/PROCESSING/HANDLED/FAILED_FINAL` 和 handling outcome。Hermes 内部更细的 queue、lease、action 和 delivery 状态只能作为只读诊断，不能由 HCO 结算。

每个 event 的不可变身份是 `event_id + event_fact_digest + origin_invocation_receipt_digest + continuation_binding_digest`。HCO 另存一次 accept request 的 request/idempotency key 和 receipt；超时未知时只查询或重交完全相同的请求。Hermes durable ledger 对同一身份返回原 acceptance，对同一 key 的不同 payload 返回冲突。`continuation_ref` 指向逻辑目标且不由 HCO 刷新，因此不建立 delivery generation、delivery attempt 或 return repair 状态机。取得 acceptance 后 HCO 停止交接；Agent 回退、模型 wake 和平台 delivery 由 Hermes 原生链路处理。

事件表必须包含 `codex.cancelled`。取消调用结果不确定时先产生 `codex.unknown`；只有远端确认取消后才产生 `codex.cancelled`。

文件状态直接属于现有 document manifest，不增加独立文件 workflow 或认领聚合。两种文档模式都使用以下四个状态；只有 `managed/v1` 才附加 FileAttemptBinding、seal 和 broker epoch：

```text
STAGING | AVAILABLE | UNAVAILABLE | QUARANTINED
```

`managed/v1` 的 `FileAttemptBinding` 和对应 seal command attempt 属于 Codex work 的现有 command attempts：binding 保存 `OPEN|SEALED|REVOKED` 写能力，seal 操作复用 `PENDING|SENT|CONFIRMED|UNKNOWN|REJECTED` 远端命令状态及原 idempotency key。seal 响应未知时只能用原身份查询或重交相同 payload；未取得 `CONFIRMED` receipt 时不能创建输出 `STAGING`。`project_local/v1` 不创建 FileAttemptBinding，turn 终态后直接按模块 06 的输入/输出校验流程处理。上述两个小子状态分别回答“Codex 还能不能写”和“远端 seal 是否已确认”，不增加文件可用状态。

数据库约束必须保证 `managed/v1` 的 `file_attempt_id` 全局唯一、非空 binding 的 `command_id` 唯一。合法写能力转移只有 `OPEN -> SEALED` 和 `OPEN -> REVOKED`，`SEALED/REVOKED` 都是吸收状态；`OPEN -> SEALED` 必须与 CONFIRMED seal receipt、`resolved_file_attempt_binding_digest` 和 creator broker epoch 在同一事务核对。相同 command 的幂等重交返回原 binding，不得生成第二个 upload mount。`project_local/v1` 只要求 `work_id + direction + message_id + version` 的 manifest 唯一键。

在 `managed/v1` 中，`file_broker_epoch` 是 work owner 内不回绕的 64 位非负整数，只能在取得本机独占锁后的 owner CAS 中递增；达到实现上限时返回 `FILE_BROKER_EPOCH_EXHAUSTED` 并进入运维处置，不能归零、复用或截断比较。FileAttemptBinding 的两个 digest 只能由共享的版本化 canonical serializer 生成，HCO、transport 和恢复器不得各自实现一份字段排序或字符串拼接规则。`project_local/v1` 不创建该 epoch。

唯一键固定为 `work_id + direction + message_id + version`。两种模式都在写文件前创建 `STAGING` manifest，固定最终文件名、actor class/digest、kind、bytes、sha256、manifest digest、retention。`managed/v1` 另保存 creator broker epoch、current recovery broker epoch、FileAttemptBinding 和 seal receipt；三者缺失、状态不是 `SEALED` 或与 command/thread/turn/scope/creator epoch 不一致时，事务拒绝创建 OUTBOX `STAGING`。`project_local/v1` 不检查不存在的 seal receipt，而是在 turn 终态后复核输入未变、输出普通文件、大小/MIME/哈希正确，再把同一记录改为 `AVAILABLE`。只有 `AVAILABLE` 可以进入 input/output manifest、document access 或 event payload。

同一唯一键和相同 hash 重试返回原 manifest；同一键不同 hash 返回 `DOCUMENT_CONFLICT`，不得覆盖。所有 `STAGING -> AVAILABLE/UNAVAILABLE/QUARANTINED` CAS 都要求调用者仍持有本机独占 owner lock；`managed/v1` 还要求 manifest 的 current recovery broker epoch 等于 work 的当前 `file_broker_epoch`。`project_local/v1` 通过唯一 exchange 目录和同一 document lane 防止同名覆盖。

同一 owner 进程内，所有 work 文件变更经过单一串行 document-broker lane；进程级 owner lock 不被误当作同进程协程互斥。manifest 事务只写入 `STAGING` 或做最终 CAS，不在数据库事务中执行 seal RPC、复制、hash、rename 或其他外部 I/O。lane 在文件 I/O 期间保持占有，避免两个重试 worker 互相覆盖；进程崩溃后 lane 自动消失，持久恢复仍只依赖 manifest，`managed/v1` 额外依赖 broker epoch。

HCO 进程崩溃后，`project_local/v1` 新 owner 只恢复已有 manifest，验证 exchange 目录、输入/输出 hash 和最终文件类型；无法验证的目录转 `QUARANTINED/UNAVAILABLE`，不能认领成新事实。`managed/v1` 才按“本机独占锁 -> work owner epoch CAS -> 撤销旧 OPEN file attempt writer”的顺序接管，并要求旧 writer 停止证据；否则保持 `RECONCILING`。已 `AVAILABLE` 但文件丢失时标记 `UNAVAILABLE`；需要重传时创建新 version，不原地修复旧 receipt。

在 `managed/v1` 中，FileAttemptBinding 的 `OPEN|SEALED|REVOKED` 只表示 command attempt 的写能力，不替代 document manifest 的四个文件状态：`SEALED` 不等于可用，只有 manifest `AVAILABLE` 才能被引用。broker epoch 只是现有 work owner 的 fencing generation，不创建独立 broker 聚合。两种模式的文件名中的时间、actor 和 kind 只用于关联和诊断，不参与 work、scope、ACL 或 terminal 状态判断。首版不支持多文件代理、共享文件系统或断电恢复；这些能力不得通过增加几个状态字段后局部启用。

## 4. Topic thread、队列和 fork

- 每个 topic binding 一个主 thread，主 thread 使用 FIFO 队列和单活跃 lease。
- `NEW/CONTINUE` 默认进入主 thread 队列；`FORK` 必须由 Hermes 明确提出并记录 parent/main-thread mapping。
- 默认每 topic 最多 32 个 pending work、每 canonical root 最多 128 个；更严格项目策略可以降低，达到上限返回 `QUEUE_FULL`。
- 取消从队列移除；FIFO 不允许普通请求插队。approval/cancel/terminal reconciliation 属于控制面，不受业务队列阻塞。
- fork 只读可并行；fork 写入必须使用独立 worktree/container。合并回 canonical root 时重新取得 root write lease。

## 5. Canonical-root 单写 lease

首版默认同一 canonical root 一个直接写者，读任务可并行。lease 至少包含：

```text
lease_id, project_id, canonical_root_digest
holder_work_id, fencing_token, state
acquired_at, heartbeat_at, expires_at
```

首版 write lease TTL 默认 60 秒、heartbeat 15 秒；数据库或 worker 停顿导致 lease 过期后，仍必须完成运行时停止确认，不能仅凭时间到期把主目录交给新 writer。

需要直接写 canonical root 时，固定顺序是：预算/admission 预留 -> root write lease -> thread lease -> command intent；等待前不得持有顺序更后的 lease。取得所需 lease、work 进入可执行状态和 command intent 必须在一个本地事务中完成，失败时释放本次预留。Tool Gateway 模式在每个写操作校验 fencing token；container/worktree 模式通过隔离目录防止写主目录。

直接 workspace 写入模式下，lease 丢失先终止旧受管进程并确认其不能继续写，再把更大的 fencing token 发给新 writer。旧进程状态不明时禁止新 writer，进入 reconciliation。仅数据库 token 而没有运行时 enforcement 不算 fencing。

## 6. Route 暂停

`SUSPENDED` 必须带模式：

- `DRAIN`：拒绝新 work；已有 scope 内的 active turn 和 interaction reply 可以继续，直到完成、deadline 或取消。
- `FREEZE`：拒绝新 work、resume、fork、approval/input reply；只允许查询、远端 cancel 和对账。

`RETIRED` 前必须选择 `DRAIN_EXISTING` 或 `CANCEL_EXISTING`。取消未确认时保留 UNKNOWN，不静默迁移到其他 route。

## 7. Budget envelope

每个 root work lineage 有持久 `BudgetEnvelope`，至少包含：

```text
max_recovery_works, max_codex_turns, wall_clock_deadline
max_codex_tokens, max_codex_cost
reserved, consumed, released, budget_revision
```

`max_codex_tokens` 和 `max_codex_cost` 必须由项目 policy 明确提供；没有配置上限时，HCO 拒绝自动 `FOLLOW_UP_CODEX`，不能解释为无限。项目 policy 还可以提供全局并发和费用 hard cap。

创建恢复 work 前，HCO 用唯一 debit key 原子预留；成功后结算，确认未启动才释放，迟到 Codex usage 仍按同一 key 结算。HCO recovery 预算不足时，Hermes 仍可在自己的模型预算内生成 DELIVER/ASK/ESCALATE，但不能再创建 Codex work。Hermes continuation 模型尝试由 Bridge policy 单独限制，不复制进 HCO ledger。

模型建议不会修改 budget。多个 Agent/fork 共享同一 root lineage counters，不能各自获得一份完整预算。

## 8. Interaction 绑定

`remote_interaction_id` 为主唯一键，模型不可见的 Hermes `interaction_receipt_ref` 有唯一索引。事件重放时 Hermes 必须返回原 receipt；HCO 使用 compare-and-set 从空值绑定，已绑定不同 receipt 时冲突告警，不能覆盖。

reply command attempt 属于 interaction 聚合，遵循 `PENDING/SENT/CONFIRMED/UNKNOWN`。UI 超时不等于远端超时，不能自动回答。

## 9. UNKNOWN 的出口

UNKNOWN 具有 owner、下次对账时间、SLA 和升级目标：

- SLA 内按退避执行只读 reconciliation。
- 超 SLA 产生/更新一个 `codex.unknown` 事件，并由 Hermes 提问或通知。
- 用户或运维可选择继续观察、远端 cancel、或 `ABANDONED_UNRESOLVED`。
- `ABANDONED_UNRESOLVED` 只停止自动动作，不改变远端事实；新证据可以重新打开。

任何路径都禁止直接修改数据库把 UNKNOWN 伪装成普通 terminal。
