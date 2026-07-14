# Hermes Codex Orchestrator 完善工作文档

**状态**：双引擎详细度审核后冻结版  
**更新时间**：2026-07-13  
**适用版本**：当前 `0.1.0` Runner MVP  
**文档用途**：作为下一阶段加固、测试和部署工作的唯一执行依据

## 1. 目标与边界

本阶段的目标是把当前已经通过本机验证的 Runner MVP，加固到可以在 devmac 上长期运行，并可通过 loopback 或 Tailscale 私网供 Hermes 调用。本计划以 Node.js 20 或更高版本为运行时前提；若未来要支持 Node.js 18，必须另行定义 `closeIdleConnections`/`closeAllConnections` 不可用时的兼容路径并新增测试。

本阶段不把 Runner 变成公网服务，也不引入数据库、分布式锁或完整的多租户平台能力。公网场景应由 Hermes 或独立网关负责认证、TLS、限流和外部 API 暴露，Runner 保持在本机或私网内。

任务 Markdown 文件仍然是任务事实源。Runner、Codex 和人工都可能读取或编辑它，因此任何写入方案都必须优先保护已有内容，不得用数据库替换任务文件。

## 2. 当前事实基线

当前实现和验证状态如下：

- HTTP 服务入口在 `runner/http.js`，默认监听 `127.0.0.1:8731`。
- 任务文件和日志由 `runner/task-store.js` 管理，保存在项目的 `.hermes/` 目录。
- tmux 和 Codex 投递由 `runner/tmux.js`、`runner/codex.js` 管理。
- 配置和项目注册由 `runner/config.js` 管理。
- `npm run verify` 已通过，包含语法、smoke、API contract、dispatch 失败和 fake Codex 成功路径。
- 真实 devmac Runner 已验证可在 loopback 上监听，带 Token 的 `/health` 返回 200，错误 Token 返回 401。
- 当前项目目录没有可用的 `.git` 元数据。实施本计划前，必须建立可回滚的版本基线或外部备份。

## 3. 部署分级

### A. devmac loopback MVP

允许 Runner 监听 `127.0.0.1` 或 `::1`。默认仍要求 Token；只有明确设置 `HCO_AUTH_MODE=none` 时才允许关闭鉴权，且关闭鉴权时必须保持 loopback 监听并记录警告。

### B. Tailscale 或局域网

推荐 Runner 继续监听 loopback，由 Tailscale Serve 或受控反向代理转发。若必须监听非 loopback 地址，则必须配置强 Token，不允许 `HCO_AUTH_MODE=none`。不允许直接把端口暴露到互联网。

### C. 公网生产

当前阶段不支持直接部署。公网入口必须是 Hermes 或网关，至少提供 HTTPS、认证、限流、审计和访问控制；Runner 只接受来自受信任网关或私网的请求。

## 4. 必须实现的加固项

### 4.1 请求体大小限制

**涉及文件**：`runner/http.js`、`runner/config.js`

新增 `HCO_MAX_BODY_BYTES`，默认值为 `1048576`（1 MiB）。配置值必须在启动时校验为 `1` 至 `16777216`（16 MiB）的整数；空值、非整数、零、负数或超出范围时以 `invalid_config` 启动失败。

该限制只约束 `readJsonBody` 读取的传入 HTTP 请求体，不限制响应体。`GET /tasks/:taskId/raw`、任务列表和日志查询即使返回内容大于 `HCO_MAX_BODY_BYTES`，也不得因此被截断或返回 413。

`readJsonBody` 必须同时处理两种情况：

1. 请求带有 `Content-Length` 且超过上限时，尽早拒绝。
2. chunked 请求没有可靠长度时，在读取过程中累计字节数，超过上限后停止累积。

客户端在读取过程中主动断开时，必须把请求标记为 aborted，避免在已关闭的连接上继续发送 500 响应；该情况只写日志，不伪装成服务端故障。

Node.js 20 的实现合同冻结如下：在开始异步读取请求体前注册请求关闭观察；`close` 发生时只有 `!req.complete` 才判定为中途断开，正常完成的请求不得误判。异步迭代读取抛错后，如果请求已销毁且尚未完整接收，则转换为内部 `request_aborted` 结果。该结果不得进入路由处理，也不得调用 `sendJson`；服务端只写一条 `warn` 级结构化日志，`code` 为 `request_aborted`。监听器必须在 `finally` 中清理。通用错误处理器在写响应前还必须检查 `res.destroyed`、`res.writableEnded` 和 `res.headersSent`，避免在关闭或已完成的响应上二次写入。

