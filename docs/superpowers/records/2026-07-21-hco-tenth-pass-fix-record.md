# HCO 十轮缺陷修复记录

**日期**: 2026-07-21  
**状态**: 已完成  
**执行方案**: `docs/superpowers/plans/2026-07-21-hco-tenth-pass-fix-plan-v3.md`

## 执行顺序

严格按方案指定顺序实施并在每项完成后运行对应测试：

1. P2-2
2. P3-1
3. P3-2
4. P2-1
5. P1-1
6. P1-2
7. P1-3
8. P1-4

未执行 `git commit` 或 `git push`。

## 修复详情

### P2-2：`commandActions` 不再误判为扩展权限

**修改文件**:

- `hco/turn-controller.js`
- `test/turn-controller.test.js`

**改动**:

- 从 `EXTENDED_PERMISSION_FIELDS` 移除仅用于展示的 `commandActions`。
- 同时移除不属于方案高风险字段集合的 `proposedExecpolicyAmendment`。
- 扩展权限字段统一为 `networkApprovalContext`、`additionalPermissions`、`proposedNetworkPolicyAmendments`、`grantRoot`。
- 新增回归测试，确认只有 `commandActions` 时仍保留 accept 命令。

**对应测试**:

```bash
node --test test/turn-controller.test.js
```

结果：通过。

### P3-1：ACL 错误只信任 `stateError`

**修改文件**:

- `hco/bridge/server.js`
- `hco/acl.js`
- `test/bridge-server.test.js`

**改动**:

- Bridge 错误归一化不再仅凭普通 Error 的 `code === "ACL_FORBIDDEN"` 公开错误。
- ACL 的配置错误、请求错误和权限错误统一使用 `stateError`，避免可信错误类型与普通 Error 混用。
- 补齐改造过程中残留的四处 `aclError` 调用，避免已删除辅助函数导致潜在 `ReferenceError`。
- 新增回归测试：伪造 `ACL_FORBIDDEN` 的普通 Error 返回 HTTP 500，且不泄露原始消息。
- Bridge 测试夹具支持透传 `eventHandler`，保持测试构造与真实入口一致。

**对应测试**:

```bash
node --test test/bridge-server.test.js test/hco-service.test.js
```

结果：59 passed，0 failed。

### P3-2：Python 与 ECMAScript Unicode 空白判断对齐

**修改文件**:

- `plugin/hermes-codex-bridge/plugin.py`
- `test/hermes_plugin_contract_test.py`

**改动**:

- 新增 `_ECMASCRIPT_EXTRA_WHITESPACE` 集合。
- `_is_safe_question_id` 使用 Python `str.isspace()` 与 ECMAScript `\s` 额外字符的并集判断。
- 新增 U+FEFF 测试，确认 Python 侧拒绝 ECMAScript 识别的 BOM/ZWNBSP 空白。
- 新增 U+0085 测试，确认 Python `isspace()` 覆盖的 NEL 字符也被拒绝。

**对应测试**:

```bash
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
```

结果：293 passed，0 failed（该步骤完成时）。

### P2-1：交互回答失败统一为用户可见状态错误

**修改文件**:

- `hco/turn-controller.js`
- `hco/bridge/server.js`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `test/turn-controller.test.js`

**改动**:

- `answerInteraction` 的 not found、orphaned、expired、unauthorized、target mismatch、answer conflict 和兜底 invalid 分支统一抛出 `stateError`。
- Bridge `INPUT_STATE_CODES` 与 Python `USER_FACING_ERROR_CODES` 同步交互错误码。
- 过期交互回归测试明确断言错误为可信 `stateError`。

**对应测试**:

```bash
node --test test/turn-controller.test.js test/hco-service.test.js
```

结果：106 passed，0 failed（该步骤完成时）。

### P1-1：Service 层强制限制扩展权限审批

**修改文件**:

- `hco/service.js`
- `hco/turn-controller.js`
- `hco/bridge/server.js`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `test/hco-service.test.js`

**改动**:

