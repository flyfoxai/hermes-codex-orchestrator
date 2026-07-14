# Hermes Codex Orchestrator

Hermes Codex Orchestrator 是一个 Runner HTTP API，用来把 Hermes 发来的开发任务写成项目内任务文件，并通过 `tmux` 投递给 Codex CLI。这个 README 提供本地验证、安全启动、项目注册、任务投递和常用查询的最短路径；更完整的部署和 API 细节见文末链接。

## 工作方式

Runner 是 Hermes 和 Codex 之间的本地调度层：

```text
Hermes Bot / Plugin
  |
  | HTTP API
  v
Runner Service
  |
  | task files + tmux
  v
Codex CLI
```

Hermes 负责接收用户命令和调用 API。Runner 负责任务创建、状态管理、日志、`tmux` session 和 Codex 预检。Codex 负责读取项目上下文、执行任务，并把状态和结果回写到任务文件。

## 前置条件

运行前确认这些依赖：

- **Node.js**：`>=20`
- **macOS/Linux**：需要 `tmux` 和可用的 `codex`，才能执行本机 dispatch
- **Windows**：可以运行 HTTP API、注册项目和创建任务，MVP 不支持本机 `tmux` dispatch
- **Runner 实例**：同一个配置根目录只运行一个 Runner

devmac 上可先检查：

```bash
node -v
tmux -V
codex --version
codex login status
```

## 安装和验证

进入仓库后安装依赖并运行完整验证：

```bash
cd /Users/hula/Projects/hermes-codex-orchestrator
npm install
npm run verify
```

`npm run verify` 会运行语法检查、smoke test、HTTP contract test、dispatch failure test、fake Codex dispatch success test 和 hardening test。测试使用临时配置、临时项目和 fake Codex，不会污染真实 `config/projects.json`。

## 创建 API Token

Runner 默认使用 `HCO_AUTH_MODE=token`，并且 fail closed：缺少 `HCO_API_TOKEN` 时会启动失败。把 Token 放在仓库外，并限制权限：

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
```

每次运行受保护命令前，从文件加载 Token：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
```

不要把真实 Token 写入仓库、任务文件、日志、shell 历史、LaunchAgent plist、systemd service 或命令行参数。长期运行时用仓库外 wrapper 脚本读取同一个 Token 文件，模板见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 启动 Runner

加载 Token 后启动服务：

```bash
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
npm start
```

默认监听地址是 `127.0.0.1:8731`。常用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HCO_AUTH_MODE` | `token` | 鉴权模式 |
| `HCO_API_TOKEN` | 无 | Bearer Token，`token` 模式必填 |
| `HCO_HOST` | `127.0.0.1` | 监听地址 |
| `HCO_PORT` | `8731` | 监听端口 |
| `HCO_MAX_BODY_BYTES` | `1048576` | 请求体大小上限，单位是 bytes |
| `HCO_CONFIG` | `config/orchestrator.json` | 主配置文件 |
| `HCO_PROJECTS_CONFIG` | `config/projects.json` | 项目注册配置 |

鉴权规则：

- `HCO_AUTH_MODE=token` 是默认值，所有 API 都需要 `Authorization: Bearer $HCO_API_TOKEN`，包括 `/health`
- `HCO_AUTH_MODE=none` 只允许精确监听 `127.0.0.1` 或 `::1`
- `localhost`、Tailscale、LAN 和公网场景不得使用 `none`
- 鉴权模式只能通过环境变量选择，`orchestrator.json` 里的 `authMode` 字段会被忽略

## 注册项目

Runner 只接受已注册项目的任务。先启动 Runner，再注册项目：

```sh
curl -X POST http://127.0.0.1:8731/projects/stockprofits \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stock Profits",
    "path": "/Users/hula/Projects/stockprofits",
    "allowCodeChanges": true,
    "allowNetwork": true
  }'
```

默认 `tmuxSession` 是 `codex-<projectId>`。如果自动生成的名称太长，在请求体中传入合法短名称。最终名称必须是 1 到 64 个字母、数字、下划线或连字符，首字符必须是字母或数字。

## 创建和投递任务

只创建任务，不投递给 Codex：

```sh
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "检查当前项目进度，确认任务文件链路可用。",
    "constraints": ["先只读检查，不修改代码。"],
    "acceptanceCriteria": ["给出当前阶段和结论。"]
  }'
