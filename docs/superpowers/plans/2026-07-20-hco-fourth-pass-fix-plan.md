# HCO 四轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待 Codex 审核后实施
**背景**: 三轮修复后复审发现 3 个新问题，全部成立，需四轮根因修复。

---

## 问题确认

### P1-a：外部项目子路径可绕过跨项目拦截

**成立。**

**文件**: `plugin/hermes-codex-bridge/plugin.py:452`

当前 `_cwd_referenced` 的 lookahead：
```python
pattern = rf"(?<![A-Za-z0-9_./-]){re.escape(cwd)}(?![A-Za-z0-9_./-])"
```

因为 lookahead 把 `/` 也列为"不续接"字符，所以：
- `/workspace/beta` **无法**匹配文本 `Edit /workspace/beta/src/main.py`
- `projectId` 语境规则对路径引用也不会命中

最小反例确认为 False。污染指令会继续提交。

### P1-b：非法审批值及错误命令类型会被永久记为已回答

**成立。**

**文件**: `hco/service.js:498`（`resolveApprovalDecision`）与 `hco/service.js:531`（`interactionCommand`）

两个子问题：

**子问题 1**：`resolveApprovalDecision` 回退行为不安全
```javascript
return choiceKey; // availableDecisions 存在但找不到时，任意字符串当 decision
```
`/codex approve <id> acceppt`（拼写错误）→ 写入 `{decision: "acceppt"}`，随后 `interaction` 被标 delivered，正确答案无法再提交。

**子问题 2**：`interactionCommand` 不校验命令类型与 interaction.method 是否匹配：
- ANSWER 命令打 `requestApproval` interaction → `questions.length === 0` → 落到末尾 else → 发 `{text: ...}` → App Server schema 错误，永久写入
- APPROVE 命令打 `requestUserInput` interaction → 跳过 ANSWER 分支 → 取 `resolveApprovalDecision` → 发 `{decision: ...}` → schema 错误，永久写入

### P2：multi-question partial 回执在插件层显示 unsupported

**成立。**

**文件**: `plugin/hermes-codex-bridge/plugin.py:1024-1026`

```python
if action == "interaction.answer":
    if status not in {"answered", "response_uncertain", "response_retryable"}:
        return _unsupported_bridge_result()  # partial 走到这里
```

用户第一次回答多问题 interaction 后，HCO 返回 `status:"partial"` + `missingQuestionIds`，但插件显示"当前插件不支持的操作结果"，用户看不到还缺哪些题目。现有 Python 测试未覆盖此端到端路径。

---

## 修复范围

### 必改文件

1. `plugin/hermes-codex-bridge/plugin.py` — CWD 子路径匹配 + partial 渲染
2. `hco/service.js` — approvalDecision 校验 + 方法类型校验
3. `test/hermes_plugin_contract_test.py` — CWD 子路径测试 + partial 渲染测试
4. `test/hco-service.test.js` — 非法 choice 拒绝测试 + 方法不匹配拒绝测试
5. `docs/superpowers/records/2026-07-20-hco-fourth-pass-fix-record.md` — 新建四轮修复记录

---

## A. 修复 CWD 子路径检测

### A1. `_cwd_referenced()` 正确处理子路径

**文件**: `plugin/hermes-codex-bridge/plugin.py:449-453`

子路径跟随 `/` 同样视为命中：

```python
def _cwd_referenced(text: str, cwd: str) -> bool:
    if not cwd or not text:
        return False
    escaped = re.escape(cwd)
    # 匹配 cwd 精确出现 OR cwd 后跟子路径 /
    # 前缀仍不命中：/workspace/a 不匹配 /workspace/alpha
    pattern = rf"(?<![A-Za-z0-9_./-]){escaped}(?:/|(?![A-Za-z0-9_./-]))"
    return re.search(pattern, text) is not None
```

逻辑：
- `(?![A-Za-z0-9_./-])` — 原有的"非路径续接"检查（防止 `/workspace/a` 误命中 `/workspace/alpha`）
- `(?:/)` — **新增**：子路径开头的 `/` 也视为合法命中边界
- 两者用 `(?:/|...)` 组合，满足其一即命中

**验证矩阵**（需测试）：

| 文本 | cwd | 期望 |
|------|-----|------|
| `Edit /workspace/beta/src/main.py` | `/workspace/beta` | True（子路径命中）|
| `see /workspace/alpha/README.md` | `/workspace/a` | False（前缀不命中）|
| `在 /workspace/beta 中执行` | `/workspace/beta` | True（精确边界）|
| `/workspace/beta-staging/app.py` | `/workspace/beta` | False（`-` 是路径续接）|
| `clone /workspace/beta` | `/workspace/beta` | True（末尾 EOL）|

