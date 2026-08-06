# HCO 统一交互机制实施报告

日期：2026-07-26

结论：核心链路已实施，全量自动化测试通过。

## 已实施

- migration v8 `unified_interaction_exchange`：immutable actions、detail delivery links、detail state 和 settlement audit。
- migration v9 `interaction_delivery_link_hardening`：数据库层保证每个 interaction 最多一个 action prompt。
- action 级审批：普通 `accept` 不再被同请求中的 network/exec policy 选项连带阻断。
- 复杂 decision：聊天侧只传 `(interactionId, actionId)`，HCO 从 immutable action row 还原 canonical answer。
- 长详情：按 UTF-8 bytes 分片；超过 16 片时生成带 bytes/SHA-256 的 Markdown document；详情 ACK 前 action prompt 不可领取。
- Zulip zform：sidecar 根据受限 `ui` 和 action IDs 构造 `widget_content`；不接受 outbox 提供任意 widget JSON。
- 文本入口：支持 `/codex interact`、旧 `/codex approve`、`/codex answer`。
- 自然语言入口：在 `CODEX_BOUND` 话题精确识别“同意/可以/批准/确认执行/OK/yes”及明确拒绝词；零候选和多候选均不猜测。
- 原子结算：自然语言候选选择、immutable answer settlement、settlement audit 和 source event journal 在同一 SQLite `IMMEDIATE` 事务内完成。
- response lease：App Server response 发送前领取单持有者 lease；并发回答只发送一次，过期 lease 转为 `uncertain`，不自动盲目重放；lease 过期或 orphan 后的晚到持有者按 durable state 稳定收敛，不再抛状态异常。
- orphan cleanup：显式 orphan 和 connection loss 都在同一事务中清理对应的 `interaction_response` lease。
- 询问：单题选项可点击，文本和多题继续使用 durable partial answers。
- secret：不向 Zulip 输出问题正文或回答入口，只允许 App Server UI。
- compatibility：旧 `compatibility` 对象保持不变，新能力通过顶层 `serverCapabilities` 发布。

## 验证结果

- JavaScript 全量：314 passed。
- Python 全量（Hermes venv）：416 passed。
- Installer：42 passed；测试脚本 TAP plan 已同步为 `1..42`。
- `npm run verify`：passed。
- `git diff --check`：passed。
- Claude Opus 4.8 聚焦复查：候选问题经状态迁移证据复核后全部撤回（`RETRACTED_ALL`），无剩余重要 finding。

重点覆盖了长命令完整性、Unicode/Markdown fence、详情 ACK 门控、document hash、复杂 decision 防篡改、zform 构造、widget 不支持降级、自然语言消歧与原子结算、并发 response 单发送、过期 lease 不重放、mid-flight lease 过期/orphan/断线竞态、v8 到 v9 migration、跨重启 interaction 和旧客户端兼容。

## 保留边界

- owner-local secret input page 尚未启用，secret 继续在 App Server UI 完成。
- interaction document 使用 durable outbox 保存到投递完成；独立 spool、审计期 GC 和 Zulip 远端删除策略后续增强。
- Zulip message POST 成功但 ACK 前进程退出仍可能产生可见重复消息；稳定 interaction/action ID 和 immutable settlement 防止重复执行。
