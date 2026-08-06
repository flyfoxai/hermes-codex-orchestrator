# HCO Codex 服务桥接产品需求文档

文档版本：0.9

更新日期：2026-08-05

状态：模块化规划基线，尚未实现或验证，不得据此宣称已经上线

## 1. 定位

HCO 是 Hermes 的 Codex App Server 服务桥。它负责把可信来源映射到项目执行范围、管理长期 Codex work、传递文档和把结构化事件交回 Hermes。

HCO 不替代 Hermes 的消息层、会话层、Agent 生命周期、提醒/cron、用户交互或平台投递，也不在 HCO 内建立第二套多 Agent 调度器。

详细合同按功能模块拆分，入口见 [`docs/hco-prd/README.md`](hco-prd/README.md)。原 0.4 长文保留在 [`reference/HCO_CODEX_SERVICE_BRIDGE_PRD_FULL_0.4.md`](hco-prd/reference/HCO_CODEX_SERVICE_BRIDGE_PRD_FULL_0.4.md)，用于追溯和迁移核对；若与本版本冲突，以本 PRD 和模块文档为准。

## 2. 总体架构

```text
用户 / Hermes Agent
        |
        | Hermes runtime 注入调用引用 + 续接引用
        v
HCO 来源路由与执行范围
        |
        | topic binding + ExecutionScope + document manifest + exchange mode
        v
Codex App Server
        |
        | progress / interaction / completed / failed / cancelled / unknown
        v
HCO 事件事实与恢复投影
        |
        | hermes_external_continuation_accept/v1
        v
Hermes 原生 session / 模型 / reminder / delivery
        |
        | 交付、提问、等待或重新调用 Codex
        v
用户或发起 Agent
```

## 3. 模块边界

| 模块 | 负责什么 | 明确不负责 |
| --- | --- | --- |
| Hermes 集成 | 工具注册、可信调用 envelope、事件接收、模型续接、提醒和最终投递 | Codex 执行状态、项目目录判断 |
| 来源路由与范围 | Zulip/非 Zulip 可信来源到 project/canonical root 的映射、context binding、ExecutionScope | 消息轮询、平台发送 |
| Codex 执行 | thread/turn、work、transport、scope attestation、状态查询 | Hermes 会话和用户回复 |
| 事件与交互 | App Server 事件、向 Hermes 的交接请求、远端 interaction 与 Hermes native receipt 绑定 | Hermes wake/处理状态、通用聊天状态、用户界面 |
| Agent 调用 | Agent 授权、结果返回、Agent 结束后的 Hermes 回退 | Agent 树、planner、join |
| 文档交换 | 输入/输出 manifest、版本、哈希、路径和生命周期 | 通用文件库、第二事实源 |
| 可靠性与安全 | 幂等、事务、恢复、重试预算、审计和降级 | 自行向用户发送消息 |

Hermes、HCO 与 Codex App Server 之间使用版本化 API。HCO 内部的功能模块是逻辑边界，不要求拆成微服务；它们可以通过类型化对象、模块服务和明确的本地事务协作，不能用跨进程 API 破坏原子性。Hermes 插件只能调用版本化的公开 extension API，禁止依赖 `_handle_message`、`_gateway_loop`、`_build_process_event_source` 等私有对象。

Hermes runtime 不自动向 HCO 导出或归档完整 transcript；HCO 也不保存 Hermes session/transcript。Hermes 可以把完成任务所需的目标、约束和历史事实整理成任务最小化、不可变的 context document，再通过 manifest 交给 HCO；必要原文片段必须有硬上限、明确 provenance 和 TTL。对 Agent 主动上传的普通文档，HCO 能确定性执行来源、大小、敏感级别、访问权限和保留期，但在不读取 Hermes transcript 的前提下，不能声称能识别文本语义上是否“恰好是完整 transcript”；若业务必须禁止这种复制，必须由 Hermes 在导出侧提供 provenance/DLP 判定。HCO 可以接收只用于项目和上下文绑定的最小来源身份，例如平台类型、`source_namespace_id`、数字 `stream_id` 和稳定 `topic_context_id`；这些来源身份不能作为投递地址。HCO 永不接收平台收件人地址、发送凭据或可由自己解析的 Hermes session key。

