# HCO 三轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施
**背景**: 二轮修复后复审发现 4 个新问题，经探索与真实 schema 核对确认全部成立，需要三轮根因修复（不打折、不回避复杂 decision 与结构化 answers）。

---

## 权威 schema 来源（本轮基石）

真实 schema 从本机 codex 0.142.3 二进制自带的类型生成器提取，可复现：

```
<codex-binary> app-server generate-ts --experimental --out <dir>
# 产物在 <dir>/v2/ 下
```

- 二进制：`/Users/hula/.npm-global/lib/node_modules/@openai/codex`（package.json 与二进制内嵌串均确认版本 `0.142.3`）
- 反向请求方法名（server → client）：`item/commandExecution/requestApproval`、`item/tool/requestUserInput`
- ⚠️ 实施时 **必须** 用上述命令重新生成并对照 `v2/` 下类型，不允许照抄本文档。若本机 schema 与本文档不一致，以本机 schema 为准并在记录文档中说明差异。

### 审批 schema（verbatim）

```ts
// v2/CommandExecutionRequestApprovalParams（server 发来的请求，节选相关字段）
export type CommandExecutionRequestApprovalParams = {
  threadId: string, turnId: string, itemId: string, startedAtMs: number,
  approvalId?: string | null, environmentId: string | null,
  reason?: string | null,
  command?: string | null,
  cwd?: string | null,
  proposedExecpolicyAmendment?: Array<string> | null,
  availableDecisions?: Array<CommandExecutionApprovalDecision> | null,  // ← 选项清单
};

// v2/CommandExecutionRequestApprovalResponse（client 必须回这个）
export type CommandExecutionRequestApprovalResponse = { decision: CommandExecutionApprovalDecision };

export type CommandExecutionApprovalDecision =
    "accept"
  | "acceptForSession"
  | { "acceptWithExecpolicyAmendment": { execpolicy_amendment: Array<string> } }
  | { "applyNetworkPolicyAmendment": { network_policy_amendment: { host: string, action: "allow" | "deny" } } }
  | "decline"
  | "cancel";
```

要点：
- 响应字段名是 **`decision`**，不是 `choice`。
- 简单决策是**裸字符串**；两个带参决策是**外层单键对象**，且内层字段是 **snake_case**（`execpolicy_amendment` / `network_policy_amendment`），外层键是 camelCase — 这是 schema 真实的不一致，不要“修正”。
- 带参决策的参数由 **server 在 `availableDecisions[]` 里给出**。client 只需把operator 选中的那一项**原样回传**，无需operator 输入参数。

### requestUserInput schema（verbatim）

```ts
// v2/ToolRequestUserInputParams（server 发来的请求）
export type ToolRequestUserInputParams = {
  threadId: string, turnId: string, itemId: string,
  questions: Array<ToolRequestUserInputQuestion>,
  autoResolutionMs: number | null,
};
export type ToolRequestUserInputQuestion = {
  id: string, header: string, question: string,
  isOther: boolean, isSecret: boolean,
  options: Array<{ label: string, description: string }> | null,
};

// v2/ToolRequestUserInputResponse（client 必须回这个）
export type ToolRequestUserInputResponse = {
  answers: { [questionId: string]: { answers: Array<string> } },
};
```

要点：
- 请求用 **`questions[]`**，每题有 `id` / `header` / `question` / `options[]`（option 只有 `label`+`description`，label 即取值）。
- 响应是 **map**：`{ answers: { <questionId>: { answers: [字符串...] } } }`。内层 `answers` 是**字符串数组**（多选产生多个元素，单选是单元素数组）。

---

## 设计总纲：转换发生在 service.js（能读到 durable interaction）

`hco/service.js` 的 `interactionCommand` 能拿到 `interaction`（含原始 `request`）。因此 **所有 schema 转换都在这里做**，operator 的命令行保持简单：

- 审批：operator 提交 `choice`（一个 key 字符串）。service.js 在 `interaction.request.availableDecisions` 里按 key 找到对应决策：裸串→`{decision: "<choice>"}`；对象决策（单键==choice）→`{decision: <完整对象>}`（保留 server 提议的参数）。找不到 availableDecisions 时回退 `{decision: "<choice>"}`。
- 用户输入：operator 提交文本。service.js 读 `interaction.request.questions`：单题→映射到该题 id；多题→按扩展语法定位具体题目 id。最终组装 `{answers: {<id>: {answers: [text]}}}`。

