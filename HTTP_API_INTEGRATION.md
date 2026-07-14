# Hermes 调用 Runner HTTP API 集成方案

## 1. 方案定位

本方案定义 Hermes 与 Hermes Codex Orchestrator Runner 之间的 HTTP API 通讯方式。

推荐架构：

```text
Hermes Bot / Plugin
  |
  | HTTP API
  v
Runner Service
  |
  | 文件协议 + tmux
  v
Codex CLI
```

核心原则：

- Hermes 只做消息入口和通知出口。
- Runner 负责任务创建、状态管理、tmux 和 Codex 调度。
- Codex 负责读取项目上下文、执行代码任务、更新任务结果。
- Hermes 不直接管理代码上下文，不直接拼接源码上下文。

## 2. 为什么使用 HTTP API

相比直接做 Hermes 深度插件，HTTP API 方案有更好的解耦性：

- Hermes 升级时，通常只需要调整 adapter。
- Runner 可以独立部署、测试和重启。
- 未来可接入 Web UI、手机快捷入口、CLI、其他 bot。
- 权限、审计、限流和日志可以集中在 Runner 层。

## 3. 部署关系

### 3.1 单机部署

Hermes 和 Runner 在同一台远程服务器：

```text
Hermes Bot
  -> http://127.0.0.1:8731
Runner
  -> tmux + codex
```

优点：

- 安全边界简单。
- Runner API 不需要暴露到公网。
- 可以只监听 `127.0.0.1`。

### 3.2 局域网 / Tailscale 部署

Hermes 与 Runner 不在同一台机器：

```text
Hermes Bot
  -> http://100.x.x.x:8731
Runner on devmac
  -> tmux + codex
```

要求：

- 仅允许 Tailscale 或内网访问。
- 必须启用 API token 鉴权。
- 不建议直接暴露公网。

## 4. Runner API 基础信息

默认监听：

```text
127.0.0.1:8731
```

推荐环境变量：

```bash
HCO_HOST=127.0.0.1
HCO_PORT=8731
HCO_AUTH_MODE=token
HCO_TOKEN_FILE="$HOME/.hco/token"
HCO_API_TOKEN="$(tr -d '\r\n' < "$HCO_TOKEN_FILE")"
HCO_CONFIG=/Users/hula/Projects/hermes-codex-orchestrator/config/orchestrator.json
HCO_PROJECTS_CONFIG=/Users/hula/Projects/hermes-codex-orchestrator/config/projects.json
```

Token 文件必须位于仓库外并设置为 `0600`；不得在文档、配置文件或命令历史中写入真实 Token。

请求头：

```http
Authorization: Bearer <HCO_API_TOKEN>
Content-Type: application/json
```

## 5. API 总览

