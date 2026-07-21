# HCO 第十轮缺陷修复实施方案 v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. 本文件仅为实施方案；本次审查不执行下列代码修改。

**目标：** 修复九轮修复后复审确认的 4 个 P1、2 个 P2、2 个 P3 问题，使 Zulip 审批、超长交互、项目引用、错误传播、ACL 错误边界和跨语言 Unicode 校验保持真实 schema 与可信授权语义。

**架构：** 在 Node 侧新增共享的交互策略模块，统一审批方法、扩展权限字段、扩展决策、可寻址 question ID 和决策解析，避免 `service.js` 与 `turn-controller.js` 再次出现规则漂移。桥接 HTTP 层不把错误的 `code` 字段当作类型证明，而是分别依赖 `isStateError`、`isTurnControllerError` 和新增的 `isAclError` 所有权标记；Python 侧使用明确的 ECMAScript whitespace 集合，不再直接使用 Python `isspace()`。

**技术栈：** Node.js ESM、`node:test`、SQLite durable store、Python `pytest`、Hermes bridge client。

## 全局约束

- 只修改本方案列出的文件，不回滚工作区现有未提交改动。
- `commandActions` 只用于展示，不得作为扩展权限判定字段。
- Zulip 命令行对扩展权限审批和不完整审批正文只能允许 `decline`/`cancel`；不得把 UI-only 情况伪装成可批准。
- 所有用户可见的错误必须由可信错误所有权或既有受信任边界产生；仅匹配 `error.code` 不足以公开错误消息。
- Node 与 Python 的 question ID 判定必须对 U+FEFF、U+0085 给出一致结果；不得继续依赖 Python `str.isspace()` 作为协议定义。
- 不改变无关的持久化 schema、路由协议或已有成功响应结构。
- 实施阶段每个任务先写回归测试，再写最小实现；本次只生成计划，不执行任何实现或测试命令。

## 现状核对与关键阻塞项

以下结论来自当前工作树的真实代码，而不是沿用初版方案中的假设：

1. `hco/turn-controller.js` 当前已有 `controllerError`、`isTurnControllerError` 和 `EXTENDED_PERMISSION_FIELDS`，但后者错误包含 `commandActions`；当前只过滤 `accept`/`acceptForSession`。
2. `hco/service.js` 当前已有 `resolveApprovalDecision` 与 `isSafeQuestionId`，但没有 service 层的扩展权限强制；其 question ID 校验与 renderer 的校验也有重复实现。
3. `toCompactContent` 当前只接收 `(interactionId, method, hasExtendedPermissions)`，而 `requestObject`、`questions`、`allAddressable` 在 renderer 的 `try` 块内部计算，不能直接在函数外假定为可用变量。
4. 代码库中没有 `HIGH_RISK_PERMISSION_FIELDS`，也没有 `escapeMd`；实施时必须定义实际函数/常量，不能直接套用初版方案片段。
5. `turn-controller.js` 的 `answerInteraction` 抛出由 `OWNED_ERRORS` 标记的 controller error；`hco/bridge/server.js` 目前只识别 state error。不要为了让 server 识别而把 controller 层直接改为依赖 `stateError`，否则会混淆错误所有权。
6. `hco/acl.js` 的 `aclError` 当前没有所有权标记；因此 server 不能安全地通过 `error.code === "ACL_FORBIDDEN"` 判断来源。
7. Python 项目引用检测位于 `plugin.py:436-484`，边界当前不包含点号，英文 verb-object 规则也没有 `handle`/`investigate`；仅把项目 ID 长度设为大于 3 不能解决项目名为 `test` 的误报。
8. Python `_is_safe_question_id` 当前使用 `isspace()`；Node 使用 ECMAScript `\s`。U+FEFF 与 U+0085 的处理必须按 Node 协议集合显式对齐。

## 修复范围

### 新增

- `hco/interaction-policy.js` — Node 侧共享交互策略与 schema 辅助函数。

### 修改

