# HCO 十轮缺陷修复方案 v3

**日期**: 2026-07-21  
**状态**: 待实施  
**背景**: 九轮修复后审查发现 8 个问题（4P1+2P2+2P3）。v1 方案经 Explore agent 审查发现 9 个阻塞项，v2 Codex 生成失败。本版本基于实际代码结构重写。

---

## 修复策略

**关键原则**：
1. 不假设不存在的常量/函数 - 所有新增定义明确列出
2. 修改现有函数时保持签名兼容
3. Service 层强制 > Renderer 层过滤
4. 错误类型统一：user-facing 用 stateError
5. 先补测试（RED），再实现（GREEN）

---

## 问题清单与对应修复

### P1-1: 扩展权限审批仍能通过命令行执行

**问题**: `turn-controller.js:117` renderer 只过滤 `accept`/`acceptForSession`，未过滤对象决策；`service.js:530` 无强制检查。

**修复**:
1. **`hco/service.js`** - 在 `interactionCommand` 的 APPROVE 分支、ACL 检查后、调用 `resolveApprovalDecision` 前，新增：
```javascript
// 在 service.js interactionCommand 函数中，约 line 582-660
if (command.type === "APPROVE") {
  // 定义高风险字段（仅这些代表额外授权）
  const HIGH_RISK_FIELDS = ["networkApprovalContext", "additionalPermissions", 
                            "proposedNetworkPolicyAmendments", "grantRoot"];
  const hasHighRisk = HIGH_RISK_FIELDS.some(f => interaction.request?.[f] != null);
  
  if (hasHighRisk) {
    const resolved = resolveApprovalDecision(interaction, command.choice);
    const key = typeof resolved === "string" ? resolved : Object.keys(resolved)[0];
    if (!["decline", "cancel"].includes(key)) {
      throw stateError(
        "INTERACTION_APPROVAL_RESTRICTED",
        "This approval contains extended permissions. Only decline/cancel permitted via command. Use App Server UI."
      );
    }
  }
}
```

2. **`hco/bridge/server.js`** - `INPUT_STATE_CODES` 新增 `"INTERACTION_APPROVAL_RESTRICTED"`

3. **`plugin/hermes-codex-bridge/bridge_client.py`** - `USER_FACING_ERROR_CODES` 新增 `"INTERACTION_APPROVAL_RESTRICTED"`

4. **`hco/turn-controller.js`** - 修改 `EXTENDED_PERMISSION_FIELDS`（line 14-20）去掉 `"commandActions"` 和 `"proposedExecpolicyAmendment"`，只保留真正的高风险字段：
```javascript
const EXTENDED_PERMISSION_FIELDS = [
  "networkApprovalContext",
  "additionalPermissions",
  "proposedNetworkPolicyAmendments",
  "grantRoot"
];
```

5. **Renderer safeChoices** - 改为只保留 decline/cancel（line ~117）：
```javascript
const safeChoices = hasExtendedPermissions
  ? choices.filter(({ key }) => ["decline", "cancel"].includes(key))
  : choices;
```

**测试**: `test/hco-service.test.js` - 含 `networkApprovalContext` 的审批，`/codex approve <id> accept` → `INTERACTION_APPROVAL_RESTRICTED`；decline 仍可用。

---

### P1-2: 超长通知精简版与真实 schema 脱节

**问题**: `toCompactContent` (line 23-43) 不接收 `requestObject`、`questions`、`allAddressable`，精简版可能误导用户。

