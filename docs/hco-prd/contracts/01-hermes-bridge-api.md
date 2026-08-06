# Hermes Bridge API 合同

适用主 PRD：0.9

## 1. 目的和边界

本合同定义 Hermes 与 HCO 之间的最小受信接口。Hermes 继续拥有 session、Agent、clarify/approval、continuation、reminder、模型调用和平台 delivery；HCO 只管理项目范围内的长期 Codex work、执行事实和文档 manifest。文档可以使用首版 `project_local/v1`，也可以在未来 capability 支持时使用严格 `managed/v1`，两者的差别见文档交换模块。

首版优先复用 Hermes 已有能力：插件工具注册、SessionStore、Agent 委派、后台 completion wake、cron/reminder、clarify/approval 和 DeliveryRouter。唯一必须新增的 Hermes 核心能力是一个公开、版本化的 external continuation adapter；它应建立在现有 completion pipeline 上，不能再建立 HCO 专用消息层。

Hermes 插件只能使用公开 API。禁止从插件调用 `_handle_message`、`_gateway_loop`、`_build_process_event_source`，禁止通过构造 synthetic `MessageEvent` 猜测目标 session。若公开能力不存在，实施必须停在实验 adapter，不能把私有调用包装后宣称合同已经满足。

## 2. 通用 envelope

每个改变状态的跨进程请求至少包含：

```json
{
  "api_version": "v1",
  "service_instance_id": "hermes-or-hco-instance",
  "audience": "hermes-bridge|hco",
  "request_id": "req_...",
  "idempotency_key": "idem_...",
  "payload_digest": "sha256:...",
  "trace_id": "trace_...",
  "issued_at": 0,
  "deadline_at": 0,
  "payload": {}
}
```

同机首选 owner-only Unix domain socket 并校验 peer UID；Windows 使用带当前服务账号 ACL 的 named pipe；同进程插件使用模型无法访问的 capability object。若必须使用 TCP/HTTP，使用 mTLS 或带 key ID 的 HMAC。认证覆盖 version、service instance、audience、request ID、idempotency key、payload digest 和 deadline；认证材料不能进入模型 prompt、工具 schema或普通日志。

`payload_digest` 使用规范化 JSON，只覆盖业务字段、opaque 引用摘要、文档 ID/version/hash 和 manifest digest，不包含 trace、发送时间、重试次数或网络 deadline。同一幂等键和相同 digest 返回第一次结果；同一键和不同 digest 返回 `IDEMPOTENCY_CONFLICT`。

通用结果：

```text
OK | ALREADY_APPLIED | REJECTED | RETRYABLE_ERROR |
IDEMPOTENCY_CONFLICT | VERSION_UNSUPPORTED | UNKNOWN
```

`UNKNOWN` 表示事务是否提交无法确定。调用方只能按原 request/idempotency key 查询或重交完全相同的请求，不能换 key 或改变 payload。

### 2.1 能力协商

`hermes_bridge_capabilities/v1` 返回 API min/max version、toolset revision、external continuation adapter revision、digest algorithm、最大 payload/document refs、project resolution、document access、interaction binding、batch status、deterministic fallback 和 HCO 文档交换能力。

文档交换能力必须分开报告，不能共用一个 `supported`：

```json
{
  "projectLocalExchange": {
    "profile": "project_local_exchange/v1",
    "supported": true,
    "maximumBytesPerExchange": 67108864,
    "maximumFilesPerExchange": 8
  },
  "managedFileExchange": {
    "profile": "local_single_broker_exchange/v1",
    "supported": false
  }
}
```

上限必须是部署 policy 允许的正整数；缺少上限时 `projectLocalExchange.supported` 必须为 `false`。`projectLocalExchange` 由 HCO document broker 自己证明，不写入 Codex App Server 的 `fileExchange` capability。`managedFileExchange` 必须直接来自 transport enforcement capability；当前 App Server 仍报告 `supported: false`。Hermes runtime 只依据受信 capability 和 document policy 选择模式，模型不看到这两个对象。

创建 managed work 时固定 bridge capability revision、选定的 document mode 和对应 profile revision。运行中升级不能原地改写旧 work；旧 revision 必须继续服务到 in-flight work drain 完成，或通过明确的兼容 adapter 处理。

