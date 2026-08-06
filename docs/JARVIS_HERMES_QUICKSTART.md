# Jarvis / Hermes 旧 Runner/tmux 兼容说明

> 这份文档只描述旧 `runner/` + `adapter/` 兼容面，不是 Option C App Server 的生产安装手册。旧 adapter 使用 Zulip 频道显示名称和 JSON state；Option C 使用数字 stream ID、SQLite、独立 Hermes 插件与 delivery sidecar。两者不会自动同步，也不能共享会话或路由权威状态。

这份说明给仍在使用旧 Runner/tmux 的 Jarvis 主 Hermes 使用。目标是让 Hermes 知道如何通过本机 Runner 把任务交给 Codex，并正确处理 Zulip、飞书、Hermes 原生对话和多项目目录。新安装应运行 `scripts/install-hermes-codex-bridge.sh` 并以 [Option C 设计](superpowers/specs/2026-07-16-hermes-codex-option-c-design.md)和[实施审核](reviews/OPTION_C_IMPLEMENTATION_REVIEW.md)为准。

如果当前部署走 Option C，不要使用本文的 `http://127.0.0.1:8731` Runner API 创建任务。Option C 的项目模型参数写在仓库外 `~/.hco/hco.json` 的 `projects[].threadOptions` 中，并通过本地 Unix socket 查询当前 Codex 源：

```sh
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  "http://localhost/v1/models?includeHidden=true&limit=100"
```

用返回的 `result.models[].id` 设置 `threadOptions.model`，用同一模型的 `supportedReasoningEfforts` 设置 `threadOptions.modelReasoningEffort`。完整 Option C 使用步骤见 [CHANNEL_TOPIC_MANAGEMENT.md](CHANNEL_TOPIC_MANAGEMENT.md) 和 [OPERATIONS.md](OPERATIONS.md)。

## 当前本机安装状态

仓库位置：

```text
/Users/hula/Projects/hermes-codex-orchestrator
```

本机 Runner 地址：

```text
http://127.0.0.1:8731
```

macOS LaunchAgent：

```text
com.hermes.codex-orchestrator
```

启动脚本：

```text
/Users/hula/.hco/run-hermes-runner.sh
```

Token 文件：

```text
/Users/hula/.hco/token
```

Adapter 配置：

```text
/Users/hula/.hco/adapter.json
```

Adapter 状态文件：

```text
/Users/hula/.hco/adapter-state.json
```

不要把 Token 写入仓库、日志、Zulip 消息、任务文件、Hermes 配置文本或命令行参数。Runner 和 adapter 都应从仓库外 Token 文件读取。

## Hermes/Jarvis 应该知道的对接信息

Jarvis 调用本项目时至少需要这些信息：

| 信息 | 当前值或来源 | 用途 |
|---|---|---|
| Runner Base URL | `http://127.0.0.1:8731` | 调用 Runner HTTP API |
| Runner Token | 从 `/Users/hula/.hco/token` 读取 | 所有 Runner API 的 Bearer 鉴权 |
| Adapter config | `/Users/hula/.hco/adapter.json` | 读取 Runner 地址、Token 文件、默认项目和 Zulip 路由 |
| Adapter state | `/Users/hula/.hco/adapter-state.json` | 保存会话绑定、Zulip 频道项目映射、话题模式和任务通知路由 |
| 项目列表 | `GET /projects` | 校验 `projectId`，禁止把未知项目发给 Runner |
| 任务入口 | `POST /tasks` | 创建只读或写任务，并可立即 dispatch 给 Codex |
| 状态入口 | `GET /tasks/:taskId`、`GET /tasks/:taskId/logs`、`GET /sessions` | 查询任务状态、日志和 tmux/Codex session |

所有 Runner 请求必须带：

```http
Authorization: Bearer <token-from-/Users/hula/.hco/token>
Content-Type: application/json
```

`/health` 也需要鉴权。

## 推荐给 Hermes/Jarvis 的最小系统规则

可以在 Jarvis 主 Hermes 中加入一段类似规则：

```text
当用户要求调用 Codex、安排开发任务、检查项目、修改代码、查看任务状态或读取 Codex 执行结果时，优先通过 Hermes Codex Orchestrator。

本机 Runner 地址是 http://127.0.0.1:8731，Bearer Token 从 /Users/hula/.hco/token 读取，不得输出 Token。

调用前必须先 GET /projects 校验 projectId。不要根据频道名或自然语言猜项目。

Zulip 来源消息使用 Zulip 专用路由：只有显式映射 projectId 的频道才是项目频道；未映射频道和其中所有话题由 Hermes 直接管理。项目频道的 topic 决定话题模式和通知目标。

飞书和 Hermes 原生对话使用通用路由：优先使用命令中显式 projectId，其次使用当前 conversationId 的绑定，最后才使用默认项目。

同一项目的写任务必须串行；如果已有活跃写任务，应拒绝或排队，不要并发 dispatch。

任务创建后必须把 taskId、projectId、状态查询方式回复给原会话，并持续或按需查询状态。
```