| 方法 | 路径 | 目的 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/projects` | 获取可调度项目 |
| `POST` | `/tasks` | 创建任务 |
| `POST` | `/tasks/:taskId/dispatch` | 投递任务给 Codex |
| `GET` | `/tasks/:taskId` | 查询任务详情 |
| `GET` | `/tasks` | 查询任务列表 |
| `POST` | `/tasks/:taskId/cancel` | 取消任务 |
| `GET` | `/tasks/:taskId/logs` | 查询任务日志 |
| `GET` | `/tasks/:taskId/raw` | 查询完整任务文件 |
| `GET` | `/sessions` | 查询 tmux/Codex session |

## 6. API 详细设计

### 6.1 健康检查

```http
GET /health
```

响应：

```json
{
  "ok": true,
  "service": "hermes-codex-orchestrator",
  "version": "0.1.0",
  "time": "2026-07-13T17:45:00+08:00"
}
```

用途：

- Hermes 启动时检查 Runner 是否可用。
- 运维脚本检查服务状态。

### 6.2 获取项目列表

```http
GET /projects
```

响应：

```json
{
  "projects": [
    {
      "projectId": "stockprofits",
      "name": "Stock Profits",
      "path": "/Users/hula/Projects/stockprofits",
      "allowCodeChanges": true,
      "allowNetwork": true,
      "tmuxSession": "codex-stockprofits"
    }
  ]
}
```

用途：

- Hermes 校验用户输入的项目名。
- Hermes 展示可用项目。

### 6.3 创建任务

```http
POST /tasks
```

请求：

```json
{
  "projectId": "stockprofits",
  "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
  "constraints": [
    "先只读检查，不修改代码。",
    "输出中文结论。"
  ],
  "acceptanceCriteria": [
    "给出当前项目阶段。",
    "给出本地 SpecCompass 版本。",
    "给出官方最新版本。",
    "说明是否需要升级。"
  ],
  "allowCodeChanges": false,
  "allowNetwork": true,
  "requestedBy": {
    "source": "hermes",
    "userId": "hula",
    "stream": "dev",
    "topic": "stockprofits"
  }
}
```

响应：

```json
{
  "taskId": "HERMES-20260713-001",
  "status": "pending",
  "projectId": "stockprofits",
  "taskFile": "/Users/hula/Projects/stockprofits/.hermes/tasks/HERMES-20260713-001.md"
}
```

行为：

- Runner 校验 `projectId` 是否在白名单。
- Runner 创建任务 Markdown 文件。
- Runner 写入初始状态 `pending`。
- Runner 返回任务 ID 和任务文件路径。

### 6.4 创建并立即投递任务

为了简化 Hermes 调用，可支持：

```http
POST /tasks
```

请求中增加：

```json
{
  "dispatch": true
}
```

行为：

- 创建任务。
- 更新状态为 `queued`。
- 预检 Codex CLI，启动或恢复 tmux session。
- 将固定 prompt 写入 `.hermes/dispatch/<taskId>.md`，再向 Codex 投递短读取指令。
- Codex 不可用或投递失败时，将任务更新为 `failed`，错误详情中返回 `taskId`。

响应：

```json
{
  "taskId": "HERMES-20260713-001",
  "status": "queued",
  "projectId": "stockprofits",
  "taskFile": "/Users/hula/Projects/stockprofits/.hermes/tasks/HERMES-20260713-001.md",
  "tmuxSession": "codex-stockprofits",
  "dispatchPromptFile": "/Users/hula/Projects/stockprofits/.hermes/dispatch/HERMES-20260713-001.md"
}
```

### 6.5 投递任务

```http
POST /tasks/:taskId/dispatch
```

请求：

```json
{
  "mode": "resume-or-create"
}
```

响应：

```json
{
  "taskId": "HERMES-20260713-001",
  "status": "queued",
  "tmuxSession": "codex-stockprofits",
  "dispatchPromptFile": "/Users/hula/Projects/stockprofits/.hermes/dispatch/HERMES-20260713-001.md"
}
```

行为：

- Runner 找到任务所属项目。
- 检查项目 tmux session 是否存在。
- 不存在则创建。
- 如果 Codex 未运行，则启动 Codex。
- 将 `templates/codex-dispatch-prompt.md` 渲染到 `.hermes/dispatch/`，向 tmux session 中的 Codex 投递短读取指令。

### 6.6 查询任务详情

```http
GET /tasks/:taskId
```

响应：

```json
{
  "taskId": "HERMES-20260713-001",
  "projectId": "stockprofits",
  "status": "running",
  "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
  "taskFile": "/Users/hula/Projects/stockprofits/.hermes/tasks/HERMES-20260713-001.md",
  "createdAt": "2026-07-13T17:45:00+08:00",
  "updatedAt": "2026-07-13T17:46:10+08:00",
  "resultSummary": null,
  "tmuxSession": "codex-stockprofits",
  "dispatchPromptFile": null,
  "failureReason": null,
  "cancellationReason": null
}
```

用途：

- Hermes 查询当前任务进度。
- 用户主动使用 `/codex status <task_id>`。

Runner 会协调任务 Markdown 可见区的 `Status`、`UpdatedAt` 和 `Result`。即使 Codex 只更新可见区，查询接口也会反映最新状态和 `resultSummary`。

### 6.7 查询任务列表

```http
GET /tasks?projectId=stockprofits&status=running&limit=20
```

响应：

```json
{
  "tasks": [
    {
      "taskId": "HERMES-20260713-001",
      "projectId": "stockprofits",
      "status": "running",
      "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
      "updatedAt": "2026-07-13T17:46:10+08:00"
    }
  ]
}
```

用途：

- Hermes 展示最近任务。
- 运维检查任务队列。

### 6.8 取消任务

```http
POST /tasks/:taskId/cancel
```

请求：

```json
{
  "reason": "用户取消"
}
```

响应：

```json
{
  "taskId": "HERMES-20260713-001",
  "status": "cancelled"
}
```

行为：

- 如果任务尚未投递，只更新任务状态。
- 如果任务正在运行，Runner 可向 tmux 投递取消提示。
- MVP 不强制杀掉 Codex 进程，避免误伤同项目其他上下文。

### 6.9 查询任务日志

```http
GET /tasks/:taskId/logs
```

响应：

```json
{
  "task": {
    "taskId": "HERMES-20260713-001",
    "projectId": "stockprofits",
    "status": "queued",
    "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
    "taskFile": "/Users/hula/Projects/stockprofits/.hermes/tasks/HERMES-20260713-001.md",
    "createdAt": "2026-07-13T17:45:00+08:00",
    "updatedAt": "2026-07-13T17:45:03+08:00",
    "tmuxSession": "codex-stockprofits"
  },
  "logs": [
    {
      "time": "2026-07-13T17:45:00+08:00",
      "level": "info",
      "message": "Task created."
    },
    {
      "time": "2026-07-13T17:45:03+08:00",
      "level": "info",
      "message": "Task dispatched to tmux session codex-stockprofits."
    }
  ]
}
```

注意：

- 日志必须脱敏。
- 不返回 API Key、token、Authorization header。

### 6.10 查询完整任务文件

```http
GET /tasks/:taskId/raw
```

响应：

```json
{
  "task": {
    "taskId": "HERMES-20260713-001",
    "status": "completed"
  },
  "content": "<!-- hco:metadata ... -->\n\n# HERMES-20260713-001\n..."
}
```

用途：Hermes 或运维直接查看完整事实源文件，不需要读取服务器文件系统。

### 6.11 查询 session

```http
GET /sessions
```

响应：

```json
{
  "platform": "darwin",
  "tmuxSupported": true,
  "sessions": [
    {
      "projectId": "stockprofits",
      "projectPath": "/Users/hula/Projects/stockprofits",
      "tmuxSession": "codex-stockprofits",
      "exists": true,
      "status": "checked"
    }
  ]
}
```

用途：

- 运维查看当前运行态。
- Hermes 判断项目是否已有活跃任务。

## 7. 状态流转

HTTP API 层使用与 PRD 相同的状态流转：

```text
pending -> queued -> running -> waiting_user -> verifying -> completed
                              -> failed
                              -> cancelled
