# Claude：话题级 Agent/Codex 协作设计审核

**审核日期**：2026-07-28  
**模型**：Claude Opus 4.8  
**设计文档**：`docs/superpowers/specs/2026-07-28-topic-agent-codex-coordination-design.md`  
**说明**：移除 CLI JSON envelope，保留正式审核内容。

## 1. 结论

**APPROVE_WITH_CHANGES**

方案在身份模型、路由矩阵、授权分层和失败矩阵上已达到可开发成熟度。但存在五项 P0 级人工使用缺口：审批消息 Zulip 呈现未定义、后台重新激活期间 Boss 无心跳、孤儿事件通知目标缺失、授权耗尽级联规则未定义、超时后 Boss 可见状态未规定。这些必须在 Phase 0 协议冻结时补全，否则真实用户无法验收。

## 2. 人工旅程评估

### Boss、Jarvis、多 Agent 和 Codex

首次回执和完成条件设计良好，但存在严重沉默期风险。Agent A 很快完成、Agent B 长时间运行时，“可随时发送阶段性反馈”没有触发规则。Jarvis 重新激活 Agent 是内部动作，Boss 可能长时间无反馈，无法区分“正在工作”和“卡死”。Task 2 在 Task 1 运行中提交时，回执也没有规定如何说明并发状态。

### Direct Codex 和人工审批

路由和一次性 token 设计正确，但人工审批者看到的文案、按钮标签、背景说明和过期时间格式均未定义。审批者无法判断“这是谁的任务、风险是什么、为何我是审批者”。若没有可达审批者，interaction 超时后 Boss 和 Jarvis 应看到什么也未说明。

### Agent 审批升级

Agent 使用 `interaction.escalate` 的机制正确，但升级后的 Zulip 消息需要明确呈现来自哪个 Agent、服务于哪个 work request、当前任务处于什么状态。

### 隔离、重启和迟到事件

`topic_context_id` 隔离和拒绝跨话题引用设计正确。写 lease 冲突时 Boss 应看到排队、延迟还是需要决策，仍未定义。审批按钮在 App Server 重启后的有效性也需要明确。迟到结果进入 `ORPHANED_REQUIRES_RECOVERY` 后必须指定通知目标，不能只留下日志。

## 3. P0 必修问题

### P0-1：人工审批消息呈现未指定

**用户可见故障**：审批者只看到技术 ID 和选项，不知道任务来源、风险和过期时间，无法自信决策；文字回复也可能无法匹配原 interaction。

**确定性修改**：新增“人工审批消息渲染合同”，强制包含任务摘要、请求来源、后果说明、过期时间、授权回答者角色和按钮/回复格式。文字回复只有在 schema、回答者和 token 都能唯一匹配时才有效。

### P0-2：后台重新激活期间 Boss 无反馈

**用户可见故障**：Boss 收到首次回执后长时间无消息，误以为系统挂死并重复提交任务。

**确定性修改**：新增进度心跳规则。超过首次静默阈值仍未完成时必须发进度更新；重新激活 Agent 时必须产生 Boss 可见的进度说明。

### P0-3：孤儿恢复通知目标未指定

**用户可见故障**：Agent 崩溃且转移失败，结果进入孤儿状态但无人收到通知，work request 永久不结束。

**确定性修改**：孤儿状态必须向对应 Jarvis session 发结构化告警；Jarvis 不可达时通知项目运维目标；work request 改为 Boss 可见的 `DEGRADED_PENDING_OPERATOR`。

### P0-4：授权耗尽的级联规则未定义

**用户可见故障**：Jarvis 认为已经批准，但 authority envelope 已过期或次数耗尽，HCO 拒绝后 interaction 卡死。

**确定性修改**：本来可由人工批准的请求在 Jarvis envelope 失效时降级为 `HUMAN_REQUIRED`，并向 Jarvis 发送原因；硬策略禁止的请求仍为 `DENY`。

### P0-5：interaction 超时后的 Boss 状态未定义

**用户可见故障**：审批超时后任务消失或仍显示 running，Boss 不知道发生了什么。

**确定性修改**：超时必须通知哪个任务的哪一步超时、任务当前状态以及恢复所需动作。

## 4. P1/P2 改进

- 写冲突时说明等待哪个工作释放什么资源、预计何时再次评估。
- 同一话题存在多个工作时，新工作回执应清楚区分各自归属。
- 明确 interaction token 的跨重启持久化和点击排队机制。
- 达到 Agent 重新激活上限时，返回失败状态、次数和最后结果，而不是继续循环。

## 5. 授权与审批意见

- `policy_revision` 不一致时，审计必须记录旧/新 revision、被阻止动作和责任主体；Boss 看到“策略已更新，需要重新评估”。
- `DelegationPacket` 应携带当前委派深度，便于 HCO 强制检查。
- `DENY` 必须向调用者发送结构化拒绝原因，不能静默。

## 6. Agent 协作与重新激活意见

双 ID 模型清晰。重新激活时，Agent 必须同时收到原始 delegation、上次报告/失败证据和新的纠正要求。达到重新激活上限后必须终止循环并上报。

## 7. 失败恢复与运维意见

- HCO 重启后自动 reconciliation 所有 `ANSWER_DELIVERING` interaction，并记录审计。
- 增加面向 Operator 的只读查询接口，能够查找长期等待人工、孤儿 call 和各状态 work request。
- route/topic/policy 不一致时，把安全的恢复指引发送给 Jarvis 和运维目标；不要只写日志。

## 8. 必须新增的人工验收场景

1. 两个用户先后点击同一按钮，只结算一次。
2. 非授权审批者点击，得到明确拒绝且 Codex 不恢复。
3. interaction token 重放，不产生第二次执行。
4. Jarvis 尝试越过 authority envelope，被 HCO 阻止并升级给正确人工。
5. Agent 等待 Codex 时崩溃，结果进入确定的监督恢复路径。
6. `ANSWER_DELIVERING` 时重启，恢复后回答恰好生效一次。
7. 跨话题使用 Codex call ID，被明确拒绝。
8. 重新激活的 Agent 同时看到原始任务和纠正要求。

## 9. 建议写回方案的确定性规则

1. 定义进度静默阈值、合并策略和重新激活通知。
2. 定义审批卡片的任务摘要、来源、影响、过期、审批角色和回复合同。
3. 定义孤儿事件的 Jarvis、运维和 Boss 可见状态。
4. 定义 Jarvis 授权失效时的人工降级和硬拒绝分界。
5. 定义 interaction 超时通知。
6. 定义 `DENY` 的调用者通知。
7. 定义重启时 `ANSWER_DELIVERING` 的自动 reconciliation。

## 10. 修订后复核

**结论**：原五项 P0 全部关闭，无新增 P0。

复核确认：审批渲染合同、反馈静默 SLA、孤儿通知、授权耗尽降级和 interaction 超时通知均已形成确定性规则。

剩余 P1：

1. 话题改名期间在途 work request 的地址过渡；
2. `context_revision` 漂移的检测和降级；
3. 同话题多 requester 的回执定向。

这些 P1 已在最终方案中继续补充。
