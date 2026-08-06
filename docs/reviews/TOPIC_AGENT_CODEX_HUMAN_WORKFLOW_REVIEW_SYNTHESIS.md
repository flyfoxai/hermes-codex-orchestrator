# 话题级 Agent/Codex 人工工作流审核综合裁决

**日期**：2026-07-28  
**设计文档**：`docs/superpowers/specs/2026-07-28-topic-agent-codex-coordination-design.md`  
**审核来源**：Claude Opus 4.8、Gemini 3.1 Pro Preview

## 1. 最终结论

两份独立审核均为 `APPROVE_WITH_CHANGES`。共同判断是：身份、话题隔离、分层汇报和授权边界方向正确，但初稿对真实人工使用中的审批呈现、长任务反馈、孤儿恢复和资源等待规定不足。

主方案已根据裁决修订。Claude 和 Gemini 复核均确认各自提出的 P0 已关闭且没有新增 P0。设计冻结时，该版本仅作为 Phase 0 协议与人工体验依据，尚未授权直接进入完整实现。此后用户已明确授权开发；当前实施状态和实现级复核见第 7 节。

## 2. 已接受并写回

1. **人工审批卡片合同**：显示任务摘要、来源、准确动作、资源、影响、风险、是否已执行、过期时间和审批角色。
2. **正确审批者解析**：由可信 ApprovalResolver 选择，模型不能指定 approver set；无审批者时进入明确配置等待状态。
3. **Boss 可见反馈**：首次回执、重要事件通知、静默 SLA、合并窗口、重新激活说明和 reply-to 原始消息。
4. **Agent 重新激活质量门**：强制携带纠正指令、上次薄弱点、预期变化和证据引用，达到上限后停止循环。
5. **授权失效级联**：可人工批准的请求由 Jarvis/Agent authority 失效降级为 `HUMAN_REQUIRED`；硬策略禁止仍为 `DENY`。
6. **interaction 超时和重启**：Boss看到超时步骤、实际状态和下一动作；`ANSWER_DELIVERING` 在重启后自动 reconciliation。
7. **孤儿恢复**：Agent 崩溃后上级接收监督恢复通知，而不是直接解释缺少局部上下文的原始 Codex 输出。
8. **并发写入保护**：fencing token、续租、全序一次性获取、有界等待和 owner 停止确认。
9. **Direct Zulip 长输出**：确定性分块或 artifact 降级。
10. **运维可观测性**：只读状态查询、operator target、降级状态和安全 runbook 引用。

## 3. 经修正后接受

### 固定周期心跳

Claude 建议首次 5 分钟、之后每 10 分钟固定通知。直接采用会在长时间无变化时制造噪音。修订为：重要事件立即通知，默认 10 分钟首次静默 SLA、之后默认 30 分钟无变化摘要，并使用 60 秒合并窗口。所有值可由运维配置。

### Agent 崩溃后的结果转移

初稿曾表述为把 mailbox 和 owned call 转给父 Agent；Gemini 指出父 Agent缺少子 Agent局部上下文。修订为只转移监督权：原 activation 标记 `FAILED_ORPHANED`，原始结果保存为 artifact，父节点收到结构化恢复选项。

### 文字回复审批

Claude 建议支持文字回复。为避免同话题并发 interaction 误匹配，修订为只有 reply-to message ID 或显式 token 能唯一定位 interaction，且回答者和内容通过 schema 时才接受；否则必须重新选择。

### 写 lease 超时

Gemini 建议绝对超时后自动失效。仅按时间放锁可能让旧 writer 与新 writer 并发写入。修订为 fenced lease：过期后还必须确认旧 owner 已停止或会被 fencing token 拒绝，才能转让。

## 4. 未接受的建议

### 在运维通知中提供可直接执行的 SQL/命令

未接受。Zulip 只提供脱敏诊断引用和 runbook，不发布 SQL、密钥、敏感路径或会直接改变状态的命令，避免误操作和权限泄露。

### 检测到资源循环后任意终止一个 work request

未按原样接受。方案优先通过 canonical path 全序和禁止持锁等待消除新死锁；历史异常返回确定的 `RESOURCE_DEADLOCK`，由 Jarvis 根据用户目标选择取消、等待或隔离执行，HCO 不猜测哪个业务任务应被牺牲。

### 每次新任务都完整复述其他 active 任务

未按原样接受。为减少噪音，新回执显示 active 数量并通过 reply-to 和短工作引用区分归属；只有存在依赖、资源冲突或时序影响时才详细说明其他任务。

## 5. Phase 0 必须冻结的人工合同