Renderer（turn-controller.js）职责：把 server 给的 `availableDecisions` / `questions` **如实展示成可操作命令**，包含每个 decision 的 key、每个 question 的 id/选项。

---

## 问题确认（全部成立）

| ID | 严重性 | 结论 |
|----|--------|------|
| P1-1 | 严重 | 审批发 `{choice}`，真实 schema 要 `{decision}`；且对象决策参数被丢弃 |
| P1-2 | 严重 | requestUserInput 用 `questions[]`，renderer 读不到；回答发 `{text}`，schema 要 `{answers:{id:{answers:[]}}}` |
| P2-1 | 中 | `cwd in text` 裸子串匹配，`/workspace/a` 误命中 `/workspace/alpha` |
| P2-2 | 中 | 只认紧邻上下文词的 projectId，常见介词短语绕过；`repositoryASK` 误报风险 |

---

## A. 审批 choice → decision（根因修复，保留对象参数）

### A1. service.js 决策查表转换

**文件**: `hco/service.js`，`interactionCommand`（约 510 行）

把：
```javascript
const answer = command.type === "APPROVE" ? { choice: command.choice } : { text: command.text };
```
改为分支处理。审批分支新增 helper：

```javascript
function resolveApprovalDecision(interaction, choiceKey) {
  const available = interaction?.request?.availableDecisions;
  if (Array.isArray(available)) {
    for (const d of available) {
      if (typeof d === "string" && d === choiceKey) return d;                 // 裸串
      if (d && typeof d === "object" && Object.keys(d).length === 1 &&
          Object.keys(d)[0] === choiceKey) return d;                          // 完整对象决策（含 server 参数）
    }
  }
  return choiceKey; // 回退：server 未提供 availableDecisions
}
```
审批：`const answer = { decision: resolveApprovalDecision(interaction, command.choice) };`

**注意**：`interaction` 在 `interactionCommand` 中已从 store 读出（用于 target/ACL 校验）。若当前作用域没有原始 `request`，需确认 `store.readInteraction` 返回体是否包含 `request`；如不包含，需在读取处一并取回（只读，不改 schema）。

### A2. Renderer 如实列出 availableDecisions

**文件**: `hco/turn-controller.js` 审批分支

- 有 `availableDecisions[]`：逐项取 key（裸串取自身，对象取其唯一键），每项渲染 `- \`/codex approve <id> <key>\``。
- 无：回退默认 `accept` / `cancel`。
- 对带参对象决策：在该行后追加只读说明，展示 server 提议的参数（如 `execpolicy_amendment: ["npm","test"]`），让 operator 知道批准将附带什么，但**无需手输**。

### A3. 测试（真实 fixture）

`test/turn-controller.test.js` / `test/hco-service.test.js`：
- `availableDecisions: ["accept", "decline", {acceptWithExecpolicyAmendment:{execpolicy_amendment:["npm","test"]}}]`
- operator `choice="accept"` → 回 `{decision:"accept"}`
- operator `choice="acceptWithExecpolicyAmendment"` → 回**完整对象**（含 `execpolicy_amendment`），断言参数未丢失
- 无 availableDecisions → 回 `{decision:"accept"}`
- 断言 `respondToInteraction` 的 `result` 完全等于期望对象

---

## B. requestUserInput questions[] + answers map（根因修复）

### B1. Renderer 展开 questions[]

**文件**: `hco/turn-controller.js` `item/tool/requestUserInput` 分支

- 读 `request.questions[]`，逐题渲染：`header`（若有）、`question` 正文、`(ID: <id>)`、`options[]` 的 `label` 列表（附 `description`）。
- 单题：`输入: /codex answer <interactionId> <你的回答>`
- 多题：对每题渲染 `回答「<header/question>」: /codex answer <interactionId> <questionId> <你的回答>`，并说明“每题一条命令，全部回答后自动提交”。
- `isSecret` 的题：提示 operator 该输入敏感（不额外处理存储，仅提示）。