超限响应合同：

- HTTP 状态码为 `413`。
- 错误码为 `payload_too_large`。
- 响应设置 `Connection: close`，避免复用已超限连接。
- 不应在发送 JSON 413 之前无条件销毁 socket；若需要关闭连接，应在响应完成后关闭。

推荐实现顺序是：先检查 `Content-Length`，再在流式读取中计数；流式计数无论 `Content-Length` 是否存在都必须执行，以覆盖错误或恶意的长度声明。超限后停止累积并让路由层发送 413。若请求流已经 aborted，则不发送响应。该实现不要求引入 HTTP 框架或额外运行依赖。

请求体为空或在限制内时，现有 JSON 校验和 API 状态码保持不变。正常任务创建仍返回现有的 `201`，不改为 `202`。

### 4.2 鉴权必须默认 fail-closed

**涉及文件**：`runner/http.js`、`runner/config.js`、`runner/index.js`、`docs/SETUP.md`、`docs/OPERATIONS.md`

新增 `HCO_AUTH_MODE`，默认值为 `token`：

- `token`：`HCO_API_TOKEN` 必须存在，否则启动失败，错误码为 `invalid_config`。
- `none`：仅允许监听精确的 loopback 地址 `127.0.0.1` 或 `::1`，并输出明确的 warning。非 loopback 配置下启动失败；`localhost` 不视为安全例外，避免 DNS 解析到非 loopback 地址。
- 未知模式必须启动失败，不得静默降级。

启动失败应通过抛出配置错误交给 CLI 入口处理，不在可复用的 HTTP 模块内直接调用 `process.exit()`。loopback 检查必须针对 `loadOrchestratorConfig()` 返回的最终合并 host 执行，覆盖配置文件和环境变量的所有来源；未设置 `HCO_HOST` 时，最终默认值必须明确为 `127.0.0.1`。

请求鉴权行为：

- 缺少或错误的 `Authorization: Bearer <token>` 返回 `401` 和 `unauthorized`。
- 可增加 `WWW-Authenticate: Bearer`，不改变现有 JSON 错误格式。
- Token 比较先分别计算输入值和期望值的 SHA-256 摘要，再对两个固定长度的摘要调用 `crypto.timingSafeEqual`。不得先比较原始 Token 长度后提前返回，也不得把不同长度的 Buffer 直接传给 `timingSafeEqual`。
- Token 不得写入项目配置、任务文件、日志或错误响应。

文档中的命令统一使用环境变量，例如 `-H "Authorization: Bearer $HCO_API_TOKEN"`，不得继续使用可复制到生产环境的 `change-me` 作为真实凭证。

`docs/SETUP.md` 必须给出不回显 Token 的生成和安装命令。推荐生成 32 个随机字节的十六进制值：

```sh
install -d -m 700 "$HOME/.hco"
umask 077
openssl rand -hex 32 > "$HOME/.hco/token"
chmod 600 "$HOME/.hco/token"
```

文档还必须说明：不要把 Token 放入 shell 历史、命令行参数、plist、仓库或日志；Runner wrapper 从该文件读取并导出 `HCO_API_TOKEN`。

### 4.3 任务文件原子写入和并发保护

**涉及文件**：`runner/task-store.js`

`writeTaskFile` 改为：在目标文件同一目录创建唯一临时文件，完整写入并关闭后，再通过 `rename` 原子替换目标文件。临时文件必须在成功和失败路径清理。不要把临时文件放到系统临时目录，以免跨文件系统 `rename` 失效。

Runner 进程内增加按 `taskId` 的异步 mutex。`updateTaskStatus` 等修改操作必须在锁内重新读取最新文件，而不能使用锁外的旧快照。所有调用路径都必须使用这一套共享实现，包括 `POST /tasks/:taskId/cancel`、dispatch 成功后的 `queued` 更新和 dispatch 失败后的 `failed` 更新；调用方不得另建锁、绕过锁或复制一套重试逻辑。

本阶段不引入第三方 mutex 包。使用 `Map<taskId, Promise>` 实现零依赖的串行队列，并在队列完成后删除无用键。该 mutex 只协调同一个 Runner 进程内的操作，不声称能锁住 Codex 或人工编辑器。

为了处理 Codex 或人工直接编辑造成的外部并发，锁内写入前还必须进行内容版本检查：

