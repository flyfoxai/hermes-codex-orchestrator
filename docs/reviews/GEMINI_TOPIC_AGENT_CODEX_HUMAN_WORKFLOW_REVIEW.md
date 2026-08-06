# Gemini：话题级 Agent/Codex 协作设计审核

**审核日期**：2026-07-28  
**模型**：Gemini 3.1 Pro Preview  
**设计文档**：`docs/superpowers/specs/2026-07-28-topic-agent-codex-coordination-design.md`  
**说明**：移除 CLI JSON envelope，保留正式审核内容。

## 1. 结论

**APPROVE_WITH_CHANGES**

方案在架构上严密，身份路由与层级汇报逻辑清晰，能够支持复杂 Agent 协作。但真实人工交互边界仍需补充防误操作规则，尤其是并发审批疲劳、异常降级后的上级处理能力和文件锁等待。

## 2. 人工旅程评估

- **Boss**：首次回执及时，`AgentReport` 能减少碎片信息；但同一话题多个任务结束时，需要清晰指向各自原始要求。
- **人工审批者**：Interaction Broker 提供统一入口；但多个 Agent 同时请求审批时，外观相似的按钮会导致盲批或误点。
- **Jarvis**：可以分发、检查和重新激活；但接收崩溃 Agent 的结果时，需要明确恢复合同，不能直接面对缺少局部上下文的原始 CodexReceipt。
- **Agent**：独立 Agent/Codex 身份和生命周期清楚。
- **Operator**：审计实体充分；但写资源等待、超时和抢占规则仍需明确。

## 3. P0 必修问题

### P0-1：并发审批导致人工盲批

**用户可见故障**：同一话题两个并行工作同时显示“是否允许修改文件”，审批者点错请求，导致错误变更被放行。

**确定性修改**：所有发往 Zulip 的 InteractionRequest 必须包含 WorkBrief 的人类可读摘要、Agent 业务背景、准确资源和影响，不能只显示底层系统选项。

### P0-2：Agent 崩溃后上级收到无法理解的原始结果

**用户可见故障**：Agent B 崩溃，Jarvis 收到缺少 Agent B 局部上下文的 CodexReceipt，既无法完成任务，也无法向 Boss 准确报告。

**确定性修改**：异常监督转移时，把原 activation 标记为 `FAILED_ORPHANED`，原始结果保存为 artifact；父节点只接收结构化恢复通知，并决定重新激活或创建新 Agent，不直接解释原始结果。

### P0-3：写资源等待可能永久静默

**用户可见故障**：Agent A 占用文件写资源并等待 Codex，Agent B 永久等待，Boss 看不到阻塞原因。

**确定性修改**：写 lease 必须有 owner、fencing token、续租和绝对等待上限。检测到超时或循环等待时返回确定的 `RESOURCE_WAIT_TIMEOUT`/`RESOURCE_DEADLOCK`，由 Jarvis 向 Boss 报告并选择取消或重排。

## 4. P1/P2 改进

- 提供只读状态入口，展示当前话题 active work request 和 Agent 树，不只依赖被动通知。
- 每个最终结果 reply 到最初的 Boss Zulip 消息，区分同话题并发任务。
- Direct Zulip 的超长结果应分块或转 artifact，避免刷屏。

## 5. 授权与审批意见

`authority_envelope` 的资源规则必须是 HCO 强校验的白名单。无论 Jarvis 如何决定，硬策略都要阻止过宽通配符、跨项目路径和系统级危险操作，模型没有扩大权限的裁量权。

## 6. Agent 协作与重新激活意见

重新激活不能原样重试。`agent.reactivate` 必须包含 `correction_instruction`、上次失败/薄弱点和 artifact 引用，确保下一 activation 明确改变做法。

## 7. 失败恢复与运维意见

重启恢复应有静默恢复期。恢复订阅本身不向 Zulip 发送噪音，只有实际状态变化、失败或完成时才对外通知。运维查询必须能快速定位阻塞资源、owner、等待时间和下一恢复动作。

## 8. 必须新增的人工验收场景

1. 同一话题两个 Agent 同时申请不同审批，普通用户能清楚区分归属和风险。
2. Agent 等待 Codex 时崩溃；结果到达后 Jarvis 收到结构化失败与恢复选项，而不是原始内容。
3. 两个 Agent 发生资源竞争；系统在可预期时间内返回明确状态并通知 Jarvis。

## 9. 建议写回方案的确定性规则

1. 发往 Zulip 的 Interaction 必须包含 WorkBrief 摘要、Agent escalation reason、资源范围和影响，否则 HCO 拒绝路由。
2. Agent 崩溃后的上级继承是监督权转移，不是要求上级解释原始 Codex 内容；原 activation 进入 `FAILED_ORPHANED`。
3. 文件写 lease 必须采用 fencing token、租约续期和有界等待，不能仅依赖普通超时自动放行。
4. Direct Zulip 输出必须执行长度上限、确定性分块和 artifact 降级。

## 10. 修订后复核

**结论**：原三项 P0 全部关闭，无新增 P0，准许进入实施设计阶段。

复核确认：并发审批可区分、Agent 崩溃只转移监督权、写资源采用 fenced lease 和有界等待。

剩余 P1：

1. 高并发 Agent 树在 Zulip 中的折叠展示；
2. 隔离 worktree 的运行和合并成本。

最终方案已规定折叠状态输出，并将 worktree 保持为项目显式启用的后续能力。