### A2. 测试要求

在 `test/hermes_plugin_contract_test.py` 增加/修改子路径测试：

```python
@pytest.mark.asyncio
async def test_cwd_subpath_triggers_rejection(tmp_path, monkeypatch):
    """子路径引用外部 cwd 应被拒绝"""
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    contaminated = {
        "type": "DISPATCH",
        "instruction": "Edit /workspace/beta/src/main.py to fix the bug.",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
    }
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, contaminated, snapshot)
    hook = manager._hooks["pre_gateway_dispatch"][0]
    cwd_map = inspect.getclosurevars(hook).nonlocals["project_cwd_map"]
    cwd_map.update({"alpha": "/workspace/alpha", "beta": "/workspace/beta"})

    submissions = []
    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}
    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=801)))
    result = await _call_hco_tool(manager, token, contaminated)
    assert submissions == [], "子路径引用外部 cwd 应被拒绝"
    assert "指令上下文冲突" in result

@pytest.mark.asyncio
async def test_cwd_prefix_still_not_false_positive(tmp_path, monkeypatch):
    """/workspace/a 不应命中引用 /workspace/alpha 的指令"""
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    clean = {
        "type": "DISPATCH",
        "instruction": "Read /workspace/alpha/README.md for details.",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
    }
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, clean, snapshot)
    hook = manager._hooks["pre_gateway_dispatch"][0]
    cwd_map = inspect.getclosurevars(hook).nonlocals["project_cwd_map"]
    cwd_map.update({"alpha": "/workspace/alpha", "a": "/workspace/a"})

    submissions = []
    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}
    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=802)))
    result = await _call_hco_tool(manager, token, clean)
    assert len(submissions) == 1, "引用自己的子路径不应被误拦"
    assert "指令上下文冲突" not in result
```

---

## B. 修复非法 choice 拒绝 + 方法类型校验

### B1. `resolveApprovalDecision`：找不到时抛错而非回退

**文件**: `hco/service.js:498-510`

```javascript
function resolveApprovalDecision(interaction, choiceKey) {
  const available = interaction?.request?.availableDecisions;
  if (Array.isArray(available) && available.length > 0) {
    for (const decision of available) {
      if (typeof decision === "string" && decision === choiceKey) return decision;
      if (isPlainObject(decision)) {
        const keys = Object.keys(decision);
        if (keys.length === 1 && keys[0] === choiceKey) return decision;
      }
    }
    // availableDecisions 存在但找不到 key：拒绝，不写入 durable
    const valid = available.map((d) =>
      typeof d === "string" ? d : (isPlainObject(d) ? Object.keys(d)[0] : null)
    ).filter(Boolean);
    throw serviceError(
      "INTERACTION_DECISION_INVALID",
      `Invalid decision '${choiceKey}'. Valid choices: ${valid.join(", ")}.`
    );
  }
  // availableDecisions 不存在或为空：按裸字符串回退（旧数据兼容）
  return choiceKey;
}
```

**理由**：
- `availableDecisions` 非空时，operator 必须选有效值；错字拒绝，不写入 durable
- `availableDecisions` 为空/不存在时维持原有回退（避免破坏已有 E2E 测试路径）

### B2. `interactionCommand`：校验命令类型与 interaction.method

**文件**: `hco/service.js:519-593`

在 ACL 校验后、业务逻辑前加入方法校验：

```javascript
// 在 acl.require 之后插入
const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);
const isApprovalInteraction = approvalMethods.has(interaction.method);
const isUserInputInteraction = interaction.method === "item/tool/requestUserInput";

if (command.type === "APPROVE" && !isApprovalInteraction) {
  throw serviceError(
    "INTERACTION_COMMAND_MISMATCH",
    `Cannot use /codex approve on a '${interaction.method}' interaction.`
  );
}
if (command.type === "ANSWER" && !isUserInputInteraction) {
  throw serviceError(
    "INTERACTION_COMMAND_MISMATCH",
    `Cannot use /codex answer on a '${interaction.method}' interaction.`
  );
}
```

**效果**：
- 方法不匹配时抛错，不进入后续逻辑，不写入 durable settlement
- 错误消息明确提示正确操作方式

### B3. 测试要求

在 `test/hco-service.test.js` 增加：

1. `resolveApprovalDecision` 场景：
   - `availableDecisions: ["accept","decline"]`，提交 `"acceppt"` → 抛 `INTERACTION_DECISION_INVALID`
   - `availableDecisions: []`（空数组），提交任意字符串 → 使用回退，不报错