- 读取并保存当前文件完整 UTF-8 内容的 SHA-256 哈希作为版本信息。
- 写入前重新读取并确认版本未变；如已变化，基于最新内容重新应用本次状态变更。
- 本阶段的状态变更必须表达为字段级 patch：调用方明确提供的 `status`、`resultSummary`、`failureReason` 或 `cancellationReason` 等字段覆盖最新内容中的对应字段；未出现在 patch 中的字段和未知 metadata 字段必须保留。每次尝试都在读取并解析最新文件后生成一个新的 `updatedAt`，同一次尝试的 metadata 和 Markdown body 必须共用该值；冲突后重试时重新生成，以使最终时间表示成功应用状态变更的时间。文件解析失败或 patch 无法合并时直接返回 `409 task_conflict`。
- 最多重试 3 次，每次冲突后等待 20ms；第 4 次仍冲突时返回 `409 task_conflict`，不得静默覆盖外部修改。

任务文件中的 `status` 和 `updatedAt` 有两份表示：metadata JSON 块，以及 Markdown body 的 `Status:` 和 `UpdatedAt:` 行。每次首次尝试和冲突重试都必须从最新完整文件重新解析 `{ metadata, body }`，先把声明的 patch 合并到最新 metadata，再用同一次尝试的 `status`、`updatedAt` 更新最新 body 中对应的两行，最后原子写入。其他 body 内容和未知 metadata 字段必须逐字保留。若任一必需 body 行缺失、metadata 分隔符损坏或文件无法解析，本阶段统一返回 `409 task_conflict`，不得只更新其中一份表示或自行补造结构。

并发顺序验证使用内部、可选、仅测试的应用观察器。观察器在原子 `rename` 成功后、释放 task mutex 前被调用，接收 `{ sequence, taskId, status, updatedAt }`；`sequence` 在该临界区内单调递增。观察器不得持久化到任务文件、不得出现在 HTTP 响应，也不得再次调用 task-store 或尝试获取同一 mutex。生产调用不提供观察器，运行行为不受影响。

这套方案能防止单 Runner 内部交错写入，并通过乐观检测降低外部编辑覆盖风险；它不是严格的跨进程 CAS，在版本检查和 `rename` 之间仍存在无法消除的竞态。因此本阶段明确只支持单个 Runner 进程管理一个配置根目录。未来若需要更强一致性，应增加由 Runner 统一执行状态变更的 `POST /tasks/:taskId/mark` 接口，并让 Codex 通过该接口更新状态。

`createTask` 必须与状态更新共用按 `taskId` 的 mutex，并在锁内检查目标文件是否已存在。自定义或生成的 `taskId` 已存在时都返回明确的 `409 task_exists`，不得覆盖已有任务文件；该保证覆盖同一 Runner 内的并发创建，跨进程创建仍受前述单 Runner 边界限制。

### 4.4 tmux session 竞态和名称校验

**涉及文件**：`runner/tmux.js`、`runner/config.js`

`ensureSession` 不再先执行 `hasSession` 再执行 `new-session`。应直接尝试创建：

- 创建成功返回 `true`。
- 失败且 stderr 在去除首尾空白后精确匹配已支持的 tmux duplicate-session 模板（至少覆盖 `duplicate session: <name>` 和 `session '<name>' already exists`，且 `<name>` 必须等于目标 session），再复查确认目标 session 已存在时，返回 `false`。实现应把匹配模板集中在一个可测试函数中；遇到未识别的 tmux 版本错误文本时不得猜测为重复，应继续抛错并记录 stderr。
- 其他错误继续抛出，不能把 tmux 不可用、权限错误或工作目录错误伪装成“session 已存在”。

项目注册时校验 `tmuxSession`：

```text
^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$
```

该正则表示总长度为 1 至 64。必须在 `normalizeProject()` 选定最终值之后统一校验：显式传入值按原值校验；自动生成的 `${tmuxPrefix}-${projectId}` 按拼接后的完整值校验。最终值超过 64 字符时返回 `400 invalid_request`，`details.field` 为 `tmuxSession`，并提示调用方提供合法的显式 session 名。不得静默截断或自动哈希，因为这会引入难以发现的目标冲突。测试边界为：显式 64 字符成功、65 字符失败，以及自动生成超过 64 字符时失败。

当前使用 `execFile` 参数数组而非 shell，严格校验主要用于保证跨平台和 tmux 目标解析稳定性，而不是替代 shell 注入防护。

