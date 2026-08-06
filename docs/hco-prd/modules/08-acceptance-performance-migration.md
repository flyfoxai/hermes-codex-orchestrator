# 08 验收、性能与迁移

## Hermes 原生能力复用矩阵

| 能力 | 归属与实施方式 | 禁止事项 |
| --- | --- | --- |
| 工具注册、toolset 和 Agent 工具继承 | 直接复用 Hermes plugin `register_tool` 和原生 toolset policy | HCO 不建立第二套工具注册或 Agent ACL |
| session、来源、频道/话题和 transcript | 直接复用 Hermes SessionStore/SessionSource | HCO 不复制 transcript，不生成 session key |
| Agent 委派、父子关系、并发和结束回报 | 直接复用 Hermes delegate/async delegation | HCO 不保存 Agent 树、planner 或 join graph |
| cron、reminder 和 wait | 直接复用 Hermes scheduler | HCO 不建立提醒表和定时 worker |
| clarify 和危险操作 approval | 复用 Hermes native UI/policy，增加 remote interaction receipt 薄适配 | HCO 不渲染按钮，不判断谁可批准 |
| 模型调用、provider fallback 和 continuation budget | 直接复用 Hermes runtime | HCO 不维护 Hermes 模型账本 |
| 平台 delivery 和最终失败告警 | 直接复用 Hermes DeliveryRouter/ledger | HCO 不调用 Zulip 或其他平台 API |
| 后台完成后主动唤醒会话 | 在 Hermes 现有 completion pipeline 上增加公开 external continuation adapter | 插件不调用 `_handle_message` 等私有 API，不建立 HCO wake worker |
| 项目路由、ExecutionScope、Codex work、远端对账、文档 manifest、写 lease 和 Codex budget | HCO 自己负责 | 不把这些状态交给模型或 Hermes transcript |
| `project_local/v1` 交换目录、固定命名、输入/输出校验和单写 lane | HCO document broker 使用项目 canonical root 内的既有权限 | 不把项目目录协议称为 sandbox，不要求 App Server 伪造 managed capability |
| FileAttemptBinding、command/seal ledger 和 work owner/broker epoch | HCO work controller 使用既有 Codex work 聚合 | 不让 document broker 生成远端 command 身份，不新建 file-attempt 业务聚合 |
| `managed/v1` 的 Codex sandbox/mount、upload 写入期限额和 file-attempt 物理封口 | 由版本化 transport enforcement adapter 强制并返回 attestation/seal receipt；当前 capability 为 `supported: false` | HCO 不根据 Codex 自报或路径猜测封口，Transport 不拥有 manifest、Hermes session 或用户投递 |
| 文件命名、目录锚定读取、普通文件校验、复制、发布和恢复 | HCO document broker 使用既有 work/manifest 子记录 | 不创建第二套文件队列，不让 Transport 决定文档 authority/ACL/可见性 |

复用的含义是使用 Hermes 的正式公开合同，不是复制源码或调用私有属性。Hermes 当前只有内部 completion wake、没有稳定 external continuation 插件入口时，该项状态是“需要薄扩展”，不能标成“原生已满足”。

## 实施前置门禁

开始业务代码修改前必须验证：

