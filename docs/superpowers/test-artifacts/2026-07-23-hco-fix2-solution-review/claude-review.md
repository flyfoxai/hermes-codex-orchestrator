基于对`plugin.py`、`bridge_client.py`、`hco/service.js`、`hco-fix2-api-acceptance.py` 及合同测试的直接阅读，以下是独立审核结论。

---

## 结论

方案总体方向正确，G-01 拆分和可观测性补强都有必要。但有三处实质性缺陷必须在合并前解决：**一个安全边界漏洞**（route=None 时 ROUTE 管理命令未被拦截）、**一个虚假测试**（G-06 marker 无法真正验证转义）、**一个实现空白**（G-01B 没有对应的代码改动，只有fixture 计划）。其余问题是可接受的，但部分需要修订后才能视为"足够好"。

---

## 必须修改

### M-1：安全漏洞 — `route is None` 时 ROUTE 管理命令未被拦截

**位置**：`plugin.py:1694-1705`

```python
if route is None and command["type"] in {
    "RUN", "OBJECTIVE_NEW", "OBJECTIVE_CONTINUE",
    "STATUS", "CANCEL", "TOPIC",
}:
    ...返回 REGISTRATION_COMMAND
source.profile = "codex-bridge"
return signed_command_rewrite(command, provenance)# ← ROUTE 命令到这里
```

当 `route is None`（未登记 stream），`ROUTE` 类型命令（包括 `/codex route set <projectId>`）**不在拦截集合中**，会被直接签名转发到 HCO。这意味着：
- 用户可在沙箱（stream2，未映射）执行 `/codex route set stockprofits` 强行改写路由；
- HCO 可能接受该请求（取决于 ACL），后果难以预测；
- 该操作完全不走REGISTRATION_TEXT 路径，用户收到的是 HCO 的路由变更确认，而非"未登记"提示。

方案一完全未提及此缺口。必须明确：ROUTE 命令是否应在 route=None 时被拦截，并写入合同测试和代码。

**推荐处置**：将 ROUTE 类命令统一到拦截集合中（`route is None` → REGISTRATION_COMMAND），仅 ROUTE.SHOW 可按当前逻辑走HCO。

---

### M-2：G-06 测试设计虚假，无法验证 Markdown 转义

marker `obj-1-LIVE-POSTFIX.S-001` 的字符集是 `[A-Za-z0-9._-]`，而 `_escape_markdown_inline`（`plugin.py:1002-1019`）**不转义这些字符中的任何一个**。`_escape_markdown_inline` 处理的是 `&`, `\`, `*`, `_`, `` ` ``, `[`, `]`, `(`, `)`, `#`, `!`, `@`, `<`, `>`, `|`——marker 中一个都没有触发。

测试中 `回显：obj-1-LIVE-POSTFIX.S-001。` 的回显是纯字面输出，和转义逻辑完全无关。通过 G-06 只能证明"route query 链路通畅"，**无法证明 project_id 或 cwd 包含 Markdown 特殊字符时会被正确转义**。

