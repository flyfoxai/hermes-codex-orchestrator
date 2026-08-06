# HCO 模块化方案

这里是 HCO Codex 服务桥的模块文档入口。模块按功能拆分，每个模块只维护自己的职责、输入输出、状态和异常边界。

```text
HCO Codex Service Bridge
├── 01 Hermes 集成与续接
├── 02 来源路由与项目范围（含 Zulip）
├── 03 Codex 执行与状态
├── 04 事件、审批与交互
├── 05 Agent 发起 Codex
├── 06 文档交换
├── 07 可靠性、安全与观测
├── 08 验收、性能与迁移
└── contracts 跨系统 API 与事务合同
```

## 阅读顺序

1. 先看根目录的 [主 PRD](../HCO_CODEX_SERVICE_BRIDGE_PRD.md)，了解边界和主流程。
2. 实现 Hermes 接口时看 01、04、05。
3. 实现项目目录和 Codex runtime 时看 02、03。
4. 处理长上下文时看 06；处理异常、并发和上线门禁时看 07、08。

## 模块目录

| 模块文档 | 唯一主责 |
| --- | --- |
| [01 Hermes 集成与续接](modules/01-hermes-integration.md) | Hermes 侧工具、事件入口、模型续接和投递 |
| [02 来源路由与项目范围（含 Zulip）](modules/02-zulip-routing-and-scope.md) | 来源路由和 ExecutionScope 生成 |
| [03 Codex 执行与状态](modules/03-codex-execution.md) | ExecutionScope 落实、thread/turn 和 work 投影 |
| [04 事件、审批与交互](modules/04-events-and-interactions.md) | HCO 侧事件和远端 interaction 绑定 |
| [05 Agent 发起 Codex](modules/05-agent-codex-calls.md) | Agent 授权和返回生命周期 |
| [06 文档交换](modules/06-document-exchange.md) | document manifest 和文件边界 |
| [07 可靠性、安全与观测](modules/07-reliability-security.md) | 跨模块幂等、恢复、安全和诊断 |
| [08 验收、性能与迁移](modules/08-acceptance-performance-migration.md) | 实施门禁、验收、成本和旧方案退出 |

## 合同目录

| 合同 | 用途 |
| --- | --- |
| [Hermes Bridge API](contracts/01-hermes-bridge-api.md) | invocation/continuation ref、单一模型工具、external continuation 和结算 |
| [Codex Transport API](contracts/02-codex-transport-api.md) | managed scope、attestation 和远端命令不确定性 |
| [状态、事务与资源合同](contracts/03-state-transactions.md) | HCO 聚合、事件 reducer、预算、队列、lease 和恢复 |

## 模块共同规则

- Hermes 拥有消息、会话、Agent、提醒、用户交互、continuation action 和平台投递。
- HCO 拥有项目路由、ExecutionScope、Codex work、远端事件和文档 manifest。
- Codex App Server 拥有远端 thread、turn、interaction 和执行状态。
- 模型只看到一个 `codex` 工具和六种语义状态；路径、权限、重试、lease、事件 ledger 和文档授权由软件处理。
- HCO 事件通过 Hermes 公开的 external continuation adapter 进入现有 native completion pipeline；插件禁止调用 Hermes 私有 `_...` 对象。
- 跨系统只传稳定 ID、opaque 引用、结构化 payload、文档引用和最小可信来源；不复制完整 Hermes transcript，也不传可用于直接平台投递的凭据/地址。
- HCO 内部模块可以共享一个本地事务，但每个聚合只有一个写入所有者；模块拆分不等于微服务拆分。
- 大 payload 首版使用项目内 `project_local/v1` 文件交换：HCO 在频道对应项目的 canonical root 下创建 `.hco/exchanges/v1/<work_id>/<exchange_id>/`，写入 `input/`，Codex 写入 `output/`，HCO 在终态后校验并登记 manifest。该模式复用普通项目权限，不提供 sandbox、物理封口或写入期隔离。只有未来 `managed/v1` 具备真实 App Server enforcement adapter 时，才使用受控 upload、物理 seal 和 attestation；文件名只用于关联，权限、完整性和状态仍以 manifest 为准，模型不生成文件名或路径。
- 发生冲突时，以主 PRD 的全局不变量为准；模块文档不能扩大本模块职责。

详细历史合同保留在 [0.4 完整参考](reference/HCO_CODEX_SERVICE_BRIDGE_PRD_FULL_0.4.md)，仅用于追溯，不作为新的独立状态设计来源。