### 4.5 优雅关闭和进程守护

**涉及文件**：`runner/index.js`、`docs/OPERATIONS.md`

在 CLI 入口处理 SIGINT 和 SIGTERM，且信号处理必须幂等：

1. 停止接受新请求。
2. 调用 `server.close()` 等待在途请求完成。
3. 默认等待 10 秒。
4. 立即调用 `server.closeIdleConnections()`（Node 20 可用）释放空闲连接。
5. 在途请求于超时前完成时以状态码 0 退出；10 秒超时后调用 `server.closeAllConnections()`，并以状态码 1 退出。

Runner 退出时不得自动杀掉项目的 tmux 或 Codex session。这个边界必须写入运维文档。

devmac 使用 launchd 进行长期守护；Linux 使用 systemd。守护配置必须提供自动重启、标准输出/错误日志路径、工作目录和安全的 Token 注入方式。不得把 Token 放进仓库文件。

devmac 的最小可执行方案是一个不纳入仓库的 wrapper：读取权限为 0600 的 `~/.hco/token`，设置 `HCO_API_TOKEN` 后 `exec npm start`。LaunchAgent 只调用该 wrapper，避免在 plist 中提交真实 Token。模板至少包含以下字段，实际用户路径必须替换：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>com.hermes.codex-orchestrator</string>
<key>ProgramArguments</key>
<array><string>/Users/hula/.hco/run-hermes-runner.sh</string></array>
<key>WorkingDirectory</key>
<string>/Users/hula/Projects/hermes-codex-orchestrator</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/Users/hula/.hco/runner.out.log</string>
<key>StandardErrorPath</key><string>/Users/hula/.hco/runner.err.log</string>
</dict>
</plist>
```

wrapper 的最小内容如下；实际安装时必须替换项目路径，并确认 `npm` 的绝对路径或 `PATH` 与交互式 shell 一致：

```sh
#!/bin/sh
set -eu
umask 077
TOKEN_FILE="$HOME/.hco/token"
[ -r "$TOKEN_FILE" ] || { printf '%s\n' 'missing token file' >&2; exit 1; }
export HCO_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
[ -n "$HCO_API_TOKEN" ] || { printf '%s\n' 'empty token file' >&2; exit 1; }
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/hula/Projects/hermes-codex-orchestrator
exec npm start
```

安装和验证应使用用户级 LaunchAgent（不使用 root）：将 plist 保存到 `~/Library/LaunchAgents/com.hermes.codex-orchestrator.plist`，确保 wrapper 和 Token 文件归运行用户所有且 Token 文件权限为 0600，然后执行 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hermes.codex-orchestrator.plist`。更新配置时先执行对应的 `launchctl bootout`，再重新 bootstrap；用 `launchctl print gui/$(id -u)/com.hermes.codex-orchestrator` 和受保护的 `/health` 请求确认服务状态。Token 不得出现在 plist、命令行参数、仓库或日志中。

wrapper 和 Token 文件必须由运行用户拥有，Token 文件权限为 0600，日志中不得打印环境变量。

## 5. 错误、路径和运维接口

意外的 5xx 错误对外只返回稳定的 `internal_error` 和通用消息，原始错误、绝对路径和底层命令输出只进入脱敏日志。

当前任务元数据中的 `projectPath`、`taskFile`、`logFile` 和 `dispatchPromptFile` 对受信任的 Hermes 本地调用方有诊断价值；当前 `taskSummary` 已暴露 `taskFile` 和 `dispatchPromptFile`，但不直接暴露 `projectPath`、`logFile`。本阶段不得为了公网兼容新增这些内部路径字段；在启用 Tailscale 或其他非本机客户端访问前，应先确认调用方可信，若边界扩大则必须增加隐藏内部路径的公开 DTO。

`/health` 继续遵守全局鉴权，不新增匿名旁路。运维探针使用 Token 环境变量；如未来网关需要匿名存活探针，应由网关提供独立探针，不改变 Runner API。

TLS 和限流不在 Runner 内重复实现：

- loopback：不需要 TLS。
- Tailscale：优先使用 Tailscale 的加密通道和 Serve 转发。
- 公网：由 Hermes/Caddy/Nginx 等受控边界终结 TLS、执行限流和访问审计，禁止直接转发到裸 Runner 端口。

## 6. 实施顺序

### Phase 0：可回滚基线

