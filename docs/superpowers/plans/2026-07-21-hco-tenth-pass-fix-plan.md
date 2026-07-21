# HCO 十轮缺陷修复方案

**日期**: 2026-07-21
**状态**: 待实施
**背景**: 九轮修复后复审发现 4 个 P1、2 个 P2、2 个 P3，本轮合并修复。

---

## 问题确认

### P1-1：扩展权限审批仍能通过命令行执行

`turn-controller.js:117` 的 `safeChoices` 只过滤 `accept`/`acceptForSession`，未过滤 `acceptWithExecpolicyAmendment`/`applyNetworkPolicyAmendment`。  
更重要的是：enforcement 必须在 service 层，因为用户可手工输入命令绕过 renderer。  
当前 `service.js:530`（`resolveApprovalDecision`）会接受 `availableDecisions` 中的任意选项，无安全限制。

### P1-2：精简版通知与真实交互 schema 脱节

`toCompactContent` 不接收 `availableDecisions`、`questions`、question 可寻址性或 `isSecret`。  
实测：只允许 decline 的审批会凭空显示 accept/cancel；多问题退化为通用 answer。  
精简版可能误导用户执行必然失败或不该显示的操作。

### P1-3：审批正文不足以作为可信授权展示

- 未转义 Markdown：三反引号可提前关闭代码块并伪造审批内容
- 命令截断 400 字符但审批命令仍可用，危险后缀不可见时审批命令不应展示

### P1-4：项目引用检测仍有漏报和误报

**漏报**：`Please handle beta failures`、`Investigate beta failures`、`修复 beta 中的测试`、`修改 beta 并运行测试`  
**误报1**：外部项目名为 `test` 时 `run test` 命中 verb-object 规则  
**误报2**：边界未包含 `.`，当前项目 `foo.bar` 的引用会被误判为引用外部项目 `foo`

### P2-1：用户可纠正错误传播仍不完整

`turn-controller.js:804-807` 在 `answerInteraction` 中用 `controllerError` 抛出：`INTERACTION_ORPHANED`、`INTERACTION_EXPIRED`、`INTERACTION_UNAUTHORIZED`、`INTERACTION_ANSWER_CONFLICT`。  
`bridge/server.js:79` 只识别 `isStateError`，这些 controllerErrors 变成 HTTP 500。  
已通过真实 HTTP 路径复现。

### P2-2：commandActions 被错误视为扩展权限

`turn-controller.js:15` 的 `EXTENDED_PERMISSION_FIELDS` 包含 `commandActions`。  
真实 schema 将 `commandActions` 定义为 best-effort 展示用解析动作，不代表额外授权。  
这会隐藏普通审批的 accept 命令，重新引入"审批不可操作"缺陷。

### P3-1：Bridge ACL 错误信任边界可被伪造

`bridge/server.js:82` 当前处理：
```javascript
if ((isStateError(error) || error?.code === "ACL_FORBIDDEN") && ...)
```
`|| error?.code === "ACL_FORBIDDEN"` 会公开任意带该 code 的 Error message，不要求可信错误类型。

### P3-2：Python 与 Node 的 Unicode 空白集合不一致

Python `character.isspace()` 与 ECMAScript `\s` 不完全相同：
- U+FEFF：Node `\s` 拒绝，Python `isspace()` 接受 → Python 允许 FEFF ID
- U+0085：Node `\s` 不拒绝，Python `isspace()` 拒绝 → Python 拒绝但 Node 允许

后者会导致 Node 正常积累 partial 但 Python 的 `_is_safe_question_id` 拒绝返回的 missingQuestionIds。

---

## 修复范围

### 必改文件

1. `hco/turn-controller.js` — P1-1 renderer + P1-2 compact + P1-3 Markdown 转义 + P2-2 commandActions
2. `hco/service.js` — P1-1 service-level enforcement
3. `hco/bridge/server.js` — P2-1 controllerError 支持 + P3-1 ACL 信任边界
4. `hco/turn-controller.js` — P2-1 指定几个错误改用 stateError
5. `plugin/hermes-codex-bridge/plugin.py` — P1-4 边界 + P3-2 whitespace
6. `test/turn-controller.test.js` — P1-1 + P1-2 + P1-3 + P2-2 测试
7. `test/hco-service.test.js` — P1-1 service enforcement 测试
8. `test/hermes_plugin_contract_test.py` — P1-4 + P3-2 测试
9. `docs/superpowers/records/2026-07-21-hco-tenth-pass-fix-record.md`

