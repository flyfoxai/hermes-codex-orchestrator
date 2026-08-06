# HCO Codex 服务桥接产品需求文档

文档版本：0.4

更新日期：2026-08-04

状态：历史详细参考，尚未实现或验证；当前权威入口是 [`docs/HCO_CODEX_SERVICE_BRIDGE_PRD.md`](../../HCO_CODEX_SERVICE_BRIDGE_PRD.md) 及其模块文档，不得据此宣称已经上线

适用范围：Hermes、HCO、Zulip 路由与 Codex App Server 的统一服务桥接、上下文连续、反向交互和文档交换

文档定位：本文是 0.4 版本的完整历史快照，供拆分、追溯和迁移核对。当前产品边界以 [`docs/HCO_CODEX_SERVICE_BRIDGE_PRD.md`](../../HCO_CODEX_SERVICE_BRIDGE_PRD.md) 和 `docs/hco-prd/modules/` 下的模块文档为准。

## 1. 文档目的

本文定义 HCO 的新产品定位：HCO 不替代 Hermes 的消息层、会话层、提醒能力或多 Agent 机制，而是把 Codex App Server 包装成 Hermes 可以发现、调用、查询、继续和恢复的一项长期执行服务。

该服务同时支持两类发起方：

1. 用户通过 Hermes 提出的 Codex 执行要求；
2. Hermes 内部 Agent 在执行自己的任务时提出的 Codex 执行要求。

对于复杂上下文、规格、历史结论、日志和输出，系统必须支持通过受控文档及文档清单传递，不能要求 Hermes 或 Agent 把所有内容塞进单条 prompt。

本文只定义目标产品合同。现有 Option C 的 Zulip 数字 stream 路由、项目注册和 canonical cwd 约束是本合同的安全输入；Runner/tmux 只是迁移期兼容执行面，不是目标架构的一部分，也不得反向要求新方案保留旧消息 outbox、delivery sidecar、objective 控制面或多 Agent 协调图。

## 2. 背景与问题

Hermes 已经具备消息接收、会话管理、Agent 调用、提醒、主动恢复对话和平台投递能力。HCO 若重新实现频道路由、用户消息 outbox、提醒调度或 Agent 消息总线，会形成两套权威状态，带来重复发送、错误归属和恢复冲突。

Hermes 还已经具备 Codex App Server 的基础运行时能力，可以在一个 Hermes Agent turn 内创建并复用 Codex session、转发进度和结果。HCO 不应复制这部分已经稳定的协议客户端和事件投影代码。HCO 只补充原生同步 turn 之外的服务能力：可信项目范围、长期 work 身份、跨 turn/进程恢复、反向 interaction、事件补交和受控文档交换。

本项目真正需要解决的是 Codex 服务接入问题，同时保留 Zulip 来源与项目目录的权威绑定：

- Hermes 如何知道 HCO 提供哪些 Codex 调用方法；
- Hermes 或其 Agent 如何发起、查询、继续和取消 Codex 工作；
- 每个 Hermes 会话如何保留专用 Codex 上下文；
- Codex App Server 需要审批、补充信息或完成工作时，如何唤醒原 Hermes 会话；
- Hermes 收到完成、失败或卡住事件后，如何调用模型判断是继续调用 Codex、向用户提问、等待还是交付结果；
- 复杂上下文如何通过文档安全、完整地传给 Codex；
- HCO 或 App Server 重启后，如何找回工作和未交付事件；
- 同一 Hermes 会话同时出现多个 Codex 要求时，如何避免串任务或并发写冲突。
- Zulip 频道如何稳定映射到项目目录，且该映射如何成为 Codex 执行范围的一部分。

## 2.1 设计原则

1. **单一消息权威**：Hermes 唯一负责用户消息、会话唤醒和平台投递。
2. **单一执行范围权威**：HCO 唯一负责 Zulip 项目路由和 Codex `ExecutionScope`。
3. **单一 Codex work 权威**：HCO 只保存 Codex 长期工作的最小状态，不保存通用业务工作图。
4. **优先复用 Hermes**：会话、Agent、提醒、cron、平台 adapter、工具注册和用户交互优先调用 Hermes 原生机制。
5. **不绕过 HCO 范围检查**：来自已映射 Zulip 项目的 Codex 调用必须进入 HCO managed work，并获得有效 `ExecutionScope`；Hermes 原生 runtime 可以作为复用的执行组件，但不能成为绕开 HCO 的旁路。
6. **模型提出意图，软件执行约束**：模型可以选择调用、继续或分开任务，不能决定项目目录、权限、幂等身份或平台投递目标。
7. **简单路径保持简单**：普通 Hermes 对话和不需要长期跟踪的非项目 Codex turn 不创建 HCO work；只有需要 HCO 项目范围或长期服务语义时才进入 HCO。
8. **交互单一归属**：Codex 的远端 interaction 事实由 HCO 持久化；向谁提问、谁可以回答、超时如何展示和回答内容由 Hermes 管理。双方只通过稳定引用绑定，不各自建立一套提问状态机。
9. **终态必须被处理**：HCO 把 Codex 事件可靠交给 Hermes 后，Hermes 必须为该事件产生可审计的处理结果；不能只把事件存进内部队列而不唤醒模型或不向用户交代。

## 3. 产品定位

一句话定位：

> HCO 是带有 Zulip 来源路由的 Codex 服务适配器、上下文映射器和可靠事件桥，不是 Hermes 的替代消息层，也不是另一套多 Agent 调度器。

总体链路：

```text
人工用户
        ^
        | Zulip 频道/话题
        v
Hermes / Hermes Agent
        |
        | 可信 Zulip provenance + HCO Codex 工具合同
        v
HCO（Zulip 路由/项目范围 + Codex bridge）
        |
        | Codex App Server thread / turn / interaction 协议
        v
Codex App Server
        |
        | 状态、审批、输入请求、结果和文档
        v
HCO
        |
        | 版本化外部事件入口 + opaque return_ref
        v
Hermes 原生会话/模型/消息层
        |
        | 模型判断：继续 Codex、提问、等待或交付
        v
Hermes 原生消息层 / HCO Codex 工具
        |
        | Zulip 频道/话题、Agent mailbox 或新的 Codex work
        v
人工用户或发起 Agent
```

## 4. 产品目标

系统必须做到：

1. HCO 以版本化能力清单和工具 schema 告诉 Hermes 如何使用 Codex 服务。
2. 用户和 Hermes Agent 都可以在授权范围内发起 Codex 工作。
3. 对 Zulip 来源，一个数字频道唯一绑定一个项目 canonical root；该频道下每个话题唯一绑定一个专用 Codex 主 thread。Hermes 仍负责把消息交给正确的会话。
4. 每次具体执行拥有独立 `work_request_id`，不会把长期上下文和单次状态混为一体。
5. Hermes 可以随时查询 Codex 工作状态、最近进展、等待原因和可执行动作。
6. Codex 的审批、输入请求、失败和完成事件可以通过正式、幂等的外部事件接口主动唤醒正确的 Hermes 会话。
7. Hermes 收到事件后调用模型综合原目标、验收条件和 Codex 证据，决定继续调用 Codex、向用户提问、等待或交付；模型不可用时由 Hermes 使用确定性降级消息，不能静默丢失结果。
8. HCO 只把事实和安全降级所需的最小摘要交给 Hermes；最终如何组织语言、提醒用户和投递消息仍由 Hermes 决定。
9. 复杂输入和输出支持文档清单、完整性校验、版本和权限约束。
10. App Server 通知丢失、HCO 重启或 Hermes 暂时不可用时，可以恢复和补交事件。
11. 对结果不确定的 App Server 调用禁止盲目重复执行。
12. 对 Zulip 来源，数字 `stream_id -> project_id -> canonical_root` 是唯一目录路由；topic 只能选择该频道内唯一的上下文会话，不能选择项目或目录。
13. Codex 执行使用不可变、可校验的 `ExecutionScope`；运行时不能证明实际 cwd、sandbox 和读写根与该范围一致时必须拒绝执行。

## 5. 非目标

本方案不负责：

- 取代 Hermes Gateway、平台 adapter、会话队列或消息投递机制；
- 由 HCO 直接向 Zulip、Telegram、飞书或其他用户频道发消息；
- 在 HCO 内重新实现 Hermes 的提醒、cronjob 或多 Agent 调度器；
- 让 HCO 判断普通自然语言应如何回复用户；
- 保存或展示 Codex 的完整内部推理；
- 保证 Codex App Server thread 一定显示在 Codex Desktop 普通会话列表中；
- 让 Agent 获得超过其父会话、发起用户或项目授权的权限；
- 把任意外部文件路径直接暴露给 Codex；
- 用 prompt 约束代替路径、权限、大小和完整性校验。

## 6. 组件职责