## 3. 两个 opaque 引用

### 3.1 `invocation_ref`

`invocation_ref` 是 Hermes 为一次工具调用签发的短期 opaque 引用。它在 Hermes 侧绑定：

```text
caller subject/type + current authorization revision
source identity + project context state
operation + model arguments digest
request/idempotency key + toolset/capability revision
issued_at + expires_at
```

模型看不到、不能填写或覆盖该引用。模型参数和受信上下文必须使用结构分离的 `model_arguments` 与 `trusted_invocation`；模型 schema 使用 `additionalProperties=false`，两侧拒绝保留键、重复键和普通对象 merge 造成的覆盖。

HCO 通过单一 `hermes_invocation_introspect/v1` 获得最小声明，不再分别 introspect grant、source 和 invocation binding。HCO 验证 operation、model arguments digest、request、有效期、source/project 和当前授权 revision 后才执行。后续 check/respond/cancel 使用新的 invocation ref，不沿用创建 work 时的授权。

### 3.2 `continuation_ref`

`continuation_ref` 是 Hermes 为一个逻辑返回目标签发的长期 opaque 引用。它指向 Hermes 自己保存的会话来源和 Agent 回退策略，不直接指向短命的当前 Agent，也不暴露 session key、`chat_type`、平台地址或父子树。

Hermes 保证引用可解析和可验证的保留期覆盖 work、interaction、未处理事件和审计窗口；签名密钥轮换必须保留旧验证 key 到该窗口结束。Agent 存活、父/根回退和平台目标变化只更新 Hermes 内部状态，不要求 HCO 刷新引用或维护 generation chain。

HCO 加密保存原值，日志和指标只保存 keyed digest。引用被安全撤销或逻辑目标永久不存在时，Hermes 返回 `CONTINUATION_REVOKED | TARGET_GONE`；HCO 标记 `TARGET_UNDELIVERABLE`、保留事件并告警，不自行选择其他 session。

### 3.3 绑定不变量

Hermes 的 invocation receipt 必须同时记录本次 `invocation_ref` 与 `continuation_ref` digest。HCO 把 origin invocation receipt digest 和 continuation binding digest 固定进 work。后续事件必须携带这两个 digest；Hermes 拒绝把 work A 的事件交给 work B 的有效 continuation ref。

两个引用减少的是跨系统组合数量，不降低校验强度：主体、来源、项目、操作和返回目标仍在 Hermes 的一条受信 receipt 中绑定，模型不能拆分或重新组合。

## 4. 模型可见的单一工具

Hermes 注册一个 `codex` 工具。模型只负责表达语义，不选择执行后端或内部状态机，也不直接调用本合同中的 Bridge API。模型可见输入固定为：

```text
codex(
  action: start | check | respond | cancel,
  goal?, acceptance?, relationship?, work_ref?, answer?, document_refs?
) -> assistant_view
```

Hermes runtime 必须在调用 HCO 前执行 action-specific schema 校验并拒绝多余字段：`start` 要求 `goal + acceptance`，可以带 `relationship + work_ref + document_refs`；`check` 只可带 `work_ref`；`respond` 只要求 `answer`；`cancel` 要求 `work_ref`，可以带语义原因。`respond` 的 interaction receipt 和所有 action 的 invocation/continuation、幂等、来源、项目及授权字段只能由 runtime 注入。模型不能通过普通参数、嵌套对象或文档内容覆盖这些字段。

| action | 模型可提交 | 软件负责 |
| --- | --- | --- |
| `start` | goal、acceptance、可选 `relationship=auto|continue|separate`、可选相关 `work_ref`、现有文档引用或非可信项目别名 | runtime 判定 native/HCO work 和文档模式；HCO 校验项目、scope、manifest、预算、队列和幂等 |
| `check` | 可选 `work_ref` | 无引用时只返回当前来源下最相关的可见 work；不枚举其他来源，不启动 turn |
| `respond` | answer | runtime 注入当前 native interaction receipt；无唯一 active interaction 时确定性拒绝并使用 Hermes clarify，不猜“最近问题” |
| `cancel` | `work_ref`、可选语义原因 | 重新鉴权并发送一次受管 cancel；远端结果不确定时返回 `uncertain` |

