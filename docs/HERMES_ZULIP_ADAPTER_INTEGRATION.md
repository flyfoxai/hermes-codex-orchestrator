---
meta:
  contentType: Conceptual
---

# 对接 Hermes、Zulip 和多项目调度

这份文档是 Hermes/Zulip adapter 的下一阶段开发依据。它说明 adapter 如何把 Hermes 或 Zulip 对话转换成 Hermes Codex Orchestrator Runner 的 HTTP API 请求，并同时处理项目路由、Token 鉴权、权限判断、多项目调度、同项目写任务串行化和任务通知。

本文只规划 adapter，不改变 Runner。当前 Runner 已提供多项目注册、任务创建、任务查询、日志查询、原始任务查询、`tmux` session 查询、任务 dispatch 和取消接口。Hermes/Zulip adapter 仍未实现，需要按本文约束开发。

## 角色边界

推荐边界如下：

```text
Zulip / Hermes conversation
  |
  | command parsing, user authz, project routing, notification state
  v
Hermes/Zulip adapter
  |
  | Runner HTTP API + Bearer Token
  v
Hermes Codex Orchestrator Runner
  |
  | .hermes task files + tmux
  v
Codex CLI in project directory
```

Adapter 只负责：

- 解析 Hermes/Zulip 命令。
- 校验用户是否能查看项目、创建只读任务、创建写任务、启用网络、取消任务。
- 把 Zulip stream/topic 或 Hermes 会话映射到 `projectId`。
- 调用 Runner HTTP API。
- 保存通知路由状态，例如 `taskId -> Zulip stream/topic/messageId`。
- 轮询任务状态并把结果通知回原对话。
- 在 adapter 侧执行同项目写任务串行策略。

Adapter 不应负责：

- 读取项目源码。
- 拼接源码上下文。
- 直接执行 shell。
- 直接操作 `tmux`。
- 直接驱动 Codex CLI。
- 替 Runner 修改 `.hermes` 任务文件。

Runner 负责项目路径、任务文件、日志、dispatch prompt 和 `tmux` session。Codex 负责理解项目上下文、执行任务和回写任务结果。

## 当前 Runner 合同

### 连接信息

本机部署时：

```text
http://127.0.0.1:8731
```

跨机器部署时，应通过 Tailscale 或受控内网访问。优先使用 Tailscale HTTPS，例如 `tailscale serve`，并继续保留 Runner Bearer Token：

```text
https://<devmac_tailscale_name_or_ip>
```

不要直接把 Runner 端口暴露到公网。公网入口必须由 Hermes、Caddy、Nginx 或等价网关提供 TLS、认证、限流、审计和访问控制。

### 鉴权

Runner 默认使用 Token 鉴权。Adapter 每次请求都应带：

```http
Authorization: Bearer <hco_api_token>
Content-Type: application/json
```

`<hco_api_token>` 是说明性占位符。实现时从仓库外 Token 文件读取并注入 header，不要打印到日志。

Runner 只读取环境变量 `HCO_API_TOKEN`。如果运维使用 Token 文件，那是启动脚本或 LaunchAgent 读取文件后把值注入 `HCO_API_TOKEN`，不是 Runner 自己读取 `HCO_TOKEN_FILE`。

`HCO_AUTH_MODE=none` 只允许精确 loopback 地址，且只适合本机调试。Tailscale、LAN 和公网入口不得使用 `none`。

### Runner API

Adapter MVP 需要这些接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 启动检查和运维健康检查 |
| `GET` | `/projects` | 展示可调度项目，校验 `projectId` 和项目配置 |
| `POST` | `/projects/:projectId` | 创建或覆盖项目配置 |
| `PUT` | `/projects/:projectId` | 幂等同步项目配置，adapter 启动同步优先用这个 |
| `POST` | `/tasks` | 创建任务；请求体中 `dispatch: true` 时立即 dispatch |
| `GET` | `/tasks?projectId=<project_id>&limit=500` | 查询项目近期任务摘要 |
| `GET` | `/tasks?projectId=<project_id>&status=running&limit=500` | 按单个状态过滤任务 |
| `GET` | `/tasks/:taskId` | 查询任务状态和摘要 |
| `GET` | `/tasks/:taskId/logs?limit=200` | 查询任务日志 |
| `GET` | `/tasks/:taskId/raw` | 查询完整任务文件内容；只给管理员或内部调试使用 |
| `GET` | `/sessions` | 查询项目对应的 `tmux`/Codex session |
| `POST` | `/tasks/:taskId/dispatch` | 手动 dispatch 已存在任务；当前接口不读取请求体 |
| `POST` | `/tasks/:taskId/cancel` | 把任务状态标记为 `cancelled` |

