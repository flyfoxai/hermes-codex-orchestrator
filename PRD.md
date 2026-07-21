# Hermes Codex Orchestrator 产品需求文档

文档版本：2.0
更新日期：2026-07-21
状态：当前生产实施基线，包含已知缺口
主生产方案：Option C（Hermes bridge + HCO + Codex App Server）
兼容方案：Runner/tmux（仅用于旧部署、测试夹具和显式回滚）

## 1. 文档目的

本文定义 Hermes Codex Orchestrator（HCO）的当前产品合同、生产边界、用户交互、状态与恢复要求、安全约束、部署门禁和验收标准。

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
3. 用 HCO objective 管理用户意图，并用 Codex App Server thread 保持同一 objective 的技术上下文。
4. 区分无需 Hermes 推理的精确控制命令和需要业务理解的自然语言请求。
5. 将入站事件、执行、交互和结果交付持久化，支持幂等处理和进程重启恢复。
6. 将 Codex 的权威完成结果可靠地投递回原始 Zulip stream/topic，且不由 Hermes 静默改写技术结论。
7. 对错误项目、错误话题、未授权操作、重复执行和丢失最终结果实行 fail-closed。
8. 在 App Server 调用结果不确定时禁止盲目重试或自动切换到 tmux。

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

一个 objective 最多绑定一个当前 App Server thread；一个 objective 同时最多有一个活动 turn。topic 只是可变交付地址和默认 objective 选择，不是永久 thread 身份。

新 topic 不得提前创建 thread。相同目标的后续消息继续原 thread；同一 topic 中实质无关的新工作必须创建新 objective/thread；显式 continue 可选择该项目的旧 objective。

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
- 未显式选择：若 topic 有当前项目 objective 则继续，否则创建新 objective。

选择和状态变更必须由 HCO 在持久事务中完成，插件和模型不得自行替代 objective。

### 11.2 Codex 上下文交接

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

topic rename/move 需要可信 Zulip continuity 事件或显式运维 relink。系统不根据文本相似度自动合并 conversation；跨项目移动默认创建新的上下文。

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