| 组件 | 权威职责 | 明确不负责 |
| --- | --- | --- |
| Hermes | 用户消息、Agent 生命周期、意图理解、工具选择、事件后的模型综合、主动对话、提醒、交互展示和最终投递 | Codex thread/turn 协议和执行恢复 |
| Hermes bridge/plugin | 向 Hermes 注册 HCO 工具；签发可信调用凭据与 opaque `return_ref`；提供正式外部事件接收/唤醒接口 | 保存 Codex 执行权威状态、重新实现 Agent 路由或绕过 Hermes 直接发送消息 |
| HCO | Zulip 数字 stream 路由、项目注册和执行范围；Codex 能力暴露、topic/thread 绑定、work 投影、App Server 调用、远端 interaction、文档清单和事件重放 | 替代 Hermes 消息层、提醒层或多 Agent 系统；解析 Agent 树；根据模型或 topic 文本猜目录 |
| Codex App Server | thread、turn、审批、用户输入和执行事件 | 决定向哪个用户频道发送消息 |
| Codex | 项目分析、代码修改、测试和结果输出 | 判断 Hermes 会话归属或用户投递路线 |

### 6.1 Zulip 与 Codex bridge 的合并边界

Zulip 路由和 Codex bridge 在 HCO 内属于一个统一的“来源到执行范围”边界，不能拆成两个各自接受 `cwd` 的独立服务：

```text
Zulip numeric stream_id
  -> HCO project registry
  -> ExecutionScope(project_id, canonical_root, policy)
  -> Codex App Server thread/turn
```

这样做的原因是目录归属和 Codex 调用必须在同一次授权判断中完成。若拆成独立服务，第二个服务只能相信上游传来的路径字符串，容易产生项目串线和权限漂移。

这里的“合并”不表示 HCO 接管 Hermes 的消息层：Hermes 仍拥有 Zulip poll、会话、提醒、Agent 唤醒和最终投递；HCO 只验证 Zulip provenance、计算项目范围、执行 Codex 并把结构化事件交回 Hermes。

本方案采用下面的稳定映射：

| Zulip 身份 | HCO 身份 | Codex 身份 |
| --- | --- | --- |
| 数字 `stream_id` | `project_id` + `canonical_root` | 执行范围的项目根目录 |
| `stream_id + topic` 的稳定 topic identity | `topic_context_id` + `topic_binding_id` | 该话题的专用 Codex 主 thread |
| 一条 Zulip 消息 | `work_request_id` + 幂等键 | 一次 turn 或受管 fork |

频道改名不改变目录；话题改名只有在可信 Zulip continuity 事件或显式 relink 后才沿用原 `topic_context_id`。无法证明连续性时创建新话题上下文，不能按文本相似度复用旧 Codex 会话。

### 6.1.1 频道和话题管理状态

频道路由和话题策略由受信任的管理员配置或运维 API 管理，不能由模型通过普通 `codex_submit` 修改。HCO 只管理 Codex 相关的路由事实，Hermes 继续管理消息和会话。

频道路由状态：

```text
UNMAPPED -> ACTIVE -> SUSPENDED -> RETIRED
              ^          |
              +----------+
```

- `UNMAPPED`：消息由 Hermes 正常处理，HCO 不创建项目 work。
- `ACTIVE`：数字 `stream_id` 可解析到一个项目和 canonical root。
- `SUSPENDED`：禁止创建新的 Codex work；允许查询、取消、对账和处理已有 interaction。
- `RETIRED`：路由永久失效；已有 work 不静默迁移，必须完成、取消或人工恢复。

话题策略和 Codex 绑定状态分开保存：

| 字段 | 允许值 | 含义 |
| --- | --- | --- |
| `topic_policy` | `AUTO` / `HERMES_ONLY` | 是否允许 Hermes 通过 HCO 创建新的 Codex work |
| `codex_binding_state` | `UNBOUND` / `BOUND` / `STALE` | 是否已经存在有效的 `topic_context_id` 和 Codex context binding；由 HCO 派生 |

具体规则：

1. 新 topic 默认 `topic_policy=AUTO`、`codex_binding_state=UNBOUND`，不预建远端 Codex thread。
2. 第一次被接受的 `codex_submit` 才惰性创建 `topic_context_id`、`topic_binding_id` 和主 thread。
3. `HERMES_ONLY` 只阻止新建/继续 Codex work，不删除历史 work，也不阻止只读查询和已登记 interaction 的安全处理。
4. 频道项目路由更新时，相关 topic binding 进入 `STALE`；旧 scope 不得改写为新目录，必须创建新 scope 或进入人工恢复。
5. topic 改名、跨频道移动和管理员 relink 必须带有可信 Zulip continuity 证据或显式旧/新 identity；只凭相似标题、prompt 或记忆不能继承 Codex thread。
6. 频道删除或 RETIRED 后，不得把旧 topic 的 work 自动转到另一个频道；结果仍回到原 Hermes 会话或由 Hermes 指定的人工恢复目标。

管理员操作至少包括：`route_register`、`route_update`、`route_suspend`、`route_retire`、`topic_policy_set` 和 `topic_relink`。这些操作不进入模型默认工具列表，所有变更都产生新的 `route_generation` 或 `policy_revision`，并留下审计事实。

### 6.2 Hermes 原生能力复用矩阵

| Hermes 原生能力 | HCO 的使用方式 | HCO 禁止重复实现的内容 |
| --- | --- | --- |
| Gateway、平台 adapter、消息队列和 delivery | HCO 通过正式外部事件入口提交结构化事件；Hermes 原子地持久化事件并安排 wake | Zulip poller、用户消息 outbox、平台发送、消息重试 |
| `SessionStore` 和 session key | Hermes 签发 opaque `return_ref` 并自行解析目标、来源类型与回退关系 | HCO 保存或重建 session key、`chat_type`、Agent 父子路由、session expiry |
| `delegate_task`、子 Agent toolset 和父子结果回传 | 将 Agent 的可信调用上下文传给 HCO | HCO 自己的通用 Agent tree、planner、join、summary bus |
| Hermes cron、reminder、后台唤醒和外部 scheduler | Codex 事件只作为 Hermes 的唤醒输入 | HCO trigger、activation、cron ticker、提醒 outbox |
| Hermes tool catalog、tool guardrail 和 approval policy | 注册 HCO capability，并接受 Hermes 注入的身份和权限 | HCO 自己的通用工具注册、自然语言路由和用户审批 UI |
| Hermes `codex_app_server` runtime | 优先复用其 App Server transport、事件投影和用量处理；必要时由 HCO 包装成长期 work | 第二套不兼容的 App Server 协议客户端和 UI 事件投影 |

### 6.3 两种 Codex 执行路径

HCO 必须区分短期 turn 和长期服务，避免所有 Codex 请求都经过重型持久状态：

| 路径 | 适用场景 | 权威状态 | 是否创建 HCO work |
| --- | --- | --- | --- |
| `HERMES_NATIVE_TURN` | 未映射 Zulip 项目或其他普通 Hermes 对话中的短期、同一 turn 内 Codex 调用 | Hermes session 和原生 Codex runtime | 否 |
| `HCO_MANAGED_WORK` | Zulip 项目任务、跨 turn 长任务、Agent 委派的 Codex 工作、需要反向 interaction/恢复/文档清单 | App Server 执行事实 + HCO 持久投影 + opaque `return_ref` | 是 |

已映射 Zulip 项目的 Codex 请求一律进入 `HCO_MANAGED_WORK`，不得通过 `HERMES_NATIVE_TURN` 绕过 stream/project/scope 约束。两条路径不能互相静默转换。`HERMES_NATIVE_TURN` 需要转为长期工作时，Hermes 必须重新调用 `codex_submit`，由 HCO 创建新的 `work_request`；HCO 不能从普通 transcript 猜测并接管一个未登记的 Codex turn。反过来，已登记 work 也不能因为 Hermes 当前 turn 结束就被当作失败。

## 7. 发起方模型

### 7.1 用户发起

用户消息先由 Hermes 正常理解。Hermes 判断需要代码检查、项目分析、修改、测试或其他 Codex 能力时，调用 HCO 暴露的 Codex 工具。

HCO 不直接接收未经 Hermes 处理的普通用户消息，也不根据频道文本自行猜测是否应该调用 Codex。

### 7.2 Agent 发起

Hermes Agent 在执行研究、规划、审查或其他工作时，可以调用同一组 Codex 工具。Hermes 运行时在模型不可见的 envelope 中签发两个 opaque 引用：

- `caller_grant_ref`：证明本次调用主体、项目授权和可用操作；HCO 通过受信任的 `hermes_grant_introspect/v1` 或等价的签名校验只获得最小授权声明（主体类型、允许项目/操作、到期时间和 grant revision），不能获得或复制 Hermes Agent 树；
- `return_ref`：由 Hermes 自己解析的事件返回地址，内部可以指向当前 Agent，并包含 Hermes 管理的父/根回退规则、真实 session source 和有效期；HCO 只保存并原样回传。

模型不能在普通工具参数中填写或覆盖这两个引用，也不能向 HCO 传入根 session、父 session、`chat_type`、delegation path 或平台地址。Hermes 必须保留解析和刷新这些引用所需的状态，HCO 不负责猜测 Agent 是否存活或应该回退给谁。

`caller_grant_ref` 与 `return_ref` 职责不同：前者只用于本次操作授权，可以短期失效；后者用于长任务结果返回，保留期必须覆盖 work 生命周期。HCO 不得把一个引用当作另一个引用使用。