1. Hermes 能签发、解析和撤销 `invocation_ref` / `continuation_ref`，DM、群聊、Zulip topic 和 Agent 回退不会串 session。
2. `hermes_external_continuation_accept/v1` 使用公开 API 复用 native completion pipeline，原子登记事件和一次 wake，并能查询处理状态。
3. 插件静态扫描和运行测试均不调用 Hermes 私有 `_...` 方法或属性。
4. 单一 `codex` 工具的 schema 只暴露 `start/check/respond/cancel` 语义字段；可信引用、路径、权限、重试和内部状态不可见。
5. `remote_interaction_id <-> native interaction receipt` 在重启、重复事件和多个并存问题下仍能准确配对。
6. 普通 project turn 能确认 HCO 派生的 canonical root；若启用 `managed/v1`，transport 还必须声明 `managed_execution_scope/v1`，且 `start_or_resume_managed_turn/v1` 真正强制并证明 cwd、sandbox 和 read/write roots。
7. Hermes 模型失败后能通过原生 delivery 发送 `assistant_view.fallback_message`。
8. external continuation、start/respond/cancel 的 schema、错误码、幂等、超时查询和版本兼容通过跨模块合同测试。
9. root 单写 lease、fencing、FIFO queue、budget debit 和 event reducer 的崩溃/并发测试通过。
10. `hco_project_context_resolve/v1` 的唯一匹配、歧义选择、授权变更和 choice 过期不会让模型选择 raw project ID 或路径。
11. 缺少 `max_codex_tokens` 或 `max_codex_cost` 时，软件拒绝自动恢复，不把缺失预算当作无限。
12. command 查询只有在后端 ledger 可证明 `NOT_FOUND` 时才允许判定未执行；不可证明时保持 `UNKNOWN`，不得换 key 重发。
13. 每个内部错误码都能映射为完整 `assistant_view`；未知异常产生 incident ref 和 fallback message，不会被吞掉。
14. 四个 action 的模型输入正例、缺字段、多余字段、保留字段注入和嵌套覆盖测试全部通过；非法调用在进入 HCO 前被 Hermes runtime 确定性拒绝。
15. Codex 事件与原生 reminder 并发到达时，同一 event snapshot generation 只产生一个有效 handling intent；更新的 Codex 事实开启新 generation，过期模型候选和重复终态投递被 CAS 阻止，但等待提醒不能吞掉后到终态。
16. HCO 连接拒绝、响应丢失和响应 schema 损坏时，Hermes facade 都返回本地、脱敏的 `assistant_view`；可能已送达的写请求保持 `uncertain` 并只用原请求身份查询。
17. HCO 只有在 document broker、正数文件/字节上限和 canonical root 校验全部可用时才声明 `project_local_exchange/v1 supported=true`；该声明与 App Server 的 managed `fileExchange.supported` 分离。项目内模式能独占创建唯一 exchange 目录，且固定文件名、普通文件类型、大小、MIME、UTF-8/JSON 和 SHA-256 校验通过。
18. `project_local/v1` 的同名文件不会被覆盖；相同键/hash 复用，不同 hash 隔离；进程恢复只处理已有 manifest，目录扫描不能认领新消息或触发 wake。
19. `project_local/v1` 的输入被修改、必需输出缺失、输出在验收期间变化、输出类型/大小不合法或目录不可写时，都能生成稳定 `assistant_view` 和确定性 fallback。
20. 只有在 capability 明确支持 `managed/v1` 时，才执行独立 `exchange_root`、FileAttemptBinding、物理 seal、broker epoch 和严格 upload 校验；当前 capability 为 `supported: false` 时，强隔离任务在 execution intent 前返回 `FILE_EXCHANGE_UNSUPPORTED`。
21. `managed/v1` 的 Codex 自报关闭后继续持有写句柄的故障注入中，transport 必须先终止或撤销 writer 并生成可验证 seal receipt；seal 响应丢失时只用原 seal command 查询/重交，无法确认时保持 `RECONCILING`。
22. `managed/v1` upload 只接受根目录下单个安全文件名组件；绝对路径、`..`、子目录/递归树、FIFO、socket、device、symlink/hard-link escape 和 Windows reparse object 均被确定性拒绝。
23. `managed/v1` upload 的字节、单文件、普通文件/inode 和目录深度限额在写入时生效；Codex 不能在事后扫描前耗尽卷空间，且预留空间足以写 manifest、错误事实和 fallback。
24. `managed/v1` broker 暂停时第二 broker 不能取得本机独占锁；旧 writer 状态未知时不得新建 file attempt 或把 `STAGING` 转为 `AVAILABLE`。
25. 文档 version、路径预算和 actor digest 的轮换规则通过跨平台合同测试；这些诊断字段不能参与状态、幂等或授权。
26. HCO、transport 和恢复器只有在 `managed/v1` 开启时才使用 FileAttemptBinding canonical JSON/digest 黄金向量；未支持时不得伪造 receipt 或 capability。

普通 `project_local/v1` 门禁未通过时，拒绝该文档任务并保留普通无文件 Codex 执行；`managed/v1` 门禁未通过时，只能实现 schema、只读诊断或实验 adapter，不能宣称受管写执行或反向审批完成。