### B2. service.js 组装 answers map

**文件**: `hco/service.js` answer 分支

读 `interaction.request.questions`：
- **单题**：`{answers: {[questions[0].id]: {answers: [command.text]}}}`
- **多题（扩展语法）**：把 `command.text` 按首个空白切成 `<questionId>` + `<剩余为答案>`。`questionId` 必须匹配某题 `id`，否则返回可读错误提示 operator 指定题目 id。命中则该题答案 = 剩余文本。
- 无 `questions`（异常/旧数据）：回退 `{text: command.text}` 并在记录文档标注。

命令行 grammar **不改 plugin.py**：`/codex answer <replyToken> <text>` 的 `text` 承载“<questionId> <答案>”，由 service.js 依据 durable interaction 解释。

### B3. 多题的一次性提交（durable 部分累积）

多题需集齐所有 `questions[].id` 才能向 App Server 回一次完整 map。设计：

- 仅对 **requestUserInput 且 questions 数 > 1** 启用累积；审批与单题走现有一次性路径，**不改其已测语义**。
- 在 interaction 上持久化 `partialAnswers`（map: questionId → [answers]）。每条 `/codex answer <id> <qid> <text>`：
  - 校验 `qid ∈ questions[].id`；合并进 `partialAnswers`（同 qid 覆盖，允许改答）。
  - 若 `partialAnswers` 覆盖全部题 id → 组装完整 `{answers:{...}}`，走 backend `respondToInteraction`，置 answered。
  - 否则持久化 partial，返回 `status:"partial"`，回执列出仍缺的题目。
- 幂等/冲突：完成前允许覆盖；完成后沿用现有冲突规则（不同最终 map = 冲突）。
- 存储改动限定在支持 `partialAnswers` 的最小列/字段；**不得回归审批与单题路径**。

> 若实施中发现 App Server 接受“逐题部分响应”，可简化为不累积、逐题直接回；但在未从本机 schema/行为确认前，默认按“集齐后一次性提交”，因为响应类型是完整 map。是否支持部分提交需在记录文档中明确写清实测结论。

### B4. 测试（真实 fixture）

`test/turn-controller.test.js` / `test/hco-service.test.js`：
- 单题：`questions:[{id:"q1",header:"环境",question:"选择环境",isOther:false,isSecret:false,options:[{label:"staging",description:"预发"},{label:"production",description:"生产"}]}]`
  - renderer 含 `q1`、`staging`、`production`、`/codex answer <id> <你的回答>`
  - answer 文本 "staging" → 回 `{answers:{q1:{answers:["staging"]}}}`
- 多题：`q1`+`q2`
  - renderer 为每题给出 `/codex answer <id> q1 ...` / `q2 ...`
  - 先答 q1 → `status:"partial"`，回执含“仍需 q2”，**未**调用 backend
  - 再答 q2 → 调用 backend 一次，`result` == `{answers:{q1:{answers:[..]},q2:{answers:[..]}}}`
- 无效 qid → 可读错误，不调用 backend

---

## C. CWD 路径边界匹配（消除误报）

**文件**: `plugin/hermes-codex-bridge/plugin.py`（约 449 行）

把裸 `cwd in text` 换成边界感知匹配：cwd 命中后，其**后一字符**不得是路径续接字符（`[A-Za-z0-9_\-./]`），避免 `/workspace/a` 命中 `/workspace/alpha`、`/workspace/beta` 命中 `/workspace/beta-staging`。前一字符不得是路径字符（避免 `/x/workspace/beta`）。

```python
def _cwd_referenced(text: str, cwd: str) -> bool:
    if not cwd or not text:
        return False
    pat = r"(?<![A-Za-z0-9_./-])" + re.escape(cwd) + r"(?![A-Za-z0-9_./-])"
    return re.search(pat, text) is not None
```

测试（`test/hermes_plugin_contract_test.py`）：
- `alpha=/workspace/alpha`, `a=/workspace/a`，指令引用 `/workspace/alpha` → **通过**
- `/workspace/beta-staging` / `_prod` / `.backup` 不命中外部 `/workspace/beta`
- `在 /workspace/beta 中执行` → **拒绝**（真实边界命中）

---

