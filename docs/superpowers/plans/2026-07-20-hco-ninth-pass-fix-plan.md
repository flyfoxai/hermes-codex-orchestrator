# HCO 九轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施
**背景**: 八轮修复后复审发现 3 个 P1、2 个 P2、1 个 P3，本轮合并处理。

---

## 问题确认

### P1-1：常见项目引用仍可绕过检测

当前 `_mentions_project_id` 覆盖：紧邻上下文词（project/repo/仓库）、介词（in/to/use/switch to/check/在/切换到）。
未覆盖的自然语言表达：
- 所有格：`beta's failing tests`、`beta 的测试`、`update beta's CI`
- 动词直接宾语：`Fix beta`、`Work on beta`、`修复 beta`、`更新 beta`
四个 DISPATCH 语义字段均调用该函数，因此仍可实际绕过拦截。

### P1-2：超长交互通知被永久丢弃

`delivery_sidecar.py` `MAX_CONTENT_BYTES = 65_536`（64 KB）。  
`_validated_claim` 在 content 超限时返回 None，`process_claim` 随即调用 `nack("CLAIM_INVALID", retryable=False)`，interaction 永远停在 pending，用户永远收不到回答入口。  
Renderer 无界展开 questions、options 和描述，实测可生成 70 000+ 字节内容，超过上限。

### P1-3：审批通知未完整呈现授权范围

当前只展示 `reason`、`cwd` 和 400 字符的 `command`。  
App Server schema 中还存在 `commandActions`、`networkApprovalContext`、`additionalPermissions`、`proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments`（文件审批还有 `grantRoot`）。  
这些字段代表实际授权范围的扩展权限。当它们存在时，用户执行 `accept` 可能接受了远超 `reason`+`command` 所展示的权限。  
此外 `command` 仍有截断，原始 Markdown 也未转义。

### P2-1：可纠正业务错误仍被隐藏为协议错误

`serviceError()` 创建普通 Error（非 `stateError`），`aclError()` 同理。  
`bridge/server.js normalizeError` 的 `isStateError` 检查对 serviceError 返回 false，因此 `INTERACTION_NOT_FOUND`、`INTERACTION_TARGET_MISMATCH`、`OBJECTIVE_REQUIRED`、`ACL_FORBIDDEN` 等均变成 HTTP 500 BRIDGE_INTERNAL → `BridgeProtocolError` → "Codex bridge protocol error."  
用户无法从错误中得到任何操作建议。

### P2-2：CWD 映射丢失 alias 和根目录项目身份

`_load_project_cwd_map` 用 `realpath` 覆盖原始 cwd，导致：
1. 用户指令引用配置中的符号链接 alias（如 `/alias/beta/src`），而 map 里只有 canonical `/canonical/beta` → 不命中
2. `cwd: /` 的项目被整个过滤出 map，后续 `_semantic_references_foreign_project` 不会为该项目运行 `_mentions_project_id` 检测

项目身份检测（projectId 提及）不应依赖 cwd 是否可用于路径匹配。

### P3-1：Python 与 Node 的 question ID 空白规则不一致

`_is_safe_question_id` 只拒绝 ASCII 控制字符（`< 32` 和 `\x7F`），不拒绝普通空格（ASCII 32）、NBSP（U+00A0）及纯空白字符串。  
Node 的 `isSafeQuestionId` 用 `/[\s\x00-\x1F\x7F]/` 涵盖 Unicode 空白。  
版本漂移或异常响应可通过 Python 层的 fail-closed 校验，造成不一致。

---

## 修复范围

### 必改文件

1. `plugin/hermes-codex-bridge/plugin.py` — P1-1 + P2-2 + P3-1
2. `hco/turn-controller.js` — P1-2 + P1-3
3. `hco/service.js` — P2-1（指定 serviceError 改 stateError）
4. `hco/bridge/server.js` — P2-1（INPUT_STATE_CODES + CONFLICT_STATE_CODES 扩充）
5. `plugin/hermes-codex-bridge/bridge_client.py` — P2-1（USER_FACING_ERROR_CODES 扩充）
6. `test/hermes_plugin_contract_test.py` — P1-1 + P2-2 + P3-1 测试
7. `test/turn-controller.test.js` — P1-2 + P1-3 测试
8. `test/hco-service.test.js` — P2-1 端到端测试
9. `docs/superpowers/records/2026-07-20-hco-ninth-pass-fix-record.md`

---

## A. P1-1：扩展项目引用检测

### A1. `plugin.py` `_mentions_project_id`