## 功能验收

`project_local/v1` 的真实 Hermes/Zulip/Codex 人工验收按 [`2026-08-05-project-local-exchange-manual-acceptance-test-plan.md`](../../superpowers/plans/2026-08-05-project-local-exchange-manual-acceptance-test-plan.md) 执行；该手册与自动合同测试配套，不能用“看到了回复”替代文件、状态和 capability 证据。

- 用户和 Agent 使用同一个 `codex` 工具创建、查看、继续、回答和取消授权范围内的 work。
- 模型不需要知道 native/managed、ExecutionScope、thread、lease、fencing、CAS、reconciliation 或 delivery ledger。
- 所有 `PROJECT_BOUND` 项目执行进入 `HCO_MANAGED_WORK`；真正无项目的短调用可走 native；`HERMES_ONLY` 两条路径都拒绝。
- 同一来源频道固定项目目录；同一频道不同 topic 使用不同 topic binding 和主 thread。
- 非 Zulip 唯一项目匹配自动绑定，歧义时使用 Hermes clarify；模型不能提供 raw root/project ID。
- 新要求到达且已有 work 未完成时，Hermes 只判断 `continue|separate` 语义关系；软件负责 queue、fork、恢复、预算和幂等。无法判断时先提问。
- 不同 invocation、source/project、work 和 continuation 不能交叉复用；work A 的事件不能使用 work B 的 continuation ref。
- 重复 start、event accept、wake、respond、cancel 和 continuation 不创建第二个 work、turn、答复或用户终态消息。
- Codex completed、failed、cancelled 或 unknown 后，无需用户再次发消息即可进入原 Hermes session；模型判断交付、提问、等待或恢复。
- 模型不可用或超预算时，Hermes 仍发送确定性状态、原因和下一步；平台最终失败进入 Hermes 运维告警。
- interaction 答复绑定远端 interaction、Hermes native receipt 和当前 responder invocation；无权限 Agent 不能批准危险操作。
- 模型只看到 `accepted|working|needs_input|completed|failed|uncertain`，内部错误全部带 human-readable reason、retryability、allowed actions 和 incident ref。
- 文档版本、哈希、路径、大小、provenance 和输出证据可审计；模型或附件不能提升 authority、ACL、scope 或控制 role。
- `project_local/v1` 的目录、文件名、对象类型、大小和哈希校验全部由软件执行；模型不提供路径或状态。`managed/v1` 额外的 file attempt、物理封口、broker 接管和 upload 限额也全部由软件执行。
- Hermes 不自动导出完整 transcript；必要片段受 provenance、单段/总量硬上限和 TTL 约束。
- work 排队期间替换 manifest 会失败；无文档权限的回退目标只收到脱敏 assistant view。
- 当前 invocation 到期或撤销会阻止后续动作；停止已启动 turn 必须走显式 cancel，不能改写本地状态冒充远端取消。
- 未知副作用不会被自动重跑；重启和 Hermes 暂不可用不会丢事件。
- scope 到期、route FREEZE、continuation ref 失效、revision 缺口和 command UNKNOWN 都有可观察、可告警的出口。
- project registry 不能被 Codex writer 改写；POSIX symlink/mount 和 Windows junction/reparse 逃逸被 transport 确定性拒绝。
- continuation 无法读取实际 task contract 时只能 ASK/ESCALATE，不能只凭摘要或 digest 判断成功。
- `check` 不能跨当前 source/project 枚举或读取 work；handle 由受信 runtime 在当前权限内重新签发，不接受 raw work/thread ID。

## 性能与模型负担

