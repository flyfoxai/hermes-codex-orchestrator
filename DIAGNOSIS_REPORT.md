# Hermes Codex Bridge 诊断报告

**生成时间**: 2026-07-19  
**诊断人员**: Claude (Kiro AI Assistant)

---

## 执行摘要

通过对 Hermes Gateway 和 HCO (Hermes Codex Orchestrator) 的日志分析，发现了以下核心问题：

### 主要问题
1. **HCO Bridge 请求被拒绝** - 部分对话中 `hco_dispatch` 工具调用失败
2. **HCO 健康检查未授权** - `/health` 端点返回 401 错误
3. **API 速率限制** - iotwq.top 提供商达到并发限制
4. **进程混乱** - 同时运行旧版 Runner 和新版 HCO

---

## 详细分析

### 1. HCO Bridge 请求拒绝问题

**症状**:
```
WARNING agent.tool_executor: Tool hco_dispatch returned error (0.00s): 
{"error": "Codex bridge request rejected."}
```

**发生时间**: 2026-07-19 12:22:34 (会话 20260719_122137_85a36178)

**影响**: 用户请求 "请评估现在项目的进度" 失败，Agent 无法将任务转发到 Codex

**可能原因**:
- HCO 服务接收到请求但拒绝处理
- 认证问题（虽然 Hermes plugin 有正确的 bearer token）
- 路由配置问题
- 项目配置或 ACL 权限问题

### 2. 健康检查未授权问题

**症状**:
```bash
$ curl http://localhost:8731/health
{"error":{"code":"unauthorized","message":"Unauthorized.","details":{}}}
```

**即使使用正确的 Bearer Token 也失败**:
```bash
$ curl -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" http://localhost:8731/health
{"error":{"code":"unauthorized","message":"Unauthorized.","details":{}}}
```

**分析**:
- 端口 8731 上运行的是**旧版 Runner** (PID 20393)，而不是新版 HCO
- Runner 使用不同的认证机制
- 查看 `/health` 路由在 `hco/bridge/server.js` 第 91 行定义为 GET 请求，不需要认证
- 但实际上端口被旧版 Runner 占用，导致请求到达错误的服务

### 3. 进程混乱问题

**当前运行的进程**:

```
PID 20393: node runner/index.js serve (旧版 Runner，占用端口 8731)
PID 35249: /usr/local/bin/node .../hco/index.js (新版 HCO，无法绑定端口)
PID 35459: delivery_sidecar.py (Zulip 投递代理)
```

**问题**: 新旧两个系统同时运行，导致：
- 端口冲突（旧 Runner 占用 8731）
- 新版 HCO 可能无法正常启动或绑定到 socket
- Hermes plugin 可能连接到错误的服务

### 4. API 速率限制

**症状**:
```
ResponseError(code='rate_limit_exceeded', 
message='Concurrency limit exceeded for account, please retry later')
```

**提供商**: https://api.iotwq.top/v1 (gpt-5.5)

**影响**: 
- 某些对话因为速率限制而失败
- 系统有重试机制，但第一次请求会失败

**成功案例**: 
- 会话 20260719_145947 (框架安装) - 成功
- 会话 20260719_175617 (项目进度) - 成功

说明系统在没有速率限制时工作正常。

---

## 根本原因

### 主因: 旧版 Runner 仍在运行

项目已经迁移到 Option C (HCO + Hermes Bridge Plugin)，但旧版 Runner 没有被停止：

1. **旧版 Runner** 在 2026-07-14 19:00:44 启动，占用端口 8731
2. **新版 HCO** 在 2026-07-19 17:06 后启动（从 gateway.log 看到 plugin 加载）
3. HCO 无法绑定到 8731 端口，可能使用了 Unix socket (`/Users/hula/.hco/hco.sock`)
4. Hermes plugin 通过 socket 连接成功，但某些请求仍然失败

### 次因: 间歇性的请求拒绝

即使连接正确，仍然出现 "Codex bridge request rejected" 错误。可能原因：
- 路由解析问题
- ACL 权限检查失败
- 项目配置不匹配
- 临时的资源竞争

---

## 解决方案

### 立即措施 (修复当前问题)

#### 1. 停止旧版 Runner
```bash
kill 20393
```

#### 2. 验证 HCO 服务状态
```bash
# 检查 HCO 进程
ps aux | grep "hco/index.js"

# 检查 socket 是否存在
ls -la /Users/hula/.hco/hco.sock

# 测试 socket 连接（需要工具）
# 或重启整个系统
```

#### 3. 重启 Hermes Gateway
```bash
# 使 Hermes 重新连接到正确的 HCO 服务
hermes gateway restart
# 或
systemctl restart hermes-gateway  # 如果使用 systemd
```

### 短期措施 (防止复发)

#### 1. 在系统启动脚本中禁用旧版 Runner

编辑 `~/.hco/run-hermes-runner.sh` 或删除启动脚本：
```bash
# 备份
mv ~/.hco/run-hermes-runner.sh ~/.hco/run-hermes-runner.sh.disabled

# 或者在脚本开头添加退出
echo "exit 0  # Option C migration: use HCO instead" > ~/.hco/run-hermes-runner.sh.new
cat ~/.hco/run-hermes-runner.sh >> ~/.hco/run-hermes-runner.sh.new
mv ~/.hco/run-hermes-runner.sh.new ~/.hco/run-hermes-runner.sh
```

