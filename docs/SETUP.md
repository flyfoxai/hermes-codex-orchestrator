# 安装与部署准备

## 目标和边界

Runner 部署在真正执行代码的机器上，例如 devmac：

```text
/Users/hula/Projects/hermes-codex-orchestrator
```

Hermes 通过 HTTP API 调用 Runner，Runner 再通过项目任务文件、tmux 和 Codex CLI 执行任务。当前版本适用于 loopback 或受控 Tailscale 私网，不支持把 Runner 端口直接暴露到公网。

## 前置条件

- Node.js 20 或更高版本。
- macOS/Linux 安装 `tmux`，并能运行 `codex`。
- Windows 可以运行 HTTP API、注册项目和创建任务；MVP 不支持本机 tmux dispatch。
- 同一个配置根目录只运行一个 Runner 进程。

devmac 推荐确认：

```bash
node -v
tmux -V
codex --version
codex login status
```

## 安装和本地验证

```bash
cd /Users/hula/Projects
git clone <repo-url> hermes-codex-orchestrator
cd /Users/hula/Projects/hermes-codex-orchestrator
npm install
npm run verify
```

当前 MVP 没有第三方运行依赖。`npm run verify` 包含语法、HTTP 合约、dispatch 和 hardening 回归测试，均使用临时配置。

## 创建 API Token

鉴权默认是 fail-closed：未设置 `HCO_AUTH_MODE` 时按 `token` 模式运行，缺少 `HCO_API_TOKEN` 会直接启动失败。

使用 32 个随机字节生成 Token，并把它保存在仓库外：

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
```

Token 文件必须归 Runner 的运行用户所有，权限必须为 `0600`。不要把 Token 放入 shell 历史、命令行参数、plist、仓库、任务文件或日志，也不要在终端回显它。

前台调试时从文件读取：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
[ -n "$HCO_API_TOKEN" ] || { printf '%s\n' 'empty token file' >&2; exit 1; }
npm start
```

长期运行时使用不纳入仓库的 wrapper 读取同一个 Token 文件，具体模板和守护配置见 `docs/OPERATIONS.md`。

## Runner 配置

主配置文件是 `config/orchestrator.json`。默认关键配置：

```json
{
  "host": "127.0.0.1",
  "port": 8731,
  "codexPath": "codex",
  "pathEnv": "$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  "dispatchDelayMs": 1500,
  "pasteSubmitDelayMs": 150
}
```

`dispatchDelayMs` 用于等待 Codex TUI 启动；`pasteSubmitDelayMs` 用于在 tmux 粘贴短指令后稍等再发送回车。机器较慢或偶发未提交时，可以适当增大这两个值。

支持的环境变量：

```sh
export HCO_AUTH_MODE="token"
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
export HCO_HOST="127.0.0.1"
export HCO_PORT="8731"
export HCO_MAX_BODY_BYTES="1048576"
export HCO_CONFIG="/Users/hula/Projects/hermes-codex-orchestrator/config/orchestrator.json"
export HCO_PROJECTS_CONFIG="/Users/hula/Projects/hermes-codex-orchestrator/config/projects.json"
```

- `HCO_AUTH_MODE=token` 是默认值，必须提供非空 Token。
- `HCO_AUTH_MODE=none` 只允许精确监听 `127.0.0.1` 或 `::1`，并会记录警告；`localhost` 和非 loopback 地址均不允许。
- 鉴权模式只能由环境变量 `HCO_AUTH_MODE` 选择；`orchestrator.json` 中的 `authMode` 字段会被忽略，不能通过配置文件关闭鉴权。
- `HCO_MAX_BODY_BYTES` 默认 1 MiB，必须是 `1` 至 `16777216` 的整数，只限制请求体，不截断 raw、列表或日志响应。
- `HCO_PORT` 必须是 `1` 至 `65535` 的整数。

除仅限本机、明确接受无鉴权风险的临时调试外，保持 `token` 模式。Tailscale/LAN 场景不得使用 `none`。

## 注册项目

先在当前 shell 安全加载 Token，再调用 API：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"

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

最终 `tmuxSession` 必须为 1 至 64 个字母、数字、下划线或连字符，且首字符必须是字母或数字。自动生成的名称过长时，应显式提供合法的短名称。

## 创建并投递任务

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

Runner 会在项目目录创建：

```text
.hermes/tasks/<taskId>.md
.hermes/logs/<taskId>.log
.hermes/dispatch/<taskId>.md
```

`tasks` 是任务事实源，`logs` 是 Runner 日志，`dispatch` 保存渲染后的 Codex 投递提示。Runner 会先执行 Codex `--version` 预检，再将短读取指令投递到项目对应的 tmux session。

## 部署前门禁

仓库内验证命令：

```bash
npm run verify
```

这只证明本地可复现的代码门禁通过。正式启用前还必须按 `docs/OPERATIONS.md` 完成用户级进程守护、真实 Codex 创建/投递/回写/查询回归，并确认网络暴露范围。Tailscale 私网还需要单独完成 Serve 或等价代理验证；公网直连 Runner 不在支持范围内。

## Option C：Hermes Codex Bridge

Option C 是 macOS 当前用户级安装路径。它不会修改 Hermes 源码，也不会修改 Hermes 生成的 `ai.hermes.gateway.plist`。安装器会创建版本化的独立插件、受限的默认及 `codex-bridge` profile、普通对话用的 `hermes-general` profile，以及两个互相独立的 LaunchAgent。

准备仓库外的 HCO 配置、bearer、上下文 HMAC key 和 Zulip 配置。可从 `config/hco.json.example` 开始；所有路径必须为绝对路径。HCO JSON、bearer、HMAC key 和 Zulip 配置必须由当前用户拥有，是非空普通文件，且没有 group/other 权限：

```sh
chmod 600 "$HOME/.hco/hco.json" \
  "$HOME/.hco/bridge.bearer" \
  "$HOME/.hco/context.key" \
  "$HOME/.zuliprc"
```

真实安装会在第一次部署变更前检查三层兼容性：配置中 Unix socket 上的 HCO bridge protocol、当前安装的 Hermes，以及 `codex app-server --stdio`。因此第一次安装时，也必须先用同一份 `HCO_CONFIG_PATH` 临时启动当前仓库的 HCO，使兼容性 endpoint 可用；安装提交后由 LaunchAgent 接管。

先执行严格 dry-run。它不读取 secret 内容、不创建锁或临时文件，也不启动子进程；需要运行时的三层检查会明确标为 deferred：

```sh
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex)"

./scripts/install-hermes-codex-bridge.sh \
  --dry-run \
  --hco-config "$HOME/.hco/hco.json" \
  --zulip-config "$HOME/.zuliprc" \
  --node-bin "$NODE_BIN" \
  --codex-bin "$CODEX_BIN"
```

确认计划后去掉 `--dry-run`。如果现有 Hermes 环境的有效 `ZULIP_CONTEXT_DEPTH` 不是 `0`，安装器会拒绝修改；审核影响后显式追加 `--authorize-context-depth-zero`，安装器会事务性地保留其他 `.env` 行并把该值规范为单一的 `0`。

成功后检查：

```sh
launchctl print "gui/$(id -u)/com.hermes.codex-bridge-hco"
launchctl print "gui/$(id -u)/com.hermes.codex-bridge-delivery"
readlink "$HERMES_HOME/plugins/hermes-codex-bridge"
```

不要把 bearer、HMAC key 或 Zulip API key 放进命令行、plist 或 Hermes `.env`。`.env` 中只保存 `HCO_CONFIG_PATH` 文件路径。
