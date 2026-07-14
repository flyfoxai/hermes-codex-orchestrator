# Hermes Codex Orchestrator

Hermes Codex Orchestrator（以下简称 Runner）是一个 HTTP API 服务，用于接收 Hermes Bot 或其他调用方发来的任务指令，在本机项目目录生成任务文件，并通过 tmux 将任务投递给 Codex CLI 执行。

```text
Hermes Bot / Plugin
  |
  | HTTP API
  v
Runner Service
  |
  | 任务文件 + tmux
  v
Codex CLI
```

Runner 负责任务创建、状态管理、tmux session 调度和 Codex 预检；Codex 负责读取项目上下文、执行代码任务、回写结果。Runner 不直接拼接源码上下文，也不直接运行代码。

## 前置条件

| 依赖 | 要求 |
|---|---|
| Node.js | `>=20` |
| tmux | macOS/Linux，用于 Codex dispatch |
| codex | macOS/Linux，已登录（`codex login status`） |
| Windows | 可使用 API 注册项目和创建任务；MVP 不支持本机 tmux dispatch |

同一个配置根目录只运行一个 Runner 进程。

devmac 推荐确认：

```bash
node -v
tmux -V
codex --version
codex login status
```

## 安装与本地验证

```bash
git clone <repo-url> hermes-codex-orchestrator
cd hermes-codex-orchestrator
npm install
npm run verify
```

`npm run verify` 依次运行语法检查、HTTP 合约、dispatch 和 hardening 回归测试。所有测试均使用临时配置，dispatch 成功测试使用 fake Codex，不会污染真实项目注册配置。

## 安全 Token 工作流

鉴权默认是 fail-closed：未设置 `HCO_AUTH_MODE` 时按 `token` 模式运行，缺少 `HCO_API_TOKEN` 会直接启动失败。

生成 Token：

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
```

Token 文件必须位于仓库外，权限必须为 `0600`。不要把 Token 写入 shell 历史、命令行参数、plist 文件、仓库、任务文件或日志，也不要在终端回显它。

加载 Token：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
```

长期运行（launchd/systemd）时，使用不纳入仓库的 wrapper 脚本读取同一个 Token 文件。详见 [`docs/OPERATIONS.md`](../OPERATIONS.md)。

## 启动 Runner

```bash
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
npm start
```

Runner 默认监听 `127.0.0.1:8731`。

主要环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HCO_AUTH_MODE` | `token` | 鉴权模式（`token` 或 `none`） |
| `HCO_API_TOKEN` | 无，token 模式必填 | Bearer Token，从 `~/.hco/token` 读取 |
| `HCO_HOST` | `127.0.0.1` | 监听地址 |
| `HCO_PORT` | `8731` | 监听端口 |
| `HCO_MAX_BODY_BYTES` | `1048576` | 请求体大小上限 |
| `HCO_CONFIG` | `config/orchestrator.json` | 主配置文件路径 |
| `HCO_PROJECTS_CONFIG` | `config/projects.json` | 项目配置文件路径 |

鉴权模式：

- `HCO_AUTH_MODE=token`（默认）：所有请求必须携带合法 Bearer Token，包括 `/health`。
- `HCO_AUTH_MODE=none`：仅当监听地址精确为 `127.0.0.1` 或 `::1` 时才允许，并会在日志中记录警告。`localhost` 和非 loopback 地址均不允许使用 `none` 模式。Tailscale/LAN 场景不得使用 `none`。

`HCO_AUTH_MODE` 只能由环境变量设置；`config/orchestrator.json` 中的 `authMode` 字段会被忽略。

## 注册项目

Runner 不接受未注册的项目。先启动 Runner 并加载 Token，再注册：

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

`tmuxSession` 自动生成为 `codex-<projectId>`。名称过长时，请在请求体中显式传入合法短名称（1 到 64 位字母、数字、下划线或连字符，首字符须为字母或数字）。

## 创建任务

仅创建（不投递）：

```sh
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
    "constraints": ["先只读检查，不修改代码。"],
    "acceptanceCriteria": ["给出当前阶段和结论。"],
    "allowCodeChanges": false,
    "allowNetwork": true
  }'
```

创建并立即投递给 Codex：

```sh
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "检查当前项目进度，确认 SpecCompass 是否最新版。",
    "constraints": ["先只读检查，不修改代码。"],
    "acceptanceCriteria": ["给出当前阶段和结论。"],
    "dispatch": true
  }'