在现有四条规则后新增两条：

**英文所有格**：
```python
english_possessive = (
    rf"{project_boundary_before}{escaped}{project_boundary_after}"
    rf"'s\b"   # "beta's tests"
)
```

**动词直接宾语（英文，大小写不敏感）**：
```python
english_verb_object = (
    rf"(?i:(?<![A-Za-z])(?:fix|work on|work in|update|test|check|run|debug|deploy|build|lint|review)\s+)"
    rf"{project_boundary_before}{escaped}{project_boundary_after}"
)
```

**中文所有格 "的"**：
```python
chinese_possessive = (
    rf"{project_boundary_before}{escaped}{project_boundary_after}"
    rf"\s*的"   # "beta 的测试"、"beta的配置"
)
```

**注意**：
- 英文所有格 `'s` 是精确匹配，不需要 `re.IGNORECASE`（pid 本身已区分大小写）
- 中文"的"用于所有格时必须紧跟 pid
- 英文动词直接宾语规则只对介词后的单词生效，词边界保护确保 `refix` 不命中 `fix`

### A2. 测试要求

`test/hermes_plugin_contract_test.py`：

1. `instruction="Fix beta's failing tests."` → 被拒绝（英文所有格）
2. `instruction="Work on beta and update its CI."` → 被拒绝（动词宾语）
3. `instruction="修复 beta 的测试。"` → 被拒绝（中文所有格）
4. `instruction="debug beta"` → 被拒绝（动词宾语）
5. `instruction="Fix alpha's tests."` → 当前项目 alpha 不拒绝（无误报）

---

## B. P1-2：超长通知截断

### B1. `hco/turn-controller.js`

在 renderer 函数末尾、`return` 前，对 `content` 做字节长度检查：

```javascript
const MAX_CONTENT_UTF8_BYTES = 60_000; // 保留 ~5KB 余量

function toCompactContent(interactionId, method) {
  const isApproval = method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval";
  const parts = ["⚠️ **交互通知过大，已生成精简版**", "",
    `_reply token_: \`${interactionId}\``];
  if (isApproval) {
    parts.push(`- \`/codex approve ${interactionId} accept\``);
    parts.push(`- \`/codex approve ${interactionId} cancel\``);
  } else {
    parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
  }
  parts.push("", "_完整详情请通过 App Server UI 查看。_");
  return parts.join("\n");
}

// 在 try 块末尾，return 前：
if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_UTF8_BYTES) {
  content = toCompactContent(interactionId, method);
}
```

### B2. 测试要求

`test/turn-controller.test.js`：

1. `questions: [{id:"q1", options: Array(200).fill({label:"opt", description:"a".repeat(300)})}]` → 通知字节 ≤ 60,000，包含 reply token 和 `/codex answer` 命令
2. 正常大小通知不受影响（回归）

---

## C. P1-3：审批通知扩展权限警告

### C1. `hco/turn-controller.js`

定义"扩展权限字段"列表：
```javascript
const EXTENDED_PERMISSION_FIELDS = [
  "commandActions",
  "networkApprovalContext",
  "additionalPermissions",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
  "grantRoot"
];

const hasExtendedPermissions = EXTENDED_PERMISSION_FIELDS.some(
  (field) => requestObject[field] != null
);
```

如果 `hasExtendedPermissions`：
- 从 `choices` 中**过滤掉** `accept` 和 `acceptForSession`（仅保留 `decline`/`cancel`/其他拒绝型决策）
- 在操作列表前添加警告：
  ```
  ⚠️ 此审批请求包含扩展权限（commandActions / networkApprovalContext 等），无法通过命令行安全完整呈现。
  如需批准，请通过 **App Server UI** 操作。
  ```

```javascript
const safeChoices = hasExtendedPermissions
  ? choices.filter(({ key }) => !["accept", "acceptForSession"].includes(key))
  : choices;
