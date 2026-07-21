# HCO 六轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施
**背景**: 五轮修复后复审发现 4 个新问题。P1×2 为实质性问题，P2/P3 为单行修复，合并本轮处理。

---

## 问题确认

### P1-a：含空白字符的 question ID 会使交互永久停留在 partial

`service.js:529-533` 的 `userInputQuestions` 过滤条件只检查非空字符串，接受含空格的 ID（如 `deploy target`）。  
但多问题解析（`service.js:579`）用 `/^(\S+)\s+([\s\S]+)$/` 取首个非空白 token 作 questionId，空格会被截断为 `deploy`，再也无法命中 `deploy target`。  
交互持久化后永远处于 partial 状态，无法提交完整 answers map。

### P1-b：符号链接 CWD 仍可绕过跨项目拦截

`plugin.py:415` 使用 `os.path.normpath(cwd)` 做文本规范化，但 HCO `config.js:121` 用 `realpathSync()` 取 canonical 路径。  
若项目配置为符号链接 `/alias/beta`，HCO 解析为 `/canonical/beta`，Codex 在 `/canonical/beta` 中运行，指令引用 `/canonical/beta/src/main.py`，但 plugin 比对的是 `/alias/beta`，检测不到外部引用，跨项目拦截被绕过。

### P2：混合非法 missingQuestionIds 被部分接受（fail-open）

`plugin.py:1057` 用 `valid_missing = [q for q in missing if _is_safe_question_id(q)]` 过滤后继续，当 `["q2","bad\nvalue"]` 出现时，静默丢弃 `bad\nvalue`，只告诉用户还缺 `q2`。  
partial 状态已表明协议集合不可信，应 fail-closed：任何元素不合法时返回协议错误。

### P3：BridgeUserError 未限定为 HTTP 4xx

`bridge_client.py:151` 对任意非200状态+白名单码都抛 `BridgeUserError`，包括 HTTP 500。  
服务端故障信息可能直接暴露给用户，违背第五轮方案中"4xx 用户错误"的契约。

---

## 修复范围

### 必改文件

1. `hco/service.js` — P1-a：单 token ID 约束
2. `hco/turn-controller.js` — P1-a：renderer 对不可寻址 ID 的提示
3. `plugin/hermes-codex-bridge/plugin.py` — P1-b：realpath + P2：fail-closed
4. `plugin/hermes-codex-bridge/bridge_client.py` — P3：4xx 限定
5. `test/hco-service.test.js` — P1-a 测试
6. `test/hermes_plugin_contract_test.py` — P1-b + P2 + P3 测试
7. `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md`

---

## A. P1-a：question ID 必须是单 token

### A1. service.js — userInputQuestions 增加单 token 过滤

**文件**: `hco/service.js:529-533`

```javascript
function userInputQuestions(interaction) {
  const questions = interaction?.request?.questions;
  return Array.isArray(questions)
    ? questions.filter(
        (question) =>
          isPlainObject(question) &&
          typeof question.id === "string" &&
          question.id.trim() &&
          !/\s/.test(question.id)   // 必须是单 token——不含空白
      )
    : [];
}
```

### A2. service.js — ANSWER 路径：若原始 questions 含不可寻址 ID，拒绝并提示

在 ANSWER 分支开头（`const questions = userInputQuestions(interaction)` 之后）：

```javascript
if (command.type === "ANSWER") {
  const allRawQuestions = Array.isArray(interaction?.request?.questions)
    ? interaction.request.questions.filter(
        (q) => isPlainObject(q) && typeof q.id === "string" && q.id.trim()
      )
    : [];
  const questions = userInputQuestions(interaction);   // single-token filter
  if (allRawQuestions.length > 0 && questions.length < allRawQuestions.length) {
    // 部分或全部问题 ID 含空白，命令行无法寻址
    throw stateError(
      "INTERACTION_QUESTION_ID_INVALID",
      "Some question IDs contain whitespace and cannot be addressed via command. Use App Server UI."
    );
  }
  // 后续逻辑不变
```

**理由**：若 server 下发含空白 ID 的问题，所有 ANSWER 尝试都直接拒绝、给出明确提示，而不是陷入无法完成的 partial 状态。

### A3. turn-controller.js — Renderer 标注不可寻址 ID

在 `item/tool/requestUserInput` 分支渲染每个 question 时：

