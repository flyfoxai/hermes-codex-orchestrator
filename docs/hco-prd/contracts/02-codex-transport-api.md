# Codex Transport API 合同

适用主 PRD：0.9

## 1. 目标

本合同定义 HCO 如何复用 Hermes 的 Codex App Server 协议代码，同时真正落实严格 `managed/v1` 的项目范围、远端命令不确定性和取消。现有仅传 `cwd` 的接口可以运行普通项目执行和 `project_local/v1` 文档交换，但不满足 `managed/v1` 写执行。

文档交换有两个明确分支：

| 模式 | 是否由本合同强制 | 说明 |
| --- | --- | --- |
| `project_local/v1` | 否 | 使用已授权的 canonical root 内 `.hco/exchanges/v1/<work_id>/<exchange_id>/`。HCO 做目录创建、manifest、哈希、大小、类型和单写校验；不提供 App Server 层的 sandbox、物理 seal 或写入期 quota。具体协议见 [文档交换模块](../modules/06-document-exchange.md)。 |
| `managed/v1` | 是 | 需要下文的 `ExecutionScope`、enforcement adapter、attestation、FileAttemptBinding 和物理 seal。当前 App Server capability 必须保持 `supported: false`。 |

下文第 2 至第 8 节仅适用于 `managed/v1`。`project_local/v1` 不得伪造或填充这些字段来获得“受管”语义。

同进程 transport 使用内部 capability object；跨进程 transport 只能使用 owner-only Unix socket、Windows 服务账号 ACL named pipe，或与 Hermes Bridge 相同等级的 mTLS/HMAC 身份验证。模型不能直接访问 transport。

`codex_transport_capabilities/v1` 返回协议版本、是否支持 `managed_execution_scope/v1` 能力协议、enforcement modes、sandbox/read-write roots 支持、远端 command idempotency、按 command/thread/turn/interaction 查询、cancel 和 attestation。只有当 transport 同时声明可强制的 upload limit profile、物理 file-attempt seal、可供 HCO 锚定的 upload directory identity 和 `max_effective_path_units` 时，才允许报告 `managed/v1` supported；任一项只能事后检查时不得声明支持。HCO 把 capability revision 固定进 work；缺少声明能力时 fail closed。`managed_execution_scope/v1` 是 ExecutionScope/attestation 的能力协议名，实际改变远端状态的端点是 `start_or_resume_managed_turn/v1`。`project_local/v1` 不依赖这个 capability，不能把它填入 `fileExchange.supported`。

Transport 稳定错误至少包括：`SCOPE_INVALID`、`SCOPE_EXPIRED`、`ROOT_IDENTITY_CHANGED`、`ATTESTATION_MISMATCH`、`THREAD_SCOPE_MISMATCH`、`WRITE_LEASE_LOST`、`REMOTE_CAPABILITY_MISSING`、`REMOTE_COMMAND_UNKNOWN`、`INTERACTION_CONFLICT`、`REMOTE_REJECTED`、`FILE_ATTEMPT_MISMATCH`、`FILE_ATTEMPT_NOT_SEALED`、`FILE_BROKER_EPOCH_STALE` 和 `UPLOAD_LIMIT_EXCEEDED`。文件类型、最终路径、document version 和发布冲突由 HCO document broker 判定，不复制进 Transport。

## 2. ExecutionScope v1

不可变 scope 至少包含：

```text
scope_version, scope_digest
project_id, route_key_digest, source_identity_digest
canonical_root, root_identity
route_generation, policy_revision, policy_digest
origin_invocation_receipt_digest, authorization_revision
sandbox_profile, read_roots, write_roots
exchange_root, document_grants_digest, input_manifest_digest
admission_expires_at, execution_deadline
write_lease_id, fencing_token
```

对 `managed/v1`，`exchange_root` 必须是规范化、由 HCO 控制、按 work 隔离的本机目录。整个 root 不能直接列为 Codex 的通用 read/write root：Codex 只读挂载 `inbox`，只读写 HCO 为当前 command 签发的 `upload/<file_attempt_id>`，不能访问 `outbox` 或 `quarantine`。`document_grants_digest` 覆盖每个 document ID、version、hash 和 `read|write|result` 权限；`input_manifest_digest` 覆盖完整 canonical manifest、provenance 和冻结版本。`project_local/v1` 不使用此挂载模型，使用模块 06 定义的项目内目录和普通项目权限。