```

创建任务并立即投递给 Codex：

```sh
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "只读检查当前项目 git 状态和项目规则。",
    "constraints": ["不要修改代码。"],
    "acceptanceCriteria": ["Codex 读取任务文件。", "Codex 回写 Result。"],
    "dispatch": true
  }'
```

投递时 Runner 会预检 Codex CLI，创建或复用项目对应的 `tmux` session，渲染 dispatch prompt，并向 Codex TUI 发送读取任务文件的短指令。Codex 不可用或投递失败时，任务会进入 `failed`。

## 查询任务和运行态

这些接口都需要 Bearer Token：

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/health
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/projects
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks?limit=20"
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/tasks/<taskId>
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/logs"
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/raw"
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
```

任务状态流转：

```text
pending -> queued -> running -> waiting_user -> verifying -> completed
                              -> failed
                              -> cancelled
```

Runner 写入 `pending`、`queued`、`cancelled` 和 dispatch 失败时的 `failed`。Codex 负责回写 `running`、`waiting_user`、`verifying`、`completed` 和详细结果。

## Hermes/Zulip/Feishu Adapter MVP

仓库现在包含一个平台中立的 Adapter MVP，用来验证 Hermes、Zulip、飞书对话到 Runner HTTP API 的核心链路。它还不是生产 Zulip bot、飞书 bot 或 Hermes bot；当前入口是本地 normalized message harness。

先创建仓库外 Adapter 配置和 Token 文件。Token 文件必须在仓库外，权限必须是 `0600`：

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
cp config/adapter.json.example "$HOME/.hco/adapter.json"
```

编辑 `$HOME/.hco/adapter.json`，至少确认：

- `runnerBaseUrl` 指向 Runner，例如 `http://127.0.0.1:8731`
- `runnerTokenFile` 指向仓库外 Token 文件，例如 `/Users/hula/.hco/token`
- `adapterStatePath` 指向仓库外状态文件，例如 `/Users/hula/.hco/adapter-state.json`
- `zulipStreamProjectRoutes` 可选地把 Zulip 频道名映射到已注册的 `projectId`；运行时确认的映射会保存在 `adapterStatePath`

旧配置键 `zulipProjectRoutes` 已废弃并会被拒绝，因为 Zulip topic 现在只表示会话/通知目标，不再参与项目路由。

本地 harness 示例：

```sh
node adapter/index.js --config "$HOME/.hco/adapter.json" --message '{
  "platform": "zulip",
  "stream": "stockprofits",
  "topic": "需求讨论",
  "text": "/codex projects",
  "user": { "id": "u1", "role": "member" },
  "receivedAt": "2026-07-14T12:00:00.000Z"
}'
```

恢复轮询状态：

```sh
node adapter/index.js --config "$HOME/.hco/adapter.json" --recover
```

已支持的命令包括 `/codex projects`、`/codex bind <projectId>`、`/codex route show|set <projectId>|confirm <projectId>|unset|none`、`/codex ask <task>`、`/codex run <task>`（仅 Zulip 从频道推断项目）、`/codex run --project <projectId> <task>`（仅 Zulip 临时跨项目）、`/codex run <projectId> <task>`（飞书、Hermes、harness 通用格式）、`/codex status|logs|raw|cancel|dispatch <taskId>` 和 `/codex sessions`。`raw` 只允许 admin；写任务由 Adapter 侧按项目串行化。

Zulip 专用路由规则：

- Zulip 频道/stream 对应 `projectId`，例如频道 `stockprofits` 可路由到项目 `stockprofits`。
- Zulip topic 对应会话/通知目标，同一个频道下不同 topic 会保留不同回复上下文。
- 如果频道名和项目 ID 不一致，在 `zulipStreamProjectRoutes` 里配置别名，例如 `"hermes-runner": "hermes-codex-orchestrator"`。
- 如果遇到新频道或频道名无法对应项目，Adapter 会先提示人工确认，例如 `/codex route confirm abcd` 或 `/codex route set abcd`，确认前不会创建任务。
- 如果该频道是通用对话、不需要项目，回复 `/codex route none`；之后该频道不会再自动调度 Codex Runner。
- Zulip topic 内不需要 `/codex bind`；如需临时操作其他项目，使用 `/codex run --project <projectId> <task>`。

飞书、Hermes 原生对话和 harness 使用通用路由规则：

