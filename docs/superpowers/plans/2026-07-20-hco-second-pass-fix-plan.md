# HCO 二轮缺陷修复方案

**日期**: 2026-07-20  
**状态**: 待 Codex 实施  
**背景**: 第一轮修复后，Codex 复审提出 4 个有效问题。经人工审核，4 条均成立，需要二轮修复。

---

## 目标

修补第一轮修复中的漏洞与死分支，使以下能力可靠成立：

1. 跨项目污染拦截覆盖 Codex 最终输入的全部 DISPATCH 文本字段。
2. 项目名匹配不再误伤普通英文，尤其是真实项目名 `ASK`。
3. 默认 interaction 通知在缺少 `availableDecisions` 时仍可操作，并区分 approval 与 user input。
4. BridgeUnavailableError 的 CONTINUE objectiveId 提示分支真正生效。

---

## 问题确认

### P1-1：跨项目拦截可被 constraints / acceptanceCriteria / reminders 绕过

**成立。**

当前 `plugin.py` 只检查 `semantic["instruction"]`。但 `hco/service.js:150-157` 的 `composeSemanticInput()` 会把以下字段全部拼进 Codex 最终输入：

- `instruction`
- `constraints[]`
- `acceptanceCriteria[]`
- `reminders[]`

因此外部项目名或 cwd 放进后三类字段仍会进入 Codex。

### P1-2：项目名匹配误伤普通英文

**成立。**

当前 `_instruction_references_foreign_project()` 对所有 projectId 做不区分大小写的单词匹配。真实项目名包含 `ASK`，所以以下正常英文会被误判：

- `Ask the user before changing the API.`
- `Do not ask for approval.`

### P1-3：默认 interaction 通知仍不保证可操作

**成立。**

`turn-controller.js` 只有 `availableDecisions` 存在时才生成 `/codex approve` 命令。`test/option-c-e2e.test.js:321` 的 E2E 场景没有提供 `availableDecisions`，因此仍可能没有可执行审批命令。

同一个 renderer 还处理 `item/tool/requestUserInput`，但现在始终显示“审批请求”，也没有 `/codex answer <id> <text>` 提示。

### P2-1：CONTINUE objectiveId 提示分支是死代码

**成立。**

合法 semantic 顶层 `type` 始终是 `DISPATCH`，继续任务由 `semantic["objective"]["mode"] == "CONTINUE"` 表示。当前代码检查 `wire_semantic["type"] == "CONTINUE"`，永远不会命中。

---

## 修复范围

### 必改文件

1. `plugin/hermes-codex-bridge/plugin.py`
2. `hco/turn-controller.js`
3. `test/hermes_plugin_contract_test.py`
4. `test/option-c-e2e.test.js` 或 `test/turn-controller.test.js`（至少覆盖默认 renderer 通知正文）
5. `docs/superpowers/records/2026-07-19-hco-fix-record.md`（追加二轮修复记录，或新建 2026-07-20 记录）

---

## 具体实施方案

## A. 修复跨项目拦截覆盖范围与误报

### A1. 重命名/替换检测函数

当前函数：

```python
def _instruction_references_foreign_project(instruction, trusted_pid, project_cwd_map): ...
```

替换为语义级检测函数，例如：

```python
def _semantic_references_foreign_project(
    semantic: dict, trusted_pid: str, project_cwd_map: dict[str, str]
) -> tuple[str, str] | None:
    """Return (foreign_project_id, field_name) when DISPATCH text references
    a foreign project by cwd or explicit project reference phrase.
    """
```

### A2. 检查全部 DISPATCH 文本字段

只对 `semantic["type"] == "DISPATCH"` 执行。

需要扫描：

```python
texts = [
    ("instruction", semantic["instruction"]),
    *[("constraints", item) for item in semantic["constraints"]],
    *[("acceptanceCriteria", item) for item in semantic["acceptanceCriteria"]],
    *[("reminders", item) for item in semantic["reminders"]],
]
```

任一字段命中 foreign project，就返回 `(pid, field)`。

### A3. 匹配规则调整：cwd 强匹配，projectId 保守匹配

#### CWD 规则

对所有外部项目的 cwd 做**精确子串匹配**：

```python
if cwd and cwd in text:
    return pid, field
```

这类命中强信号，应直接拒绝。

#### ProjectId 规则

不要再做 case-insensitive 普通词匹配。

使用**大小写敏感**且必须带“项目/仓库/repo/project/repository/cwd/working directory”等上下文词的显式项目引用匹配。

