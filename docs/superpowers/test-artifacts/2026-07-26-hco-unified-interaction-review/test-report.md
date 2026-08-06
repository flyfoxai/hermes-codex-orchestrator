# HCO 统一交互机制测试报告

日期：2026-07-26

测试对象：当前工作树中的 Hermes Codex Orchestrator

设计基准：`docs/superpowers/specs/2026-07-26-hco-unified-interaction-exchange-design.md`

## 结论

现有 HCO 基线测试通过，但设计中的统一交互机制尚未实现，不能按新方案发布。

- 基线：PASS。JavaScript、Python、installer 和仓库标准 verify 均通过。
- 新功能验收：FAIL。长命令、action 级审批、zform、自然语言批准和 interaction document 仍是旧行为或未实现。

“现有测试全绿”只能证明旧逻辑稳定。现有测试中有三项明确把“隐藏 accept、截断命令”断言为正确行为，因此不能作为新设计的完成证据。

## 基线测试

| 测试 | 结果 | 说明 |
|---|---:|---|
| `npm run check` | PASS | JavaScript 语法和 Python 脚本编译检查通过 |
| `node --test test/*.test.js` | PASS | 304 passed，0 failed |
| Hermes venv `python -m pytest -q test` | PASS | 407 passed，0 failed，21.17s |
| `bash test/install-hermes-codex-bridge.test.sh` | PASS | TAP `1..32`，32 项均为 `ok` |
| `npm run verify` | PASS | check、smoke、contract、dispatch failure/success、hardening 全部通过 |

首次使用系统 Python 3.9 收集 pytest 时缺少 `zulip` 和 `hermes_cli`，收集阶段失败。按照项目真实运行环境改用 `/Users/hula/Projects/hermesAgent/.venv/bin/python` 后，407 项全部通过；因此该首次失败归类为测试解释器错误，不是产品失败。

## 新方案行为测试

### 1. 长命令完整展示：FAIL

执行现有定向测试：

```text
default approval renderer hides accepting choices when the command is truncated
```

测试通过，证明当前 renderer 对 401 字符命令仍执行以下旧行为：

- 只展示前 400 个 JavaScript 字符；
- 输出“命令已截断”；
- 隐藏 `/codex approve <id> accept`。

这与设计要求“长度只决定 inline/chunk/document 传输方式，不决定权限”相反。

### 2. 请求包含扩展权限时保留普通 accept：FAIL

定向测试确认以下旧行为仍生效：

```text
default approval renderer hides accepting choices when networkApprovalContext is present
default approval renderer treats execpolicy amendments and unsafe choice keys as UI-only
```

`hco/service.js` 对带 `networkApprovalContext` 或 `proposedExecpolicyAmendment` 的 request 仍返回 `INTERACTION_APPROVAL_RESTRICTED`。风险判断仍基于 request 顶层，而不是用户实际选择的 action class。

### 3. Zulip zform 和 `/codex interact`：FAIL

运行时探针结果：

```json
{
  "parse_interact": null,
  "zulip_send_signature": "(self, stream_id, topic, content) -> SendResult",
  "validated_claim": ["d-1", "l-1", 42, "Build", "body"]
}
```

含义：

- plugin 不识别 `/codex interact <interactionId> <actionId>`；
- `ZulipSender.send` 没有 `widget_content` 参数；
- sidecar 收到带 `payload.ui` 的 claim 时会忽略 `ui`，只返回正文。

因此当前无法构造或响应审批按钮。

### 4. “同意、可以、OK”自然语言批准：FAIL

运行时探针：

```json
{"parse_ok": null}
```

仓库中也不存在 `NATURAL_INTERACTION_REPLY` 或 `natural_interaction_reply_v1`。精确审批别名仍会落入普通消息路由，不能可靠结算 interaction。

### 5. Opaque action 与双键 settlement：NOT IMPLEMENTED

当前没有 `INTERACT` command、`interaction_actions` 表或 `(interaction_id, action_id)` 查询路径。复杂 decision 仍由 `/codex approve <choice>` key 解析，策略变更选项被整体限制。

### 6. Detail ACK、interaction document 与 action prompt 保序：NOT IMPLEMENTED

当前 artifact manifest 只服务 dispatch 文件契约。尚无：

- `interaction_details`；
- `interaction_delivery_links`；
- detail 最后一片 ACK 后原子创建 action prompt；
- interaction document upload/URI/GC 状态。

### 7. Secret 独立提交路径：NOT IMPLEMENTED

当前 secret question 只会被 Zulip command 拒绝，并要求使用 App Server UI。尚无 `respondSecretInteraction`、无值 attempt/outcome 或 `secret_uncertain` 状态。

### 8. 滚动升级 capability：NOT IMPLEMENTED

代码中不存在 `serverCapabilities`、`interaction_exchange_v2` 或 `zulip_zform_v1`。旧 sidecar 仍对 `compatibility` 对象做精确匹配。

## 验收判定

| 设计验收项 | 当前结果 |
|---|---:|
| 400 字符以上命令不截断 | FAIL |
| 同一 request 中普通 accept 不受 amendment 选项影响 | FAIL |
| Zulip 显示可点击 zform | FAIL |
| `/codex interact` 端到端可用 | FAIL |
| 唯一 pending approval 可回复“同意/OK” | FAIL |
| 多 pending 时不猜测 | NOT IMPLEMENTED |
| policy change 只能显式 action 选择 | NOT IMPLEMENTED |
| 详情完整 ACK 后才出现 action prompt | NOT IMPLEMENTED |
| interaction document 可下载且 hash 一致 | NOT IMPLEMENTED |
| secret 不进入 durable answer JSON | 部分满足：当前直接禁止 Zulip secret；新安全路径未实现 |
| 旧协议滚动升级兼容 | NOT IMPLEMENTED |

## 后续测试门槛

实施前应先把上述 FAIL/NOT IMPLEMENTED 条目写成红色自动化测试，并替换当前三个“隐藏 accepting choices”的旧断言。实现完成后至少需要：

1. JavaScript 与 Python 全量基线继续全绿。
2. 新 interaction v2 单元、并发、重放和失败注入测试通过。
3. installer 在旧 sidecar、新 HCO 组合下通过 compatibility gate。
4. 真实 Zulip Web/Desktop 验证 zform 渲染、点击可见 reply、长命令/文档可读和 `OK` 消歧。