`POST /tasks/:taskId/cancel` 只更新任务状态，不保证停止已经在 `tmux` 或 Codex 中执行的进程。Adapter 的用户提示必须说明这一点。

`GET /health` 返回 UTC ISO 时间，例如：

```json
{
  "ok": true,
  "service": "hermes-codex-orchestrator",
  "version": "0.1.0",
  "time": "2026-07-14T09:45:00.000Z"
}
```

### 任务摘要字段

`POST /tasks`、`POST /tasks/:taskId/dispatch`、`POST /tasks/:taskId/cancel`、`GET /tasks/:taskId` 和 `GET /tasks` 的任务摘要使用同一组字段：

```json
{
  "taskId": "HERMES-20260714-M9ZK4X-AB3C",
  "projectId": "stockprofits",
  "status": "queued",
  "goal": "检查当前失败测试并给出修复建议。",
  "taskFile": "/Users/hula/Projects/stockprofits/.hermes/tasks/HERMES-20260714-M9ZK4X-AB3C.md",
  "createdAt": "2026-07-14T09:45:00.000Z",
  "updatedAt": "2026-07-14T09:45:01.000Z",
  "tmuxSession": "codex-stockprofits",
  "resultSummary": null,
  "dispatchPromptFile": "/Users/hula/Projects/stockprofits/.hermes/dispatch/HERMES-20260714-M9ZK4X-AB3C.prompt.md",
  "failureReason": null,
  "cancellationReason": null
}
```

`taskId` 由 Runner 生成时形如：

```text
HERMES-YYYYMMDD-<BASE36_TIMESTAMP>-<4_CHAR_RANDOM>
```

不要按顺序号解析任务 ID。

`taskFile` 和 `dispatchPromptFile` 是 Runner 机器上的绝对路径。Adapter 不应把这些路径直接转发给普通 Zulip 用户。

### 当前摘要接口的限制

`GET /tasks` 和 `GET /tasks/:taskId` 的摘要不包含：

- `allowCodeChanges`
- `allowNetwork`
- `requestedBy`
- `constraints`
- `acceptanceCriteria`

这些字段存在于任务原始内容或任务元数据中，但不是摘要字段。因此，同项目写任务门禁不能只依赖 `GET /tasks` 摘要判断某个活跃任务是不是写任务。

## Adapter 配置

Adapter 至少需要这些配置：

| 配置 | 示例 | 用途 |
|---|---|---|
| `runnerBaseUrl` | `http://127.0.0.1:8731` | Runner HTTP API 地址 |
| `runnerTokenFile` | `/Users/hula/.hco/token` | Adapter 读取的仓库外 Token 文件 |
| `defaultProjectId` | `stockprofits` | 没有显式项目时的可选默认项目 |
| `zulipProjectRoutes` | `dev/stockprofits -> stockprofits` | Zulip stream/topic 到项目的映射 |
| `pollIntervalMs` | `5000` | 正常状态轮询间隔 |
| `pollMaxIntervalMs` | `30000` | 退避后的最大轮询间隔 |
| `taskPollTimeoutMs` | `7200000` | 单个任务最长轮询时间 |
| `writeTaskPolicy` | `reject_when_project_busy` | 同项目写任务并发策略 |
| `adapterStatePath` | `/Users/hula/.hco/adapter-state.json` | 保存任务通知路由和活跃写任务状态 |

Token 文件必须位于仓库外，并设置为 `0600`。不要把真实 Token 写入 Hermes 配置仓库、Zulip bot 配置、日志、任务文件或命令行参数。

## 注册和校验多个项目

Runner 通过 `projectId` 把任务路由到项目目录。每个项目应有独立路径和唯一 `tmuxSession`：

```text
stockprofits -> /Users/hula/Projects/stockprofits -> codex-stockprofits
project_a    -> /Users/hula/Projects/project-a     -> codex-project-a
project_b    -> /Users/hula/Projects/project-b     -> codex-project-b
```

Adapter 启动时应调用 `GET /projects` 并校验：

- `projectId` 在 Zulip/Hermes 路由表里存在。
- `path` 是预期项目路径。
- `tmuxSession` 在所有项目中唯一。
- `concurrency` 符合 adapter 支持的策略。
- 只在明确允许时同步注册项目。

项目注册或同步示例：

```sh
curl -X PUT http://127.0.0.1:8731/projects/project_a \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Project A",
    "path": "/Users/hula/Projects/project-a",
    "tmuxSession": "codex-project-a",
    "allowCodeChanges": true,
    "allowNetwork": true,
    "language": "zh-CN",
    "concurrency": "single-writer"
  }'
```