```

Runner 会预检 Codex CLI，启动或恢复对应 tmux session，将渲染后的 prompt 写入 `.hermes/dispatch/<taskId>.md`，再向 Codex 投递短读取指令。Codex 不可用或投递失败时，任务状态会更新为 `failed`。

## 查询接口

所有请求均需携带 `Authorization: Bearer $HCO_API_TOKEN`。

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/health
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/projects
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks?projectId=stockprofits&status=running&limit=20"
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

Runner 写入 `pending`、`queued`、`cancelled`、dispatch 失败时的 `failed`；Codex 回写 `running`、`waiting_user`、`verifying`、`completed` 及详细结果。

## 生成的项目文件

每个任务会在项目目录下生成以下文件：

| 文件 | 说明 |
|---|---|
| `.hermes/tasks/<taskId>.md` | 任务事实源，包含目标、约束、状态和结果 |
| `.hermes/logs/<taskId>.log` | Runner 操作日志（已脱敏，不含 Token 或 API Key） |
| `.hermes/dispatch/<taskId>.md` | 渲染后的 Codex 投递 prompt |

任务状态以 `.hermes/tasks/<taskId>.md` 为事实源。Runner 使用原子替换和按 taskId 的进程内串行化；持续冲突时 API 返回 `409 task_conflict`，不会静默覆盖内容。

## 运维边界

- 一个配置根目录只运行一个 Runner，不提供跨进程强一致性。
- 不得直接暴露 Runner 端口到公网。公网入口须由 Hermes、Caddy、Nginx 或等价网关提供 TLS、认证、限流和审计。
- Tailscale/LAN 场景优先让 Runner 继续监听 loopback，由 Tailscale Serve 或受控反向代理转发；必须保持 Token 模式，并完成私网健康检查和真实任务回归后再判定可用。
- Runner 重启不会停止 tmux session 或 Codex。重启后用 `/sessions` 和 `tmux ls` 复核，不要重复投递已有任务。
- LaunchAgent（macOS）和 systemd（Linux）配置见 [`docs/OPERATIONS.md`](../OPERATIONS.md)。

## 常见问题

### `HCO_API_TOKEN is required when HCO_AUTH_MODE=token`

默认鉴权已启用。检查 `~/.hco/token` 是否存在、权限是否为 `0600`，以及当前 shell 是否正确导出了 `HCO_API_TOKEN`。不要把 Token 直接写入服务定义或命令行。

### `tmux dispatch is supported on macOS/Linux only in MVP`

Runner 正在 Windows 上运行。Windows 可用于 API 开发和任务创建，但实际 dispatch 应部署到 macOS/Linux 机器。

### `tmux was not found in PATH`

```bash
tmux -V
```

交互式 shell 能找到 tmux 不代表 launchd/systemd 也能找到。检查守护进程 wrapper 中的 `PATH`。

### Codex 版本不对或找不到

确认 `config/orchestrator.json` 的 `pathEnv`。devmac 推荐将 `$HOME/.npm-global/bin` 排在 `/opt/homebrew/bin` 前面。运行 `codex --version` 和 `codex login status` 确认可用。

### Hermes 能创建任务，但 Codex 没有执行

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
tmux ls
tmux attach -t codex-<projectId>
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/logs"
```

查看后按 `Ctrl-b d` 退出 tmux，不要停止任务。若 Codex TUI 中短指令已显示但未提交，可适当增大 `config/orchestrator.json` 中的 `pasteSubmitDelayMs`，重启 Runner 后再验证。若 dispatch 失败，检查任务详情中的 `failureReason` 字段和 `.hermes/dispatch/<taskId>.md`。

### 关闭超时（`shutdown_timeout`）

表示在途连接未在 10 秒内完成，退出码为 `1`。先检查客户端是否卡在上传或响应读取，再检查任务写入、文件系统和外部命令。不要通过缩短超时掩盖持续阻塞。

## 部署验证清单

1. `npm run verify` 通过。
2. Token 为至少 32 个随机字节，文件权限为 `0600`，日志和服务定义中无 Token。
3. 用户级 launchd/systemd 自动启动、健康检查和异常重启已验证。
4. 至少一次真实任务创建、dispatch、Codex 回写和查询成功。
5. Runner 重启后 tmux/Codex session 仍存在，无重复投递任务。
6. 只运行一个 Runner，监听地址和代理暴露范围符合目标部署级别。
7. Tailscale/LAN 另行完成私网调用验证；公网直连始终判定为不支持。

## 文档

- [`docs/SETUP.md`](../SETUP.md)：安装、Token 创建、配置和项目注册详解。
- [`docs/OPERATIONS.md`](../OPERATIONS.md)：守护进程配置（launchd/systemd）、运维检查、网络边界。
- [`HTTP_API_INTEGRATION.md`](../../HTTP_API_INTEGRATION.md)：Hermes 适配器集成方案、完整 API 参考。
- [`docs/STATUS.md`](../STATUS.md)：当前开发状态与下一步计划。