`managed/v1` 使用文件传递大 payload 时，transport 必须声明 `local_single_broker_exchange/v1`，并遵守 [文档交换协议](../modules/06-document-exchange.md) 的严格模式。首版只允许同一主机、同一卷的普通本地文件系统；HCO work owner 是该 work 的唯一文件代理和最终文件写入者。NFS、SMB、共享目录、多个文件代理并发认领、跨卷移动和断电一致性不在严格模式合同内，capability probe 必须拒绝。`project_local/v1` 不调用本 capability，文件名不能替代 manifest 或 command ledger，目录扫描不能产生 work、事件或 wake。

### 2.1 FileAttemptBinding

可能产生文件输出的每个 `START/RESUME/FORK` 必须携带由 HCO 创建的 `FileAttemptBinding`，其 canonical digest 至少覆盖：

```text
binding_version: 1
file_attempt_id, work_id, command_id
expected_thread_id?, scope_digest
creator_file_broker_epoch, upload_relpath
limit_profile_digest, expires_at
```

binding 保存在现有 command attempt 中，不单独形成业务聚合。`file_attempt_id` 是 HCO 生成的至少 128 bit 不可预测 opaque ID且不可复用；`upload_relpath` 只能是 HCO 派生的单层相对路径，不能接收模型或远端提供的路径。提交前字段通过共享 schema 的 RFC 8785 canonical JSON + SHA-256 形成不可变 `file_attempt_request_digest`；远端 receipt 到达后，HCO 以 CAS 一次性补充实际 `thread_id/turn_id`，并对固定对象 `{binding_version, file_attempt_request_digest, thread_id, turn_id}` 使用同一算法形成 `resolved_file_attempt_binding_digest`。禁止字符串拼接或由 adapter 自定义 canonicalization。attestation 必须证明实际 thread/turn，seal、输出 manifest 和导入使用 resolved digest。取消、替换、scope 到期或 broker epoch 变化后，transport 必须撤销旧 binding 的写挂载，迟到输出只能隔离。

`file_attempt_id` 全局唯一，`command_id` 在 file binding 中唯一；同一 command/idempotency key 重交只能复用第一次 binding。需要新的 file attempt 时必须使用新的 command，并先证明旧 binding 已 `SEALED` 或 `REVOKED`。transport 收到同一 command 的不同 binding 时返回 `FILE_ATTEMPT_MISMATCH`，不能创建第二个 upload mount。

基础 profile 固定 `max_depth=1`，只允许在当前 upload 根目录创建普通文件，不协商子目录或 archive 自动展开。limit profile 至少包含每 attempt/每 work 总字节数、单文件大小、普通文件数/inode 数、保留期和 HCO reserve 要求。enforcement adapter 必须在写入发生时以 quota、隔离 backing store、container/filesystem policy 或等效机制强制；轮询目录后再终止不算强制能力。

`root_identity` 是随 adapter/capability revision 固定的 tagged union。POSIX 至少包含 filesystem/mount identity、`st_dev`、`st_ino` 和 enforcement adapter 持有或可复核的 root directory handle identity；Windows 至少包含 volume identity、`FILE_ID_128`、最终 reparse-resolved handle identity 和 reparse policy。HCO 与 attestation 必须使用同一 adapter/version 的规范化和比较规则；实现不能把不存在的 POSIX `dev/ino` 硬套到 Windows，也不能只用规范化路径字符串代替文件系统对象身份。

`admission_expires_at` 到期后禁止新 start、resume、fork 和会恢复执行的 interaction reply。正在运行的 turn 只能执行到 `execution_deadline`；到期后 transport 发起取消/终止。若无法确认停止，work 进入 `RECONCILING`，不能交给新写者。