1. 首次回执、阶段性反馈、状态查询和最终答复模板。
2. 审批卡片字段、按钮、文字回复唯一匹配、结算后消息更新。
3. `DIRECT_ZULIP | JARVIS | AGENT` 三类来源的结果和 interaction 路由。
4. ApprovalResolver 角色矩阵、Jarvis/Agent authority envelope 和人工降级规则。
5. Agent inspect/reactivate/cancel/replace 的用户可见行为。
6. 静默 SLA、消息合并、超时、孤儿、状态未验证和运维降级文案。
7. Direct Zulip 分块/artifact 与同一话题多 work request 的 reply 关系。

复核提出的话题改名在途交付、`context_revision` 漂移、多 requester 回执定向、Agent 树折叠展示和 worktree 运维成本也已写回最终方案。

## 6. 审核证据

- `docs/reviews/CLAUDE_TOPIC_AGENT_CODEX_HUMAN_WORKFLOW_REVIEW.md`
- `docs/reviews/GEMINI_TOPIC_AGENT_CODEX_HUMAN_WORKFLOW_REVIEW.md`
- `docs/reviews/TOPIC_AGENT_CODEX_HUMAN_WORKFLOW_REVIEW_REQUEST.md`

两次有效 CLI 调用均返回成功，模型没有修改仓库文件。首次 Gemini 调用返回空响应并报告 `INVALID_STREAM`，未作为审核结论；之后使用文件预加载方式重试成功。

## 7. 实施审计（2026-07-28）

本轮已实现设计中的话题级身份、调用归属、逐级汇报和失败恢复主链路：

1. channel 继续唯一确定项目和 canonical cwd；topic 只创建隔离的 `topic_context_id`，每个 topic 默认一个 Codex conversation，并可按 work/Agent 新建附加 conversation。
2. `DIRECT_ZULIP`、`JARVIS`、`AGENT` 三种调用来源持久化 caller、report target 和 interaction target。Direct Zulip 结果进入原话题 outbox；Jarvis/Agent 结果只进入准确的 durable mailbox，不直接向 Zulip 泄露原始结果。
3. Agent 父子 scope、activation 和 Codex call 都做可信链校验。Agent report 在提交 HCO 前先写入 owner-only 原子 spool，HCO 或 Hermes 重启后可重放；重复 source 只有内容完全一致才视为幂等。
4. mailbox 使用 claim token、租约续期、有界重试和 restart recovery。Agent 不可恢复时以 CAS 标记准确 activation 为 `FAILED_ORPHANED`，通知准确父 Agent；父 Agent 不可用时交给 Jarvis，再失败进入 operator 降级。
5. 普通小型 interaction 作为 `action_prompt` 发送原生按钮。首次有效回答原子结算，并在 prompt 已确认发送后排队删除该 Zulip 消息；重复回答不会再次提交给 Codex。
6. 回答交付结果不确定、连接丢失或 interaction orphan 时，call/work 进入 `STATUS_UNVERIFIED`。系统删除回答 lease、禁止盲目重发，并向 Jarvis/Agent 写 `STATUS_NOTICE`，或向 Direct Zulip 写 durable notice。
7. 新 objective 持久化不可变 project/topic scope。同项目跨 topic 的 continuation/status/cancel 失败关闭；没有新 scope 的 legacy objective 返回 `OBJECTIVE_TOPIC_MIGRATION_REQUIRED`，只能由当前项目 maintainer/admin 在已证明的原 topic 执行 `THREAD_BIND` 显式重链。

实现后再次调用 Claude 和 Gemini 做代码级审核。Claude 提出的 stale activation 重复恢复缺陷有效：旧 `FAILED_ORPHANED` 状态现在必须同时匹配准确 activation，并由 `notification_ledger` 证明原转换；错误 activation 返回 `AGENT_RECOVERY_CONFLICT`。Claude 其余三项与既定合同不冲突：空 Agent summary 允许使用确定性 fallback、空 detail hash 不代表按钮 payload 为空、Agent recovery update 已包含 expected state 条件。

Gemini 提出的“uncertain interaction 后续可能转为 delivered”在当前状态机不可达：记录 `uncertain` 会删除 lease，`uncertain -> delivered` 被拒绝，旧 holder 只能得到 stale lease。没有 App Server 的肯定 reconciliation 证据时，不放宽 `STATUS_UNVERIFIED -> RUNNING`，避免把可能已生效的回答再次发送。

最终自动化结果为 Node `337 passed`、Python `449 passed`、installer `42/42`；`npm run check` 和 `git diff --check` 通过。Hermes 上游文件 `gateway/run.py` 未修改。原生 Zulip 按钮的 PC/Android 呈现和点击后删除仍属于部署后的真实客户端人工验收，不由单元测试替代。
