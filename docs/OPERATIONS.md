# 运维手册

## 运行原则

- 默认使用 `HCO_AUTH_MODE=token`，Token 只从仓库外、权限为 `0600` 的文件读取。
- 一个配置根目录只运行一个 Runner。进程内 mutex 和冲突重试不提供跨 Runner 强一致性。
- Runner 只监听 loopback，或由 Tailscale Serve/受控反向代理从私网转发。
- 不把 Runner 端口直接暴露到公网。

运行受保护的检查命令前，在当前 shell 加载 Token：

```sh
export HCO_API_TOKEN="$(tr -d '\r\n' < "$HOME/.hco/token")"
```

## 常用检查

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/health
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/projects
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks?limit=20"
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/logs"
curl -H "Authorization: Bearer $HCO_API_TOKEN" "http://127.0.0.1:8731/tasks/<taskId>/raw"
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
```

`/health` 也遵守全局鉴权，不提供匿名旁路。

## 优雅关闭

Runner 在 `SIGINT` 或 `SIGTERM` 后停止接受新请求，关闭空闲连接，并最多等待在途请求 10 秒：

- 在途请求完成后退出码为 `0`。
- 超时后强制关闭剩余连接，退出码为 `1`，日志包含 `shutdown_timeout`。
- 重复信号不会启动第二套关闭流程。
- Runner 退出不会自动杀掉项目的 tmux 或 Codex session。

开发调试可在前台按 `Ctrl-C`。长期运行应由 launchd 或 systemd 发送 `SIGTERM`，不要使用 `kill -9`，除非进程已经无法正常关闭。

## devmac launchd

先创建仓库外 wrapper：

```sh
#!/bin/sh
set -eu
umask 077
TOKEN_FILE="$HOME/.hco/token"
[ -r "$TOKEN_FILE" ] || { printf '%s\n' 'missing token file' >&2; exit 1; }
export HCO_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
[ -n "$HCO_API_TOKEN" ] || { printf '%s\n' 'empty token file' >&2; exit 1; }
export HCO_AUTH_MODE="token"
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/hula/Projects/hermes-codex-orchestrator
exec npm start
```

建议路径为 `~/.hco/run-hermes-runner.sh`，并设置：

```sh
chmod 700 "$HOME/.hco/run-hermes-runner.sh"
chmod 600 "$HOME/.hco/token"
```

在 launchd 环境中确认 `npm` 的解析结果。若 PATH 仍不稳定，把 wrapper 最后一行的 `npm` 替换为本机 `command -v npm` 得到的绝对路径。

用户级 LaunchAgent 模板保存到 `~/Library/LaunchAgents/com.hermes.codex-orchestrator.plist`，不要放入仓库：

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

安装、检查和更新：

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hermes.codex-orchestrator.plist"
launchctl print "gui/$(id -u)/com.hermes.codex-orchestrator"
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/health

launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hermes.codex-orchestrator.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hermes.codex-orchestrator.plist"
```

使用用户级 LaunchAgent，不使用 root。plist 中不得出现 Token 或完整环境变量转储。

## Linux systemd 用户服务

Linux 可复用同一 wrapper；将其中项目路径和 PATH 改为实际值。创建仓库外的 `~/.config/systemd/user/hermes-codex-orchestrator.service`：

```ini
[Unit]
Description=Hermes Codex Orchestrator Runner
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/Projects/hermes-codex-orchestrator
ExecStart=%h/.hco/run-hermes-runner.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
KillMode=process
StandardOutput=append:%h/.hco/runner.out.log
StandardError=append:%h/.hco/runner.err.log

[Install]
WantedBy=default.target
```

启用和检查：

```sh
systemctl --user daemon-reload
systemctl --user enable --now hermes-codex-orchestrator.service
systemctl --user status hermes-codex-orchestrator.service
systemctl --user restart hermes-codex-orchestrator.service
```

`KillMode=process` 避免停止 Runner 时由 systemd 清理同一服务 cgroup 中的辅助进程；仍应实测 tmux server 和 Codex session 在重启后继续存在。日志文件和 Token 文件不得向其他用户开放。

