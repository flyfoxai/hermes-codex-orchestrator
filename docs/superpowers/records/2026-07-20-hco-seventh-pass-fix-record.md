# HCO 七轮缺陷修复记录

**日期**：2026-07-20
**方案**：`docs/superpowers/plans/2026-07-20-hco-seventh-pass-fix-plan.md`
**状态**：已完成，未执行 `git commit` 或 `git push`

## 修复内容

### P1-a：Renderer 按完整问题集合抑制不可执行命令

- 在 `hco/turn-controller.js` 的 `item/tool/requestUserInput` 渲染分支中增加完整 questions 集合的 `allAddressable` 判断。
- question ID 必须为非空字符串且不含空白字符；任一问题不满足条件时，整条通知不再输出任何 `/codex answer` 命令。
- 整体不可寻址时输出 App Server UI 提示；不可寻址的问题同时标注 ID 无法通过命令回答。
- 全部单 token ID 的单问题继续输出通用回答命令，多问题继续输出 per-question 命令和自动提交说明。
- 在 `test/turn-controller.test.js` 增加单问题空白 ID 和混合 ID 的回归测试，既有合法单/多问题测试继续覆盖正常命令渲染。

### P1-b：ANSWER 对完整原始 questions 列表统一验证

- 在 `hco/service.js` 增加 `validateQuestions()`，在任何答案处理或 durable partial 写入前验证原始完整 questions 列表。
- question ID 必须为非空字符串、不含空白字符，并且在当前交互中唯一。
- 任一验证失败均抛出 `INTERACTION_QUESTION_ID_INVALID`，不调用 backend，也不写入 durable partial answers。
- 删除 ANSWER 分支中先过滤空 ID、再比较列表长度的旧逻辑；验证通过后仍使用 `userInputQuestions()` 进入既有单问题、多问题 partial/完成或 legacy 路径。
- 在 `test/hco-service.test.js` 增加全空 ID、混合空 ID、重复 ID 的拒绝覆盖，并保留合法单 token 单/多问题回归路径。

### 文档偏差修正

- 修正 `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md` 对 `os.path.realpath()` 的描述。
- 明确默认 `strict=False` 时不存在路径不会抛异常，`try/except` 仅用于权限等实际 I/O 异常。

## TDD 记录

先增加测试并运行最小相关集合，确认修复前出现预期失败：

- turn-controller 测试：`55 passed, 2 failed`；单问题空白 ID 仍输出通用命令，混合 ID 仍为合法问题输出局部命令。
- HCO service focused 测试：`1 failed`；空 ID 请求未按预期抛出 `INTERACTION_QUESTION_ID_INVALID`。

完成最小生产修改后重跑：

- turn-controller 测试：`57 passed, 0 failed`。
- HCO service focused 测试：`1 passed, 0 failed`。

## 修改文件

本轮仅修改方案列出的必要文件：

- `hco/turn-controller.js`
- `hco/service.js`
- `test/turn-controller.test.js`
- `test/hco-service.test.js`
- `docs/superpowers/records/2026-07-20-hco-sixth-pass-fix-record.md`
- `docs/superpowers/records/2026-07-20-hco-seventh-pass-fix-record.md`

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
- 定向 Node 测试：`107 passed, 0 failed`。
- 插件契约测试：`281 passed`。
- 全量 Node 测试：`254 passed, 0 failed`。

## 已知限制与未解决问题

- 本轮方案列出的验收项均已实现，未发现新增未解决问题。
