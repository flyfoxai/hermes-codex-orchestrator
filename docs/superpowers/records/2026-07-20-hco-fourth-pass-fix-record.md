# HCO 四轮修复记录

**日期**: 2026-07-20
**方案**: `docs/superpowers/plans/2026-07-20-hco-fourth-pass-fix-plan.md`
**状态**: 已完成

## 改动

1. 修复 `plugin/hermes-codex-bridge/plugin.py` 的 `_cwd_referenced()`：外部项目 CWD 后跟 `/` 子路径时视为命中，同时保留路径前缀和 `-` 续接边界保护。
2. 修复 `hco/service.js` 的审批决策处理：非空 `availableDecisions` 中不存在的 choice 现在抛出 `INTERACTION_DECISION_INVALID`；空数组或缺失字段继续兼容裸字符串回退。
3. 修复 `hco/service.js` 的交互命令类型校验：`APPROVE` 仅允许审批 interaction，`ANSWER` 仅允许 `item/tool/requestUserInput` interaction；错配在 ACL 校验后拒绝，且不调用回答后端。
4. 修复 `plugin/hermes-codex-bridge/plugin.py` 的 partial 回执渲染：显示项目、交互、缺失 question IDs，以及继续使用 `/codex answer <interactionId> <questionId> <text>` 的指引。
5. 在 `test/hermes_plugin_contract_test.py` 增加外部 CWD 子路径拒绝和 partial 回执端到端回归测试；在 `test/hco-service.test.js` 增加非法 choice 与两种命令错配回归测试。

## 验证

以下命令按方案要求执行，全部通过：

- `npm run check` — 通过。
- `node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js` — 通过。
- `/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q` — 通过。
- `node --test test/*.test.js` — 252 个测试通过，0 个失败。
- `git diff --check -- plugin/hermes-codex-bridge/plugin.py hco/service.js test/hermes_plugin_contract_test.py test/hco-service.test.js` — 通过。

## 未解决问题

未发现本四轮方案范围内的未解决问题。未执行 `git commit` 或 `git push`。