`relationship` 只表达“继续已有任务”或“另开任务”的语义关系。`NEW/CONTINUE/FORK/RECOVER`、thread、queue 和 worktree 由软件根据来源、并发和恢复策略映射，模型不能直接选择。没有并发任务时默认 `auto`；同一话题已有多个可能相关 work 且无法确定时，Hermes 使用原生 clarify 提问。

runtime 路径顺序固定：`HERMES_ONLY` 拒绝任何 Codex；`PROJECT_BOUND` 进入 HCO managed work；未绑定但需要项目文件、持久恢复、interaction 或文档时先解析项目；只有真正无项目、同一 turn 内可完成的短调用走 Hermes native runtime。HCO work 内再按任务要求选择 `project_local/v1` 或 `managed/v1`；模型始终调用同一个工具，不需要知道路径名称。

大文本、附件和输出由 runtime 自动转为文档 manifest 或受限 document ref；项目内交换时由 HCO 生成 `.hco/exchanges/v1/<work_id>/<exchange_id>/` 和固定文件名，严格模式才由 enforcement adapter 提供受控目录。模型不调用独立 `document_put/result/list` 工具，也不提供 path、authority、retention 或 ACL。

### 4.1 `assistant_view`

工具结果和 external continuation 给模型的内容必须先经过软件归一化：

```json
{
  "state": "accepted|working|needs_input|completed|failed|uncertain",
  "summary": "bounded human-readable fact",
  "reason": "bounded human-readable reason-or-null",
  "work_ref": "opaque-or-null",
  "retry": "automatic|allowed|blocked|needs_user",
  "allowed_actions": ["check", "respond", "cancel", "wait", "ask_user", "deliver", "follow_up_codex", "escalate"],
  "required_user_decision": null,
  "evidence_refs": [],
  "fallback_message": "bounded redacted deterministic message",
  "incident_ref": "incident_...|null"
}
```

模型不得看到 ExecutionScope、remote command attempt、lease、fencing token、CAS generation、reducer revision、budget debit、delivery ledger 或内部 stack trace。内部 `UNKNOWN/RECONCILING` 统一映射为模型可理解的 `uncertain`，但原始事实仍保留在诊断面。

`allowed_actions` 是语义白名单：`check/respond/cancel` 对应同名工具 action；`follow_up_codex` 由 Hermes 映射为 `codex(action=start, relationship=continue)`；`wait/ask_user/deliver/escalate` 复用 Hermes 原生能力。模型输出白名单之外的动作时，runtime 确定性拒绝，不尝试猜测。

稳定内部错误必须由 Bridge/HCO 映射为 `reason + retry + allowed_actions + fallback_message`，不能要求模型解释错误码。最低映射如下：

| 内部事实 | 模型视图 | 软件允许的下一步 |
| --- | --- | --- |
| 已接收或仍正常执行 | `accepted/working` | `check/wait/cancel` |
| Codex 明确等待输入或审批 | `needs_input` | `respond/ask_user/cancel`，审批主体仍由 Hermes policy 决定 |
| 有可验证终态证据 | `completed` | `deliver/follow_up_codex` |
| 鉴权、范围、策略或参数确定性拒绝 | `failed` | `ask_user/escalate`；授权或输入修复后才能发起新的 `start` |
| Codex 明确失败且未产生不确定副作用 | `failed` | `deliver/ask_user/follow_up_codex/escalate`，是否恢复仍受预算限制 |
| 远端副作用、取消或交互结算无法确认 | `uncertain` | `check/wait/cancel/escalate`；禁止自动 `follow_up_codex` |
| Hermes 调用 HCO 失败 | 确认未送达为 `failed`；可能已送达为 `uncertain` | 使用原 request/key 查询；模型只看到可等待、查询或升级，不接收网络异常 |
| 未知内部异常 | `failed` 或 `uncertain` | 根据是否可能产生副作用确定；附 `incident_ref`，禁止模型猜测重试 |

未知错误统一附不含敏感信息的 `incident_ref`；不得把异常文本、绝对路径、token 或 Codex 原文直接放进模型上下文。Hermes facade 必须能在 HCO 无响应时生成本地 `assistant_view`：只有 transport 能证明请求未送达时才返回可重新发起的 `failed`；请求可能已经送达时返回 `uncertain`，后台只按原 request/idempotency key 查询或重交相同 payload。`assistant_view` 生成失败时，Hermes 使用本地固定模板说明“状态转换失败”、incident ref 和可查询方式，不得返回空结果。

