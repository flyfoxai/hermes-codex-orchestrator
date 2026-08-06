# 06 文档交换

## 目标和两种模式

文档交换用于传递较大的上下文、任务合同、日志、验收证据和 Codex 输出。它是 HCO 的文件协议，不是 Hermes 的消息层、session、reminder 或 mailbox。

文档交换分为两个模式，调用方和模型都不直接选择模式，由 HCO 根据项目能力和任务要求决定：

| 模式 | 当前状态 | 文件位置 | 能保证什么 | 不能保证什么 |
| --- | --- | --- | --- | --- |
| `project_local/v1` | 首版可用模式（方案目标；代码需按此实现） | 频道对应项目的 canonical root 内 | 唯一目录、固定命名、输入/输出哈希、大小和类型检查、单项目写者、失败可解释 | 不能从操作系统层面阻止 Codex 访问项目其他文件，不能物理封口，不能把普通路径变成 sandbox |
| `managed/v1`（当前 capability 为 `supported: false`） | 后续能力 | App Server enforcement adapter 提供的受控目录 | 目录隔离、写入期配额、物理封口、可验证 attestation | 当前 App Server 尚未提供这些能力，因此不能启用 |

`project_local/v1` 不是把 `managed/v1` 偷换成较弱实现，而是明确的降级协议。任务需要强隔离、不可修改的输入、秘密材料或跨代理安全边界时，HCO 必须拒绝并返回 `FILE_EXCHANGE_UNSUPPORTED`，不能自动降级到项目内目录。

### 模式选择

模式选择由软件执行，不要求模型理解 capability：

1. App Server/Hermes 有正式附件输入且满足任务要求时，优先使用原生能力。
2. 项目 policy 允许普通项目文件、文档 sensitivity 不高于允许级别、没有 `requires_immutable_input` 或 `requires_cross_agent_isolation` 时，选择 `project_local/v1`。
3. 受信 policy、附件 provenance 或调用约束要求强隔离时，只能选择 `managed/v1`；capability 不支持就返回 `FILE_EXCHANGE_UNSUPPORTED`。
4. sensitivity、来源或项目绑定无法确定时，fail closed：请求 Hermes 澄清或改用有界内联文本，不让模型通过参数把任务降级到 `project_local/v1`。

模型可以表达“需要更严格处理”这一业务约束，但不能要求降低 sensitivity、绕过项目 policy 或把 `managed/v1` 强行改为 `project_local/v1`。最终模式及原因写入受信 manifest 和 `assistant_view`。

## 职责边界

- Hermes 负责生成受信的 invocation/document ref、调用模型、续接、提醒和最终投递。
- HCO 负责选择模式、创建交换目录、生成文件名、写入输入、校验输出、维护 manifest 和把结构化事实交回 Hermes。
- Codex 负责读取 HCO 指定的输入、执行项目任务，并把约定的结果写入指定输出目录；Codex 不生成路径、文件名、权限或状态。
- App Server 在 `project_local/v1` 下只提供普通项目目录读写；它不声称提供 managed file exchange。只有在 capability 明确支持 `managed/v1` 时，才执行物理隔离和封口。

模块之间只交换版本化 manifest、document ref、校验摘要和稳定错误，不共享 Hermes transcript。模型只看到简短的任务说明和由软件生成的相对文件引用。

## `project_local/v1` 目录协议

### 目录布局

每个 project-bound work 在 canonical root 下使用专用目录：

```text
<canonical_root>/.hco/exchanges/v1/<work_id>/<exchange_id>/
  input/
    context.md
    task-contract.json
  output/
    result.md
    evidence.json
  status.json
```

`<work_id>` 和 `<exchange_id>` 都由 HCO 生成的不可复用 opaque ID；实现可以在目录名开头附带 UTC 毫秒时间，时间只用于排查，不用于唯一性、顺序或授权。来源类别只写入 manifest，不把用户姓名、频道名称或未经处理的文本放入路径。所有路径和文件名使用 ASCII 固定 token，避免空格、路径分隔符、控制字符、`.`、`..`、Windows 保留名和用户可控后缀。

HCO 创建目录时必须使用 canonical root 的真实目录对象，并确认该目录仍位于 root 内。交换目录只承载 payload，不能保存 Hermes message、session、Agent mailbox、reminder 或 delivery 状态。项目源码仍是项目事实源，交换目录不是第二份源码副本。

### Manifest 最小字段

数据库中的 document manifest 至少保存以下绑定；文件名和 `status.json` 不能替代这些字段：