等待 interaction 时 scope 到期，旧 interaction 不再接受答复。Hermes 请求重新授权；HCO 只有在旧 turn 已确认取消/终止后，才能用新 scope 创建关联 replacement work。旧 scope 不原地更新。

## 3. Managed turn API

```text
start_or_resume_managed_turn/v1(
  command_id,
  idempotency_key,
  execution_scope,
  expected_thread_id?,
  input_manifest,
  file_attempt_binding?,
  operation: START | RESUME | FORK
)
```

调用方不能另外传入 cwd、sandbox 或 root 覆盖字段。transport 在启动前落实隔离和写 lease，再返回：

```text
thread_id, turn_id, remote_command_receipt
effective_scope_attestation
remote_status, remote_revision
```

## 4. Attestation

`effective_scope_attestation` 至少包含：

```text
enforcement_adapter_id/version
enforcement_mode: CODEX_NATIVE | TOOL_GATEWAY | CONTAINER | WORKTREE
isolation_instance_id
actual_canonical_root + actual_root_identity
actual_sandbox_profile + actual_read_roots + actual_write_roots
actual_exchange_root + actual_document_grants_digest + actual_input_manifest_digest
actual_exchange_profile + actual_inbox_read_mount + actual_upload_write_mount
actual_file_attempt_id + actual_file_attempt_request_digest
resolved_file_attempt_binding_digest
actual_upload_limit_profile_digest + actual_max_effective_path_units
file_broker_owner_receipt + actual_creator_file_broker_epoch
actual_write_lease_id + actual_fencing_token
thread_id + turn_id + scope_digest + issued_at
attestation_mac_or_local_receipt
```

attestation 必须由真正创建 sandbox/container/worktree 或拦截工具调用的 enforcement adapter 产生，不能只是把请求字段原样回显。HCO 核对全部关键字段后才能把 work 标为 ACTIVE。

文件输出不能仅凭 Codex 自报“已关闭”开始导入。transport 必须提供：

```text
seal_managed_file_attempt/v1(
  seal_command_id, idempotency_key,
  command_id, file_attempt_id,
  thread_id, turn_id, expected_scope_digest,
  expected_creator_file_broker_epoch
) -> file_attempt_seal_receipt
```

adapter 必须先阻止新写入，并证明对应 isolation instance 的现有进程、挂载和已打开句柄都不能继续修改该 upload，再签发 receipt。receipt 绑定 `resolved_file_attempt_binding_digest`、isolation instance、enforcement adapter revision 和 sealed time，并由本地可信 receipt/MAC 防篡改。仅修改权限位、ACL 或相信进程自报不满足此合同。seal 使用现有 remote command attempt ledger 的 `PENDING/SENT/CONFIRMED/UNKNOWN` 规则；完全相同的 `seal_command_id + idempotency_key + payload digest` 重试返回原 receipt，不同 payload 冲突。transport 还必须支持按 seal command/file attempt 只读查询；响应丢失且无法确认时保持 `UNKNOWN/RECONCILING`，不能换 key 重封或开始导入。无法形成确定 receipt 时返回 `FILE_ATTEMPT_NOT_SEALED`；取消和 scope 丢失还必须撤销 file attempt，不能把本地状态写成假封口。

不同操作系统和 enforcement mode 分别通过 capability gate；无法落实写边界、物理 seal 或写入期 upload 限额时，只允许明确的只读 profile 或拒绝文件输出。路径授权必须校验最终解析对象和文件系统身份，不能使用字符串前缀判断：POSIX 需要阻止 symlink、hard-link、bind mount/挂载点和 TOCTOU 逃逸，Windows 需要阻止 junction、reparse point、volume alias 和大小写/短文件名混淆。transport 必须把 upload 暴露为 HCO 可锚定的目录对象并证明它仍属于 attested exchange root；HCO document broker 再负责相对该 handle 打开 regular file、no-follow/nonblocking、打开后类型复核、复制 deadline 和流式字节上限。FIFO、socket、device、directory 和异常 link/reparse object 必须确定性拒绝。每次打开或写入时，enforcement adapter 都要证明目标仍位于获准 root，且 root identity 与 attestation 一致；仅在 admission 时调用一次 `realpath` 不足以构成运行时隔离。