- `hco/turn-controller.js` — renderer、精简通知、Markdown 安全展示、扩展审批决策过滤、共享 question ID 校验。
- `hco/service.js` — service-level 扩展权限强制、共享决策解析与 question ID 校验。
- `hco/bridge/server.js` — controller/ACL 所有权识别和稳定 HTTP 状态映射。
- `hco/acl.js` — ACL 错误所有权标记与 `isAclError` 导出。
- `plugin/hermes-codex-bridge/plugin.py` — 项目引用正则和 Python question ID whitespace 定义。
- `plugin/hermes-codex-bridge/bridge_client.py` — 新增用户可纠正错误码。
- `package.json` — 将新增 Node 模块纳入 `npm run check`。

### 测试

- `test/turn-controller.test.js`
- `test/hco-service.test.js`
- `test/bridge-server.test.js`
- `test/option-c-e2e.test.js`
- `test/hermes_plugin_contract_test.py`

不新增或修改记录文件、数据库迁移和外部协议版本；本文件本身是本次唯一交付物。

---

## Task 1：建立共享交互策略接口

**文件：**

- Create: `hco/interaction-policy.js`
- Modify: `hco/turn-controller.js`
- Modify: `hco/service.js`
- Test: `test/turn-controller.test.js`
- Test: `test/hco-service.test.js`

**接口要求：** 新模块必须导出以下实际名称，后续任务不得另造同义常量：

```javascript
export const APPROVAL_METHODS;
export const EXTENDED_PERMISSION_FIELDS;
export const EXTENDED_PERMISSION_DECISIONS;
export const SAFE_ZULIP_APPROVAL_DECISIONS;
export function decisionKey(decision);
export function approvalDecisionKeys(request);
export function hasExtendedPermissions(request);
export function isSafeQuestionId(value);
export function analyzeQuestions(request);
```

实施步骤：

- [ ] 定义 `APPROVAL_METHODS` 为 `item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval`。
- [ ] 定义 `EXTENDED_PERMISSION_FIELDS` 为当前真实 schema 中代表额外授权的字段：`networkApprovalContext`、`additionalPermissions`、`proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments`、`grantRoot`；明确不包含 `commandActions`。
- [ ] 定义 `EXTENDED_PERMISSION_DECISIONS` 为 `acceptWithExecpolicyAmendment` 与 `applyNetworkPolicyAmendment`，以便即使上游没有附带权限字段，service 仍拒绝对应的 Zulip 批准。
- [ ] 定义 `SAFE_ZULIP_APPROVAL_DECISIONS` 为 `decline` 与 `cancel`。
- [ ] `decisionKey` 只接受字符串或恰好只有一个键的 plain object；其他值返回 `null`，不得通过 `Object.keys(value)[0]` 让 malformed decision 变成可执行命令。
- [ ] `approvalDecisionKeys` 对 `request.availableDecisions` 做真实 schema 解析；数组为空或缺失时返回当前兼容默认值 `accept`、`cancel`，数组存在但包含非法项时只返回合法 key，并由 service 的既有决策错误处理最终拒绝非法输入。
- [ ] `hasExtendedPermissions(request)` 返回权限字段命中或可用决策包含 `EXTENDED_PERMISSION_DECISIONS`；`commandActions` 不得触发该结果。
- [ ] `isSafeQuestionId` 统一 Node 侧规则：非空字符串、无 ECMAScript `\s`、无 U+0000–U+001F/U+007F、UTF-8 不超过 256 bytes。后续 renderer、service 必须调用它。
- [ ] `analyzeQuestions(request)` 返回 `{ questions, allAddressable }`：`questions` 保留真实数组；`allAddressable` 只有在数组非空、每项为 plain object、ID 合法且不重复时为 `true`。
- [ ] 将 `turn-controller.js` 内部 `EXTENDED_PERMISSION_FIELDS`、内联 question ID 检查和 `service.js` 内部 `isSafeQuestionId`/重复决策解析替换为上述接口；不要改变既有错误码文本以外的行为。

测试要求：

- [ ] 增加共享策略覆盖：`commandActions` 不触发扩展权限；五个权限字段和两个扩展决策分别触发；字符串 decision、单键对象 decision、非法 decision 的解析结果明确。
- [ ] 增加 Node question ID 边界：普通 ID、空白、控制字符、256/257 UTF-8 bytes、U+FEFF、U+0085。