2. 方法不匹配场景：
   - approval interaction + ANSWER 命令 → 抛 `INTERACTION_COMMAND_MISMATCH`
   - requestUserInput interaction + APPROVE 命令 → 抛 `INTERACTION_COMMAND_MISMATCH`

两种场景都断言 `backend.respondToInteraction` 未被调用（不写入 durable）。

---

## C. 修复 partial 状态渲染

### C1. `_render_bridge_result` 增加 partial 分支

**文件**: `plugin/hermes-codex-bridge/plugin.py:1024-1038`

```python
if action == "interaction.answer":
    if status == "partial":
        # 多问题累积未完成，提示还缺哪些题
        project_id = result.get("projectId")
        interaction_id = result.get("interactionId")
        missing = result.get("missingQuestionIds")
        if (
            type(project_id) is str and project_id
            and type(interaction_id) is str and interaction_id
            and type(missing) is list and missing
        ):
            missing_list = "、".join(str(q) for q in missing if type(q) is str)
            return (
                f"已记录部分回答。项目：{project_id}。交互：{interaction_id}。"
                f"还需回答：{missing_list}。"
                f"继续用 /codex answer {interaction_id} <questionId> <你的回答> 提交。"
            )
        return "Codex bridge protocol error."
    if status not in {"answered", "response_uncertain", "response_retryable"}:
        return _unsupported_bridge_result()
    project_id = result.get("projectId")
    objective_id = result.get("objectiveId")
    interaction_id = result.get("interactionId")
    if not all(
        type(value) is str and value
        for value in (project_id, objective_id, interaction_id)
    ):
        return "Codex bridge protocol error."
    return (
        f"交互回复状态：{status}。项目：{project_id}。任务：{objective_id}。"
        f"交互：{interaction_id}。"
    )
```

### C2. 测试要求

在 `test/hermes_plugin_contract_test.py` 增加端到端 partial 路径测试：

```python
@pytest.mark.asyncio
async def test_partial_answer_renders_missing_question_ids(tmp_path, monkeypatch):
    """multi-question 首次回答应渲染 partial 状态和缺少的 question IDs"""
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    dispatch = _dispatch()
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, dispatch, snapshot)

    async def submit(_self, event):
        return {
            "schemaVersion": 1,
            "status": "partial",
            "action": "interaction.answer",
            "projectId": "alpha",
            "objectiveId": "objective-1",
            "interactionId": "interaction-1",
            "missingQuestionIds": ["q2", "q3"],
        }
    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=901)))
    result = await _call_hco_tool(manager, token, dispatch)

    assert "已记录部分回答" in result
    assert "q2" in result
    assert "q3" in result
    assert "/codex answer" in result
```

---

## 验证命令

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js
```

---

## 验收标准

### CWD 子路径
- [ ] `Edit /workspace/beta/src/main.py` 命中外部 cwd `/workspace/beta`，被拒绝
- [ ] `/workspace/alpha/README.md` 不命中 `/workspace/a`（前缀仍不误报）
- [ ] `/workspace/beta-staging` 不命中 `/workspace/beta`（`-` 仍是续接）

### 非法 choice / 方法不匹配
- [ ] `availableDecisions` 存在但 choice 不在其中 → 抛 `INTERACTION_DECISION_INVALID`，不写 durable
- [ ] ANSWER 打 approval interaction → 抛 `INTERACTION_COMMAND_MISMATCH`，不写 durable
- [ ] APPROVE 打 requestUserInput interaction → 抛 `INTERACTION_COMMAND_MISMATCH`，不写 durable
- [ ] `availableDecisions` 不存在/为空 → 按裸字符串回退（旧数据兼容路径）

### partial 渲染
- [ ] `status:"partial"` 返回包含 missingQuestionIds 的可读提示
- [ ] 提示包含 `/codex answer <id> <questionId> <text>` 格式的继续指引
- [ ] Python E2E 测试覆盖此路径

---

## 注意事项

1. B1 改动只在 `availableDecisions` **非空**时严格拒绝；空数组和不存在两种情况继续回退，保持旧数据兼容。
2. B2 方法校验放在 ACL 之后，避免泄露 interaction 存在与否。
3. C1 中 `partial` 分支先于 `not in {answered, ...}` 检查，不影响现有状态处理。
4. 不修改 Bridge 命令解析 grammar，不提交 git commit。
5. 测试 fixture 使用真实 schema 形状（含 `availableDecisions`、`method` 字段）。
