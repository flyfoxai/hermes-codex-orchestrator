# Hermes Codex Orchestrator 历史实施基线

> **文档状态：LEGACY / 兼容与迁移参考，不是当前目标方案的产品权威。**
>
> 当前目标 PRD 是 [`docs/HCO_CODEX_SERVICE_BRIDGE_PRD.md`](docs/HCO_CODEX_SERVICE_BRIDGE_PRD.md)。它将 Hermes 设为消息、会话、Agent、提醒和用户投递的唯一权威，并把 HCO 收缩为 Zulip 项目范围 + Codex App Server 长任务桥。本文中的 HCO outbox、Zulip delivery sidecar、HCO reminder/trigger、通用多 Agent coordination graph 和 HCO Hermes session 状态属于历史 Option C 或实验性设计，除非新 PRD 明确保留，否则不得继续作为新功能实现依据。
>
> 本文保留的目的：记录现有实现、迁移约束、兼容 runner/tmux 和已知回滚信息。若本文与新 PRD 冲突，以新 PRD 为准；任何代码实现前必须先完成职责迁移和旧控制面停写门禁。

文档版本：2.2-legacy
更新日期：2026-08-04
状态：历史实施基线；不得作为新方案或新功能的权威依据
历史主方案：Option C（Hermes bridge + HCO + Codex App Server）
历史兼容方案：Runner/tmux（仅用于旧部署、测试夹具和显式回滚）

## 1. 文档目的

本文记录历史 Hermes Codex Orchestrator（HCO）Option C 的产品合同、生产边界、用户交互、状态与恢复要求、安全约束、部署门禁和验收标准，供迁移和兼容排查使用。

本文以仓库当前实现为基线。若本文与旧 Runner 文档、历史任务文件协议或早期设计冲突，以本文描述的 Option C 生产面为准。架构决策的技术细节由 ADR 和设计文档补充，不应再把 Runner/tmux 描述为默认生产链路。

## 2. 产品背景

用户希望通过 Zulip 上的 Hermes 入口远程发起、继续、检查和控制代码任务，同时保留：

- Hermes 的多端消息入口、业务理解、会话与通知能力；
- Codex 对项目目录、项目规则、源码、Git 状态和测试工具的原生理解；
- 跨消息、跨进程重启的 Codex 技术上下文连续性；
- 可审计、可恢复、不会串项目或串话题的执行与交付链路。

原始 Runner/tmux 方案通过任务文件和 Codex CLI TUI 完成投递，但不能提供 Codex App Server thread 级连续性，也不能满足当前的数字 stream 路由、细粒度权限、持久交互、事件日志和可靠结果交付要求。因此，当前生产面采用 Option C。

## 3. 产品目标

### 3.1 核心目标

系统必须做到：

1. 将来自 Zulip 的项目请求绑定到唯一、已注册的项目和规范工作目录。
2. 以数字 Zulip stream ID 作为唯一项目路由权威，禁止从频道名、topic、prompt、模型输出、进程 cwd 或记忆推断项目。
3. 建立稳定的一一映射：数字 Zulip `stream_id` 唯一绑定一个项目 canonical cwd；`stream_id + topic` 唯一绑定一个 `topic_context_id` 和专用 Codex 上下文会话/主 thread。HCO objective 管理该话题中的具体工作，不能跨话题借用 Codex 会话。
4. 区分无需 Hermes 推理的精确控制命令和需要业务理解的自然语言请求。
5. 将入站事件、执行、交互和结果交付持久化，支持幂等处理和进程重启恢复。
6. 将 Codex 的权威完成结果可靠地投递回原始 Zulip stream/topic，且不由 Hermes 静默改写技术结论。
7. 对错误项目、错误话题、未授权操作、重复执行和丢失最终结果实行 fail-closed。
8. 在 App Server 调用结果不确定时禁止盲目重试或自动切换到 tmux。
9. 工作完成、提醒到期、外部条件成立或确需人工决定时，系统可以不等待用户再次发消息，主动恢复工作并向原话题续报或提问。
10. 同一话题允许存在多个独立或相关工作；系统必须保留各自身份，并显式决定独立、依赖、追加、替代、冲突或汇总关系。
11. 简单只读任务保持轻量执行；单 Agent无副作用的提醒/checkpoint只增加持久trigger；只有出现委派、依赖、持久人工路线、并行汇合或副作用时才升级为持久协作图。

### 3.2 质量优先级

优先级从高到低为：

1. 项目和交付目标正确；
2. 权限与安全边界正确；
3. 不重复执行且不丢失权威结果；
4. objective/thread 上下文连续；
5. 可恢复性与可审计性；
6. 响应延迟与 token 成本。

token 节省不能削弱正确性门禁。

## 4. 非目标

当前产品不承诺：

- 复刻 Codex Desktop UI 或保证 App Server thread 一定显示在 Codex Desktop 会话列表；
- 让 Hermes 保存或重放 Codex 的完整内部推理；
- 让 Hermes、Codex Desktop、Codex CLI 和旧 tmux 会话共享同一个会话列表；
- 由模型选择项目、工作目录、权限、profile、凭据或执行后端；
- 自动从 stream 显示名、topic 文本或引用内容推断路由；
- 对不确定的 App Server 调用自动跨后端重试；
- 在首个生产版本中流式转发每一个 App Server delta；
- 自动创建 GitHub PR、自动合并或提供图形化任务看板；
- 将历史 Runner taskId 转换为 App Server thread 连续性；
- 用 HCO 专用逻辑维护 Hermes core fork。

## 5. 用户与权限角色

### 5.1 用户角色

| 角色 | 最低能力 |
| --- | --- |
| viewer | 查看项目、topic 和 objective 状态 |
| contributor | 创建/继续/取消 objective，回答被授权的审批或用户输入 |
| maintainer | 管理 topic、stream 路由、执行后端和 thread 恢复 |
| admin | 全局管理；在项目内继承最高权限 |

权限为递增关系。HCO 必须按受信任的数字 Zulip sender ID 鉴权，不能使用邮箱、显示名、模型声明或请求体自报角色作为授权依据。

对于审批和用户输入，仅满足项目角色还不够；回复者还必须存在于该交互的持久化 allowed responder 集合中。

### 5.2 系统参与方

- **Hermes bridge plugin**：负责 Zulip/Hermes 接入、精确命令解析、受信任上下文封装、profile 选择和自然语言工具桥接。
- **HCO service**：负责路由、ACL、objective/thread/turn 控制、SQLite 状态、恢复、结果渲染和 outbox。
- **Codex App Server**：负责 Codex thread、turn、审批和用户输入等执行协议。
- **Zulip delivery sidecar**：只负责租用 HCO outbox 记录并调用 Zulip REST API 发送结果。
- **运维人员**：负责配置、安装、升级、回滚、运行态证明和人工恢复。
- **Runner/tmux**：兼容执行面参与方，不是 Option C 的默认生产调度器。

## 6. 总体架构

### 6.1 Option C 生产面

```text
Zulip
  |
  | inbound message
  v
Hermes Zulip ingress + hermes-codex-bridge plugin
  |
  | signed/versioned bridge event over owner-only local transport
  v
HCO service
  |
  | thread/turn protocol
  v
Codex App Server

Codex App Server events
  |
  v
HCO SQLite journal/reducer/outbox
  |
  v
send-only Zulip delivery sidecar
  |
  v
original numeric stream ID + snapshotted topic
```

生产面事实源：

- 项目注册和数字 stream 路由由 HCO 配置与 SQLite 控制面共同约束；
- objective、thread、turn、submission、interaction、event 和 outbox 状态以 HCO SQLite 为权威；
- 项目源码、Git 状态和仓库规则仍以目标项目目录为权威；
- Zulip stream 显示名仅为展示元数据。

### 6.2 Runner/tmux 兼容面

```text
Hermes/adapter -> task files -> Runner -> tmux -> Codex CLI
```

兼容面保留旧 taskId、项目文件、JSON adapter state 和 tmux session。它不得：

- 参与 Option C 的数字 stream 路由；
- 伪造或恢复 App Server thread 连续性；
- 在 App Server 结果不确定时被自动选作重试后端；
- 将旧 taskId 提升为 Option C objectiveId/threadId。

## 7. 组件职责

### 7.1 Hermes bridge plugin

插件必须：

- 作为独立 Hermes 插件安装，不承载 HCO 的持久业务状态；
- 验证原始 Zulip provenance，包括正整数 stream ID、sender ID 和 source message ID；
- 从新鲜、完整性校验通过的本地 route snapshot 选择 `zulip-ingress`、`codex-bridge` 或 `hermes-general`；
- 本地解析精确 `/codex` 命令并转换为短时、签名、一次性上下文；
- 对项目自然语言保留原始用户消息并进入普通 Hermes agent；
- 通过受限 `hco_dispatch` 工具向 HCO 提交严格 semantic 对象；
- 对协议错误、路由不可用和 HCO 不可用返回短且确定的错误；
- 不在日志、回复或模型可见参数中暴露 bearer token、HMAC key 或内部 capability。

插件的 pre-dispatch 热路径不得进行网络 I/O、HCO 调用或持久化写入。允许的唯一预授权可变状态是有 TTL、全局条目/字节上限和发送者配额的一次性内存 vault。

### 7.2 HCO service

HCO 是生产控制面的唯一权威，必须负责：

- 项目注册、规范 cwd、静态与运行时 stream 路由；
- topic mode、topic alias 和 objective 选择；
- ACL 与每个操作的授权；
- App Server 子进程生命周期、协议协商和能力检查；
- objective/thread/turn、submission 和 interaction 状态；
- append-only 事件日志、幂等 reducer、资源 lease 和重放保护；
- 完成结果选择、过滤、分块、outbox 和交付账本；
- 重启 reconciliation、异常分类和运维诊断；
- 发布带时效与完整性保护的 route snapshot。

HCO 必须是其 SQLite 数据库的唯一写入者。bridge API 仅可监听 loopback 或 owner-only Unix socket，并使用文件托管的 bearer token。

### 7.3 Codex App Server

App Server 负责：

- `thread/start`、`thread/resume`、`thread/read`、`thread/list`；
- `turn/start`、`turn/interrupt`；
- 按能力支持显式 `thread/fork` 和 `thread/compact/start`；
- turn、item、thread status、token usage、approval 和 user input 的协议事件。

HCO 必须先完成协议初始化、能力和版本检查，再接受生产请求。App Server 不提供跨系统全局 replay cursor，HCO 不得假设其通知流天然 exactly-once。

### 7.4 Zulip delivery sidecar

sidecar 必须：

- 只发送，不轮询 Zulip、不处理入站消息、不调用模型；
- 从 HCO 领取带 lease 的 outbox 项；
- 使用 outbox 中不可变的数字 stream ID 和 topic 快照发送；
- 将 Zulip 返回的不可变 message ID 回写 HCO；
- 对已确认的 chunk 禁止再次发送。

生产环境必须只保留一个使用该 Zulip bot 凭据的入站 adapter/poller。

## 8. 路由与 topic 所有权

### 8.1 stream 路由权威

数字 Zulip stream ID 是唯一项目路由键：

- 映射到注册 `projectId`：该 stream 为项目 stream；
- 显式标记为 Hermes 或在新鲜 snapshot 下按可信 default owner 判定为 Hermes：进入 `hermes-general`；
- snapshot 缺失、过期、损坏、过大、结构错误或完整性失败：留在项目中立的 `zulip-ingress` 并固定拒绝；
- 插件未加载或 hook 异常：不得继承默认项目 cwd、项目记忆、Task Guard、MCP 或 root 凭据；部署状态必须判定为不健康。

频道显示名只能在收到真实、已认证的 Zulip 事件后作为一次性迁移别名使用。系统不得猜测、哈希或伪造数字 stream ID。

路由命令：

```text
/codex route show
/codex route set <projectId>
/codex route none
/codex route unset
```

`set`、`none` 和 `unset` 必须在同一事务内更新运行时路由并清理受影响的 topic 当前选择。

### 8.2 topic mode

项目 stream 中每个 topic 有三种模式：

| 模式 | 产品语义 |
| --- | --- |
| `AUTO` | 默认状态，可无数据库行；接受可执行请求时才创建 objective/thread |
| `CODEX_BOUND` | 已持久化真实 objectiveId 和真实 App Server threadId，默认继续当前 objective |
| `HERMES_ONLY` | 阻止新的 Codex dispatch，但不删除历史，也不自动取消已运行 turn |

用户或模型只能请求 `AUTO`、`HERMES_ONLY`；只有 HCO 能在 objective 和真实 thread 绑定成功的同一持久事务中设置 `CODEX_BOUND`。

topic 命令：

```text
/codex topic show
/codex topic auto
/codex topic hermes
```

`HERMES_ONLY` 下仍允许状态查询、取消既有工作、回答交互、查看 topic 和人工 thread bind。重新执行必须先显式切回 `AUTO`。

## 9. 身份与连续性模型

以下标识不可互换：

| 标识 | 所有者与含义 |
| --- | --- |
| `projectId` | 注册项目、规范 cwd、ACL 和执行策略 |
| `streamId` | Zulip 数字 stream ID，项目路由权威 |
| `deliveryTargetId` | 平台、数字 stream ID 和 topic 的交付地址 |
| `topicAliasId` | topic 地址及其改名/移动历史 |
| `topicContextId` | 一个数字 stream 与稳定 topic identity 的不可变上下文身份 |
| `codexContextSessionId` | 该 topic 唯一拥有的逻辑 Codex 上下文会话 |
| `objectiveId` | HCO 创建的持久用户目标 |
| `threadId` | 绑定给一个 objective 的 Codex App Server thread |
| `turnId` | thread 内的一次 Codex 执行 |
| `itemId` | App Server 输出或交互 item |
| `inboundEventId` | 入站事件幂等身份，包含可信 source message 身份 |
| `eventRecordId` | HCO append-only journal 记录 |
| `submissionId` | 一次 turn 提交意图和不确定性边界 |
| `interactionId` | 一次审批或用户输入请求，同时作为 reply token |
| `outboxMessageId/deliveryId` | 一条不可变语义交付 |
| `deliveryAttemptId` | 一次实际发送尝试 |

一个数字 stream 只能绑定一个项目 canonical cwd。一个 `stream_id + topicContextId` 只能绑定一个 `codexContextSessionId`，该上下文会话拥有一个主 App Server thread；一个 objective 最多绑定一个当前 thread，并同时最多有一个活动 turn。

新 topic 不得提前创建远端 thread，但第一次可执行请求必须惰性创建该 topic 的逻辑 Codex 上下文会话和主 thread。相同目标的后续消息继续该 topic 的主 thread；同一 topic 中实质无关的新工作仍属于同一个 topic 上下文，但必须使用新的 objective，并在需要并行或隔离时使用该上下文受管的 fork/branch。任何 topic 都不能借用其他 topic 的 thread。

topic 改名只有在可信 Zulip continuity 事件或显式运维 relink 后才能保留 `topicContextId` 和 Codex 上下文；不能按文本相似度自动继承。频道路由改变项目时，旧 topic 上下文不得静默迁移到新目录，必须失效、完成、取消或进入人工恢复。

## 10. 用户交互路径

### 10.1 精确命令路径

当前命令语法：

```text
/codex run <instruction>
/codex status [objectiveId]
/codex cancel [objectiveId]
/codex topic show
/codex topic auto
/codex topic hermes
/codex route show
/codex route set <projectId>
/codex route none
/codex route unset
/codex objective new <instruction>
/codex objective continue <objectiveId> <instruction>
/codex thread bind <objectiveId> <threadId>
/codex approve <replyToken> <choice>
/codex answer <replyToken> <text>
```

多问题输入使用：

```text
/codex answer <replyToken> <questionId> <answer>
```

精确命令必须：

- 使用严格语法，拒绝未知后缀或模糊解析；
- 不调用 Hermes 模型；
- 从原始事件绑定 stream ID、topic、sender ID、source message ID、参数、签发/过期时间和 nonce；
- 先经过 Gateway 用户授权，再由私有 awaited handler 提交 HCO；
- 对伪造、过期、重放、签名错误或上下文冲突 fail-closed；
- 使用可信 source message ID 和 HCO 入站幂等记录避免重复动作。

Hermes 的 adapter busy-session guard 早于插件 hook。相同 session 忙碌时，精确命令可能先进入 Hermes pending queue；它仍不得落入模型，但不保证立即执行。

### 10.2 项目自然语言路径

项目 stream 的普通文本必须进入项目中立的 `codex-bridge` Hermes profile 和普通 Hermes agent，以保留 Jarvis PM 的 SOUL、会话、记忆和业务工具语义。

处理流程：

1. 插件从原始 Zulip 事件和签名 route snapshot 冻结可信项目与来源上下文。
2. 原始用户文本保持为会话中的 user message；插件只增加有界、临时的 channel prompt。
3. 内部签名 capability 仅保存在有界一次性 vault，不作为模型工具参数。
4. `pre_llm_call` 用可信 session ID、turn ID、source message ID 和原始请求绑定该 capability。
5. 模型可以正常回答业务问题；需要执行项目工作时，只能调用一次 `hco_dispatch`。
6. 模型只提交严格 `semantic` 对象；插件在 `pre_tool_call` 和 handler 中再次验证并原子消费可信上下文。
7. `hco_dispatch` 为 terminal/direct-return 工具，成功或失败结果直接成为最终回复，不触发不受控的修复模型调用。

semantic 结果限定为：

| 类型 | 行为 |
| --- | --- |
| `DISPATCH` | 提交规范化的执行意图、约束、验收标准和 objective 选择 |
| `CONTROL` | 请求允许的 topic mode 控制，不执行代码 |
| `CLARIFY` | 返回有界澄清问题，不提交 HCO |
| `BUSINESS_REPLY` | 由 Hermes 回答业务问题，不调用 Codex |
| `REJECT` | 使用稳定原因拒绝 |