大 payload 首选 Hermes/Codex 原生输入；没有附件接口但任务只需要普通项目目录读写时，使用 `project_local/v1`：HCO 在频道对应项目的 canonical root 内创建 `.hco/exchanges/v1/<work_id>/<exchange_id>/`，写入 `input/`，让 Codex 写入 `output/`，在 turn 终态后校验并登记 manifest。该模式复用 Codex 原有项目权限，不提供 sandbox、物理封口或写入期隔离，因此不称为 managed file exchange。任务要求强隔离、秘密材料或不可修改输入时，必须要求 `managed/v1`；当前 App Server capability 仍为 `supported: false`，此类任务明确失败。两种模式都只承载文档 payload，不替代 Hermes 消息层、session 或 reminder。

模型只看到一个压缩的 `codex` 工具，提交 `start/check/respond/cancel` 之一和语义参数。模型不构造 Bridge API 请求，也不选择 `HERMES_NATIVE_TURN` 或 `HCO_MANAGED_WORK`，不提交 execution scope、lease、fencing、retry、预算或平台地址。Hermes runtime 先按 action 校验模型参数，再在模型不可见的受信 envelope 中注入短期 `invocation_ref` 和覆盖任务生命周期的 `continuation_ref`；前者绑定本次调用的主体、来源、项目候选、操作、请求和有效期，后者指向 Hermes 自己保存的逻辑会话/回退目标。HCO 只保存这两个 opaque 引用及其摘要，不解析 Hermes session、Agent 树或平台地址。canonical root 和实际 `cwd` 由 HCO 根据可信来源及 project registry 派生；即使 prompt 或文档正文出现路径、session、身份、权限或平台地址字符串，也只能视为不受信任数据，不能提升为控制字段。

## 4. 三条主流程

### 4.1 执行前

```text
用户/Agent -> Hermes 理解目标
  -> Hermes runtime 注入 invocation_ref、continuation_ref 和调用幂等键
  -> HCO 解析项目路由并封存 ExecutionScope
  -> HCO 校验权限、幂等键、文档并选择 project_local 或 managed 模式
  -> HCO 查找/创建 topic binding 和 work
  -> project_local 使用普通项目 turn；managed 才调用 start_or_resume_managed_turn/v1
  -> managed 核对 effective_scope_attestation；project_local 校验 canonical root 和 manifest
```

### 4.2 执行中

```text
Codex event -> HCO 持久化并去重
  -> hermes_external_continuation_accept/v1 原子登记事件 + 一次 native continuation wake
  -> Hermes 调用模型或确定性处理器
  -> 提问、审批、等待、查询或继续 Codex
```

### 4.3 执行后

```text
completed/failed/cancelled/unknown -> Hermes continuation turn
  -> 对照原目标、验收条件和证据
  -> DELIVER / FOLLOW_UP_CODEX / ASK / WAIT / ESCALATE
  -> 软件限制重试次数、费用、权限和幂等
  -> 模型不可用时使用 HCO 生成的确定性事实摘要
  -> Hermes 原生消息层投递
```

## 5. 全局不变量

