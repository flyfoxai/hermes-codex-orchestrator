# HCO 九轮缺陷修复记录

**日期**：2026-07-20
**方案**：`docs/superpowers/plans/2026-07-20-hco-ninth-pass-fix-plan.md`
**状态**：已完成，未执行 `git commit` 或 `git push`

## 修复内容

### P1-1：扩展外部项目自然语言引用检测

- 在 `plugin/hermes-codex-bridge/plugin.py` 的 `_mentions_project_id()` 增加英文所有格、英文动词直接宾语和中文“的”所有格规则。
- 现在会拒绝 `Fix beta's failing tests.`、`Work on beta and update its CI.`、`修复 beta 的测试。` 和 `debug beta` 等外部项目引用。
- 保留项目 ID 边界和可信项目跳过逻辑，`Fix alpha's tests.` 不产生当前项目误报。

### P1-2：超长交互通知生成安全精简版

- 在 `hco/turn-controller.js` 增加 60,000 UTF-8 字节上限和精简通知 renderer。
- 超限通知不再进入 sidecar 的 64 KiB 永久拒绝路径，而是保留 reply token、回答或审批操作命令，并引导用户到 App Server UI 查看完整内容。
- 对含扩展权限的超长审批同样保持 fail-closed：精简版不显示接受命令，仅保留取消和 UI 引导。

### P1-3：扩展权限审批隐藏命令行接受入口

- 检测 `commandActions`、`networkApprovalContext`、`additionalPermissions`、`proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments` 和 `grantRoot`。
- 任一扩展权限字段非空时，过滤 `accept` 与 `acceptForSession`，并显示“扩展权限”及 App Server UI 警告。
- 无扩展权限的普通审批继续显示原有接受命令。

### P2-1：可纠正业务错误对用户可见

- 在 `hco/service.js` 将 `INTERACTION_NOT_FOUND`、`INTERACTION_TARGET_MISMATCH`、交互路径的 `OBJECTIVE_NOT_FOUND` 和命令路径的 `OBJECTIVE_REQUIRED` 改为 `stateError()`。
- 在 `hco/bridge/server.js` 将 interaction/input 错误映射为 HTTP 400，将 `OBJECTIVE_NOT_FOUND` 与 `ACL_FORBIDDEN` 映射为 HTTP 409。
- `ACL_FORBIDDEN` 仍由 `hco/acl.js` 的普通 Error 产生；由于本轮允许修改文件不包含该文件，bridge 仅对精确白名单码 `ACL_FORBIDDEN` 放宽 state-error 标记要求，未扩大其他普通 Error 的用户可见范围。
- 在 `plugin/hermes-codex-bridge/bridge_client.py` 扩充用户可读错误码，使插件显示服务端可纠正消息，而不是统一显示 protocol error。

### P2-2：CWD 映射同时保留 alias、canonical 和根项目身份

- `_load_project_cwd_map()` 的值改为 `(config_cwd, canonical_cwd)` 元组。
- 配置路径与 `realpath` 结果不同时同时保留两者，因此 alias 子路径和 canonical 子路径都会触发外部项目冲突。
- `cwd: /` 项目保留为 `(None, None)`，跳过宽泛路径匹配，但仍参与 projectId 自然语言检测。
- 同步更新语义冲突检测、当前项目 prompt CWD 提示及测试中的 closure map 注入结构。

### P3-1：Python question ID 拒绝所有空白字符

- `_is_safe_question_id()` 先拒绝空字符串或纯空白字符串，再用 `str.isspace()` 拒绝普通空格、NBSP 和其他 Unicode 空白。
- 保留 256 UTF-8 字节限制及控制字符检查，与 Node 侧规则对齐。

## TDD 记录

先增加测试并运行定向集合，确认修复前出现预期失败：

- `test/turn-controller.test.js`：`3 failed`，分别覆盖两类扩展权限审批和超长通知。
- `test/hco-service.test.js`：`1 failed`，缺失 interaction 仍不是 `stateError`。
- Python 定向集合：`30 failed`，包括新自然语言规则、元组 CWD 结构、alias/root 行为和空白 question ID；多数既有外部项目测试因旧实现无法处理元组而按预期失败。

完成最小生产修改后重跑同一批定向测试：

- `test/turn-controller.test.js`：`62 passed, 0 failed`。
- `test/hco-service.test.js`：`44 passed, 0 failed`。
- Python 定向集合：`30 passed, 0 failed`。

## 修改文件

本轮仅修改方案列出的必要文件：

- `plugin/hermes-codex-bridge/plugin.py`
- `hco/turn-controller.js`
- `hco/service.js`
- `hco/bridge/server.js`
- `plugin/hermes-codex-bridge/bridge_client.py`
- `test/hermes_plugin_contract_test.py`
- `test/turn-controller.test.js`
- `test/hco-service.test.js`
- `docs/superpowers/records/2026-07-20-hco-ninth-pass-fix-record.md`

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
- 定向 Node 测试：`113 passed, 0 failed`。
- 插件契约测试：`290 passed`。
- 全量 Node 测试：`260 passed, 0 failed`。
- `git diff --check`：通过。

## 验收结果

- P1-1：英文所有格、动词宾语和中文所有格外部项目引用均被拒绝；当前项目引用不误报。
- P1-2：超大 questions/options 通知小于 60,000 字节，并保留 reply token 与可安全执行的操作命令；正常通知保持原行为。
- P1-3：扩展权限审批不显示 `accept`/`acceptForSession`，普通审批仍显示接受命令。
- P2-1：不存在 interaction 的 APPROVE 返回可读 `does not exist` 状态错误；目标不匹配、缺少 objective 和 ACL 错误进入用户可读 4xx 映射。
- P2-2：alias 与 canonical 子路径均可检测；根目录项目仍按 ID 检测且不会匹配任意绝对路径。
- P3-1：普通空格、NBSP 和纯空白 question ID 均被拒绝，`q1` 保持合法。

## 已知限制与未解决问题

- 本轮方案列出的验收项均已实现，未发现新增未解决问题。
- 工作区仍包含本轮开始前已有的未提交修改和未跟踪文件；按要求未清理、提交或推送。