`projectId` 必须匹配 Runner 校验规则：首字符为字母或数字，总长度 2 到 64，只能包含字母、数字、下划线和连字符。

`tmuxSession` 必须是 1 到 64 个字母、数字、下划线或连字符，首字符必须是字母或数字。

如果生产环境关闭项目注册，`POST|PUT /projects/:projectId` 会返回 `project_registration_disabled`。这种情况下 adapter 只能读取现有项目配置，不能自动注册。

## Zulip/Hermes 到项目的映射

Zulip stream/topic 应通过显式映射选择项目：

```json
{
  "zulipProjectRoutes": {
    "dev/stockprofits": "stockprofits",
    "dev/project-a": "project_a",
    "ops/hermes-runner": "hermes-codex-orchestrator"
  }
}
```

项目选择顺序：

1. 命令显式包含 `projectId` 时，使用命令里的项目。
2. 否则根据 Zulip `stream/topic` 查 `zulipProjectRoutes`。
3. 否则使用当前 Hermes 会话已绑定的项目。
4. 否则在配置允许时使用 `defaultProjectId`。
5. 仍无法确定项目时，拒绝创建任务并提示用户先绑定项目。

不要根据自然语言猜项目。项目选择错误会把任务写入错误目录，也可能把 dispatch 发到错误 `tmuxSession`。

多项目同时工作时，每个项目用自己的 `projectId`、项目路径、`.hermes` 目录和 `tmuxSession`。Adapter 的状态文件也必须按 `projectId` 记录活跃任务，不能只保存一个全局当前项目。

## 推荐命令

Hermes 或 Zulip bot 可以提供这些命令：

| 命令 | 行为 |
|---|---|
| `/codex projects` | 调用 `GET /projects`，列出可调度项目 |
| `/codex bind <projectId>` | 把当前 Zulip stream/topic 或 Hermes 会话绑定到项目 |
| `/codex run <projectId> <task>` | 显式指定项目并创建任务 |
| `/codex ask <task>` | 使用当前 stream/topic 或会话绑定创建任务 |
| `/codex status <taskId>` | 调用 `GET /tasks/:taskId` |
| `/codex logs <taskId>` | 调用 `GET /tasks/:taskId/logs` |
| `/codex raw <taskId>` | 仅管理员可用，调用 `GET /tasks/:taskId/raw` |
| `/codex cancel <taskId>` | 调用 `POST /tasks/:taskId/cancel` |
| `/codex dispatch <taskId>` | 调用 `POST /tasks/:taskId/dispatch` |
| `/codex sessions` | 调用 `GET /sessions` |

`/codex ask` 适合固定 topic 的日常项目工作。`/codex run <projectId>` 适合跨项目调度或临时项目操作。

## 创建任务

Adapter 调用 `POST /tasks` 时，应把聊天来源写入 `requestedBy`：

```json
{
  "projectId": "stockprofits",
  "goal": "检查当前失败测试并给出修复建议。",
  "constraints": [
    "默认用中文回复。",
    "按用户授权决定是否修改代码。"
  ],
  "acceptanceCriteria": [
    "说明执行结果。",
    "如修改代码，说明改动和验证结果。"
  ],
  "allowCodeChanges": true,
  "allowNetwork": true,
  "dispatch": true,
  "requestedBy": {
    "source": "zulip",
    "userId": "hula",
    "stream": "dev",
    "topic": "stockprofits",
    "messageId": "1234567890123"
  }
}
```

当前 Runner 会保存 `requestedBy`，但不会基于它做权限判断。Adapter 必须在调用 Runner 前完成用户授权。

`goal`、`constraints`、`acceptanceCriteria` 和 `requestedBy` 都会进入 Codex 可读取的任务内容。Adapter 必须把这些字段当作不可信用户输入处理：

- 限制长度。
- 拒绝空任务。
- 规范化控制字符。
- 不把内部密钥、环境变量或完整系统提示写入任务。
- 在写任务场景中明确保留用户原始意图，避免 adapter 自己拼出越权指令。

## 权限模型

Adapter 推荐实现这些权限：