## 查看 Codex 执行现场

```bash
tmux ls
tmux attach -t codex-stockprofits
```

退出查看但不停止任务：

```text
Ctrl-b d
```

Runner 重启只影响 HTTP 接入口。已存在的 `codex-<projectId>` session 应继续运行；重启后用 `/sessions` 和 `tmux ls` 复核，不要假定任务已经停止或重新投递。

## 任务状态和一致性边界

任务状态以项目文件为事实源：

```text
<project>/.hermes/tasks/<taskId>.md
<project>/.hermes/logs/<taskId>.log
<project>/.hermes/dispatch/<taskId>.md
```

Runner 使用原子替换、按 taskId 的进程内串行化和有限冲突重试。人工或 Codex 外部修改持续冲突时，API 返回 `409 task_conflict`，不会静默覆盖最新内容。这不是跨进程 CAS，因此不得让多个 Runner 同时写同一配置根目录。

Runner 负责写入 `pending`、`queued`、`cancelled` 和 dispatch 失败时的 `failed`。Codex 执行任务后负责回写 `running`、`waiting_user`、`verifying`、`completed` 或 `failed`。

## 网络边界

### Loopback

推荐保持 `HCO_HOST=127.0.0.1` 和 Token 鉴权。临时使用 `HCO_AUTH_MODE=none` 时只能监听精确的 `127.0.0.1` 或 `::1`。

### Tailscale/LAN

优先让 Runner 继续监听 loopback，由 Tailscale Serve 或受控反向代理转发。必须保持 Token 模式，并在启用前确认远端调用方是否可以看到任务响应中的内部文件路径。完成私网健康检查和真实任务回归后，才能判定私网部署可用。

### 公网

不得直接暴露 Runner。公网入口必须由 Hermes、Caddy、Nginx 或等价网关提供 TLS、认证、限流、审计和访问控制，Runner 保持在受控私网。该架构需要单独评审。

## 常见问题

### `HCO_API_TOKEN is required when HCO_AUTH_MODE=token`

默认鉴权已启用。检查 `~/.hco/token` 是否存在、权限是否为 `0600`，以及 wrapper 是否成功读取非空内容。不要把 Token 直接写入服务定义。

### `tmux dispatch is supported on macOS/Linux only in MVP`

Runner 正在 Windows 上运行。Windows 可用于 API 开发和任务创建，但实际 dispatch 应部署到 macOS/Linux。

### `tmux was not found in PATH`

```bash
tmux -V
```

同时检查守护进程 wrapper 中的 PATH；交互式 shell 能找到 tmux 不代表 launchd/systemd 也能找到。

### Codex 版本不对

确认 `config/orchestrator.json` 的 `pathEnv`。devmac 推荐让 `$HOME/.npm-global/bin` 排在 `/opt/homebrew/bin` 前面。

### Hermes 能创建任务，但 Codex 没有执行

```sh
curl -H "Authorization: Bearer $HCO_API_TOKEN" http://127.0.0.1:8731/sessions
tmux ls
tmux attach -t codex-<projectId>
cat <project>/.hermes/logs/<taskId>.log
```

若短指令已显示但没有提交，可增大 `config/orchestrator.json` 中的 `pasteSubmitDelayMs`，重启 Runner 后再验证。若 dispatch 失败，检查任务详情中的 `failureReason`、`codex --version`、`codex login status` 和 `.hermes/dispatch/<taskId>.md`。

### 关闭超时

出现 `shutdown_timeout` 表示在途连接未在 10 秒内完成。先检查客户端是否卡在上传或响应读取，再检查任务写入、文件系统和外部命令。退出码 `1` 会触发 launchd/systemd 的重启策略；不要通过缩短超时掩盖持续阻塞。

## 部署验证清单