如果 Hermes 支持 skill，建议给 Hermes 建立一个专用 skill。这个 skill 不需要掌握项目源码，只需要掌握本说明里的路由、鉴权、命令和安全边界。

## Zulip 来源消息的规则

Zulip 只在 Zulip 消息来源下使用下面规则：

```text
Zulip 频道 / stream -> projectId
Zulip 话题 / topic  -> 话题模式、会话和通知目标
```

也就是说：

- 只有静态配置或运行时状态中显式映射了 `projectId` 的频道才决定项目目录。
- 频道名即使与 `projectId` 完全相同，也不会自动建立映射。
- 没有 `projectId` 的频道及其中所有话题由 Hermes 直接管理，不创建 Runner 任务。
- 项目频道的话题不改变项目，只决定话题模式、回复和后续通知目标。

示例：

| Zulip 频道 | Zulip 话题 | projectId | 含义 |
|---|---|---|---|
| `stockprofits` | `需求讨论` | `stockprofits` | 在 stockprofits 项目里创建任务，通知回该话题 |
| `调用工作` | `修复 adapter` | `abc` | 如果已映射为 `调用工作 -> abc`，就在 abc 项目里创建任务 |
| `abc d` | `新需求` | 无 | 未显式映射，整个频道由 Hermes 管理，不猜 `abcd` |

### 频道映射

新频道默认由 Hermes 管理。HCO 不查询相似项目、不按同名项目自动绑定，也不因为消息带了 `--project` 就临时跨项目。需要项目执行时，由 maintainer/admin 明确建立映射：

```text
/codex projects
/codex route set <projectId>
```

`/codex route none` 可显式标记为 Hermes 通用频道；`/codex route unset` 删除运行时决定，之后静态配置仍可能生效。改变频道映射时，HCO 会清除该频道已有的话题模式，避免旧项目状态带到新项目。

常用 Zulip 路由命令：

| 命令 | 作用 |
|---|---|
| `/codex route show` | 查看当前频道的项目关联状态 |
| `/codex route set <projectId>` | 把当前频道关联到指定项目 |
| `/codex route unset` | 删除当前频道运行时映射或通用频道标记 |
| `/codex route none` | 标记当前频道不关联任何项目，作为通用对话 |

`route set`、`route unset`、`route none` 只允许维护者或管理员执行。普通成员可以执行 `route show`。`route confirm` 仅作为旧客户端的 `route set` 兼容别名，不再对应相似项目建议流程。

### 项目话题模式

项目频道中的每个话题有三个状态：

| 状态 | 说人话的含义 |
|---|---|
| `AUTO` | 默认状态；Hermes 判断需要项目执行时，可以创建 Codex 任务 |
| `CODEX_BOUND` | 这个话题最近成功创建了真实 Runner 任务，状态中保存真实 `taskId` |
| `HERMES_ONLY` | 这个话题暂不使用 Codex，后续 `/codex ask` 和 `/codex run` 会被拦截 |

显式命令：

| 命令 | 作用 |
|---|---|
| `/codex topic show` | 查看当前话题状态 |
| `/codex topic hermes` | 设为 `HERMES_ONLY` |
| `/codex topic auto` | 恢复为 `AUTO` |

普通已认证成员可以控制自己正在说话的当前话题，但不能借此获得 `/codex run` 的写权限。切到 `HERMES_ONLY` 不会停止或取消已经创建的任务；回复会给出原 `taskId` 和明确的取消命令。

自然语言也必须支持，例如“这个话题不要用 Codex”或“这个话题可以重新交给 Codex”。Hermes 只调用配置的模型一次，把结果收敛成下面的严格结构，再调用 HCO：

```js
await applySemanticControl({
  control: {
    type: "CONTROL",
    action: "SET_TOPIC_MODE",
    mode: "HERMES_ONLY" // 或 "AUTO"
  },
  message,
  config,
  statePath
});
```

HCO 不自己理解普通自然语言，只验证结构、频道映射、当前话题和用户权限。结构不合法就返回 `model_protocol_error`，不会再调用第二次模型修复。当前仓库已经实现这个接收入口；Hermes 的模型循环仍需在上游 transport/plugin 中接线。

## 飞书和 Hermes 原生对话的规则

飞书和 Hermes 原生对话不使用 Zulip 频道/topic 规则。

项目选择顺序：

1. 命令中显式写了 `projectId`，就使用该项目。
2. 当前 `conversationId` 已经 `/codex bind <projectId>`，就使用绑定项目。
3. 配置里存在 `defaultProjectId` 时，才使用默认项目。
4. 仍无法确定时，拒绝创建任务并要求用户提供或绑定项目。

常用命令：

| 命令 | 作用 |
|---|---|
| `/codex projects` | 查看可用项目 |
| `/codex bind <projectId>` | 把当前飞书/Hermes 会话绑定到项目 |
| `/codex ask <task>` | 创建只读任务 |
| `/codex run <projectId> <task>` | 创建写任务并 dispatch |
| `/codex status <taskId>` | 查询任务状态 |
| `/codex logs <taskId>` | 查询任务日志 |
| `/codex sessions` | 查看 Codex/tmux session |