```json
{
  "schemaVersion": 1,
  "exchangeMode": "project_local/v1",
  "workId": "work_opaque_id",
  "exchangeId": "exchange_opaque_id",
  "projectId": "project_opaque_id",
  "relativeRoot": ".hco/exchanges/v1/work_opaque_id/exchange_opaque_id",
  "inputManifestDigest": "sha256...",
  "files": [],
  "state": "STAGING|AVAILABLE|UNAVAILABLE|QUARANTINED",
  "retentionClass": "work_default"
}
```

`relativeRoot` 只能由 HCO 根据已验证的 canonical root 派生，不能接受模型、Hermes 文本或 Codex 输出中的路径。严格 `managed/v1` 的 manifest 还要附加 enforcement capability、FileAttemptBinding 和 seal receipt；`project_local/v1` 不填充这些字段。

### 写入顺序

1. HCO 根据已验证的 project route 和 work 生成 `exchange_id`，先在一个短事务中创建 `STAGING` manifest，冻结 work/project/mode、预期输入摘要、输出声明和 relative root。
2. 事务提交后，HCO 使用 exclusive `mkdir` 创建完整目录；同名时把本次 manifest 标记为冲突并生成新的 exchange/manifest version，不覆盖已有目录。
3. HCO 将输入写入 `input/`，使用临时文件、关闭后哈希、再以 no-replace 方式发布单文件，并复核 `bytes`、`sha256`、媒体类型、版本和 provenance 与 manifest 一致。不能把普通 rename 当作跨平台 no-replace；实现使用平台原子 no-replace 原语，或在本机单写 lane 内使用等价的 exclusive-create 流程。
4. HCO 生成 `status.json`，只写入当前事实的摘要，例如 `READY`、`RUNNING`、`OUTPUT_PENDING`、`AVAILABLE` 或错误码。该文件是给排查和 Codex 读取的提示，不是状态权威；HCO 不从中恢复控制状态，并可用当前数据库事实重新生成它。
5. HCO 启动或继续 Codex turn，并在任务文本中提供本次 `input/` 和 `output/` 的相对路径、允许的文件类型和输出要求。模型不需要理解 manifest、lease、CAS 或重试规则。
6. Codex 读取 `input/`，把结果写到本次 `output/`。它可以访问该项目原本允许访问的其他项目文件；HCO 不把项目内目录协议描述成 sandbox。
7. Codex turn 进入终态后，HCO 在单写 lane 中重新读取和校验输出，比较输入哈希，生成输出 manifest，并把可用内容注册为 `AVAILABLE`。成功导入前，输出仍是普通项目文件，不能被当成已证明的受管结果。
8. HCO 更新 `status.json`，保存脱敏的结果摘要和 incident ref（如有），然后通过 Hermes external continuation 把事件交回 Hermes。Hermes 调用模型决定交付、追问、继续 Codex、等待或升级。

### 文件命名

目录和文件名由软件生成，模型不生成或修改它们。首版固定文件名即可：`context.md`、`task-contract.json`、`result.md`、`evidence.json`、`status.json`。同一 work 的每个 exchange 使用独立目录，避免两个重试 worker 互相覆盖。需要多版本时，使用新的 `exchange_id` 或 manifest version，不能覆盖已经 `AVAILABLE` 的结果。

如果需要把时间和调用人用于排查，应写进 `status.json` 和 manifest 的结构化字段；不要把未经清理的调用人、频道或主题直接拼进路径。

### 输入和输出规则

- 按协议输入只能由 HCO 写入；普通项目权限无法在系统层阻止 Codex 修改。HCO 在执行前后比较输入哈希；发现变化时，结果标记为 `PROJECT_LOCAL_INPUT_CHANGED`，不得默认为可信成功。
- 输出是 Codex 产生的不受信项目文件。HCO 只接受 manifest 声明的输出文件，检查普通文件类型、大小、媒体类型、UTF-8/JSON 格式和 SHA-256；缺失必需输出返回 `PROJECT_LOCAL_OUTPUT_MISSING`。
- HCO 读取输出时记录文件身份、大小和哈希；读取前后发现对象或内容变化，返回 `PROJECT_LOCAL_OUTPUT_CHANGED`，隔离本次结果，不把半成品发布为 `AVAILABLE`。项目内模式没有物理封口，不能用一次成功读取推导出长期不可修改保证。
- HCO 不递归接收任意目录，不自动展开 archive，不把目录扫描当成事件或 wake。需要更多文件时，Codex 必须在任务中声明并由 HCO 生成新的 manifest。
- 已有同名结果不覆盖：哈希相同则幂等复用，哈希不同则生成 `DOCUMENT_CONFLICT` 并隔离新结果。
- `.hco/exchanges/` 应加入仓库的本地忽略规则。Git 项目通过 Git 自身解析实际 info/exclude 路径后写入本地规则，避免直接假设 `.git` 一定是目录，也避免修改项目共享的 `.gitignore`；没有 Git 时由 HCO 自己按 retention 清理。