## 5. 远端 command attempt

start、resume、fork、reply、seal 和 cancel 在调用远端前，HCO 先在所属 work/interaction 聚合中写入：

```text
command_id, command_kind, idempotency_key, payload_digest
state: PENDING | SENT | CONFIRMED | UNKNOWN | REJECTED
attempt_revision, sent_at, remote_receipt, reconciliation_evidence
```

事务提交 `PENDING` 后才能发送；发送前改为 `SENT`。收到可验证 receipt 后为 `CONFIRMED`。超时、断线或进程崩溃后无法证明结果时为 `UNKNOWN`。

- 后端支持 command idempotency 和结果查询：按原 command ID 查询或重交，远端效果可以达到恰好一次。
- 后端不支持：不得重发可能有副作用的命令；保持 `UNKNOWN` 并只读对账、升级用户或运维。

因此 PRD 只承诺“幂等意图和不确定时不盲目重发”，不无条件承诺 App Server 远端效果恰好一次。

## 6. Interaction reply

```text
reply_interaction/v1(
  command_id,
  remote_interaction_id,
  interaction_receipt_ref,
  responder_invocation_ref,
  answer_digest,
  answer,
  current_scope_digest
)
```

HCO 校验模型不可见的 Hermes interaction receipt、当前 responder invocation、回答授权、远端 revision、scope 未过期和 route 模式。相同 command/digest 返回第一次结果；不同 digest 冲突。远端结果不确定时禁止用新 command 重答。

## 7. Cancel 和 scope 丢失

cancel 是远端控制面操作，不需要访问项目文件。HCO 使用已持久化的 work/thread 归属、远端 ID 和原 scope digest 校验目标：

```text
cancel_managed_turn/v1(command_id, work_id, thread_id, turn_id, reason)
```

canonical root 丢失或平台化 `root_identity` 变化时，仍允许只向已绑定的远端 turn 发 cancel，并由 enforcement adapter 判定、记录 `scope_lost=true`。只有远端确认后才能记 `remote_status=CANCELLED`；无法确认则保持 `RECONCILING/UNKNOWN`，不能写成假取消。

## 8. 查询与 reconciliation

Transport 至少提供以下版本化只读端点：

```text
get_managed_command_status/v1(command_id, idempotency_key)
  -> CONFIRMED(receipt) | REJECTED(error) | PENDING | NOT_FOUND | UNKNOWN

get_managed_turn_snapshot/v1(thread_id, turn_id?, expected_scope_digest)
  -> remote_status + remote_revision/snapshot_digest + scope evidence

get_managed_interaction_snapshot/v1(remote_interaction_id, thread_id)
  -> OPEN | ANSWERED | EXPIRED | CANCELLED | NOT_FOUND | UNKNOWN

get_managed_file_attempt_snapshot/v1(file_attempt_id, seal_command_id?, expected_scope_digest)
  -> OPEN | SEALED(file_attempt_seal_receipt) | REVOKED | NOT_FOUND | UNKNOWN
```

这些端点不能启动、继续、回答、封口或取消远端工作。只有后端具备可证明的 command ledger，`NOT_FOUND` 才能证明命令未执行；否则 `NOT_FOUND` 仍按 `UNKNOWN` 处理，不能据此换 key 重发。若 App Server 没有稳定 revision，HCO 使用 snapshot digest 对账，不能自行生成看似单调的远端 revision。

`RECONCILING` 超过 SLA 时发送 `codex.unknown` 给 Hermes。运维或用户可以把本地追踪标为 `ABANDONED_UNRESOLVED`，表示系统停止自动对账；远端事实仍为 UNKNOWN，后续证据到达时可以重新打开，不能强制改成 FAILED/CANCELLED。

首版默认：远端 command 请求 30 秒无确定响应即记录 UNKNOWN；5 秒后开始只读对账，指数退避最高 5 分钟；15 分钟仍 UNKNOWN 必须通知原 Hermes 会话，30 分钟仍 UNKNOWN 必须触发运维告警。App Server capability 可以声明更短 timeout，不能在普通调用中临时放宽。