1. Hermes 是用户消息、会话、Agent、提醒、交互展示和平台投递的唯一权威。
2. HCO 是可信来源到项目的路由、ExecutionScope、Codex work 和 Codex 事件事实的唯一权威。
3. App Server 是远端 thread、turn 和 interaction 执行状态的事实源；HCO 状态只是恢复投影。
4. `invocation_ref` 和 `continuation_ref` 都由 Hermes 签发；HCO 只保存 opaque 值及摘要，不能解析 Agent 父子树、平台目标或 `chat_type`。
5. `continuation_ref` 指向 Hermes 的逻辑目标；Agent 存活、父/根回退和平台投递由 Hermes 解析，HCO 不刷新、不挑选替代目标。
6. 同一事件、work、turn、interaction 答复和 Hermes wake 都必须幂等；未知副作用不得盲目重试。
7. 事件接收和 wake 登记必须原子完成；HCO 不得通过 synthetic message 猜 session。
8. HCO 必须从可信路由派生 canonical root，禁止模型或调用方覆盖 `cwd`。`project_local/v1` 只证明路由、目录和文件校验正确，实际可访问范围继承普通 Codex 执行环境；只有 `managed/v1` 才承诺真实 sandbox/读写根强制和 `effective_scope_attestation`。
9. Hermes 模型可以决定下一步，但软件限制预算、权限、并发和重试链长度。
10. HCO 不直接调用 Zulip 或其他平台发送接口。
11. `UNKNOWN` 只能表示事实仍不确定；超时后可以进入 `UNRESOLVED/ABANDONED` 的本地处置状态，但不能伪装成远端成功、失败或取消。
12. 同一 canonical root 默认单写者；不能证明旧写者已停止时，不得把同一目录交给新写者。
13. 内部状态和错误必须由软件先转换为固定的 `assistant_view`；模型不负责理解异常栈、错误码目录、重试算法或状态机。
14. Codex 事件和 Hermes reminder 都进入 Hermes 原生 continuation/session queue；同一逻辑目标的重复或并发唤醒由 Hermes 原生幂等和 CAS 处理，HCO 不建立第二套调度器。
15. `project_local/v1` 只支持本机项目目录、单 HCO 实例和唯一 exchange 目录；不承诺物理隔离、断电一致性、NFS/SMB 或多个代理恢复。
16. `project_local/v1` 的输入哈希、输出类型/大小和 manifest 是软件校验，不是 App Server enforcement；输入变化、输出缺失或冲突必须显式失败。
17. `managed/v1` 才使用 `FileAttemptBinding`、物理 seal、写入期 quota、broker epoch 和 enforcement attestation；当前 capability 不支持时不得创建 managed file attempt。

## 6. 最小持久对象

HCO 有六个业务聚合：`project_routes/topic_policy`、`topic_codex_bindings`、`codex_works`、`codex_interaction_bindings`、`codex_events`、`document_manifests`。为落实幂等和恢复，聚合内部允许使用命令 attempt、thread/write lease、队列项和 work budget 等子记录；它们不是新的业务工作图，也不能拥有 Hermes 消息状态。

`ExecutionScope` 是 work 的不可变快照，不单独形成状态机；Hermes 的事件处理状态、continuation action intent、reminder 和 delivery receipt 留在 Hermes。

## 7. 实施门禁

代码实施前必须验证：

