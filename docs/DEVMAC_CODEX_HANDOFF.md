# devmac Codex 开发交接

UpdatedAt: 2026-07-13

## 目标

在 devmac 上继续开发 `Hermes Codex Orchestrator`，把当前 Runner MVP 从“本机 API 验证通过”推进到“远程真实项目可通过 Hermes/HTTP 触发 Codex 执行”。

部署目录：

```text
/Users/hula/Projects/hermes-codex-orchestrator
```

## 当前状态

已完成：

- Node.js Runner HTTP API 初版。
- 项目注册和查询。
- 任务创建、查询、取消。
- 任务日志查询。
- tmux session 查询。
- tmux + Codex dispatch 初版。
- smoke test 使用临时配置，不污染真实 `config/projects.json`。
- 安装、部署、运维文档。

已在 Windows 本地验证：

```bash
npm run check
npm run smoke
```

尚未在 devmac 上完成真实验证：

- `dispatch: true` 是否能启动或复用 tmux session。
- Codex CLI 是否能收到任务 prompt 并读取 `.hermes/tasks/<taskId>.md`。
- Codex 是否能按任务文件回写状态和结果。

## 已确认设计约束

- 使用 Node.js。
- 项目不能写死，必须通过 API 注册和配置。
- Runner 可以部署在 devmac 的 `/Users/hula/Projects/hermes-codex-orchestrator`。
- 设计要考虑 macOS、Linux、Windows；MVP 的 tmux dispatch 只支持 macOS/Linux。
- Hermes 只负责入口、权限、通知和调用 Runner API。
- Codex 负责代码上下文管理，读取项目文件、任务文件和项目规则后执行。
- 项目文件和 `.hermes/tasks/*.md` 是事实源，不依赖 Hermes 聊天上下文。

## devmac 环境线索

此前已确认 devmac 上存在：

```text
node v24.13.0
codex-cli 0.142.3
tmux 3.6a
codex login status: Logged in using an API key
```

注意 Codex 路径选择：

- SSH shell 中稳定版 Codex 曾位于 `/Users/hula/.npm-global/bin/codex`。
- CC Pocket 环境曾优先使用 `/opt/homebrew/bin/codex`，版本可能不同。
- Runner 默认 `pathEnv` 已把 `$HOME/.npm-global/bin` 放在 `/opt/homebrew/bin` 前面。

## 下一步开发任务

### 1. 在 devmac 上做基础验证

进入目录：

```bash
cd /Users/hula/Projects/hermes-codex-orchestrator
npm run check
npm run smoke
```

验收：

- 两个命令都通过。
- `config/projects.json` 没有被 smoke test 写入临时项目。

### 2. 注册真实项目并验证任务文件创建

启动 Runner：

```bash
cd /Users/hula/Projects/hermes-codex-orchestrator
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
npm start
```

另开终端注册项目，例如：

```bash
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

创建但不投递任务：

```bash
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "只读检查项目状态，确认任务文件链路可用。",
    "constraints": ["不要修改代码。"],
    "acceptanceCriteria": ["任务文件已创建。"]
  }'
```

验收：

- 项目目录出现 `.hermes/tasks/<taskId>.md`。
- 项目目录出现 `.hermes/logs/<taskId>.log`。
- `GET /tasks/<taskId>` 能查询任务。
- `GET /tasks/<taskId>/logs` 能查询日志。

### 3. 验证 tmux + Codex dispatch

创建并立即投递：

```bash
curl -X POST http://127.0.0.1:8731/tasks \
  -H "Authorization: Bearer $HCO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "stockprofits",
    "goal": "只读检查当前项目 git 状态和项目规则，最后回写任务结果。",
    "constraints": ["不要修改代码。"],
    "acceptanceCriteria": ["Codex 读取任务文件。", "Codex 回写 Result。"],
    "dispatch": true
  }'
```

查看 session：

```bash
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
tmux ls
tmux attach -t codex-stockprofits
```

验收：

- tmux session `codex-stockprofits` 存在。
- Codex CLI 已在对应项目目录运行。
- Codex 收到 Runner 投递的 prompt。
- 任务文件状态至少能从 `pending` 更新到 `queued`。
- Codex 最终能将任务文件中的 `Status`、`Codex Execution Log`、`Result` 回写。

### 4. 修复 dispatch 实测问题

重点检查：

- `runner/tmux.js` 的 `pasteText()` 在 macOS tmux 3.6a 下是否可靠。
- 新建 tmux session 后 `dispatchDelayMs` 是否足够等待 Codex 启动。
- 如果 Codex 首次启动需要交互确认，Runner 应记录风险，不要静默失败。
- 如果 Codex prompt 进入了 shell 而不是 Codex 输入框，需要调整启动和投递顺序。

可能改进方向：

- 将 dispatch prompt 写入临时文件，再向 Codex 发送“读取此文件”的短命令。
- 增加 `GET /tasks/:taskId/raw`，方便 Hermes 或运维查看完整任务文件。
- 增加 `POST /tasks/:taskId/mark`，允许外部工具安全更新状态。

### 5. 实现 Hermes adapter 前的 API 稳定化

需要确认：

- API 错误格式统一。
- `POST /projects/:projectId` 的参数验证足够清晰。
- `POST /tasks` 的必填参数缺失时返回 400。
- `GET /sessions` 在 tmux 不存在或平台不支持时返回可读错误或 `unsupported_platform`。
- 日志不输出 token、API key、Authorization header。

验收：

- `HTTP_API_INTEGRATION.md` 与实际实现一致。
- `docs/SETUP.md` 和 `docs/OPERATIONS.md` 能按步骤跑通。

## 推荐开发顺序

1. 先跑 `npm run check` 和 `npm run smoke`。
2. 再用真实项目验证非 dispatch 的任务创建链路。
3. 然后验证 dispatch 链路。
4. 发现问题优先修 Runner，不急着写 Hermes adapter。
5. dispatch 链路稳定后，再实现 Hermes adapter。

## 完成标准

本阶段完成时应满足：

- devmac 上 Runner 可长期启动。
- Hermes 或 curl 可通过 HTTP 创建任务。
- Runner 可在真实项目生成 `.hermes/tasks/*.md`。
- Runner 可启动或复用 tmux session。
- Codex 能读取任务文件并执行。
- Codex 能回写任务结果。
- 用户可以通过 API 查询任务状态和日志。

## 不要做的事

- 不要让 Hermes 拼接源码上下文。
- 不要把项目路径写死到代码里。
- 不要直接暴露 Runner API 到公网。
- 不要在日志里输出 API token 或模型 API key。
- 不要为了取消任务直接杀掉整台机器上的 Codex 或 tmux 进程。