## D. projectId 显式引用（补齐介词短语，防复合词误报）

**文件**: `plugin/hermes-codex-bridge/plugin.py` `_mentions_project_id`

在现有“紧邻上下文词”规则基础上，新增介词短语规则，全部保持 pid 两侧词边界 `(?<![A-Za-z0-9_-])`/`(?![A-Za-z0-9_-])`（复合词 `repositoryASK` 因此不命中）：

- 中文：`(?:在|到|切换到|切到|使用|用|检查|查看|查|操作|进入)\s*<pid>\s*(?:中|里|下|执行|操作|运行|仓库|项目|代码|目录)?` — 覆盖“请切换到 ASK 执行 / 请在 ASK 中执行 / 检查 ASK 的仓库”。
- 英文（`re.IGNORECASE` 仅用于介词部分，pid 本身仍大小写敏感匹配）：`(?:in|into|to|use|using|switch to|check|inspect|open|enter)\s+<pid>\b` — 覆盖 “use ASK for this task / switch to ASK / in ASK”。
  - ⚠️ pid 的大小写敏感通过在正则里用原样 `re.escape(pid)` 且不对 pid 段加 IGNORECASE 实现；避免 `Ask the user` 误命中 `ASK`。若正则难以对“介词大小写不敏感 + pid 大小写敏感”分段，采用两步：先大小写敏感定位 pid 词边界，再检查其邻近介词（可小写化邻近窗口判断）。

测试：
- 拒绝：`请切换到 ASK 执行`、`请在 ASK 中执行`、`检查 ASK 的仓库`、`use ASK for this task`、`switch to ASK`
- 不误报：`repositoryASK`、`Ask the user before changing the API.`、`Do not ask for approval.`
- 保留二轮已有：`请在 ASK 仓库中执行` 仍拒绝；自身项目名不拒绝

---

## E. 文档更新

新建 `docs/superpowers/records/2026-07-20-hco-third-pass-fix-record.md`，必须含：
1. 四问题结论与严重性
2. 每问题的修复文件/函数/关键逻辑
3. **本机 schema 核对结论**（生成命令、版本、与本文档是否一致）
4. 测试命令与结果
5. 仍未解决的限制（如多题部分提交是否被 server 接受的实测结论；`isSecret` 仅提示未加密存储等）

---

## 验证命令

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js   # 全量回归
```

---

## 验收标准

### 审批
- [ ] service.js 回 `{decision: ...}`（非 `choice`）
- [ ] 对象决策（acceptWithExecpolicyAmendment）原样回传，`execpolicy_amendment` 参数不丢失
- [ ] renderer 依 availableDecisions 列出每个 key 命令
- [ ] 无 availableDecisions 时回退 accept/cancel 且仍发 `{decision}`

### requestUserInput
- [ ] renderer 展开 questions[]，显示 id/question/options
- [ ] 单题回 `{answers:{<id>:{answers:[text]}}}`
- [ ] 多题：逐题命令、集齐后一次性提交完整 map、缺题回执 partial
- [ ] 无效 questionId 有可读错误

### CWD 边界
- [ ] `/workspace/alpha` 不被 `/workspace/a` 误拦
- [ ] `-staging`/`_prod`/`.backup` 后缀不误命中
- [ ] 真实 `在 /workspace/beta 中` 仍拒绝

### projectId 介词短语
- [ ] 五个绕过样例全部拒绝
- [ ] `repositoryASK` 与普通英文 `ask` 不误报

---

## 注意事项

1. **必须先用本机 `codex app-server generate-ts --experimental` 核对 schema**，与本文档冲突时以本机为准并记录。
2. 转换集中在 service.js；不改 plugin.py 的 `/codex approve|answer` wire grammar。
3. 多题累积仅作用于 requestUserInput 多题路径，**不得回归审批/单题已测语义**。
4. 保持 P2 匹配大小写敏感策略（避免 `Ask` 误杀）；新增介词规则不得破坏该性质。
5. 不提交 git commit，由上层统一提交。
6. 测试必须使用**真实 schema 形状**的 fixture（availableDecisions 含对象决策、questions[] 含 id/options），不得用 `{prompt:...}`/`{choice}` 这类掩盖问题的假 fixture。