1. Hermes 能签发、解析和撤销 `invocation_ref` / `continuation_ref`，且 DM、群聊、Zulip topic 和 Agent 回退不会串 session。
2. `hermes_external_continuation_accept/v1` 能复用现有 native completion pipeline，原子登记事件和一次 wake，并查询处理状态。
3. `remote_interaction_id <-> native Hermes interaction receipt` 能在重启和重复事件后恢复；interaction handle 不暴露给模型。
4. `project_local/v1` 能核对可信 canonical root 和 manifest；若启用 `managed/v1`，transport 还必须真正强制并证明 ExecutionScope，而非只接收 cwd。
5. 模型失败时，Hermes 能通过原生 delivery 发送确定性降级消息。
6. start/reply/cancel 的远端 command attempt 能在断线后进入 CONFIRMED 或 UNKNOWN，而不是盲目重发。
7. canonical root 单写 lease、fencing 和队列在崩溃恢复后仍不会产生两个写者。
8. scope 到期、route 暂停、`continuation_ref` 失效和事件乱序都有确定性出口。
9. work A 的事件不能使用 work B 的 `continuation_ref`；HCO 必须核对 work 与原始 continuation binding digest。
10. 非 Zulip 首次项目解析、文档 access ref 过期/回退后的重新签发，都有版本化接口、幂等身份和无权时的脱敏降级。
11. `max_codex_tokens`、`max_codex_cost` 和恢复 work/turn 上限缺失时，软件拒绝自动续接，不允许模型把预算解释为无限。
12. 单一 `codex` 工具按 action 定义受信 envelope、授权重检和 source/project 过滤；`check` 不能成为跨项目枚举或读取旁路。
13. Hermes 的 interaction/clarify/approval handle 不进入模型工具参数；HCO 只保存远端 interaction 与 Hermes receipt 的绑定。
14. project registry 与 Codex 写目录隔离；HCO 对 `project_local/v1` 的 exchange 路径执行最终对象边界校验，`managed/v1` transport 还要对全部受控读写根处理 POSIX symlink/mount 和 Windows junction/reparse point。
15. continuation 必须读取实际、有界的 task contract；只有摘要或 digest 时不得判断任务已经满足验收条件。
16. Hermes facade 必须对四个 action 做 schema 正例、反例和越权字段测试；模型只提供语义字段，可信 envelope 只能由 runtime 注入。
17. 每类稳定内部失败和未知异常都必须映射为完整、脱敏、可执行的 `assistant_view`；模型不可用时仍能由 Hermes 原生 delivery 发送 fallback message。
18. `project_local/v1` 必须使用 HCO 生成的唯一 exchange 目录、固定文件名和单写 lane；发布不能依赖普通 rename 的覆盖语义，目标已存在时哈希相同复用、哈希不同隔离。
19. `project_local/v1` 的输入/输出必须经过大小、MIME、普通文件、UTF-8/JSON 和 SHA-256 校验，并在验收前后确认对象没有变化；不能用 `status.json`、文件名或目录存在替代 manifest 事实。
20. `managed/v1` 才要求每个可能产生文件输出的 command 绑定不可复用 `FileAttemptBinding`，并让 attestation、seal receipt、manifest 和导入 CAS 匹配同一 command/thread/turn/scope/broker epoch。
21. `managed/v1` transport 必须在读取 upload 前物理封口 writer，并在写入期间强制字节、文件/inode、单文件和目录深度限额；只支持 `chmod`、自报关闭或事后扫描时不得声明能力。
22. 两种模式都必须把稳定错误转换为 `assistant_view`；目录创建、输入变化、输出缺失、冲突和 capability 缺失都有确定性出口，不能静默重跑。

门禁按能力分别生效：`project_local/v1` 的 18、19、22 未通过时只拒绝项目内文档任务，不影响普通无文档 Codex 执行；`managed/v1` 的 20、21 未通过时 capability 必须保持 `supported: false`。Hermes external continuation、主动续报或反向审批对应的门禁未通过时，不能宣称这些能力已经完成。

## 8. 模块文档

- [Hermes 集成与续接](hco-prd/modules/01-hermes-integration.md)
- [来源路由与项目范围（含 Zulip）](hco-prd/modules/02-zulip-routing-and-scope.md)
- [Codex 执行与状态](hco-prd/modules/03-codex-execution.md)
- [事件、审批与交互](hco-prd/modules/04-events-and-interactions.md)
- [Agent 发起 Codex](hco-prd/modules/05-agent-codex-calls.md)
- [文档交换](hco-prd/modules/06-document-exchange.md)
- [可靠性、安全与观测](hco-prd/modules/07-reliability-security.md)
- [验收、性能与迁移](hco-prd/modules/08-acceptance-performance-migration.md)

接口和事务合同：

- [Hermes Bridge API](hco-prd/contracts/01-hermes-bridge-api.md)
- [Codex Transport API](hco-prd/contracts/02-codex-transport-api.md)
- [状态、事务与资源合同](hco-prd/contracts/03-state-transactions.md)