验收标准：`service.js` 与 `turn-controller.js` 不再各自维护一份会漂移的扩展权限/question ID规则，且不存在未定义的 `HIGH_RISK_PERMISSION_FIELDS` 或 `escapeMd` 引用。

---

## Task 2：阻断 Zulip 扩展权限审批（P1-1）并修正 `commandActions`（P2-2）

**文件：**

- Modify: `hco/service.js:530-670`
- Modify: `hco/turn-controller.js:14-151`
- Modify: `plugin/hermes-codex-bridge/bridge_client.py:22-33`
- Test: `test/hco-service.test.js`
- Test: `test/turn-controller.test.js`
- Test: `test/hermes_plugin_contract_test.py`

实施步骤：

- [ ] 在 `service.js` 的 `interactionCommand` 中，完成 interaction 存在性、目标和 ACL 检查后，先用 `resolveApprovalDecision` 验证 `command.choice` 是真实可用决策，再执行扩展权限判定。
- [ ] 当 `hasExtendedPermissions(interaction.request)` 为真时，只允许 key 属于 `SAFE_ZULIP_APPROVAL_DECISIONS`；对 `accept`、`acceptForSession`、`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 以及任何未知批准 key 都抛出新的受信任 state error：`INTERACTION_APPROVAL_RESTRICTED`。消息必须明确“扩展权限审批需通过 App Server UI；Zulip 仅可 decline/cancel”。
- [ ] 将 `INTERACTION_APPROVAL_RESTRICTED` 加入 `bridge/server.js` 的 400 输入错误集合，并加入 `bridge_client.py` 的 `USER_FACING_ERROR_CODES`，确保 Zulip 用户收到原始用户可读消息，而不是通用 protocol error。
- [ ] 在 renderer 中使用共享 `hasExtendedPermissions`；过滤逻辑改为只保留 `decline`/`cancel`，不得只排除两个旧 key。没有可保留的安全操作时显示 UI-only 提示，不生成虚假的命令。
- [ ] 确认 `commandActions` 从 `EXTENDED_PERMISSION_FIELDS` 移除后，普通审批仍展示其真实 `availableDecisions`；它只可以作为详情展示，不改变可批准性。
- [ ] 保留已有 `availableDecisions` 校验：命令行不能凭空接受不在真实数组中的决策。

测试要求：

- [ ] service 测试覆盖每个扩展字段、两个扩展决策和 `commandActions`：前两类的 accept/acceptForSession/扩展批准均拒绝，decline/cancel 成功；仅 `commandActions` 的普通 accept 成功。
- [ ] renderer 测试覆盖自定义决策数组：扩展权限下只出现真实存在的 decline/cancel，不出现 accept 或 fallback accept；普通审批显示 `commandActions` 存在时的 accept。
- [ ] bridge client 测试确认 `INTERACTION_APPROVAL_RESTRICTED` 作为 `BridgeUserError` 返回。

验收标准：任何带扩展授权语义的审批无法通过 `/codex approve ... accept*` 或自定义扩展批准 key 完成；普通包含 `commandActions` 的审批不会被误判为扩展权限。

---

## Task 3：让超长通知保持真实交互 schema（P1-2）

**文件：**

- Modify: `hco/turn-controller.js:23-249`
- Test: `test/turn-controller.test.js`

实施步骤：

- [ ] 把 `toCompactContent` 改为唯一明确的签名：

```javascript
function toCompactContent(interactionId, method, {
  requestObject = {},
  questions = [],
  allAddressable = false,
  isSecret = false,
  commandTruncated = false
} = {})
```

- [ ] 在 `defaultInteractionRenderer` 的 `try` 之前，先从 `request` 生成稳定的 `requestObject`、`questions` 和 `allAddressable`，使正常渲染、catch fallback、compact fallback 使用同一份输入，不从 `try` 块外引用不存在的局部变量。
- [ ] 审批 compact 内容从 `approvalDecisionKeys(requestObject)` 生成，而不是硬编码 accept/cancel；扩展权限或 `commandTruncated` 时再与安全决策集合求交集。
- [ ] 单问题 user-input compact 保留当前真实交互协议：输出通用 `/codex answer <interactionId> <你的回答>`，因为 service 对单问题使用整段 command text 作为答案。
- [ ] 多问题且 `allAddressable === true` 时为每个 question 输出真实 ID 命令：`/codex answer <interactionId> <questionId> <你的回答>`；不得退化成无 ID 的通用命令。
- [ ] 多问题包含非法、重复、空白或超长 ID 时输出 UI-only 提示，且不输出任何可寻址命令；仍保留 token 和“完整详情请通过 App Server UI 查看”。
- [ ] compact 中按真实 question schema 处理 `isSecret === true`：只提示“包含敏感输入，请在 App Server UI 完成”，不得把 secret 的候选答案、值或命令参数拼进通知。非 secret 问题可显示安全的 header/ID 摘要。
- [ ] compact 生成后再次以 UTF-8 bytes 检查不超过 `MAX_CONTENT_UTF8_BYTES`；若摘要仍超限，使用只含 token、UI-only 提示和固定短文本的第二级安全 fallback。

测试要求：

- [ ] 超长审批只出现真实 `availableDecisions`，当数组只有 decline 时不得出现 accept/cancel 幻觉；数组含扩展权限时只出现 decline/cancel。
- [ ] 超长单问题、超长多问题、非法 question ID、多问题 secret 分别验证命令形态与 UI-only 行为。
- [ ] 断言 compact 的 UTF-8 bytes 始终不超过 60,000，且 token 始终存在。

验收标准：compact 通知与正常 renderer 使用同一套 available decisions/questions/isSecret 语义；任何命令不会指向实际 service 不接受的操作。

---

## Task 4：把审批正文变成可信授权展示（P1-3）

**文件：**

- Modify: `hco/turn-controller.js`
- Test: `test/turn-controller.test.js`

实施步骤：

- [ ] 新增实际存在的 `escapeMarkdownText(text)`，用于 `reason`、`cwd`、`approvalId`、`itemId`、question header/description 等用户可控的普通 Markdown 文本；至少转义反斜杠、反引号、`*`、`_`、`[`、`]`，并确保换行不会改变标题/列表结构。
- [ ] 不使用“把三反引号替换成 `\`\`\``”作为代码块安全方案：在 fenced code block 内，反斜杠不能可靠阻止 fence 结束。新增 `renderIndentedCode(text)`，将命令按行规范化 CRLF/CR 为 LF，并给每一行（包括空行）加四个空格，避免用户命令关闭 Markdown 容器或伪造后续正文。
- [ ] 生成命令展示前记录 `commandTruncated = command.length > 400`，截断只用于通知长度，不得把截断后的内容当作完整授权证据。
- [ ] 命令超过 400 个 JavaScript 字符时只展示截断预览、明确“完整命令不可在 Zulip 审批”、并将可操作决策限制为真实存在的 decline/cancel；不输出 accept/acceptForSession/扩展批准命令。
- [ ] 命令未截断时展示完整 indented code，并保留真实可选操作；审批 detail 采用安全转义后的单行文本，不把原始对象直接嵌入 Markdown。
- [ ] 对 reason/cwd/command 采用“不泄露原始 Markdown 控制结构”的快照测试，覆盖 ```、反引号、换行、列表前缀、链接括号、粗体/斜体标记。

测试要求：

- [ ] 恶意 command `safe\n```\n- /codex approve ... accept` 不得让输出出现可被 Markdown 解析为正文外部命令的 fence。
- [ ] 401 字符命令仍可完整展示并保留真实安全决策；400 字符边界准确；401+ 字符不出现 accept 命令。
- [ ] 用户可控 reason/cwd 中的 Markdown 不改变通知结构，且正文仍包含审批 token 和 UI 入口。