**修复**:
1. **修改 `toCompactContent` 签名**（约 line 23）：
```javascript
function toCompactContent(interactionId, method, context = {}) {
  const { requestObject = {}, questions = [], allAddressable = false } = context;
  const isApproval = method === "item/commandExecution/requestApproval" || 
                     method === "item/fileChange/requestApproval";
  const parts = ["⚠️ **交互通知过大，已生成精简版**", "", `_reply token_: \`${interactionId}\``];

  if (isApproval) {
    const HIGH_RISK_FIELDS = ["networkApprovalContext", "additionalPermissions", 
                              "proposedNetworkPolicyAmendments", "grantRoot"];
    const hasHighRisk = HIGH_RISK_FIELDS.some(f => requestObject[f] != null);
    const available = Array.isArray(requestObject.availableDecisions) 
      ? requestObject.availableDecisions 
      : ["accept", "cancel"];
    
    const keys = available.map(d => typeof d === "string" ? d : Object.keys(d)[0])
      .filter(Boolean);
    const displayKeys = hasHighRisk ? keys.filter(k => ["decline", "cancel"].includes(k)) : keys;
    
    if (hasHighRisk) {
      parts.push("⚠️ 此审批含扩展权限，仅可通过 App Server UI 批准。");
    }
    for (const key of displayKeys) {
      parts.push(`- \`/codex approve ${interactionId} ${key}\``);
    }
  } else {
    // User input
    if (questions.length === 0 || !allAddressable) {
      parts.push("⚠️ 此请求无法通过命令行完整回答，请使用 App Server UI。");
      parts.push(`通用回答: \`/codex answer ${interactionId} <你的回答>\``);
    } else if (questions.length === 1) {
      parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
    } else {
      for (const q of questions.slice(0, 5)) {  // 最多5题避免过长
        const label = q.header || q.question || q.id;
        parts.push(`回答「${label}」: \`/codex answer ${interactionId} ${q.id} <答案>\``);
      }
      if (questions.length > 5) parts.push(`...还有 ${questions.length - 5} 个问题`);
    }
  }
  parts.push("", "_完整详情请通过 App Server UI 查看。_");
  return parts.join("\n");
}
```

2. **调用点传参**（约 line 175）：
```javascript
if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_UTF8_BYTES) {
  content = toCompactContent(interactionId, method, {
    requestObject,
    questions,
    allAddressable
  });
}
```

**测试**: `test/turn-controller.test.js` - 超大审批只含 `{availableDecisions:["decline"]}` → 精简版只显示 decline，不凭空显示 accept。

---

### P1-3: 审批正文 Markdown 转义 + 截断可见性

**问题**: 未转义 Markdown（三反引号可关闭代码块），命令截断 400 字符但仍显示 accept。

**修复**:
1. **新增转义函数**（在 `toCompactContent` 上方）：
```javascript
function escapeMarkdownTripleBacktick(text) {
  // 只转义三反引号，防止关闭代码块
  return text.replace(/```/g, '\\`\\`\\`');
}
```

2. **审批通知生成**（约 line 120-130）修改：
```javascript
if (typeof requestObject.reason === "string" && requestObject.reason) {
  parts.push(`**原因**: ${escapeMarkdownTripleBacktick(requestObject.reason)}`);
}
if (typeof requestObject.cwd === "string" && requestObject.cwd) {
  parts.push(`**工作目录**: \`${requestObject.cwd}\``);
}
if (typeof requestObject.command === "string" && requestObject.command) {
  const cmdTruncated = requestObject.command.length > 400;
  const displayCmd = cmdTruncated 
    ? requestObject.command.slice(0, 400) 
    : requestObject.command;
  parts.push("", "**待审批命令**:", "```", escapeMarkdownTripleBacktick(displayCmd), "```");
  
  if (cmdTruncated) {
    parts.push("⚠️ 命令已截断。完整命令请通过 App Server UI 查看后操作。");
    // 命令截断时只显示 decline/cancel
    safeChoices = safeChoices.filter(({ key }) => ["decline", "cancel"].includes(key));
  }
}
```

**测试**: `test/turn-controller.test.js` - `reason` 含 ` ``` ` → 渲染后不关闭代码块；超长命令 → 只显示 decline/cancel。

---

### P1-4: 项目引用检测漏报和误报

**问题**: 
- 边界不含 `.`，`foo.bar` 项目误判为 `foo`
- 缺 `handle`/`investigate` 动词
- 短项目名（如 `test`）在 verb-object 规则中误报

**修复** (`plugin/hermes-codex-bridge/plugin.py`, 约 line 437-475):

1. **边界包含 `.`**:
```python
project_boundary_before = r"(?<![A-Za-z0-9_.-])"
project_boundary_after = r"(?![A-Za-z0-9_.-])"
```

2. **扩展动词**（在现有 `english_verb_object` 规则中）:
```python
# 仅当项目名长度 > 3 时使用 verb-object 规则，避免 test/run 等短词误报
if len(project_id) > 3:
    english_verb_object = (
        rf"(?i)(?<![A-Za-z])(?:fix|work on|work in|update|test|check|run|debug|deploy|build|lint|review|handle|investigate)\s+"
        rf"{project_boundary_before}{escaped}{project_boundary_after}"
    )
    # 加入 patterns 列表
```

3. **中文扩展**（新增）:
```python
chinese_verb_context = (
    rf"(?:修复|修改|更新|检查|处理|调查)\s*{project_boundary_before}{escaped}{project_boundary_after}"
    rf"(?:\s*(?:中的|里的|并|的))?"
)
# 加入 patterns 列表
```

**测试**: `test/hermes_plugin_contract_test.py` - `"Please handle beta failures"` → 拒绝；`"run test"` 且外部项目名=test → 不误报（因长度≤3跳过 verb-object）；当前项目 `foo.bar`、外部 `foo` → 不误判。

---

### P2-1: user-facing 错误传播不完整

**问题**: `turn-controller.js:804-807` 用 `controllerError` 抛 `INTERACTION_ORPHANED` 等，但 `bridge/server.js:79` 只识别 `stateError`。

**修复**:
1. **`hco/turn-controller.js`** - `answerInteraction` 中（约 line 800-815）改用 `stateError`：
```javascript
// 确保已导入：import { stateError } from "./state/reducer.js";
async answerInteraction(input) {
  // ...
  if (!committed.accepted) {
    const failures = {
      not_found: ["INTERACTION_NOT_FOUND", "Interaction does not exist."],
      orphaned: ["INTERACTION_ORPHANED", "Interaction is orphaned."],
      expired: ["INTERACTION_EXPIRED", "Interaction has expired."],
      unauthorized: ["INTERACTION_UNAUTHORIZED", "Interaction responder is not authorized."],
      target_mismatch: ["INTERACTION_TARGET_MISMATCH", "Interaction target mismatch."],
      answer_conflict: ["INTERACTION_ANSWER_CONFLICT", "Interaction answer conflicts."]
    };
    const [code, message] = failures[committed.reason] ?? 
      ["INTERACTION_ANSWER_INVALID", "Interaction answer is invalid."];
    throw stateError(code, message);  // 改为 stateError
  }
  // ...
}
```

2. **`hco/bridge/server.js`** - `INPUT_STATE_CODES` 新增（约 line 15-26）：
```javascript
const INPUT_STATE_CODES = new Set([
  "FACT_INVALID",
  "OUTBOX_CLAIM_INVALID",
  "OUTBOX_ACK_INVALID",
  "OUTBOX_NACK_INVALID",
  "INTERACTION_DECISION_INVALID",
  "INTERACTION_COMMAND_MISMATCH",
  "INTERACTION_QUESTION_ID_INVALID",
  "INTERACTION_NOT_FOUND",
  "INTERACTION_TARGET_MISMATCH",
  "OBJECTIVE_REQUIRED",
  "INTERACTION_ORPHANED",           // 新增
  "INTERACTION_EXPIRED",            // 新增
  "INTERACTION_UNAUTHORIZED",       // 新增
  "INTERACTION_ANSWER_CONFLICT",    // 新增
  "INTERACTION_ANSWER_INVALID"      // 新增
]);
```

3. **`plugin/hermes-codex-bridge/bridge_client.py`** - `USER_FACING_ERROR_CODES` 同步新增。

**测试**: `test/hco-service.test.js` - 过期交互回答 → 用户收到 "expired" 可读错误，不是 "protocol error"。

---

### P2-2: commandActions 错误视为扩展权限

**问题**: `EXTENDED_PERMISSION_FIELDS` 含 `commandActions`（只是展示信息）。

**修复**: 已在 P1-1 中完成 - 从 `EXTENDED_PERMISSION_FIELDS` 去掉 `commandActions`。

**测试**: `commandActions` 非空但无其他高风险字段 → accept 命令正常显示。

---

### P3-1: ACL 错误信任边界可伪造

**问题**: `bridge/server.js:82` 用 `|| error?.code === "ACL_FORBIDDEN"` 公开任意 Error。

**修复** (`hco/bridge/server.js`, 约 line 82):
```javascript
// 去掉 || error?.code === "ACL_FORBIDDEN"，只信任 stateError
if (isStateError(error) && CONFLICT_STATE_CODES.has(error.code)) {
  return { status: 409, code: error.code, message: error.message };
}
```

同时 `hco/acl.js` 中 `ACL_FORBIDDEN` 改用 `stateError`（需从 `./state/reducer.js` 导入）：
```javascript
import { stateError } from "./state/reducer.js";
// ...
throw stateError("ACL_FORBIDDEN", "Permission denied.");
```

**测试**: 非 stateError 的 ACL_FORBIDDEN → HTTP 500，不暴露 message。

---

### P3-2: Python/Node Unicode 空白不一致

**问题**: Python `isspace()` vs Node `\s`，U+FEFF/U+0085 不一致。

**修复** (`plugin/hermes-codex-bridge/plugin.py`, 约 line 888-900):
```python
# ECMAScript \s 额外字符（Python isspace() 不完全覆盖）
_ECMASCRIPT_EXTRA_WS = frozenset({
    '\xa0',   # NBSP
    ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', '　', '﻿'  # BOM/ZWNBSP
})

def _is_safe_question_id(value: object) -> bool:
    """Non-empty after strip, max 256 bytes, no whitespace (Python isspace + ECMAScript \\s union)."""
    if type(value) is not str or not value.strip():
        return False
    # Union: reject if EITHER Python isspace() OR ECMAScript \s
    if any(c.isspace() or c in _ECMASCRIPT_EXTRA_WS for c in value):
        return False
    try:
        if len(value.encode("utf-8")) > 256:
            return False
    except Exception:
        return False
    return all(ord(c) >= 32 and c != "\x7f" for c in value)
```

**测试**: `test/hermes_plugin_contract_test.py` - U+FEFF ID → Python 拒绝；U+0085 ID → Python 拒绝（isspace() 已覆盖）。

---

## 验证命令

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js
```

---

## 实施顺序

1. P2-2（最简单，只删除数组元素）
2. P3-1（ACL 信任边界）
3. P3-2（Python 空白集合）
4. P2-1（controllerError → stateError）
5. P1-1（Service enforcement + Renderer 修正）
6. P1-2（toCompactContent 重构）
7. P1-3（Markdown 转义）
8. P1-4（Python 边界和动词）

每步完成后运行对应测试确认 GREEN。

---

## 注意事项

1. **导入检查**: `stateError` 在 `turn-controller.js` 和 `acl.js` 中需要新增 `import { stateError } from "./state/reducer.js";`
2. **HIGH_RISK_FIELDS** 定义两次（service.js 和 turn-controller.js toCompactContent），保持一致
3. **命令截断检测** 在 hasExtendedPermissions 之后独立执行，两者可叠加触发 decline-only
4. **测试优先**: 先补充失败测试（RED），再实现修复（GREEN）
5. **不提交**: 完成后不执行 `git commit` 或 `git push`

---

## 生成记录

修复完成后生成：`docs/superpowers/records/2026-07-21-hco-tenth-pass-fix-record.md`
