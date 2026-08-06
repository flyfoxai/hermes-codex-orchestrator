# Codex Orchestrator 历史整体机制框架说明

> 本文描述的是 Option C/Runner 迁移期实现，不是当前目标架构的权威方案。当前目标以 [`HCO_CODEX_SERVICE_BRIDGE_PRD.md`](HCO_CODEX_SERVICE_BRIDGE_PRD.md) 为准；尤其不能据本文继续扩大 HCO 的消息 outbox、Zulip delivery sidecar、提醒调度或通用多 Agent 控制面。

本文总结当前 `hermes-codex-orchestrator` 的安装方式、机制框架、主要特性、功能边界和注意事项。它是总览文档；具体命令和运维细节以 [SETUP.md](SETUP.md)、[OPERATIONS.md](OPERATIONS.md)、[HERMES_ZULIP_ADAPTER_INTEGRATION.md](HERMES_ZULIP_ADAPTER_INTEGRATION.md) 和 [HTTP_API_INTEGRATION.md](../HTTP_API_INTEGRATION.md) 为准。

## 1. 项目定位

`hermes-codex-orchestrator` 是 Hermes/Jarvis、Zulip 等消息入口和 Codex 执行环境之间的本地编排层。它不直接替代 Hermes，也不替代 Codex；它负责把用户消息安全地路由到明确项目，把执行请求交给 Codex，并把状态、审批、输入请求和最终结果回传到原会话。

当前仓库包含两套执行面：

1. **Option C 生产面**：核心目录为 `hco/`、`plugin/hermes-codex-bridge/` 和 delivery sidecar。它通过 Codex App Server 保持 thread/objective 连续性，以数字 Zulip stream ID、SQLite 和 route snapshot 作为权威状态。
2. **旧 Runner/tmux 兼容面**：核心目录为 `runner/` 和 `adapter/`。它通过 HTTP API、项目任务文件和 `tmux` 驱动 Codex TUI，主要用于旧部署、harness、回滚和兼容验证。

两套执行面不能混用状态：不要把旧 Runner 的 `taskId`、频道显示名称路由、JSON adapter state 当作 Option C 的权威状态；Option C 也不会自动续接旧 Runner/tmux 的任务。

## 2. 整体架构

### Option C 生产链路

```text
Zulip / Hermes message
  |
  | Hermes plugin: 路由检查、上下文签名、命令/语义事件
  v
HCO bridge over Unix socket
  |
  | Bearer auth + protocol negotiation + strict JSON contract
  v
HCO service
  |
  | route resolver + ACL + objective/turn controller + SQLite state
  v
Codex App Server
  |
  | durable thread + turn + reverse interaction
  v
Codex execution
  |
  | turn completed / approval / user input notifications
  v
SQLite outbox -> delivery sidecar -> Zulip
```

Option C 的关键点是“项目身份只来自可信路由”。Zulip 项目路由使用数字 stream ID，不使用频道显示名称、topic、消息内容、cwd、模型猜测或历史记忆推断项目。

### 旧 Runner/tmux 兼容链路

```text
Hermes / Adapter command
  |
  | Runner HTTP API + Bearer token
  v
Runner service
  |
  | .hermes task files + logs + dispatch prompt
  v
tmux session
  |
  | short prompt pasted into Codex TUI
  v
Codex CLI
```

旧兼容面以项目目录下 `.hermes/tasks/<taskId>.md` 作为任务事实源。Runner 负责创建和投递任务，Codex 负责读取任务文件、执行、并回写状态和结果。

## 3. 安装和部署

### 基础依赖

- Node.js `>=20`
- macOS/Linux 上需要 `tmux` 和可用的 `codex`
- Option C 需要可用的 `codex app-server --stdio`
- Python 环境来自 Hermes 仓库，安装脚本默认使用 `/Users/hula/Projects/hermesAgent/venv/bin/python3`
- SQLite 由 Node 依赖 `better-sqlite3` 支撑

常用本地检查：

```sh
node -v
tmux -V
codex --version
codex login status
```

仓库依赖安装和本地验证：

```sh
cd /Users/hula/Projects/hermes-codex-orchestrator
npm install
npm run verify
```

`npm run verify` 覆盖语法检查、Runner smoke/contract/dispatch/hardening 测试。Option C 相关单元测试可按运维文档额外运行 `node --test`、Python contract test 和安装器测试。

### Option C 用户级安装

生产化 macOS 安装使用：

```sh
./scripts/install-hermes-codex-bridge.sh \
  --hco-config "$HOME/.hco/hco.json" \
  --zulip-config "$HOME/.zuliprc" \
  --node-bin "$(command -v node)" \
  --codex-bin "$(command -v codex)"
```

