# `project_local/v1` 人工验收方案

## 1. 目的

这份方案用于在真实 Hermes + HCO + Codex App Server + Zulip 环境中验收项目内文档中转。

它验证的是：HCO 能否在频道绑定项目目录内创建一次独立 exchange，给 Codex 提供输入，接收 Codex 输出，并在成功或失败时把人话结果交回 Hermes。

它**不**证明 `managed/v1` 已经可用，也不证明 `.hco/exchanges/` 是 sandbox。当前 App Server 的 managed file exchange capability 必须仍为 `supported: false`；`project_local/v1` 继承普通 Codex 项目权限。

## 2. 测试边界

- 只使用临时测试项目或项目副本，不使用生产源码、密钥、客户数据和真实交易数据。
- 测试项目必须由 HCO project registry 注册，并由 Zulip 频道绑定到该项目的 canonical root。
- 每轮使用新的频道话题和唯一 `RUN_ID`，避免与历史 work、topic binding 或 Codex thread 混淆。
- 人工发送必须由真实 Boss 用户在 Zulip Web/App 中完成；不能使用 Jarvis bot 自发消息伪造人工入站。
- API、日志和文件检查只用于回查证据，不能把内部路径、session key、token 或凭据发回 Zulip。
- 测试过程中不要手工修改数据库状态、`status.json` 的身份字段或 HCO ledger；需要故障注入时只改测试 exchange 内的文件。

## 3. 环境准备

### 3.1 一次性准备

在测试项目中准备一个不敏感的输入文件：

```text
manual-fixtures/request.md
```

内容示例：

```markdown
# Manual fixture

Run ID: <RUN_ID>
Requested fact: report the package manager and list the top-level test command.
```

确认：

1. `project registry` 中的项目 `cwd` 是该测试项目的 canonical root。
2. Zulip 频道与该项目一一绑定；测试话题使用 `hco-project-local-<RUN_ID>`。
3. HCO、Hermes 和 Codex App Server 都已启动，且 App Server 能创建普通无文件 turn。
4. 测试用户能看到 Jarvis 回复；Jarvis bot 不会把自己发出的消息再次当作 Boss 入站。
5. 记录本轮 HCO/Hermes/Codex 版本、配置文件摘要、Gateway/HCO PID 和测试项目绝对路径。凭据只记录“已配置”，不复制内容。

### 3.2 自动测试先行

人工测试前先在仓库根目录运行：

```bash
npm run project-local-exchange:test
npm run hco-service:test
npm run turn-controller:test
npm run bridge:test
npm run check
```

完整回归再运行：

```bash
npm run verify
```

Hermes 插件合同测试使用项目指定虚拟环境：

```bash
/Users/hula/Projects/hermesAgent/venv/bin/python3 -m pytest -q test/hermes_plugin_contract_test.py
```

自动测试通过后，保存命令、退出码、测试总数和失败输出；自动测试失败时先修复或记录为 `BLOCKED`，不要继续用人工“看起来能用”替代失败的合同测试。

### 3.3 能力核对

从只读 `/v1/compatibility` 响应或 HCO 日志确认：

```json
{
  "projectLocalExchange": {
    "profile": "project_local/v1",
    "supported": true,
    "maximumBytesPerExchange": 67108864,
    "maximumFilesPerExchange": 8
  }
}
```

同时从 App Server backend capability 确认：

```json
{
  "fileExchange": {
    "supported": false
  }
}
```

若 managed 能力被报告为 `true`，立即停止验收，记为 `BLOCKED`，因为这属于错误的能力声明，不是通过。

## 4. 证据目录和记录格式

每轮建立独立证据目录，例如：

```text
docs/superpowers/test-artifacts/YYYY-MM-DD-project-local-manual/<RUN_ID>/
```

至少保存：

- `test-result.md`：每个用例的 PASS/FAIL/BLOCKED、时间和结论。
- `commands.txt`：执行过的只读命令和退出码；不要保存 token。
- `compatibility.json`：脱敏后的 capability 响应。
- `zulip-evidence.json`：消息 ID、话题、发送/回复时间、rendered HTML 摘要。
- `exchange-list.txt`：exchange 相对路径和文件列表。
- `status-before.json`、`status-after.json`：只保存测试 exchange 的状态文件。
- 必要的截图或日志片段；原始日志中的凭据、Authorization header 和完整 transcript 必须删掉。