#### 2. 添加端口冲突检测

在 HCO 启动脚本中添加检测：
```bash
if lsof -i :8731 | grep -q LISTEN; then
  echo "ERROR: Port 8731 already in use. Stopping conflicting process..."
  # 自动停止或报警
fi
```

### 中期措施 (增强可靠性)

#### 1. 调查 "Codex bridge request rejected" 根因

需要查看：
- HCO 的详细日志（如果有日志级别配置，设为 DEBUG）
- 请求被拒绝时的完整 payload
- ACL 权限验证逻辑
- 路由解析过程

建议添加详细日志：
```javascript
// 在 hco/service.js 中添加调试日志
console.log('Bridge request received:', {
  binding,
  command,
  userId: binding.senderId,
  projectId: resolvedProject?.projectId
});
```

#### 2. 实施健康检查监控

```bash
# 创建监控脚本
cat > ~/.hco/healthcheck.sh << 'EOF'
#!/bin/bash
if ! test -S /Users/hula/.hco/hco.sock; then
  echo "ERROR: HCO socket not found"
  exit 1
fi
echo "OK: HCO socket exists"
EOF
chmod +x ~/.hco/healthcheck.sh

# 添加到 cron (每5分钟检查)
# */5 * * * * ~/.hco/healthcheck.sh || notify-send "HCO Health Check Failed"
```

#### 3. 处理 API 速率限制

在 Hermes config.yaml 中配置：
- 启用请求队列
- 添加备用 provider
- 增加重试延迟

```yaml
providers:
  - name: iotwq
    base_url: https://api.iotwq.top/v1
    rate_limit:
      max_concurrent: 2  # 降低并发
      retry_delay_ms: 5000  # 增加重试延迟
  - name: backup
    base_url: https://backup-provider.com/v1
    fallback: true  # 作为备用
```

---

## 测试验证

执行以下步骤验证修复：

### 1. 停止旧 Runner 并重启服务
```bash
kill 20393
sleep 2
hermes gateway restart
```

### 2. 验证 HCO 正常工作
```bash
# 检查 socket
test -S /Users/hula/.hco/hco.sock && echo "Socket OK" || echo "Socket missing"

# 检查进程
ps aux | grep -E "hco|runner" | grep -v grep
```

### 3. 发送测试消息到 Zulip
在 Zulip stream 4 (ASK项目) 的 "general chat" topic 发送：
```
请回复 "收到"，并显示当前 projectId
```

预期响应：
```
收到。当前 projectId: ASK
```

### 4. 测试项目切换
在 stream 5 (量化交易) 发送：
```
当前项目是什么？
```

预期响应：
```
当前 projectId: stockprofits
```

### 5. 监控日志
```bash
# 终端1: 监控 Gateway 日志
tail -f ~/.hermes/logs/gateway.log | grep -E "hco_dispatch|error|rejected"

# 终端2: 监控 Agent 日志
tail -f ~/.hermes/logs/agent.log | grep -E "hco_dispatch|bridge"
```

---

## 长期改进建议

### 1. 进程管理
- 使用 systemd 或 launchd 管理 HCO 服务生命周期
- 添加自动重启策略
- 配置进程互斥（确保只有一个实例）

### 2. 可观测性
- 集成结构化日志（如 pino, winston）
- 添加 Prometheus metrics 端点
- 实施分布式追踪（OpenTelemetry）

### 3. 错误处理
- 为所有 "bridge rejected" 场景添加明确的错误代码
- 在用户消息中提供可操作的错误提示
- 自动诊断和恢复机制

### 4. 文档
- 创建运维手册
- 记录常见问题和解决方案
- 更新 README 包含故障排除章节

---

## 附录：相关文件

### 日志文件
- Gateway 日志: `~/.hermes/logs/gateway.log`
- Agent 日志: `~/.hermes/logs/agent.log`
- Error 日志: `~/.hermes/logs/errors.log`
- Gateway Error 日志: `~/.hermes/logs/gateway.error.log`
- HCO Error 日志: `~/.hco/runner.err.log`
- HCO Output 日志: `~/.hco/runner.out.log`

### 配置文件
- HCO 配置: `~/.hco/hco.json`
- Hermes 配置: `~/.hermes/config.yaml`
- Bearer Token: `~/.hco/hco.bearer`
- 路由快照: `~/.hco/zulip-routes-option-c.json`

### 代码位置
- HCO Service: `/Users/hula/Projects/hermes-codex-orchestrator/hco/service.js`
- Bridge Server: `/Users/hula/Projects/hermes-codex-orchestrator/hco/bridge/server.js`
- Hermes Plugin: `~/.hermes/plugin-releases/hermes-codex-bridge-1.0.0-*/plugin.py`

---

## 总结

**当前状态**: 系统部分工作，但存在间歇性故障

**根本原因**: 旧版 Runner 与新版 HCO 冲突

**风险等级**: 中 - 影响用户体验但有重试机制

**修复优先级**: 高 - 应立即停止旧版 Runner

**预计修复时间**: 5-10 分钟（停止进程 + 重启服务）

**后续工作**: 深入调查请求拒绝的根本原因，需要更详细的日志
