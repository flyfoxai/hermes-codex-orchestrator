# HCO 八轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施
**背景**: 七轮修复后复审发现 2 个 P1 + 2 个 P2，本轮合并处理。

---

## 问题确认

### P1-a：重复 question ID 生成必然失败的命令

`turn-controller.js:112` 的 `allAddressable` 只检查非空和无空白，不检查唯一性。两个 `id: "q1"` 全部通过检查，渲染出两条相同的 `/codex answer <interactionId> q1 ...` 命令。但 `service.js:50` 的 `validateQuestions` 明确检查重复 ID 并抛 `INTERACTION_QUESTION_ID_INVALID`。用户按提示操作必然失败。

### P1-b：空 questions 时兼容回退被 renderer 意外禁用

`questions.length === 0` 时 `allAddressable = false`（因为 `questions.length > 0 &&` 条件为 false）。随后 `if (!allAddressable)` 分支触发，只显示 "App Server UI" 警告，不生成任何命令。但 `service.js` 对空 questions 明确保留了旧 `{text}` 回退路径，七轮方案注释也要求空时生成通用命令。Renderer 与 service 行为不一致。

### P2-a：Node 与 Python 对安全 ID 的定义不一致

Node `validateQuestions` 和 `allAddressable`：非空 + `/\s/`（空白字符）。
Python `_is_safe_question_id`：非空 + 无 `\x00-\x1F` + 无 `\x7F` + ≤ 256 UTF-8 字节。

不一致之处：
1. 非空白控制字符（如 `\x01`）：Node 接受，Python 拒绝
2. 超长 ID（>256 字节）：Node 接受，Python 拒绝

两种情况都会导致 partial 回答进入 `missingQuestionIds`，最终 Python 渲染层拒绝返回 "Codex bridge protocol error."，或 renderer 生成超过命令长度限制的不可提交命令。

### P2-b：非对象 question 被静默跳过，验证 fail-open

`service.js:41` 对非 plain object 的 question（`null`、数组、数字）直接 `continue`，不计入 `ids` 检查。`questions: [null]` 通过 `validateQuestions`（无错误），`userInputQuestions` 过滤后得空列表，落入旧 `{text}` 结算。`[null, {id:"q1"}]` 则静默忽略 `null` 只提交 `q1` 的答案，可能不完整。

---

## 修复范围

### 必改文件

1. `hco/turn-controller.js` — P1-a 唯一性检查 + P1-b 空列表修复
2. `hco/service.js` — P1-a（allAddressable 与 validateQuestions 保持一致）+ P2-a 控制字符/长度 + P2-b 非对象拒绝
3. `test/turn-controller.test.js` — P1-a 重复 ID 渲染测试 + P1-b 空列表渲染回归
4. `test/hco-service.test.js` — P2-a 控制字符/超长测试 + P2-b 非对象测试
5. `docs/superpowers/records/2026-07-20-hco-eighth-pass-fix-record.md`

---

## A. P1-a：allAddressable 加唯一性检查

### A1. `hco/turn-controller.js`

将 `allAddressable` 计算改为使用 `Set` 检查唯一性：

```javascript
const allAddressable = questions.length > 0 && (() => {
  const seen = new Set();
  for (const question of questions) {
    if (!question || typeof question !== "object" || Array.isArray(question)) return false;
    const id = question.id;
    if (typeof id !== "string" || id.trim() === "" || /\s/.test(id)) return false;
    if (seen.has(id)) return false; // 重复 ID
    seen.add(id);
  }
  return true;
})();
```

注意：此处仅检查 non-empty + no-whitespace + unique。与 `validateQuestions` 的标准对齐在 A2 中统一处理。

### A2. 测试要求

`test/turn-controller.test.js`：

1. `questions: [{id:"q1",...},{id:"q1",...}]`（重复 ID）→ `allAddressable = false`，通知无 `/codex answer` 命令，有 App Server UI 提示

---

## B. P1-b：空 questions 回退命令

### B1. `hco/turn-controller.js`

在通知末尾条件中，将 `if (!allAddressable)` 改为 `if (questions.length > 0 && !allAddressable)`，使空 questions 可以正确落入 `else` 分支生成通用命令：