1. `npm run verify` 通过。
2. Token 为至少 32 个随机字节，文件权限为 `0600`，日志和服务定义中无 Token。
3. 用户级 launchd/systemd 自动启动、健康检查和异常重启已验证。
4. 至少一次真实任务创建、dispatch、Codex 回写和查询成功。
5. Runner 重启后 tmux/Codex session 仍存在，且没有重复投递任务。
6. 只运行一个 Runner，监听地址和代理暴露范围符合目标部署级别。
7. Tailscale/LAN 另行完成私网调用验证；公网直连始终判定为不支持。

## Option C Bridge 运维

HCO 和 Zulip send-only delivery 是两个独立的当前用户 LaunchAgent。delivery 停止不会停止 HCO；检查、重启或卸载时使用各自 label：

```sh
DOMAIN="gui/$(id -u)"
HCO_PLIST="$HOME/Library/LaunchAgents/com.hermes.codex-bridge-hco.plist"
DELIVERY_PLIST="$HOME/Library/LaunchAgents/com.hermes.codex-bridge-delivery.plist"

launchctl print "$DOMAIN/com.hermes.codex-bridge-hco"
launchctl print "$DOMAIN/com.hermes.codex-bridge-delivery"

launchctl kickstart -k "$DOMAIN/com.hermes.codex-bridge-hco"
launchctl kickstart -k "$DOMAIN/com.hermes.codex-bridge-delivery"

launchctl bootout "$DOMAIN/com.hermes.codex-bridge-delivery"
launchctl bootstrap "$DOMAIN" "$DELIVERY_PLIST"
```

HCO 必须先于 delivery 可用。需要同时冷启动时，先 bootstrap HCO，确认其 socket 和 `/v1/compatibility` 正常，再 bootstrap delivery。日志默认位于 `~/Library/Application Support/HermesCodexBridge/logs/`，诊断和工单中不得粘贴 bearer、HMAC key、Zulip API key 或完整环境变量。

### 话题协调、interaction 与重启恢复

- channel route 是项目和 canonical cwd 的唯一权威；topic 只隔离上下文。不得通过 topic 文本、Agent 请求或模型输出覆盖 project/cwd。
- Direct Zulip Codex 调用的完成消息进入原 topic outbox。Jarvis 和 Agent 调用的原始结果只进入准确 caller mailbox；由 Agent 报告父 Agent、Agent 报告 Jarvis、Jarvis 汇总给 Boss。
- 普通短 interaction 使用单条 `action_prompt` 原生按钮。回答成功结算后，只有已取得 prompt 的 Zulip message ID 才会排队删除；重复点击不会产生第二次 Codex answer。
- `response_uncertain`、连接丢失和 orphan interaction 都进入 `STATUS_UNVERIFIED`。此状态表示“后端结果无法证明”，不是 `running` 的同义词。系统不会重发回答；Jarvis/Agent 收到 durable `STATUS_NOTICE`，Direct Zulip 收到同 topic durable notice，之后必须以 App Server reconciliation 结果推进。
- Hermes Agent terminal report 先落到 `$HERMES_HOME/hco-agent-report-spool/`，目录要求当前用户所有、非 symlink 且不允许 group/other 权限；记录使用原子 replace 和 fsync。不要手工编辑或复制 spool 文件，同一 source 内容不一致会作为幂等冲突保留并告警。
- Hermes 启动后只扫描启动 cutoff 之前的非终态 Agent activation。恢复使用 CAS 和准确 activation ID；可验证父 Agent时通知父 Agent，否则通知 topic Jarvis，再失败进入 `DEGRADED_PENDING_OPERATOR`。仅恢复订阅或重放相同通知不会直接向 Zulip发送原始 Codex 结果。
- mailbox worker 使用 lease token 和续租。达到有界重试上限、caller session 不可恢复或 scope 不一致时，记录失败原因并走孤儿监督转移；不得直接 ACK 丢弃或跨 topic 唤醒相似 session。

升级前创建、没有 `objective_scopes` 的 legacy objective 不会自动归属当前 topic。continuation/status/cancel 返回 `OBJECTIVE_TOPIC_MIGRATION_REQUIRED`；只有项目 maintainer/admin 可在唯一精确匹配的旧 topic 使用 `/codex thread bind <objectiveId> <threadId>` 建立 scope 并恢复 thread。先核对 durable 历史绑定和 App Server thread，不要按 topic 名称猜测。

