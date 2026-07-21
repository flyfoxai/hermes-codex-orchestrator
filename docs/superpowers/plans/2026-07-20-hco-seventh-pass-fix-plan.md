# HCO 七轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施
**背景**: 六轮修复后复审发现 2 个 P1 + 1 个文档偏差，本轮合并处理。

---

## 问题确认

### P1-a：Renderer 生成必然失败的命令

**文件**: `hco/turn-controller.js:130-155`

`isAddressable` 检查只在 `questions.length > 1` 分支生效：
- 单问题 ID 为 `deploy target`：不进入任何分支，最终 line 155 输出 `/codex answer <id> <你的回答>`
- 混合 ID（`q1` + `deploy target`）：`q1` 得到命令，`deploy target` 得到"使用 App Server UI"，并且追加"全部回答后自动提交"

两种情况都会导致用户按提示操作后，service.js（已因任一空白 ID 拒绝整个 ANSWER）抛出 `INTERACTION_QUESTION_ID_INVALID`，通知实际不可操作。

**修复方向**：渲染前先对整个 questions 集合做一次可寻址性判断。若集合中任何问题存在不可寻址 ID，整条通知改为"无法通过命令回答，请使用 App Server UI"；否则按现有逻辑生成命令。

### P1-b：空 ID / 重复 ID 绕过检查并永久结算交互

**文件**: `hco/service.js:573-584`

`allRawQuestions` 在完整性检查前用 `.trim()` 过滤了空 ID：

1. **全空 ID**：`allRawQuestions.length === 0`，跳过比较；`questions.length === 0`，落入旧 `{text}` 路径（line ~638），永久错误结算
2. **混合空 ID**：空 ID 题从 `allRawQuestions` 里消失，被静默忽略；提交的 answers map 不完整
3. **重复 ID**：多个相同 ID 的问题折叠到同一个 map key，后续答案覆盖前者

App Server schema 对 `id` 只有 `type: string`，无 minLength 或 unique 约束，这些输入是协议合法的。`turn-controller.js:733` 先 durable commit 再发响应，错误一旦提交无法重试。

**修复方向**：对原始完整 questions 列表（不预过滤）做统一验证：非空 string、单 token（无空白）、全局唯一。任一失败在 durable commit 前抛错。

### 文档偏差（低优先级，同步修正）

`docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md:82` 描述"路径不存在时异常并回退 normpath"不准确：`os.path.realpath()` 默认 `strict=False`，不存在路径**不会**抛异常，只是尽量解析符号链接后返回路径。`try/except` 仅捕获权限等实际异常。功能正确，但文档需更正。

---

## 修复范围

### 必改文件

1. `hco/turn-controller.js` — P1-a：整体可寻址性判断
2. `hco/service.js` — P1-b：完整 questions 验证
3. `test/turn-controller.test.js` — P1-a 渲染测试
4. `test/hco-service.test.js` — P1-b 边界测试
5. `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md` — 文档偏差修正
6. `docs/superpowers/records/2026-07-20-hco-seventh-pass-fix-record.md` — 新建七轮修复记录

---

## A. P1-a：Renderer 整体可寻址性判断

### A1. 实现

**文件**: `hco/turn-controller.js`，`item/tool/requestUserInput` 分支

在渲染 questions 之前，先判断整个集合是否全部可寻址：