---

## A. P1-1：Service-level 扩展权限强制

### A1. 定义高风险字段（`hco/service.js`）

仅以下字段代表额外授权，须在 service 层拒绝批准：

```javascript
const HIGH_RISK_PERMISSION_FIELDS = Object.freeze([
  "networkApprovalContext",
  "additionalPermissions",
  "proposedNetworkPolicyAmendments",
  "grantRoot"
]);
// 注意：commandActions 不在此列（是展示信息）
// 注意：proposedExecpolicyAmendment 通过 availableDecisions 的 detail 已可见，不在此列
```

### A2. `interactionCommand` 中的强制检查

在 ACL 校验后、`resolveApprovalDecision` 调用前：

```javascript
if (command.type === "APPROVE") {
  const hasHighRisk = HIGH_RISK_PERMISSION_FIELDS.some(
    (field) => interaction.request?.[field] != null
  );
  if (hasHighRisk) {
    const resolved = resolveApprovalDecision(interaction, command.choice);
    const key = typeof resolved === "string" ? resolved : Object.keys(resolved)[0];
    const SAFE_FOR_HIGH_RISK = new Set(["decline", "cancel"]);
    if (!SAFE_FOR_HIGH_RISK.has(key)) {
      throw stateError(
        "INTERACTION_APPROVAL_RESTRICTED",
        `This approval contains extended permissions. Only decline/cancel are permitted via command. Use App Server UI to accept.`
      );
    }
  }
}
```

同步将 `INTERACTION_APPROVAL_RESTRICTED` 加入 `INPUT_STATE_CODES`（`bridge/server.js`）和 `USER_FACING_ERROR_CODES`（`bridge_client.py`）。

### A3. Renderer 同步修正（`turn-controller.js`）

`EXTENDED_PERMISSION_FIELDS` 去掉 `commandActions`（P2-2 一并处理），只保留真正的高风险字段：

```javascript
const EXTENDED_PERMISSION_FIELDS = [
  "networkApprovalContext",
  "additionalPermissions",
  "proposedNetworkPolicyAmendments",
  "grantRoot"
];
```

`safeChoices` 的过滤条件同时扩展到所有非 decline/cancel 决策：

```javascript
const safeChoices = hasExtendedPermissions
  ? choices.filter(({ key }) => new Set(["decline", "cancel"]).has(key))
  : choices;
```

---

## B. P1-2：精简版通知反映真实 schema

`toCompactContent` 接收完整的 `requestObject` 和 `questions`：

```javascript
function toCompactContent(interactionId, method, {
  requestObject = {},
  questions = [],
  allAddressable = false
} = {}) {
  const isApproval = method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval";
  const parts = ["⚠️ **交互通知过大，已生成精简版**", "", `_reply token_: \`${interactionId}\``];

  if (isApproval) {
    const hasHighRisk = HIGH_RISK_PERMISSION_FIELDS.some(f => requestObject[f] != null);
    if (hasHighRisk) {
      parts.push("此审批含扩展权限，请通过 App Server UI 操作。");
      // 只展示 decline/cancel
      const available = requestObject.availableDecisions;
      const safeKeys = Array.isArray(available)
        ? available.map(d => typeof d === "string" ? d : Object.keys(d)[0])
            .filter(k => ["decline", "cancel"].includes(k))
        : ["decline", "cancel"];
      for (const key of safeKeys) {
        parts.push(`- \`/codex approve ${interactionId} ${key}\``);
      }
    } else {
      const available = requestObject.availableDecisions;
      const keys = Array.isArray(available) && available.length > 0
        ? available.map(d => typeof d === "string" ? d : Object.keys(d)[0]).filter(Boolean)
        : ["accept", "cancel"];
      for (const key of keys) {
        parts.push(`- \`/codex approve ${interactionId} ${key}\``);
      }
    }
  } else {
    if (!allAddressable || questions.length === 0) {
      parts.push("此请求无法通过命令行完整回答，请使用 App Server UI。");
      parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
    } else if (questions.length === 1) {
      parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
    } else {
      for (const q of questions) {
        parts.push(`回答「${q.header || q.question || q.id}」: \`/codex answer ${interactionId} ${q.id} <你的回答>\``);
      }
    }
  }
  parts.push("", "_完整详情请通过 App Server UI 查看。_");
  return parts.join("\n");
}
```

在调用 `toCompactContent` 时传入相关参数：
```javascript
if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_UTF8_BYTES) {
  content = toCompactContent(interactionId, method, {
    requestObject,
    questions: answerable questions array,
    allAddressable
  });
}
```

---

## C. P1-3：Markdown 转义 + 截断可见性

### C1. 转义 user-provided 字段

对 `reason`、`cwd` 和 `command` 中的 Markdown 特殊字符（`` ` ``、`*`、`_`、`[`、`]`）和三反引号进行转义：