每个用例记录以下字段：

```text
case_id:
run_id:
started_at:
zulip_stream/topic:
source_message_id:
work_request_id:
objective_id:
codex_call_id:
exchange_relative_root:
expected:
actual:
evidence_files:
status: PASS | FAIL | BLOCKED | NOT RUN
operator:
```

不要用“没有看到回复”作为唯一证据；必须同时回查 Zulip 消息、HCO 状态/日志和 exchange 文件事实。

## 5. 人工用例

### PL-00 版本、路由和能力预检

**操作**

1. 在测试话题发送一条普通无文件、无副作用请求：`PL-00-<RUN_ID>：只回复 READY。不要调用 Codex。`
2. 查询 `/v1/compatibility`，保存脱敏响应。
3. 回查 project registry 和 route snapshot，确认 canonical root 是测试项目，而不是仓库根或调用方传入路径。

**预期**

- 普通对话仍由 Hermes 处理，不创建 project-local exchange。
- `project_local/v1` 为 `supported: true`；managed `fileExchange` 为 `supported: false`。
- 路由缺失或歧义时，Hermes 明确询问/拒绝，不创建 exchange。

### PL-01 普通输入和结果输出

**发送**

```text
PL-01-<RUN_ID>：请读取项目中的 manual-fixtures/request.md，按其中要求检查项目，只做只读检查。
请把简短结论写入文档交换的 Markdown 结果，并把使用的命令和事实写入 JSON 证据。
不需要强隔离，不要修改源码、input/ 或其他项目文件。
完成后告诉我 workRequestId、objectiveId 和结果是否已通过 HCO 校验。
```

**操作和证据**

1. 保存 Hermes 的接单回复、`workRequestId`、`objectiveId`、`codexCallId`。
2. 从 HCO 日志或状态查询取得 `exchange_relative_root`，不能猜路径。
3. 检查以下文件存在：

   ```text
   .hco/exchanges/v1/<work_id>/<exchange_id>/input/context.md
   .hco/exchanges/v1/<work_id>/<exchange_id>/input/task-contract.json
   .hco/exchanges/v1/<work_id>/<exchange_id>/output/result.md
   .hco/exchanges/v1/<work_id>/<exchange_id>/output/evidence.json
   .hco/exchanges/v1/<work_id>/<exchange_id>/status.json
   ```

4. 用 `sha256sum`/`shasum -a 256` 与 manifest 对照输入和输出哈希。
5. 回查 Zulip：最终只出现一条面向 Boss 的综合结果；不得把 Codex 原始完成事件直接贴回频道。

**通过条件**

- `status.json` 最终为 `AVAILABLE` 或等价终态；错误码为空。
- `context.md` 和 `task-contract.json` 不含调用方任意输出路径、session key、权限身份或平台投递地址。
- 输出是普通文件，大小、MIME、UTF-8/JSON 和 SHA-256 均通过。
- 项目源码 `git status` 除预期测试文件外没有被任务修改。

### PL-02 输出命名与调用方路径隔离

**操作**

1. 在同一测试话题发起一个声明两个 Markdown 和两个 JSON 结果的任务；可在任务描述中提到“希望写到 `caller/result.md`”，这是负面测试输入。
2. 等任务接单后回查 HCO 送给 Codex 的 prompt 和 `task-contract.json`。

**预期**

- HCO 生成 `result.md`、`result-002.md`、`evidence.json`、`evidence-002.json`。
- `caller/result.md` 不出现在 Codex prompt、task contract 或 HCO 产出的 output manifest 中。
- 模型不能通过自选文件名覆盖已有结果；文件名只用于观察，manifest 才是事实。

### PL-03 输入被修改

**操作**

1. 发起一个明确等待 30 秒再读取 `manual-fixtures/request.md` 的只读任务。
2. 从 HCO 日志取得本次 exchange 根后，等待 Codex 已接单，再修改该 exchange 的 `input/context.md`，只添加一行 `MANUAL-MUTATION-<RUN_ID>`。
3. 等待 turn 进入终态，查询 work 和 Zulip 回复。

**预期**

