# 05 Agent 发起 Codex

## 入口

Hermes Agent 使用与用户相同的单一 `codex` 工具。Hermes 决定哪些 Agent 可以使用工具，并沿用原生 toolset 继承、并发、深度和审批限制。

Agent 调用只提供目标、验收条件、简单任务关系和文档引用。Hermes 在模型不可见的 envelope 中注入：

- `invocation_ref`：本次主体、来源、项目上下文、操作和授权；
- `continuation_ref`：结果所属的 Hermes 逻辑会话和 Agent 回退策略；
- capability revision 和调用幂等键。

非 Zulip Agent/DM 的项目范围必须来自 Hermes `invocation_ref` 的 opaque `project_context_ref` claims，不能从 Agent prompt、topic 文本或模型参数推断目录。

首次没有 project context 时，Agent 只能提供逻辑项目别名候选；受信 resolver 在当前 grant 的获准项目内解析。唯一匹配后由 Hermes 签发 context，歧义或无匹配时向有权限主体提问。Agent 不能把别名、路径或 project ID 自行提升为可信范围。

Agent 不能填写 `agent_id`、父节点、delegation path、session key、平台地址、raw `cwd`、interaction ID 或审批身份。它只可以使用工具返回的受限 opaque `work_ref`；HCO 必须重新校验 invocation、来源、项目、interaction receipt 和授权。

## 生命周期

Agent 可能在 Codex 完成前结束。HCO 继续保存 work，并携带 origin invocation receipt 和 `continuation_ref` 发事件；Hermes 解析逻辑引用：

1. Agent 存活：交回该 Agent mailbox。
2. Agent 已结束：按 Hermes 自己的父/根回退规则处理。
3. 引用被撤销或逻辑目标不存在：进入人工修复，HCO 不猜测新目标。

回退只改变事件接收者，不改变 work、权限、scope 或结果。Hermes 可以让新的 Agent 综合，但 HCO 不保存 Agent 树。

## 权限与审批规则

Agent 权限是根会话权限、父授权和项目策略的交集。危险操作必须由 Hermes 授权策略映射到明确的审批主体和答案类型：

| 操作类别 | 默认审批主体 | Agent 是否可代答 |
| --- | --- | --- |
| 只读项目分析、普通输入补充 | 当前 Agent/父 Agent | 可，前提是 grant 允许 |
| 项目内写入、测试、受限 sandbox 操作 | Hermes 当前授权主体 | 仅在 grant 明确允许时 |
| 扩大文件/网络/凭据范围 | 用户或管理员 | 不可 |
| 修改 sandbox、不可逆或外部副作用 | 用户或管理员 | 不可 |

审批主体、可接受答案、超时和撤销由 Hermes native approval policy 决定；模型不能自行判断“谁可以批准”。HCO 只校验 responder invocation、interaction receipt 和 policy revision。Agent 不能代替用户批准。

## 多 Agent 并发

多个 Agent 可以各自创建 work，但必须使用不同的幂等键、文档 manifest 和 Codex thread，并共享 root lineage 的预算和写 lease。HCO 只保证 scope、并发写 lease、预算和权限不变量，不负责 planner、join、evaluator、summary bus 或通用协作图。