强烈建议先执行 `--dry-run`：

```sh
./scripts/install-hermes-codex-bridge.sh \
  --dry-run \
  --hco-config "$HOME/.hco/hco.json" \
  --zulip-config "$HOME/.zuliprc" \
  --node-bin "$(command -v node)" \
  --codex-bin "$(command -v codex)"
```

安装器的行为：

- 创建版本化、不可变的插件 release 目录。
- 通过原子 symlink 激活 `plugins/hermes-codex-bridge`。
- 创建两个独立用户级 LaunchAgent：`com.hermes.codex-bridge-hco` 和 `com.hermes.codex-bridge-delivery`。
- 配置受限的 `zulip-ingress`、`codex-bridge` profile，以及普通对话用的 `hermes-general` profile。
- 安装前做三层兼容检查：HCO bridge protocol、当前 Hermes 安装、Codex App Server。
- 写入部署 manifest、attestation 和 route semantic hash，用于部署后验证。
- 部署变更期间支持事务性回滚；提交后的降级需要作为新的运维变更处理。

Option C 配置来自仓库外 `hco.json`，示例见 [config/hco.json.example](../config/hco.json.example)。核心字段包括：

- `codexExecutablePath`：Codex 可执行文件绝对路径。
- `databasePath`：HCO SQLite 数据库绝对路径。
- `bridge.tokenPath`：Unix socket bridge bearer 文件。
- `bridge.contextKeyPath`：上下文 HMAC key 文件。
- `bridge.socketPath`：HCO bridge Unix socket。
- `bridge.routeSnapshotPath`：Hermes 插件读取的 route snapshot。
- `admins`：全局管理员 Zulip user ID。
- `projects`：项目 `projectId`、`cwd`、后端、静态 stream ID 和 ACL。
- `projects[].threadOptions`：项目级 Codex 启动选项，可设置 `model`、`modelReasoningEffort`、`approvalPolicy`、`sandbox`、`baseInstructions` 和 `developerInstructions`。其中 `modelReasoningEffort` 是 HCO 配置名，发送给 Codex App Server 时会映射为 `config.model_reasoning_effort`。可用模型和推理深度以运行时 `/v1/models` 查询结果为准。

所有配置、bearer、HMAC key、Zulip 配置文件都必须位于仓库外，属于当前用户，且权限为 owner-only，通常是 `0600`。

### 旧 Runner/tmux 安装