Agent 的权限不得超过根会话和发起主体的权限交集。Agent 可以请求 Codex 执行，但不能自行批准原本需要人工批准的危险操作。

### 7.3 Agent 生命周期结束

Agent 发起 Codex 工作后，Agent 可能先于 Codex 结束。HCO 必须保证：

- Codex 工作不会因为短期 Agent turn 结束而丢失；
- HCO 始终使用原 `return_ref` 提交事件，不自行选择当前、父或根 Agent；
- Hermes 解析 `return_ref` 时，Agent 仍存活就投递给该 Agent，已经结束则按 Hermes 自己的委派关系回退；
- Hermes 的回退只改变事件接收者，不改变 Codex 工作身份、权限或结果；
- `return_ref` 过期、撤销或无法解析时，Hermes 返回稳定错误，HCO 保留事件等待刷新或人工修复，不猜测新目标；
- Hermes 决定是否继续派给新的 Agent、由父 Agent 综合，或直接向用户续报。

### 7.4 Agent 调用合同

HCO capability 作为 Hermes toolset 的一部分提供给授权 Agent。Hermes 负责决定哪些父/子 Agent 获得该 toolset，并沿用原生的 toolset 继承、缩减、并发和深度限制；HCO 不接受模型自行声明 `agent_id`、父节点或权限。

Agent 调用 `codex_submit` 时只提供目标、验收条件、执行意图和文档引用。Hermes 插件在模型不可见的调用 envelope 中补充 `caller_grant_ref`、`return_ref`、可信 Zulip provenance 和 capability revision。HCO 校验 envelope 后再创建 work；HCO 的审计记录只保存发起方类型、opaque 引用的摘要/版本和授权判定，不保存 Hermes 的 Agent 拓扑。

复杂信息交换遵循以下路径：

```text
Agent 生成 Markdown/JSON 上下文
  -> codex_document_put
  -> HCO 校验并返回 document_id + version + sha256
  -> Agent 调用 codex_submit(document_refs=[...])
  -> Codex 结果以 result document manifest 返回
  -> Hermes 解析 return_ref，将结果交回存活 Agent 或执行自己的回退
```

Agent 不得通过 prompt 或普通工具参数传入 raw `cwd`、任意宿主机路径、Hermes session reference、`return_ref` 或审批身份。Agent 提前结束不会取消 HCO work；但短期 Agent 自己的 transcript、总结和父子状态仍由 Hermes 管理，不复制到 HCO。

### 7.5 定时和条件发起

时间、备忘录到期、外部状态变化或用户设定的 checkpoint 等主动条件，统一使用 Hermes 原生 cron/reminder/wake 能力：

```text
Hermes cron/reminder/condition event
  -> Hermes 恢复目标 session 或创建受管后台 session
  -> Hermes 根据上下文决定是否调用 codex_submit
  -> HCO 只处理已提交的 Codex work
  -> Codex event 回到 Hermes
```

HCO 不创建第二个 scheduler，也不根据时间自行唤醒用户或 Agent。若 Hermes 判断“暂时不需要 Codex”，该条件事件可以只在 Hermes 内部完成；若 Codex work 需要延迟续报，HCO 只返回结构化状态，续报时间和是否打扰用户仍由 Hermes 的提醒策略决定。

## 8. 核心对象

### 8.1 Hermes 返回引用

HCO 保存 Hermes 签发的不可解释引用 `return_ref`。它可以对应频道话题、私聊会话、Agent mailbox 或由 Hermes 管理的回退目标，但 HCO 看不到也不保存其中的平台坐标、`chat_type`、session key 或 Agent 父子关系。

`return_ref` 必须带版本、完整性保护、保留期和撤销语义。其可解析保留期不得短于关联 work、interaction 和未处理事件的最长保留期；路由凭据需要轮换时，Hermes 必须能够根据旧引用返回同一逻辑目标的新引用，不能让正常长任务因普通 session TTL 丢失结果。Hermes 是它的签发、解析、刷新、回退和最终消息投递的唯一权威；HCO 只在创建 work 时绑定它，在事件中原样回传，并保存不可逆摘要用于审计和去重。

### 8.2 Topic 到 Codex thread 的绑定

HCO 不再建立一套类似 Hermes session 的 `codex_context_session` 状态机，只保存恢复 Codex 上下文所需的最小 `topic_codex_binding`。对 Zulip 来源，该绑定严格按 `(numeric_stream_id, topic_context_id, project_id, canonical_root_digest)` 唯一；对非 Zulip 来源，可以使用 Hermes 签发的 opaque `context_ref + project_id`。绑定只记录：

- `topic_binding_id` 和稳定来源 identity；
- `project_id`、canonical root digest 与当前 binding generation；
- 主 Codex thread ID 及其已验证的远端 scope 证据；
- 最后一次对账 revision；
- `UNBOUND | BOUND | STALE` 派生状态。

一个频道只能绑定一个项目目录；一个频道下的每个话题只能绑定一个主 Codex thread。多个 `work_request` 可以顺序复用该 thread，但不能把互相独立或冲突的工作放进同一个活跃 turn。需要并行时创建属于该 topic 的受管 fork，并直接记录在对应 work 上，不能把 fork 图、文档清单、压缩状态或 Hermes transcript 塞进 topic binding，也不能借用其他 topic 的 thread。

### 8.3 Work Request

每次 Codex 执行创建独立 `work_request`，至少记录：

- `work_request_id`；
- `topic_binding_id` 或非 Zulip `context_ref`；
- `codex_thread_id` 和 `codex_turn_id`；
- 发起方类型 `human | agent`；
- `caller_grant_ref` 的不可逆摘要和 opaque `return_ref`；
- 不可变 `ExecutionScope` 快照；
- 用户目标、验收条件和输入文档清单；
- 幂等键；
- App Server 状态投影、等待原因、最近 progress revision 和 reconciliation 标记；
- 最终结果与输出文档清单。

### 8.4 Codex interaction 绑定

Codex 提出的审批或信息请求必须创建持久 `codex_interaction_binding`，但 HCO 不建立通用聊天提问状态机。绑定至少记录：

- App Server 签发的 `remote_interaction_id`，以及所属 work、thread、turn、item；
- 类型 `input_required | approval_required`，问题、选项、风险和相关文档的不可变快照；
- Hermes 接受事件后返回的 opaque `hermes_interaction_ref`；
- 远端状态、远端 revision、答复提交幂等键和结算证据；
- App Server 明确提供的失效时间；若远端没有截止时间，HCO 不自行虚构一个。

允许回答的用户/Agent、展示状态、提醒和 clarification 生命周期由 Hermes 管理。HCO 只接受 Hermes 通过受信接口提交、且同时绑定正确 `remote_interaction_id + hermes_interaction_ref` 的答复。

### 8.5 ExecutionScope（目录和权限的唯一执行合同）

每个 `work_request` 必须绑定一个不可变的 `ExecutionScope`。模型、普通工具参数、prompt、topic 名称和 Agent 自报字段都不能创建或修改它。

```json
{
  "scopeVersion": 1,
  "projectId": "stockprofits",
  "routeKey": "zulip:42",
  "canonicalRoot": "/Users/hula/Projects/stockprofits",
  "rootIdentity": { "dev": 1, "ino": 12345 },
  "routeGeneration": 17,
  "policyRevision": 4,
  "policyDigest": "sha256:...",
  "sandboxProfile": "project-workspace-write",
  "readRoots": ["/Users/hula/Projects/stockprofits", "/Users/hula/.hco/exchange/work_..."],
  "writeRoots": ["/Users/hula/Projects/stockprofits"],
  "expiresAt": 1780000000000,
  "scopeDigest": "sha256:..."
}
```

规则：

1. Zulip 项目路由只认数字 `stream_id`；频道名、topic、prompt 和 `cwd` 参数都不能选择项目。topic 只有在可信 Zulip provenance 中才用于解析该频道内的 `topic_context_id`。
2. 项目注册配置必须是 owner-only、非 symlink 的受信文件；项目 `cwd` 必须是绝对路径、存在的目录，并在注册时 `realpath`。
3. 每个静态或运行时 `stream_id` 只能映射一个项目；同一项目根目录不能重复注册，且不同项目根目录不能互为祖先/子目录；除非未来显式定义并审核嵌套项目策略。
4. 每次创建、继续和恢复前重新解析 route，并检查 `routeGeneration`、`policyDigest` 和根目录 `dev/ino`。任一变化都暂停并进入 reconciliation。取消已有 work 时使用其不可变原 scope 核对远端 thread 后执行，即使 route 已 SUSPENDED/RETIRED 也不能阻止安全停止；取消不能启动新 turn 或扩大访问范围。
5. HCO 向 App Server 传入的 cwd、sandbox 和文档根目录必须从 scope 派生，不能由 Hermes 或 Codex 覆盖。
6. thread 恢复或手工绑定前，必须读取并核对远端 thread 的项目 cwd、sandbox/profile（App Server 能力不足时直接拒绝绑定），不能只凭 thread ID。
7. scope 不能过期复用；范围变化必须创建新 scope 和新 work 版本，不能原地修改旧合同。
8. route 改变项目归属时，旧 topic 选择和未开始的 scope 必须在同一事务中失效；正在执行的 work 不得静默迁移到新项目，只能完成、取消或进入人工恢复。