- 任务不得被判定为成功。
- 结果进入 `reconciliation_needed`/失败处置，并返回 `PROJECT_LOCAL_INPUT_CHANGED`。
- `status.json` 保存 `ERROR` 和该错误码；原始输出不发布为可信结果。
- Hermes 向 Boss 说明输入在执行期间变化，并给出下一步；不能静默重跑。

测试完成后删除本次临时 exchange 或保留为证据，不要恢复性修改数据库。

### PL-04 必需输出缺失

**操作**

1. 发起一个只要求读取输入并回复文字、明确“不创建 `result.md`”的任务。
2. 等 Codex turn 完成后查询 HCO 终态。

**预期**

- HCO 返回 `PROJECT_LOCAL_OUTPUT_MISSING`。
- work 不进入可信 `completed`，不产生成功 manifest 或成功通知。
- Hermes 会要求模型补做、改用无文件回答或向 Boss 解释缺失原因；不得把 Codex 的“我已完成”当成文件成功。

### PL-05 非法 JSON 输出

**操作**

1. 发起要求生成 JSON 证据的任务。
2. 在 exchange 创建后、turn 结束前，将 `output/evidence.json` 写为 `{not-json}`，或让测试 Codex 明确生成非法 JSON。
3. 等 HCO 验收。

**预期**

- HCO 返回 `PROJECT_LOCAL_OUTPUT_INVALID`。
- 不发布该 JSON，不把目录存在或 `status.json=AVAILABLE` 当作成功。
- Hermes 的最终消息包含“证据格式非法”和可执行下一步。

### PL-06 目录和文件边界

**操作**

1. 用只读测试项目验证 HCO 能创建 `.hco/exchanges/v1/`。
2. 在维护窗口把测试项目的 `.hco` 或 `exchanges` 临时替换为普通文件/符号链接，再发起文档任务。
3. 恢复测试项目后重新发起一次正常任务。

**预期**

- HCO 返回 `PROJECT_LOCAL_EXCHANGE_UNAVAILABLE`，不跟随符号链接、不写到 canonical root 外。
- 普通无文件 Codex 任务仍能执行。
- 恢复后新 exchange 能正常创建；旧失败不能自动被当作成功。

### PL-07 重试和并发不覆盖

**操作**

1. 对同一话题连续提交两个语义相同但 `RUN_ID` 不同的文档任务。
2. 同时观察 HCO 日志、work 状态和 `.hco/exchanges/v1/<work_id>/`。

**预期**

- 每次尝试有独立 `exchange_id` 和独立目录。
- 后一次失败或重试不能覆盖前一次的 `context.md`、`task-contract.json`、输出或 `status.json`。
- 同一 canonical root 的写任务仍受单写 lane/lease 约束；不能出现两个写者都被报告为成功。
- 重复消息不会创建第二个 work/turn/最终回复。

### PL-08 重启后的事实恢复

**操作**

1. 启动一个需要等待的只读文档任务，在 Codex turn 运行期间重启 HCO 或 bridge（仅维护窗口）。
2. 重启后先查询原 `workRequestId`，再观察 Codex 事件和 exchange。

**预期**

- HCO 继续使用原 work、原 Codex thread/turn 和原 exchange；不得因为重启创建第二个 exchange 或重新提交未知副作用。
- 已存在的 manifest/ledger 是恢复依据；孤立目录本身不能触发新 work 或 Hermes wake。
- 事实未知时显示 `UNKNOWN/RECONCILING`，不得伪装成成功或失败。

### PL-09 强隔离必须 fail closed

**操作**

1. 发起一个明确要求“不可修改输入、跨 Agent 隔离或秘密材料处理”的任务。
2. 观察 Hermes/HCO 的接单结果和 capability。

**预期**

- 当前 managed capability 不支持时，返回 `FILE_EXCHANGE_UNSUPPORTED`。
- 不偷偷降级到 `project_local/v1`，不创建声称受管的目录，不生成虚假的 seal/attestation。
- 普通无文件任务不受影响。

### PL-10 普通无文件回归

**发送**

```text
PL-10-<RUN_ID>：只读取 package.json 的 scripts 字段，直接在回复中告诉我，不要创建或修改任何文件。
```

**预期**

- 普通 Codex turn 正常执行；相对执行前的目录快照不新增 exchange。历史 `.hco/exchanges/v1/` 可以存在，不能据此误判本用例失败。
- HCO 不强行注入文件协议，不要求模型理解 exchange 文件名。
- 结果仍由 Hermes 负责最终投递。

