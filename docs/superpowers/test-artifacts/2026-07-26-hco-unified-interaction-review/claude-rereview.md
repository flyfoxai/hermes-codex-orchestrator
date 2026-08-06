# Claude 对修订版的收口复审

日期：2026-07-26

审查器：Claude Code CLI，`claude-opus-4-8`

结论：`APPROVE`

Claude 在同一审查 session 中重新读取修订后的主设计，并被明确要求只判断设计是否可实施、安全、自洽，不因生产代码尚未实现而重复报错。

## 逐项结论

| Finding | 结果 | 复审理由 |
|---|---|---|
| C-1 legacy capability | RESOLVED | 旧 `compatibility` 对象保持原样，新能力走顶层 `serverCapabilities`，并有旧 sidecar 启动测试 |
| C-2 `/codex interact` | RESOLVED | plugin parser、bridge schema、service route、双键 settlement 四层实施点已明确 |
| C-3 widget delivery | RESOLVED | sidecar 解析结构化 UI，sender 同次发送 `widget_content`，reply 由 ID 构造 |
| C-4 secret answer | RESOLVED | 独立 `respondSecretInteraction`、无值 attempt/outcome、uncertain 锁定和 reconciliation 已定义 |
| C-5 action binding | RESOLVED | 双键 SQL、复合主键和 settlement 校验均已写明 |
| C-6 detail ACK | RESOLVED | 既有 outbox ACK 在同一事务中推进 detail 并创建唯一 action prompt |
| H-1 natural replay | RESOLVED | `event_journal` 保存 outcome，重投返回首次结果，不重新消歧 |
| H-2 selected-action risk | RESOLVED | 明确删除 request-level `hasExtendedPermissions` 限制，改查 immutable action class |
| H-3 plugin capability | RESOLVED | compatibility 提供 `serverCapabilities`，plugin 只在服务端支持时启用新入口 |
| H-4 alias/chat boundary | RESOLVED | 仅 `CODEX_BOUND` 截获，零候选不进模型，其他 topic mode 维持原路由 |
| M-1 presentation state | RESOLVED | 删除冗余 presentation 表，改用 delivery links 和现有 outbox 状态 |
| 补充：document lifecycle | RESOLVED | Zulip retention、远端删除能力和禁止上传 secret 均有明确边界 |

## 新问题扫描

Claude 未发现新 blocker。唯一建议是注明 `event_journal` 是否为现有 schema；主设计已补充说明它是现有表，`source_type` 不需要 enum migration。

Claude 最终原文结论：`APPROVE`。