模型输出不得包含或决定 sender、stream、topic、source message、project、cwd、profile、权限、role、token、socket、凭据或文件系统 authority。HCO 必须重新校验项目路由、topic mode、ACL、objective 所属和执行策略。

可信的自然语言 route/progress 查询可以使用确定性窄匹配与受限 marker 回显；普通项目请求不能因包含相似词而意外获得控制权限。

### 10.3 未映射与 Hermes-owned stream

- 明确 Hermes-owned 的 stream 使用 `hermes-general`，保持普通 Hermes 行为且不获得项目 cwd。
- 未映射 stream 在可信 default owner 为 Hermes 时仍归 Hermes；若请求项目执行，只能返回有界注册指引。
- 路由权威不可用时固定返回“项目路由暂不可用，请稍后重试。”，不得用模型猜测项目。

## 11. objective、thread 与上下文

### 11.1 objective 选择

- `objective new` 或 semantic `NEW`：始终创建新 objective；
- `objective continue <objectiveId>` 或 semantic `CONTINUE`：继续指定且属于当前项目的 objective；
- 未显式选择：默认创建新的独立 work/objective；只有显式 `CONTINUE`、合法 interaction 回复或已经确认的 relation 才允许继续既有 objective。新的 objective 仍属于当前 topic 的唯一 Codex 上下文会话，不得因此创建或借用另一个 topic 的上下文。

选择和状态变更必须由 HCO 在持久事务中完成，插件和模型不得自行替代 objective。

### 11.2 Codex 上下文交接

HCO 先按数字 `stream_id` 解析项目 canonical cwd，再按该 stream 内的可信 topic identity 解析唯一 `topicContextId -> codexContextSessionId`。Hermes session ID 只用于消息与 Agent 回传，不能替代这两个路由键。每次 start、resume、status、cancel、interaction 和 reconciliation 都必须同时验证项目与 topic context。

HCO 不在每轮重放完整 Zulip 历史。Codex turn 接收：

1. 当前用户指令；
2. 紧凑 objective brief 和当前验收标准；
3. 上一轮后的未解决约束与用户纠正；
4. Hermes 提供的有界项目/业务提醒；
5. 已持久长上下文的文件引用。

稳定项目规则仍由目标仓库的 `AGENTS.md` 等文件提供；Codex thread 历史提供技术连续性。当前用户指令和当前仓库事实优先于历史摘要或记忆。

### 11.3 并发

- 一个 objective 同时最多一个活动 turn；
- 后续执行请求默认 FIFO 排队；
- interrupt、cancel、approval 和 user input 必须绑定准确 objective/turn/interaction；
- Option C 不承诺旧 PRD 所述“强制并发时自动创建 Git worktree”；是否使用 worktree 由 Codex 项目规则或未来策略决定。

## 12. 持久状态与状态机

### 12.1 SQLite 权威状态

HCO SQLite 至少持久化：

- schema migration 和控制面版本；
- append-only event journal 与本地单调 ingestion sequence；
- project/static/runtime stream route 和 topic alias/mode；
- objective、objective-project 绑定和 objective execution；
- inbound intent、turn submission、turn output 和审计事实；
- pending interaction、partial answer 和不可变 answer settlement；
- Zulip outbox、delivery attempt 和 resource lease；
- replay nonce 和幂等键。

项目任务 Markdown、`.hermes/sessions.json` 和旧 adapter JSON 不是 Option C 的权威状态。

### 12.2 关键状态

objective 的高层状态为：

```text
created -> running -> completed
```

执行控制状态包括：

```text
idle -> starting -> ready -> submitting -> running -> completed
                         |             |
                         |             -> cancelled / terminal_error
                         -> submission_unknown / reconciliation_needed
                         -> backend_unavailable
```

submission 独立记录：

```text
intent -> running -> completed
      |          -> cancelled / terminal_error
      -> submission_unknown / reconciliation_needed
```

interaction 独立记录：

```text
pending -> answered
       -> expired
       -> orphaned
```

outbox 独立记录：

```text
pending -> leased -> delivered
                  -> failed
```

状态不能压缩成旧 Runner 的单一 task 状态机。

### 12.3 事件与最终结果

App Server 事件处理顺序必须为：

```text
notification -> durable event journal -> idempotent reducer
             -> authoritative output selection -> Zulip outbox
```

完成的 `agentMessage` item 是权威最终文本。delta 可用于进度显示，但不得覆盖完成 item。完成的 plan 或其他 typed item 必须按类型处理。

最终输出经过事件类型白名单、敏感路径策略、已知 secret 脱敏和大小限制，再按 Markdown 边界确定性分块。每个 chunk 必须有稳定 delivery ID、序号、content hash、状态和 Zulip message ID。

## 13. 审批与用户输入

HCO 必须将 App Server approval 和 user-input server request 持久化为 pending interaction，并通过 outbox 投递可操作指令。

### 13.1 审批

```text
/codex approve <interactionId> <choice>
```

- choice 必须属于该 interaction 公布的允许集合；
- 回复必须来自允许的数字 sender ID 和正确项目授权域；
- 重复相同回答保持幂等，不同回答产生冲突；
- 已过期、已 orphan 或不存在的 interaction 返回明确状态错误。

### 13.2 单问题与多问题输入

```text
/codex answer <interactionId> <answer>
/codex answer <interactionId> <questionId> <answer>
```

- 单问题可直接回答；
- 多问题必须具有唯一、非空、可安全寻址的 question ID；
- 每次可提交一个 question 的 partial answer；
- HCO 持久化 partial answers，全部问题完成后一次性结算并回复 App Server；
- 不存在、重复、含控制字符、过大或混合无效的 question ID 必须 fail-closed；
- interaction 最终 answer settlement 不可修改或删除。

敏感输入当前只提供敏感性提示，不代表端到端加密；不得通过此通道提交秘密，除非后续实现加密持久化和专用输入面。

## 14. 结果交付

每次入站请求必须冻结交付目标：平台、数字 stream ID、topic 和 source message 身份。后续 stream 显示名变化不得改变目标。

HCO outbox 是交付权威：

- 完成结果先持久化，再由 sidecar 发送；
- payload、目标快照、语义键和序号在创建后不可变；
- sidecar 使用 lease，记录每次尝试及错误；
- 收到 Zulip message ID 后确认不可变；
- 已确认 chunk 不得重发；
- 未确认发送存在窄的 at-least-once 重复窗口，系统必须暴露该状态，不能以静默丢失换取表面去重。

若完成 turn 没有可恢复的权威 final item，系统必须报告“恢复不完整”，不得让 Hermes 编造摘要。

## 15. 重启、失败与 reconciliation

### 15.1 通用规则

- HCO、App Server 或 sidecar 重启后，必须从 SQLite 恢复非终态执行、pending interaction、lease 和 outbox；
- App Server 断线后使用 `thread/read(includeTurns=true)` 等能力对账，不假设通知可完整重放；
- reducer 必须容忍重复和乱序观察；
- 外部调用前后必须持久化足以判断“已知未发送”“已发送”“结果未知”的状态；
- transport error、timeout、断线或通用协议错误绝不能触发盲目重试。

### 15.2 不确定 App Server 调用

当 `thread/start` 或 `turn/start` 的结果不确定时：

- 标记 `submission_unknown` 或 `reconciliation_needed`；
- 不自动再发同一 turn；
- 不自动切到 tmux；
- 通过对账或人工绑定恢复。

### 15.3 已证明 thread 缺失

只有已安装 App Server 对请求 thread ID 返回精确、已探测的 missing-thread 错误签名，才能认定 thread 确实不存在。当前已验证分类是 JSON-RPC code `-32600` 且 message 精确等于 `thread not loaded: <requestedThreadId>`。

满足精确证明后，HCO 可以：

1. 最多创建一次 replacement thread；
2. 在同一事务中更新 objective 和所有关联 `CODEX_BOUND` topic；
3. 复用原始 turn text 与 client user message ID；
4. 审计 old/new thread ID 和 `proven_missing_thread` 原因。

近似文本、前缀匹配、空白宽松匹配、timeout、断线和 malformed response 都不是缺失证明。

若 replacement `thread/start` 结果也不确定，必须进入 `manual_thread_binding_required`，并由 maintainer/admin 在 objective 所属数字 stream 中执行：

```text
/codex thread bind <objectiveId> <threadId>
```

HCO 必须重新验证 stream 路由、objective/project 所属、ACL 和可信 source message ID。外部 `turn/start` 前立即写入 uncertainty fence；fence 之后命令重放不得再次提交 turn。

## 16. 安全要求

### 16.1 执行隔离

- `zulip-ingress` 必须项目中立，不含项目 cwd、项目记忆、Task Guard 投影、MCP 或模型凭据；
- `codex-bridge` 仅获得有界推理配置和 `hco_bridge` toolset，不继承某一项目的工作目录或记忆；
- `hermes-general` 只服务明确 Hermes-owned 的 stream；
- restricted profile 的实际工具配置是安全边界，prompt 文本不是安全边界；
- 项目 cwd 只能来自 HCO 注册配置。
- `stream_id -> projectId -> canonical cwd` 和 `stream_id + topicContextId -> codexContextSessionId` 必须由 HCO 原子维护，模型不能提供或覆盖；
- 项目注册时拒绝相同或互为祖先/子目录的 canonical root；执行、继续和恢复时重新核对 root 的 `dev/ino`、route generation 和 policy digest；
- Codex thread 恢复或人工绑定前必须核对远端 thread 的 cwd 与 sandbox/profile，不能只凭 thread ID；
- `cwd` 只是启动位置，不是物理文件隔离。写能力必须由受管 sandbox、容器、worktree 或 Tool Gateway 实际限制 read/write roots；无法证明边界时拒绝写执行。

### 16.2 capability 与协议

- command envelope 和自然语言 capability 必须短时有效、签名、限制大小、一次性消费并防重放；
- vault 必须限制 TTL、条目数、总字节数和发送者占用；
- capability 必须绑定 message digest/长度、stream、topic、sender、project、topic mode、session 和 turn；
- 模型工具 schema 只能暴露 semantic 内容，不能让模型搬运内部签名 token；
- HMAC 和 bearer secret 仅从 owner-only 文件加载，不能写入仓库、日志、prompt、回复、plist 或命令行参数；
- 签名上下文只保证完整性，不能替代 HCO ACL。

### 16.3 失败策略

以下情况必须 fail-closed：

- 路由 snapshot 不可信；
- project、stream、topic、source message 或 sender 绑定冲突；
- capability 过期、重放、缺失或篡改；
- semantic schema 含未知字段、错误类型、越界文本或 authority 字段；
- HCO/App Server 协议版本或能力不兼容；
- 用户无权限或不在 interaction allowed responder 集合。

普通 Hermes 对话只有在 stream 被正向证明为 Hermes-owned 时才可继续；未知路由不能回退到全局项目环境。

## 17. 非功能要求

### 17.1 可靠性

- 客户端断线不得终止已接受的远程执行；
- HCO 状态写入、路由变化和关键 binding 必须事务化；
- 交付与执行采用幂等语义键和持久 lease；
- 错项目、错 topic、未授权操作、重复执行或静默丢失 final output 均为 P0，发生一次即停止相关 rollout cohort。

### 17.2 可审计性

系统必须能关联：

```text
source message -> inbound event -> project/objective
               -> submission/thread/turn -> App Server event/item
               -> outbox/delivery attempt -> Zulip message ID
```

事件原始载荷以受限引用和 hash 保存；日志必须脱敏。代码变更本身仍通过目标项目 Git diff 和验证证据审计。

### 17.3 可观测性

至少记录或暴露：

- route snapshot 生成时间、有效期、发布状态和失败原因；
- bridge 协议版本、插件版本、App Server 能力和 live attestation；
- objective/turn 状态、reconciliation 原因和 pending interaction；
- outbox backlog、lease、attempt、最老未交付年龄和确认 message ID；
- App Server 重启、协议错误、token usage 和 compaction 事件；
- exact command 的零模型调用和项目自然语言的单次首轮模型调用。

指标和日志不得包含用户秘密、capability、HMAC key、bearer token 或平台 API key。

### 17.4 平台范围

- Option C 当前生产安装目标为 macOS 用户级 launchd；
- HCO/Runner 的部分逻辑可在 Linux 开发和测试，但 Option C 的等价生产 installer/service contract 尚未在本文承诺；
- Windows 可作为 Zulip/Hermes 控制端，不是当前本机执行宿主。

## 18. 部署、升级与回滚

### 18.1 安装器合同

`scripts/install-hermes-codex-bridge.sh` 必须：

- 先执行无副作用的配置、Hermes、plugin、HCO bridge 和 App Server 兼容性探测；
- 将插件安装为不可变版本目录，并通过原子 symlink 激活；
- 迁移单一 Zulip poller 到 `zulip-ingress`，保持 profile 与 secret scope 隔离；
- 生成 HCO 与 send-only delivery sidecar 的独立 LaunchAgent；
- 保存所有将修改路径和原 launchd loaded/running intent 的快照；
- 串行化安装，拒绝不可信 owner 状态、非预期文件类型、权限或符号链接；
- 激活后重启真实 Gateway，并要求 PID 轮换、健康/就绪通过和 live plugin/hook/profile attestation；
- 任一步失败时恢复文件与服务意图，并验证回滚结果；
- 不修改 Hermes 生成的 Gateway plist，不引入 HCO 专用 Hermes core fork。

### 18.2 SQLite 连续性

升级、备份、恢复和回滚必须把 SQLite 主文件及其 `-wal`、`-shm` side files 作为一致状态处理。不得只复制主数据库文件后宣称状态完整。

### 18.3 运行态门禁

生产启用前必须证明：

- HCO 和 delivery sidecar 的 LaunchAgent 健康；
- Gateway 是新进程并加载目标插件版本；
- `zulip-ingress`、`codex-bridge`、`hermes-general` 的边界与 toolset 正确；
- 只有一个 Zulip 入站 poller；
- route snapshot 新鲜且完整性有效；
- App Server 初始化、能力和 exact missing-thread probe 与当前版本匹配；
- 真实项目 stream、Hermes stream 和失效路由 smoke test 符合预期。

### 18.4 回滚

回滚必须恢复：

- plugin symlink 和历史安装布局；
- Hermes profile/config/env 的原内容；
- HCO、delivery 和 Gateway 的原 loaded/running intent；
- 数据库主文件与 WAL/SHM 连续性。

回滚不得把项目 stream 临时切到 unrestricted general profile。需要回退执行面时，由运维人员显式启用 Runner/tmux，并保持两套权威状态隔离。

## 19. Runner/tmux 兼容与回滚附录

旧执行面继续支持：

- 注册项目和项目白名单；
- 创建 `.hermes/tasks/<taskId>.md`；
- 通过 Runner HTTP API 创建、查询、取消任务；
- 创建或复用 tmux session 并向 Codex CLI 投递短 prompt；
- 由任务文件、日志和 JSON adapter state 提供旧链路审计。

旧状态流：

```text
pending -> queued -> running -> waiting_user -> verifying -> completed
                              -> failed
                              -> cancelled
```

兼容面要求：

- 同一配置根目录只运行一个 Runner；
- Runner 默认使用 bearer token 并监听 loopback；
- 任务文件和日志不得包含 API key；
- macOS/Linux 需要 tmux；Windows 不支持本机 tmux dispatch；
- 旧 taskId、频道名路由、`.hermes/sessions.json` 和 task Markdown 仅在兼容面内有效；
- 兼容面可用于显式回滚，但不能作为不确定 App Server 操作的自动 retry。

## 20. 生产验收矩阵

“已验证”表示 2026-07-21 本地审计基线已有自动化证据，不等同于所有真实部署环境永久兼容。

| 验收项 | 预期 | 当前证据/状态 |
| --- | --- | --- |
| 数字 stream 路由 | 频道名、topic、cwd 和模型不能改变 project | 已验证：HCO/Option C 测试通过 |
| 频道目录与话题 Codex 会话 | 一个数字 stream 对应一个 canonical cwd；每个 stream/topic 对应唯一 topic context 和 Codex 主 thread；跨 topic 复用被拒绝 | 方案要求已写入；需补充实现与跨重启验收 |
| topic mode | `AUTO`、`CODEX_BOUND`、`HERMES_ONLY` 转换和权限正确 | 已验证 |
| lazy thread | 新 topic 在可执行请求前不创建 thread | 已验证 |
| 精确命令 | 严格解析、零 Hermes 模型调用、签名与防重放 | 已验证 |
| 项目自然语言 | 普通 Hermes agent 保留上下文；执行只通过受限 `hco_dispatch` | 已验证：plugin contract 290 项通过 |
| semantic 边界 | 模型不能提供项目、cwd、权限、token 或来源 authority | 已验证 |
| ACL | viewer/contributor/maintainer/admin 与 responder 限制生效 | 已验证：HCO service 64 项通过 |
| objective/thread 连续 | 同一 objective 跨 turn 和重启继续同一 thread | 已验证：turn controller 62 项通过 |
| 入站幂等 | 重放 Zulip source message 不重复创建 turn | 已验证 |
| 不确定调用 | 不自动重发 turn，不自动切 tmux | 已验证 |
| proven-missing 恢复 | 仅精确缺失签名允许一次 replacement；支持人工 bind | 已验证 |
| 审批与输入 | 类型、choice、question ID、partial answer、ACL 正确 | 已验证 |
| 权威结果 | completed item 持久化并确定性进入 outbox | 已验证 |
| 交付恢复 | lease、attempt、不可变 target/message ID 和重启恢复 | 已验证：自动化合同通过 |
| App Server 协议 | 初始化、通知、交互、重连和能力检查 | 已验证：App Server 50 项通过 |
| Option C 端到端 | 路由到执行、结果和交互闭环 | 已验证：7 项通过 |
| 旧兼容面 | Runner smoke/contract/dispatch/hardening | 已验证：`npm run verify` 通过 |
| 安装器事务 | staged probe、激活、健康、attestation、回滚 | **未满足：当前 fresh mutating install 合同失败，见 21.1** |
| 真实部署 smoke | 合法用户在项目/Hermes stream 和故障路由下实发实收 | 需要每次安装/升级现场验证 |

