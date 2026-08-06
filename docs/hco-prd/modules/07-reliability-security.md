# 07 可靠性、安全与观测

详细请求和事务字段见 [`../contracts/03-state-transactions.md`](../contracts/03-state-transactions.md)；本模块规定跨模块的最小恢复和安全不变量。

## 幂等与事务

| 操作 | 唯一身份 |
| --- | --- |
| 创建普通 work | Hermes request key + invocation receipt + continuation/project/scope/manifest digest |
| 创建恢复 work | parent work + caused event + continuation decision |
| 启动 turn | work + start command revision |
| 接收 App Server 事件 | backend + thread + turn + item + type + remote revision + event fact digest |
| 向 Hermes 交接事件 | event ID + event fact + continuation binding + request key |
| 回答 interaction | remote interaction + Hermes native receipt + reply key |
| 取消 | work + cancel command revision |
| Hermes 接收事件 | event ID + event fact + origin invocation receipt + continuation binding |

同一幂等身份携带不同 payload digest 必须冲突。HCO 先持久化远端命令意图，再调用 App Server；中间崩溃进入 reconciliation，不猜测是否执行成功。远端不支持 command idempotency 时不承诺恰好一次，只承诺不盲目重发。

## 重试与恢复

基础设施重连、事件补交、去重和对账由软件完成，不调用模型、不创建新 work。换方法、补上下文或再次执行属于 Hermes 模型决定的语义恢复，创建新 `RECOVER` work，并带 `parent_work_request_id`、`caused_by_event_id`、`continuation_decision_id`。

HCO 通过 root lineage `BudgetEnvelope` 强制最大恢复 work、Codex turn、累计时间和可用 Codex token/费用；恢复 work 使用唯一 debit key 预留、结算或释放，多个 Agent/fork 不能重复获得预算。Hermes 单独按 Bridge policy 限制 continuation 模型调用次数和时间，不把 Hermes 模型账本复制到 HCO。`UNKNOWN/RECONCILING`、权限扩大、不可逆操作或任一侧预算耗尽时不得自动重试。

HCO 重启后恢复 binding、work、interaction、文档、未确认命令和未交接事件。Hermes 不可用时，事件留在 `codex_events`；取得 acceptance 后由 Hermes 处理，不转成 HCO 用户消息 outbox。

## 安全边界

- Hermes 是身份和审批权威；模型参数不能覆盖 scope、引用、权限或目录。
- `invocation_ref`、`continuation_ref` 和 interaction receipt 都是敏感值，日志、指标和普通审计只保存 keyed digest。需要重放未交接事件的 `continuation_ref` 原值在 work/event 中以 ciphertext、key ID、nonce 和 work/event associated data 加密保存，支持密钥轮换；旧解密 key 必须保留到引用和事件保留期结束。其他引用默认只保存最小 receipt 和摘要。解密失败进入 `TARGET_UNDELIVERABLE` 和运维告警，日志不得记录 token、密钥、凭据或敏感文档原文。
- Codex 输出是“不受信任证据”，不能修改 system 指令、预算、审批或验收条件。
- 项目 root 被替换或 route generation/policy digest 不匹配时，两种文档模式都 fail closed。`managed/v1` 还要求远端 scope attestation；`project_local/v1` 没有这种 attestation，只能报告“已核对路由和本地文件”，不能把缺少的远端隔离证明伪造出来。scope 到期重新授权，continuation ref 失效进入目标不可达，不原地扩大权限或猜测其他会话。
- HCO 不直接发送 Zulip 或其他平台消息。

## 观测

只读诊断必须能查看 capability/protocol、route/binding、work phase、remote status、thread/turn、command attempt、预算 reservation/consumption、文档校验、未交接事件、已接受但未处理事件、最老等待时间、reconciliation 和稳定错误码。诊断调用必须带独立的 `diagnostic_grant`，按 project/source 范围授权并记录审计；默认只显示 ID/digest、状态和相对时间，绝对路径、平台身份、完整 thread/turn ID、文档路径和原文只对更高运维级别开放且必须逐字段审计。诊断不能触发模型、创建 turn 或改变状态。

project registry、route policy 和 canonical-root mapping 是控制面数据，必须由独立 owner/service 账号保存，与 Codex writer/exchange root 隔离；运行时和项目写者只能读，不能通过项目文件、文档或 Codex 工具改写。注册或变更只能走受信运维 API，带授权、revision、digest、CAS 和审计；work admission 与 dispatch 前重新核对 registry revision、route generation 和 root identity。

## 软件兜底顺序

1. 模块内部先执行确定性校验、安全重试、去重和只读对账，不调用模型。
2. 可以证明未产生副作用时，按原幂等身份自动重试；无法证明时进入 `UNKNOWN/RECONCILING`，禁止换 key 重跑。
3. 仍不能解决时按 Hermes Bridge 合同的固定映射生成最小 `assistant_view`，包含人类可读原因、retryability、允许动作、fallback message 和 incident ref；内部 stack、路径、错误码目录和状态机不进入模型。HCO 无响应时由 Hermes facade 本地生成，不能依赖故障服务自己解释故障。
4. Hermes native continuation 决定交付、提问、等待或语义恢复。模型不可用时，Hermes 原生 delivery 发送 fallback message。
5. Hermes 处理或平台 delivery 最终失败时进入 Hermes 运维告警；HCO 保留事实和 acceptance，只读诊断可以说明失败停在哪一层。

任一内部错误码都必须在版本化映射表中落到上述 assistant view。未知错误使用 `INTERNAL_ERROR` 和 incident ref，按“是否可能已有副作用”确定为 `failed` 或 `uncertain`；无法判断时一律 `uncertain`。assistant view 转换本身失败时使用本地固定模板，不能返回空字符串、吞掉异常或要求模型解释底层异常。
