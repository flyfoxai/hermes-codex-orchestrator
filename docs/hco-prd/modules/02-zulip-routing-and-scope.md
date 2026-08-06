# 02 来源路由与项目范围（含 Zulip）

## 职责

HCO 将可信来源映射到唯一项目和 canonical root，再把该范围固定进 Codex `ExecutionScope`。Zulip 是首要来源；Hermes 仍负责 Zulip poll、会话和平台投递。

本模块负责生成和校验 scope；transport 如何落实 scope 归 [`03-codex-execution.md`](03-codex-execution.md)。

所有来源上下文都由 Hermes 封装进模型不可见的 `invocation_ref`。Zulip adapter 维护稳定 `source_namespace_id`、`topic_context_id` 和 rename/move continuity；非 Zulip introspection 返回稳定来源上下文，项目已绑定时包含 opaque `project_context_ref`。授权和 project context 由 [`../contracts/01-hermes-bridge-api.md`](../contracts/01-hermes-bridge-api.md) 的单一 invocation introspection 解析，模型不能补项目路径。非 Zulip 首次选择项目使用该合同的 `hco_project_context_resolve/v1`，歧义时由 Hermes 原生 clarify 提问。

## 稳定映射

| 来源 | HCO 对象 | 约束 |
| --- | --- | --- |
| `source_namespace_id + stream_id` | `project_id + canonical_root` | 同一来源命名空间内，一个频道只能有一个项目 |
| `source_namespace_id + stream_id + topic_context_id` | `topic_binding_id + Codex 主 thread` | 一个稳定话题只能有一个主上下文 |
| 非 Zulip `project_context_ref` | `context_binding_id + Codex 主 thread` | project/context 必须来自 Hermes invocation claims |
| 一条消息 | `work_request_id + idempotency_key` | 一次具体执行 |

`source_namespace_id` 由受信 adapter 注入，模型不能填写；传输层 instance ID 也不能代替业务来源命名空间。频道名、topic 文本、prompt 和模型传入的 `cwd` 都不能选择项目。话题改名或跨频道移动，只有可信 continuity 事件或管理员显式 relink 才能沿用绑定。

`route_key` 的 Zulip 形式固定为 `(source_namespace_id, stream_id)`；topic binding key 固定为 `(source_namespace_id, stream_id, topic_context_id)`。非 Zulip 使用 Hermes 签发的 opaque `project_context_ref + context_id`，不能把平台名称、聊天文本或模型别名当作 route key。

`source_namespace_id` 由 Hermes connector/realm/account registry 分配，稳定且不可复用；连接器重装必须恢复原 ID，替换或轮换只能通过带 continuity receipt 的管理员 `source_namespace_relink` 完成。旧命名空间进入 `RETIRED` 后不自动迁移既有 route/work，也不能把新来源静默映射到旧项目。

continuity receipt 至少绑定 old/new connector identity digest、logical realm/account digest、existing/new namespace ID、管理员 operation/grant、registry revision、issued time 和模式：`REBIND_TO_EXISTING_NAMESPACE | CREATE_NEW_NAMESPACE`。前者只让新 connector 继续使用原业务 namespace，不迁移 route/work；后者创建新 namespace，必须显式重新注册 route，旧 work 仍留在旧 namespace。相同 operation/digest 幂等，冲突 receipt 拒绝。

## 路由状态

```text
UNMAPPED -> ACTIVE -> SUSPENDED -> RETIRED
              ^          |
              +----------+
```

- `UNMAPPED`：Hermes 正常处理，不创建 HCO project work。
- `ACTIVE`：允许创建、继续和恢复 Codex work。
- `SUSPENDED(DRAIN)`：禁止新建；已有 scope 内的 active turn 和 interaction reply 可以继续。
- `SUSPENDED(FREEZE)`：禁止新建、resume、fork 和会恢复执行的 interaction reply；只允许查询、cancel 和对账。
- `RETIRED`：不再接受新任务；旧 work 不静默迁移。

`topic_policy` 为 `AUTO | HERMES_ONLY`；`HERMES_ONLY` 表示该 topic 只允许 Hermes 对话/模型处理，禁止从该 topic 发起任何 Codex native turn 或 HCO managed work，不能作为绕过 scope 的开关。`topic_binding_state` 为 `UNBOUND | BOUND | STALE`。binding 惰性创建，路由变化后旧 binding 进入 `STALE`，旧 scope 不得改写为新目录。

## ExecutionScope

每个 `HCO_MANAGED_WORK` 持有不可变 scope 快照；文档模式单独记录为 `project_local/v1` 或 `managed/v1`。字段名必须与 transport 合同一致。`exchange_root` 在 `project_local/v1` 中指向 canonical root 下的唯一 `.hco/exchanges/v1/<work_id>/<exchange_id>/`；在 `managed/v1` 中才指向 enforcement adapter 创建的受控挂载：

```text
scope_version, project_id, route_key_digest, source_identity_digest, canonical_root, root_identity
route_generation, policy_revision, policy_digest
origin_invocation_receipt_digest, authorization_revision
document_mode, sandbox_profile, read_roots, write_roots, exchange_root?
document_grants_digest, input_manifest_digest, write_lease_id, fencing_token
admission_expires_at, execution_deadline
scope_digest
```

HCO 在创建、继续和恢复前重新核对 route generation、policy digest 和 registry 的 `root_identity`；同一 work 的比较始终使用固定 adapter/capability revision。`project_local/v1` 只核对 canonical root 和 exchange manifest，不伪造 sandbox/attestation；`managed/v1` 还必须通过 transport enforcement。scope 到期禁止新 start/resume/fork/reply；旧 active turn 只能运行到 execution deadline。等待 interaction 的 work 到期后须重新授权并创建 replacement work，不能原地延长 scope。取消是远端控制面，即使 root 丢失也可按已绑定 thread 执行，结果不确定保持 UNKNOWN。

项目注册必须拒绝相同或相互嵌套的 canonical root。注册表和 policy 由独立 owner/service 账号保存，Codex writer、exchange root 和普通项目文件不可写；变更只接受带授权、revision、digest、CAS 和审计的运维 API。没有可信目录范围时只能显式降级为只读，不能默认为写入；dispatch 前必须重新核对 registry revision 和 root identity。

## 管理员操作

`route_register`、`route_update`、`route_suspend`、`route_retire`、`source_namespace_relink`、`topic_policy_set` 和 `topic_relink` 只能由受信运维入口执行，不进入模型默认工具列表。`RETIRED` 前必须选择 `DRAIN_EXISTING` 或 `CANCEL_EXISTING`。所有变更产生 generation/revision 和审计事实。