验收标准：Zulip 中看到的审批命令要么是完整命令，要么明确是不可授权的截断预览；用户无法通过 Markdown 注入伪造审批内容或隐藏危险命令尾部。

---

## Task 5：修复项目引用漏报/误报（P1-4）

**文件：**

- Modify: `plugin/hermes-codex-bridge/plugin.py:436-484`
- Test: `test/hermes_plugin_contract_test.py`

实施步骤：

- [ ] 将 project ID 前后边界从 `(?<![A-Za-z0-9_-])` / `(?![A-Za-z0-9_-])` 改为包含点号的 `(?<![A-Za-z0-9_.-])` / `(?![A-Za-z0-9_.-])`；路径检测 `_cwd_referenced` 保持其独立的路径边界规则，不把两个规则混用。
- [ ] 英文 verb-object 规则补充 `handle`、`investigate`，并保持原有 `fix`、`work on`、`update`、`test`、`check`、`run`、`debug`、`deploy`、`build`、`lint`、`review`。
- [ ] 仅对“动词 + 项目 ID”这一歧义规则加入明确的通用词排除集合，例如 `test`、`run`、`build`、`check`、`debug`、`deploy`、`review`、`lint`、`fix`、`update`；不要用长度阈值，因为项目名 `test` 长度为 4 仍会误报。显式上下文 `project test`、`in test repo`、`test's` 仍应命中，以保留真实项目名可引用能力。
- [ ] 增加中文动词-对象规则：`修复|修改|更新|检查|查看|处理|调查|排查|运行|测试` 后跟 project ID，并允许 `中/里/下/的` 等连接词；因此“修复 beta 中的测试”和“修改 beta 并运行测试”都必须识别 beta。
- [ ] 保持项目 ID大小写行为与现状一致：英文模式不区分大小写，项目 map 的 key 仍作为最终返回值；不要通过 lower-case 破坏原始 ID。
- [ ] 在现有所有文本字段测试（instruction、constraints、acceptanceCriteria、reminders）中加入漏报和误报用例，不只测 instruction。