**修复**：需要补充两类测试：
1. project_id 或 cwd 中含 `*`、`_`、`` ` ``、`[`、`@` 字符时，`_render_bridge_result` 的输出通过 Zulip API 验证 rendered_html 中无对应 Markdown 渲染标签（`<strong>`, `<em>`, `<code>`, user-mention 等）；
2. marker 本身只验证回显链路完整性，不要将 G-06 的通过等同于转义验证通过——这两件事必须在测试描述中明确分开。

---

### M-3：G-01B 缺乏代码实现，现状与方案描述不符

方案一称"显式 HERMES route → 调用 HCO，返回 ROUTE_HERMES_OWNED"。但实际代码 `plugin.py:1717-1718`：

```python
if route is not None and route.owner == "HERMES":
    source.profile = "hermes-general"
# 然后 return {"action": "allow"} — 根本不走 HCO
```

当前代码**完全不调用 HCO**，而是让请求走 hermes-general profile。`ROUTE_HERMES_OWNED` 出现在 `bridge_client.py:46` 的 `USER_FACING_ERROR_CODES` 中，说明 HCO 有这个错误码，但插件当前根本不会触发它。

方案一说"G-01B 优先自动化 fixture，不直接修改生产沙箱 route"，这只是测试数据规划，对**是否修改 `route.owner == "HERMES"` 分支的代码**只字未提。

必须在合并前明确：
- **选项A**（维持现状）：保留`profile=hermes-general`，不调用 HCO。G-01B 只测试"插件拦截 /codex 命令并返回 HERMES 提示"，无需修改代码，fixture 验证即可。
- **选项 B**（变更）：修改代码，让HERMES-owned stream 的 /codex 命令调用 HCO。这需要代码改动、新合同测试、以及评估对生产中所有 HERMES route 的影响。

**推荐选项 A**，理由：减少不必要的 HCO 网络调用；行为更直接；不改动已通过合同测试的路径；ROUTE_HERMES_OWNED 码用于 HCO 内部自洽，插件不需要主动触发它。

---

## 建议修改

### S-1：日志方案不够具体，需要三处补充

1. **topic脱敏摘要格式未定义**：只说"脱敏摘要"，但 topic 可能含项目名、人名、内部编号。建议：记录字节长度 + SHA256 前12位（`topic_digest`），不记录明文。

2. **错误分类不完整**：方案中 `dispatchDecision` 字段未涵盖 `BridgeUncertainError`（请求可能已写入但响应丢失）。这是最需要区分的情况，必须有独立 decision 值（如 `"uncertain"`），并对应告警级别 WARNING，而非与 `"unavailable"` 合并记录。

3. **`channel_prompt` 中的 CWD 路径**：`plugin.py:1800` 注入的 `event.channel_prompt` 包含完整 CWD 路径（`_cwd_hint`）。方案声称不记录路径，但如果日志框架意外 dump 了 event对象，CWD 会泄露。建议明确：`channel_prompt` 赋值之前/之后均不得dump event对象到日志。

### S-2：`_is_route_query` 的 marker 正则与ROUTE_MARKER_PATTERN 存在细微不一致

`_route_query_marker`（plugin.py:932-940）用的搜索 pattern尾部是 `[A-Za-z0-9._-]{1,64}` 后接 `rstrip(".")`，而 `ROUTE_MARKER_PATTERN`（plugin.py:65）是 `fullmatch`。两者对以 `.` 结尾的 marker 行为不同：搜索 pattern 会提取并截掉尾 `.`，而 `_verify_context` 里用`ROUTE_MARKER_PATTERN.fullmatch` 验证。如果 marker 是 `test.`，搜索后得到 `test`，写入 context，verify 时 fullmatch `test` 会通过，不是问题；但测试中应覆盖此边界。

### S-3：`inbound_intents` 审计表的决策需显式声明

方案说"不把未提交 HCO 的请求写入 inbound_intents；需要长期审计时再增加独立受限审计表"。这是合理的延迟决策，但需要在设计文档中明确记录。当前合同测试或service.js 中没有任何提示说明插件拦截路径（REGISTRATION_TEXT）是否留有任何可查记录——生产排查时如果有用户投诉"发了 /codex run 没响应"，没有任何审计迹象，支持成本会很高。至少应在README 或CHANGELOG 中标注这是已知限制。

---

## 测试补充

### T-1：`route is None` + ROUTE 命令的行为测试（对应 M-1）

需要新增合同测试：
- `/codex route show` 在 route=None 时走 signed_command_rewrite（当前行为）；
- `/codex route set some-project` 在 route=None 时的行为——无论决策如何都必须有测试覆盖。

### T-2：Markdown 转义集成测试（对应 M-2）

`hco-fix2-api-acceptance.py` 的 B-03 测试只验证 escape_inline 函数本身（在 `raw` 中检查 entity），**未验证 Zulip rendered_html 的内容**（`_rendered` 参数在 `raw_encoded` lambda 中根本未使用）。应将 `markdown_safe` 检查（检查 rendered）与 `raw_encoded` 检查（检查 raw）两类断言互相补充，而非只做其中一类。

### T-3：HERMES route 流路径的合同测试（对应 M-3）

无论选择A 还是 B，都需要一个专项合同测试覆盖 `/codex status` 在 `route.owner == "HERMES"` stream 时的完整行为（期望输出是什么、profile 是什么）。目前合同测试中此路径无明确专项用例。

### T-4：BridgeUncertainError 的用户提示验证

`_bridge_uncertain_message`（plugin.py:1050-1058）当 objectiveId 通过 `_is_safe_cli_token` 检查时会嵌入 objectiveId 到回复中。应有测试覆盖：objectiveId 含边界字符时（如空格、`/`）是否被正确过滤，以及 BridgeUncertainError 触发时 pending_vault 中对应 entry 的状态。

---

## 风险与最终建议

**最高风险**：M-1 的 `/codex route set` 漏洞在沙箱 stream 2 可被重现。如果用户（甚至测试脚本）在 stream 2 执行 `/codex route set stockprofits`，可能会在未预期的生产 route 上造成副作用，且当前完全没有日志可追溯。这是阻断级缺陷。

**次要风险**：G-06 通过不等于转义验证通过。如果后续某次 projectId 使用了下划线或星号（如 `my_project` 或 `v2.0*`），而又没有真正的转义回归测试，Markdown 注入风险会在无感知的情况下出现。

**G-01B 语义**：强烈建议采用"插件拦截、不调用 HCO"方案（选项 A），并在合同测试中明确断言。如果后续真的需要 HCO 感知 HERMES route，应作为单独的 feature 而非这次修复的一部分。

**最终推荐**：

| 项目 | 阻断 | 可合并前完成 |
|------|------|------------|
| M-1 ROUTE 命令拦截漏洞 | ✓是 | 修代码 + 合同测试 |
| M-2 G-06 marker 无法验证转义 | ✓ 是 | 补充含特殊字符的测试用例 |
| M-3 G-01B 无代码实现 | ✓ 是 | 明确选A/B，补合同测试 |
| S-1 日志格式不具体 | 否 | 日志实现时补spec |
| S-2 marker 边界 | 否 | 补边界测试即可 |
| T-1–T-4 测试补充 | T-1 是 | 其余合并后补|

当前自动化通过率（Python 310, Node273, installer 32/32, Zulip 12/12）只能证明**现有测试范围内无回归**，不能证明上述漏洞不存在。P-00、G-05通过的结论不受本审核影响；G-06 需要按M-2 重新设计才能认可。