查询当前 Codex 源提供的模型和推理深度：

```sh
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  "http://localhost/v1/models?includeHidden=true&limit=100"
```

响应位于 `result.models`。常用字段包括 `id`、`displayName`、`hidden`、`supportedReasoningEfforts`、`defaultReasoningEffort`、`serviceTiers` 和 `isDefault`。`result.cached` 表示来自 HCO TTL 缓存，`result.stale` 表示 Codex App Server 当前不可用但有旧缓存可用，`result.sourceStatus` 为 `unavailable` 时不要据此更新生产配置。首次查询没有缓存且源不可用时，接口返回 `503 MODEL_CATALOG_UNAVAILABLE`，这通常表示 Codex App Server 尚未连接、Codex 登录或账号源不可用。

### Artifact 协议检查

`artifact_manifest` 使用项目配置中的 canonical `cwd` 作为文件根目录。不要直接编辑数据库中的 artifact 状态，也不要把缺失的 input 当作可选输入。required output 未验证通过时，submission 应停在 `reconciliation_needed`，且不应出现最终 outbox delivery；补齐文件后通过正常 completion reconciliation 重试。

可用只读 SQLite 查询检查最近的文件契约：

```sh
sqlite3 -readonly "$HCO_DATABASE_PATH" <<'SQL'
.headers on
.mode column
SELECT submission_id, direction, artifact_id, state, observed_bytes
FROM artifact_contracts
ORDER BY created_at_ms DESC, direction, artifact_id;
SQL
```

状态含义为 `declared`、`verified`、`missing`、`mismatch` 和 `invalid`。诊断时同时检查声明路径所在项目 `cwd`、文件类型、大小和 SHA-256，但不要在工单或聊天中粘贴敏感文件内容。当前 delivery sidecar 只发送 outbox 文本 `content`，不会把 artifact 自动上传到 Zulip；完整协议见 [ARTIFACT_PROTOCOL.md](ARTIFACT_PROTOCOL.md)。

升级使用与首次安装相同的命令重新运行安装器。它先持有每用户锁，完成三层兼容检查，创建完整的不可变版本目录，再原子切换 `plugins/hermes-codex-bridge` symlink。旧 release 在提交前不会删除；遇到非 symlink 的现有插件目录会保留原目录并拒绝安装。

部署变更开始后的失败或信号会触发自动回滚：停止本次启动的 bridge 服务，恢复配置、`.env`、plist、插件 symlink 和原先的服务加载状态。若输出包含 `rollback verification failed`，不要继续启动 delivery；保留现场并按诊断中的非敏感路径人工恢复。

自动回滚只覆盖尚未提交的安装事务。成功提交后的人工降级属于新的运维变更：先卸载 delivery 和 HCO，保存当前配置及 plist，确认目标旧 release 仍是 installer-owned 的完整目录，再切换 stable symlink、恢复与该 release 匹配的配置并依次启动 HCO、验证兼容性、启动 delivery。不要删除未知目录，也不要只切 symlink 后继续使用新配置。

每次安装或升级后执行：

```sh
/bin/bash test/install-hermes-codex-bridge.test.sh
PYTHONDONTWRITEBYTECODE=1 \
  /Users/hula/Projects/hermesAgent/venv/bin/python3 \
  -m pytest -q test/hermes_plugin_contract_test.py
launchctl print "gui/$(id -u)/com.hermes.codex-bridge-hco"
launchctl print "gui/$(id -u)/com.hermes.codex-bridge-delivery"
```

验证默认与 `codex-bridge` profile 仍只暴露 bridge 所需工具，`hermes-general` 在 bridge 两个服务都关闭时仍能用于普通对话，并确认有效 `ZULIP_CONTEXT_DEPTH=0`。

## HCO Fix2 后续强化：部署证据、路由审计与链路诊断