测试要求：

- [ ] 正向：`Please handle beta failures`、`Investigate beta failures`、`修复 beta 中的测试`、`修改 beta 并运行测试` 均阻断跨项目 dispatch。
- [ ] 边界：foreign `foo` 不得匹配 `foo.bar`；`beta-staging`、`beta_prod`、`beta.backup` 不得误当成 beta。
- [ ] 项目名为 `test` 时，`run test` 不阻断；`work in test`、`project test`、`test repo` 仍阻断。
- [ ] 既有 cwd 精确路径、子路径、symlink canonical path 测试全部保持通过。

验收标准：语义项目引用检测覆盖新增英文/中文动词句式；点号参与边界；只在明确项目上下文或非歧义引用中判定外部项目，不以通用测试词误报。

---

## Task 6：完整传播用户可纠正错误（P2-1）

**文件：**

- Modify: `hco/bridge/server.js:5-85`
- Modify: `plugin/hermes-codex-bridge/bridge_client.py:22-33`
- Test: `test/bridge-server.test.js`
- Test: `test/option-c-e2e.test.js`
- Test: `test/hermes_plugin_contract_test.py`

实施步骤：

- [ ] 在 `bridge/server.js` 导入现有 `isTurnControllerError`；不要在 `turn-controller.js` 导入 `stateError`，也不要把 controller error 伪装成 state error。
- [ ] 定义受信任的 `CONTROLLER_INPUT_CODES`：`INTERACTION_ORPHANED`、`INTERACTION_EXPIRED`、`INTERACTION_UNAUTHORIZED`、`INTERACTION_TARGET_MISMATCH`、`INTERACTION_ANSWER_CONFLICT`、`INTERACTION_ANSWER_INVALID`。只在 `isTurnControllerError(error)` 为真时使用这些 code/message。
- [ ] `normalizeError` 映射规则：controller owned 且属于上述可纠正输入的错误返回 400；`INTERACTION_ANSWER_CONFLICT` 可保持 409 的冲突语义，但必须在测试中固定，不能掉到 500。已由 service 产生的同 code state error 继续走既有 state 分支。
- [ ] 将相同 code 加入 `bridge_client.py` 的 `USER_FACING_ERROR_CODES`，使 400/409 响应变成 `BridgeUserError` 并由 plugin 原样显示；`INTERACTION_TARGET_MISMATCH` 已有时只补齐缺失项。
- [ ] 使用真实 `TurnController.answerInteraction` 产生 owned controller error 的 HTTP 路径测试，而不是只让 event handler 抛一个手工设置 `code` 的普通 Error；这样能证明 ownership check 真正在工作。
- [ ] 额外测试同样 `code` 的未标记 Error 仍为 500/`BRIDGE_INTERNAL`，防止修复退化为 code-only 信任。

