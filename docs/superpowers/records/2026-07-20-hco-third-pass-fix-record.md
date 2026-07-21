# HCO 三轮缺陷修复记录

**日期**: 2026-07-20  
**执行方案**: `docs/superpowers/plans/2026-07-20-hco-third-pass-fix-plan.md`  
**执行结果**: 四项问题均按真实 App Server schema 完成根因修复；未执行 `git commit` 或 `git push`。

## 问题结论

| ID | 严重性 | 复核结论 | 修复结果 |
|---|---|---|---|
| P1-1 | 严重 | 成立。审批响应错误使用 `{choice}`，且对象 decision 的参数无法保留。 | 改为 `{decision: ...}`；按 `availableDecisions` key 查找并原样回传完整 decision 对象。 |
| P1-2 | 严重 | 成立。renderer 未展开 `questions[]`，回答响应也不符合 `answers` map schema。 | renderer 展开所有问题；单题直接映射，多题持久化累积并在集齐后一次提交完整 answers map。 |
| P2-1 | 中 | 成立。CWD 裸子串匹配会把路径前缀误判为外部项目引用。 | 改为路径字符双侧边界匹配。 |
| P2-2 | 中 | 成立。projectId 介词短语覆盖不足，同时复合词可能误报。 | 补齐中英文介词短语，保持 PID 大小写敏感和双侧词边界，避免 `repositoryASK`/普通 `ask` 误报。 |

## 修复详情

### P1-1：审批 decision 原样回显

- `hco/service.js`：新增 `resolveApprovalDecision()`，从 durable interaction 的 `request.availableDecisions` 中按 operator 提交的 key 查找对应项。
- 字符串 decision 返回 `{decision: "accept"}` 等真实响应形状。
- 单键对象 decision 返回 `{decision: <完整对象>}`，保留 server 提供的 `execpolicy_amendment`、`network_policy_amendment` 等全部参数，不让 operator 重输参数。
- 无 `availableDecisions` 的旧数据继续回退为 `{decision: <choice>}`，但不再发送 `{choice}`。
- `hco/turn-controller.js`：approval renderer 由 `availableDecisions` 动态生成全部 `/codex approve` 命令，并展示对象 decision 中 server 已提供的参数。
- `test/turn-controller.test.js`、`test/hco-service.test.js`：加入字符串 decision、带 `execpolicy_amendment` 的对象 decision、无选项回退等真实 fixture。
- `test/option-c-e2e.test.js`：更新重启恢复审批的 E2E 断言，要求发送 `{decision:"accept"}`。

### P1-2：requestUserInput questions 与 answers map

- `hco/turn-controller.js`：展开 `questions[]` 的 `header`、`question`、`id`、`options[].label/description`；多题为每个 questionId 生成独立命令；`isSecret` 只提示敏感性。
- `hco/service.js`：单题回答转换为 `{answers:{<questionId>:{answers:[<text>]}}}`。
- `hco/service.js`：多题把 `/codex answer <replyToken> <questionId> <answer>` 中的首个 token 解释为 questionId；无效 ID 抛出可读的 `INTERACTION_QUESTION_ID_INVALID`，且不调用 backend。
- `hco/service.js`：多题未集齐时返回 `status:"partial"` 和 `missingQuestionIds`；集齐后只调用一次 `respondToInteraction`，提交完整 answers map。
- `hco/state/store.js`：读取并持久化 `partialAnswers`；完成回答或 interaction orphan 后清理部分答案。
- `hco/state/migrations.js`：新增 v6 `interaction_partial_answers` migration 和 nullable `partial_answers_json`。现有 interaction CHECK 要求 pending 状态的 `answer_json` 为空，不能安全复用该列，因此新增列是 durable 多题累积所需的最小存储改动。
- `test/turn-controller.test.js`、`test/hco-service.test.js`：覆盖真实单题、多题、部分回执、覆盖改答、重启持久化、完整提交与无效 questionId。
- `/codex answer` wire grammar 未修改；多题 questionId 仍由既有 text 参数承载，并由 service 层结合 durable request 解释。

### P2-1：CWD 路径边界

- `plugin/hermes-codex-bridge/plugin.py`：新增 `_cwd_referenced()`，在 CWD 两侧使用路径字符边界检查。
- `/workspace/a` 不再命中 `/workspace/alpha`；`/workspace/beta` 不再命中 `-staging`、`_prod`、`.backup` 等续接路径。
- 独立出现的真实外部路径仍被识别并拒绝。
- `test/hermes_plugin_contract_test.py`：覆盖前缀、三类后缀和真实边界命中。

### P2-2：projectId 介词短语

- `plugin/hermes-codex-bridge/plugin.py`：扩展 `_mentions_project_id()`，覆盖“切换到/在/检查/使用”等中文短语和 `use`、`switch to`、`in`、`check` 等英文短语。
- projectId 本身保持大小写敏感，避免 `ASK` 误命中 `Ask the user` 或普通 `ask`。
- projectId 两侧维持 `[A-Za-z0-9_-]` 边界，避免 `repositoryASK` 等复合词误报。
- `test/hermes_plugin_contract_test.py`：覆盖方案中的五个绕过样例，以及 `repositoryASK`、普通英文 `ask` 的非误报样例。

## App Server Schema 核对

- Codex CLI：`codex-cli 0.142.3`。
- 生成命令：`codex app-server generate-ts --experimental --out /tmp/hco-third-pass-schema-20260720`。
- `v2/CommandExecutionRequestApprovalResponse.ts`：确认为 `{ decision: CommandExecutionApprovalDecision }`。
- `v2/CommandExecutionApprovalDecision.ts`：确认为字符串 decision 或带参数的单键对象；`acceptWithExecpolicyAmendment` 内层字段为 `execpolicy_amendment`。
- `v2/ToolRequestUserInputParams.ts`：确认为 `questions: Array<ToolRequestUserInputQuestion>`。
- `v2/ToolRequestUserInputResponse.ts` 与 `ToolRequestUserInputAnswer.ts`：确认为 `{answers:{[questionId]:{answers:Array<string>}}}`。
- 方案中的类型是相关字段节选；本机 approval params 还包含 `networkApprovalContext`、`commandActions`、`additionalPermissions`、`proposedNetworkPolicyAmendments` 等字段。核心请求/响应形状与方案一致，本轮实现不丢弃 durable request 中这些额外字段。

## 验证结果

按方案顺序执行：

1. `npm run check`：通过，exit code 0。
2. `node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js`：105 passed，0 failed，exit code 0。
3. `/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q`：270 passed，exit code 0。
4. `node --test test/*.test.js`：252 passed，0 failed，exit code 0。

验证过程中第二条命令首次发现 `test/option-c-e2e.test.js` 仍断言旧 `{choice}`；将该直接相关断言修正为真实 `{decision}` 后，定向与全量回归均通过。

## 已知限制

- 未对真实运行中的 App Server 做“逐题部分响应”行为实验。生成 schema 只表明响应是 answers map，未声明 server 接受多次部分响应；因此实现采用保守策略：durable 累积全部问题后一次提交完整 map。
- `isSecret` 当前仅在 renderer 中提示输入敏感；interaction 数据仍按现有持久化机制保存，不提供字段级加密。
- 对没有 `questions[]` 的异常或历史 requestUserInput interaction，仍保留旧 `{text:<answer>}` 回退，以免破坏已有 durable 数据的恢复路径。
- 当前工作区在本轮开始前已有多项未提交改动；本轮未清理、覆盖或提交这些既有改动。

## 提交状态

- 未创建 git commit。
- 未执行 git push。