## 21. 已知限制与当前实施缺口

### 21.1 安装器与插件 prompt 合同不一致

当前工作区存在一个阻断 fresh mutating install 的已知失败：

- 插件在 `plugin/hermes-codex-bridge/plugin.py` 中注入了扩展的受信任项目/cwd 上下文和跨项目警告；
- 安装器在 `scripts/install-hermes-codex-bridge.sh` 中的 staged compatibility probe 仍要求旧的精确两句 prompt；
- `bash test/install-hermes-codex-bridge.test.sh` 因 `valid PROJECT route supplied malformed bridge context` 失败。

在该合同同步并重新通过完整安装器测试前，不能宣称当前安装器满足生产验收，也不应执行无保护的生产升级。

### 21.2 busy-session 命令延迟

Hermes busy-session guard 早于 plugin hook。同一 adapter session 忙碌时，精确 `/codex` 命令可能排队，无法保证立即执行；正确性合同是“零模型 fallthrough”，不是“零等待”。

### 21.3 Zulip 交付语义

Zulip API 在发送成功但确认丢失时没有跨系统 exactly-once 保证。系统保留语义 delivery ID 并禁止重发已确认消息，但未确认发送仍存在可见的窄 at-least-once 重复窗口。

### 21.4 topic 改名与移动

topic rename/move 需要可信 Zulip continuity 事件或显式运维 relink，只有这样才能保留原 `topicContextId` 和 `codexContextSessionId`。系统不根据文本相似度自动合并 conversation；跨项目移动默认创建新的上下文。

### 21.5 App Server 版本依赖

自动 replacement 依赖当前安装版本的精确 missing-thread 错误签名。每次 Codex 升级必须重新运行隔离 probe；签名变化时自动 replacement 保持禁用，直到分类器和回归测试更新。

### 21.6 敏感用户输入

当前桥接会提示 App Server 问题的敏感属性，但 interaction 内容会持久化，未提供端到端加密的秘密输入通道。

### 21.7 平台与策略

- Option C 生产 installer 目前是 macOS/launchd 专用；
- 自动 fork、自动 compaction、复杂 worktree 并发和 streaming progress 不是当前默认策略；
- 真实 Zulip smoke 必须使用获授权的非 bot 发送者，不能用会被 Hermes 忽略的 bot 自发消息替代。

## 22. 文档与变更治理

以下文档共同约束实现：

- 本 PRD：产品范围、用户可见行为、生产门禁和已知缺口；
- `docs/adr/0001-zulip-trusted-execution-scope.md`：可信执行与 profile 隔离；
- `docs/adr/0002-hermes-codex-context-handoff.md`：上下文、thread 和结果交付；
- `docs/adr/0003-zulip-channel-topic-ownership.md`：数字 stream、topic mode 和恢复；
- `docs/superpowers/specs/2026-07-16-hermes-codex-option-c-design.md` 及后续 remediation design：详细协议与演进；
- `docs/SETUP.md`、`docs/OPERATIONS.md`：配置、安装、运行和回滚步骤；
- `README.md`：入口说明与两套执行面导航。

发生下列任一变化时，必须同步评审和更新 PRD：

- 生产执行面、路由权威或身份模型变化；
- 用户命令、topic mode、ACL 或交互方式变化；
- 状态机、幂等、恢复或交付语义变化；
- profile、凭据、capability 或安全边界变化；
- installer、服务监管、健康门禁或回滚合同变化；
- 新增已知生产缺口或关闭现有缺口。

## 23. 关键结论

生产系统的职责分工是：

```text
Hermes 负责消息入口、业务理解和用户会话。
bridge plugin 负责可信来源、profile 隔离和受限语义桥接。
HCO 负责路由、权限、持久状态、恢复和可靠交付。
Codex App Server 负责 objective 所绑定 thread 中的技术执行。
项目目录负责源码、Git 和项目规则事实。
Runner/tmux 只负责旧兼容与显式回滚。
```

产品正确性的底线是：不猜项目、不越权、不盲目重试、不静默丢失权威结果。

## 24. [LEGACY] 主动协调与多 Agent V2 产品合同

> 本节不属于当前目标 PRD。当前目标明确复用 Hermes 原生 Agent、提醒和消息机制；本节中的 HCO coordination graph、trigger/activation、effect 和 delivery sidecar 只能作为历史研究资料，不得进入 HCO Codex bridge MVP。

本节定义下一阶段产品能力。详细事务、状态机和故障恢复合同以 `docs/superpowers/specs/2026-07-28-topic-agent-codex-coordination-design.md` 为准。该能力在对应发布阶段通过真实故障注入前，不得标记为生产可用。

### 24.1 用户可见行为

1. 用户提交工作后，不需要再次询问状态才能收到最终结果。Codex 完成、失败、需要确认或超过约定时间时，系统应主动在原 stream/topic 续报。execution terminal 不等待 Zulip delivery；交付状态单独展示。
2. 主动续报、定时提醒、条件复查、备忘录到期和模型主动提问共用一套持久 trigger/activation/outbox 机制，不各自依赖内存定时器或某个模型会话保持在线。
3. 复杂结果优先由 Jarvis 综合；Jarvis 超时或不可用时，HCO 必须用已验证事实发送确定性降级通知。两条通道只能竞争同一个最终交付 claim。
4. 同一话题的新要求默认保留为新的独立 work。只有确定性 admission 检出显式work/objective引用、reply-to/interaction身份、共享写资源、修改验收条件，或“继续、再、也、上述、前一个、刚才、然后”等有界指代/续接信号时，系统才调用关系模型判断是否追加、依赖、替代、冲突或合并。规则只决定“是否需要判断关系”，不能仅凭关键词直接合并；命中信号时必须先创建有owner/revision/deadline的relation decision request，不能等模型产出relation后才留下第一条持久事实。模型失败时LOW risk可按预注册默认独立，HIGH risk必须走确定性人工选项或可见失败并保持写gate关闭。
5. 模型发现缺少信息时可以主动提问。只影响当前节点的信息问题仅暂停该节点；会改变权限、写入路线、依赖、join 或共享资源的问题必须先安全冻结受影响范围，再公开提问。冻结按 scope/barrier 生效，不自动阻塞同 work 的无关只读分支。

### 24.2 权威和执行路径

HCO 是 work、coordination graph、interaction、effect 和 delivery 的唯一状态权威。Hermes/Jarvis/Codex/LangGraph 只能提出候选动作或保存运行上下文，不能自行宣布节点成功、推进图、扩大权限或重复发送终态消息。

HCO 必须实现为“最小内核 + 可独立启停的 capability module”，不能实现一个同时理解全部业务状态的 mega-reducer。最小内核只负责 identity、trigger/occurrence、command receipt、outbox/delivery、storage health、leader/fence 和 capability registry；relation、budget、agent graph/join、workspace、external effect、freeze/interaction、retention 分属独立模块。每个模块只推进自己拥有的状态，跨模块默认只通过持久 fact、trigger 和 command receipt 通信。确需原子跨模块提交时，只能使用预注册、版本化且有固定参与模块、读写集合、行数预算和幂等 receipt 的 transaction recipe，由 HCO transaction coordinator一次提交；禁止临时拼接跨模块 SQL 或让一个 reducer 顺手修改别的模块状态。

`capability_registry` 必须保存模块版本、contract digest、schema/policy依赖、rollout scope、qualification evidence和状态 revision。模块状态为 `UNAVAILABLE | SHADOW | CANARY | ACTIVE | SUSPENDED`；`UNAVAILABLE/SHADOW`不得进入业务due scan、worker热路径、模型工具列表或模型上下文，`SUSPENDED`只允许运行已有事实的deadline/reconciliation/drain due，不接受新任务。模块必须能单独迁移、回滚、故障注入和灰度；一个可选模块故障时，内核继续处理 receipt、人工回答、取消/deadline、delivery reconciliation 和 storage health。模型只接收当前任务需要、默认不超过 4 KiB 的 compact capability envelope/delta，不接收完整状态表、未启用工具或所有 reducer 说明。

Transaction recipe必须显式标记`ADMISSION`或`DRAIN`。ADMISSION只接受`CANARY/ACTIVE` participant；DRAIN可以接受与原事实contract兼容的`SUSPENDED` participant，但只能结算既有deadline、取消、失败、已预创建且已封存授权合同的补偿、reconciliation和确定性降级，禁止创建新模型activation、新effect/authorization、扩大scope/权限或延长hard deadline。SUSPENDED后才发现需要的新补偿副作用必须进入有owner/deadline的人工裁决，或按封存policy安全收口为`COMPENSATION_FAILED`，不能借DRAIN补建effect。

Jarvis 综合与 HCO 确定性降级竞争的 final claim 只决定“同一份已经归约的执行事实由哪种文案交付”，不决定 work relation、execution outcome、权限或副作用路线。HCO 降级只能读取已经由对应 reducer 提交的权威事实；它不能用 `INDEPENDENT/CONFLICTS/SUCCEEDED` 等业务判断抢占 Jarvis proposal。claim 已被降级消息占用后，迟到的 Jarvis 内容只能在发现更高 revision 的权威事实时创建更正 supplement，不能覆盖业务状态或重复发送 primary。

系统有两条权威执行路径和一个轻量 profile：

```text
FAST_PATH
  单 Agent、无委派、无持久人工等待、无写副作用
  不创建协作图，不增加 Planner/Evaluator/Jarvis 固定调用

DURABLE_TRIGGER_ONLY
  单 Agent、无依赖/副作用/人工路线，但需要持久 reminder/checkpoint/条件复查
  只创建 durable trigger/occurrence/activation，不创建 coordination graph
  不是第三个work.execution_path；work仍为FAST_PATH，profile只属于trigger

DURABLE_PATH
  委派、依赖、join、ROUTE_MUTATING、局部返工或外部副作用
  使用持久节点、边、join、lease、fence 和恢复机制
```

FAST_PATH 从运行开始就只能获得物理隔离的 `PURE_COMPUTE` 和受范围约束的 `READ_ONLY` 工具，不能持有写凭据或绕过 Tool Gateway 的文件、Git、网络能力。无法证明 sandbox/worktree、临时目录、Git 和 credential 边界的环境必须将 FAST capability 标记为 unavailable，不得用 prompt 或工具名称代替物理隔离。任何 `WORKSPACE_WRITE`、`MUTATING_EXTERNAL`、`UNKNOWN`、relation proposal、子委派或 ROUTE_MUTATING 请求必须先完成 `FAST_PATH -> UPGRADE_PENDING -> DURABLE_PATH`，再由受限 runtime 执行；单 Agent无副作用checkpoint可以留在 `DURABLE_TRIGGER_ONLY`；升级完成前不得越过副作用边界。

Tool Gateway 必须区分 `WORKSPACE_WRITE` 与 `MUTATING_EXTERNAL`。受管sandbox/worktree内、无网络和外部凭据、可用journal恢复的多个本地文件操作可以合并到一个`workspace_write_session`，按session产生一次本地receipt，不为每个文件/格式化调用创建完整外部effect。session必须先持久化稳定logical edit identity和跨session唯一operation receipt，再允许越过文件写边界；编辑先落到私有staging/overlay，COMMITTING时才发布到共享workspace。重叠scope在`OPEN/COMMITTING/ROLLING_BACK/UNKNOWN`以及仍需裁决的`DEAD`期间由持久scope fence阻止新写；COMMITTING期间的重叠reader必须等待、读取不可变base snapshot或只能stash结果。Git push、Zulip、云API和任何无法证明本地原子恢复的写入继续使用完整effect/authorization/receipt/reconciliation协议；`UNKNOWN`一律按外部写fail closed。

私有staging/journal必须有独立、可恢复的清理生命周期，不能假设session终态后进程会顺手删除。创建workspace session前，HCO按该session最坏artifact字节同时从项目和全局容量账户预留额度；每个项目还必须有不超过全局hard cap的`max_share_of_global_bytes`，单个项目的清理故障只能停止该项目，不能无限吃满全局额度。成功提交或回滚且receipt、workspace revision和目录fsync证据齐全后，按retention policy先进入`ARCHIVE_PENDING`或`CLEANUP_DUE`；需要保留的artifact必须先写manifest/checksum并验证，再由有lease/deadline/幂等deletion receipt的reducer在writer事务外删除并fsync，最后且仅最后归还一次额度。删除前或删除后回执前崩溃都能按稳定artifact identity恢复。清理超时进入`CLEANUP_FAILED_HOLD`后，新的storage-health HEALTHY revision或持久recovery due必须自动、有界地重试同一artifact，不得在磁盘恢复后仍永久占额，也不得因健康探针抖动形成删除热循环。`UNKNOWN/DEAD + UNCERTAIN_HOLD`不得自动删除，且持续计入项目/全局quota；达到high-water优先清理，达到hard cap时在创建目录前拒绝新session并告警，不能等磁盘耗尽才停机。

升级只允许单向进行。并发升级意图必须合并到唯一 canonical run，并用 `safety_flags_revision` 封存所有安全要求后才启动 DURABLE activation/effect。升级超时或崩溃时进入 `UPGRADE_FAILED`，operator 可重试同一 canonical run 或 `SAFE_FAILED` 安全取消；不得回到一个已经暴露写意图的 FAST_PATH，也不得启动两个并行执行。

### 24.3 状态和交付

执行终态与消息交付终态必须正交保存：

```text
execution_state = TERMINAL_VERIFIED | TERMINAL_UNVERIFIED | non-terminal
execution_outcome = SUCCEEDED | PARTIAL | FAILED | CANCELLED | null
delivery_state  = DELIVERED | DELIVERY_UNCERTAIN | DEAD |
                  GROUP_OWNED | SATISFIED_BY_GROUP | non-terminal
```

`execution_state` 只表示生命周期及终态证据是否验证，`execution_outcome` 才表示该世代的业务结果；两者必须由HCO completion reducer按固定合同在同一事务写入。非终态的outcome必须为null，两个execution terminal的outcome必须是四个终态值之一。`TERMINAL_VERIFIED`不等于成功：验证过的失败仍是`TERMINAL_VERIFIED + FAILED`。模型声明、`work_requests.state`展示值和delivery receipt都不能代替该权威outcome。Jarvis面向Boss的综合发生在execution terminal之后，不能成为所有任务终态的隐含前置；只有sealed completion contract显式要求的Integrator/Evaluator才参与执行归约，并有deadline/降级出口。Zulip 暂时或永久不可达不能撤销已经确定的执行事实。fencing、迟到结果拒绝和 terminal tombstone 只依据执行终态、outcome、revision 和 terminal epoch。面向用户的综合状态可以显示“任务执行成功，但消息交付失败”或“任务执行失败且已通知”，不能把交付结果误写成执行结果。

`TERMINAL_UNVERIFIED`收到新的权威证据时，completion reducer可以在同一epoch用revision CAS修正state/outcome。若primary尚未创建effect，直接替换旧candidate；effect已创建但权威证明authorization未消费、adapter调用数为0且尚未越过dispatch边界时，同一事务撤销旧effect并替换为新revision primary。只有旧effect已经DISPATCHING、结果不明或终态时，系统才按`work + terminal epoch + execution revision`创建唯一更正supplement；它持久绑定前序claim/effect并按subject sequence等待前序CONFIRMED/DEAD后发送，前序DEAD时使用自包含文案，不能出现“更正先发、陈旧primary后发”。普通迟到模型结果只能进审计，不能借此重复宣告完成。

外部发送不承诺严格 exactly-once。发送结果只能是 `CONFIRMED`、`ABSENT` 或 `UNCERTAIN`；不确定时必须对账，不得盲目重发。

### 24.4 多 Agent 和 join

第二个 Agent 出现时必须升级为 DURABLE_PATH。委派通过持久、幂等的 proposal 事务创建，重复 semantic key 只能返回原 child，不得重复启动 Agent。父 Agent、子 Agent和 Evaluator 的完成声明都先是 candidate，只有 HCO 按 completion contract 接受后才能成为节点终态。

`agent.reactivate` 不是普通“再发一次消息”。每次请求必须携带稳定 `reactivation_operation_id + payload_digest + source_agent_activation_id/revision + source_node_id/expected_node_revision + reactivation_mode`。普通重新激活只接受已经`REPORTED/FAILED/FAILED_ORPHANED`的source activation；若source仍处于`CREATED/RUNNING/WAITING_CODEX/WAITING_CHILDREN`，HCO只能持久返回`ALREADY_ACTIVE`或先走独立的取消/接管流程，不能用reactivate抢占在飞attempt。`CONTINUE_NONTERMINAL_NODE`只允许原node尚未终态、run和work仍可推进、current activation仍是source时继续同一node；HCO在一个事务中结算/标记旧candidate、创建operation receipt和唯一新activation、更新node的`current_agent_activation_id`。

原node已经`SUCCEEDED/FAILED/CANCELLED/STALE`时禁止原地复活。只有run/work仍非终态且run处于`ACTIVE`时，才允许`CORRECTION_NODE_ACTIVE_RUN`：同一graph operation必须原子创建带`source_node_id`的required correction node、明确的父边或下一join generation membership、run completion contract/node-set revision、预算、operation receipt和start trigger；run终态CAS必须比较该revision，因此不能在修正node完成前越过它。run或work已经terminal时禁止向旧run追加node；需要继续执行时必须显式reopen到新terminal epoch并创建新run，旧node、旧join snapshot、effect和tombstone保持不可变。新epoch若修正已公开结论，只能按前序claim生成更正supplement。同一node同时最多一个非终态Agent activation。回执丢失后的同ID重放返回原新activation/node；Jarvis重试与reconciliation使用不同operation ID并发时，也只有一个能通过node/run revision CAS，失败方读取当前结果而不能再启动一个。