建议 helper：

```python
_PROJECT_CONTEXT_WORDS_BEFORE = r"(?:project|repo|repository|cwd|working directory|项目|仓库|工作目录)"
_PROJECT_CONTEXT_WORDS_AFTER = r"(?:project|repo|repository|项目|仓库)"

def _mentions_project_id(text: str, pid: str) -> bool:
    escaped = re.escape(pid)
    # pid after marker: "project ASK", "project: ASK", "项目 ASK", "仓库：ASK"
    before = rf"(?<![A-Za-z0-9_-]){_PROJECT_CONTEXT_WORDS_BEFORE}\s*[:：]?\s*{escaped}(?![A-Za-z0-9_-])"
    # pid before marker: "ASK project", "ASK repo", "ASK 项目", "ASK 仓库"
    after = rf"(?<![A-Za-z0-9_-]){escaped}(?![A-Za-z0-9_-])\s*{_PROJECT_CONTEXT_WORDS_AFTER}"
    return re.search(before, text) is not None or re.search(after, text) is not None
```

**重要**：不要传 `re.IGNORECASE`。这能避免 `Ask the user...` 命中 `ASK`。

如果担心中文或大小写输入，可后续再做白名单式增强；本轮优先避免误杀。

### A4. 拦截点

当前拦截在 `hco_dispatch_handler`：

```python
if wire_semantic["type"] == "DISPATCH":
    wire_semantic["topicModeAction"] = None
    instruction = wire_semantic.get("instruction", "")
    foreign = _instruction_references_foreign_project(...)
```

改成：

```python
if wire_semantic["type"] == "DISPATCH":
    wire_semantic["topicModeAction"] = None
    conflict = _semantic_references_foreign_project(wire_semantic, context.project_id, project_cwd_map)
    if conflict is not None:
        foreign, field = conflict
        return (
            f"⚠️ 指令上下文冲突：任务路由到 **{context.project_id}**，"
            f"但 {field} 引用了 **{foreign}**。已拒绝执行。\n"
            "请重新在正确的项目频道发起请求，或联系 Jarvis PM。"
        )
```

### A5. 测试要求

在 `test/hermes_plugin_contract_test.py` 增加或调整测试：

1. `test_dispatch_foreign_project_reference_in_constraints_is_rejected`
   - 路由到 `stockprofits`
   - `instruction` 正常
   - `constraints = ["必须在 ASK 仓库中操作"]`
   - 期望：返回“指令上下文冲突”，`BridgeClient.submit` 未调用

2. `test_dispatch_foreign_project_reference_in_reminders_is_rejected`
   - 外部 cwd 放在 `reminders`：`/Users/hula/workspace/ASK`
   - 期望拒绝

3. `test_dispatch_ask_common_english_does_not_false_positive`
   - foreign projectId = `ASK`
   - `instruction = "Ask the user before changing the API."`
   - 期望通过，不拒绝

4. `test_dispatch_explicit_ask_project_reference_is_rejected`
   - `instruction = "请在 ASK 仓库中执行"`
   - 期望拒绝

---

## B. 修复默认交互通知可操作性

### B1. defaultInteractionRenderer 按 method 分支

当前 renderer 未看 `interaction.method`。需要按以下三类处理：

1. `item/commandExecution/requestApproval`
2. `item/fileChange/requestApproval`
3. `item/tool/requestUserInput`

### B2. Approval 通知规则

对于 `requestApproval` 类方法：

- 标题：`⚠️ **审批请求**`
- 展示：
  - `reason`（如有）
  - `cwd`（如有）
  - `command`（如有，截断）
  - `approvalId` / `itemId`（如有）
  - `allowedResponderIds`（至少显示 `允许响应者 ID: ...`，因为 renderer 没有用户名映射）
- 可选操作：
  - 如果 `request.availableDecisions` 存在且非空：从其中提取 choice
  - 如果缺失或为空：默认给出 `accept` 和 `cancel`

生成命令：

```text
/codex approve <interactionId> accept
/codex approve <interactionId> cancel
```

注意：对象类型 decision（如 `{"acceptWithExecpolicyAmendment": {...}}`）使用其 key 作为 choice。

### B3. User input 通知规则

对于 `item/tool/requestUserInput`：

- 标题：`💬 **输入请求**`
- 展示：
  - `reason` / `prompt` / `question` / `message` 中存在的字段
  - `toolName` 或 `itemId`（如有）
  - `allowedResponderIds`
- 必须生成命令模板：

```text
/codex answer <interactionId> <你的回答>
```

