# HCO 五轮缺陷修复记录

**日期**：2026-07-20
**方案**：`docs/superpowers/plans/2026-07-20-hco-fifth-pass-fix-plan.md`
**状态**：已完成，未执行 `git commit` 或 `git push`

## 修复内容

### P1-a：缺少 availableDecisions 时拒绝非法 choice

- 在 `hco/service.js` 增加已知简单决策集合：`accept`、`acceptForSession`、`decline`、`cancel`。
- 当 `availableDecisions` 缺失、为 `null` 或为空时，仅允许上述决策；非法 choice 抛出 `INTERACTION_DECISION_INVALID`。
- 增加缺失配置下错字拒绝、无 durable backend 调用，以及 `null` 配置下 `decline` 成功的测试。

### P1-b：CWD 规范化

- 在 `plugin/hermes-codex-bridge/plugin.py` 使用 `os.path.normpath()` 规范项目 CWD。
- 过滤根目录 `/`，避免过宽的项目路径匹配。
- 增加尾斜杠路径命中、根目录过滤和子路径冲突测试。
- 符号链接解析未纳入本轮：`normpath()` 不解析符号链接，而 HCO canonical CWD 使用 `realpathSync()`；完全对齐需要文件系统访问，超出本轮方案范围。

### P2：业务校验错误保持用户可见

- `hco/service.js` 仅将三个指定校验错误改为 `stateError()`：
  - `INTERACTION_DECISION_INVALID`
  - `INTERACTION_COMMAND_MISMATCH`
  - `INTERACTION_QUESTION_ID_INVALID`
- `hco/bridge/server.js` 将三个错误码加入 `INPUT_STATE_CODES`，使其通过 HTTP 400 返回。
- `plugin/hermes-codex-bridge/bridge_client.py` 增加 `BridgeUserError`，保留已知用户错误码和消息。
- `plugin/hermes-codex-bridge/plugin.py` 捕获 `BridgeUserError` 并直接返回用户可读消息。
- 测试覆盖 400 响应解析、插件处理器映射，以及真实 Bridge server → BridgeClient → plugin 链路；错误消息包含有效 choices，且不退化为协议错误。

### P3：missingQuestionIds 元素校验

- 仅接受非空字符串、UTF-8 长度不超过 256 bytes 且不含 ASCII 控制字符或 DEL 的 question ID。
- 过滤整数和含换行元素；过滤后无有效元素返回协议错误，避免空列表渲染或通知注入。
- 增加混合元素、控制字符和全无效元素测试。

## 修改文件

本轮仅修改方案列出的必要文件：

- `hco/service.js`
- `hco/bridge/server.js`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `plugin/hermes-codex-bridge/plugin.py`
- `test/hco-service.test.js`
- `test/hermes_plugin_contract_test.py`
- `docs/superpowers/records/2026-07-20-hco-fifth-pass-fix-record.md`

仓库在本轮开始前已存在其他未提交修改；本轮未重置、提交或推送这些修改，也未修改方案范围之外的文件。

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
- 插件契约测试：`278 passed`。
- 全量 Node 测试：`252 passed, 0 failed`。

## 未解决问题

- 仅保留方案已明确的符号链接 CWD 限制；本轮未解析符号链接。
- 除上述限制外，本轮方案列出的验收项均有对应实现和测试覆盖。
