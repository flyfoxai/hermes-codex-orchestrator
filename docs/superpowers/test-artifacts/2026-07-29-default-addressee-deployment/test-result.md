# 2026-07-29 默认收件人部署与测试结果

## 部署结果

- 状态：`COMMITTED`
- 激活 release：`hermes-codex-bridge-1.0.0-18c91b8dc930`
- Gateway PID：从 `73983` 更新为 `14176`
- HCO、Gateway、delivery：部署提交时均为 loaded/running
- `zulip-ingress`：`ZULIP_CONTEXT_DEPTH=0`，`ZULIP_DEFAULT_ADDRESSEE=self`
- Hermes 上游 `gateway/run.py` 未修改

## 自动化结果

结果目录：[automated](automated/)

| 检查 | 结果 |
| --- | --- |
| Python 完整测试集 | PASS，449 项 |
| 自动验收中的 Python plugin contract 子集 | PASS，347 项 |
| Node contract/runtime | PASS，337 项 |
| 安装器事务与回滚矩阵 | PASS，42 项 |
| Python compile、Node syntax、diff check、tracked bytecode | PASS |
| 当前部署 manifest/release/attestation/route smoke | PASS |
| 路由前置条件 | stream 2 unmapped、stream 5 PROJECT、stream 6 HERMES 均 READY |

默认收件人自动矩阵已验证：

1. stream/topic 零 mention 时只向当前默认 bot 合成内部 self mention。
2. 只 mention 一个或多个其他用户/用户组时不追加 Jarvis，并停止进入 Jarvis session。
3. 显式 mention Jarvis，以及 Jarvis 与其他用户同时被 mention 时，消息只进入一次。
4. `@all`/`@everyone` 保持 Zulip wildcard 语义。
5. 私聊继续使用 Zulip 的明确收件人，不套用 stream 默认规则。
6. 原始 message/event 不被原地修改；策略只在 installer-owned `zulip-ingress` 启用。

验收驱动脚本同时修正了两个本机可移植性问题：隔离 PATH 现在包含 `/usr/local/bin`，安装器 fixture 会清除生产 `HCO_CONFIG_PATH`，防止生产配置泄漏到临时测试环境。

## 真实对话自动化边界

本次没有发送真实 Zulip 测试消息，不能把 `PC-00` 记为端到端通过：

- 历史 Chrome MCP `127.0.0.1:12306` 当前未监听。
- 两个现有 `agent-browser` 会话均为 SpecCompass 页面，不包含 Zulip 登录态。
- Playwright 使用默认持久 Chrome profile 时未完成 CLI session 注册，页面停留在 `about:blank`；相关测试进程已正常终止。
- 当前唯一 API 配置属于 Jarvis bot，而 adapter 会忽略 bot 自己的消息，因此没有用 bot API 伪造 Boss 入站。

## 仍需人工执行

优先执行 `PC-00` 五项，并覆盖至少两个频道、两个话题。随后执行 `PC-01` 至 `PC-07`、Android、`NET-01/02` 和 `COORD-01` 至 `COORD-06`。每条消息保存 source/reply message ID、原文、rendered HTML 和对应 Gateway/HCO 记录。

`PC-00` 最小人工消息如下，其中 `<RUN_ID>` 每次替换为唯一值：

```text
请只回复 DEFAULT-JARVIS-<RUN_ID>
```

预期：没有任何 mention 时 Jarvis 回复一次。只 mention 非 Jarvis 用户的两项必须通过 Zulip 候选列表生成原生 mention，并确认 Jarvis 无回复、无新 session；不能只输入普通文本 `@名字`。