### 8.5.1 App Server transport 的范围强制合同

现有 Hermes `CodexAppServerSession` 只向 `thread/start` 传入 `cwd`，并允许 Codex 使用本机默认 permission profile。这不足以落实 `ExecutionScope`，因此不能直接作为 `HCO_MANAGED_WORK` 的安全执行入口。

实施前必须扩展共享 transport，或在其外增加同协议的受管 adapter，并提供版本化能力 `managed_execution_scope/v1`。入口至少接受：

```text
start_or_resume_managed_turn(
  execution_scope,
  expected_thread_id?,
  input_manifest,
  idempotency_key
)
```

该入口必须满足：

1. `cwd`、read roots、write roots、sandbox profile 和交换目录全部从已验证的 `ExecutionScope` 派生，调用方不能另外传入同名覆盖字段。
2. transport 在启动 turn 前通过 Codex 原生权限、受管 subprocess/container/worktree 或 Tool Gateway 真正落实边界；只把路径写进 prompt、只设置进程 cwd 或依赖用户默认配置不算落实。
3. transport 返回 `effective_scope_attestation`，至少包含实际 canonical cwd、实际 sandbox/profile、实际读写根、隔离实例、远端 thread ID 和 scope digest。HCO 比对成功后才能把 work 标记为 ACTIVE。
4. resume、fork、reconciliation 和取消前都重新核对 thread 与 scope；thread 已存在但无法证明其有效范围时禁止继续。
5. capability 不存在或证明不足时，写任务必须确定性拒绝；只有能够物理落实只读边界时才允许显式降级为只读，不能静默退化成“仅传 cwd”。
6. transport 的 scope 校验失败、App Server 拒绝权限配置或 attestation 不一致都返回稳定错误码，并保留原始 work 进入 `RECONCILING` 或终止，不自动换后端重跑。

这项改造属于实施前置条件。PRD 中“复用 Hermes 原生 Codex runtime”是复用其协议客户端和事件投影，不表示现有 `cwd`-only 接口已经满足项目隔离要求。

### 8.6 HCO 最小持久状态

目标实现只允许保存完成 Codex 服务职责所需的六类状态：

| 状态对象 | 需要保存 | 不属于 HCO |
| --- | --- | --- |
| `project_routes` + `topic_policy` | project route、continuity/relink、generation/revision | Zulip 消息历史、频道成员管理、平台发送记录 |
| `topic_codex_bindings` | topic/context identity、主 thread、远端 scope 证据、派生 binding 状态 | Hermes transcript、session expiry、Codex 上下文摘要状态机 |
| `codex_works` | work identity、opaque `return_ref`、幂等键、不可变 scope、远端状态投影、终态证据 | 通用业务 task、Agent planner/join graph、Hermes 事件处理决定 |
| `codex_interaction_bindings` | 远端 interaction、opaque Hermes interaction 引用、答复幂等和远端结算 | 通用聊天提问、允许回答者和 Hermes clarification 状态 |
| `codex_events` | Codex event、revision、payload ref、Hermes acceptance receipt、交接重试 | 用户消息 outbox、Zulip message ID、平台 delivery attempt |
| `document_manifests` | manifest、版本、哈希、scope 和生命周期 | 用户的通用文件库或第二份项目事实源 |

`ExecutionScope` 是 `codex_works` 中的不可变快照，不是独立状态机。App Server 的 thread/turn/interaction 是执行事实源；HCO 的 work 状态是供恢复、查询和对账使用的持久投影。单一 Hermes 目标下不另建 `event_delivery` 表，Hermes acceptance 直接记录在 `codex_events` 中。

因此，新方案不得创建或迁移以下旧控制面作为目标架构：HCO 用户消息 outbox、send-only Zulip delivery sidecar、HCO cron/reminder trigger、通用 Agent activation/coordination graph、Jarvis 综合器、HCO 自有 Hermes session transcript、HCO Agent fallback tree 或第二套 clarification。迁移期需要读取旧表时必须只读，并有明确删除或停止写入的版本门禁。

## 9. HCO 向 Hermes 暴露的能力

HCO 必须通过版本化 capability manifest 和严格工具 schema 向 Hermes 暴露能力。manifest 必须同时声明：Codex 调用方法、可接受的来源类型、目录范围由 HCO 计算、禁止传入 raw `cwd`，以及 scope 失效时的确定性错误。Hermes 不应依赖一段长期静态 prompt 猜测调用方法。

建议的模型可见工具如下：

| 工具 | 用途 | 是否改变状态 |
| --- | --- | --- |
| `codex_submit` | 创建或继续 Codex 工作 | 是 |
| `codex_status` | 查询一个 work 的状态、进展和等待原因 | 否 |
| `codex_list` | 列出当前 Hermes 会话可见的 Codex 工作 | 否 |
| `codex_reply` | 回答 Codex 的输入请求或审批请求 | 是 |
| `codex_cancel` | 取消指定 Codex work/turn | 是 |
| `codex_result` | 读取终态结果、证据和输出文档清单 | 否 |
| `codex_document_put` | 创建受控上下文文档并返回文档引用 | 是 |

HCO 内部可以自动执行 `topic binding get-or-create`、thread resume/fork 和 reconciliation，不要求模型手工管理底层 thread ID。

每个工具响应必须提供：

- `work_request_id` 或相关资源 ID；
- 当前状态；
- 本次操作是否已经接受；
- 下一步可执行动作；
- 是否需要等待用户、Agent、Hermes 或 Codex；
- 稳定错误代码；
- 可供 Hermes 展示的简短事实，不直接包含用户平台发送指令。

`codex_reply` 的模型可见参数只包含 `hermes_interaction_ref` 和答复内容；Hermes 插件根据自己的绑定补充 `remote_interaction_id`、`responder_grant_ref` 和答复幂等键。`codex_submit` 的重试/恢复调用同样必须由 Hermes 注入稳定 `continuation_decision_id`，模型不能自行制造重试次数或绕过预算。

### 9.1 能力提示

Hermes 应在以下时机获得紧凑能力提示：

- Hermes profile 或插件加载时；
- HCO 能力版本变化时；
- 当前会话第一次出现 Codex 相关意图时；
- work 的远端状态进入 `WAITING_INPUT`、`WAITING_APPROVAL` 或终态时。

提示内容只说明当前可用工具、适用场景和关键限制。事件触发的 continuation turn 还必须明确提醒模型：它可以查询原 work、读取结果、回答 interaction、在软件预算内发起后续 Codex work，或者使用 Hermes reminder 等待；不能让模型因为不知道这些能力而直接结束会话。该提示不应把完整 PRD、状态表或 App Server 协议反复塞进每个模型 turn。

## 10. 执行前流程

```text
用户或 Agent 提出 Codex 要求
  -> Hermes 理解目标并选择 codex_submit
  -> Hermes 运行时注入 caller_grant_ref、return_ref 和可信来源
  -> HCO 以数字 stream ID 解析 Zulip 路由（非 Zulip 来源使用已签名项目授权）
  -> HCO 创建并封存 ExecutionScope
  -> HCO 校验权限、幂等键、根目录身份、sandbox 和文档
  -> HCO 查找或创建 topic 到 Codex thread 的最小绑定
  -> HCO 决定 resume、queue、fork 或 new thread
  -> HCO 创建 work_request
  -> HCO 通过 managed_execution_scope/v1 调用 Codex App Server
  -> HCO 核对 effective_scope_attestation
  -> 返回 work_request_id 和初始状态给 Hermes/Agent
```

`codex_submit` 必须快速返回已接受或明确失败，不能为了等待长任务完成而无限占用 Hermes 工具调用。实现可以提供有上限的短等待；超过上限后必须返回 handle，由事件或 `codex_status` 继续跟踪。

## 11. 执行中流程

Hermes 或 Agent 可以随时调用 `codex_status`。状态查询必须是只读操作，不得隐式重试 turn、创建新 thread 或改变审批决定。

Codex App Server 的状态和通知由 HCO 归一为以下事件：

| 事件 | 含义 | Hermes 动作 |
| --- | --- | --- |
| `codex.progress` | 阶段变化或有意义的进展 | 按用户偏好决定是否续报 |
| `codex.needs_input` | Codex 缺少继续执行所需信息 | 唤醒原会话；模型判断能否从已有上下文回答，否则向有权限主体提问 |
| `codex.approval_required` | Codex 请求执行受控操作 | 唤醒原会话；展示风险并只接受有权限主体的明确决定 |
| `codex.completed` | 已获得终态结果或部分完成证据 | 唤醒原会话；模型对照原目标和验收条件，决定交付或发起有界后续 Codex work |
| `codex.failed` | 执行明确失败 | 唤醒原会话；模型判断更换方法重试、向用户提问或如实交付失败 |
| `codex.cancelled` | 已确认取消 | 告知取消结果 |
| `codex.unknown` | 调用结果或外部副作用不确定 | 禁止盲目重试，进入 reconciliation |