飞书和 Hermes 原生对话中不要使用 `/codex route ...`；这是 Zulip 专用命令。

## 多项目目录适配

这个项目支持多个工作项目同时存在。每个项目必须有：

- 唯一 `projectId`
- 唯一项目目录
- 唯一 `.hermes` 任务目录
- 唯一 `tmuxSession`

推荐结构：

```text
projectId: stockprofits
path:      /Users/hula/Projects/stockprofits
session:   codex-stockprofits

projectId: hermes-codex-orchestrator
path:      /Users/hula/Projects/hermes-codex-orchestrator
session:   codex-hermes-codex-orchestrator
```

Jarvis/Hermes 每次创建任务前必须用 `GET /projects` 校验 `projectId` 存在。不要把未确认的频道名、自然语言项目名或相似名称直接当作 `projectId` 提交给 Runner。

不同项目的任务可以并行。同一项目的写任务必须串行。只读任务可以并行，但仍应避免把高风险操作伪装成只读任务。

## Runner API 最小调用方式

### 健康检查

```sh
TOKEN="$(tr -d '\r\n' < /Users/hula/.hco/token)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8731/health
```

### 查看项目

```sh
TOKEN="$(tr -d '\r\n' < /Users/hula/.hco/token)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8731/projects
```

### 创建任务并立即 dispatch

```sh
TOKEN="$(tr -d '\r\n' < /Users/hula/.hco/token)"
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "hermes-codex-orchestrator",
    "goal": "检查当前项目状态并给出下一步建议。",
    "constraints": ["用中文回复。"],
    "acceptanceCriteria": ["说明检查结果。"],
    "allowCodeChanges": false,
    "allowNetwork": false,
    "dispatch": true,
    "requestedBy": {
      "source": "hermes",
      "conversationId": "jarvis-main"
    }
  }'
```

真实实现中不要把 Token 打印到日志；上面的 shell 示例只用于本机人工验证。

## 本地 adapter harness 示例

在真实 Zulip/飞书/Hermes transport 接好之前，可以用本地 normalized message harness 验证路由行为。

Zulip 示例：

```sh
node /Users/hula/Projects/hermes-codex-orchestrator/adapter/index.js \
  --config /Users/hula/.hco/adapter.json \
  --message '{
    "platform": "zulip",
    "stream": "hermes-runner",
    "topic": "安装验证",
    "text": "/codex route show",
    "user": { "id": "hula", "role": "admin" },
    "receivedAt": "2026-07-15T00:00:00.000Z"
  }'
```

Hermes 原生对话示例：

```sh
node /Users/hula/Projects/hermes-codex-orchestrator/adapter/index.js \
  --config /Users/hula/.hco/adapter.json \
  --message '{
    "platform": "hermes",
    "conversationId": "jarvis-main",
    "text": "/codex projects",
    "user": { "id": "hula", "role": "admin" },
    "receivedAt": "2026-07-15T00:00:00.000Z"
  }'
```

恢复未完成任务轮询：

```sh
node /Users/hula/Projects/hermes-codex-orchestrator/adapter/index.js \
  --config /Users/hula/.hco/adapter.json \
  --recover
```

## 给最终用户的使用方式

Zulip 用户：

```text
/codex projects
/codex route show
/codex route set hermes-codex-orchestrator
/codex topic show
/codex topic hermes
/codex topic auto
/codex ask 检查当前项目状态，不要修改代码
/codex run 修复 adapter 的某个问题，并完成验证
/codex status <taskId>
/codex logs <taskId>
```

飞书或 Hermes 原生用户：

```text
/codex projects
/codex bind hermes-codex-orchestrator
/codex ask 检查当前项目状态，不要修改代码
/codex run hermes-codex-orchestrator 修复某个问题，并完成验证
/codex status <taskId>
/codex logs <taskId>
```

## 运维检查

查看服务：

```sh
launchctl list | rg 'com.hermes.codex-orchestrator'
```

重启服务：

```sh
launchctl kickstart -k "gui/$(id -u)/com.hermes.codex-orchestrator"
```

查看日志：

```sh
tail -n 100 /Users/hula/.hco/runner.out.log
tail -n 100 /Users/hula/.hco/runner.err.log
```

健康检查：

```sh
TOKEN="$(tr -d '\r\n' < /Users/hula/.hco/token)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8731/health
```

## 安全边界

- Runner 默认使用 Token 鉴权，不要关闭。
- 不要把 `127.0.0.1:8731` 直接暴露公网。
- 跨机器访问时应走 Tailscale 或受控反向代理，并继续保留 Bearer Token。
- Adapter/Hermes 在调用 Runner 前必须完成用户权限判断。
- 普通用户不应访问 `/codex raw <taskId>`。
- `allowCodeChanges` 是给 Codex 和 adapter 的控制语义，不是系统级沙箱。
- `cancel` 只把任务标记为取消，不保证停止已经在 tmux/Codex 中运行的进程。

## 继续阅读

- [README.md](../README.md)
- [docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md](HERMES_ZULIP_ADAPTER_INTEGRATION.md)
- [docs/OPERATIONS.md](OPERATIONS.md)