### 4.2 受限 work handle

HCO 签发的 `work_ref` 是限定 source/project/object/operations 的 opaque handle，不是 raw work/thread ID，也不是权限本身。每次使用重新校验 invocation ref、当前 object visibility/access revision、ACL 和 policy。

handle 到期时，只有 Hermes runtime 能调用 `hco_handle_reissue/v1(old_handle, requested_operations, invocation_ref, reissue_key)`。新权限只能是旧权限、当前 invocation、对象 ACL 和当前 policy 的交集。模型丢失 handle 时，`check` 只能在当前 source/project 和当前主体可见范围内恢复最相关 work，不允许 raw ID 查找或跨项目枚举。

## 5. 项目上下文解析

`hermes_invocation_introspect/v1` 返回的 project context state 为 `UNBOUND | PROJECT_BOUND`。Zulip claims 包含最小可信 `source_namespace_id + stream_id + topic_context_id`；非 Zulip 在项目绑定后包含 opaque `project_context_ref`。`UNBOUND` 只能进入 resolver，不能创建 managed work。

非 Zulip 首次项目解析使用 `hco_project_context_resolve/v1`。模型只能提供逻辑别名候选：

- 唯一匹配：HCO 返回 resolution receipt，Hermes 保存项目绑定并为新的工具调用签发 `PROJECT_BOUND invocation_ref`。
- 多个匹配：Hermes 使用原生 clarify 展示 display label 和 opaque choice ref。
- 无匹配或无权限：确定性拒绝，不回显隐藏 project ID、root 或候选数量。

resolution receipt 绑定 resolver request/key、unbound source digest、authorization revision、alias digest、registry revision、candidate-set digest、selected project、choice digest 和 expiry。相同 key/digest 幂等；registry 或授权变化需要新的 receipt。

## 6. External continuation adapter

### 6.1 正式扩展点

Hermes 必须提供公开的 `hermes_external_continuation_accept/v1`。它可以由同进程 first-party extension 或本机 RPC 实现，但必须复用 Hermes 现有的 completion/session queue、模型 continuation 和 delivery，不得启动 HCO 专用 wake worker，也不得要求 HCO 传 platform、chat ID、`chat_type` 或 session key。

请求：

```json
{
  "event_id": "evt_...",
  "event_type": "codex.completed",
  "event_fact_digest": "sha256:...",
  "work_request_id": "work_...",
  "origin_invocation_receipt_digest": "sha256:...",
  "continuation_ref": "opaque",
  "continuation_binding_digest": "sha256:...",
  "remote_revision": "opaque-or-monotonic",
  "assistant_view": {},
  "payload_ref": "payload_...",
  "document_refs": []
}
```

Hermes 在一个本地事务中：

1. 校验 API、event fact、work/origin/continuation 绑定、文档引用和 assistant view schema。
2. 解析 Hermes 自己保存的逻辑 session/Agent 回退目标，不接受 HCO 提供的平台坐标。
3. 按 `event_id + event_fact_digest + continuation_binding_digest` 写入 durable external event ledger。
4. 按 event ID 登记一次 native continuation wake；同一事件只返回原 `acceptance_id`。
5. 提交后返回 `ACCEPTED | ALREADY_ACCEPTED`。不同 fact 或 binding digest 返回 `EVENT_CONFLICT`。

同一请求网络超时后，HCO 使用原 request/idempotency key 查询或重交完全相同的 payload。Hermes durable ledger 保证已经提交的请求返回同一 acceptance，确定性拒绝返回同一 rejection receipt。因为 continuation binding 不由 HCO 刷新，合同不需要 delivery generation、delivery attempt 或 return-ref refresh 状态机。

### 6.2 状态查询

`hermes_external_continuation_status/v1` 支持以 `acceptance_id` 或 `(event_id, request_id)` 查询：

```text
ACCEPTED | PROCESSING | HANDLED | FAILED_FINAL | STATUS_UNKNOWN
```