```javascript
function escapeMd(text) {
  // 首先转义三反引号（替换为转义版本），防止关闭代码块
  return text.replace(/```/g, "\\`\\`\\`");
}
```

应用于 `reason`、`cwd` 展示，以及 command 的截断提示。

### C2. 命令截断时不显示批准命令

若命令超过 400 字符，用户无法看到完整内容，不应展示 accept 命令：

```javascript
const commandTruncated = requestObject.command?.length > 400;
if (commandTruncated) {
  const truncated = requestObject.command.slice(0, 400);
  parts.push("", "**待审批命令（已截断，完整命令请通过 App Server UI 查看）**:", 
    "```", escapeMd(truncated), "```",
    "⚠️ 命令已截断，无法通过此命令行安全审批。请通过 App Server UI 查看完整命令后操作。");
  // 如果命令被截断，只展示 decline/cancel
  // override safeChoices：
  safeChoices = choices.filter(({ key }) => new Set(["decline", "cancel"]).has(key));
} else if (requestObject.command) {
  parts.push("", "**待审批命令**:", "```", escapeMd(requestObject.command), "```");
}
```

---

## D. P1-4：项目引用检测修正

### D1. 边界包含 `.`（`plugin.py`）

```python
project_boundary_before = r"(?<![A-Za-z0-9_.-])"
project_boundary_after = r"(?![A-Za-z0-9_.-])"
```

这样 `foo.bar` 中不会误命中外部项目 `foo`。

### D2. 扩展动词列表，过滤常见英文词

在 `english_verb_object` 中：
1. 扩展：添加 `handle`、`investigate`
2. 防误报：排除项目名与动词同名的场景，要求项目名在该规则中长度 > 3（排除极短的常见词如 `run`/`test`/`fix` 直接匹配自身）

```python
# 仅当 pid 长度 > 3 时才用 verb-object 规则（避免 test/run 等短词误报）
if len(project_id) > 3:
    english_verb_object = (
        rf"(?i:(?<![A-Za-z])(?:fix|work on|work in|update|test|check|run|debug|deploy|build|lint|review|handle|investigate)\s+)"
        rf"{project_boundary_before}{escaped}{project_boundary_after}"
    )
    patterns.append(english_verb_object)
```

### D3. 扩展中文 "中的"、"并" 句式

```python
chinese_verb_context = (
    rf"(?:修复|修改|更新|检查|处理|调查)\s*{project_boundary_before}{escaped}{project_boundary_after}"
    rf"\s*(?:中的|并|的|里的)?"
)
```

---

## E. P2-1：user-facing controllerErrors → stateErrors

在 `hco/turn-controller.js` 的 `answerInteraction` 中，以下错误改用 `stateError`（需从 `./state/reducer.js` 导入）：

```javascript
// 改为：
import { stateError } from "./state/reducer.js";