```

### C2. 测试要求

`test/turn-controller.test.js`：

1. `request: {reason:"...", command:"...", commandActions:[...]}` → 通知不含 `/codex approve <id> accept`，含 "扩展权限" 警告
2. `request: {networkApprovalContext:{host:"example.com"}}` → 同上
3. `request: {reason:"...", command:"..."}` (无扩展权限) → 正常含 accept 命令（回归）

---

## D. P2-1：可纠正业务错误统一暴露

### D1. `hco/service.js`：改用 stateError

以下错误码从 `serviceError` 改为 `stateError`（仅修改这些调用，其余 serviceError 不变）：
- `INTERACTION_NOT_FOUND`
- `INTERACTION_TARGET_MISMATCH`
- `OBJECTIVE_REQUIRED`
- `OBJECTIVE_NOT_FOUND`（在 interactionCommand 中）

```javascript
import { stateError } from "./state/reducer.js"; // 已存在
// ...
throw stateError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
throw stateError("INTERACTION_TARGET_MISMATCH", "Interaction target does not match.");
throw stateError("OBJECTIVE_REQUIRED", "An objective is required.");
```

对于 ACL 错误：`aclError` 也需要可见。检查 `hco/acl.js` 中 `aclError` 的创建方式，若与 stateError 不兼容，将 `ACL_FORBIDDEN` 错误也改为 `stateError`。

### D2. `hco/bridge/server.js`：扩充 INPUT_STATE_CODES

```javascript
const INPUT_STATE_CODES = new Set([
  "FACT_INVALID",
  "OUTBOX_CLAIM_INVALID",
  "OUTBOX_ACK_INVALID",
  "OUTBOX_NACK_INVALID",
  "INTERACTION_DECISION_INVALID",
  "INTERACTION_COMMAND_MISMATCH",
  "INTERACTION_QUESTION_ID_INVALID",
  "INTERACTION_NOT_FOUND",         // 新增
  "INTERACTION_TARGET_MISMATCH",   // 新增
  "OBJECTIVE_REQUIRED",            // 新增
]);
const CONFLICT_STATE_CODES = new Set([
  ...现有...,
  "OBJECTIVE_NOT_FOUND",           // 新增（已有但可能不在这里）
  "ACL_FORBIDDEN",                 // 新增
]);
```

**注意**：`ACL_FORBIDDEN` 是 409 Conflict（重复的授权请求），其他是 400 Input errors。根据语义分配。

### D3. `bridge_client.py`：扩充 USER_FACING_ERROR_CODES

```python
USER_FACING_ERROR_CODES = frozenset({
    "INTERACTION_DECISION_INVALID",
    "INTERACTION_COMMAND_MISMATCH",
    "INTERACTION_QUESTION_ID_INVALID",
    "INTERACTION_NOT_FOUND",        # 新增
    "INTERACTION_TARGET_MISMATCH",  # 新增
    "OBJECTIVE_REQUIRED",           # 新增
    "OBJECTIVE_NOT_FOUND",          # 新增
    "ACL_FORBIDDEN",                # 新增
})
```

### D4. 测试要求

`test/hco-service.test.js`：
- 对不存在的 interaction 使用 APPROVE → 用户收到包含 "does not exist" 的消息，而非 "protocol error"

---

## E. P2-2：CWD 映射保留 alias 和根目录项目身份

### E1. `plugin.py`：将 map 值改为 `(config_cwd, canonical_cwd)` 元组

```python
def _load_project_cwd_map(config_path: str) -> dict[str, tuple[str | None, str | None]]:
    """Return {project_id: (config_cwd_normalized, canonical_cwd)} for all projects.
    
    config_cwd_normalized: normpath of the raw config cwd; None if cwd is root.
    canonical_cwd: realpath-resolved canonical path; None if root or same as config.
    
    Both paths are used for CWD conflict detection. Projects with cwd=/ are retained
    for projectId-based detection even though they are excluded from path matching.
    """
    try:
        ...
        for p in projects:
            ...
            if isinstance(pid, str) and pid and isinstance(cwd, str) and cwd:
                config_normalized = os.path.normpath(cwd)
                try:
                    canonical = os.path.normpath(os.path.realpath(cwd))
                except Exception:
                    canonical = config_normalized

                if config_normalized == os.sep:
                    # Root path: include project for ID detection, exclude from path matching
                    result[pid] = (None, None)
                elif canonical == os.sep:
                    result[pid] = (config_normalized, None)
                else:
                    result[pid] = (
                        config_normalized if config_normalized != os.sep else None,
                        canonical if canonical != config_normalized else None
                    )
    ...
```

### E2. `_semantic_references_foreign_project` 使用新结构

```python
def _semantic_references_foreign_project(semantic, trusted_pid, project_cwd_map):
    ...
    for pid, (config_cwd, canonical_cwd) in project_cwd_map.items():
        if pid == trusted_pid:
            continue
        for field, text in texts:
            if not isinstance(text, str):
                continue
            # CWD path matching (skipped if both are None, i.e. root project)
            if config_cwd and _cwd_referenced(text, config_cwd):
                return pid, field
            if canonical_cwd and _cwd_referenced(text, canonical_cwd):
                return pid, field
            # projectId mention detection always runs
            if _mentions_project_id(text, pid):
                return pid, field
    return None