| 权限 | 对应字段或行为 | 建议 |
|---|---|---|
| 查看项目 | `GET /projects`、`GET /tasks` | 普通成员可用 |
| 查看日志 | `GET /tasks/:taskId/logs` | 项目成员可用 |
| 查看 raw | `GET /tasks/:taskId/raw` | 仅管理员或维护者 |
| 只读任务 | `allowCodeChanges=false` | 默认允许 |
| 写任务 | `allowCodeChanges=true` | 仅项目维护者或管理员 |
| 网络访问 | `allowNetwork=true` | 按项目或用户授权 |
| 取消任务 | `POST /tasks/:taskId/cancel` | 任务发起人、项目维护者或管理员 |
| 手动 dispatch | `POST /tasks/:taskId/dispatch` | 项目维护者或管理员 |

重要限制：

- MVP 中 Runner 只有一个静态 Token。拿到 Token 的进程拥有所有 Runner 项目权限。
- `allowCodeChanges` 是任务元数据和给 Codex 的约束，不是 Runner 强制权限边界。
- 如果 adapter 配错权限，普通用户也可能创建写任务。
- 普通用户不应看到 raw 任务内容、绝对路径、环境变量或完整内部日志。

## 多项目和同项目并发

多项目并发策略：

- 不同项目的任务可以并行。
- 同一项目的只读任务可以谨慎并行。
- 同一项目的写任务必须串行。
- 同一项目已有写任务处于 `pending`、`queued`、`running`、`waiting_user` 或 `verifying` 时，adapter 应拒绝新的写任务或放入 adapter 自己的队列。

Runner 当前提供：

- 任务文件原子写。
- 按 `taskId` 的进程内串行化。
- 任务文件冲突保护。

Runner 当前不提供：

- 跨任务的项目级写锁。
- `project_busy` 或 `project_locked` 错误。
- 能直接从 `GET /tasks` 判断任务是否为写任务的摘要字段。

因此，`concurrency: "single-writer"` 目前是项目配置语义，需要 adapter 执行。

### MVP 写任务门禁

安全 MVP 推荐用单实例 adapter，并维护 adapter 自己的活跃写任务状态：

1. 用户请求写任务。
2. Adapter 根据用户权限确认可以设置 `allowCodeChanges=true`。
3. Adapter 检查自己的 `adapterStatePath`，查找同项目活跃写任务。
4. 如果存在活跃写任务，按 `writeTaskPolicy` 拒绝或排队。
5. 如果不存在，先把即将创建的写任务登记为同项目活跃写任务。
6. 调用 `POST /tasks`，设置 `allowCodeChanges=true` 和 `dispatch: true`。
7. 保存 `taskId -> Zulip/Hermes 通知目标`。
8. 轮询到任务进入 `completed`、`failed` 或 `cancelled` 后，释放该项目写任务占用。

如果 adapter 允许外部直接调用 Runner 创建任务，或存在多个 adapter 实例，上述流程会有 TOCTOU 竞争：检查和创建不是一个原子操作。多实例部署必须增加外部锁，例如数据库唯一约束、Redis lock、文件锁，或等待 Runner 后续提供项目级写锁。

### 兼容外部任务

如果必须识别不是 adapter 创建的写任务，可选方案：

1. 调用 `GET /tasks?projectId=<project_id>&limit=500` 获取近期任务。
2. 过滤活跃状态：`pending`、`queued`、`running`、`waiting_user`、`verifying`。
3. 对这些候选任务调用 `GET /tasks/:taskId/raw`，解析元数据里的 `allowCodeChanges`。
4. 发现同项目活跃写任务时拒绝或排队。

这个方案成本更高，也会接触 raw 内容。只应在受信任的 adapter 内部使用，不要把 raw 内容转发给用户。

## 状态通知和恢复

Runner 当前没有 webhook。Adapter 使用轮询：

1. 创建任务后，立即把 `taskId` 回复到原 Zulip thread 或 Hermes 会话。
2. 以 `pollIntervalMs` 开始调用 `GET /tasks/:taskId`。
3. 连续多次无变化时退避，最高不超过 `pollMaxIntervalMs`。
4. 状态进入 `completed`、`failed` 或 `cancelled` 时发送最终通知。
5. 达到 `taskPollTimeoutMs` 后停止自动轮询，并提示用户用 `/codex status` 或 `/codex logs` 手动查看。

通知内容应包括：

- `taskId`
- `projectId`
- 当前状态
- `resultSummary`
- 日志查询命令
- 原始 Zulip stream/topic 或 Hermes 会话

Adapter 必须保存 `taskId -> 通知目标`，不能只依赖 Runner 的 `requestedBy`。原因是 `requestedBy` 不在任务摘要中，且通知系统通常还需要 Zulip thread、bot message id、重试计数和上次通知状态。

启动恢复时，adapter 应：