- 普通 Hermes 对话不创建 HCO work，也不加载完整 PRD。
- 只有 Codex 意图注入一个紧凑工具；模型 prompt 不包含内部 API、状态表或错误码清单。
- progress 默认 5 秒合并；transport 重试、事件去重、对账、handle/document access 和预算结算不调用模型。
- continuation 只提供固定大小 `assistant_view`、task contract 和必要 document handle。
- terminal、interaction 和长期 uncertain 才按策略调用模型；默认最多 2 次、hard cap 3，超限走确定性降级。
- 大上下文由 runtime 自动转为文档；模型不负责文档 ACL、路径、版本和生命周期。
- 大上下文优先走 Hermes/Codex 原生输入，必要时由软件写入项目内 `.hco/exchanges/v1/<work_id>/<exchange_id>/`；模型只接收相对文档引用，不生成目录名或文件名。
- 两种模式都使用现有 document manifest 的四个 file state，不创建新的文件工作流、调度器或模型调用。
- `project_local/v1` 只做确定性目录/manifest 校验；`FileAttemptBinding`、物理封口、quota 和 broker epoch 只属于未来 `managed/v1`，不增加普通项目任务的模型调用。

## 分阶段实施

| 阶段 | 范围 | 明确延后 |
| --- | --- | --- |
| Phase 0 | Hermes 公开 external continuation adapter、两个引用、单一工具 schema、合同测试 | 所有业务写执行 |
| Phase 1 | 单项目/单 topic 主 thread、start/check、项目内 `project_local/v1` 文件交换、terminal event 和 fallback | fork、多 Agent 并发、复杂 interaction、严格 `managed/v1` 文件交换 |
| Phase 2 | respond/cancel、native clarify/approval 适配、文档访问、UNKNOWN 对账和预算 | worktree merge、跨项目 workflow |
| Phase 3 | 多 Agent 并发、隔离 fork/worktree、复杂恢复和非 Zulip resolver 完整能力 | 通用 planner/join，除非另立项目 |

每一阶段都必须能独立降级：HCO 停止时 Hermes 普通消息、Agent、提醒和平台 delivery 仍可工作；未启用的 Codex 功能确定性拒绝并说明原因，不进入半执行状态。

严格 `managed/v1` 文件交换不是 Phase 3 的默认交付项。只有出现明确的强隔离、共享文件系统、多代理或断电恢复需求时，另立合同、威胁模型和验收；否则保持 `project_local/v1`，避免把 HCO 变成文件系统事务引擎。

## 升级和回滚

- Hermes/HCO capability matrix 至少覆盖当前版本和前一稳定版本。
- 新版本先通过 shadow capability probe 和合同测试，再灰度到新 work；in-flight work 固定旧 revision 直到 drain。
- external continuation adapter、单一工具 schema 或 reference validation 不兼容时，停止接收新 managed work，不中断 Hermes 普通对话。
- 回滚保留旧 adapter 和验证 key 到所有旧 work/event 超过保留窗口；不得因回滚丢弃 pending event。
- CI 和安装门禁扫描插件私有 Hermes API 依赖，发现即阻止发布。

## 迁移规则

| 旧能力 | 新归属 |
| --- | --- |
| 七个模型可见 Codex 工具 | Hermes 单一 `codex(action=...)` facade |
| 三个 grant/source/return 引用和 binding chain | `invocation_ref + continuation_ref`，详细 claims 留在 Hermes |
| HCO 用户消息 outbox / Zulip sidecar | Hermes external continuation 和原生 delivery |
| HCO mailbox wake worker / synthetic gateway message | Hermes 公开 adapter 复用 native completion pipeline |
| HCO Hermes session/transcript/Agent fallback tree | Hermes logical continuation ref，不复制 Hermes 状态 |
| HCO reminder/trigger | Hermes cron/reminder/wake |
| HCO 多 Agent coordination graph | Hermes 原生 Agent |
| HCO 直接渲染最终消息 | `assistant_view` 事实和 fallback message，由 Hermes 投递 |
| 旧 `artifact_manifest + 任意项目相对路径` | 迁移为 HCO 自动生成的 `project_local/v1` exchange 目录；旧接口只保留显式兼容开关 | 不让模型或调用方继续选择任意路径，不把事后校验称为 managed |
| 旧 App Server adapter | 复用协议代码并补 managed scope、attestation 和 command UNKNOWN 对账 |

迁移完成的标准是：HCO 停止后 Hermes 普通消息、Agent、提醒和平台投递仍能工作；Codex 项目执行只有一套状态权威；旧 outbox、sidecar、私有 gateway 调用和 coordination 写路径已停止。