Hermes 内部可以保留更细的 queue/lease/action/delivery 状态，但不作为 HCO 控制面。状态至少返回最后进展时间、handling outcome 和脱敏失败类别。`ACCEPTED/PROCESSING` 超 SLA 的重排、模型 fallback 和 delivery retry 由 Hermes 完成；HCO 只告警，不接管处理。

`HANDLED` 的 outcome 可以是 `USER_DELIVERED | FALLBACK_DELIVERED | FOLLOWUP_STARTED | QUESTION_ASKED | REMINDER_SET | ESCALATED | CANCEL_CONFIRMED | SUPERSEDED`。`FAILED_FINAL` 表示 Hermes 原生处理或平台 delivery 已达到最终失败门限，必须进入 Hermes 运维告警。

## 7. Interaction 适配

HCO 保存 Codex 的 `remote_interaction_id` 和远端 revision；Hermes 保存 native clarify/approval interaction。两者以 Hermes 签发、模型不可见的 `interaction_receipt_ref` 绑定。

收到 `needs_input` 时，Hermes continuation 模型可以先使用原生 clarify，再调用 `codex(action=respond, answer=...)`。runtime 在受信 envelope 中注入 interaction receipt；HCO 校验该 receipt 绑定的 remote interaction、work、continuation、回答主体、答案类型和 revision。多个 interaction 并存且没有唯一 receipt 时拒绝，不按“最近问题”猜测。

重复相同答复返回第一次结果；同一 reply key 携带不同答案冲突拒绝。Hermes UI 超时不能代替 Codex 自动回答；只有远端明确过期、取消或终态才能关闭远端 interaction。

危险操作的可批准主体和答案类型由 Hermes native approval policy 决定。HCO 只验证受信 receipt 和项目 policy，不建立第二套审批 UI、回答主体模型或 Agent 权限树。

## 8. 文档访问

document handle 本身不是授权。Hermes continuation 需要读取结果、证据或 task contract 时，使用当前 `invocation_ref` 调用 `hco_document_access_issue/v1`：

```text
event/acceptance + work + document ID/version/hash
operation: READ_RESULT | READ_EVIDENCE | READ_TASK_CONTRACT
consumer invocation_ref + issuance idempotency key
```

HCO 在一个事务中核对 invocation、event/work、manifest ACL、version/hash、retention 和 operation，返回短期单用途 access ref。access ref 到期后以新的当前 invocation 重新申请；无权时只返回不含正文、excerpt、敏感路径或隐藏对象数量的 assistant view。缺少可读 task contract 时，Hermes 只能 ASK/ESCALATE，不能判断验收成功。

## 9. Continuation 动作

模型只返回 `DELIVER | FOLLOW_UP_CODEX | ASK | WAIT | ESCALATE` 候选。Hermes 在执行动作前持久化：

```text
continuation_decision_id
acceptance_id + decision_generation
event_snapshot_generation + action_kind + payload_digest
state: INTENT_RECORDED | DISPATCHING | CONFIRMED | UNKNOWN | SUPERSEDED
```

同一 acceptance/generation 只能有一个 action。外部动作已执行但本地确认不确定时按原 action ID 查询，不能重新调用模型生成第二个动作。`FOLLOW_UP_CODEX` 使用 decision ID 作为 HCO 子 work 幂等身份；`ASK/WAIT/DELIVER` 分别复用 Hermes native clarify、reminder 和 delivery。

## 10. 负载、兼容和降级

- 普通 Hermes 对话不加载 HCO 详细合同；只有 Codex 意图注入紧凑的单工具 schema。
- progress 由软件合并，transport retry、去重、对账、handle/document access 和预算拒绝不调用模型。
- 每个关键 event 的模型尝试默认最多 2 次、hard cap 3；超限直接使用 `assistant_view.fallback_message`。
- 每个 continuation 输入使用固定大小 assistant view 和 document handle，不注入完整 transcript 或内部 ledger。
- Hermes/HCO 升级必须通过 capability negotiation、旧 revision drain、跨版本合同测试和 rollback 演练。兼容矩阵至少覆盖当前版本和前一稳定版本。
- 升级门禁扫描插件对 Hermes 私有 `_...` 属性或方法的调用；发现即失败。
- 未知内部异常必须持久化 incident ref、返回脱敏原因并允许只读诊断。即使模型、HCO、Codex 或 Hermes delivery 任一环节失败，也不得静默结束。
