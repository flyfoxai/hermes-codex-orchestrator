# HCO 二轮缺陷修复记录

**日期**: 2026-07-20  
**关联方案**: [2026-07-20-hco-second-pass-fix-plan.md](../plans/2026-07-20-hco-second-pass-fix-plan.md)

---

## 复审结论

Codex 复审提出的四个问题经本轮复核均成立，并已按方案修复。

| ID | 结论 | 修复结果 |
|---|---|---|
| P1-1 | 成立 | 跨项目检测覆盖全部 DISPATCH 文本字段 |
| P1-2 | 成立 | projectId 改为大小写敏感的显式上下文匹配 |
| P1-3 | 成立 | 默认 interaction 通知可直接审批或回答 |
| P2-1 | 成立 | CONTINUE objectiveId 提示分支改为检查 `objective.mode` |

## 修复详情

### P1-1：跨项目检测覆盖不完整

- **文件**: `plugin/hermes-codex-bridge/plugin.py`
- **函数**: `_semantic_references_foreign_project()`、`hco_dispatch_handler()`
- **改动**: 扫描 `instruction`、`constraints`、`acceptanceCriteria`、`reminders`；任一字段命中外部项目 cwd 或显式项目引用即拒绝提交，并在提示中标出字段名。
- **测试**: `test_dispatch_foreign_project_reference_in_any_text_field_is_rejected` 参数化覆盖四个字段的 projectId 引用和 cwd 引用，验证 `BridgeClient.submit` 不被调用。

### P1-2：项目名误伤普通英文

- **文件**: `plugin/hermes-codex-bridge/plugin.py`
- **函数**: `_mentions_project_id()`、`_semantic_references_foreign_project()`
- **改动**: 移除 `re.IGNORECASE` 普通单词匹配；projectId 仅在带 `project`、`repo`、`repository`、`cwd`、`working directory`、`项目`、`仓库`、`工作目录` 等上下文词时匹配，cwd 继续使用精确子串强匹配。
- **测试**: `test_dispatch_ask_common_english_does_not_false_positive` 验证 `Ask the user before changing the API.` 正常提交；`test_dispatch_explicit_ask_project_reference_is_rejected` 验证 `请在 ASK 仓库中执行` 被拒绝。

### P1-3：默认 interaction 通知不可操作

- **文件**: `hco/turn-controller.js`
- **函数**: `defaultInteractionRenderer()`
- **改动**: 按 approval、user input 和异常 method 分支渲染；approval 缺失 `availableDecisions` 时默认生成 `accept`、`cancel` 命令；对象 decision 使用首个 key；user input 生成 `/codex answer` 命令且不显示 approve 命令；通知展示 numeric `allowedResponderIds`。
- **测试**: `default approval renderer provides fallback accept and cancel commands`、`default user input renderer provides answer command without approval commands`；`test/option-c-e2e.test.js` 的 pending approval 场景直接验证 outbox 正文包含 interactionId、两条默认审批命令和 `npm test`。

### P2-1：CONTINUE objectiveId 分支不可达

- **文件**: `plugin/hermes-codex-bridge/plugin.py`
- **函数**: `hco_dispatch_handler()` 的 `BridgeUnavailableError` 分支
- **改动**: 从错误的顶层 `type == "CONTINUE"` 改为检查 `objective.mode == "CONTINUE"`，并在 `objectiveId` 为字符串时加入异常提示。
- **测试**: `test_dispatch_continue_bridge_unavailable_includes_objective_id` 验证 DISPATCH + CONTINUE objective 在 bridge 响应异常时同时包含“任务可能已提交但响应丢失”和 `objective-123`。

## 修改文件

- `plugin/hermes-codex-bridge/plugin.py`
- `hco/turn-controller.js`
- `test/hermes_plugin_contract_test.py`
- `test/turn-controller.test.js`
- `test/option-c-e2e.test.js`
- `docs/superpowers/records/2026-07-20-hco-second-pass-fix-record.md`

未修改 HCO 路由、数据库 schema 或 `delivery_sidecar.py`，未创建 git commit 或 push。

## 验证结果

### 方案规定命令

```bash
npm run check
```

- 结果：通过，所有列出的 JavaScript 文件语法检查成功。

```bash
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
```

- 结果：`104 passed, 0 failed`。

```bash
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
```

- 结果：`258 passed in 19.89s`。

### 追加完整验证

```bash
node --test test/*.test.js
```

- 结果：`251 passed, 0 failed`。

## 验收对照

- [x] 四个 DISPATCH 文本字段中的 foreign cwd 均被拒绝。
- [x] 四个 DISPATCH 文本字段中的显式 foreign projectId 引用均被拒绝。
- [x] 普通英文 `Ask the user before changing the API.` 不再误命中项目 `ASK`。
- [x] 显式 `ASK 仓库` 引用仍被拒绝。
- [x] approval 缺少 decisions 时生成 `accept` 与 `cancel`。
- [x] approval 存在 decisions 时按实际 choice 生成命令。
- [x] user input 生成 answer 命令且不生成 approve 命令。
- [x] E2E 覆盖默认通知正文。
- [x] CONTINUE bridge 异常提示包含 objectiveId。
- [x] 非 CONTINUE 继续保留通用异常提示。

## 已知限制

1. `defaultInteractionRenderer()` 只有 numeric userId，无法把 `allowedResponderIds` 转换成 Zulip `@用户名`，因此当前仅显示“允许响应者 ID”。
2. projectId 匹配有意保持大小写敏感；例如错误大小写的显式项目名不会命中。这是本轮为避免 `ASK`/`Ask` 误杀而采取的保守策略，后续如需增强应使用白名单式规则而非恢复全局 case-insensitive 匹配。
3. `project_cwd_map` 仍是 best-effort 配置读取；配置不可读时无法执行 cwd/projectId 跨项目检测，但现有 bridge 配置与其他 fail-closed 边界未在本轮扩展。