### PL-11 Agent 发起文档任务

**发送**

```text
PL-11-<RUN_ID>：请委派一个只读 Agent 检查 manual-fixtures/request.md，并让它调用 Codex 完成文档结果；Agent 先向你汇报，你再只向我综合回复。不得修改源码。
```

**预期**

- Agent 使用与用户调用相同的 HCO 文档协议，但不绕过 Hermes 原生 Agent 父子汇报。
- Codex 原始结果先回 Agent；Hermes/Jarvis 决定是否继续、补做或交付。
- Zulip 不出现 Agent 直接投递的重复原始结果。
- work、agent session、codex call 和 exchange 的绑定不跨话题串线。

### PL-12 Git 忽略规则

**操作**

在测试项目运行：

```bash
git -C <PROJECT_ROOT> check-ignore -v .hco/exchanges/v1/<work_id>/<exchange_id>/status.json
git -C <PROJECT_ROOT> diff -- .gitignore
```

**预期**

- `.hco/exchanges/` 由项目本地 `info/exclude` 忽略。
- 共享 `.gitignore` 不被 HCO 自动改写。
- 非 Git 项目不因缺少 Git metadata 而阻止 project-local exchange。

## 6. 失败处理和判定

### FAIL

出现以下任一项即失败：

- output 使用了调用方或模型自选路径，或覆盖了已有 exchange。
- 输入变化、输出缺失/非法、目录越界没有稳定错误码。
- HCO 把 `project_local/v1` 宣称为 sandbox/managed，或把 App Server managed capability 报为 supported。
- HCO/重试创建重复 work、turn、Codex 结果或 Zulip 最终消息。
- 普通无文件任务因文档协议失败而被阻断。

### BLOCKED

以下情况不能算通过，也不能算实现失败：

- 没有可用的真实 Zulip 用户会话、Codex App Server 或测试项目路由。
- 无法在不破坏生产数据的前提下注入指定故障。
- Android 真机/App 不可用；不要用移动视口网页冒充 Android 验收。

记录阻塞原因、已完成的自动测试和需要的外部条件，等待补测。

## 7. 最终验收标准

### 自动化

- 专项 `project-local-exchange` 测试覆盖正常路径、固定命名、路径隔离、上限、UTF-8/MIME、symlink、冲突、状态更新。
- HCO service、turn controller、bridge、plugin 合同测试全部通过。
- `npm run check`、`npm run verify` 无失败；Python 合同测试使用指定虚拟环境通过。

### 人工

- `PL-00`、`PL-01`、`PL-02`、`PL-03`、`PL-04`、`PL-05`、`PL-06`、`PL-07`、`PL-08`、`PL-09`、`PL-10`、`PL-11`、`PL-12` 均为 PASS，或按第 6 节记录为有证据的 BLOCKED。
- 每个 PASS 都有 Zulip 消息、HCO 状态/日志和 exchange 文件三类证据。
- 任何 managed 强隔离用例在当前 capability 下都明确 fail closed，不得以“目录存在”替代 enforcement。

## 8. 结果模板

```markdown
# Project-local manual acceptance result

- Date:
- Release/commit:
- Hermes version:
- HCO version:
- Codex App Server version:
- Zulip stream/topic:
- Project root:
- Operator:

| Case | Status | work/objective/call | Exchange | Evidence | Note |
| --- | --- | --- | --- | --- | --- |
| PL-00 |  |  |  |  |  |
| PL-01 |  |  |  |  |  |
| PL-02 |  |  |  |  |  |
| PL-03 |  |  |  |  |  |
| PL-04 |  |  |  |  |  |
| PL-05 |  |  |  |  |  |
| PL-06 |  |  |  |  |  |
| PL-07 |  |  |  |  |  |
| PL-08 |  |  |  |  |  |
| PL-09 |  |  |  |  |  |
| PL-10 |  |  |  |  |  |
| PL-11 |  |  |  |  |  |
| PL-12 |  |  |  |  |  |

## Automatic checks

- Commands:
- Exit codes:
- Node test count:
- Python test count:
- Known failures:

## Conclusion

- project_local/v1:
- managed/v1:
- Remaining blockers:
```
