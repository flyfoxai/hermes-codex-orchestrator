# HCO 八轮缺陷修复记录

**日期**：2026-07-20
**方案**：`docs/superpowers/plans/2026-07-20-hco-eighth-pass-fix-plan.md`
**状态**：已完成，未执行 `git commit` 或 `git push`

## 修复内容

### P1-a：重复 question ID 不再生成不可执行命令

- 在 `hco/turn-controller.js` 的 `allAddressable` 计算中使用 `Set` 检查 question ID 唯一性。
- 任一重复 ID 会使完整 questions 集合不可寻址，通知不输出任何 `/codex answer` 命令，并提示使用 App Server UI。
- 在 `test/turn-controller.test.js` 增加重复 `q1` 的渲染回归测试。

### P1-b：空 questions 保留 legacy 通用回答命令

- 仅在 questions 非空且不可寻址时输出 App Server UI 警告。
- `questions: []` 重新落入兼容分支，输出 `/codex answer <interactionId> <你的回答>` 通用命令。
- 在 `test/turn-controller.test.js` 增加空 questions 回归测试，并验证不显示 App Server UI 警告。

### P2-a：Node 与 Python 统一安全 question ID 定义

- 在 `hco/service.js` 增加 `isSafeQuestionId()`，要求 ID 为非空字符串、不含空白或 `\x00-\x1F`/`\x7F` 控制字符，且 UTF-8 长度不超过 256 字节。
- `validateQuestions()` 统一使用该 helper，非法 ID 在 backend 调用和 durable partial 写入前抛出 `INTERACTION_QUESTION_ID_INVALID`。
- `hco/turn-controller.js` 的 `allAddressable` 同步使用相同字符和 UTF-8 字节限制，并按方案对 `Buffer.byteLength()` 做防御性 `try/catch`。
- 在 `test/hco-service.test.js` 增加 `\x01q` 和 300 字节 ID 的拒绝测试；既有 `q1` 正常回答路径继续作为合法回归覆盖。

### P2-b：非对象 question 改为 fail-closed

- `validateQuestions()` 不再静默跳过 `null`、数字等非 plain object question，而是返回 malformed questions 错误。
- 增加 `[null]`、`[null, {id: "q1"}]`、`[42]` 三种拒绝测试。
- 测试同时确认 backend 调用数不变，相关交互的 durable `partialAnswers` 保持 `null`。

## TDD 记录

先增加测试并运行定向集合，确认修复前出现预期失败：

- `node --test test/turn-controller.test.js test/hco-service.test.js`：`99 passed, 3 failed`。
- 重复 ID 测试显示两条重复 `/codex answer` 命令仍被渲染。
- 空 questions 测试显示仅有 App Server UI 警告，没有通用回答命令。
- service 聚合测试在新非法 ID 场景出现 `Missing expected rejection`，证明现有验证仍 fail-open。

完成最小生产修改后重跑同一命令：

- `102 passed, 0 failed`。

## 修改文件

本轮仅修改方案列出的必要文件：

- `hco/turn-controller.js`
- `hco/service.js`
- `test/turn-controller.test.js`
- `test/hco-service.test.js`
- `docs/superpowers/records/2026-07-20-hco-eighth-pass-fix-record.md`

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
- 定向 Node 测试：`109 passed, 0 failed`。
- 插件契约测试：`281 passed`。
- 全量 Node 测试：`256 passed, 0 failed`。

## 验收结果

- P1-a：重复 ID 使通知无 `/codex answer` 命令，并显示 App Server UI 提示。
- P1-b：空 questions 通知包含通用回答命令，不显示 App Server UI 警告。
- P2-a：控制字符和超过 256 UTF-8 字节的 ID 均被拒绝；renderer 与 service 使用相同安全规则。
- P2-b：非对象 question 均返回 `INTERACTION_QUESTION_ID_INVALID`，backend 未调用且未写 durable partial answers。

## 已知限制与未解决问题

- 本轮方案列出的验收项均已实现，未发现新增未解决问题。