动态 join 必须先 `OPEN` 收集成员，再由 HCO collection reducer 经过 `SEALING` 固定成员集合。创建 generation 时就必须固定 `min/max/expected members`、`max_generations`、collection/seal deadline和timeout/invalid policy；父 Agent只能提交 seal proposal，不能拥有封口迁移权。父 Agent崩溃、预算耗尽、达到成员上限或deadline到期时，HCO必须确定性进入封口、失败或取消；SEALING owner崩溃后由lease-expiry reducer接管，不能永久停在 `COLLECTING/SEALING`。`join_members` 是 generation、成员、required 标记和结果摘要的唯一事实源。每次归约必须绑定不可变的 generation、数据库提交序号、reduction revision 和成员结果快照，不能用壁钟时间划分迟到结果。`QUORUM`、`ANY_SUCCESS` 等策略必须明确 required 节点、未完成成员、归约后的剩余成员策略和迟到结果处理；迟到结果不能改变已经提交的归约，只能进入下一 generation、补充报告或审计。Work merge的`ALL_SUCCESS`只接受`TERMINAL_VERIFIED + SUCCEEDED`，未验证成员等待到固定deadline后按预注册partial/fail/人工策略退出，不能按可变outcome提前成功或失败。

`NEXT_GENERATION` 必须区分两种语义。迟到结果的 `CARRY_FORWARD_LATE` 复用原 `node_id`，只创建新的 membership operation并保存 source generation/terminal sequence，不得重启 Agent；它只进入下一 generation 的新 snapshot/reducer，绝不能注入已归约 generation 的旧 Integrator、父 Agent thread或已提交 candidate。真正重新执行的 `RERUN` 必须递增delegation generation、创建新 `node_id`，并以 `source_node_id` 指回旧节点。若迟到事实与已提交结果冲突，policy只能创建新generation、明确更正/补充或要求RERUN，不得静默改写旧结果或已经发生的effect。旧 generation 行始终保留 `TERMINAL_CUTOFF`。数据库只禁止同一 node 同时存在于两个 OPEN generation，不得用全局 `UNIQUE(join_id,node_id)` 破坏迟到事实的跨代历史。

`required` 成员是成功归约的 veto：required 未成功时，`QUORUM/ANY_SUCCESS` 不能仅凭其他成员数量提前成功。归约 snapshot 一旦 seal 就不可修改；需要 Integrator/Evaluator 时进入持久等待态并带 hard deadline，超时按预先保存的确定性降级、partial、failed 或人工提问策略退出。

Merge group 的权威成员来源是 `work_merge_members`。`MERGE_MEMBER` relation 仅作为 membership transaction 的派生关系或审计证据，不得形成第二套可漂移的成员事实。`ONE_SUMMARY` 在 OPEN 阶段先登记唯一 ownership reservation，SEALED 事务成功后才将成员 primary 标记为 `GROUP_OWNED`；group 取消、过期或封口失败时释放 reservation，group receipt 成功后成员进入 `SATISFIED_BY_GROUP`，避免 reconciliation 把成员误判为漏发或留下无主成员。

`ONE_SUMMARY` 只有在成员尚无个人 primary external effect时才能取得 reservation。`AVAILABLE/LEASED` delivery claim只是内部文案/claim准备资格，运行时没有Zulip凭据、dispatch authorization或发送网络请求的能力；只有claim原子进入`EFFECT_CREATED`后，独立delivery effect才可按Gateway生命周期越过外部边界。reservation事务必须同时CAS成员`delivery_subject`的subject revision和当前primary claim：无claim可直接预留；`AVAILABLE/LEASED`且`effect_id/adapter request`为空、adapter调用数为0的个人claim必须在同一事务变为`ABANDONED`并递增subject revision；个人claim已经`EFFECT_CREATED/DELIVERY_UNCERTAIN/CONFIRMED/DEAD`时拒绝`ONE_SUMMARY`或改用`SUMMARY_AND_INDIVIDUAL`。个人claim的`LEASED -> EFFECT_CREATED`不是“先重验、后插入”：同一条件写事务必须验证claim lease/state、`delivery_subject.primary_claim_id/subject_revision`、没有active ownership/group owner且adapter调用数为0，插入唯一effect并更新claim；任一条件影响行数不是精确1就整笔回滚。若个人claim先创建effect，reservation CAS失败；若reservation先成功，旧claim不能再越过effect创建边界。reservation只可在 OPEN/SEALING 且 group尚未创建发送 effect时释放；SEALED、发送不确定或已确认后必须由原 group claim接管，不能恢复成员各自发送。

Merge group 必须由唯一HCO reducer推进`OPEN -> SEALING -> SEALED/COLLECTING -> READY_TO_REDUCE -> REDUCED/PARTIAL/FAILED`，并为取消和人工分支保存独立状态。创建时固定seal/reduce/hard deadline、reducer lease、成员上限和最坏事务行预算；默认最多32个成员，实际cap按256行事务预算继续降低。`ONE_SUMMARY`必须在`SEALING -> SEALED`同一事务创建稳定group final claim；SEALED以后任何超时都由该claim发送partial/failure/cancel结果，不能裸`EXPIRED`又继续压住成员primary。member callback或coordinator丢失后，due sweep仍按固定member snapshot接管同一group claim并生成确定性降级汇总。`MANUAL`不得作为裸completion policy；只有带proposal owner、interaction revision和deadline的`ASK_HUMAN`失败分支可以等待人工，超时按预注册partial/fail策略退出。

需要Boss确认的work relation必须有持久的`QUESTION_PENDING/WAITING_CONFIRMATION`生命周期、`WORK_RELATION` proposal owner、interaction/delivery revision和confirmation/hard deadline。问题尚未确认送达时不能显示“等待Boss”；回答、发布失败、失联或超时都由唯一relation reducer用revision CAS结算。Relation proposal必须固定双方terminal epoch、relation projection/context/safety revision，并在发布、回答和实际应用前重验；等待期间target reopen或scope变化时旧问题STALE，不能把旧回答作用到新任务世代。安全默认是不合并、不替代、不扩大写范围。

同一pair的已确认关系和待确认替换关系必须分槽：关系行本身分别标记`CURRENT`与`PENDING_REPLACEMENT`，数据库各自最多允许一条。创建替换proposal不撤销旧`CURRENT`；发布失败、拒绝或超时只结算pending，旧关系及其active wait继续有效。确认单条或relation result-set必须进入HCO有界writer queue，在同一短写事务内重验旧current relation ID/revision和新proposal完整snapshot；旧current历史化、旧wait结算、pending晋升和新wait创建都使用带完整revision/state/role条件的写入，并逐项断言影响行数，任何0行/多行或SQLite snapshot升级失败都整笔回滚重读。每pair最多一条relation来源active wait，单set默认最多8个pair且必须在公开问题前按256行上限预留最坏结算预算；容量不足时整个set在admission失败，不能先提问后确定性撞墙。一个target的其他下游是独立pair，不在本次replacement事务中批量改写。target reopen或relation-relevant scope/acceptance/context/safety projection revision使旧current固定snapshot失效时，confirmed-relation validity reducer按旧epoch结算关联wait并把旧current历史化；普通执行进度、通知和审计revision不进入该projection，不能导致关系反复失效。Validity reducer与新proposal并发时使用pair/relation revision CAS，不能永久占槽，也不能把旧epoch关系作用到新epoch。

`WAITING_RELATION_CONFIRMATION/WAITING_DEPENDENCY`只是展示reason，权威work状态统一为带active owner/revision/effective deadline的`WAITING_INPUT`。每条依赖wait还必须固定目标work/terminal epoch、`EXECUTION_SUCCEEDED/EXECUTION_TERMINAL/DELIVERY_CONFIRMED`条件和failure policy；`EXECUTION_SUCCEEDED`只接受同一epoch的`TERMINAL_VERIFIED + execution_outcome=SUCCEEDED`，验证过的`PARTIAL/FAILED/CANCELLED`必须立即走不可能满足/failure policy。目标execution或delivery revision变化事务确定性唤醒，callback丢失由due sweep补扫，条件不可能或deadline到期必须退出。同一dependent/target epoch只能有一条active wait；反向fan-out受同话题active-work上限和256行终态事务预算约束，默认最多32个active work。超过上限必须在relation/wait admission前可见拒绝，不能让任务结束事务无限放大。

每个 trigger occurrence 只能创建一个逻辑 activation，但多个来源 occurrence 可以通过持久 `activation_trigger_members` 合并到同一个 activation；合并只减少模型调用，不删除 occurrence、旧membership或事件身份。activation在创建时固定`budget_lineage_id`，普通成员只有lineage相同才能直接合并；关系判断、join角色等跨来源事件必须先归一到各自专用的稳定预算lineage。所有入口必须使用同一个versioned lane normalizer：`scope_kind + scope_id + scope_epoch + activation_kind + target_kind + stable_target_route_key`。WORK使用`work_request_id + terminal_epoch`，TOPIC_RELATION使用`topic_context_id + relation_lane_generation`，JOIN_ROLE使用`join_id + join_generation + role`；work/relation revision和`input_projection_digest`只属于activation snapshot，不能让新revision绕过去创建第二个active model activation。一次 activation 可以有多个带独立 fencing token 的 attempt；`activation_candidates` 按 `(activation_id, outcome_revision)` 唯一，且一个 activation 最多一个 accepted outcome。activation重试由唯一 `activation_retry_schedules` 保存due、预算和hard deadline，不依赖primary occurrence。OPEN成员取消时可用revision更新role/state并提升primary，但occurrence-to-activation绑定、member sequence和identity不可变；SEALED后role/state和snapshot也不可改。SEALED成员取消时旧activation必须STALE并结算全部旧occurrence，仍成立的条件通过新的幂等`REEVALUATE` trigger/occurrence继续，禁止把旧occurrence重绑到新activation。父trigger只保存规则和recurrence生命周期，occurrence才是lease和自身重试的事实源。相同 `semantic_scope_key + semantic_key` 重放必须返回原 trigger，不同 payload digest 必须拒绝；周期 occurrence 默认串行，missed occurrence 按 policy 合并。

`REEVALUATE`必须是新的ONCE trigger，不得重新激活已经`COMPLETED/DEAD`的父trigger。成员取消、T2 projection CAS失败、权限/依赖/resource fence变化和reconciliation判定stale共用一个创建事务：以source activation/member、旧trigger/occurrence、最新condition fingerprint/input projection和reason class生成versioned identity，写唯一reevaluation receipt、新trigger、occurrence 1及旧member的replacement pointer。相同identity/digest重放返回原新trigger，不同digest拒绝；条件不再成立、预算耗尽或policy拒绝也必须写terminal receipt并收口owner。新trigger继承原lineage预算和hard deadline，不能借连续重评重置预算。Activation实际member cap必须按最坏stale结算写放大反推，包含旧事实结算、receipt、新trigger/occurrence和replacement pointer；超过单事务行预算的事件在OPEN阶段进入SLOT_WAIT，不能等SEALED后拆分原子结算。

TOPIC_RELATION的budget lineage耗尽后不能靠重启、新work或普通activation重置，也不能让长寿命topic永久失去关系判断。HCO必须用持久`relation_lineage_rollover`在旧relation模型lane完全quiescent后原子seal旧root，并通过多条grant同时从topic/provider/global父预算CAS预留有界新tranche，创建唯一新generation/root/lineage；旧activation、proposal、relation和receipt不迁移。父级累计用量、rollover频率和总额度持续累计，换代不能绕过限额。Relation request admission与rollover都必须CAS topic relation revision/generation/current rollover pointer：request先提交就计入旧代quiescence，rollover先提交则request只能进入新代，不能在换代后向sealed lineage追加activation。旧lineage耗尽或rollover已PENDING时，新request只加入有条目/字节上限和自身deadline的rollover membership，不创建模型activation；rollover终态只写release fact，再由固定批次receipt按风险唤醒/结算成员。旧lane未quiescent时rollover带not-before/hard deadline等待并由lane release唤醒；到期仍失败时LOW risk默认独立，HIGH risk走固定人工选项或可见失败并保持mutating gate。并发请求共享同一rollover operation/receipt，不能创建双generation、双模型activation或超大终态事务。

稳定lane使用持久lane state保存当前activation、release revision、waiter sequence/count/精确accounted bytes和容量。SEALED lane上的新occurrence进入`SLOT_WAIT`；blocker终态时若有waiter必须原子进入`DRAINING`并写唯一release fact，不得在同一事务更新全部waiter。`DRAINING`期间新T1也只能排队，不能抢占看似空闲的lane。slot-wait reducer按固定行数、持久weighted-deficit budget lineage顺序分批处理；需要下一次模型调用时每次最多创建一个新activation，其余waiter去重、消费或重新绑定当前blocker。每lane waiter达到条目/字节上限后只能按确定性overflow policy聚合、拒绝或降级，并为已领取occurrence写可见settlement receipt，不能扩大终态事务或回到READY热循环。

FAST 到 DURABLE 的每个升级请求必须先写入持久 `work_upgrade_intents`，携带稳定 operation ID、payload digest、tier revision 和安全 flags。升级封口事务必须在同一数据库提交中证明当前 tier 的所有 accepted intent 都已合并，再允许创建 DURABLE activation 或 effect permit；旧 tier 的迟到 intent 只能进入 stale/audit。Effect intent 同样必须以 `effect_id` 为主键，并对同一 group 内的 semantic key 建唯一约束，防止 outcome 重试创建两个相同外部动作。

同一 effect 可以被多个 effect group引用，但外部动作只能有一个权威 `effect_id`。`effect_group_members` 是每个 group的成员/required事实源，`effect_intents.origin_effect_group_id` 只记录首次创建归属；group按 sealed membership digest归约，不能按 origin字段计数或为复用动作再发一次。E1只允许跨group复用已 `CONFIRMED`、`post_confirmation_reuse=STABLE_FACT` 且没有补偿/撤销义务的既成事实；`COMPENSATABLE`、已有/可创建compensation row、或确认后仍可能被取消/反转的effect一律返回 `EFFECT_TERMINAL_REUSE_REQUIRES_CONSUMER_TRACKING`。因此一个group不能在另一个group已按X成功并交付后把X静默补偿掉。终态consumer retention claim、失效传播和更正通知属于E2门禁；实现前不得靠“terminal group不再是active demand”绕过。命中未完成effect同样fail closed。E2通过专项故障注入后才允许复用未完成或可撤销effect；物理合同必须同时匹配传递effect依赖、全部group调度依赖、execution profile、adapter/version、payload/target、deadline、retry/uncertain、资源能力、consumer-retention和取消补偿策略，任一不同就原子拒绝 `EFFECT_MEMBERSHIP_POLICY_CONFLICT`。SEALED group取消不能删除其他 active group依赖的成员或依赖闭包，也不能抹掉复用比较基准。

Effect group 不提供无owner的`completion_policy=MANUAL`。外部事实不确定统一走有decision owner、proposal/interaction或operator receipt、decision/hard deadline的`effect_adjudication`；required补偿无人裁决时，deadline reducer按安全默认进入`COMPENSATION_FAILED`并告警。E2进入补偿时，权威证明原动作未发生的补偿row必须结算为`NOT_APPLICABLE`：它满足补偿DAG的`TERMINAL`边但不满足`CONFIRMED`边；后者不可能满足时立即失败传播，不能让实际需要执行的下游补偿永久BLOCKED。

共享interaction proposal和effect policy conflict必须在绑定owner/requester前预留最终结算行预算。这里的proposal owner是等待同一答案的内部work/node/conflict，不是“有资格回答的人”；授权审批人集合由interaction ACL/approval policy固定，同一已发布interaction收到任何合格审批人的回答都结算当前generation，不会因为回答者较晚出现就创建下一generation。默认单proposal最多32个owner、单conflict最多32个requester、proposal settlement最多192行，实际cap按最坏写放大继续降低。proposal进入`DELIVERING`时owner set永久seal；之后到达或满额的内部owner进入带`PROPOSAL_QUEUED`状态的下一generation，持久引用前代并由generation reducer在前代answer/terminal receipt后机械结算或接替公开，不能加入已发布问题。后代尚未取得自己的gate前，前代终态只结算前代barrier；不能把仍有合法后代的队列误当成同一个freeze失败，也不能让后代回答释放前代gate。conflict requester满额时新node进入有due/hard deadline的BACKPRESSURE。任何实现都不能先无限合并，再在回答/超时事务中突破256行上限或把barrier永久冻结。

多 Agent 图的 operation ID 必须单独唯一；payload digest 只用于判断同 ID 重放是否一致，不能和 operation ID 组成一个允许同 ID 多 digest 的复合唯一键。`join_barriers` 以 `(join_id, join_generation)` 为主键，edge 对 nullable generation 使用可真实执行的 partial unique index。所有文档声明的 `BACKPRESSURE`、`CONFLICT_REVIEW`、问题排队和 freeze uncertain 状态都必须存在于权威枚举，并具有 deadline、重试、取消或人工裁决出口。

### 24.5 性能和模型成本

#### 24.5.1 Token usage 批量结算合同