测试要求：

- [ ] HTTP 真实路径覆盖 orphaned、expired、unauthorized、answer conflict 至少各一项，验证状态码、错误码、用户可读 message。
- [ ] server 单测验证伪造 `{ code: "INTERACTION_EXPIRED", message: "secret" }` 不公开 message。
- [ ] Python bridge client 解析所有新增用户错误码为 `BridgeUserError`，未知 4xx 仍为 protocol error。

验收标准：用户因 interaction 过期、孤儿、未授权或答案冲突得到可纠正的 4xx，而不是 500；未经 controller 所有权标记的同名错误不会穿透内部错误信息。

---

## Task 7：收紧 Bridge ACL 错误信任边界（P3-1）

**文件：**

- Modify: `hco/acl.js:16-20,31-80`
- Modify: `hco/bridge/server.js:68-85`
- Test: `test/bridge-server.test.js`
- Test: `test/hco-service.test.js`

实施步骤：

- [ ] 在 `hco/acl.js` 增加模块私有 `OWNED_ERRORS = new WeakSet()`；`aclError` 创建 Error 后加入该集合，并导出 `isAclError(error)`，实现方式与 state/controller error 所有权检查一致。
- [ ] 不改变 ACL 的错误码和消息；`ACL_FORBIDDEN` 仍由 `createAcl().require()` 产生，只是附加可信所有权。
- [ ] 在 `bridge/server.js` 导入 `isAclError`，将当前 `(isStateError(error) || error?.code === "ACL_FORBIDDEN")` 改为 `isStateError(error) || isAclError(error)`，并继续用 `CONFLICT_STATE_CODES` 控制 409 映射。
- [ ] 对普通 `Error`、带有 `code = "ACL_FORBIDDEN"` 的 Error、带有继承/代理属性的伪造对象均返回 `BRIDGE_INTERNAL`，不公开其 message。

测试要求：

- [ ] 真实 ACL deny 仍返回 409、`ACL_FORBIDDEN` 和既有安全消息。
- [ ] event handler 抛出伪造 ACL code 时返回 500、`BRIDGE_INTERNAL`，响应不含伪造 message。
- [ ] 既有 service ACL 单测确认 `isAclError(error) === true`，普通同码 Error 为 false。

验收标准：只有 HCO ACL 模块实际创建并标记的错误才能被桥接层作为 ACL 冲突公开；攻击者不能通过构造同名 code 伪造信任边界。

---

## Task 8：统一 Python/Node Unicode whitespace（P3-2）

**文件：**

- Modify: `plugin/hermes-codex-bridge/plugin.py:908-920`
- Modify: `hco/interaction-policy.js`（Node 侧规则集中位置）
- Test: `test/hermes_plugin_contract_test.py`
- Test: `test/turn-controller.test.js`
- Test: `test/hco-service.test.js`

实施步骤：

- [ ] 在 Python 中定义完整且固定的 `_ECMASCRIPT_WHITESPACE`：`\u0009`–`\u000D`、U+0020、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000、U+FEFF；不要再调用 `character.isspace()`。
- [ ] `_is_safe_question_id` 改为：非空字符串；任意字符属于 `_ECMASCRIPT_WHITESPACE` 即拒绝；U+0000–U+001F 或 U+007F 即拒绝；UTF-8 bytes 不超过 256。不要用 `value.strip()` 判断非空，因为 Python `strip()` 会把 U+0085 当作空白，而 Node 的 `\s` 不会。
- [ ] Node 共享 `isSafeQuestionId` 使用同一协议语义：`\s` 与控制字符检查，确保 U+FEFF 拒绝、U+0085 允许（只要不触发其他控制规则）。
- [ ] 保持正常 ASCII、非 ASCII 非空 ID 和 UTF-8 byte 限制行为不变。

测试要求：