- 优先使用命令里的显式 `projectId`。
- 其次使用当前 `conversationId` 通过 `/codex bind <projectId>` 保存的绑定。
- 最后才使用可选 `defaultProjectId`。
- 不使用 Zulip 频道/topic 规则。

当前边界：

- Adapter 不读取源码、不执行 shell、不操作 `tmux`、不直接驱动 Codex。
- 真实 Zulip/Hermes transport 仍是后续集成工作。
- 当前实现未部署，也没有暴露任何新端口。
- 完整对接设计见 [docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md](docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md)。

## 项目内文件

每个任务会在目标项目里生成这些文件：

| 文件 | 用途 |
|---|---|
| `.hermes/tasks/<taskId>.md` | 任务事实源，包含目标、约束、状态和结果 |
| `.hermes/logs/<taskId>.log` | Runner 任务日志，日志会脱敏 |
| `.hermes/dispatch/<taskId>.md` | 渲染后的 Codex 投递 prompt |

任务文件是状态事实源。Runner 使用原子替换、按 taskId 的进程内串行化和有限冲突重试。持续冲突时 API 返回 `409 task_conflict`，不会静默覆盖最新内容。这不是跨进程一致性协议，所以不要让多个 Runner 写同一个配置根目录。

## 运维边界

当前仓库已完成本地可复现验证，但不等于已经完成部署。启用前还需要验证实际运行环境、守护进程、真实 Codex dispatch、网络暴露范围和任务回写链路。

遵守这些边界：

- 一个配置根目录只运行一个 Runner
- Runner 监听 loopback，或通过 Tailscale Serve/受控反向代理从私网转发
- Tailscale/LAN 必须保持 `HCO_AUTH_MODE=token`
- 不要直接把 Runner 端口暴露到公网
- 公网入口必须由 Hermes、Caddy、Nginx 或等价网关提供 TLS、认证、限流、审计和访问控制
- Runner 重启不会停止已有 `tmux` 或 Codex session，重启后用 `/sessions` 和 `tmux ls` 复核

macOS LaunchAgent 和 Linux systemd 的长期运行配置见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 常见问题

### `HCO_API_TOKEN is required when HCO_AUTH_MODE=token`

检查 `~/.hco/token` 是否存在、权限是否为 `0600`，以及当前 shell 或 wrapper 是否正确导出了非空 `HCO_API_TOKEN`。不要把 Token 写进服务定义。

### `tmux dispatch is supported on macOS/Linux only in MVP`

Runner 正在 Windows 上运行。Windows 可用于 API 开发、项目注册和任务创建；实际 dispatch 应部署到 macOS 或 Linux。

### `tmux was not found in PATH`

先确认交互式 shell 可以找到 `tmux`：

```bash
tmux -V
```

如果 Runner 由 launchd 或 systemd 启动，再检查 wrapper 里的 `PATH`。交互式 shell 的 `PATH` 不一定会出现在守护进程环境里。

### Codex 版本不对或找不到

检查 `config/orchestrator.json` 的 `pathEnv`。devmac 推荐让 `$HOME/.npm-global/bin` 排在 `/opt/homebrew/bin` 前面。再运行：

```bash
codex --version
codex login status
```

### Hermes 能创建任务，但 Codex 没有执行

先查询 Runner 视角和 `tmux` 现场：

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
tmux ls
tmux attach -t codex-<projectId>
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/logs"
```

查看后按 `Ctrl-b d` 退出 `tmux`，不要停止任务。如果短指令已经显示但没有提交，可适当增大 `config/orchestrator.json` 里的 `pasteSubmitDelayMs`，重启 Runner 后再验证。

## 主要文档

继续阅读这些文档：

- [docs/SETUP.md](docs/SETUP.md)：安装、Token、配置和项目注册
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：launchd/systemd、运维检查、网络边界和部署验证清单
- [HTTP_API_INTEGRATION.md](HTTP_API_INTEGRATION.md)：Hermes adapter 集成方式和完整 API 参考
- [docs/STATUS.md](docs/STATUS.md)：当前开发状态和下一步
- [docs/reviews/CLAUDE_USER_DOCUMENTATION_DRAFT.md](docs/reviews/CLAUDE_USER_DOCUMENTATION_DRAFT.md)：Claude 候选稿
- [docs/reviews/GEMINI_USER_DOCUMENTATION_DRAFT.md](docs/reviews/GEMINI_USER_DOCUMENTATION_DRAFT.md)：Gemini 候选稿
