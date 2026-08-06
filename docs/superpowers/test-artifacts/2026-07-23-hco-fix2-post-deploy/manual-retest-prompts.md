# HCO Fix2 部署后人工复测提示词

**编制日期**：2026-07-23  
**部署状态**：已安装工作区修复版，等待人工 Zulip 复测  
**已激活 release**：`hermes-codex-bridge-1.0.0-82229c0d0376`  
**适用 Gateway**：`ai.hermes.gateway`，2026-07-23 10:45:32 +0800 后启动的实例

## 1. 重要前提

1. Zulip stream 消息默认要求 mention。每条入站测试必须在 Zulip 编辑器中从候选列表选择真正的 **@Jarvis PM** mention。
2. 不要只键入普通文本 `@Jarvis PM`；发送后应能看到 Zulip mention 的特殊样式。
3. 使用新的 `RUN_ID`，不要重用消息 `502`、`505`、`507` 的旧测试 ID。
4. 不重启 Gateway，不修改 route snapshot、topic mode、ACL、项目映射或 `require_mention` 配置。
5. 本轮只执行无副作用的错误路径和状态查询，不创建真实 Codex objective。

建议 RUN_ID：

```text
HCO-FIX2-POSTDEPLOY-20260723-<HHMMSS>
```

建议两个频道使用相同的新 topic：

```text
hco-fix2-postdeploy-20260723-<HHMMSS>
```

## 2. 测试 P-00：Gateway 入站烟雾测试

**频道**：`量化交易stockProfits`  
**目的**：先证明 mention gate、Zulip event queue 和 Gateway 入站链路正常。

复制以下正文，并将开头替换为 Zulip UI 生成的真实 mention：

```text
@Jarvis PM 请只回复：HCO-FIX2-POSTDEPLOY-20260723-<HHMMSS>-P00
```

预期：

- 产生 Hermes/Jarvis 回复。
- Gateway 日志出现对应 `inbound message: platform=zulip`。
- 若这一项失败，停止后续测试，记录入站和回复 message ID，并标记整轮 `BLOCKED`。

## 3. 测试 G-01：Hermes-owned stream 路由拒绝

**频道**：`沙箱`  
**目的**：验证受限频道命令进入插件后返回稳定的 `ROUTE_HERMES_OWNED` 用户错误，且不创建 objective。

复制以下正文，并将开头替换为真实 mention，同时替换 RUN_ID：

```text
@Jarvis PM /codex run HCO-FIX2-POSTDEPLOY-20260723-<HHMMSS>-G01 no-op
```

预期：

- Gateway 有该消息的 inbound 记录。
- Zulip 收到用户可理解的 Hermes-owned route 错误。
- 错误分类为 `ROUTE_HERMES_OWNED`，而不是 `Codex bridge protocol error.`。
- 不创建 objective、submission 或 Codex turn。
- 回复中不包含 bearer、HMAC、API key、socket 路径或堆栈。

失败条件：

- 没有回复且 Gateway 无 inbound：优先检查发送内容是否使用真实 mention。
- 进入普通模型对话、创建 objective、返回 protocol error 或泄露内部信息：标记 `FAIL`。

## 4. 测试 G-05：正常项目频道只读状态查询

**频道**：`量化交易stockProfits`  
**目的**：验证合法项目 route、CLI token 解析和不存在 objective 的用户错误路径。

复制以下正文，并将开头替换为真实 mention，同时替换 RUN_ID：

```text
@Jarvis PM /codex status HCO-FIX2-POSTDEPLOY-20260723-<HHMMSS>-G05-does-not-exist
```

预期：

- Gateway 有该消息的 inbound 记录。
- HCO 收到该 source message ID。
- Zulip 快速返回 objective 不存在的稳定用户错误，预期错误分类为 `OBJECTIVE_NOT_FOUND` 或当前协议对应的 Python 用户错误。
- 不创建新 objective、submission 或 Codex turn。
- 不返回 `Codex bridge protocol error.`。
- 回复经过 Markdown 安全处理，不产生异常链接、mention 或多段结构。

## 5. 测试 G-06：正常标识符与 Markdown 防护

**频道**：`量化交易stockProfits`  
**目的**：验证错误回显不会破坏正常标识符；只在已有无副作用的用户错误路径上执行。

```text
@Jarvis PM /codex status obj-1-LIVE-POSTFIX.S-001-does-not-exist
```

预期：

- 回复保持单行。
- `obj-1` 和 `LIVE-POSTFIX.S-001` 不被插入多余反斜杠，不发生 Markdown 强调或链接渲染。
- 错误仍按用户错误返回，不变成 protocol error。
- 不创建 objective。

## 6. 可选负对照 N-01：无 mention 消息

只有在需要确认 mention gate 行为时执行。发送到新 topic，且不要使用真实 mention：

```text
/codex status HCO-FIX2-POSTDEPLOY-20260723-<HHMMSS>-N01-does-not-exist
```

预期：

- Gateway 不产生业务 inbound 日志。
- HCO 不记录该 source message ID。
- 不产生回复。
- 该结果属于配置预期，不应判定为 poller 故障。

## 7. 每个用例必须保存的证据

记录以下字段：

| 字段 | 要求 |
|---|---|
| RUN_ID | 完整记录，不复用旧 ID |
| stream/topic | 记录名称和 stream ID |
| 入站 message ID | Zulip UI 或 API 返回的数字 ID |
| 回复 message ID | 无回复时写 `NONE` |
| mention | 记录是否为 Zulip 真实 mention |
| Gateway | 是否存在对应 inbound 日志 |
| HCO | 是否存在对应 source message ID |
| objective 数量变化 | 执行前后应为 0 |
| raw content | 保存脱敏后的 API 原文 |
| rendered HTML | 检查链接、强调、mention、换行注入 |
| 结果 | `PASS`、`FAIL` 或 `BLOCKED` |

敏感字段必须写成 `***MASKED***`，不要保存 API key、bearer、HMAC key、cookie 或完整环境文件。

## 8. 整轮通过标准

- P-00、G-01、G-05 必须全部通过。
- G-06 建议通过后再关闭 Fix2 验收。
- G-01/G-05/G-06 均不得创建 objective。
- 不得出现重复回复、跨频道回复、普通模型兜底或未知 protocol error。
- 如果消息没有使用真实 mention，该用例无效，必须使用新 RUN_ID 重发，不能把无回复归因于 Gateway poller。

## 9. 结果记录位置

执行完毕后，将结果写入同目录：

```text
docs/superpowers/test-artifacts/2026-07-23-hco-fix2-post-deploy/manual-retest-result.md
```

建议按 P-00、G-01、G-05、G-06、N-01 的顺序记录，并附上脱敏后的 API 回读和时间戳。