HCO 收到反向事件后必须：

1. 先持久化并去重；
2. 读取 work 绑定的 opaque `return_ref`，不自行解析会话或 Agent 回退目标；
3. 通过 Hermes 正式外部事件入口提交 `event_id + return_ref + payload/document refs`，不直接写 Hermes 内部数据库；
4. Hermes 在同一原子操作中持久化事件、解析正确 session source 并登记一次逻辑 wake；
5. Hermes 返回 acceptance receipt 后，HCO 才标记事件已经交付给 Hermes；
6. 用户平台上的实际发送、重试和确认继续由 Hermes 管理。

HCO 可以保存“等待交给 Hermes 的事件”，但不能保存或发送“等待发给 Zulip/用户的消息”。前者是服务事件桥，后者属于 Hermes 消息层。

### 11.1 Hermes 收到事件后的判断闭环

Hermes 接受 `needs_input`、`approval_required`、`completed`、`failed`、`cancelled` 或 `unknown` 后，必须创建一次由 `event_id` 去重的 continuation turn。给模型的上下文至少包括：

- 原始目标、验收条件和用户最新约束；
- Codex 状态、结果摘要、错误、测试/修改证据和文档引用；
- 已有 work 与恢复尝试次数；
- 软件计算的剩余次数、时间、token/费用和权限预算；
- 当前允许的动作及其稳定工具引用。

模型只负责语义判断，可以选择：

| 判断结果 | 后续动作 |
| --- | --- |
| `DELIVER` | Hermes 综合事实并回复用户或上级 Agent |
| `FOLLOW_UP_CODEX` | Hermes 生成新的 `continuation_decision_id`，在预算内调用 `codex_submit` 创建后续 work，并绑定下次检查点 |
| `ASK` | Hermes 创建/复用自己的交互，向有权限主体提问 |
| `WAIT` | 使用 Hermes 原生 reminder/cron 安排下一次检查，不要求 HCO 建 scheduler |
| `ESCALATE` | 说明失败、风险或不确定性，把选择交给用户 |
| `NO_MESSAGE` | 只允许用于被更新事件取代等明确情况，必须记录原因，不能用于掩盖终态 |

每个被接受的关键事件必须在 Hermes 内形成一个终结处理结果：`USER_DELIVERED | AGENT_DELIVERED | FOLLOWUP_STARTED | QUESTION_ASKED | REMINDER_SET | ESCALATED | SUPERSEDED`。这是 Hermes 的事件处理状态，不复制到 HCO work 状态机；但必须能够通过 Hermes 诊断接口按 `acceptance_id` 查询，防止出现“事件已经接住，但没有后续”的静默停滞。

Codex 文本、日志和文档都必须作为“不受信任的任务证据”放入 continuation 上下文，不能作为 system 指令拼接。Codex 输出中即使写着“请扩大权限”“忽略预算”或“直接回复成功”，也不能改变允许动作、重试预算、审批规则或验收条件；这些由 Hermes system context 和 HCO 软件校验决定。

### 11.2 重试边界与确定性降级

必须区分两种重试：

1. HTTP/进程重连、事件补交等基础设施重试由软件按幂等键执行，不调用模型，也不创建新 Codex work。
2. 更换思路、补充上下文或再次执行 Codex 属于语义重试，由 Hermes 模型建议，并创建新的关联 work。旧终态不可改写。

语义重试必须同时带 `parent_work_request_id`、`caused_by_event_id` 和 Hermes 签发的 `continuation_decision_id`。HCO 对三者组合去重，并执行最大次数、累计时间、费用/token、权限、未知副作用和取消不确定性限制。模型不能提高这些上限；`UNKNOWN/RECONCILING`、权限扩大、不可逆外部操作或预算耗尽时不得自动重试，必须询问或升级给用户。

`FOLLOWUP_STARTED` 只有在新 work 已被 HCO 接受并保存 child work ID 后才成立。Hermes 必须为 child work 继承原 `return_ref` 并使用原生 reminder/checkpoint 监控；连续恢复次数或累计静默时间达到软件阈值后，必须向用户续报或升级，不能用不断创建后续 work 的方式永久推迟交付。

HCO 必须不依赖模型地生成结构化 `safe_fallback_summary`：工作 ID、软件确认的状态、经过大小限制和转义的结果/错误摘要、软件判断的重试门禁、可查询动作和需要用户决定的事项。Codex 自报的“安全”“已完成”只能作为证据字段，不能直接变成软件结论。

如果 Hermes 模型调用超时、不可用或连续失败，Hermes 自己的事件处理器使用该结构化事实渲染确定性降级消息。该消息仍通过 Hermes 原生消息层发送；HCO 不直接联系用户。降级消息进入 Hermes 持久 delivery 后记为 `USER_DELIVERED` 或 `ESCALATED`，不能因为模型失败而无限重新唤醒。这保留了“Hermes 模型综合 + HCO 确定性事实降级”双通道，同时不建立第二套用户消息层。

## 12. 审批与主动提问

当 Codex 请求信息或审批时：

```text
Codex App Server interaction
  -> HCO 按 remote_interaction_id 持久化远端事实并产生事件
  -> Hermes 原子接收事件，创建/复用 Hermes interaction
  -> Hermes 返回 hermes_interaction_ref 并触发 wake-up
  -> HCO 保存 remote_interaction_id <-> hermes_interaction_ref 绑定
  -> Hermes 结合会话上下文向用户或上级 Agent 提问
  -> 回答进入 Hermes
  -> Hermes 调用 codex_reply(hermes_interaction_ref, answer/decision)
  -> 插件附加 remote_interaction_id、responder_grant_ref 和答复幂等键
  -> HCO 校验引用配对、远端状态和授权证明
  -> HCO 恰好一次地回复 App Server
  -> Codex 继续执行
```

恢复和并发规则：

1. `(backend_id, remote_interaction_id)` 在 HCO 唯一；同一 `event_id` 在 Hermes 只能创建一个 `hermes_interaction_ref`。
2. 重复相同答复返回第一次结算结果；同一幂等键携带不同内容，或 interaction 已被另一答复结算时，必须冲突拒绝，不能覆盖。
3. Hermes 的 UI/提醒超时不能替 Codex 自动回答。只有 App Server 明确过期、turn 终止或取消确认后，HCO 才关闭远端 interaction，并向 Hermes 发送对应 resolution 事件。
4. HCO 重启后从 App Server 对账远端状态；Hermes 重启后按 `event_id` 和 `hermes_interaction_ref` 恢复展示。任一侧暂时不可用时，另一侧保留自己的事实，不猜测对方已经回答。
5. Hermes 必须先验证回答主体和原会话权限；HCO 再校验本次答复专用的 `responder_grant_ref`。两层检查的职责不同，不是两套用户交互状态机。

Agent 可以回答普通技术信息问题，但以下情况默认必须由有权限的人确认：

- 扩大文件、网络、凭据或项目访问范围；
- 修改审批策略或 sandbox；
- 执行不可逆或外部副作用操作；
- 用户明确要求人工确认的决策；
- Agent 的权限不足或来源无法验证。

## 13. 执行后流程

Codex 完成后，HCO 必须保存：

- 最终状态和终态证据；
- Codex 最终文本；
- 修改文件和测试结果；
- token、时间和模型等可用统计；
- 输出文档清单；
- 尚未满足的验收条件；
- thread、turn 和 work 引用。

随后 HCO 产生 `codex.completed` 或 `codex.failed` 事件并插入 Hermes。Hermes 负责：

- 解析 `return_ref`，由 Hermes 自己判断交给存活 Agent、回退目标还是主用户会话；
- 调用模型对照原目标、验收条件和证据判断是否真的完成；
- 决定使用新方法发起有界的后续 Codex work、向用户提问、设置 Hermes reminder，或生成用户可读回复；
- 模型不可用时使用第 11.2 节的确定性降级消息；
- 通过自己的消息层发送到原用户会话。

HCO 不直接生成平台命令，不绕过 Hermes 发送“最终结果”。

## 14. Codex 状态投影

App Server 的 thread、turn 和 interaction 是执行状态的事实源。HCO 不再另造一套同等粒度的权威状态机，只保存以下恢复投影：

```text
SUBMITTING -> ACTIVE -> WAITING_INTERACTION -> ACTIVE
      |          |               |
      +----------+---------------+-> RECONCILING
      |          |               |
      +----------+---------------+-> TERMINAL
```

| HCO phase | 含义 |
| --- | --- |
| `SUBMITTING` | 启动调用已持久化，尚未确认远端 thread/turn 与 scope attestation |
| `ACTIVE` | 远端状态为 queued/running/cancelling 等可继续状态 |
| `WAITING_INTERACTION` | 至少一个远端 input/approval interaction 待结算 |
| `RECONCILING` | 调用结果、远端状态或副作用不确定，正在只读对账 |
| `TERMINAL` | 远端已明确 completed/failed/cancelled，并保存终态证据 |

`remote_status`、`remote_revision` 和终态原因必须原样保存，不能只剩一个 HCO phase。`UNKNOWN` 是远端调用结果或副作用不确定的事实，应投影为 `RECONCILING`，不能被当成普通 `FAILED` 后自动重试。Hermes 的 wake、模型综合、用户消息和 reminder 状态不进入该投影。