- 建立 Git 提交或等价备份。
- 若仓库仍无 `.git`，在仓库外创建带时间戳的完整备份（至少包含 `runner/`、`config/`、`templates/`、`scripts/`、`docs/`、`package.json` 和 lockfile，如存在），记录备份绝对路径与 SHA-256 校验值，并完成一次可读性/恢复性检查。
- 记录当前 `npm run verify` 输出。
- 确认 `config/projects.json` 仅包含预期项目。

### Phase 1：安全和输入基线

- 实现 Token fail-closed、显式 loopback 无鉴权模式和安全比较。
- 实现请求体上限及 `413` 合同。
- 更新 `SETUP.md`、`OPERATIONS.md` 中的 Token 使用方式。

### Phase 2：文件和 tmux 可靠性

- 实现任务文件原子写和单进程 mutex。
- 实现版本检查、有限重试和 `409 task_conflict`。
- 自定义 taskId 冲突返回 `409`。
- 修复 tmux 创建竞态和 session 名称校验。

### Phase 3：生命周期和错误边界

- 实现优雅关闭。
- 对非预期 5xx 做统一脱敏。
- 增加 launchd 运维说明。

### Phase 4：部署验证

- 在 loopback 运行完整测试和真实 Codex dispatch。
- 通过 Tailscale Serve 做一次私网调用验证。
- 确认 Runner 端口未直接暴露到公网。

## 7. 必须新增的测试门禁

新增 `scripts/hardening-test.js`，并纳入 `npm run verify`：

- 请求体恰好等于上限时成功，超过上限时返回 `413 payload_too_large`；覆盖 `Content-Length` 和 chunked 请求，并覆盖 `HCO_MAX_BODY_BYTES` 的无效配置值。
- `HCO_MAX_BODY_BYTES` 不限制响应体；大于该值的 `GET /tasks/:taskId/raw` 仍完整返回 200。
- 客户端上传中断测试必须使用原始 TCP socket：发送完整请求头和部分 body 后主动销毁连接；确认没有 500、没有未处理的 promise rejection、没有路由副作用，并且只产生 `request_aborted` 警告。另用正常完整请求确认不会误记 aborted。
- 未设置 Token 时，token 模式启动失败；loopback 显式 none 模式成功；非 loopback none 模式失败。
- 正确 Token 返回 200，错误或缺失 Token 返回 401，日志不含 Token。
- 同一 taskId 触发至少 10 次不同状态的并发更新，记录每次成功、409 和其他失败结果；测试通过内部应用观察器记录临界区分配的单调递增序号。最终文件必须可解析、metadata 块完整，metadata/body 的 `status` 与 `updatedAt` 必须相等，并与序号最大的成功观察记录一致；序号不得写入文件或 API。
- 模拟外部编辑后再更新状态，确认未知 metadata 字段和非状态 body 文本在成功重试后仍逐字保留，且成功重试的 `updatedAt` 来自成功尝试；持续制造冲突时，取消和其他状态更新都在重试耗尽后返回 409，最新外部内容不被覆盖。
- 自定义 taskId 顺序和并发重复创建都返回 409，现有文件内容保持不变。
- 并发调用 `ensureSession`，最多创建一个 session，duplicate session 不被报告为 dispatch 失败。
- 非法 `tmuxSession` 在项目注册阶段返回 400；覆盖显式长度 64/65 的边界和自动生成值超过 64 字符的情况，确认没有静默截断。
- SIGTERM 测试必须用 `child_process.fork()` 或 `spawn()` 启动独立 Runner 子进程；在存在在途请求时向子进程发送 SIGTERM，确认请求完成、子进程在正常路径退出，并单独覆盖超时强制退出路径。
- 非预期 500 不返回绝对项目路径或底层堆栈。
- 现有 `npm run verify`、真实 dispatch 成功路径和 Windows API-only 路径保持通过。

## 8. 完成标准和部署门禁

### Loopback MVP 可以部署的条件

- Phase 0 至 Phase 3 完成，并完成 Phase 4 中的 loopback 验证项。
- `npm run verify` 通过，新增 hardening 测试通过。
- Token 已替换为至少 32 个随机字节生成的 base64url 或十六进制值，或明确使用 loopback-only 的 `HCO_AUTH_MODE=none`。
- devmac 由用户级 launchd 守护，Linux 由 systemd 守护；tmux 只用于临时验证，不满足长期部署门禁。
- 至少一次真实任务创建、dispatch、Codex 回写和查询回归成功。

### Tailscale/LAN 可以部署的条件

