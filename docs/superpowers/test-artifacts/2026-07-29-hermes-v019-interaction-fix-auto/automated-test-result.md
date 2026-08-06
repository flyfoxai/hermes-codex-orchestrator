# Hermes v0.19.0 交互修复自动验证结果

## 结论

- 执行时间：2026-07-29 12:14-12:22 CST。
- 自动验证：**PASS**。
- 当前 release：`hermes-codex-bridge-1.0.0-e0cc0301a5a7`。
- 本结果不把 PC/Android 按钮视觉和点击体验判为通过；机器上没有可复用的 Boss Zulip 登录态，`~/.zuliprc` 仅属于 Jarvis bot，不能用 bot 自发消息冒充 Boss。

## 修复覆盖

- 项目话题的原请求和 zform 回复使用同一个 `codex-bridge` Hermes session key。
- native clarify 的 zform `short_name` 使用选项原文，不再显示 `1/2/3`。
- 首次回答只结算一次，第二次回答不能重复结算；prompt 删除回调只执行一次。
- `/codex` 从触发消息解析完整命令，允许任务 ID 后跟多行自然语言。
- status 回复前查询 App Server 并归约 call/work；无法唯一对应或后端无法确认时使用 `STATUS_UNVERIFIED`，不猜成 running。
- App Server 完成通知在同一 store 事务中更新 turn、Codex call、work/mailbox，并按 submission 的 call identity 归属。
- `WORK_REQUEST_TOPIC_MISMATCH` 在 bridge 映射为 HTTP 409，而不是 400、500 或通用 protocol error。
- 启动恢复只查询非终态 call，不重新提交或重放 Codex 工作。

## 自动测试

| 检查 | 结果 |
|---|---|
| Node 全量测试 | PASS，345 tests |
| Python plugin/delivery/diagnostic/smoke 测试 | PASS，453 tests |
| Hermes upstream clarify/Zulip 测试 | PASS，270 tests |
| 安装器隔离、回滚和升级测试 | PASS，42 cases |
| `npm run verify` | PASS |
| `git diff --check` | PASS |
| post-deploy smoke | PASS，12 checks |
| 同一 Boss 消息两次 service dispatch | PASS，一个 work、两个不同 call/objective |
| completed/failed/unverified status 归约 | PASS |
| 同 objective 多 active call 的 completion 归属 | PASS，不猜第一条 call |
| Jarvis/Agent durable mailbox 与父级汇报合同 | PASS |

post-deploy smoke 的结构化证据位于同目录的 `post-deploy-smoke.json` 和 `post-deploy-smoke.md`。

## 部署范围

安装器只替换了默认 `~/.hermes` 这一组 launchd 服务：

| 服务 | 部署前 PID | 部署后 PID |
|---|---:|---:|
| HCO | 14160 | 8920 |
| Zulip ingress Gateway | 14176 | 8992 |
| delivery sidecar | 14228 | 9048 |

另外两个 Hermes Gateway PID `1525` 和 `1533` 在部署前后保持不变，未被操作。

## 真实运行时探针

使用当前 Unix socket、签名上下文和真实 HCO 数据执行了两个请求；没有记录 bearer 或 context key：

1. 在原话题查询当前 work：返回 `action=work.status`、`workState=WAITING_CODEX`、`nextAction=wait_for_codex`、`activeCalls=1`。
2. 在话题 B 查询话题 A 的 work：返回用户错误 `WORK_REQUEST_TOPIC_MISMATCH`。

这证明已部署版本不再返回 `Codex bridge protocol error`，并且跨话题 status 使用明确 scope mismatch。启动恢复后 call 汇总为：`COMPLETED=2`、`FAILED=2`、`RUNNING=1`、`STATUS_UNVERIFIED=1`；旧 call 不再全部机械保留为 running。

## 仍需人工复测

- PC-01：按钮显示“选项 A / 选项 B / 取消”，而不是 `1/2/3`。
- PC-02：首次点击后确认一次，原 zform prompt 删除。
- PC-03：两个标签竞态点击只结算一次。
- PC-04：取消后 prompt 删除且不继续。
- PC-05：Web UI 发送带尾随中文的 `/codex status`。
- PC-06：选择一个已知后端终态，核对回复不是过期 running。
- Android：按钮显示、点击、刷新和 PC/Android 交叉消费。
- NET-01：弱网重试；需要故障注入授权。

NET-02 的服务重启恢复已由本次真实部署和自动启动恢复覆盖后端部分，但 pending clarify 的客户端体验仍建议在维护窗口人工验证。