- 读取 `adapterStatePath`。
- 重新轮询未终止任务。
- 扫描处于 `pending` 或 `queued` 且超过阈值的任务。
- 对 stale `queued` 任务给出操作提示：重新 dispatch、取消，或人工检查 `tmux` session。
- 释放已经终止的活跃写任务占用。

## 错误处理

Adapter 应把 Runner 错误码和 adapter 本地错误转换成用户可理解的提示。

| 错误码 | 来源 | 用户提示 |
|---|---|---|
| `unauthorized` | Runner | Runner Token 无效或未加载，联系运维 |
| `project_not_found` | Runner | 项目未注册，先运行 `/codex projects` 或绑定项目 |
| `invalid_project_id` | Runner | 项目 ID 格式不合法 |
| `project_path_not_found` | Runner | Runner 机器上不存在该项目路径 |
| `project_registration_disabled` | Runner | 当前环境禁止通过 API 注册项目 |
| `payload_too_large` | Runner | 任务内容超过请求体限制 |
| `invalid_request` | Runner | 请求格式不正确 |
| `task_exists` | Runner | 指定任务 ID 已存在，重新创建或让 Runner 自动生成 |
| `task_not_found` | Runner | 找不到该任务 |
| `task_conflict` | Runner | 任务文件发生并发冲突，稍后重试 |
| `codex_not_found` | Runner | Runner 找不到 Codex CLI |
| `codex_unavailable` | Runner | Codex CLI 预检失败，检查登录状态 |
| `tmux_not_found` | Runner | Runner 找不到 `tmux` |
| `project_busy` | Adapter | 当前项目已有活跃写任务，稍后再试或排队 |
| `permission_denied` | Adapter | 当前用户没有执行该操作的权限 |
| `route_unbound` | Adapter | 当前 stream/topic 或会话没有绑定项目 |

日志里不要输出 Authorization header、真实 Token、模型 API key 或完整环境变量。

## 最小开发顺序

Adapter MVP 按这个顺序实现：

1. 从仓库外 Token 文件读取 Runner Token。
2. 调用 `GET /health`，确认 Runner 可用。
3. 调用 `GET /projects`，校验项目、路径和 `tmuxSession` 唯一性。
4. 实现 Zulip stream/topic 和 Hermes 会话到 `projectId` 的显式映射。
5. 实现 `/codex projects` 和 `/codex bind <projectId>`。
6. 实现 `/codex ask <task>` 和 `/codex run <projectId> <task>`。
7. 创建任务时写入 `requestedBy`。
8. 实现用户权限判断，并按权限设置 `allowCodeChanges` 和 `allowNetwork`。
9. 实现 adapter 侧同项目写任务排队或拒绝。
10. 实现 `taskId -> 通知目标` 状态存储。
11. 实现状态轮询、退避、超时和最终通知。
12. 实现 `/codex status`、`/codex logs`、`/codex cancel`、`/codex dispatch` 和 `/codex sessions`。
13. 增加 adapter 启动恢复逻辑。

## 部署检查清单

上线前确认：

- Runner 已通过 `npm run verify`。
- Runner 使用 `HCO_AUTH_MODE=token`。
- Adapter 从仓库外 `0600` Token 文件读取 Token。
- Adapter 日志不会输出 Token、Authorization header 或模型密钥。
- Zulip stream/topic 和 Hermes 会话到 `projectId` 的映射明确。
- 每个项目都有唯一 `tmuxSession`。
- 同一配置根目录只运行一个 Runner。
- MVP 阶段只运行一个 adapter 实例，或已配置外部项目级写锁。
- 同项目写任务有排队或拒绝策略。
- `GET /tasks/:taskId/raw` 只对管理员开放。
- Tailscale/LAN 访问已验证；跨机器访问优先 HTTPS。
- Runner 端口没有直接暴露公网。
- 至少一次真实任务完成创建、dispatch、Codex 回写、状态查询和 Zulip/Hermes 通知。
- 模拟 Runner 重启后，adapter 能恢复未完成任务轮询并处理 stale `queued` 任务。

## 后续增强

MVP 之后可以考虑：

- Runner 提供 webhook 或 server-sent events，减少轮询。
- Runner 在任务摘要中返回 `allowCodeChanges`、`allowNetwork` 和 `requestedBy` 的安全子集。
- Runner 提供项目级活跃写任务状态或原子项目写锁。
- Runner 支持每项目或每用户 Token。
- Runner 支持取消时联动 Codex/tmux 执行进程。
- Hermes adapter 支持审批流，例如写任务需要项目维护者确认。
- Zulip topic 绑定关系持久化并提供审计日志。
- 支持任务队列、优先级和队列位置通知。