每个 Codex thread 同一时间最多一个活跃 turn，每个 work 同一时间最多一个未决启动命令。HCO 必须用事务、唯一约束和 lease 强制，不能依赖模型自觉。

## 15. 同一会话中的多个任务

每条新要求先由 Hermes 判断是否属于已有 Codex work。Hermes 可以使用自己的会话上下文、reply-to、显式 work 引用和 Agent 语义判断；HCO 不实现通用关系模型，也不根据 topic 名称猜测关系。`codex_submit` 只接受已经收敛的执行意图：

| 执行意图 | HCO 行为 |
| --- | --- |
| `NEW` | 在当前 topic context 下创建新 work；默认排队复用主 thread，需要明确并行时使用受管 fork |
| `CONTINUE` | 仅继续 Hermes 明确指定且属于当前 scope 的 work/thread |
| `FORK` | 从指定 work 创建受管 Codex fork；不能借用其他 topic 的 thread |
| `REVIEW` | 对指定结果建立只读审查 work，并固定输入文档版本 |
| `CANCEL_AND_REPLACE` | 先按授权取消旧 work，再创建新 work；取消不确定时不得静默启动替代执行 |
| `RECOVER` | 根据一个已处理的 completed/failed 事件创建新的后续 work；必须带 parent、cause 和 Hermes continuation decision 引用 |

如果 Hermes 无法判断关系，应先向用户或上级 Agent 提问，或选择 `NEW`；HCO 不负责把多个 work 组成依赖图、join、planner/evaluator 流程。跨 work 依赖只有在未来明确增加独立 Codex workflow capability 后才允许进入 HCO，不能通过扩展普通 `codex_submit` 参数临时实现。

HCO 仍必须在软件层强制以下不变量：

- 一个 Codex thread 同时最多一个活跃 turn；
- 一个 work 只能被一个有效执行 attempt 推进；
- `CONTINUE/FORK/REVIEW` 的目标 work 必须属于同一项目 scope，且目标 thread 的远端 cwd/sandbox 必须重新核对；
- 同一幂等键只能得到一个 work；
- 同一 `(parent_work_request_id, caused_by_event_id, continuation_decision_id)` 只能创建一个恢复 work，且必须通过软件预算；
- 关系意图和目标引用都不能扩大 Hermes 已授予的权限。

## 16. 文档交换能力

### 16.1 目标

复杂上下文不得全部复制进工具参数或 App Server prompt。HCO 必须支持用户、Hermes Agent 和 Codex 之间的双向文档交换：

```text
用户附件 / Hermes 上下文 / Agent 产物
  -> 受控文档
  -> document manifest
  -> Codex App Server / Codex

Codex 报告 / 日志 / 补丁说明 / 审批材料
  -> 输出文档
  -> document manifest
  -> HCO 事件
  -> Hermes
```

### 16.2 文档类型

首版默认支持能够稳定校验和读取的 UTF-8 文本类文档：

- Markdown；
- 纯文本；
- JSON；
- 项目内已有源码、配置和日志文件引用。

PDF、Office 文档、图片、音频等格式只有在运行时能力协商确认存在可靠读取链路时才能启用。不能仅凭文件扩展名假设 Codex 能正确读取。

### 16.3 文档来源

文档可以来自：

1. 项目规范工作目录内的现有文件；
2. Hermes 已验证并落盘的用户附件；
3. Hermes 或 Agent 通过 `codex_document_put` 创建的上下文文档；
4. HCO 生成的任务合同、验收条件和历史摘要；
5. Codex 生成的输出文件和报告。

HCO 管理的上下文文档必须写入 owner-only、按 work 隔离的交换目录。项目文件继续以项目规范工作目录为事实源，不复制成另一份可编辑权威文件。

### 16.4 文档清单

每个文档引用至少包含：

```json
{
  "document_id": "doc_...",
  "role": "context",
  "media_type": "text/markdown",
  "path_or_handle": "opaque-or-validated-path",
  "bytes": 1234,
  "sha256": "...",
  "source": "hermes_agent",
  "authority": "supporting_evidence",
  "version": 1,
  "required": true,
  "sensitivity": "internal"
}
```

可用 `role` 包括：

- `task_spec`：任务规格；
- `context`：复杂上下文；
- `prior_result`：历史结果；
- `evidence`：日志、数据或证据；
- `approval_material`：审批所需材料；
- `expected_output_contract`：输出要求；
- `result`：Codex 最终报告；
- `artifact`：代码或其他交付物。

`authority` 必须区分用户要求、系统合同、机器证据、Agent 候选结论和 Codex 输出。Codex 不得把 Agent 候选结论自动提升为用户要求或系统事实。

### 16.5 传给 App Server 的方式

HCO 应优先使用 Codex App Server 经能力协商确认的原生文件或输入项能力。若当前 App Server 不支持原生文档输入，HCO 可以采用受控路径引用降级：

- 将简短任务目标和文档清单放入 turn 输入；
- 明确要求 Codex 读取指定文档；
- 只提供 sandbox 可读、路径校验通过的文件；
- 不把任意宿主机路径或未校验 symlink 暴露给 Codex；
- 在提交前再次验证哈希、大小和版本。

HCO 不得虚构 App Server 尚未提供的附件 API。具体传输适配器必须由运行时 capability 决定。

### 16.6 文档更新

文档一旦绑定到已提交 turn，其清单版本和哈希不可原地修改。更新必须创建新版本，并通过新的 `codex_reply`、后续 work 或 turn continuation 显式传入。

这样可以回答“Codex 当时实际看到了哪一版上下文”，避免同一路径内容后来变化却无法审计。

### 16.7 安全限制

文档层必须实施：

- 规范根目录和路径包含检查；
- symlink 逃逸防护；
- 文件数量、单文件大小和总字节上限；
- MIME/编码验证；
- SHA-256 完整性；
- 敏感级别和日志脱敏；
- 项目与 work 隔离；
- 生命周期和安全清理；
- 输出文件重新验证，不能相信模型自报路径。

这些规则只保护被声明的文档，不能代替 Codex 运行时的文件系统隔离。执行环境还必须满足：

- `workspace-write` 等 profile 必须由受管 sandbox、容器、worktree 或 Tool Gateway 实际落实可读/可写根目录；仅传 `cwd` 或在 prompt 中提醒不能算隔离；
- `danger-full-access` 默认不属于项目执行能力，除非经过单独的运维策略、审批和风险登记；
- 不能证明物理目录边界时，工作只能降级为只读受限能力或拒绝执行；
- 同一频道的不同 topic 默认共享频道项目目录，topic 只隔离 Codex 上下文；需要文件隔离时必须使用受管临时 worktree/container，并有合并、清理和恢复策略；
- 写 lease 只能解决并发写冲突，不能替代目录越界防护。

现有 [ARTIFACT_PROTOCOL.md](../../ARTIFACT_PROTOCOL.md) 可作为项目输入/输出文件校验基础。实现时应扩展出上下文文档 profile，而不是另建一个互不兼容的文件协议。

## 17. 可靠性与恢复

### 17.1 幂等

以下操作必须有稳定幂等键：

- 创建 work；
- 启动 turn；
- 回答 interaction；
- 取消 work；
- 接收 App Server 事件；
- 把事件交给 Hermes。

状态查询和结果读取为只读操作，不使用查询触发隐式写入。

最低唯一约束如下：

| 操作 | 唯一身份 |
| --- | --- |
| 创建普通 work | Hermes 请求幂等键 + project/scope digest |
| 创建恢复 work | `parent_work_request_id + caused_by_event_id + continuation_decision_id` |
| 启动远端 turn | `work_request_id + start_command_revision` |
| 接收 App Server 事件 | backend + thread + turn + item + event type + remote revision |
| 回答 interaction | `remote_interaction_id + hermes_interaction_ref + reply_idempotency_key` |
| 取消 work | `work_request_id + cancel_command_revision` |
| Hermes 接收事件 | `event_id` |

同一幂等身份携带不同 payload digest 必须返回冲突，不能把后到内容当成重复成功。创建 work、登记未决远端命令和写入 outbox/event 必须使用本地事务；远端调用无法与本地数据库共用事务时，先持久化命令意图，再调用远端，最后确认结果。进程在中间崩溃时进入 reconciliation，不能重新猜测执行。

### 17.2 App Server 事件

HCO 优先消费 App Server 主动通知。因为通知不应被假设为 exactly-once，HCO 必须使用 thread、turn、item、事件类型和 revision 等稳定身份去重。

### 17.3 对账

当通知中断、HCO 重启或 work 长时间没有变化时，HCO 使用低频、受预算控制的状态查询进行 reconciliation。对账用于发现状态差异，不用于无条件重新执行任务。

### 17.4 Hermes 暂时不可用

Hermes 不可用时，HCO 持久保存待交付的结构化 Codex 事件。恢复后重新尝试插入 Hermes，并在 Hermes 接受后确认。