Token 统计必须按“attempt 内聚合、批量结算”实现，不能按每个 token 或每个小 streaming chunk 更新共享主账本。provider callback 先只更新 attempt-local accumulator；达到版本化的 `usage_flush_interval_ms`、`usage_flush_token_threshold`、`usage_flush_bytes_threshold` 任一阈值，或收到 response terminal callback 时，才以单调 `usage_batch_sequence` 批量 CAS `attempt_usage`、`activation_budget_reservations` 和 `lineage_budget_ledger`。默认部署必须声明 accumulator/spool 最大字节、最大未结算 token、flush 重试次数和 `usage_deadline_ms`；参考默认值为 250ms、4096 tokens、64 KiB、1 MiB、16384 未结算 tokens、3 次 flush 重试，部署只能按资源和 provider 合同收紧，不能取消上限。

超过内存上限时必须写入有界、可校验、可重放的 attempt usage spool，不能无限堆内存，也不能退回逐 token 写 SQLite。每个 batch 使用 `(attempt_id, usage_batch_sequence, source_event_id, payload_digest)` 去重；相同 batch 重放返回原 settlement receipt。flush 事务只做短时 CAS 和事实写入，禁止等待 provider、模型、网络、文件或对象存储。

flush 前崩溃时，provider correlation/reconciliation 优先重放权威 usage；无法证明时由唯一 settlement reducer 按封存 attempt ceiling 和 policy 估算一次并标记 `ESTIMATED`，保留不确定事实，不能返还未知余额或放宽父账户 admission。迟到 usage 只能按同一 policy 审计或向下修正。provider call 越过边界前的单次 reservation CAS 仍必须保留，不能用批量 token flush 替代。

#### 24.5.2 SQLite writer transaction 合同

只有需要跨模块线性化的短写配方才能使用 `BEGIN IMMEDIATE`。事务开始前必须完成 payload 解析、大 artifact 读取、写集/行数预算和权限校验；持锁期间禁止模型调用、provider/Zulip/网络请求、文件写、对象存储、等待其他 lease 或调用外部服务。

`CRITICAL/CONTROL/BULK` 分别使用版本化的 `max_hold_ms`、`max_rows_per_transaction`、busy retry 次数和 hard deadline；参考默认持锁上限为 100ms、250ms、250ms，busy retry 为 4 次，退避为 5/20/80/160ms 加 jitter，部署可以收紧但不能取消 hard deadline。`SQLITE_BUSY`、`SQLITE_BUSY_SNAPSHOT` 或 affected-row 不符合预期时必须整笔 rollback，丢弃旧读快照，按有界指数退避加 jitter 重新入队并从新 snapshot 重读，不能在原事务内自旋。超过 deadline 后，BULK 进入有 due 的 `BACKPRESSURE/RETRY_WAIT`，CONTROL 进入 `DEGRADED_PENDING_OPERATOR` 或由 reconciliation 接管，CRITICAL 写入失败则进入 `STORAGE_UNHEALTHY` 并停止新副作用。

超过行数或持锁预算的 fan-out、release 和 settlement 必须在 admission 时固定 generation/cursor，以持久 batch receipt 和共同业务 CAS 分批提交；不能把需要原子切换的操作临时拆成多个无共同条件的事务。qualification 必须分别记录 queue wait、busy time、lock hold、rollback/retry 和关键子类别等待；当前 p95/p99 仍属于待验证门槛。

系统不得把 Planner、Executor、Evaluator 变成固定三次模型流水线。版本查询、状态查询、文件存在性和已有结构化 receipt 应由确定性 handler 直接处理和交付。FAST_PATH 默认 capability delta 不超过 4 KiB；DURABLE_TRIGGER_ONLY不创建coordination graph；HCO 新增排队/归约开销 p95 目标不超过 250ms，本地确定性任务端到端 p95 目标不超过 2s（均不含模型 provider 和 Zulip 网络时间）。

`CODEX_EVENT` 必须先经过 deterministic classifier。简单结构化结果直接由 HCO/deterministic handler 交付，不自动唤醒 Jarvis；只有 completion contract 要求综合、冲突解释、路线选择或人工问题时才创建模型 activation。completion、SLA、reconciliation 和 dependency event 的WORK lane使用稳定 `work + terminal_epoch + activation_kind + target_kind + stable_target_route_key`；relation和join role分别使用同一normalizer定义的topic relation generation和join generation lane。`input_projection_digest`、relation/work revision和时间窗口只作为输入snapshot/batch key。每个稳定lane只能有一个active model activation；事件只有在lane可接收且预算lineage相同时才能追加，其他事件进入有界`SLOT_WAIT`。目标或预算lineage不同的Jarvis/Agent事件不得错误合并。relation decision、checkpoint、Integrator和Evaluator也必须有稳定lane和独立、不可因primary变化而转移的预算。

模型 wakeup、provider call、token、question 和 no-progress 预算写入持久 lineage ledger；每个activation在首次创建时原子预留唯一budget reservation，所有attempt复用该reservation，primary提升、取消、重启、重放和session重建都不能改变归属或重置计数。预算采用控制面/执行面分层：lineage首次授信、tranche续期、到期回收或换代时，控制面同时CAS适用的work/topic/join、provider和global父账户；单次attempt热路径只更新lineage、activation reservation、attempt usage和独立provider capacity lease，不在每次call/token callback上更新provider/global热行。provider/global额度按固定policy revision、时间窗口和稳定shard预分配互不重叠的父账户上限，所有shard上限之和不得超过该窗口hard cap；lineage只能花已取得且未过期的grant，临时闲置额度不能凭统计rollup再次授予。每次grant/续期/返还/rebalance必须使用稳定operation ID、payload digest和同事务receipt；同ID不同账户、金额或policy必须拒绝。每个attempt在越过provider边界前都必须单独把一次call reservation转为used，并按权威usage或到期估算独立结算token；T2前崩溃、FENCED和迟到usage不能让旧attempt漏账。重试attempt必须在原grant内扩充reservation；grant不足时先走低频tranche续期，父账户CAS失败则不得调用provider。外部事件必须有认证、时间窗和稳定 `source_event_id`，否则 fail closed，不创建 trigger。

Provider capacity slot的lease到期不能直接释放：已越过provider边界而结果未知时先进入`RECONCILING`。只有provider终态、确认取消、可验证permit/fence回收或provider合同保证的最大执行时限证据才允许回到AVAILABLE；仅本地超时、transport关闭或UNKNOWN全额计费时保持`HELD_UNCERTAIN`并触发provider-shard熔断/告警。

进入`HELD_UNCERTAIN`时必须同事务创建带稳定operation ID、slot/attempt revision、decision owner和hard deadline的capacity adjudication。无provider证据时只允许`RETAIN_HOLD`或`DISABLE_SHARD`，不能由operator或超时伪造AVAILABLE；分片恢复使用有owner/lease、hard deadline、持久cursor和batch receipt的有界扫描，worker崩溃可接管，超时回DISABLED。operator只能授权降容恢复，不能替代provider证据释放held slot。预算账户主键和grant外键必须共同包含logical scope、window和shard；grant还要封存父账户policy revision，不能用动态account revision充当持续有效性条件；非窗口预算固定`LIFETIME/0`，窗口/分片只能由policy revision分配。

每个 trigger 必须直接保存 `lineage_id`、`root_trigger_id` 和可选 `parent_trigger_id`，不能在调度热路径临时沿 activation/parent 链反查预算。周期 trigger 的父游标使用 `trigger_revision + next_occurrence` CAS；默认串行模式对 `SCHEDULED/READY/LEASED/ACTIVATION_PENDING/COALESCED/SLOT_WAIT/RETRY_WAIT` 建单一 active-occurrence 约束。所有 semantic key 和 payload digest 使用同一版本化 canonical JSON + SHA-256 规则生成，禁止各组件自行拼接字符串。

新消息先由确定性 admission 处理：无显式引用、无共享写资源、无验收条件变化且没有回答某个 interaction 时，默认创建独立 work，不调用关系判断模型。只有确有关系信号时才让 Jarvis 提议关系。

每次 activation 只注入当前 work/node 所需的限长 capability delta。结构化主动性判断应与主响应同一次生成；解析失败默认 `NONE`，只有模型已经公开承诺主动动作时才允许一次修正。stale 结果先由代码比较投影变化，只有语义输入确实改变且预算允许时才重新调用模型；默认同一 node 10 分钟最多自动重评 5 次，相同原因连续 3 次即进入 backpressure/conflict review。

DURABLE_PATH 的 HCO 机械调度/归约开销目标为 p95 不超过 500ms、p99 不超过 2s，sealed join 应在 p95 1s 内开始机械归约，均不含模型 provider 和外部网络时间。SQLite writer queue必须声明容量、关键保留槽和最大持锁时间；按`CRITICAL/CONTROL/BULK`排队，CRITICAL至少保留25%容量。CRITICAL公平必须同时覆盖首次ingress和事实入库后的reducer：认证后按可信source principal及receipt、人工回答、取消/deadline、delivery/storage health划分保留槽，并按source/work限流和加权公平调度；单一异常adapter不能占满全部关键容量。可重试来源在主writer前收到带`Retry-After`的backpressure；不可重试关键来源先按稳定source event ID写入独立、有界、fsync的durable spool，spool提交后才ACK。spool满或持久化失败进入`STORAGE_UNHEALTHY`并停止新副作用，不能退回无界内存。达到70%停止BULK fan-out，达到90%拒绝新的BULK和非必要CONTROL，但继续处理关键事实。默认单事务最多写256行，activation/join/effect group/merge group绝对成员上限分别为128/64/64/32，proposal owner和conflict requester默认各不超过32，proposal settlement默认最多192行；lane waiter也必须有独立条目/字节上限。实际cap还要按每成员/owner/requester的最坏写放大从256行预算反推并取更小值。超过任一上限必须封口、分代、分批release、进入有deadline的backpressure或fail closed，不能扩大单事务。activation member、join terminal、upgrade intent、effect/merge成员、proposal owner、conflict requester和workspace operation只要求聚合内有序，使用各自父实体的local sequence/revision；只有跨实体reconciliation change log保留全局序列，避免无意义热点行。

上述 SLO 不是上线承诺，必须由软件资格门禁转换成可验证证据。每个 capability/profile 绑定固定硬件、SQLite/WAL参数、数据库规模、并发、事件混合、每条路径的模型调用/prompt/队列阈值、binary/schema/policy digest和有效期，qualification 状态为 `NOT_RUN | PASS | FAIL | EXPIRED`。测试至少包含 deterministic synthetic handler、脱敏生产事件回放和不产生真实副作用的 shadow reducer；shadow/replay不得调用真实模型、Zulip、文件写、Git或外部adapter。有效`PASS`只允许进入受限scope的`CANARY`；进入`ACTIVE`还必须有匹配current head、scope、组件版本/部署digest、故障矩阵和sealed窗口集合的不可变真实集成evidence manifest、规定数量的连续完整CANARY GOOD窗口和幂等promotion receipt。每个capability使用一个可升级revalidation mailbox合并TTL、head失败、deployment变化和安全撤销；head失败/安全撤销的事实事务先原子停止admission并递增registry revision，再升级mailbox，不能被远期TTL任务占槽。连续观测窗口超标时，软件自动停止扩大灰度并按`NORMAL -> THROTTLED -> DRAIN_ONLY/SUSPENDED`降级：先关闭BULK、fan-out和非必要模型复核，始终保留receipt、人工回答、取消/deadline、delivery reconciliation、storage health和已发生副作用对账。writer queue、WAL/磁盘、cleanup backlog和provider latency分别治理，不能用一个总延迟掩盖瓶颈。qualification、监控、限流、熔断、promotion和恢复均不得唤醒模型。

Qualification runner自身也必须可恢复：稳定operation/run key包含capability、profile和全部digest，同一key最多一个`QUEUED/RUNNING`且最多一个带head revision的current run；创建新attempt必须原子推进current head，旧PASS立即失去新的rollout资格。run持久化lease/fence、attempt、artifact checkpoint和hard deadline。runner崩溃或lease到期由唯一reducer收口为`EXPIRED/FAIL`并写terminal receipt；只有current head的`COMMITTED + PASS`、head revision、registry revision和全部digest同时匹配时才能进入CANARY，进入ACTIVE另走真实CANARY promotion门禁。

Capability失效必须明确处理在飞工作：安全撤销或deployment/contract digest变化会fence尚未越过外部边界的旧activation，已越界调用只按旧contract对账/DRAIN且不能重试；仅证据TTL到期且deployment未变时，已RUNNING的纯只读FAST任务可以在原hard deadline内完成，但T2必须重验输出schema/work/safety revision，不能创建新attempt。新PASS只授权新activation，不能复活旧attempt。Provider capacity lease/adjudication/shard recovery与qualification/revalidation各使用独立CONTROL恢复配额和due SLO，不得被BULK fan-out挤死。

缺少任一required metric的窗口为`INCOMPLETE`：立即停止扩大灰度，不算GOOD、不清零BAD、不得参与恢复；连续INCOMPLETE达到profile上限后按policy进入THROTTLED或`SUSPENDED + DRAIN_ONLY`，不能因监控坏了反而永久保持ACTIVE。

当前仍处于文档设计阶段，没有真实qualification evidence，因此所有新增V2 capability的资格状态按`NOT_RUN`处理；本PRD中的p95/p99数值只是待验证门槛，不能据此声称“已可上线”。

预算、重试、超时、健康、清理、指标、限流、CAS、授权和SLO门禁全部由软件执行。模型只负责语义关系、任务分解、结果综合、无法机械解决的冲突解释和人工问题措辞；模型不得自行计算余额、选择重试时机、宣布健康恢复、绕过Gateway或推进业务状态。简单版本查询、状态查询和结构化结果的模型调用数不得因启用本机制而增加。

### 24.6 发布顺序和门禁

| 发布 | 范围 | 不得隐含依赖 |
| --- | --- | --- |
| A1 | `CODEX_EVENT/WORK_STATE/OPERATOR_RECOVERY`、双通道交付、final claim、bounded reconciliation、FAST_PATH确定性交付、最小stable lane/单active review、有界等待释放、基础retention执行者 | reminder、calendar、webhook、多 Agent、freeze |
| A2 | 一次性reminder、DURABLE_TRIGGER_ONLY、模型checkpoint、跨时间due恢复、多waiter按lineage公平分批drain | calendar/DST、外部webhook、多 Agent |
| B | FAST到DURABLE唯一升级点、只读/纯计算父子图、幂等委派、线性依赖、runtime supervisor | 动态join、写能力、复杂evaluator |
| C1 | `WORKSPACE_WRITE`、私有staging、workspace journal/receipt/scope fence、项目/全局artifact quota、持久cleanup/deletion receipt、Tool Gateway本地classification/sandbox/staging core | 外部effect、复杂freeze、外部adapter authorization |
| C2 | 两类人工问题、局部freeze、Tool Gateway外部authorization/adapters、单外部effect/线性effect group | 通用Effect DAG |
| D | calendar/DST和认证webhook、join generation/seal、按需integrator/evaluator、merge group delivery | LangGraph、复杂补偿 |
| E | 有真实需求后再实现未完成或可撤销effect跨group复用、terminal consumer retention/失效传播、通用Effect DAG、复杂补偿、可选LangGraph adapter和高级冷归档/远端生命周期自动化 | 不作为前述发布门槛；A1-D仍必须有基础retention执行者 |

每个发布只能开启已经通过真实 Hermes、Codex App Server、runtime supervisor、delivery sidecar 和 Zulip 故障注入的 capability。未实现或未验证的能力必须 fail closed，并向模型和运维界面暴露真实 unavailable 状态。

发布状态由`capability_registry`和有效qualification证据共同决定，而不是部署脚本中的单个feature flag。`SHADOW`不能取得外部授权或推进业务状态；`CANARY`只能服务明确rollout scope；`SUSPENDED`停止新admission但必须继续drain/reconcile已经接收的关键事实。模块依赖图、transaction recipe contract或qualification证据不兼容时，启动校验必须把相关能力置为`UNAVAILABLE`，不能让模型在运行时试错。

V2 设计门禁还必须证明：

