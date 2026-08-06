# HCO Artifact Manifest Protocol（兼容参考）

> 本文描述仓库中已有的 `artifact_manifest` 兼容协议，不是当前目标方案的权威设计。新的文档交换方案见 [`docs/hco-prd/modules/06-document-exchange.md`](hco-prd/modules/06-document-exchange.md)：新任务使用项目内 `.hco/exchanges/v1/<work_id>/<exchange_id>/` 的 `project_local/v1`，不接受模型或调用方直接提供任意项目路径。当前 App Server 仍不支持 `managed/v1` 的真实 enforcement，不能把本文的事后文件检查称为 managed file exchange。

本文定义 Hermes Codex Orchestrator（HCO）Option C 生产链路中的正式文件中转协议。协议能力名为 `artifact_manifest`，当前 schema 版本为 1。

Artifact 协议用于在 Hermes 和 Codex 之间传递“文件契约”，而不是把文件内容嵌入消息。Hermes 声明 Codex 可以读取哪些输入文件、应写出哪些输出文件；HCO 负责路径边界、文件完整性、完成条件和结果清单。Codex 仍在已注册项目的工作目录中读写文件。

## 1. 适用范围

协议支持两类正式工作流：

1. **A -> A：** Hermes 交付文档 A，Codex 就地编辑 A。A 同时出现在 `input` 和 `output` 中。
2. **A -> B：** Hermes 交付文档 A，Codex 读取 A 并生成文档 B。A 出现在 `input`，B 出现在 `output`。

当前 delivery sidecar 只把 outbox 中的文本 `content` 发送到 Zulip。它不会自动上传 artifact 文件；Zulip 消息中的 manifest 摘要用于报告路径、状态、字节数和哈希。

## 2. 能力协商

Hermes 插件和 HCO 在 bridge compatibility 请求中声明 `artifact_manifest`。发送带 `artifacts` 的 `DISPATCH` 前，应确认协商结果包含该能力。协议主版本仍为 bridge protocol version 1。

## 3. Wire Schema

`artifacts` 是 `SEMANTIC` 事件中 `DISPATCH` 对象的可选字段。存在时必须恰好包含 `input` 和 `output` 两个数组；两个数组都必须存在，但可以为空。

```json
{
  "type": "DISPATCH",
  "instruction": "Read the request and write the result.",
  "constraints": [],
  "acceptanceCriteria": ["The result artifact is written."],
  "reminders": [],
  "objective": { "mode": "NEW" },
  "artifacts": {
    "input": [
      {
        "artifactId": "request",
        "path": "docs/request.md",
        "kind": "document",
        "mimeType": "text/markdown",
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "maxBytes": 1048576
      }
    ],
    "output": [
      {
        "artifactId": "result",
        "path": "docs/result.md",
        "kind": "document",
        "mimeType": "text/markdown",
        "maxBytes": 1048576,
        "required": true
      }
    ]
  }
}
```

Manifest 和 entry 都是严格对象：未知字段会被拒绝。每个方向最多 16 个 entry，同一方向内的 `artifactId` 必须唯一；同一个 ID 可以分别出现在 `input` 和 `output` 中。

### Entry 字段

| 字段 | 必填 | 约束 | 语义 |
|---|---|---|---|
| `artifactId` | 是 | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | 当前方向内稳定且唯一的逻辑 ID |
| `path` | 是 | 非空，UTF-8 最多 4096 bytes，不含 C0/C1 控制字符 | 相对于项目 canonical `cwd` 的文件路径；绝对路径只有在仍位于该 `cwd` 内时才可接受，并会规范化为相对路径 |
| `kind` | 是 | 去除首尾空白后非空，UTF-8 最多 128 bytes，不含 C0/C1 控制字符 | 业务类型，例如 `document`、`report`、`dataset` |
| `mimeType` | 是 | 去除首尾空白后非空，UTF-8 最多 128 bytes，不含 C0/C1 控制字符 | 内容类型，例如 `text/markdown`、`application/json` |
| `maxBytes` | 否 | 整数，范围 `1..67108864` | 文件大小上限；默认 `1048576`（1 MiB） |
| `required` | 否 | boolean | 默认 `true`；当前只影响 output 是否阻塞完成 |
| `sha256` | 否 | 64 位十六进制字符串，不区分大小写 | 预期文件内容 SHA-256；规范化为小写后比较 |

必须注意：当前实现要求所有 input 在 dispatch 时都存在且有效，即使 input entry 显式写了 `required: false` 也不会变成可选输入。可选语义只应用于 output。

## 4. 路径和文件安全边界

Artifact 根目录固定为项目注册配置中的 canonical `projects[].cwd`，调用方不能另行指定根目录。HCO 会执行以下检查：

- 拒绝空路径、NUL、换行及其他 C0/C1 控制字符。
- 拒绝任何值为 `..` 的路径段，以及规范化后逃逸项目 `cwd` 的路径。
- 拒绝把项目 `cwd` 本身声明为文件。
- 只接受普通文件；目录、设备、socket 和末端 symlink 均无效。
- 解析真实路径后再次确认文件仍在项目 `cwd` 内。
- 打开文件时使用 `O_NOFOLLOW`（平台支持时），并用 `fstat` 校验设备号和 inode，读取后以实际字节数计算大小和 SHA-256。

