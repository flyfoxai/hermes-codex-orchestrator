# HCO 十一轮修复记录：审批安全与精简通知闭环

## 日期

2026-07-21

## 审核状态

- Codex CLI 只读计划审核 v1：FAIL。
- 主要 blocker：renderer fallback 不安全、decision/question CLI token 校验不足、Markdown 覆盖不足、hard compact fallback 语义不足、旧测试契约冲突。
- 计划 v2：已补齐上述 blocker。
- Codex CLI 只读计划审核 v2：PASS。

## 修复范围

### `hco/turn-controller.js`

- 将 `proposedExecpolicyAmendment` 纳入扩展权限字段。
- 增加统一 approval decision 解析，畸形 decision 不再触发裸 `Object.keys(null)`。
- 增加 CLI token 安全校验；decision key 和 question id 只有通过安全 token 校验才会进入 `/codex approve` / `/codex answer` 命令。
- 对对象型 approval decision 视作命令行高风险；Zulip 命令只渲染 `decline` / `cancel` 等安全拒绝路径。
- 将命令截断状态传入 compact 渲染；超长命令触发 compact 后不再重新放出 `accept`。
- 用 inline/code-block 两类 Markdown 转义覆盖 reason、cwd、command、approvalId、itemId、allowedResponderIds、question header/body/id、option label/description、no-question fallback 字段、toolName。
- 改为 method-aware fallback；未知/异常渲染不再无条件显示 `accept` 或通用 answer 命令。
- compact 输出保留 secret 警告、截断 question label，并做最终字节上限检查；超限降级到有界 hard fallback。

### `hco/service.js`

- 将 `proposedExecpolicyAmendment` 纳入 service 高风险审批字段。
- `resolveApprovalDecision()` 改为返回 `{ key, decision, objectDecision }`，避免畸形 decision 进入裸对象 key 路径。
- `/codex approve` 只解析一次 decision；扩展权限或对象型 decision 只能命令行 `decline` / `cancel`，其他批准抛 `INTERACTION_APPROVAL_RESTRICTED`。
- `requireObjectiveProject()` 和 `statusCommand()` 的 objective 缺失/跨项目错误改用 trusted `stateError`。
- question ID 校验与 renderer CLI token 规则收敛，禁止 Markdown/命令分隔符进入命令寻址。

### `hco/bridge/server.js`

- `OBJECTIVE_PROJECT_MISMATCH` 加入 trusted conflict state code，映射为用户可见 409。
- 保留普通 `Error` 冒充同名 code 时返回 `BRIDGE_INTERNAL` 的边界。

### `plugin/hermes-codex-bridge/bridge_client.py`

- `OBJECTIVE_PROJECT_MISMATCH` 加入 user-facing error 白名单，Python bridge client 将其抛为 `BridgeUserError`。

### `plugin/hermes-codex-bridge/plugin.py`

- 去掉短 projectId 和 `test` 特判；所有合法 projectId 都进入 verb-object 检测。
- 保留 token 边界，避免 `foo.bar` vs `foo`、`repositoryASK` 等边界误判。

## 测试更新

- 替换旧契约断言：对象型 approval decision 不再可通过 Zulip 命令渲染或提交。
- 替换旧短 ID 断言：`run test` / `fix api` 等短 projectId verb-object 引用现在命中项目引用检测。
- 新增或更新覆盖：
  - command 截断 + compact 后不显示 `accept`。
  - `availableDecisions: [null, ...]` 不抛裸异常。
  - `proposedExecpolicyAmendment` 禁止命令行批准。
  - 对象型 `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` 禁止命令行批准。
  - unsafe decision key / question id 不渲染 slash-command。
  - Markdown 注入字段不能生成伪命令行。
  - `OBJECTIVE_PROJECT_MISMATCH` 在 bridge server/client 为用户可见错误。

## 验证结果

- `node --check hco/turn-controller.js && node --check hco/service.js && node --check hco/bridge/server.js`：通过。
- `python3 -m py_compile plugin/hermes-codex-bridge/bridge_client.py plugin/hermes-codex-bridge/plugin.py`：通过。
- `node --test test/turn-controller.test.js test/hco-service.test.js test/bridge-server.test.js`：128/128 通过。
- `/Users/hula/Projects/hermesAgent/.venv/bin/python3 -m pytest test/hermes_plugin_contract_test.py -q -k 'project_reference_detection_handles_boundaries_verbs_and_short_names or safe_question_id'`：2/2 通过。
- `npm run check`：通过。
- `/Users/hula/Projects/hermesAgent/.venv/bin/python3 -m pytest test/hermes_plugin_contract_test.py -q`：294/294 通过。
- `node --test test/*.test.js`：268/268 通过。
- `git diff --check`：通过。

## 未执行项

- 未运行 delivery sidecar 或 installer contract suite；本轮未修改 delivery sidecar 或 installer contract。
- 未提交、未 push；用户未要求提交。