- trigger occurrence、activation、stale 和 delivery claim 均有持久唯一身份与恢复出口；
- upgrade intent、effect intent、graph operation、join barrier 和 interaction proposal 均有数据库可执行的主键/唯一键，不能只靠应用层先查后写；
- 局部 freeze 只阻塞重叠 scope，closure 超限时在写 fence 前安全失败；
- `FREEZE_SCOPE_UNCERTAIN`、问题排队和 node backpressure 均有持久状态、hard deadline 和确定性唤醒/退出路径；`RESUMING`只有accepted stash-review receipt才能释放，review失败/超时进入`SAFE_FAILED + UNCERTAIN_HOLD`而不是误放行或永久伪运行；
- `UPGRADE_FAILED` 可重试同一 canonical run 或安全取消，旧 FAST activation 不恢复写权限；
- join collection deadline、HCO seal owner、join_members、terminal sequence、post-reduction policy 和迟到结果策略可重放；`CARRY_FORWARD_LATE`复用旧node但不重启，`RERUN`使用新node/delegation generation，两者均使用新membership identity且同一node不能同时占用两个OPEN generation；
- Agent重新激活必须有跨重试稳定的operation receipt、source activation/node revision CAS和node级单active activation唯一约束；回执丢失、Jarvis重试和reconciliation并发不能让同一node双跑；
- `ONE_SUMMARY` 成员进入 `GROUP_OWNED/SATISFIED_BY_GROUP`，seal事务原子创建稳定group claim，唯一merge reducer在callback/coordinator故障或SEALED超时后按due接管并交付partial/failure；merge成员、seal事务和人工分支均有容量、lease和hard deadline；
- primary final claim 跨 candidate revision 只有一个 terminal slot，迟到报告只能成为 supplement。
- activation attempt、provider correlation 和 accepted outcome revision 可追踪、可重放，旧 attempt 迟到不能推进业务状态；
- trigger semantic scope、source event、occurrence 和 parent trigger 的唯一约束/状态边界明确，周期 occurrence 默认串行且 missed policy 可恢复；
- relation proposal/confirm/reject 使用 revision、operation digest 和有效状态 CAS；人工确认绑定`WORK_RELATION` owner、interaction revision和confirmation/hard deadline，失败/不答时只结算pending replacement，仍有效的current不变；current snapshot失效由validity reducer历史化并释放current槽；已确认dependency wait固定目标epoch/condition/failure policy并由上游revision或due唤醒；`MERGE_MEMBER` 只能从 membership transaction 派生；
- `ONE_SUMMARY` 的 ownership reservation、group seal、release 和 group receipt 全部可恢复，不留下无主 `GROUP_OWNED` 成员；
- `CODEX_EVENT` 先走 deterministic classifier，同一稳定active lane最多一个模型activation；input projection变化只能排队，恢复不得重置lineage budget。
- `terminal_epoch` 从 work创建到该世代终态保持不变，只在显式 reopen时递增；terminal tombstone、merge、delivery、upgrade和activation引用同一世代。
- activation/Agent/effect 的每次执行 attempt都有独立 lease、fence、deadline和持久身份；重试不能覆盖旧 attempt。
- closure不确定时必须保留 scoped provisional freeze gate；interaction proposal发布后必须随回答、超时或取消进入持久结算终态。
- upgrade retry、运行中 safety expansion、join角色等待和 uncertain人工裁决都有同事务迁移、hard deadline和确定性出口。
- reconciliation cursor有固定 high-water、EOF回绕和 oldest-overdue补扫，后补的早期 due记录不会永久漏扫。
- relation propose/confirm/reject各自保存 append-only operation receipt；响应丢失后可返回原结果。
- activation重试以唯一 `activation_retry_schedules` 行为due事实，occurrence级重试和effect使用各自实例due；primary occurrence取消、父trigger终态或成员变化不能吞掉activation重试或留下无owner状态。
- activation在创建时固定budget lineage和唯一reservation；不同预算lineage不能直接coalesce，primary变化和attempt重试不能转移、重复扣减或重置预算。
- SEALED activation因成员取消或projection失效时，旧trigger/occurrence保持terminal；仍成立的业务条件只能通过统一source identity和reevaluation receipt创建新的ONCE trigger/occurrence，不能re-arm旧trigger或把旧membership换绑到新activation。
- TOPIC_RELATION预算换代必须有持久operation receipt、旧lane quiescence门禁和topic/provider/global父预算CAS；只创建一个新generation/root/lineage，累计预算与换代频率不重置，超时按relation risk确定性收口。
- 已sealed activation占用coalescing slot时，新occurrence进入带blocker和hard deadline的 `SLOT_WAIT`；只有真实重试可使用带非NULL due的 `RETRY_WAIT`。blocker终态只提交lane release fact，waiter按有界批次和公平lineage顺序释放，不能把无限waiter塞进终态事务。
- effect group通过 sealed `effect_group_members` 复用同一 effect，不改写 origin、不重复外部动作；E1跨group复用只接受不可再补偿/撤销的`STABLE_FACT`，可补偿事实的终态consumer追踪和失效传播未启用时必须fail closed。
- effect dependency按 group持久化；共享非终态 effect的传递依赖闭包/复用策略完全一致，group取消不影响其他 active group的调度前提。
- effect group补偿成功进入独立 `COMPENSATED` 终态，只表示补偿完成，不能冒充原动作或work成功；group依赖使用可实际匹配的 `SUCCEEDED/TERMINAL/COMPENSATED` 条件。
- required effect的所有传递前驱也必须required；依赖条件明确不可能满足时确定性取消后继并触发失败/补偿，不能让group永久停在 `BLOCKED`。
- 共享effect的取消/补偿策略冲突使用持久 conflict、确定性重评trigger和hard deadline；冲突消失可自动恢复，持续冲突才提问人工。
- `BLOCKED -> READY -> LEASED` 每一步都由HCO按固定effect/group revision重验dispatch资格；依赖变化会触发确定性重评，deadline后必须失败、补偿、取消或进入人工出口。
- group dependency必须随dependent group一起seal且之后不可变；E1只依赖已seal/terminal group，E2批量建图在一个事务内对group、共享effect及全部前提构造wait-for图并做无环检查，不能形成显式或隐式跨group等待环。
- group canonical identity在seal时按完整成员、required、effect/group依赖和全部执行策略生成；effect dispatch摘要在首个group seal时CAS固定，OPEN草稿不能提前冻结错误合同。
- `TERMINAL/COMPENSATED` 只能作为非required cleanup/mitigation顺序；required effect闭包使用 `CONFIRMED`，required group dependency只能等待 `SUCCEEDED`。
- `LEASED -> DISPATCHING` 是外部动作前的最终线性化事务，必须再次核对持久eligibility snapshot；group取消先提交就禁止dispatch，DISPATCHING先提交就按在飞动作处理。
- 同一effect最多一个活跃attempt；旧attempt已到DISPATCHING后接管者只能对账，不能再建dispatch attempt。Effect合同从NULL封口必须有数据库CAS和不可变约束。
- effect group取消必须同时收口cancellation和业务state，不能留下 `CANCELLED + RUNNING` 的组合。
- 未dispatch共享effect的group-local取消只撤销该group的active demand，不阻塞其他共享者；只有adapter cancel/补偿会改变其他group仍依赖的物理事实时才进入policy conflict。
- 共享policy conflict只冻结请求取消/补偿的group节点，不能改变base effect事实或阻塞其他健康group。
- failure policy先于BEST_EFFORT归约；E1只对required failure触发group补偿，required补偿明确失败时group立即进入 `COMPENSATION_FAILED`。
- E1只复用已CONFIRMED且`post_confirmation_reuse=STABLE_FACT`、无补偿/撤销义务的effect；未完成或可撤销effect跨group共享属于E2，必须比较完整versioned execution contract和terminal consumer合同，不能只比较依赖图。
- Gateway只能消费由成功 `DISPATCHING` 事务激活的一次性authorization；预留permit、旧token或提交失败的authorization都不能执行写操作。
- Policy conflict先预留持久question attempt；proposal/owner创建成功后才进入 `QUESTION_PENDING`。问题outbox入库或发送unknown只能进入`DELIVERING/PUBLISH_UNCERTAIN`和`QUESTION_DELIVERING/QUESTION_DELIVERY_UNCERTAIN`，不能启动回答期限；只有delivery receipt确认用户可见、proposal和interaction同事务进入`PUBLISHED/WAITING_HUMAN`后才能宣称等待人工。发布前失败、问题超时/取消或回答后仍不能解冲突时，conflict、请求方node/group、barrier和operator alert必须一起进入明确终态。
- 已terminal且condition不匹配的required dependency必须在seal时拒绝；optional dependency必须按固定partial/skip规则收口，补偿/cleanup不能用required `SUCCEEDED`依赖已失败origin group。
- Effect取消只能写入current reconciliation attempt；有效lease的DISPATCHING owner先迁移到持久reconciliation phase，再由同一attempt owner串行执行receipt query和adapter cancel。旧 `DISPATCHING/RECONCILING` 接管必须先FENCE旧attempt再创建只读对账attempt。
- FENCED attempt的迟到receipt必须写回原物理attempt、递增effect级receipt evidence fence并唤醒当前reconciliation；不能丢弃，不能由旧attempt直接推进业务状态，也不能让旧ABSENT查询或人工裁决继续提交。
- Base effect的状态、receipt和external fact revision变化必须唤醒相关policy conflict；只监听group变化不合格。
- 补偿动作使用sealed dormant compensation membership，激活后仍走普通 `READY/LEASED/DISPATCHING/CONFIRMED` Gateway生命周期；原effect/group才使用补偿投影。E2补偿lineage和DAG边必须持久化、验无环并签入canonical digest，eligibility/reducer/recovery只能消费同一sealed snapshot。权威未发生origin的row结算为`NOT_APPLICABLE`，满足`TERMINAL`但不满足`CONFIRMED`边；不可能满足的边立即失败传播。Group进入 `COMPENSATED` 前，全部适用required补偿必须有权威成功、不适用row有权威origin fact，所有已dispatch optional补偿也必须终态；人工`TREAT_CONFIRMED`只能进入独立`COMPENSATION_ACCEPTED_UNVERIFIED`终态，不能伪造receipt。补偿receipt和有owner/deadline的adjudication变化必须唤醒origin group；无人裁决时安全进入`COMPENSATION_FAILED`。
- E1数据库/profile validator必须拒绝普通执行图的fan-in、fan-out、多分支、非CONFIRMED edge、多级补偿和其他E2-only condition，同时允许并正确激活独立sealed的dormant单层补偿；API、恢复、migration和operator路径不能绕过。
- Effect `TERMINAL` dependency必须使用封闭状态集合；reconciliation确认ABSENT后，允许重试的effect原子进入带due的 `RETRY_WAIT`，不允许出现无人负责的 `ABSENT -> READY`。
- Group取消在hard deadline后不能继续 `CANCEL_REQUESTED + UNCERTAIN`。若unknown effect仍被其他active sealed group需要，本group只能撤销自己的demand并按policy进入`PARTIAL/FAILED/COMPENSATING`，不得把共享effect置为DEAD；只有effect自身deadline到期或已经没有其他active demand时，effect reducer才能进入 `DEAD + adjudication`。没有待补偿已确认动作时group以真实终态收口；存在sealed补偿义务时必须进入补偿态，不能用PARTIAL截断补偿。
- 等价interaction proposal可以共享一次公开提问，但必须用多对多owner rows保留每个activation/node/relation/merge/policy conflict/adjudication；绑定前按最坏写放大预留结算行预算，进入DELIVERING后owner set永久seal，迟到/满额owner进入有`PROPOSAL_QUEUED`状态和hard deadline的下一generation。每代结算事务逐个收口固定owner snapshot，generation reducer按前代answer/terminal receipt继续，不能只唤醒第一个owner或突破事务上限。
- Dispatch authorization只能在 `READY -> LEASED` claim时为当前attempt短期创建；effect seal和dormant compensation注册不得提前占用会过期的reservation。
- `RETRY_WAIT` 收到更高revision的权威receipt evidence时由adapter reconciliation优先抢占，retry-due reducer不能把已确认动作再次推进READY。
- E1每个原effect最多一个单层补偿；E2允许同一origin通过不同branch key预注册多个补偿，数据库主键不能错误限制为一对一。
- Policy conflict创建人工问题前必须预留可恢复的question attempt receipt；确定性创建失败持久计数并有限重试，storage失败fail closed，不能因事务回滚永久吞掉失败预算。
- 普通effect group的 `UNCERTAIN` 只允许存在于group hard deadline前；到期后先结算本group的active demand并按sealed policy进入 `FAILED/PARTIAL/COMPENSATING/COMPENSATION_UNCERTAIN`。共享unknown effect只有在自身deadline到期或不再有其他active sealed demand时才进入 `DEAD + adjudication`，不能由一个group的deadline终止其他group的对账。
- Question attempt因projection revision变化而STALE时使用独立连续计数、退避和绝对截止；持续抖动必须RESOLVED或DEAD，不能通过不计failure budget永久重试。
- SQLite writer queue必须有CRITICAL保留槽、关键子类别公平配额、source/work限流、各类admission policy、成员/事务行数和持锁时间上限；不可重试ingress spool必须保存稳定event identity、digest、sequence、状态、lease、main receipt和连续checkpoint，主库提交后崩溃可幂等重放。超过上限时封口、分代、backpressure或fail closed，不能让BULK事务或单一异常receipt来源堵住人工回答、取消和deadline。
- 受管本地文件写使用有稳定logical edit identity、跨session operation receipt、私有staging、scope fence和journal的`workspace_write_session`批量结算；session创建时固定按最坏提交写放大推导的operation/目标文件/staged bytes/journal/private-base-snapshot字节上限，并同时CAS项目/全局artifact quota，admission超限时在创建私有目录和写staging前fail closed，不能到COMMITTING才制造超大事务。`COMMITTED/ROLLED_BACK` artifact由带lease/deadline/deletion receipt的reducer清理后才归还额度；`UNKNOWN`或仍需裁决的`DEAD`持续持锁、禁止自动清理并计入quota。COMMITTING期间重叠reader不能提交混合快照。外部或无法证明本地恢复的写入继续使用完整effect协议，二者不能由模型自行降级分类。
- freeze provisional gate必须把声明scope展开为规范scope keys，并在同一SQLite事务竞争唯一active owner；重叠非等价proposal只能排队，不能仅依赖应用层先查后写。
- coordination run、node和Agent activation的全部常驻非终态都有唯一reducer、hard deadline和补扫出口；丢失child/join callback不能使父节点永久停在`WAITING_CHILDREN/WAITING_CODEX/CANDIDATE_SUBMITTED`。
- 聚合内成员顺序使用activation/join/run/effect本地revision，不能为方便统一使用全局热点sequence；只有确需跨实体high-water的reconciliation log使用全局sequence。
- terminal事实保留紧凑tombstone；原始candidate/prompt/observation按versioned retention policy先归档、校验manifest和watermark后清理，活动/uncertain/未结算引用不得删除。

### 24.7 实施前阻塞验收

以下场景未通过前，相关 capability 只能保持 unavailable，不得进入生产灰度：