- `interactionCommand` 在 ACL 检查后、提交回答前检查审批请求是否包含高风险字段。
- 高风险审批通过命令接口只允许 `decline` 或 `cancel`；其他决策抛出 `INTERACTION_APPROVAL_RESTRICTED`。
- Renderer 对高风险审批采用 decline/cancel 白名单，不再依赖仅过滤已知 accept 名称的黑名单。
- Bridge 与 Python 客户端同步新增用户可见错误码 `INTERACTION_APPROVAL_RESTRICTED`。
- 新增高风险 accept 被拒绝以及 decline 仍可正常执行的测试。

**对应测试**:

```bash
node --test test/turn-controller.test.js test/hco-service.test.js
```

结果：106 passed，0 failed（该步骤完成时）。

### P1-2：超长通知使用真实请求 schema

**修改文件**:

- `hco/turn-controller.js`
- `test/turn-controller.test.js`

**改动**:

- `toCompactContent` 接收 `requestObject`、`questions` 和 `allAddressable` 上下文。
- 审批精简版从真实 `availableDecisions` 生成命令，并继续应用高风险审批限制。
- 用户输入精简版根据真实问题数量和 question ID 可寻址性生成回答命令或 UI 提示。
- 修正 `requestObject`、`questions`、`allAddressable` 的作用域，使正常版和精简版共享同一份已解析 schema。
- 新增仅提供 decline 决策的超大审批测试，确认精简版不会凭空显示 accept。

**对应测试**:

```bash
node --test test/turn-controller.test.js
```

结果：63 passed，0 failed（该步骤完成时）。

### P1-3：Markdown 三反引号转义并隐藏截断命令的批准选项

**修改文件**:

- `hco/turn-controller.js`
- `test/turn-controller.test.js`

**改动**:

- 审批原因和命令中的三反引号在渲染前转义，避免破坏 Markdown 代码块结构。
- 命令超过 400 字符时标记为截断并提示通过 App Server UI 查看完整内容。
- 命令被截断时，命令行只显示 decline/cancel，不显示任何批准型决策。
- 新增 reason、command 含三反引号以及 401 字符命令的回归测试。

**对应测试**:

```bash
node --test test/turn-controller.test.js
```

结果：65 passed，0 failed（该步骤完成时）。

### P1-4：项目引用边界与动词检测修正

**修改文件**:

- `plugin/hermes-codex-bridge/plugin.py`
- `test/hermes_plugin_contract_test.py`

**改动**:

- 项目 ID 前后边界加入 `.`，避免当前项目 `foo.bar` 被误识别为外部项目 `foo`。
- 英文 verb-object 模式新增 `handle` 和 `investigate`。
- 新增中文 `修复`、`修改`、`更新`、`检查`、`处理`、`调查` 动词上下文。
- 对容易成为命令参数的项目 ID `test` 禁用 verb-object 匹配，避免 `run test` 误报。
- 新增 `handle beta`、`investigate beta`、中文处理、`run test` 和 `foo.bar` 边界测试。

**方案歧义处理**:

方案示例写的是仅对长度 `> 3` 的项目 ID 启用 verb-object，但验收同时要求四字符项目 ID `test` 在 `run test` 中不误报。仅使用长度条件无法同时满足这两个要求，因此最终采用：

```python
len(project_id) > 3 and project_id.casefold() not in {"test"}
```

该处理保留四字符真实项目 `beta` 的动词检测，同时满足 `run test` 不误报的验收要求。

**对应测试**:

```bash
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
```

结果：294 passed，0 failed。

## 最终验证

在所有代码和测试修改完成后，重新执行方案列出的全部验证命令：

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js
```

结果：

- `npm run check`：通过。
- 核心 Node 测试：116 passed，0 failed。
- Python 合约测试：294 passed，0 failed。
- 全部 Node 测试：264 passed，0 failed。

## 修改文件

实现文件：

- `hco/acl.js`
- `hco/bridge/server.js`
- `hco/service.js`
- `hco/turn-controller.js`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `plugin/hermes-codex-bridge/plugin.py`

测试文件：

- `test/bridge-server.test.js`
- `test/hco-service.test.js`
- `test/hermes_plugin_contract_test.py`
- `test/turn-controller.test.js`

记录文件：

- `docs/superpowers/records/2026-07-21-hco-tenth-pass-fix-record.md`

## 未解决问题

无。本轮方案列出的 8 项问题均已修复，对应定向测试和全部最终验证均通过。

工作树中存在本轮开始前已有的其他修改和未跟踪文件；本轮未清理、回退或提交这些内容。