这些记录不是用户消息 outbox。HCO 不保存平台目标、不调用平台 API，也不代替 Hermes 判断最终回复内容。

### 17.5 重启恢复

HCO 重启后必须恢复：

- topic/context 到 Codex thread 的最小绑定；
- work 投影、thread、turn 和 Codex interaction 绑定；
- 文档清单和版本；
- 未确认的 App Server 调用；
- 尚未交给 Hermes 的反向事件；
- 需要 reconciliation 的工作。

### 17.6 事件交给 Hermes 的确定性合同

HCO 与 Hermes 之间必须增加一个正式、版本化的原子入口 `hermes_external_event_accept/v1`。不能把“接受事件”和“唤醒 session”拆成两个由 HCO 依次调用的接口，否则第一步成功、第二步失败时会再次出现结果停在系统内部的问题。

```text
hermes_external_event_accept/v1(
  event_id,
  event_type,
  revision,
  return_ref,
  payload_ref/document_refs,
  payload_digest,
  safe_fallback_summary,
  wake_policy
)
  -> acceptance_id + ACCEPTED|ALREADY_ACCEPTED
  -> interaction 事件可同时返回 hermes_interaction_ref
```

Hermes 必须在一个本地事务中完成：

1. 校验 capability 版本、payload digest、文档可读性和 `return_ref`；
2. 由 Hermes 自己把 `return_ref` 解析为真实 session source，保留 platform、chat ID、`chat_type`、thread、profile 和 Agent 回退语义；
3. 按 `event_id` 持久化一份外部事件到目标 session/mailbox；
4. 按 `event_id` 登记一次逻辑 wake；interaction 事件还要创建或复用一个 `hermes_interaction_ref`；
5. 事务提交后才返回 acceptance receipt。

重复相同 `event_id + payload_digest` 只能返回原 `acceptance_id` 和原 `hermes_interaction_ref`，不能创建第二条 mailbox 事件或第二次逻辑 wake。同一 `event_id` 携带不同 digest 必须冲突拒绝。Hermes 可以把多个 progress 事件合并到一次模型 turn，但每个 completed、failed、unknown、needs_input 和 approval event 都必须有独立处理结果。

现有通过 synthetic `MessageEvent` 重新构造来源、再调用通用 `handle_message()` 的方式不能作为本合同实现。该路径可能丢失真实 `chat_type` 并唤醒错误 session。正式入口只能使用 Hermes 自己保存的 opaque `return_ref` 解析来源，HCO 不传也不猜 `chat_type`。

`codex_events` 直接保存 `event_id`、work、事件类型/revision、opaque `return_ref`、payload/document refs、投递状态、尝试次数、下一次重试时间、`acceptance_id` 和最终错误，不另建单目标 `event_delivery` 状态机。网络超时可以重交同一事件；一旦获得 acceptance receipt，HCO 不再重发，而通过 Hermes 的只读 `external_event_status(acceptance_id)` 诊断其 `ACCEPTED | PROCESSING | HANDLED | FALLBACK_DELIVERED | FAILED` 状态。

以下情况必须进入 HCO 的事件重试或人工诊断，不得直接调用 Zulip API：Hermes 不可用、`return_ref` 失效、版本不兼容、payload/document 不完整或 Hermes 拒绝接收。可刷新引用时由 Hermes 的受信插件刷新；无法刷新时标记 `NEEDS_RETURN_REF_REPAIR` 并告警，HCO 不自行挑选另一个 session。Hermes 接受事件只代表“事件与 wake 已可靠登记”，不代表模型已经处理或用户已经看到消息；后两者由 Hermes 的处理状态、重试、确定性降级和平台 delivery 负责。

Hermes 的 wake worker 必须有持久 lease、崩溃恢复和处理超时扫描。模型调用失败达到软件上限后，必须执行第 11.2 节的确定性降级；`ACCEPTED/PROCESSING` 超过 SLA 但没有处理结果时必须告警并重新排队同一逻辑 wake，不能要求用户主动查询才发现。

在 Hermes 尚未提供满足上述语义的稳定入口、处理状态查询和确定性降级前，本 PRD 只能视为未完成，不能把 HCO 的临时 HTTP 回调、拆开的 accept/wake 调用或直接写 Hermes 数据库当作等价实现。

## 18. 权限与安全

1. Hermes 是用户和 Agent 身份的权威来源。
2. HCO 只接受经过本地受控传输、版本协商和身份封装的调用。
3. 模型参数不能覆盖项目、工作目录、`ExecutionScope`、`return_ref`、`caller_grant_ref`、Agent 身份或权限范围。
4. Agent 权限交集由 Hermes 计算并签发为 `caller_grant_ref`；HCO 校验 grant 和项目策略，不保存或重算 Hermes Agent 树。
5. 审批答复必须同时绑定具体 `remote_interaction_id` 和 `hermes_interaction_ref`，不能用模糊的“同意”匹配最近请求。
6. HCO 不在日志中记录 bearer、HMAC key、凭据或未经脱敏的敏感文档内容。
7. App Server 结果不确定时 fail closed，不跨后端自动重试。
8. 文档只能在授权项目或 HCO 交换目录内读取，不能通过用户文本扩大文件范围；未声明的 Codex 文件访问也必须由 sandbox/Tool Gateway 物理限制。
9. 项目注册拒绝相同或重叠的 canonical 根目录；根目录被替换、route generation 变化或 policy digest 不匹配时，执行 fail closed。
10. thread resume 和人工 thread bind 必须验证远端 thread 的项目范围与 sandbox；不能只验证 thread ID 格式或本地数据库中尚未使用。
11. Codex 事件和文档在 Hermes continuation 中只能作为不受信任证据；事件 envelope、允许动作、预算和权限必须使用独立的受信 system 数据结构。
12. `safe_fallback_summary` 必须由结构化状态和受限字段确定性生成，进行长度限制、控制字符处理和敏感信息过滤，不能直接把 Codex 原文当成平台消息。

## 19. 可观察性

HCO 必须提供不依赖模型的只读诊断：

- capability 和协议版本；
- Codex App Server 可用性；
- topic/context 与 Codex thread 绑定；
- work 当前状态、等待原因和最后事件时间；
- thread/turn 引用；
- 发起方类型、opaque grant/return ref 的版本和摘要；
- 输入/输出文档清单及校验状态；
- 尚未交给 Hermes 的事件数；
- 已被 Hermes 接受但尚未 HANDLED/降级交付的事件数和最老等待时间；
- reconciliation 状态和稳定错误代码。

诊断接口不得触发模型调用、创建 turn 或改变 work 状态。

## 20. 性能与成本原则

- 普通 Hermes 对话不加载完整 Codex 能力文档；
- 只有出现 Codex 相关意图时才注入紧凑能力提示；
- 大上下文使用文档引用，prompt 只保留目标、关键约束和文档目录；
- `codex_status` 使用缓存或 App Server 只读查询，不启动新 Agent；
- progress 事件按阶段和重要变化合并，避免每个 delta 都唤醒 Hermes；
- 只有需要语义判断的 input/approval/terminal/unknown 事件才必须调用 Hermes 模型；普通 transport 重试、去重和对账不调用模型；
- continuation turn 使用原 Hermes 会话和一个紧凑事件包，不为每个 Codex 事件再创建 planner、reviewer 或多 Agent 流程；
- 同一 `event_id` 的模型处理有固定次数和时间上限，超过上限走确定性降级，不无限消耗 token；
- 每个 thread 只允许一个活跃 turn，独立工作使用新 thread 或 fork；
- 模型负责语义判断，软件负责身份、状态、并发、幂等和权限约束。

## 21. MVP 范围

第一阶段必须实现：

1. capability manifest；
2. `codex_submit`、`codex_status`、`codex_list`、`codex_reply`、`codex_cancel`、`codex_result` 和 `codex_document_put`；
3. 用户和 Agent 两类可信发起方，以及 Hermes 签发的 `caller_grant_ref`、`return_ref`；
4. topic/context 到 Codex 主 thread 的最小持久绑定；
5. 每个 work 的独立身份、不可变 scope 和 App Server 状态投影；
6. `remote_interaction_id <-> hermes_interaction_ref` 的绑定、恢复和恰好一次答复；
7. App Server 的审批、输入请求、完成、失败和不确定事件；
8. 原子的 `hermes_external_event_accept/v1`、事件处理状态查询、wake 恢复和确定性降级；
9. Hermes continuation turn，以及有界的交付、追问、提醒和 `RECOVER` 决策；
10. Markdown、文本、JSON 和项目文件引用；
11. 文档清单、哈希、大小、路径和版本校验；
12. Zulip 数字 stream 到项目 canonical root 的路由注册、generation 和完整性快照；
13. 版本化 `ExecutionScope`、根目录身份校验、重叠目录拒绝和 sandbox capability gate；
14. `managed_execution_scope/v1` transport 和 `effective_scope_attestation`；
15. 重启恢复、事务幂等、事件去重和低频 reconciliation。

MVP 的 App Server 实现应复用 Hermes 已有 `CodexAppServerSession`/transport 的协议客户端、事件投影和审批适配代码，但现有只传 `cwd` 的启动接口必须先扩展为 `managed_execution_scope/v1`，否则不得执行 HCO managed 写任务。若增加 HCO 专属 adapter，它必须复用相同 thread/turn/interaction 语义和事件 identity，不能另造用户可见消息协议。