## 固定限制和错误兜底

`project_local/v1` 至少执行以下软件限制：单个输入/输出大小、每个 exchange 文件数、总字节数、路径深度、允许 MIME、文本编码、JSON 解析和 retention。限制由 HCO 在写入前和读取后检查；它们不是 App Server 的写入期隔离，不能用来宣称安全 sandbox。HCO 应预留生成 manifest、错误事实和 Hermes fallback 所需的本地空间。

稳定错误至少包括：

| 错误 | 人话含义 | Hermes 后续行为 |
| --- | --- | --- |
| `PROJECT_LOCAL_EXCHANGE_UNAVAILABLE` | 项目目录不可写或交换目录无法创建 | 交回模型；可换无文件方式或告知用户 |
| `PROJECT_LOCAL_INPUT_CHANGED` | Codex 改了 HCO 写入的输入 | 不判定成功；请求模型检查或告知用户 |
| `PROJECT_LOCAL_OUTPUT_MISSING` | 必需结果文件没有生成 | 请求 Codex 补做或向用户说明 |
| `PROJECT_LOCAL_OUTPUT_INVALID` | 输出不是允许的普通文件/格式/大小 | 隔离结果并请求模型处理 |
| `PROJECT_LOCAL_OUTPUT_CHANGED` | 验收期间输出仍在变化，无法形成稳定快照 | 不发布结果；等待或请求 Codex 重新生成 |
| `DOCUMENT_CONFLICT` | 同一结果已有不同内容 | 保留两份证据，不覆盖旧结果 |
| `FILE_EXCHANGE_UNSUPPORTED` | 任务要求强隔离，但当前 App Server 没有 enforcement adapter | 明确失败，不偷偷使用项目内模式 |

任何 HCO 异常都先转换成固定 `assistant_view`，包含状态、原因、是否可重试、下一步和 incident ref。模型不可用时，Hermes 仍用原生 delivery 发送确定性 fallback。远端 start/turn 结果不确定时，沿用原 command id 做只读对账，不能因为文件目录已经存在就重跑任务。

## 并发、恢复和清理

- 同一 canonical root 默认一个直接写 work；不同 topic 不能并写同一项目目录。读任务可以并行，但涉及项目修改仍需 root write lease。
- 每个 exchange 使用唯一目录；创建、导入和状态更新在 HCO 的单一 document lane 中串行执行。发布使用 no-replace/exclusive-create 语义；目标已存在时哈希相同复用，不同哈希隔离。
- 进程重启后，只恢复数据库中已有的 `STAGING`/`AVAILABLE` manifest。孤立目录不能自动变成新任务、事件或 Hermes wake；无法核验的目录标记为 `QUARANTINED`。
- 首版不承诺断电一致性，不支持 NFS/SMB/共享目录、跨卷移动或多个 HCO 文件代理。断电恢复和多代理严格隔离属于 `managed/v1` 的独立合同。
- work 终态后按 retention 清理 exchange；仍被未处理事件、interaction 或子 work 引用时延迟删除。删除失败保留最小 metadata 并告警，不重新暴露文件。

## 传给 Codex 的最小说明

HCO 只向 Codex 注入类似下面的简短说明，具体路径由软件填入：

```text
本次任务的上下文在 .hco/exchanges/v1/<work_id>/<exchange_id>/input/。
请先读取 task-contract.json 和 context.md。
需要回传的结果写入 output/result.md；结构化证据写入 output/evidence.json。
不要修改 input/，不要创建其他 exchange 目录，不要把秘密写入输出。
```

这段说明不是安全边界。Codex 的实际权限仍由普通项目执行环境决定；HCO 负责在任务结束后校验并解释偏离。

## `managed/v1` 严格模式（延后）

以下要求只适用于未来的 `managed/v1`，不能反过来阻塞 `project_local/v1`：App Server enforcement adapter 对 inbox/upload 的独立挂载、写入期硬配额、已打开句柄也不能继续写入的物理 seal、scope attestation、跨平台对象身份和分布式恢复租约。当前 App Server 不提供这些能力，`capability.supported` 必须保持 `false`。

启用严格模式前必须通过 [Codex Transport API](../contracts/02-codex-transport-api.md) 的 capability probe、物理封口故障注入和跨进程恢复验收。不能以 `chmod`、文件名、目录存在、Codex 自报完成或事后扫描替代 enforcement。