```

**效果**：
- 引用 `/alias/beta/src`：config_cwd = `/alias/beta` → `_cwd_referenced` 命中
- 引用 `/canonical/beta/src`：canonical_cwd = `/canonical/beta` → `_cwd_referenced` 命中
- 项目 `cwd: /`：config/canonical 均为 None，跳过路径匹配，但仍运行 `_mentions_project_id`

### E3. 测试要求

`test/hermes_plugin_contract_test.py`：
1. 配置 alias cwd，指令引用 alias 子路径 → 被拒绝
2. 配置 alias cwd，指令引用 canonical 子路径 → 被拒绝
3. 配置 `cwd: /` 的项目，指令包含其 projectId 上下文引用 → 被拒绝（projectId 检测仍工作）
4. 配置 `cwd: /` 的项目，指令引用 `/anywhere/path` → 不触发 cwd 规则（已知限制，不拒绝）

---

## F. P3-1：Python _is_safe_question_id 加空白检查

### F1. `plugin.py:861-870`

```python
import unicodedata  # 可能已导入或不需要；用 str.split() 检测即可

def _is_safe_question_id(value: object) -> bool:
    """Non-empty string after strip, max 256 bytes, no control chars or whitespace."""
    if type(value) is not str:
        return False
    if not value.strip():  # empty or whitespace-only (aligns with Node's trim check)
        return False
    # Check for any whitespace character (Unicode-aware, matches Node's /\s/)
    if any(c.isspace() for c in value):
        return False
    try:
        if len(value.encode("utf-8")) > 256:
            return False
    except Exception:
        return False
    return all(ord(character) >= 32 and character != "\x7f" for character in value)
```

**说明**：
- `value.strip()` 空白检查覆盖 NBSP 等 Unicode 空白（`str.strip()` 在 Python 中处理 Unicode 空白）
- `c.isspace()` 检查每个字符是否为空白（含 NBSP、各种 Unicode 空白）
- 原有控制字符检查保留作为双重保护

### F2. 测试要求

`test/hermes_plugin_contract_test.py`（或 Python 单元测试）：
1. `_is_safe_question_id(" q1")` → False（含空格）
2. `_is_safe_question_id(" q1")` → False（NBSP）
3. `_is_safe_question_id("  ")` → False（纯空白）
4. `_is_safe_question_id("q1")` → True（回归）

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

### P1-1
- [ ] `Fix beta's failing tests.` 拒绝（英文所有格）
- [ ] `Work on beta and update its CI.` 拒绝（动词宾语）
- [ ] `修复 beta 的测试。` 拒绝（中文所有格）
- [ ] `Fix alpha's tests.`（当前项目）不拒绝（无误报）

### P1-2
- [ ] 超大 questions/options → 通知 ≤ 60,000 字节，保留 reply token 和操作命令
- [ ] 正常大小通知不受影响

### P1-3
- [ ] 含 `commandActions` 等扩展权限字段 → 通知无 accept/acceptForSession，有 App Server UI 引导
- [ ] 无扩展权限字段 → accept 命令仍正常显示（回归）

### P2-1
- [ ] `/codex approve <id> <choice>` 对不存在 interaction → 用户看到可读错误，不是 "protocol error"
- [ ] 类似对 TARGET_MISMATCH、ACL_FORBIDDEN 有可读错误

### P2-2
- [ ] 引用 alias 子路径 → 被拒绝
- [ ] `cwd: /` 项目 projectId 引用 → 被拒绝（projectId 检测工作）
- [ ] `cwd: /` 不触发路径规则

### P3-1
- [ ] 含空格的 question ID 被 Python 拒绝
- [ ] NBSP 被拒绝
- [ ] 纯空白字符串被拒绝

---

## 注意事项

1. P2-1 只将有用户操作意义的错误改为 stateError（不改 HCO_SERVICE_CLOSED 等内部错误）。
2. P1-3 的扩展权限检测是**保守策略**（有扩展字段则隐藏 accept）——在信息不完整时保护安全，不引入新的授权逻辑。
3. P2-2 的 map 值结构变化需要同步更新所有使用 `project_cwd_map` 的地方（`_semantic_references_foreign_project` 和测试中的 closure mutation）。
4. 不提交 git commit / push。
5. 测试 cwd alias 场景时若沙箱不支持符号链接，用 monkeypatch mock `os.path.realpath`。