- [ ] 两端均验证：`q1` 通过；空格、NBSP、U+FEFF、U+2003、换行、DEL 拒绝。
- [ ] 两端均验证：嵌入 U+0085 的 ID 不因 `isspace()` 被拒绝；该字符不是 Node `\s`，且不属于 C0/DEL 控制范围。
- [ ] 256 bytes 通过、257 bytes 拒绝；重复 ID 和空 ID 仍由 question schema 校验拒绝。
- [ ] partial answer 的 `missingQuestionIds` 在 Python renderer 中使用同一判定；含 U+FEFF 的返回必须是 protocol error，含 U+0085 的合法 ID 必须能正常显示。

验收标准：Python 返回 missing question ID 的可接受集合与 Node 产生/接受的 question ID 完全一致；U+FEFF 不再被 Python 错放行，U+0085 不再被 Python 独有拒绝。

---

## Task 9：回归验证与文档一致性检查

**文件：**

- Verify only: `hco/interaction-policy.js`
- Verify only: `hco/turn-controller.js`
- Verify only: `hco/service.js`
- Verify only: `hco/bridge/server.js`
- Verify only: `hco/acl.js`
- Verify only: `plugin/hermes-codex-bridge/plugin.py`
- Verify only: `plugin/hermes-codex-bridge/bridge_client.py`
- Modify: `package.json`
- Verify only: `test/turn-controller.test.js`
- Verify only: `test/hco-service.test.js`
- Verify only: `test/bridge-server.test.js`
- Verify only: `test/option-c-e2e.test.js`
- Verify only: `test/hermes_plugin_contract_test.py`

实施步骤：

- [ ] 先运行受影响的 Node 测试：`npm run turn-controller:test`、`npm run hco-service:test`、`npm run bridge:test`、`node --test test/option-c-e2e.test.js`。
- [ ] 运行 Python 合同测试：`python -m pytest -q test/hermes_plugin_contract_test.py`。
- [ ] 运行静态语法检查：`npm run check`，并确认新增 `hco/interaction-policy.js` 已纳入 `package.json` 的 check 列表；若实施者不扩展脚本，则至少执行 `node --check hco/interaction-policy.js`。
- [ ] 运行完整既有验证入口：`npm run verify`；失败时只修复本轮相关回归，不修改无关问题。
- [ ] 用 `git diff --name-only` 检查本轮实现只触及本方案文件；本方案自身生成阶段不得修改业务代码。
- [ ] 搜索阻塞项：`rg -n "HIGH_RISK_PERMISSION_FIELDS|escapeMd|throw stateError" hco/turn-controller.js hco/service.js`，确认没有未定义引用、controller 层错误的跨层伪造或遗留初版片段。
- [ ] 搜索规则漂移：`rg -n "EXTENDED_PERMISSION_FIELDS|isSafeQuestionId|isspace\(|\\\\s" hco plugin/hermes-codex-bridge/plugin.py`，确认 Node 规则来自共享模块，Python 不再使用 `isspace()`，而 `commandActions` 不在扩展权限字段集合。

最终验收：

- [ ] 8 个问题均有对应回归测试，且每个测试验证真实失败模式而不是只验证函数存在。
- [ ] 4 个 P1 不存在命令行越权、schema 幻觉、Markdown 伪造授权或项目引用漏报/误报。
- [ ] 2 个 P2 的用户错误可达且 commandActions 不再隐藏普通审批。
- [ ] 2 个 P3 的错误类型与 Unicode 协议边界均由测试固定。
- [ ] 所有既有相关测试通过，未改变不相关功能和持久化数据格式。

## 实施注意事项

1. 当前工作区已有多处未提交改动；实施者必须逐文件查看 diff，不得用 checkout/reset 清理工作区。
2. 不要把 `HIGH_RISK_PERMISSION_FIELDS` 直接复制到两个文件；它应由 `hco/interaction-policy.js` 导出，避免下一轮再次出现 service/renderer 不一致。
3. 不要用“过滤 accept/acceptForSession”代表扩展权限安全；安全集合必须是显式 allow-list：`decline`、`cancel`。
4. 不要通过 `error.code` 单独判断 controller 或 ACL 错误；所有权标记是公开用户消息的必要条件。
5. 不要以项目 ID 长度解决 `test` 误报；必须区分歧义的 verb-object 句式与明确项目上下文。
6. 不要把 Python `isspace()` 与 Node `\s` 视为同一协议；尤其要保留 U+0085 的 Node 兼容行为并拒绝 U+FEFF。