1. 同一 callback 被 event、scheduler 和 reconciliation 同时处理，只生成一个 trigger、occurrence 和 activation。
2. 周期 occurrence 1 未结束时不并发启动 occurrence 2；休眠恢复按 missed policy 合并且不重置预算。
3. 旧 attempt 迟到时不能提交新的 accepted outcome；同一 relation pair 并发确认只能有一个有效 revision。
4. 两个 `ONE_SUMMARY` group 并发争用同一 work 时，只有一个 ownership reservation 成功；失败 group 能释放 reservation。
5. 简单 `CODEX_EVENT` 由 deterministic handler 直接交付；completion、SLA、reconciliation 同时到达只产生一个 active review activation。
6. 重启后 relation、checkpoint、Integrator 和 capability activation 继续使用原 lineage budget。
7. 未认证、签名过期或重复的 external event 不创建 trigger/activation。
8. 同一 effect semantic key 或 graph operation 并发重放只创建一条事实；相同 operation ID 携带不同 digest 被拒绝。
9. 两个 FAST activation 并发请求不同安全 flags 时，只有一个 canonical run；升级 seal 必须包含当前 tier 的全部 accepted intent，旧 tier 写入不能污染重试。
10. 重叠 scope 的第二个人工问题持久进入队列，前一问题结算后由唯一 reevaluate trigger 唤醒；`FREEZE_SCOPE_UNCERTAIN` 到期后不会永久停住。
11. Work进入终态时不改变 terminal epoch；reopen才创建新 epoch，旧 attempt和旧 merge/delivery引用不能命中新世代。
12. Activation/Agent重试在原逻辑身份下创建新 attempt；旧 attempt迟到只能写 candidate/audit。
13. Freeze closure超限时 provisional gate继续阻止重叠写操作；缩小范围使用新 barrier identity，不能在原 barrier原地删成员。
14. 被放弃且从未创建 effect的 primary claim可以被新 candidate替换；uncertain/confirmed claim不能让出 slot。
15. Integrator/Evaluator超时按持久 policy退出；sealed snapshot和迟到成员均不能被原地改写。
16. Cursor已推进后补建更早 due的 terminal/outbox记录，仍在有界周期内被 overdue sweep发现并补发。
17. Relation confirm提交后响应丢失，使用同一 operation ID重放返回原 receipt，不覆盖 proposal operation。
18. RETRY_WAIT写入后进程重启，occurrence、activation retry schedule和effect仍按各自持久next retry时间领取，不热循环、不互相代替，也不永久等待。
19. 新 group在E1复用旧 group中已`CONFIRMED + STABLE_FACT`且无补偿/撤销义务的effect时，只新增membership、不会再次调用adapter；可补偿、可撤销或`CONSUMER_TRACKED`事实在admission前拒绝，两个已接受该稳定事实的group不会被后来静默改写。
20. Group A中 `X -> Y`，Group B复用未 dispatch的 `Y`：B只有导入相同 `X -> Y` 闭包和复用策略才能 seal；A取消后B仍可依赖自己的闭包推进，且外部 adapter只收到一次Y。B使用不同前提时原子返回 `EFFECT_MEMBERSHIP_POLICY_CONFLICT`，不能提前 dispatch或复制Y。
21. Scheduler cursor已经扫过未来 occurrence 后又新增更早到期的 `SCHEDULED` occurrence，due索引和有界回绕/overdue sweep仍能在SLA内领取它。
22. Effect group原动作失败后全部 required补偿成功，group进入 `COMPENSATED`，依赖 `COMPENSATED` 的后继可推进，但原work不会被归约成 `TERMINAL_VERIFIED` 成功。
23. Group C已持有未dispatch的effect X；Group A试图在新增required group依赖后复用X时因dispatch摘要不同被拒绝，不能让A的依赖反向卡住C，也不能绕过A的顺序提前执行X。
24. Required effect Y依赖X时，X不能标记为optional；非法图在seal时被拒绝。运行中依赖条件变成不可能后，Y被确定性取消并使group按policy退出，不永久停在BLOCKED。
25. 共享effect因其他group仍需要而不能补偿时创建唯一policy conflict；其他group取消后确定性重评自动恢复，持续到`question_eligible_at`才允许发布一次人工问题。整个freeze、发布、回答和结算仍受更晚但绝对的hard deadline约束。
26. Effect在依赖满足后由reducer从BLOCKED推进READY；READY后某个member group并发取消时，worker领取前重验失败，不调用adapter，并按剩余active demand回到BLOCKED或CANCELLED。
27. Group A与B并发声明相互依赖时，E1因目标尚未seal而拒绝；E2原子DAG校验拒绝整批，数据库中不能留下两边各提交一半的等待环。
28. Effect完成READY领取后、写DISPATCHING前全部member group取消，attempt完整eligibility CAS失败且adapter零调用；若DISPATCHING先提交，取消方明确进入in-flight/uncertain流程。
29. Required B以TERMINAL依赖required A的图在seal时被拒绝；A失败不能先把B放行为READY，再由FAIL_FAST追赶取消。
30. 两个OPEN group用相同动作集合但不同edge/required/group dependency时得到不同sealed canonical contract；同一未sealed effect的不同dispatch digest并发CAS只有一个成功。
31. Group取消且没有dispatch事实时原子进入 `cancellation_state=CANCELLED,state=CANCELLED`；部分发生或结果不明时分别进入PARTIAL或UNCERTAIN，不保留RUNNING。
32. Group A取消尚未dispatch的共享X、Group B仍active时，A退出active demand且B继续dispatch X，不创建policy conflict；X已在飞且A要求adapter cancel时才按共享冲突处理。
33. BEST_EFFORT group的required节点失败时仍优先触发FAIL_FAST/COMPENSATE；optional失败按sealed trigger policy处理。Required补偿无retry地明确失败后group立即终态，不等deadline。
34. 两个seal事务给同一无合同effect写入不同digest时，数据库 `NULL -> digest` CAS和immutable trigger只允许一个成功；失败事务不留下OPEN canonical key或可领取attempt。
35. 旧effect attempt已DISPATCHING后lease失效，新owner只能创建RECONCILING路径，partial unique index阻止第二个active dispatch attempt。
36. Group A补偿已确认共享X与Group B保留X冲突时，只有A的node进入CONFLICT_REVIEW；X仍CONFIRMED，B的后继继续归约。
37. 同一topic先后创建两个INDEPENDENT work时，各自惰性创建 `OBJECTIVE_PRIMARY` thread；旧 `TOPIC_PRIMARY` 名称不能把第二个work接入第一个thread。
38. 新occurrence遇到sealed active slot时进入SLOT_WAIT且不被scheduler按retry轮询；blocker终态只写lane release fact，slot reducer分批唤醒，blocker卡死则在slot deadline后有界失败。
39. E1命中其他group尚未终态的effect identity时原子返回 `EFFECT_NONTERMINAL_REUSE_UNAVAILABLE`，不复制动作；E2未通过第20、23、26-30、32项前保持feature unavailable。
40. Worker取得reservation后并发取消导致DISPATCHING CAS失败，authorization保持不可执行且Gateway零写入；DISPATCHING成功后Gateway只能原子消费一次，消费后崩溃进入uncertain对账而不重发。
41. Policy conflict到达`question_eligible_at`时先持久预留question attempt，再原子创建proposal/owner并进入 `QUESTION_PENDING`；attempt、publish和answer期限都不得超过conflict绝对hard deadline。outbox入库或发送unknown保持`DELIVERING/PUBLISH_UNCERTAIN`且回答期限为空，只有confirmed delivery的publish事务才进入 `WAITING_HUMAN`。剩余时间不足、创建/发布持续失败、interaction超时/取消或回答无解后，conflict进入 `DEAD`，请求方node/group、barrier收口并只产生一个operator alert。
42. Seal时required dependency目标已经terminal但condition不匹配，整个group原子返回 `EFFECT_DEPENDENCY_CONDITION_CONFLICT`；optional目标不匹配时不dispatch并确定性进入partial/skip终态。
43. 已失败origin group的补偿/cleanup proposal使用required `SUCCEEDED` dependency时在seal被拒绝；改用非required `TERMINAL/COMPENSATED` 后按声明顺序执行。
44. Cancellation与receipt reconciliation并发到达时，只有current attempt owner按持久phase串行query和cancel；cancellation reducer、旧owner和新owner不会并发调用adapter。
45. 旧 `DISPATCHING/RECONCILING` lease过期后，接管事务先将旧attempt置为 `FENCED`再插入唯一新 `RECONCILING` attempt；新attempt没有dispatch authorization，partial unique index不冲突且adapter dispatch计数不增加。
46. FENCED旧attempt收到迟到receipt时，receipt写回原adapter request审计并创建唯一reconciliation trigger；旧attempt不能直接完成effect，当前attempt能据此收口。
47. Base effect迁移为 `CONFIRMED/ABSENT/FAILED/CANCELLED/DEAD/COMPENSATED/COMPENSATION_ACCEPTED_UNVERIFIED/COMPENSATION_FAILED` 或external fact revision变化时，所有受影响active policy conflict只被唤醒一次；projection未变化时不热循环。
48. Group处于 `COMPENSATION_UNCERTAIN` 后收到required补偿迟到成功receipt，且所有已dispatch optional补偿已终态时可恢复到 `COMPENSATED`；仍有optional attempt在飞时不得提前终态，required补偿无retry失败时立即 `COMPENSATION_FAILED`。
49. E1普通执行proposal包含fan-in、fan-out、两个独立分支、非 `CONFIRMED` effect edge、跨group未完成effect复用或二级补偿时，所有入口都返回 `EFFECT_PROFILE_CAPABILITY_UNAVAILABLE`，数据库不留下半个group/effect。
50. E1线性组 `A -> B` 中B失败、A已CONFIRMED时，seal时预注册的dormant补偿C按逆序激活；C取得普通Gateway authorization并只dispatch一次。C不形成普通fan-out，也不能在group进入COMPENSATING前领取。
51. 旧reconciliation的ABSENT query在途时先收到FENCED dispatch attempt的权威CONFIRMED receipt，receipt evidence/effect revision使ABSENT settlement、人工裁决和重试资格CAS全部失败；不会产生第二次dispatch。
52. Policy conflict创建proposal后、公开问题前freeze失败或proposal过期，conflict从QUESTION_PENDING进入DEAD，请求方node/group收口且只告警一次；不会留下假的WAITING_HUMAN。
53. 有效lease的DISPATCHING attempt收到取消时，原owner先持久迁移为RECONCILING/QUERY_REQUIRED；query unknown后分两次CAS进入CANCEL_REQUIRED/CANCEL_IN_FLIGHT，任一崩溃点恢复都不并发调用adapter。
54. Effect dependency使用TERMINAL时，seal validator和运行时对 `CONFIRMED/ABSENT/FAILED/CANCELLED/COMPENSATED/COMPENSATION_ACCEPTED_UNVERIFIED/COMPENSATION_FAILED/DEAD` 得到相同结果，并一致排除uncertain和retry状态；精确`COMPENSATED`条件不匹配人工未验证终态。
55. Reconciliation确认原请求ABSENT且允许重试时，同事务记录fact并进入带非NULL due的RETRY_WAIT；retry reducer到期才推进READY，新attempt开始时更新fact revision，不存在ABSENT无人认领。
56. Group取消到hard deadline仍有unknown effect时，先检查其他active sealed demand：仍被其他group需要则只撤销本group demand并进入PARTIAL/FAILED/COMPENSATING，base effect继续对账；无其他demand或effect自身deadline到期才把effect置为DEAD并创建唯一adjudication。存在sealed补偿义务时进入COMPENSATING/COMPENSATION_UNCERTAIN，均告警且不回到普通UNCERTAIN。
57. 两个policy conflict复用同一个等价人工问题时各自写独立proposal owner；回答、超时和发布失败都会在一个settlement事务中收口两个conflict，不遗留第二个QUESTION_PENDING。
58. Dormant补偿在group seal时没有dispatch authorization；数天后激活并通过READY claim时才创建新RESERVED authorization，能够正常进入DISPATCHING且旧过期资格不可续期复用。
59. Effect已在RETRY_WAIT时收到迟到CONFIRMED receipt，adapter reconciliation以receipt-evidence revision取消retry due并进入CONFIRMED；retry scheduler并发领取CAS失败，adapter总dispatch次数仍为一次。
60. E2同一origin预注册两个不同branch key的补偿时，数据库保存lineage和dependency edges，seal digest签入全部边并完成端点/闭包/无环校验；eligibility、reducer和recovery按同一sealed DAG归约。E1提交相同结构时profile validator拒绝且不留下半个补偿row。
61. Policy conflict预留question attempt后在proposal创建前OOM/崩溃，lease-expiry reducer按同一operation ID结算WORKER_LOST并递增一次failure count；重复崩溃最终进入DEAD。确定性validator连续失败同样有界，SQLite不可写时系统fail closed且恢复后先结算过期attempt。
62. 普通group在hard deadline仍有required unknown effect时，group按FAIL_FAST进入FAILED或按补偿策略进入补偿态；不得以UNCERTAIN作为hard deadline后的自循环出口。若effect仍被Group B合法需要则保持base state并继续B的对账；只有effect自身deadline到期或无其他active demand时才进入DEAD和唯一adjudication。
63. 等价proposal进入DELIVERING后新增owner不能修改已seal generation；它进入下一generation和`PROPOSAL_QUEUED`。前代ANSWERED时按answer revision机械重评，前代EXPIRED/FAILED时按后代hard deadline接替或DEAD，不停在QUESTION_PENDING。
64. Base effect持续变化使question attempt连续STALE时，stale count不会因新attempt重置；conflict消失则RESOLVED，达到stale上限或绝对截止则DEAD并只告警一次。
65. 同一稳定activation lane已有RUNNING模型调用时，新input projection只能进入SLOT_WAIT；不能用新digest创建第二个active activation。
66. primary occurrence在首次attempt前被取消时，OPEN activation同事务提升最早active member；在RUNNING/RETRY_WAIT的SEALED activation中任一成员被取消时，旧attempt被fence、activation变STALE、retry schedule取消、旧occurrence全部终态结算，仍成立条件通过新的幂等REEVALUATE occurrence继续；旧membership不换绑且两条路径均不遗留无owner状态。
67. OPEN join的父Agent在seal前崩溃，HCO collection reducer按deadline/parent/budget/max-members policy进入SEALED、FAILED或CANCELLED，不永久COLLECTING。
68. NEXT_GENERATION携带迟到结果时，以`CARRY_FORWARD_LATE`复用原node且不创建新Agent activation；重新执行时以`RERUN`创建新node和delegation generation。两者都保留source identity，数据库允许跨代历史、拒绝同一node同时加入两个OPEN generation。
69. writer queue达到90%且已有BULK或异常receipt积压时，按关键子类别保留和source/work公平限制，仍能在SLO内提交人工回答、取消和deadline；超长BULK事务因行数/持锁上限在入队前被封口或拒绝。
70. activation第129个member、join/effect group第65个member或lane waiter超过条目/字节上限时不会扩大当前原子事务；按policy进入下一activation/generation、有界release批次或fail closed。
71. 单Agent只读checkpoint使用DURABLE_TRIGGER_ONLY，重启后能恢复提醒，但不创建coordination graph、Planner或Evaluator调用。
72. 同一logical edit key的多个文件/格式化调用只创建或恢复一个workspace write session；相同operation ID跨session重放返回原operation receipt，不重复append/rename。Git push/Zulip/云API仍各自走完整外部effect协议。
73. workspace journal提交前后各注入崩溃，recovery能确定commit/rollback或标记unknown；UNKNOWN和仍需裁决的DEAD保持scope lock，不能误报成功、允许重叠写或把本地session升级成重复外部动作。
74. 归档任务不能清理active lease、uncertain effect、未回答interaction或delivery claim引用；manifest/checksum失败时watermark不推进、SQLite原始行保留。
75. 性能验收固定硬件、数据库规模、并发和事件混合，分别报告HCO入队到提交、provider和Zulip端到端延迟；不能用排除项掩盖用户实际等待。
76. 两个不同root lineage的occurrence命中同一active lane时不能直接共享预算；已有activation固定budget lineage和reservation，另一个occurrence进入SLOT_WAIT，primary取消和attempt重试均不改变扣费归属。
77. 一个RUNNING activation积累300个SLOT_WAIT waiter后仍可在事务行数上限内提交终态；release reducer按固定批次、公平lineage顺序处理，最多创建一个下一active activation，不产生writer长事务或唤醒风暴。
78. child/join终态callback丢失后，graph/node补扫按revision唤醒父node；`WAITING_CHILDREN/WAITING_CODEX/CANDIDATE_SUBMITTED/CANCEL_REQUESTED/BACKPRESSURE/CONFLICT_REVIEW`均在hard deadline前由唯一reducer收口。
79. workspace session发布A、B两个文件时，在A已发布而B未发布的故障点启动重叠reader；reader只能等待、读取不可变base snapshot或stash，不能以旧workspace revision提交混合结果。
80. workspace session部分发布后进入UNKNOWN，新的重叠writer无法取得scope lock；只有recovery或带revision的operator adjudication确认rollback/commit后才能释放或转移锁。
81. 两个非等价ROUTE_MUTATING proposal并发声明重叠scope时，规范scope-key owner唯一约束只允许一个进入FREEZING，另一个原子进入QUEUED；不同freeze_id不能绕过重叠检测。
82. activation、join、upgrade和effect在高并发下只更新各自父实体的local sequence/revision；不会争用同一个全局hot row，reconciliation high-water仍保持全局单调。
83. A1、A2、B、C1、C2能力可以分别关闭和故障注入；未启用的calendar/webhook/write/effect/join枚举不会被模型看到，也不会成为更早阶段的migration或reducer必选分支。
84. A1关闭A2时，CODEX_EVENT、WORK_STATE和OPERATOR_RECOVERY同时命中复杂结果仍由最小stable lane只启动一次Jarvis review；A2只增加跨时间due恢复和多lineage waiter公平drain。
85. 每个实际provider attempt都单独结算call/token；旧attempt在T2前崩溃、FENCED后重试时，旧调用仍记账且新attempt必须先扩充原reservation，预算不足不再调用。
86. lane已有waiter时blocker终态原子进入DRAINING；release reducer运行前的新T1不能插队。取消、deadline和overflow按每条waiter保存的accounted bytes精确减回，崩溃后公平cursor/deficit继续有效。
87. CRITICAL首次ingress被异常adapter压满时，可重试来源收到backpressure，不可重试来源写有界durable spool；spool满或fsync失败进入STORAGE_UNHEALTHY并停止新副作用，人工回答和取消保留独立入口容量。
88. 同一topic relation decision涉及多个work epoch时，所有入口都使用`topic_context_id + relation_lane_generation`的同一active lane；work epoch只进入input snapshot，不能制造第二次模型调用。
89. required补偿在hard deadline后人工`TREAT_CONFIRMED`进入`COMPENSATION_ACCEPTED_UNVERIFIED`，`TREAT_ABSENT/STOP_AUTOMATION`进入`COMPENSATION_FAILED`；两者都离开`COMPENSATION_UNCERTAIN`，且前者不冒充权威receipt。
90. Group A和B共享unknown effect X时，A的group deadline只结算A并撤销A demand，B继续对账X；X自身deadline到期或最后一个active demand退出后才允许把X置为DEAD。
91. workspace session并发追加operation通过`session_revision + next_operation_sequence`分配唯一局部序号；相同operation ID跨session重放只读取全局receipt，不重复追加或推进cursor。
92. A1-D在没有E高级冷归档时仍有可运行的基础retention执行者；manifest/checksum失败或存在active/uncertain引用时不清理原始行，SQLite不会因“等E再做”而无界增长。
93. Policy conflict的`question_eligible_at`和绝对hard deadline分开保存；系统不会刚到绝对截止才开始freeze/提问，也不会通过重试、共享proposal或晚到delivery receipt把回答期限延到hard deadline之后。
94. proposal发送中最后一个active owner因projection变化而结算后，confirmed delivery不会再进入WAITING_HUMAN；proposal/interaction转为STALE/CANCELLED，barrier恢复，已送达消息通过唯一edit effect禁用按钮并标记失效。
95. 同一effect/group/kind conflict被两个node同时请求时，只创建一个conflict/问题，但保存两个requester rows；回答、自动解冲突、超时和发布失败都逐node CAS结算，不能丢掉第二个node。
96. waiter绑定新blocker后仍保持索引可见的WAITING/SLOT_WAIT，不存在漏扫的REBLOCKED状态；weighted-deficit使用固定默认weight、quantum和每waiter成本，重启前后得到相同公平顺序。
97. workspace session第65个operation、目标文件/私有staging/journal/private-base-snapshot字节、项目/全局artifact quota或最坏事务行预算超限时，在创建私有目录或共享workspace发布前返回`WORKSPACE_SESSION_CAPACITY_EXCEEDED`；不得扩大COMMITTING事务或静默拆分失去原子性。
98. 不可重试receipt在spool fsync后、主库提交前崩溃会正常重放；主库提交后、spool APPLIED前崩溃只返回原main receipt。digest冲突、checksum失败和非连续checkpoint不会被跳过。
99. provider usage迟到时按attempt固定的usage deadline/policy只估算一次并释放余额；不同worker不能选择不同截止。lane公平算法的weight/quantum/cost也由versioned policy固定。
100. 持续高负载触发WAL/磁盘maintenance high-water时，系统暂停新BULK/非必要CONTROL并用小批storage-maintenance保留槽做checkpoint/归档；它不挤占receipt、人答、取消/deadline，达到磁盘危险线时停止新副作用而不是永远停掉维护。
101. run/node进入WAITING_HUMAN/WAITING_INPUT时绑定active proposal owner、interaction revision和effective deadline；截止后不能继续写回WAITING。WAITING_AGENT、WAITING_JARVIS、WAITING_APPROVER_CONFIGURATION和ORPHANED_REQUIRES_RECOVERY也都有唯一owner、绝对deadline和终态出口。
102. 合并notification的每个内部/外部component都有非NULL稳定source event identity和component business key；同一业务component重放只结算一次，不会被SQLite允许多个NULL的唯一约束绕过。
103. 高风险relation的问题发布失败、回答回执丢失或Boss不答时，relation reducer在deadline安全REJECT/CANCEL并释放pending replacement槽；两个work退出`WAITING_INPUT(reason=RELATION_CONFIRMATION)`，已有current保持不变且失效current由validity reducer释放，不会永久阻塞后续任务。
104. `ONE_SUMMARY`在seal时已创建group claim；成员未全部terminal就到hard deadline，或全部terminal后丢失callback且coordinator崩溃，overdue sweep仍接管同一claim并交付一次partial/failure/summary。merge admission达到成员/行预算时在reservation前fail closed。
105. `STASH_REVIEW`进入FAILED/DEAD/CANCELLED时freeze gate不释放；resume deadline进入`SAFE_FAILED + UNCERTAIN_HOLD`，只有accepted review receipt或带revision且满足安全谓词的adjudication可以释放。
106. required compensation adjudication无人处理时，decision deadline把adjudication置EXPIRED并将origin/group结算为`COMPENSATION_FAILED`；与权威receipt并发时只有一方CAS成功。
107. E2补偿图中A未发生、B已发生且CB以`TERMINAL`依赖CA时，CA结算`NOT_APPLICABLE`后CB可执行；若边要求`CONFIRMED`则立即失败传播，不在DORMANT/BLOCKED卡到deadline。
108. 等价proposal第33个owner、进入DELIVERING后的owner或超出settlement行预算的owner进入下一generation和`PROPOSAL_QUEUED`；前代answer在projection一致时机械结算后代。conflict requester满额时新node进入有deadline的BACKPRESSURE，任何回答/超时事务都不超过256行。
109. B依赖A的固定terminal epoch时，A execution/delivery revision变化会创建唯一work-wait reducer trigger；即使callback丢失，due sweep也按condition将wait置SATISFIED/REJECTED/EXPIRED并让B退出WAITING_INPUT。A reopen后的新epoch不能误满足旧wait。
110. `agent.reactivate`事务提交后回执丢失，Jarvis原operation重放只返回同一个新activation/target node；Jarvis新请求与reconciliation并发时，node/run revision CAS和partial unique index只允许一个非终态activation及一个运行attempt。source node尚未终态且source activation已终态时可CONTINUE；terminal node只有在active run内才能创建已挂接的`CORRECTION_NODE_ACTIVE_RUN`，terminal run必须reopen新epoch，不能改写旧node/join/effect。
111. Group B复用X并成功交付后，Group A试图补偿X：E1因为X不是`STABLE_FACT`在B admission前就拒绝复用，不会留下“B仍成功但X已被补偿”的状态；E2只有实现terminal consumer retention、原子release/失效传播和唯一更正通知并通过故障注入后才可放行。
112. B以`EXECUTION_SUCCEEDED`依赖A时，A以`TERMINAL_VERIFIED + execution_outcome=FAILED`终止不会启动B；wait立即按预注册failure policy结算。只有同一epoch的`TERMINAL_VERIFIED + SUCCEEDED`满足条件，delivery成功、展示`COMPLETED`或单独的`TERMINAL_VERIFIED`都不能伪造成功。
113. 同话题反向dependency达到active-work/终态事务预算上限时，新relation在创建wait前明确失败且不留半成品；A终态写fact、tombstone和全部wait trigger仍保持有界，不能因下游过多而无法完成。
114. `TERMINAL_UNVERIFIED`的outcome被权威证据修正时，未dispatch旧effect被原子撤销并替换；已越过边界的primary不重发，更正supplement按predecessor/subject sequence在旧claim终态后只投递一次。callback丢失、HCO重启、sidecar乱序和迟到普通candidate均不会导致陈旧primary晚于更正或重复宣告完成。
115. Jarvis在Codex完成后失联不会阻止HCO先形成execution terminal/outcome/tombstone；确定性通道仍能续报。只有执行前sealed且有deadline的Integrator/Evaluator可以成为completion contract的一部分。
116. relation模型在生成relation前失败时，持久decision request仍由deadline reducer按风险收口；HIGH risk不会放行写操作或永久伪装运行。一个relation activation合并多条消息时，每条request都有独立decision/settlement，不能被单个候选吞掉；单个request可以用有上限的relation set原子表达“同时依赖A和B”，或提出一个完整merge group，任一边失败不能半提交。
117. 目标work已经terminal后才建立dependency时，admission同事务立即满足或拒绝wait；`ALL_SUCCESS` merge只接受verified success，unverified到deadline按sealed policy退出，后续修订只发唯一group correction supplement。
118. Relation问题发出后目标work reopen或scope变化，旧回答在confirm和实际应用前的revision重验中被判STALE，不能取消、修改或依赖新epoch。每个work/epoch加入merge group的生命周期次数受默认16及事务预算上限约束，事实变化不会因反向group过多而无法提交。
119. Agent reactivation事务提交后在worker入队前崩溃，重启从持久`CREATED` activation和唯一start trigger恢复同一执行；`CARRY_FORWARD_LATE`创建下一generation后即使没有新事件，也由持久join reducer due收口，不留下幽灵activation或孤岛snapshot。
120. B当前依赖A epoch 1且relation已CONFIRMED时，针对A epoch 2创建的替换proposal可以与旧current共存；问题发布失败、Boss拒绝或超时只结算pending，旧current不被提前撤销。
121. Relation replacement确认与target reopen并发时，pair/relation revision CAS只允许“原子切换完整新set”或“旧epoch current和pending一起按validity规则失效”；不会永久占住pair slot，也不会留下半套dependency wait。
122. Active run中的terminal node创建correction时，同一事务写required correction node、父边或下一join generation membership、run completion/node-set revision、预算和start trigger；并发run终态CAS必须失败并重算，correction不会成为孤岛。
123. Run或work已经terminal时，`CORRECTION_NODE_ACTIVE_RUN`明确拒绝；只有显式reopen递增terminal epoch并创建新run后才能继续执行，旧run/node/effect/tombstone不回到非终态。
124. Source Agent activation仍在`CREATED/RUNNING/WAITING_CODEX/WAITING_CHILDREN`时，普通reactivation返回同一`ALREADY_ACTIVE` receipt或等待独立接管，不创建新activation、不fence在飞attempt。
125. `ONE_SUMMARY` reservation与成员个人claim的effect创建并发时，subject revision/claim CAS只允许一方越过边界；reservation成功后旧`AVAILABLE/LEASED` claimant不能创建effect，个人effect先创建则group reservation失败或降级为`SUMMARY_AND_INDIVIDUAL`。
126. Relation set在公开问题前已经按旧/new relation、wait、owner和projection最坏写放大预留事务行数；超过cap时整set admission失败。单pair只有一条relation来源active wait，替换不批量改写其他pair下游，confirm不会确定性撞上事务上限后永久重试。
127. Relation replacement confirm在writer queue内重验后，旧current、旧wait、pending和新wait的每个条件写都断言精确影响行数；validity reducer并发先提交时confirm整笔回滚重读，不会生成指向失效snapshot的孤儿CURRENT。
128. 成员个人claim从`LEASED -> EFFECT_CREATED`时，subject/current claim/ownership条件检查、唯一effect插入和claim更新是同一事务；ONE_SUMMARY reservation并发先提交后，旧claimant的条件写为0并回滚，不能在“重验后”偷插个人effect。
129. 长寿命topic的relation lineage预算耗尽后，两个新relation request并发到达只创建一个PENDING rollover和两条有界membership；旧lane quiescent后settle旧grants并从topic/provider/global父account原子预留新tranche，只创建一个新generation/root/lineage，父级累计预算和rollover频率不归零。
130. Relation rollover等待旧RUNNING activation、SLOT_WAIT或300个request时带not-before/hard deadline；核心终态事务只写release fact，request按固定batch receipt唤醒/结算。callback丢失由due/reconciliation接管；到期仍不能换代时LOW-risk默认独立，HIGH-risk走固定人工选项或可见失败并保持mutating gate，不留下半换代topic或超大事务。
131. ONCE trigger的SEALED activation在普通T2 CAS stale后，旧trigger/occurrence保持terminal；同一事务以source activation/member和最新projection写唯一reevaluation receipt、新trigger和occurrence 1。receipt提交后进程崩溃，重放仍返回同一个新trigger而不re-arm旧trigger。
132. callback与reconciliation并发结算同一stale candidate时只产生一个REEVALUATE trigger；相同source identity不同payload整笔拒绝。新activation再次stale可形成下一代source identity，但继承原lineage预算和hard deadline，不能无限重评。
133. Relation rollover的新lineage必须同时取得topic、provider和global三条budget grant；任一父account CAS失败整笔回滚。临时FROZEN account与ACTIVE lineage grant都有唯一reducer和deadline，已越过provider边界的usage不返还，root终态后未用grant不永久占额。
134. 连续完成workspace session不会无界积累私有staging/journal：按retention policy先归档或把安全artifact置为`CLEANUP_DUE`，cleanup在文件删除后、receipt前崩溃可补写同一deletion receipt且只归还一次项目/全局额度；`UNKNOWN/UNCERTAIN_HOLD`禁止删除并持续占quota，单项目share cap和全局hard cap在创建新session目录前分别fail closed。
135. retention policy要求保留的workspace artifact先归档并验证manifest/checksum；归档失败或cleanup失败时不删除、不归还额度，成功归档后才进入`CLEANUP_DUE`，重复执行只返回原manifest/deletion receipt。
136. cleanup因存储故障进入`CLEANUP_FAILED_HOLD`后，新的HEALTHY storage-health revision或recovery due会有界重试同一artifact并在成功后自动归还额度；同一health revision只触发一次，且绝不把`UNKNOWN/UNCERTAIN_HOLD`当成可删临时文件。
137. 存储健康使用持久单例和单调revision；主库恢复可写后必须先进入`RECOVERY_REQUIRED`并完成integrity/WAL/spool/lease/artifact对账，再提交唯一`HEALTHY` revision。进程内探针或两个恢复owner不能提前开放副作用、重复唤醒cleanup。
138. 10,000个并发attempt消耗已授予tranche时，provider/global父账户不随每次call/token callback更新；热路径只写lineage/reservation/attempt和分片capacity lease。父账户写次数只随首次grant、tranche续期、到期回收或换代增长，且所有shard/window hard cap之和不超过policy总上限。
139. grant到期、usage callback丢失或worker在provider边界后崩溃时，系统按attempt固定policy估算/结算，不能把不确定余额返还后再次授予；usage rollup延迟或损坏不得放宽admission。
140. 任一可选capability处于`UNAVAILABLE/SUSPENDED`时，不出现在模型工具列表、capability envelope或新任务热路径；`UNAVAILABLE`不运行业务due，`SUSPENDED`只运行已有事实的deadline/reconciliation/drain due。receipt、人工回答、取消/deadline、delivery reconciliation和storage health仍可运行。
141. 跨模块操作只有预注册transaction recipe可以在一个事务内同时修改多个模块；recipe中途崩溃或相同operation重放只得到一个receipt和全有/全无的状态，不允许relation/freeze/effect出现半提交。
142. capability没有有效qualification `PASS`、证据已`EXPIRED`或contract/schema/policy digest变化时，不能进入`CANARY`；shadow/replay不会调用真实模型或执行任何外部副作用。`ACTIVE`还必须通过真实scoped CANARY、连续GOOD窗口、模型调用/prompt阈值和故障矩阵promotion门禁。
143. SLO连续窗口超标时软件自动停止扩大灰度并关闭BULK、fan-out和非必要模型复核，同时关键事实、人工回答、取消/deadline和副作用对账继续服务；该熔断和恢复过程模型调用数为0。
144. 预算批量结算、storage health恢复、workspace cleanup恢复和SLO熔断分别在0次模型调用下完成；简单FAST_PATH版本/状态查询的模型调用数与未启用V2机制时相同。
145. 模型只收到当前任务所需且默认不超过4 KiB的capability envelope；完整状态机、未启用模块和无关工具不会进入prompt。模型尝试自行重试、计算预算、宣布恢复或直接推进业务状态时被schema/Gateway拒绝。
146. provider请求开始后worker崩溃、capacity lease到期时，slot先进入RECONCILING而不是立即复用；只有provider终态、确认取消、可验证permit回收或provider合同保证的最大执行时限证据才允许释放。仅transport关闭、本地超时或UNKNOWN全额计费时保持`HELD_UNCERTAIN`并熔断/告警。
147. 同一SLO window指标重复上报、迟到或operator与自动breaker并发时，只形成一个sealed verdict和一个registry revision迁移；恢复必须满足连续健康窗口，单次成功不能直接恢复ACTIVE。
148. EFFECT/FREEZE等模块在已有非终态事实时进入`SUSPENDED + DRAIN_ONLY`，已注册DRAIN recipe仍能按旧contract原子结算，但不能创建新activation、effect、authorization、扩大scope或延长deadline；ADMISSION recipe必须拒绝。
149. required metrics缺失会产生INCOMPLETE窗口并立即停止扩大灰度；连续INCOMPLETE达到policy上限后进入THROTTLED或SUSPENDED，且INCOMPLETE不能计入恢复所需的连续GOOD窗口。
150. FAST_PATH只读取CORE和当前任务必需的capability snapshot，不扫描未启用模块表、不启动可选worker、不增加额外事务或模型调用；registry revision变化时确定性backpressure/re-evaluate，模型不能代替资格判断。
151. participant模块升级会创建新的不可变recipe version；旧跨模块事实继续引用旧version并只走DRAIN，直到引用计数为0且reconciliation/归档证明无漏项。新version不能解释旧事实，旧version不能接受新ADMISSION。
152. qualification runner领取任务后持久化lease/fence、attempt和run hard deadline；同一capability/profile/all-digest最多一个QUEUED/RUNNING run和一个current head。runner崩溃或lease到期由唯一reducer收口为EXPIRED/FAIL并写receipt；创建R2原子推进head revision，R1迟到PASS不能再晋级。
153. `HELD_UNCERTAIN` capacity slot进入带owner、decision/hard deadline和operation receipt的adjudication；无provider证据时只能RETAIN_HOLD或DISABLE_SHARD，不能自动AVAILABLE。分片恢复有lease、cursor和有界batch receipt；中途崩溃可接管，operator不能替代provider证据释放slot，模型调用数为0。
154. provider/global预算账户的canonical key同时包含scope、window和shard；grant复合外键和封存policy revision使用同一四元组，非窗口预算固定`LIFETIME/0`。相同grant operation/digest只提交一次，不同金额或policy重放拒绝；新窗口或换ID不能绕过旧grant和总额度。
155. R1已PASS但rollout延迟时创建R2；head切换事务提交后，R1即使仍在有效期且持有旧registry revision也不能更新CANARY/ACTIVE，只有R2 current head能参与后续门禁。
156. synthetic/replay/shadow PASS后只能进入受限CANARY；缺少真实Hermes/App Server/provider/sidecar/Zulip及适用Gateway的故障注入manifest、连续GOOD窗口或模型调用/prompt阈值任一项时，promotion确定性拒绝且不会扩大scope。
157. CANARY promotion提交后receipt丢失，使用相同operation/digest重放只返回原ACTIVE registry revision；同ID替换scope、窗口或evidence digest时拒绝。CANARY期间出现BAD/INCOMPLETE或scope revision变化时不能晋级。
158. R1 ACTIVE且远期TTL revalidation已排队时R2 current head FAIL：R2终态事务先SUSPEND并递增registry revision，再把同一mailbox升级为紧急event；旧operation不能占槽或覆盖，新admission立即拒绝。TTL到期即使mailbox worker延迟，FAST admission也不能越过已知valid-until。
159. grant事务扣减父额度后回执前崩溃，相同operation/digest只返回原grant；同ID改金额、账户或policy返回冲突，不会再扣一次或形成无回执额度。
160. DRAIN只能推进已预创建、已封存授权合同的补偿；SUSPENDED后才发现需要新补偿effect时进入有owner/deadline裁决或`COMPENSATION_FAILED`，不会借DRAIN创建新authorization。
161. capability发生SAFETY/digest撤销时，未越界旧activation被fence，已越界attempt只按旧contract对账且不重试；仅TTL到期的在飞只读FAST任务最多完成原attempt并通过T2重验，新PASS不会复活旧attempt。
162. writer queue被BULK压到90%时，provider capacity lease/reconciliation仍使用CONTROL恢复配额推进；qualification新run可以暂停，但已有RUNNING run和revalidation仍在独立CONTROL配额内按deadline终态，不会永久占active unique。
163. provider终态callback、健康revision或permit回收证据在分片DISABLED后到达时，scheduler自动创建/复用BEGIN_RECOVERY并接管分批扫描；没有证据时保持DISABLED而不是按时间猜测AVAILABLE。
164. CANARY manifest的run/head、组件版本/deployment digest或window-set任一不匹配当前promotion时，registry保持CANARY并写REJECTED_EVIDENCE；manifest过期不能原地延寿后继续晋级。
165. Streaming provider 的每 token/小 chunk callback 不直接写 `lineage_budget_ledger`；10,000 个并发 attempt 在已取得 tranche 内只按 attempt-local 聚合和有界批量 flush 更新 usage。flush 崩溃、重放、迟到 callback 和估算 settlement 都按 attempt/batch identity 只结算一次，不返还不确定余额或放宽 admission。
166. 写事务在 `BEGIN IMMEDIATE` 前完成所有外部读取和写集预算；持锁期间没有模型、网络、provider、Zulip、文件或对象存储 I/O。`SQLITE_BUSY*` 会 rollback、丢弃旧 snapshot、有限退避重试，超过 hard deadline 按 CRITICAL/CONTROL/BULK 策略降级，不会无限占用 writer。
167. writer queue 达到70%/90%、事务超过行数或持锁上限时，BULK fan-out 和非必要 CONTROL 被停止或分批，CRITICAL receipt/人工回答/取消/deadline/delivery health 仍有保留容量；qualification 报告各队列类别的等待、busy、锁持有和重试指标，不能只报告一个总延迟。