旧兼容面使用：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
npm start
```

默认监听 `127.0.0.1:8731`。项目通过 HTTP API 注册，任务通过 `POST /tasks` 创建；请求体中 `dispatch: true` 时立即投递到项目对应的 `tmux` session。

长期运行可使用用户级 launchd 或 systemd wrapper。Token 必须由 wrapper 从仓库外文件读取，不写入 plist、service、命令行参数或日志。

## 4. 核心机制

### 路由机制

Option C 路由只承认数字 Zulip stream ID：

- `staticStreamIds` 在 `hco.json` 中声明静态项目路由。
- 运行时 `/codex route set|unset|none` 写入 SQLite runtime route。
- 未匹配 stream 默认归 Hermes，不会创建 Codex objective。
- 路由变化会发布 route snapshot，Hermes 插件读取该 snapshot 做本地拦截和提示。
- route snapshot 带 TTL、generation 和 sha256 完整性校验；过期、损坏或过大时不能当作有效路由。

一个数字 stream 唯一绑定一个项目 canonical cwd。Topic 不决定项目；每个 stream/topic 的稳定 `topic_context_id` 唯一绑定一个逻辑 Codex 上下文会话和主 thread，同时承载会话模式和 objective 绑定。不同 topic 不能复用彼此的 Codex thread：

- `AUTO`：默认状态，可由 Hermes/Codex 桥接创建或继续 objective。
- `CODEX_BOUND`：已有 Codex objective 与该 topic 关联。
- `HERMES_ONLY`：当前 topic 不交给 Codex；不会自动取消已有 objective。

### 权限机制

Option C 使用项目 ACL：

- `viewer`：读取项目、topic、objective 状态。
- `contributor`：创建/继续/cancel objective，回答允许自己响应的 interaction。
- `maintainer`：管理 topic、route、后端恢复。
- `admin`：全局管理权限，可管理 Hermes-owned route 等跨项目操作。

ACL 使用 Zulip 数字 user ID。普通消息、命令和交互回复都会经过权限校验。

### Objective、Thread 和 Turn

Option C 中一次可执行目标称为 objective：

- 新任务创建 objective。
- 同一 topic 可继续当前 objective。
- App Server 后端支持 durable thread continuity，能保留 Codex thread。
- `THREAD_BIND` 用于恢复或绑定已知 App Server thread，需要维护者权限。
- Codex turn 完成后，HCO 记录 terminal output，并通过 outbox 安排消息投递。

App Server 断开时，HCO 会把后端置为 unavailable，并按退避重连。请求结果不确定时会以 uncertain/reconciliation 状态处理，避免把可能已写入的请求误判为失败后重复执行。

### 反向交互机制

Codex App Server 可能发起反向请求：

- 命令执行审批：`item/commandExecution/requestApproval`
- 文件变更审批：`item/fileChange/requestApproval`
- 用户输入请求：`item/tool/requestUserInput`

HCO 会把这些 interaction 持久化，并渲染成 Zulip 可读消息。用户可通过 `/codex approve ...` 或 `/codex answer ...` 回复；涉及扩展权限、复杂决策、敏感输入或无法安全表示的问题，会要求用户回到 App Server UI 操作。

### 状态存储和投递

Option C 使用 SQLite 保存：

- objective、submission、turn、interaction
- runtime route、topic mode、control generation
- audit facts
- Zulip outbox

Zulip delivery sidecar 通过 `/v1/outbox/claim` 领取待发送消息，发送成功后 `ack`，失败后 `nack`。outbox 使用 lease、attempt count、semantic key 和 per-objective sequence，避免并发 worker 重复发送和乱序发送。

### 项目内文档中转

当前目标方案使用 `project_local/v1` 传递长上下文和结果。HCO 在频道对应项目的 canonical root 内自动创建 `.hco/exchanges/v1/<work_id>/<exchange_id>/`，把输入写入 `input/`，要求 Codex 把结果写入 `output/`，turn 完成后验证并把 manifest 状态持久化到 SQLite。它复用普通项目权限，不提供 App Server 层 sandbox、物理封口或写入期硬 quota。

- 输入和输出使用每次 exchange 独立的固定文件名，避免重试 worker 覆盖彼此文件。
- HCO 在执行前冻结输入的 bytes、类型和 SHA-256；输入被 Codex 改动时标记 `PROJECT_LOCAL_INPUT_CHANGED`。
- 必需输出缺失或不合法时标记 `PROJECT_LOCAL_OUTPUT_MISSING`/`PROJECT_LOCAL_OUTPUT_INVALID`，不把任务判定为成功。
- 同名结果不覆盖；同 hash 幂等复用，不同 hash 隔离为 `DOCUMENT_CONFLICT`。
- `status.json` 只用于排查提示；SQLite manifest、Codex event 和 Hermes continuation 才是事实源。
- Hermes 仍通过 external continuation 接收结果并调用模型决定交付、追问、继续或等待；文件目录不替代 Hermes 消息层。

兼容期的 `artifact_manifest` schema、路径安全、状态和回执格式见 [ARTIFACT_PROTOCOL.md](ARTIFACT_PROTOCOL.md)；它允许的任意项目相对路径不作为新 `project_local/v1` 的调用接口。

### Bridge 协议

HCO bridge 是 Unix socket HTTP 服务，主要接口包括：

- `GET /v1/compatibility`
- `GET /v1/health`
- `GET /v1/models`
- `POST /v1/events`
- `POST /v1/mailbox/claim`
- `POST /v1/mailbox/<mailboxItemId>/ack`
- `POST /v1/agents/report`
- `POST /v1/outbox/claim`
- `POST /v1/outbox/<deliveryId>/ack`
- `POST /v1/outbox/<deliveryId>/nack`

请求必须带 bearer，必须使用协议版本、插件版本和 capabilities 协商。请求体和响应体都有大小上限，字段是严格白名单。

`/v1/agents/report` 只接受 Hermes 提供的子会话身份和停止事件，HCO 再反查内部 Agent/activation scope；客户端不能指定 HCO 内部 Agent ID 或报告目标。Agent 仍有非终态 Codex call 时，报告不会误标完成，而是把 Agent 和 work 明确置为 `WAITING_CODEX`。未曾调用 Codex、因此没有 HCO scope 的普通 Hermes Agent 返回确定的 `UNTRACKED`，继续走 Hermes 原生父子汇报。

`GET /v1/models` 是只读管理接口，不读取 JSON body，不触碰 outbox 或业务事件状态。它通过当前 Codex App Server client 调用 `model/list`，返回模型 ID、展示名、是否隐藏、支持的 `supportedReasoningEfforts`、默认推理深度和 service tier 等源端字段。查询参数只允许：

- `includeHidden=true|false`
- `limit=1..500`
- `cursor=<opaque cursor>`

HCO service 对模型目录做 TTL 缓存，默认 5 分钟。同一组查询参数独立缓存；源可用时返回新鲜数据，源短暂不可用且已有缓存时返回 `stale: true` 的旧缓存，首次查询无缓存且源不可用时返回 `MODEL_CATALOG_UNAVAILABLE`。配置加载阶段不会联网或启动 App Server 来校验模型名，避免 Codex 登录、网络或源异常导致 HCO 不能启动。

### 模型和推理深度

项目可以通过 `projects[].threadOptions.model` 指定 Codex 工作模型，通过 `projects[].threadOptions.modelReasoningEffort` 指定推理深度。长期方案不是在 HCO 中硬编码模型表，而是把 Codex App Server 的 `model/list` 作为运行时真源：

- `threadOptions.model` 使用 `/v1/models` 返回的 `models[].id` 或源端接受的模型 ID。
- `threadOptions.modelReasoningEffort` 应从对应模型的 `supportedReasoningEfforts` 中选择；不设置时由 Codex 使用 `defaultReasoningEffort` 或源端默认值。
- HCO 只校验配置字段是非空字符串，不做在线可用性校验。模型下线、账号权限变化或源端策略变化会在实际启动/resume thread 时由 Codex App Server 返回错误。
- 隐藏模型只有在 `includeHidden=true` 时才会出现在目录中；除非明确需要，不建议把隐藏模型写入生产项目配置。

## 5. 主要特性和功能

### Option C 生产面

- Hermes 插件不修改 Hermes core，通过独立插件和 profile 接入。
- 项目路由基于数字 stream ID，避免频道名称、topic 或模型推断造成串项目。
- 支持静态路由和运行时 route override。
- 支持 topic 级 `AUTO`、`HERMES_ONLY`、`CODEX_BOUND` 模式。
- 支持多项目，每个项目有独立 cwd、ACL、后端和 thread options。
- 支持项目内 `project_local/v1` 文档交换；输入完整性、输出格式和 required output 都由 HCO 软件校验。未来 `managed/v1` 仍受 App Server capability gate 控制。
- 默认后端是 Codex App Server，支持 thread 续接和 reverse interaction。
- 使用 SQLite 保存 objective、turn、interaction、outbox 和 audit 状态。
- delivery sidecar 与 HCO 独立运行，HCO 停止不会自动停止 delivery，反之亦然。
- 安装器支持 dry-run、兼容性门禁、事务性部署、自动回滚、部署 manifest 和 post-deploy smoke。
- 对未映射 stream fail-closed：不猜项目，并给出登记提示。
- 对 route 审计、部署证据和 Zulip message trace 提供诊断脚本。

### 旧 Runner/tmux 兼容面

- HTTP API 创建、查询、取消和投递任务。
- 项目注册、项目列表、任务列表、日志、raw 文件、session 查询。
- 任务文件、日志和 dispatch prompt 都落在目标项目 `.hermes/` 下。
- `tmux` session 可复用，Runner 重启不会自动杀掉 Codex session。
- Adapter MVP 支持 `/codex projects`、`bind`、`route`、`topic`、`ask`、`run`、`status`、`logs`、`raw`、`cancel`、`dispatch`、`sessions` 等命令。
- 适合旧部署、测试 harness、回滚和 tmux 兜底，不提供 App Server thread 续接能力。

## 6. 注意事项

### 安全和密钥

- 不要把 bearer、HMAC key、Zulip API key、Runner token 写入仓库、日志、任务文件、LaunchAgent plist、systemd service、shell 历史或命令行参数。
- secret 文件必须在仓库外，owner-only，通常权限为 `0600`。
- 诊断输出和工单中必须脱敏，不粘贴完整环境变量。
- `HCO_AUTH_MODE=none` 只允许精确 loopback 临时调试；Tailscale、LAN、公网入口都必须使用 token。

### 路由和上下文

- Option C 项目路由只以数字 stream ID 和 SQLite/route snapshot 为权威。
- 不要根据频道显示名、topic、消息文本、cwd、记忆或模型判断项目。
- 用户文本、模型生成的 instruction、constraints、acceptance criteria 和 reminders 可以提到任意项目名或路径；插件不扫描这些文本来选择或拒绝项目。它们不能覆盖签名路由中的项目身份，HCO 始终使用注册表中的 canonical `cwd`。
- Hermes multiplex profile 在每个 turn 内使用独立的会话 cwd。profile 未显式配置 `terminal.cwd` 时使用 profile 自己的目录，不能继承默认业务项目的 cwd 或 `AGENTS.md`。
- 未映射 stream 默认归 Hermes；项目执行必须先明确登记 route。
- Topic mode 只影响当前话题是否允许 Codex，不改变项目。
- 切换 route 时要注意清理或确认旧 topic 状态，避免旧上下文误用。

### 部署和运维

- 同一配置根目录只运行一个 Runner 或 HCO 实例。
- Runner 或 HCO 不应直接暴露公网；公网必须通过带 TLS、认证、限流、审计和访问控制的网关。
- Tailscale/LAN 也要保持 token，并确认响应里是否暴露内部路径。
- HCO 必须先于 delivery 可用；冷启动时先验证 HCO socket 和 `/v1/compatibility`，再启动 delivery。
- 安装或升级后检查 `launchctl print`、stable symlink、deployment manifest、route snapshot、attestation 和 post-deploy smoke。
- 自动回滚只覆盖未提交事务；提交后的降级不能只切 symlink 后继续用新配置。

### 执行和一致性

- App Server 请求结果不确定时，不要自动重试可能已写入的操作。
- `cancel` 不等于强杀已经运行的 Codex 执行；旧 Runner/tmux 的 cancel 也只是更新任务状态。
- 旧 Runner 使用任务文件作为事实源，但不是跨进程强一致协议；不要多个 Runner 写同一配置根目录。
- Runner 重启不会自动停止 `tmux` 或 Codex session，重启后要用 `/sessions` 和 `tmux ls` 复核。
- 旧 Runner/tmux 的 `taskId` 和 Option C 的 `objectiveId`/`threadId` 是不同概念，不能互相替代。

### 输入输出限制

- HCO bridge 请求体默认上限为 1 MiB。
- Option C 单条 instruction 上限为 16 KiB，语义对象上限为 32 KiB。
- Artifact manifest 每个方向最多 16 个文件；单文件默认上限 1 MiB，可声明到 64 MiB。
- Artifact 路径必须位于项目 canonical `cwd` 内；控制字符、路径穿越、末端 symlink 和非普通文件会被拒绝。
- 所有 input 必须在 dispatch 时存在且通过可选 SHA-256 校验；optional 语义当前只适用于 output。
- route snapshot 默认上限为 256 KiB，TTL 默认 60 秒。
- interaction 通知过大时会渲染为精简版；敏感输入不通过 Zulip 命令承接。
- 普通用户不应看到 Runner 机器上的完整绝对路径，除非是管理员或内部调试场景。

## 7. 验证清单

启用或变更前至少确认：

1. `npm install` 已完成，`npm run verify` 通过。
2. Option C 配置、bearer、HMAC key、Zulip 配置均为绝对路径、仓库外、owner-only。
3. `scripts/install-hermes-codex-bridge.sh --dry-run` 输出符合预期。
4. 真实安装后两个 LaunchAgent 均可 `launchctl print`。
5. HCO `/v1/compatibility` 和 `/v1/health` 正常；delivery 可以 claim/ack outbox。
6. route snapshot 未过期，generation、semantic hash 和 deployment manifest 一致。
7. 至少一次隔离 topic 的只读任务完成：创建 objective、Codex App Server turn、结果入 outbox、Zulip delivery 成功。
8. route 未映射、Hermes-owned stream、PROJECT stream、HERMES_ONLY topic、权限不足、App Server 不可用等失败路径都按预期 fail closed。
9. 日志、manifest、audit 和诊断结果中没有泄露 secret。

## 8. 常用文档入口

- [README.md](../README.md)：仓库总入口，区分 Option C 和旧 Runner/tmux。
- [SETUP.md](SETUP.md)：安装、配置、Token 和项目注册。
- [OPERATIONS.md](OPERATIONS.md)：LaunchAgent/systemd、升级、回滚、post-deploy smoke 和诊断。
- [ARTIFACT_PROTOCOL.md](ARTIFACT_PROTOCOL.md)：正式 artifact manifest schema、生命周期、安全边界和示例。
- [HERMES_ZULIP_ADAPTER_INTEGRATION.md](HERMES_ZULIP_ADAPTER_INTEGRATION.md)：Adapter 和多平台路由设计。
- [CHANNEL_TOPIC_MANAGEMENT.md](CHANNEL_TOPIC_MANAGEMENT.md)：Zulip channel/topic 管理规则。
- [JARVIS_HERMES_QUICKSTART.md](JARVIS_HERMES_QUICKSTART.md)：旧 Runner/tmux 兼容说明。
- [HTTP_API_INTEGRATION.md](../HTTP_API_INTEGRATION.md)：旧 Runner HTTP API 参考。
