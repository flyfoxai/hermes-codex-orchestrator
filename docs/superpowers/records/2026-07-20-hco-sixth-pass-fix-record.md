# HCO 六轮缺陷修复记录

**日期**：2026-07-20
**方案**：`docs/superpowers/plans/2026-07-20-hco-sixth-pass-fix-plan.md`
**状态**：已完成，未执行 `git commit` 或 `git push`

## 修复内容

### P1-a：question ID 限定为单 token

- 在 `hco/service.js` 的 `userInputQuestions()` 中排除包含空白字符的 question ID。
- ANSWER 路径同时检查原始有效字符串 ID 集合；只要部分或全部 ID 含空白，就抛出 `INTERACTION_QUESTION_ID_INVALID`，不调用 backend，也不持久化 partial answers。
- 保留全部单 token ID 的多问题 partial 和完成流程。
- 在 `hco/turn-controller.js` 中仅为可寻址的单 token ID 渲染 `/codex answer` 命令；含空白 ID 改为提示使用 App Server UI。
- 在 `test/hco-service.test.js` 增加全部 ID 含空白、部分 ID 含空白的拒绝测试，并验证 backend 调用数和 durable partial answers 均未变化；现有单 token partial/完成测试继续作为回归覆盖。

### P1-b：项目 CWD 使用 realpath 解析符号链接

- 在 `plugin/hermes-codex-bridge/plugin.py` 的 `_load_project_cwd_map()` 中先调用 `os.path.realpath()`，异常时回退 `os.path.normpath()`，最终统一执行 `normpath` 并继续排除根目录。
- 增加真实临时符号链接测试：配置指向 symlink 的 beta CWD，指令引用 canonical beta 路径时触发跨项目拒绝。
- 既有尾斜杠规范化和根目录过滤测试继续通过。

### P2：missingQuestionIds 全元素 fail-closed

- partial answer 渲染前比较合法元素数量与原始列表长度；只要包含换行字符串、整数等任一非法元素，立即返回 `Codex bridge protocol error.`。
- 全合法的 `q2`、`q3` 列表仍正常渲染 partial 提示。
- 更新参数化测试，覆盖 `['q2', 'bad\nvalue']`、`['q2', 7]`、全非法元素和全合法回归路径。

### P3：BridgeUserError 仅用于 HTTP 4xx

- 在 `plugin/hermes-codex-bridge/bridge_client.py` 中增加 `400 <= status < 500` 条件。
- HTTP 400 携带白名单错误码继续抛出 `BridgeUserError`。
- HTTP 500 即使携带同一白名单错误码，也改为抛出 `BridgeProtocolError("bridge rejected request")`，不向用户暴露服务端错误消息。

## TDD 记录

先添加测试并运行最小相关集合，确认修复前出现预期失败：

- `test/hco-service.test.js`：1 个失败，空白 question ID 未被拒绝。
- `test/hermes_plugin_contract_test.py`：4 个失败，分别对应 HTTP 500 错误分类、symlink CWD、混合换行 ID、混合整数 ID。

完成最小生产修改后重跑：

- HCO service 测试：`43 passed, 0 failed`。
- turn-controller 测试：`55 passed, 0 failed`。
- 相关 Python 契约测试：`9 passed`。

## 修改文件

本轮仅修改方案列出的必要文件：

- `hco/service.js`
- `hco/turn-controller.js`
- `plugin/hermes-codex-bridge/plugin.py`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `test/hco-service.test.js`
- `test/hermes_plugin_contract_test.py`
- `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md`

仓库在本轮开始前已存在前序轮次和其他工作的未提交修改；本轮未重置、提交或推送这些修改，也未有意修改方案范围之外的文件。

## 验证结果

按方案原样执行以下命令，全部退出码为 `0`：

```text
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js
```

结果摘要：

- 语法检查：通过。
- 定向 Node 测试：`105 passed, 0 failed`。
- 插件契约测试：`281 passed`。
- 全量 Node 测试：`252 passed, 0 failed`。

## 已知限制与未解决问题

- `os.path.realpath()` 默认 `strict=False`，不存在的路径**不会**抛异常，而是尽量解析已存在的前缀后返回路径。`try/except` 仅捕获权限等实际 I/O 异常。功能行为正确，此处修正文字表述。
- 除上述已知限制外，本轮方案列出的验收项均已实现，未发现新增未解决问题。
