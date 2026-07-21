# HCO 十一轮缺陷修复方案

**日期**: 2026-07-21
**状态**: 待实施
**背景**: 十轮修复后审查发现 9 项剩余问题（3P1 + 6P2），集中在审批安全和精简通知路径未闭环。

---

## P1-1: 命令截断后精简通知重新放出 accept

**文件**: `hco/turn-controller.js:280`

**问题**: 完整渲染器命令超 400 字符时只保留 decline/cancel，但超 60KB 触发精简渲染时未传 `cmdTruncated`，精简版按原始 decisions 重新输出 accept。

**修复**: 将 `cmdTruncated` 状态提升到 renderer 顶层，传入 `toCompactContent`，精简审批分支据此过滤：
```javascript
// toCompactContent 增加 cmdTruncated 参数
function toCompactContent(interactionId, method, context = {}) {
  const { requestObject = {}, questions = [], allAddressable = false, cmdTruncated = false } = context;
  // ...审批分支：
  const restrictToSafe = hasHighRisk || cmdTruncated;
  const displayKeys = restrictToSafe ? keys.filter(k => ["decline", "cancel"].includes(k)) : keys;
```

调用点传入 cmdTruncated（需将 cmdTruncated 变量提升到 try 外层可访问）。

---

## P1-2: 扩展权限判断与真实 schema 不一致

**文件**: `hco/service.js:662`, `hco/turn-controller.js:14`

**问题**:
1. HIGH_RISK_FIELDS 遗漏 `proposedExecpolicyAmendment`
2. `availableDecisions` 中的对象决策 `acceptWithExecpolicyAmendment`/`applyNetworkPolicyAmendment` 本身即授予策略修正，即使无其他高危字段也应拒绝命令行执行

**修复**:
1. service.js HIGH_RISK_FIELDS 加入 `proposedExecpolicyAmendment`
2. service.js 强制逻辑：不仅检查高危字段，还要检查 resolved decision 是否为对象类型（对象决策 = 携带参数的授权，一律拒绝命令行）：
```javascript
if (command.type === "APPROVE") {
  const HIGH_RISK_FIELDS = ["networkApprovalContext", "additionalPermissions",
                            "proposedNetworkPolicyAmendments", "proposedExecpolicyAmendment", "grantRoot"];
  const hasHighRisk = HIGH_RISK_FIELDS.some(f => interaction.request?.[f] != null);
  const resolved = resolveApprovalDecision(interaction, command.choice);
  const isObjectDecision = resolved !== null && typeof resolved === "object";
  const key = isObjectDecision ? Object.keys(resolved)[0] : resolved;
  // 对象决策（携带策略修正参数）或高危字段存在时，只允许 decline/cancel
  if ((hasHighRisk || isObjectDecision) && !["decline", "cancel"].includes(key)) {
    throw stateError("INTERACTION_APPROVAL_RESTRICTED", "...");
  }
}
```
3. turn-controller.js EXTENDED_PERMISSION_FIELDS 也加入 `proposedExecpolicyAmendment`；renderer 对对象决策同样过滤（safeChoices 排除 detail !== null 的决策）

---

## P1-3: Markdown 注入伪造审批操作

**文件**: `hco/turn-controller.js:22`（escapeMarkdownTripleBacktick）

**问题**: 只转义三反引号；reason/cwd/问题标题/问题正文/选项描述中的其他 Markdown 控制字符（单反引号、换行+列表符、`*`、`_`、`[]()`）仍可闭合结构插入假命令。