// answerInteraction 中：
const [code, message] = failures[committed.reason] ?? ["INTERACTION_ANSWER_INVALID", "..."];
throw stateError(code, message);  // 而非 controllerError
```

同步将以下加入 `INPUT_STATE_CODES`（`bridge/server.js`）：
- `INTERACTION_EXPIRED`
- `INTERACTION_ORPHANED`
- `INTERACTION_UNAUTHORIZED`
- `INTERACTION_ANSWER_CONFLICT`
- `INTERACTION_ANSWER_INVALID`

---

## F. P3-1：ACL 错误信任边界修正

`bridge/server.js:82` 当前：
```javascript
if ((isStateError(error) || error?.code === "ACL_FORBIDDEN") && CONFLICT_STATE_CODES.has(error.code)) {
```

改为只信任真正的 stateError：
```javascript
if (isStateError(error) && CONFLICT_STATE_CODES.has(error.code)) {
```

对应地，`hco/acl.js` 中 `aclError` 的 `ACL_FORBIDDEN` 改为 `stateError`（与其他已修改的错误保持一致），或导入并用 `stateError` 替代。

---

## G. P3-2：Python whitespace 集合与 Node 对齐

使用 ECMAScript `\s` 的超集，确保两端都拒绝的字符都被拒绝：

```python
# ECMAScript \s 额外字符（Python isspace() 不覆盖的部分）
_ECMASCRIPT_EXTRA_WHITESPACE = frozenset({
    ' ',  # NBSP
    ' ',
    ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', ' ', ' ', ' ',
    ' ', ' ',  # LS/PS
    ' ',
    ' ',
    '　',
    '﻿',  # BOM/ZWNBSP — Node \s 拒绝，Python isspace() 不拒绝
})

def _is_safe_question_id(value: object) -> bool:
    """Non-empty string after strip, max 256 bytes, no whitespace (Python+ECMAScript union)."""
    if type(value) is not str or not value.strip():
        return False
    # Union of Python isspace() and ECMAScript \s characters
    if any(c.isspace() or c in _ECMASCRIPT_EXTRA_WHITESPACE for c in value):
        return False
    try:
        if len(value.encode("utf-8")) > 256:
            return False
    except Exception:
        return False
    return all(ord(c) >= 32 and c != "\x7f" for c in value)
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

### P1-1
- [ ] `/codex approve <id> accept` 在高风险字段存在时被 service 拒绝（`INTERACTION_APPROVAL_RESTRICTED`），decline/cancel 仍可用
- [ ] `acceptWithExecpolicyAmendment` 也被拒绝（非 safe 集合）

### P1-2
- [ ] 精简版审批通知使用真实 availableDecisions（decline-only 不凭空显示 accept）
- [ ] 精简版用户输入通知反映 question 可寻址性

### P1-3
- [ ] 含三反引号的 reason/command 不能关闭代码块
- [ ] 截断命令时只显示 decline/cancel，不显示 accept

### P1-4
- [ ] `Please handle beta failures` 拒绝
- [ ] `修复 beta 中的测试` 拒绝
- [ ] `run test` 不因 projectId=test 误报
- [ ] 当前项目 `foo.bar` 的引用不因外部项目 `foo` 被误拦

### P2-1
- [ ] 过期/孤立交互回答 → 用户可读错误而非 protocol error

### P2-2
- [ ] `commandActions` 非空但无高风险字段 → accept 命令正常显示

### P3-1
- [ ] 只有 `stateError` 类型的 ACL_FORBIDDEN 被暴露

### P3-2
- [ ] U+FEFF 被 Python 拒绝为 question ID
- [ ] U+0085 被 Python 接受但测试验证 Node 侧 isSafeQuestionId 也接受（U+0085 不在 ECMAScript \s 中，两端一致）

---

## 注意事项

1. `HIGH_RISK_PERMISSION_FIELDS` 与 `EXTENDED_PERMISSION_FIELDS` 须保持一致，不含 `commandActions` 和 `proposedExecpolicyAmendment`。
2. 命令截断检测应在 `hasExtendedPermissions` 之后执行，两者都可以独立触发 decline-only 模式。
3. verb-object 长度 > 3 守卫只影响英文 verb-object 规则，不影响其他规则（context-word、possessive 等不受影响）。
4. `stateError` 在 `turn-controller.js` 中已导入，不需要新增导入。
5. 不提交 git commit / push。
