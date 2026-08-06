# Claude 对 HCO 统一交互设计的审查记录

日期：2026-07-26

审查器：Claude Code CLI，`claude-opus-4-8`

结论：`REVISE`

审查方式：通过 `local-ai-cli` 指定的非交互 JSON 调用，只读检查设计与仓库代码。

Claude 首轮读取了主设计、artifact 协议和 HCO/插件关键代码。尝试读取仓库外的 Hermes Gateway zform 参考文件时被 Claude CLI 权限拒绝；该参考实现不是判断 HCO 现状问题的必要条件。第二轮在同一 session 中输出了完整压缩版 findings。

## Findings

### C-1：旧 sidecar 的 capability 精确比较会阻断滚动升级

当前 `check_compatibility()` 要求 `compatibility` 对象与旧客户端期望完全相等。若新 HCO 直接往原字段增加 capability，旧 sidecar 会启动失败，无法按设计降级到 content-only。

修改要求：保留旧 `compatibility` 回显不变，以顶层 `serverCapabilities` 提供可选能力；新客户端再按 required/supported 集合协商。

### C-2：必须补齐 `/codex interact` 的端到端命令路由

当前 plugin parser、HCO `validateCommand` 和 `handleCommand` 都没有 `INTERACT`。如果只实现 zform 出站，按钮点击会变成 invalid command。

修改要求：设计明确 Python parser、bridge command schema、service route 和 immutable action lookup 四个实施点。

### C-3：必须补齐 widget 的真实投递路径

当前 sidecar claim 只读取 `payload.content`，`ZulipSender.send` 也没有 `widget_content` 参数。

修改要求：设计明确 sidecar 读取并验证结构化 `ui`，按 HCO 生成的 interaction/action 信息构造 zform，与正文同一次发送。

### C-4：secret answer 与现有强制 durable answer 冲突

当前唯一 answer 路径先把完整 `answer_json` 写入 SQLite，再响应 App Server；这不满足 secret 只驻留内存的规则，而且 uncertain 后不能从 durable answer 重放。

修改要求：新增独立 secret submission 状态和 `respondSecretInteraction` 路径，不进入普通 settlement；明确 success、explicit failure、uncertain 和重启后的处理。

### C-5：action 必须与 interaction 使用双键绑定

仅按 opaque `actionId` 查询会留下跨 interaction 误用风险。

修改要求：action 表以 `(interaction_id, action_id)` 作为主键/唯一键；settlement 在同一事务内用两个字段查询。

### C-6：详情 ACK 到 actionable 的触发链缺失

初稿要求详情先交付，但未定义现有 outbox ACK 如何推进 interaction detail state、何时创建 action prompt。

修改要求：detail delivery 与 interaction/chunk 建立 durable link；最后一片 ACK 时在同一事务内标记详情 delivered 并创建 action prompt outbox。

### H-1：自然语言 source message 幂等需要明确落表

自然语言入口必须在 durable journal 中以 source type + Zulip message ID 去重，不能只依赖 interaction 已回答后的相同 answer 比较。

修改要求：复用 append-only `event_journal` 的 `(source_type, source_id)` 唯一约束，并在 settlement audit 保存 source identity。

### H-2：核心实现必须删除按 request 顶层扩权字段限制普通 accept 的逻辑

当前 `service.js` 仍使用 `hasExtendedPermissions(interaction.request) || resolved.objectDecision`。这正是本次故障根因。

修改要求：实现时只读取 selected immutable action 的 class；普通 `accept` 不受同请求其他 amendment 选项影响。

### H-3：plugin 需要获得 HCO server capability

plugin 当前没有在注册自然语言别名之前判断 HCO 能力的通路。

修改要求：compatibility 响应提供 `serverCapabilities`；plugin 缓存能力，只在支持时启用 alias 和 `INTERACT`。

### H-4：自然语言零候选与普通对话边界需写死

全局截获“OK”会破坏普通 Hermes 对话，完全放行又会让用户误以为已审批。

修改要求：只在 `CODEX_BOUND` 话题确定性截获精确别名；零候选给明确提示且不二次送模型，Hermes-owned 话题不截获。

### M-1：独立 presentation 表造成冗余双写

detail delivery count、action delivery ID 和 outbox state 可由已有 outbox 与 detail link 表表达。

修改要求：移除 `interaction_presentations`，在 `interaction_details` 保存 action prompt delivery ID，并由 outbox ACK 事务推进。

## Claude 给出的必须修改项

1. capability 滚动升级兼容。
2. `/codex interact` 端到端路由。
3. sidecar 与 Zulip sender 的 widget 投递。
4. secret answer 独立内存路径。
5. action/interaction 双键校验。
6. detail ACK 原子触发 action prompt。
7. 自然语言 source-message 幂等。
8. selected-action 风险分类替代 request-level 限制。
9. plugin 能力发现。

## 处理决定

以上 findings 均纳入设计修订。对 C-4 做一项比审查建议更严格的调整：secret response 进入 uncertain 后不会让用户立即对同一 wire request 重提；HCO 先锁定 interaction 并核对 App Server request 状态。只有能证明原 request 仍 pending 时才允许重新输入，否则等待 App Server 重新发出 interaction 或转安全 UI，避免双响应。