**修复**: 强化转义函数，对所有 user-provided 文本字段统一转义：
```javascript
function escapeMarkdown(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")        // 所有反引号
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ")       // 换行折叠为空格，防止插入列表/命令行
    .replace(/^[>#-]/gm, "\\$&"); // 行首标记
}
```
应用于：reason、cwd、command、question.header、question.question、option.label、option.description。
命令块内用不同策略（放在 ``` 内的内容折叠换行 + 转义反引号即可）。

---

## P2-1: 不可寻址 questions 精简版仍显示必然失败的 answer 命令

**文件**: `hco/turn-controller.js:56-58`

**问题**: `!allAddressable` 时先提示用 UI，紧接着又输出通用 `/codex answer`，该命令会被 service 拒绝。

**修复**: `!allAddressable` 时不输出可执行命令：
```javascript
if (questions.length === 0 || !allAddressable) {
  parts.push("⚠️ 此请求无法通过命令行回答（问题 ID 不可寻址），请使用 App Server UI。");
  // 不再输出通用 /codex answer 命令
} else if (questions.length === 1) {
  ...
```

---

## P2-2: 敏感问题超限后丢失安全警告

**文件**: `hco/turn-controller.js:54-67`（精简输入分支）

**问题**: 精简版不检查 isSecret，仍输出 answer 命令，用户可能在缺少警告时提交敏感数据。

**修复**: 精简输入分支检查任意 question.isSecret，若有则加警告：
```javascript
const hasSecret = questions.some(q => q && typeof q === "object" && q.isSecret === true);
if (hasSecret) {
  parts.push("⚠️ 此交互含敏感输入；桥接不加密持久化，敏感数据建议通过 App Server UI 提交。");
}
```

---

## P2-3: 60KB 限制不是最终输出上限

**文件**: `hco/turn-controller.js:62`

**问题**: 精简版问题标签无长度限制，精简后无二次字节检查。两个合法问题 + 70KB header 可生成约 70KB 精简通知。

**修复**:
1. 标签截断：`const label = (q.header || q.question || q.id || "").slice(0, 100)`
2. `toCompactContent` 返回前二次字节检查，超限则返回硬兜底：
```javascript
const compact = parts.join("\n");
if (Buffer.byteLength(compact, "utf8") > MAX_CONTENT_UTF8_BYTES) {
  return [
    "⚠️ **交互通知过大**",
    `_reply token_: \`${interactionId}\``,
    "请通过 App Server UI 查看并操作。"
  ].join("\n");
}
return compact;
```

---

## P2-4: 畸形 decision 使 renderer 抛裸 TypeError

**文件**: `hco/turn-controller.js:45`

**问题**: `Object.keys(d)[0]` 未排除 null，`[null,"cancel"]` 抛异常；精简渲染在外层 try/catch 之后，兜底接不住。

**修复**: map 时排除 null/非对象：
```javascript
const keys = available
  .map(d => {
    if (typeof d === "string") return d;
    if (d !== null && typeof d === "object" && !Array.isArray(d)) return Object.keys(d)[0];
    return null;
  })
  .filter(Boolean);
```

---

## P2-5: OBJECTIVE_NOT_FOUND 用户可见传播断裂

**文件**: `hco/service.js:339-342`

**问题**: `requireObjectiveProject` 和 status fallback 抛普通 serviceError，bridge 只信任 stateError → status/cancel/continue/thread-bind 查询不存在 objective 时变成 HTTP 500。

**修复**:
1. `requireObjectiveProject` 改用 stateError：
```javascript
if (ownedProjectId === null) throw stateError("OBJECTIVE_NOT_FOUND", "Objective does not exist.");
if (ownedProjectId !== projectId) throw stateError("OBJECTIVE_PROJECT_MISMATCH", "Objective belongs to another project.");
```
2. bridge/server.js CONFLICT_STATE_CODES 确认含 `OBJECTIVE_NOT_FOUND`（已有）和新增 `OBJECTIVE_PROJECT_MISMATCH`
3. bridge_client.py USER_FACING_ERROR_CODES 加入 `OBJECTIVE_PROJECT_MISMATCH`（OBJECTIVE_NOT_FOUND 已有）
4. 检查其他 status/cancel fallback 路径是否也用 serviceError 抛 OBJECTIVE_NOT_FOUND，统一改 stateError

---

## P2-6: 短 projectId 绕过跨项目检测

**文件**: `plugin/hermes-codex-bridge/plugin.py:466-471`

**问题**: `len(project_id) > 3` 守卫 + test 特判完全禁用短 ID 的 verb-object 匹配，但配置允许 1-64 字符 ID，`fix api`、`fix test` 无 cwd/上下文时不被拦截。

**修复**: 去掉长度守卫，对所有 ID 启用 verb-object 规则。短英文单词误报（如项目名恰好是 run/test）的风险低于跨项目污染漏报的风险，采用 fail-safe：
```python
english_verb_object = (
    rf"(?i:(?<![A-Za-z])(?:fix|work on|work in|update|test|check|run|debug|deploy|build|lint|review|handle|investigate)\s+)"
    rf"{project_boundary_before}{escaped}{project_boundary_after}"
)
# 无条件加入 patterns
```

---

## 验证命令
```bash
npm run check
node --test test/*.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/delivery_sidecar_test.py -q
```

## 验收标准
- P1-1: 命令截断 + 超 60KB → 精简版只显示 decline/cancel
- P1-2: 对象决策（acceptWith*）命令行执行 → INTERACTION_APPROVAL_RESTRICTED；proposedExecpolicyAmendment 视为高危
- P1-3: reason/cwd/question 各字段的 Markdown 控制字符被转义，无法插入假命令
- P2-1: 不可寻址 questions 精简版无通用 answer 命令
- P2-2: 含 isSecret 的精简版有安全警告
- P2-3: 超大 header 精简后仍 ≤ 60KB
- P2-4: `[null, "cancel"]` 不抛异常
- P2-5: 不存在 objective 的 status/cancel → 用户可读错误，非 protocol error
- P2-6: `fix api`、`fix test` 引用外部项目被拦截

## 注意
- 不提交 git commit / push
- 每项完成运行对应测试
- 完成后生成 docs/superpowers/records/2026-07-21-hco-eleventh-pass-fix-record.md