安装器成功提交后会在 installer root 写入 `deployment-manifest.json`。该文件权限应为 `0600`，只包含 release、gateway PID/attestation、服务状态和 route semantic hash；不包含 token、HMAC、CWD、消息正文或 route 配置正文。若 manifest 缺失或状态不是 `COMMITTED`，不要把文件已切换视为部署完成。

本地未映射 route 的脱敏审计写入 Hermes home 下的 `hermes-codex-bridge-route-audit.jsonl`，权限必须为 `0600`，文件不得是 symlink、hardlink 或其他用户所有。按 message ID 查询：

```sh
python3 scripts/query-hermes-route-audit.py \
  --source-message-id 542 \
  --json
```

查询返回 `UNIQUE` 才表示唯一审计命中；`NOT_FOUND`、`AMBIGUOUS`、`UNTRUSTED` 都不能当作审计通过。工具会跳过并计数 NUL 或 malformed 行，不会回显坏行。审计文件达到大小上限时，本地终止决策会 fail closed；本轮不实现复杂后台轮转器，建议在确认路径和 owner-only 权限后采用系统级轮转，并在轮转前保留工单关联。

按 Zulip source message ID 汇总 HCO 只读链路：

```sh
python3 scripts/trace-zulip-message.py \
  --database "$HCO_DATABASE_PATH" \
  --source-message-id 542 \
  --audit-file "$HOME/.hermes/hermes-codex-bridge-route-audit.jsonl" \
  --json
```

该工具以 SQLite read-only URI 打开数据库，只输出层级状态和安全 ID。未映射 route 的预期是 gateway audit 命中、HCO 层无适用业务记录；PROJECT route 应显示 inbound/objective/submission/outbox 的实际停止层；显式 HERMES route 的普通消息归 Hermes，而显式 `/codex` 命令应进入 HCO 并返回 `ROUTE_HERMES_OWNED`，不能用“没有项目 objective”误判为丢消息。

部署后自动冒烟默认只做 preflight/dry-run。只有明确的 `--send` 授权、隔离测试 topic、唯一 RUN_ID、只读 instruction 和 route/PID/attestation 稳定时才允许发送真实 Zulip 消息；`BridgeUncertainError` 不得自动重试。旧 release manifest、临时 staging 目录和测试结果应在确认没有回滚或审计需要后由运维手工清理，禁止脚本按模糊路径批量删除。

只读部署后检查使用：

```sh
python3 scripts/hco-post-deploy-smoke.py \
  --hco-config "$HCO_CONFIG_PATH" \
  --output-json /tmp/hco-post-deploy-smoke.json \
  --output-markdown /tmp/hco-post-deploy-smoke.md
```

该命令不会发送 Zulip 消息，也不会写 HCO 业务数据。它核对 deployment manifest、stable symlink、release hash、gateway attestation/PID、部署时服务状态以及当前 route snapshot 的完整性、时效、generation 和 semantic hash。服务清单是部署提交时证据，实时探测仅覆盖 attested gateway PID；HCO 和 delivery 的实时状态仍以 `launchctl print` 为准。需要检查用例前置条件时可传入 `--unmapped-stream-id`、`--project-stream-id`、`--hermes-stream-id`；缺少显式 HERMES 隔离 stream 会报告 `BLOCKED_PRECONDITION`，不能记为端到端通过。

`scripts/hco-fix2-automated-acceptance.sh` 默认跳过 Zulip API 发送。设置 `HCO_CONFIG_PATH` 后它会先运行上述只读 preflight；只有 preflight 全部通过且获得真实发送授权后才能显式运行 `--send`，否则记录 `BLOCKED_PREFLIGHT_REQUIRED` 并拒绝发送。可用 `HCO_SMOKE_INSTALL_ROOT`、`HCO_SMOKE_STABLE_LINK`、`HCO_SMOKE_ATTESTATION_FILE` 和三类 `HCO_SMOKE_*_STREAM_ID` 环境变量指定经过批准的运行态证据和测试 stream。直接调用 `scripts/hco-fix2-api-acceptance.py` 同样必须提供 `--send`，防止误发。