```javascript
// 末尾条件（原来是 if (!allAddressable)）
if (questions.length > 0 && !allAddressable) {
  parts.push("⚠️ 此交互包含不可寻址的 question ID，无法通过命令行回答，请使用 App Server UI 完成。");
} else if (questions.length > 1) {
  parts.push("每题一条命令，全部回答后自动提交。");
} else {
  // length === 1 OR length === 0（空列表走旧 {text} 兼容路径，保留通用命令）
  parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
}
```

### B2. 测试要求

`test/turn-controller.test.js`（回归）：

1. `questions: []`（空数组）→ 通知包含通用 `/codex answer <id> <你的回答>` 命令，不显示 App Server UI 警告

---

## C. P2-a：统一安全 ID 定义

### C1. 新增公共 helper

在 `hco/service.js` 中，在 `validateQuestions` 上方新增：

```javascript
// 对齐 plugin.py 的 _is_safe_question_id：无控制字符，≤256 UTF-8 字节
function isSafeQuestionId(id) {
  if (typeof id !== "string" || id.trim() === "") return false;
  if (/[\s\x00-\x1F\x7F]/.test(id)) return false;
  if (Buffer.byteLength(id, "utf8") > 256) return false;
  return true;
}
```

### C2. 更新 `validateQuestions` 使用 `isSafeQuestionId`

```javascript
function validateQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const ids = [];
  for (const question of rawQuestions) {
    if (!isPlainObject(question)) {
      return "One or more questions are malformed. Use App Server UI to answer."; // P2-b 一并处理
    }
    const id = question.id;
    if (!isSafeQuestionId(id)) {
      return `Question ID '${String(id).slice(0, 40)}' is invalid (empty, contains whitespace/control chars, or exceeds 256 bytes). Use App Server UI.`;
    }
    if (ids.includes(id)) {
      return `Duplicate question ID '${id.slice(0, 40)}'. Use App Server UI to answer.`;
    }
    ids.push(id);
  }
  return null;
}
```

### C3. 同步更新 `allAddressable`

在 `turn-controller.js` 的 `allAddressable` 中也使用相同规则（`/[\s\x00-\x1F\x7F]/` 且长度 ≤ 256字节）：

```javascript
const allAddressable = questions.length > 0 && (() => {
  const seen = new Set();
  for (const question of questions) {
    if (!question || typeof question !== "object" || Array.isArray(question)) return false;
    const id = question.id;
    if (typeof id !== "string" || id.trim() === "") return false;
    if (/[\s\x00-\x1F\x7F]/.test(id)) return false;
    try { if (Buffer.byteLength(id, "utf8") > 256) return false; } catch { return false; }
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
})();
```

### C4. 测试要求

`test/hco-service.test.js`：

1. `id: "\x01q"` → `validateQuestions` 返回错误（控制字符）
2. `id: "a".repeat(300)` → 返回错误（超长）
3. `id: "q1"` → 正常通过（回归）

---

## D. P2-b：非对象 question 拒绝而非跳过

已在 C2 的 `validateQuestions` 中包含：对 `!isPlainObject(question)` 返回错误消息。此处不再重复，已合并实现。

### D1. 测试要求

`test/hco-service.test.js`：

1. `questions: [null]` → `INTERACTION_QUESTION_ID_INVALID`，backend 未调用
2. `questions: [null, {id:"q1"}]` → 同上
3. `questions: [42]` → 同上

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
- [ ] 重复 ID → `allAddressable = false`，通知无 `/codex answer` 命令

### P1-b
- [ ] 空 questions 数组 → 通知有通用 `/codex answer <id> <你的回答>` 命令（无 App Server UI 警告）

### P2-a
- [ ] 含 `\x01` 等非空白控制字符的 ID → `validateQuestions` 返回错误
- [ ] 超 256 字节 ID → 返回错误
- [ ] `allAddressable` 与 `validateQuestions` 使用相同规则

### P2-b
- [ ] `questions: [null]` → `INTERACTION_QUESTION_ID_INVALID`，不写 durable
- [ ] `questions: [null, {id:"q1"}]` → 同上

---

## 注意事项

1. `isSafeQuestionId` 使用 `Buffer.byteLength(id, "utf8")` 计算字节数，与 Python 的 `value.encode("utf-8")` 等价。
2. `allAddressable` 中的 Buffer 调用需包 `try/catch` 防止意外异常（Node 一般不会抛，但防御性编程）。
3. 非对象 question 改为拒绝，属于 fail-closed 增强，不破坏合法交互（App Server schema 只下发合法对象）。
4. 不提交 git commit / push。