### 21.1 实施前置门禁

开始业务代码改造前，必须先用接口测试或最小技术验证确认：

1. Hermes 能签发、解析和刷新 opaque `return_ref`，且 DM、群聊、Zulip topic 和 Agent 回退不会因 `chat_type` 丢失而串 session；
2. `hermes_external_event_accept/v1` 能原子完成事件入箱和 wake 登记，并能查询事件最终处理状态；
3. Hermes interaction 能返回稳定 `hermes_interaction_ref`，重启和重复事件后仍能与同一远端 interaction 配对；
4. App Server transport 能实际强制并证明 `ExecutionScope`，而不只是接收 `cwd`；
5. 模型 continuation 失败时，Hermes 的确定性降级能够通过原生 delivery 到达测试用户。

任一门禁未通过，只允许实现独立的只读查询、schema 或实验 adapter，不得宣称主动续报、受管写执行或反向审批已经完成。

首阶段可以暂缓：

- PDF、Office、图片和音频文档；
- 自动 thread compaction；
- 复杂多分支 thread 图；
- 高频流式 progress；
- 自动上传用户平台附件；
- 跨项目上下文合并。

## 22. 验收标准

### 22.1 用户发起

- 用户通过 Hermes 发起 Codex 工作后获得稳定 `work_request_id`；
- Hermes 可以查询执行状态；
- Codex 完成或失败后，即使用户没有再次发消息，Hermes 也会被唤醒；模型会对照目标判断继续 Codex、提问或续报；
- 模型不可用时，Hermes 会发送包含 work ID、事实状态和下一步的确定性降级消息；
- HCO 不直接调用用户平台发送接口。

### 22.2 Agent 发起

- Hermes Agent 可以调用 Codex 并查询状态；
- Agent 身份和权限由 Hermes 注入，模型不能伪造；
- HCO 只持有 opaque `return_ref`，不保存根/父/当前 Agent 和 delegation path；
- Agent 提前结束后，Hermes 仍能通过 `return_ref` 把 Codex 结果交给存活 Agent 或自己的父/根回退目标；
- 两个独立 Agent 的 Codex 工作不会串 thread、文档或结果。

### 22.3 反向交互

- Codex 的输入请求和审批请求可以主动唤醒原 Hermes 会话；
- 回答同时绑定准确的 `remote_interaction_id` 和 `hermes_interaction_ref`；
- 重复相同回答只结算一次，冲突回答不会覆盖已提交决定；
- 无权限 Agent 不能代替用户批准危险操作；
- HCO/Hermes 重启后，未回答 interaction 仍可继续。

### 22.4 文档交换

- 长上下文可以通过 Markdown 文档传给 Codex，而不复制进单条 prompt；
- Codex 实际读取的文档版本、哈希和来源可审计；
- 文档路径逃逸、哈希变化、超限和缺失会确定性拒绝；
- Codex 输出文档经过重新校验后才能作为结果引用交给 Hermes。

### 22.5 恢复与去重

- 重复 `codex_submit` 不创建第二个逻辑 work；
- 重复 App Server 终态事件不导致 Hermes 重复续报；
- 事件接受和 wake 登记不会出现一个成功、另一个失败的中间状态；
- Hermes 暂时不可用不会丢失 Codex 终态事件；
- Hermes 接受但未处理的事件能被状态查询和超时扫描发现，并最终重试同一逻辑 wake 或走确定性降级；
- 不确定的 App Server 调用不会被自动重复执行；
- 重复 Hermes continuation 不会创建第二个恢复 work；
- 状态查询不会改变执行状态。

### 22.6 Zulip 路由与目录范围

- 同一数字 `stream_id` 始终解析到同一个有效项目，频道改名和 topic 文本不能改变项目目录；
- 不同项目不能注册相同或互相嵌套的 canonical root；
- 请求、继续、恢复和人工 thread bind 都会重新验证 route generation、policy digest 和根目录 `dev/ino`；
- Codex 收到的 cwd、sandbox、read roots 和 write roots 都来自 `ExecutionScope`，模型或 Hermes 参数不能覆盖；
- transport 返回的 `effective_scope_attestation` 与 work scope 完全一致；不一致时 turn 不会进入 ACTIVE；
- sandbox、容器、worktree 或 Tool Gateway 无法证明目录边界时，系统拒绝启用写能力；
- 同一频道不同 topic 默认共享该频道的项目目录，但必须使用不同的 `topic_context_id`、`topic_binding_id` 和主 thread；要求文件隔离时必须显式选择受管 worktree/container；
- 频道或话题改名不能凭名称猜测继承关系；只有可信 continuity/relink 才能保留原目录或 Codex 会话；
- HCO 不直接发送 Zulip 消息，只把结构化事件交给 Hermes 原生消息层或其受信任 delivery 入口。

### 22.7 Hermes 原生复用与复杂度门禁

- 普通 Hermes 对话不会创建 HCO work、HCO trigger、HCO Agent graph 或 HCO 用户消息 outbox；
- Hermes 原生 `SessionStore`、Agent delegation、cron/reminder、platform delivery 和 Codex runtime 均有明确调用或复用证据；
- HCO 不维护第二份 Hermes transcript，不直接写 Hermes 数据库，不直接调用 Zulip 发送 API；
- HCO 不保存 Hermes Agent tree、session source 或 clarification 状态，Hermes 不复制 App Server 远端 interaction 事实；
- 短期 `HERMES_NATIVE_TURN` 与长期 `HCO_MANAGED_WORK` 的进入条件、状态权威和退出条件可通过测试区分；
- 关闭 HCO 的可选 Codex capability 后，Hermes 普通对话、原生 Agent、提醒和平台投递仍可独立工作；
- 同一任务不能因为事件重放、Agent 重试或 Hermes wake 重试而增加第二个 work、turn 或用户可见终态消息；
- terminal/interaction 事件才触发模型 continuation，progress 合并、基础设施重试和对账不会额外调用模型。

## 23. 旧方案到新方案的迁移映射

| 旧 Option C 概念 | 新方案处理 | 迁移要求 |
| --- | --- | --- |
| HCO 用户消息 outbox / Zulip delivery sidecar | 删除目标职责；改为 `codex_events` 经 Hermes 原子外部事件入口交接 | 新链路稳定前旧 sidecar 只能作为兼容面，禁止新 PRD 功能继续写入 |
| HCO objective | 改名并收敛为 `work_request` | 只保留 Codex 执行状态，不承载 Hermes 用户目标或 Agent 图 |
| HCO Hermes session/transcript / Agent fallback tree | 使用 opaque `return_ref` | 不复制 transcript、session source、delegation path，不从 HCO 解析或生成 Hermes session key |
| HCO reminder/trigger/activation | 使用 Hermes cron/reminder/wake | HCO 只接收 Codex event，不创建通用 due scheduler |
| HCO 多 Agent V2 / coordination graph | 删除为 HCO 默认能力 | Hermes 原生 Agent 负责委派和综合；只有另立产品 PRD 才能增加 HCO workflow capability |
| HCO 直接渲染最终 Zulip 文本 | 改为结构化 Codex event | Hermes 决定摘要、语言、线程位置和最终发送 |
| 两套 HCO/Hermes interaction | 远端 interaction 事实留在 HCO，展示与回答留在 Hermes，以双引用绑定 | 迁移时按 remote ID 对账；无法唯一配对的旧请求进入人工处理，不能猜测合并 |
| HCO 自有 App Server 协议投影 | 复用 Hermes Codex runtime 的协议代码，HCO 只留恢复投影 | 先补 `managed_execution_scope/v1`；只有长期 work 的恢复、幂等和远端交互允许增加包装层 |

迁移完成的判定不是“新模块已经启动”，而是：普通 Hermes 消息、Agent、提醒和投递在 HCO 停止后仍可工作；映射 Zulip 项目的 Codex work 只有一套状态权威；旧 outbox/sidecar/coordination 写路径已停用或被明确隔离。

## 24. 关键产品结论

```text
Hermes 拥有消息、会话、Agent、用户交互，以及 Codex 事件后的模型判断和确定性降级。
HCO 以统一的 Zulip 路由 + Codex bridge 向 Hermes 暴露 Codex 服务，并维护 ExecutionScope、topic/thread 绑定、work 投影和反向事件。
Codex App Server 提供 thread、turn、interaction 和执行事件。
用户与 Agent 都可以发起 Codex 调用，但权限必须来自 Hermes 的可信上下文。
复杂上下文和输出使用受控文档清单传递。
HCO 使用 opaque return_ref 和原子外部事件入口唤醒 Hermes，不替代 Hermes 向用户发送消息。
Hermes 收到结果后可以再次调用 Codex，但重试次数、费用、权限、幂等和未知副作用由软件规则限制。
```

这条边界是后续实施和评审的首要约束。任何新增能力如果要求 HCO 直接接管用户频道、Hermes 会话或 Hermes 消息重试，应视为架构越界并重新评审。