这些检查缩小了常见路径穿越、symlink 和 TOCTOU 风险，但 artifact 目录仍应遵循项目级权限和单写者约束。不要把 secret 或项目外部敏感文件放入 manifest。

## 5. 生命周期和状态

每个 entry 在 SQLite `artifact_contracts` 表中按 `submission_id + direction + artifact_id` 持久化。状态包括：

| 状态 | 含义 |
|---|---|
| `declared` | 已声明，尚未完成文件观察；通常是刚接收的 output |
| `verified` | 普通文件存在，未超过大小限制，且可选哈希匹配 |
| `missing` | 文件不存在 |
| `mismatch` | 文件存在，但与声明的 `sha256` 不一致 |
| `invalid` | 非普通文件、symlink、越界、过大、读取不安全或无法作为有效 artifact |

### 输入阶段

HCO 在调用 Codex 前规范化 manifest 并校验所有 input。输入通过后，manifest 的路径和输入观察结果与 execution intent 一起进入持久状态，artifact 列表也会写入 Codex prompt。Prompt 只包含契约元数据，不内嵌文件内容。

任何 input 的 `missing`、`invalid` 或 `mismatch` 都会拒绝 dispatch，不会启动 Codex turn。

### 输出阶段

Codex turn 到达 terminal completion 后，HCO 校验全部 output：

- required output 只有 `verified` 才允许 submission 完成。
- required output 为 `missing`、`mismatch` 或 `invalid` 时，submission 进入 `reconciliation_needed`，不写 terminal output，也不创建最终 outbox delivery。
- optional output 缺失或无效不会阻塞完成，其实际状态仍保留在结果 manifest 中。
- required output 补齐后，可以用原 terminal completion source 重试；校验通过后只完成和投递一次。

## 6. 完成回执

完成后的 outbox payload 保留原有文本 `content`，并附带规范化后的 `artifacts`：

```json
{
  "content": "Done.\n\nArtifact manifest:\n- input request: docs/request.md (...)\n- output result: docs/result.md (...)",
  "artifacts": {
    "schemaVersion": 1,
    "baseDir": "/canonical/project/path",
    "input": [],
    "output": [
      {
        "artifactId": "result",
        "path": "docs/result.md",
        "kind": "document",
        "mimeType": "text/markdown",
        "required": true,
        "maxBytes": 1048576,
        "state": "verified",
        "sha256": "<observed-sha256>",
        "bytes": 1234
      }
    ]
  }
}
```

`expectedSha256` 只在请求声明了预期哈希时出现；`sha256` 和 `bytes` 是 HCO 对实际文件的观察值。不要依赖 Zulip 自动取得文件内容，应通过受信任的项目文件访问方式读取已验证路径。

## 7. 工作流示例

### A -> A：就地编辑

输入可携带编辑前哈希，output 不应复用编辑前哈希，否则编辑后的文件必然 `mismatch`。

```json
{
  "input": [{
    "artifactId": "document",
    "path": "docs/A.md",
    "kind": "document",
    "mimeType": "text/markdown",
    "sha256": "<sha256-before-edit>"
  }],
  "output": [{
    "artifactId": "document",
    "path": "docs/A.md",
    "kind": "document",
    "mimeType": "text/markdown",
    "required": true
  }]
}
```

### A -> B：生成新文档

```json
{
  "input": [{
    "artifactId": "request",
    "path": "docs/A.md",
    "kind": "request",
    "mimeType": "text/markdown"
  }],
  "output": [{
    "artifactId": "result",
    "path": "docs/B.md",
    "kind": "result",
    "mimeType": "text/markdown",
    "required": true
  }]
}
```

## 8. 错误码

| 错误码 | 阶段 | 含义 |
|---|---|---|
| `ARTIFACT_MANIFEST_INVALID` | dispatch | schema、字段、数量、路径或根目录无效 |
| `ARTIFACT_INPUT_MISSING` | dispatch | 声明的 input 不存在 |
| `ARTIFACT_INPUT_INVALID` | dispatch | input 不是安全的普通文件、过大或不可安全读取 |
| `ARTIFACT_INPUT_HASH_MISMATCH` | dispatch | input 实际 SHA-256 与声明值不一致 |

Output 未满足契约通常表现为 artifact 状态和 `reconciliation_needed`，而不是创建一条成功回执。运维人员应检查项目文件和 `artifact_contracts`，修复文件后触发正常 reconciliation；不要通过直接修改 SQLite 绕过校验。

## 9. 兼容性规则

- 未协商 `artifact_manifest` 的旧插件不得发送 `artifacts`。
- 没有 `artifacts` 的现有 `DISPATCH` 行为不变。
- Artifact 协议属于 Option C App Server 生产链路；旧 Runner/tmux 任务文件机制不是该协议的一部分。
- 增加字段或改变 required/input 语义需要新的协议能力或 schema 版本，不能静默放宽当前严格 schema。