不要显示 `/codex approve`。

### B4. 兜底规则

如果 method 异常或 request 字段不完整，至少返回：

```text
Interaction requested.

_reply token_: `<interactionId>`

审批: `/codex approve <interactionId> accept`
取消: `/codex approve <interactionId> cancel`
输入: `/codex answer <interactionId> <你的回答>`
```

### B5. 测试要求

至少新增/修改以下测试：

1. 在 `test/option-c-e2e.test.js` 的 pending approval 测试中：
   - claim outbox 或读取 `pending` 创建的 outbox payload
   - 断言 `payload.content` 包含：
     - `pending.interactionId`
     - `/codex approve ${pending.interactionId} accept`
     - `/codex approve ${pending.interactionId} cancel`
     - `npm test`

2. 在 `test/turn-controller.test.js` 增加 `requestUserInput` 场景：
   - 调用 `handleInteractionRequest`，method = `item/tool/requestUserInput`
   - request 中提供 `prompt` 或 `question`
   - claim outbox
   - 断言 content 包含 `/codex answer <interactionId> <你的回答>`，且不包含 `/codex approve`

---

## C. 修复 CONTINUE objectiveId 死分支

### C1. 当前错误逻辑

```python
if wire_semantic.get("type") == "CONTINUE":
    _obj = wire_semantic.get("objective", {})
```

这永远不会命中，因为顶层 type 是 `DISPATCH`。

### C2. 正确逻辑

```python
_obj = wire_semantic.get("objective")
if isinstance(_obj, dict) and _obj.get("mode") == "CONTINUE" and isinstance(_obj.get("objectiveId"), str):
    _obj_hint = f" 任务：{_obj['objectiveId']}。"
```

### C3. 测试要求

在 `test/hermes_plugin_contract_test.py` 中新增或修改现有 BridgeUnavailableError 测试：

- 构造 DISPATCH semantic：

```python
{
  "type": "DISPATCH",
  "instruction": "继续任务",
  "constraints": [],
  "acceptanceCriteria": [],
  "reminders": [],
  "objective": {"mode": "CONTINUE", "objectiveId": "objective-123"},
}
```

- mock `BridgeClient.submit` 抛 `BridgeUnavailableError`
- 期望返回文本包含：
  - `任务可能已提交但响应丢失`
  - `objective-123`

---

## D. 文档更新

更新或新建修复记录：

建议新建：

`docs/superpowers/records/2026-07-20-hco-second-pass-fix-record.md`

内容必须包含：

1. 四个复审问题的结论：均成立
2. 每个问题的修复文件、函数、测试
3. 测试运行命令与结果
4. 仍未解决的限制（例如：renderer 无法把 userId 转成 Zulip @用户名）

---

## 验证命令

实施完成后运行：

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
```

如时间允许，再运行：

```bash
node --test test/*.test.js
```

---

## 验收标准

### 跨项目拦截

- [ ] `instruction`、`constraints`、`acceptanceCriteria`、`reminders` 任一字段引用 foreign cwd 均被拒绝
- [ ] `instruction`、`constraints`、`acceptanceCriteria`、`reminders` 任一字段显式引用 foreign projectId + 项目上下文词均被拒绝
- [ ] 普通英文 `Ask the user before changing the API.` 不会因为 foreign projectId `ASK` 被拒绝
- [ ] `请在 ASK 仓库中执行` 仍会被拒绝

### Interaction 通知

- [ ] requestApproval 缺少 `availableDecisions` 时仍生成 `/codex approve <id> accept` 与 `/codex approve <id> cancel`
- [ ] requestApproval 包含 `availableDecisions` 时按实际 decisions 生成命令
- [ ] requestUserInput 生成 `/codex answer <id> <你的回答>`
- [ ] requestUserInput 不显示“审批请求”，不生成 approve 命令
- [ ] E2E 测试验证默认通知正文

### BridgeUnavailableError

- [ ] `objective.mode == CONTINUE` 时响应异常提示包含 objectiveId
- [ ] 非 CONTINUE 时仍返回通用“任务可能已提交但响应丢失”提示

---

## 注意事项

1. 不要修改 HCO 路由或数据库 schema。
2. 不要改 `delivery_sidecar.py`，投递侧原样发送 content 是正确职责划分。
3. 不要恢复 case-insensitive 项目名匹配。
4. 不要把 renderer 设计成依赖 Zulip 用户名映射；当前只掌握 numeric userId。
5. 不要提交 git commit，由上层操作者统一提交。