```javascript
const isAddressable = typeof question.id === "string" && question.id && !/\s/.test(question.id);
if (questions.length > 1 && isAddressable) {
  parts.push(`回答「${header}」: \`/codex answer ${interactionId} ${question.id} <你的回答>\``);
} else if (questions.length > 1 && !isAddressable) {
  parts.push(`回答「${header}」: _ID 含空白字符，无法通过命令回答，请使用 App Server UI。_`);
}
```

### A4. 测试要求

`test/hco-service.test.js`：

1. questions 中所有 ID 含空白 → ANSWER 命令抛 `INTERACTION_QUESTION_ID_INVALID`，不调用 backend
2. questions 中部分 ID 含空白 → 同上
3. questions 中所有 ID 均为单 token → 正常进入 partial / 完成路径（回归）

---

## B. P1-b：_load_project_cwd_map 用 realpath 解析符号链接

**文件**: `plugin/hermes-codex-bridge/plugin.py:400-420`

```python
def _load_project_cwd_map(config_path: str) -> dict[str, str]:
    """Read {project_id: cwd} mapping from HCO config file (best-effort).
    Attempts os.path.realpath() to match HCO's realpathSync(); falls back
    to normpath if the path does not exist or realpath fails.
    Root path (os.sep) is excluded as too broad.
    """
    try:
        raw = _read_owner_file(config_path, MAX_CONFIG_BYTES)
        config = json.loads(raw.decode("utf-8"))
        projects = config.get("projects", [])
        if not isinstance(projects, list):
            return {}
        result: dict[str, str] = {}
        for p in projects:
            if not isinstance(p, dict):
                continue
            pid = p.get("projectId")
            cwd = p.get("cwd")
            if isinstance(pid, str) and pid and isinstance(cwd, str) and cwd:
                try:
                    resolved = os.path.realpath(cwd)   # 解析符号链接，对齐 realpathSync
                except Exception:
                    resolved = os.path.normpath(cwd)
                normalized = os.path.normpath(resolved)
                if normalized and normalized != os.sep:
                    result[pid] = normalized
        return result
    except Exception:
        return {}
```

**已知限制更新**：`realpath()` 仅在目标路径存在时可靠解析。若 CWD 路径在插件加载时不存在（例如容器/挂载延迟），回退为 `normpath`；此边界在修复记录中说明。

### B1. 测试要求

`test/hermes_plugin_contract_test.py`：

1. 配置 symlink CWD `symlink_beta → /canonical/beta/`，指令引用 `/canonical/beta/src/main.py` → 应被拒绝（注意：测试需要本地能够创建符号链接；若环境不支持，改用 `monkeypatch` mock `os.path.realpath`）
2. `normpath` 尾斜杠测试回归（已有，确认不被破坏）

---

## C. P2：fail-closed — missingQuestionIds 全部合法才继续

**文件**: `plugin/hermes-codex-bridge/plugin.py:1057-1060`

```python
valid_missing = [q for q in missing if _is_safe_question_id(q)]
if len(valid_missing) != len(missing):   # 有非法元素 → fail-closed
    return "Codex bridge protocol error."
if not valid_missing:
    return "Codex bridge protocol error."
missing_list = "、".join(valid_missing)
```

### C1. 测试要求

`test/hermes_plugin_contract_test.py`：

1. `missingQuestionIds: ["q2", "bad\nvalue"]` → 返回协议错误（not "已记录部分回答"）
2. `missingQuestionIds: ["q2", 7]` → 返回协议错误
3. `missingQuestionIds: ["q2", "q3"]`（全合法）→ 正常返回 partial 提示（回归）

---

## D. P3：BridgeUserError 限定为 HTTP 4xx

**文件**: `plugin/hermes-codex-bridge/bridge_client.py:151-152`

```python
if 400 <= status < 500 and error["code"] in USER_FACING_ERROR_CODES:
    raise BridgeUserError(error["code"], error["message"])
raise BridgeProtocolError("bridge rejected request")
```

### D1. 测试要求

`test/hermes_plugin_contract_test.py`：

1. `HTTP 400 + INTERACTION_DECISION_INVALID` → `BridgeUserError`（回归）
2. `HTTP 500 + INTERACTION_DECISION_INVALID` → `BridgeProtocolError`（新增）

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

### P1-a
- [ ] 含空白 ID 的 questions（全部或部分）→ ANSWER 命令抛 `INTERACTION_QUESTION_ID_INVALID`，不写 durable
- [ ] 单 token ID 的多问题交互正常进入 partial / 完成路径（回归）
- [ ] Renderer 对含空白 ID 的 question 显示"使用 App Server UI"而非 `/codex answer` 命令

### P1-b
- [ ] realpath 解析后，符号链接 CWD `/alias/beta` 的项目，指令引用 `/canonical/beta/src/main.py` 被拒绝
- [ ] 尾斜杠测试回归通过

### P2
- [ ] `["q2", "bad\nvalue"]` 返回协议错误，不显示 partial 成功
- [ ] 全合法元素路径回归通过

### P3
- [ ] HTTP 500 + 白名单码 → `BridgeProtocolError`（不暴露 server 错误）
- [ ] HTTP 400 + 白名单码 → `BridgeUserError`（回归）

---

## 注意事项

1. A2 中的"原始 questions"检查只看 ID 字段是否含空白，不影响其他字段校验。
2. P1-b 的 `realpath` 在路径不存在时回退 `normpath`，不抛错——best-effort。
3. 不提交 git commit / push。
4. 测试 symlink 场景时，若沙箱不支持符号链接，用 `monkeypatch.setattr(os.path, "realpath", ...)` 替代。