```javascript
} else if (method === "item/tool/requestUserInput") {
  const parts = ["💬 **输入请求**", ""];
  const questions = Array.isArray(requestObject.questions) ? requestObject.questions : [];

  // 判断是否有任何不可寻址的 question ID（含空白、空串或非字符串）
  const allAddressable = questions.length > 0 && questions.every((question) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) return false;
    const id = question.id;
    return typeof id === "string" && id.trim() !== "" && !/\s/.test(id);
  });

  if (questions.length > 0) {
    questions.forEach((question, index) => {
      // ... 渲染 header、question text、options（不变）...
      const isAddressable = typeof question.id === "string" && question.id && !/\s/.test(question.id);

      if (!allAddressable) {
        // 整体不可寻址时：每个 question 都不显示命令行，对不可寻址 ID 标注原因
        if (!isAddressable) {
          parts.push(`回答「${header}」: _此问题 ID 含空白字符，无法通过命令回答。_`);
        }
        // 可寻址 ID 的问题此处也不显示命令（因整体被拒绝）
      } else if (questions.length > 1) {
        // 全部可寻址且多于一题：显示 per-question 命令
        parts.push(`回答「${header}」: \`/codex answer ${interactionId} ${question.id} <你的回答>\``);
      }
      // 全部可寻址且单问题：不在此处生成命令，由后面统一处理
      parts.push("");
    });
  }
  // ...
  if (!allAddressable) {
    parts.push("⚠️ 此交互包含不可寻址的 question ID，无法通过命令行回答，请使用 App Server UI 完成。");
  } else if (questions.length > 1) {
    parts.push("每题一条命令，全部回答后自动提交。");
  } else if (questions.length === 1) {
    parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
  } else {
    // questions 为空，fallback
    parts.push(`输入: \`/codex answer ${interactionId} <你的回答>\``);
  }
  content = parts.join("\n");
}
```

**关键逻辑**：
- `allAddressable = true` → 单题显示通用命令；多题显示 per-question 命令 + 提交说明
- `allAddressable = false` → 所有题目不显示任何 `/codex answer` 命令；在末尾加 App Server UI 提示

### A2. 测试要求

`test/turn-controller.test.js` 增加/修改：

1. **单问题含空白 ID** (`request: {questions: [{id: "deploy target", question: "..."}]}`):
   - 通知**不包含** `/codex answer`
   - 通知包含"App Server UI"提示
2. **混合 ID**（`q1` 合法 + `deploy target` 非法）:
   - 通知**不包含** `/codex answer`（即使 `q1` 合法，整体不可寻址）
   - 通知包含 App Server UI 提示
3. **全部单 token ID 多问题**（回归）:
   - 每题仍有 per-question `/codex answer <id>` 命令
4. **单 token 单问题**（回归）:
   - 有通用 `/codex answer <id>` 命令

---

## B. P1-b：完整 questions 验证

### B1. 实现

**文件**: `hco/service.js`，ANSWER 分支（line 572 附近）

用对完整原始列表的统一验证替换当前的 `allRawQuestions` + `questions` 双过滤逻辑：

```javascript
if (command.type === "ANSWER") {
  // 取原始完整 questions 列表（不预过滤）
  const rawQuestions = Array.isArray(interaction?.request?.questions)
    ? interaction.request.questions
    : [];

  const validationError = validateQuestions(rawQuestions);
  if (validationError) {
    throw stateError("INTERACTION_QUESTION_ID_INVALID", validationError);
  }

  // 验证通过后，用 userInputQuestions 取可操作问题（此时已确保全部可寻址）
  const questions = userInputQuestions(interaction);
  // 后续 questions.length === 0 / 1 / >1 逻辑不变
  ...
}

// 新增 helper
function validateQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const ids = [];
  for (const q of rawQuestions) {
    if (!isPlainObject(q)) continue;
    const id = q.id;
    if (typeof id !== "string" || id.trim() === "") {
      return "One or more questions have empty or missing IDs. Use App Server UI to answer.";
    }
    if (/\s/.test(id)) {
      return `Question ID '${id.slice(0, 40)}' contains whitespace and cannot be addressed via command. Use App Server UI.`;
    }
    if (ids.includes(id)) {
      return `Duplicate question ID '${id.slice(0, 40)}'. Use App Server UI to answer.`;
    }
    ids.push(id);
  }
  return null;  // valid
}
```

**验证清单**：
1. ID 必须是字符串且非空（`.trim() !== ""`）
2. ID 不含空白（单 token）
3. ID 在本次交互中唯一（无重复）

任一失败 → `INTERACTION_QUESTION_ID_INVALID` → HTTP 400 → `BridgeUserError` → 用户看到可读提示，**不写入 durable**。

### B2. 测试要求

`test/hco-service.test.js` 增加：

1. 全空 ID（`questions: [{id: "", ...}]`） → `INTERACTION_QUESTION_ID_INVALID`，backend 未调用
2. 混合空 ID（`[{id: ""}, {id: "q1"}]`） → 同上
3. 重复 ID（`[{id: "q1"}, {id: "q1"}]`） → `INTERACTION_QUESTION_ID_INVALID`，backend 未调用
4. 合法单 token ID 的单/多问题 → 正常通过（回归）

---

## C. 文档偏差修正

**文件**: `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md`

将第 82 行附近"路径不存在时异常并回退 normpath"改为：

> `os.path.realpath()` 默认 `strict=False`，不存在的路径**不会**抛异常，而是尽量解析已存在的前缀后返回路径。`try/except` 仅捕获权限等实际 I/O 异常。功能行为正确，此处修正文字表述。

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
- [ ] 单问题含空白 ID → 通知无任何 `/codex answer` 命令，有 App Server UI 提示
- [ ] 混合 ID（含空白） → 整条通知无命令，有 App Server UI 提示
- [ ] 全单 token 多问题 → 每题有 per-question 命令（回归）
- [ ] 全单 token 单问题 → 有通用命令（回归）

### P1-b
- [ ] 全空 ID → `INTERACTION_QUESTION_ID_INVALID`，不写 durable
- [ ] 混合空 ID → 同上
- [ ] 重复 ID → `INTERACTION_QUESTION_ID_INVALID`，不写 durable
- [ ] 合法 questions → 正常处理（回归）

### 文档
- [ ] 第六轮修复记录中关于 realpath 的描述已更正

---

## 注意事项

1. `validateQuestions` helper 对空 `rawQuestions`（length === 0）返回 `null`（允许通过），由后续 `questions.length` 判断决定走 single-question 还是 legacy {text} 路径——该路径对应 `questions` 字段缺失的旧 interaction，不在本次修复范围。
2. `allAddressable` 判断与 `validateQuestions` 使用相同的"无空白 ID"规则，两者需保持一致。
3. 不提交 git commit / push。