```

Runner 负责更新：

- `pending`
- `queued`
- `cancelled`
- `failed`

Codex 负责更新：

- `running`
- `waiting_user`
- `verifying`
- `completed`
- 任务内详细结果

## 8. Hermes 适配边界

Hermes adapter 只做以下事情：

1. 解析用户命令。
2. 校验用户是否有权限调度项目。
3. 调用 Runner HTTP API。
4. 将 Runner 返回的任务 ID 发给用户。
5. 查询任务状态。
6. 发送任务完成或失败通知。

Hermes adapter 不做：

- 不读取项目源码。
- 不读取 `.speccompass/` 并自行总结。
- 不拼接大段上下文。
- 不直接执行 shell 命令。
- 不直接调用 Codex。

## 9. Hermes 命令建议

### 9.1 创建并运行任务

```text
/codex run stockprofits 检查当前项目进度，确认 SpecCompass 是否最新版。
```

Hermes 调用：

```http
POST /tasks
```

并设置：

```json
{
  "dispatch": true
}
```

### 9.2 查询任务

```text
/codex status HERMES-20260713-001
```

Hermes 调用：

```http
GET /tasks/HERMES-20260713-001
```

### 9.3 查看项目

```text
/codex projects
```

Hermes 调用：

```http
GET /projects
```

### 9.4 取消任务

```text
/codex cancel HERMES-20260713-001
```

Hermes 调用：

```http
POST /tasks/HERMES-20260713-001/cancel
```

## 10. 鉴权设计

MVP 使用静态 Bearer token：

```http
Authorization: Bearer <HCO_API_TOKEN>
```

Runner 必须：

- 拒绝缺少 token 的请求。
- 拒绝 token 不匹配的请求。
- 不在日志中打印 token。
- 支持 token 从环境变量读取。

后续可增强：

- 每个 Hermes bot 单独 token。
- token 权限范围。
- 请求签名。
- IP 白名单。
- Tailscale identity 校验。

## 11. 错误响应格式

统一错误格式：

```json
{
  "error": {
    "code": "project_not_found",
    "message": "Project stockprofits is not registered.",
    "details": {}
  }
}
```

常见错误码：

| code | 含义 |
|---|---|
| `unauthorized` | 鉴权失败 |
| `project_not_found` | 项目未注册 |
| `task_not_found` | 任务不存在 |
| `invalid_request` | 请求参数错误 |
| `invalid_project_id` | 项目 ID 格式错误 |
| `invalid_task_id` | 任务 ID 格式错误 |
| `runner_error` | Runner 内部错误 |
| `tmux_not_found` | 远程主机缺少 tmux |
| `codex_not_found` | 找不到 Codex CLI |
| `codex_unavailable` | Codex CLI 存在但预检失败 |
| `project_locked` | 项目已有写任务运行 |

## 12. 安全要求

Runner HTTP API 默认只监听：

```text
127.0.0.1
```

如果要监听 Tailscale IP：

- 必须启用 token。
- 建议限制防火墙。
- 不允许公网开放。
- 日志必须脱敏。
- 请求体不允许传 API Key。

## 13. 日志要求

Runner 至少记录：

- 请求时间。
- 请求路径。
- 调用来源。
- task_id。
- project_id。
- 状态变化。
- tmux session。
- 错误摘要。

不得记录：

- Authorization header。
- OpenAI API Key。
- Anthropic API Key。
- CC Pocket token。
- SSH 私钥。

## 14. MVP 实现顺序

1. 实现 `GET /health`。
2. 实现 `GET /projects`。
3. 实现 `POST /tasks`，只创建任务文件。
4. 实现 `POST /tasks/:taskId/dispatch`。
5. 实现 `GET /tasks/:taskId`。
6. 实现 `GET /tasks`。
7. 实现 Hermes `/codex run` 和 `/codex status`。
8. 再实现取消、日志和 session 查询。

## 15. 验收标准

HTTP API 方案完成后，应能验证：

1. Hermes 能通过 HTTP 创建任务。
2. Runner 能在项目目录生成 `.hermes/tasks/<task_id>.md`。
3. Runner 能启动或恢复 tmux session。
4. Runner 能将任务投递给 Codex。
5. Codex 能读取任务文件并回写结果。
6. Hermes 能查询任务状态。
7. Hermes 能收到任务完成摘要。
8. Runner 重启后仍能通过任务文件恢复状态。

## 16. 关键结论

HTTP API 是推荐的稳定集成方式。

最终边界应保持为：

```text
Hermes = 入口和通知
Runner HTTP API = 稳定调度边界
tmux + Codex = 远程执行上下文
项目文件 = 事实源
```

这样 Hermes 升级时，主要影响 Hermes adapter；Runner、任务文件协议和 Codex 执行协议可以保持稳定。