- Loopback 条件全部满足。
- Phase 4 中的 Tailscale Serve 或等价私网调用验证已完成。
- Runner 未使用 `HCO_AUTH_MODE=none`。
- 任务并发冲突测试通过，且明确只有一个 Runner 进程写入该配置根目录。

### 公网部署判定

在 Runner 直接暴露公网端口的方案下，判定为不可部署。只有 Hermes/网关完成 TLS、认证、限流、审计和回滚设计，并且 Runner 仍处于受控私网时，才进入单独的公网架构评审。

## 9. 明确不在本阶段实现的内容

- 取消任务时强制杀掉 Codex 或 tmux 进程。
- 数据库迁移或分布式任务锁。
- Runner 内置完整 HTTPS、用户系统和复杂限流算法。
- 通过 Hermes 聊天上下文传递源码，而不是通过项目文件和任务文件传递事实。
- 为兼容公网而删除当前可信本地 API 中的所有内部路径字段。

## 10. 审核记录和冻结结论

本文件的初稿和关键设计已由本机 Claude CLI（`claude-opus-4-8[1m]`）和 Gemini CLI（`gemini-3.1-pro-preview`）分别审核；主开发代理根据审核结论修订后，又对照当前代码完成最终复核。已采纳的关键意见包括：

- 固定长度 SHA-256 摘要后再使用 `timingSafeEqual`，避免不同长度 Buffer 抛错。
- 明确零依赖 mutex、SHA-256 内容版本、字段级冲突重放、3 次重试和 20ms 等待；同时保留“非严格跨进程 CAS”的边界。
- 明确流式字节计数始终启用、上传中断处理和 `413 payload_too_large` 响应顺序。
- 明确 tmux duplicate-session 的匹配模板和复查条件，其他错误不得吞掉。
- 明确 Node.js 20 基线、SIGTERM 子进程测试、`closeIdleConnections()`、10 秒超时和 `closeAllConnections()`。
- 补齐用户级 LaunchAgent、wrapper、Token 文件权限和部署验证门禁。
- 修正当前任务元数据与 `taskSummary` 的实际路径字段边界，并明确扩大访问边界前的 DTO 要求。
- 明确 `HCO_MAX_BODY_BYTES` 只限制请求体，不限制 raw、列表或日志响应，并增加大响应回归测试。
- 冻结 Node.js 20 下上传中断的判定、日志、无响应和监听器清理合同，并指定原始 TCP 测试。
- 统一取消、dispatch 成功和 dispatch 失败等状态变更到同一 taskId mutex 与冲突重放路径。
- 明确每次重试从最新 metadata 和 body 双重重放，成功尝试内两份 `status`/`updatedAt` 必须一致，其他内容必须保留。
- 冻结测试专用应用观察器，不把应用序号持久化或暴露到生产 API。
- 明确最终 `tmuxSession` 在规范化后按 64 字符上限校验，超长自动生成值返回 400，不静默截断。

本轮详细度审核的独立中转文件为 `docs/reviews/CLAUDE_IMPROVEMENT_PLAN_REVIEW.md` 和 `docs/reviews/GEMINI_IMPROVEMENT_PLAN_REVIEW.md`。两家结论均为 `READY_WITH_REQUIRED_ADDITIONS`；上述阻断歧义已在本版中冻结，因此本文件现在可以作为开发输入，但仍不代表实现或部署门禁已经完成。

对审核意见的最终裁决如下：

- 采纳 Gemini 关于每次冲突重试刷新 `updatedAt` 的意见，拒绝“整个逻辑操作固定首次时间戳”。原因是该字段表示最终修改时间；外部编辑已发生后继续写入首次尝试时间会造成时间回退。同一次尝试内 metadata/body 必须使用同一值。
- 采纳 Claude 对最终 session 名、请求中断、body 双重表示和应用序号观察器的阻断判断；保留计划原定的 64 字符上限，不采用 Claude 原始答复中不一致的 63 字符变体。
- 暂不采纳重试 jitter、HTTP ETag/If-Match、全面 JSON Schema、数据库或分布式锁。这些内容不会解决当前单 Runner 阶段的阻断问题，且会扩大 API 或运行时范围。

审核结论只确认本文件可以作为下一阶段实施基线，不代表第 4 至第 8 节中的代码、测试或部署门禁已经完成。下一阶段若改变鉴权模式、并发模型、部署边界、错误合同或任务文件事实源，必须先更新本文件并重新执行双引擎审核。
