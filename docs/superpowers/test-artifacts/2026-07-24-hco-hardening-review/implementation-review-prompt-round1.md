你是 hermes-codex-orchestrator 的资深安全与可靠性审查员。请在当前仓库中独立审查本轮“post-fix hardening”实际实现，不要只复述计划。

必须阅读：
1. docs/superpowers/plans/2026-07-24-hco-post-fix-hardening-plan.md
2. 当前 git diff（注意工作区包含此前用户修改；重点审查与计划相关的新增/修改）
3. plugin/hermes-codex-bridge/plugin.py
4. scripts/install-hermes-codex-bridge.sh
5. scripts/query-hermes-route-audit.py
6. scripts/trace-zulip-message.py
7. test/diagnostic_tools_test.py
8. test/hermes_plugin_contract_test.py 中 route audit 与提交确认相关测试
9. docs/OPERATIONS.md
10. package.json

已执行且通过的验证：
- /Users/hula/Projects/hermesAgent/.venv/bin/python3 -m pytest -q => 395 passed
- bash test/install-hermes-codex-bridge.test.sh => 32/32 PASS
- node --test test/*.test.js => 273/273 PASS
- npm run check => PASS
- npm run verify => PASS
- git diff --check => PASS

重点审查：
- 独立 JSONL route audit sink 的目录/文件权限、symlink/hardlink、大小限制、短写、fsync、fail-closed 行为
- deployment-manifest 是否只在完整成功后 COMMITTED，事务回滚是否安全，是否足以证明 release/attestation/service/route 语义
- query/trace 工具是否只读、隐私安全、错误状态清楚、不会泄露正文或秘密
- 显式 owner=HERMES stream 中普通消息归 Hermes，但显式 /codex 必须签名进入 HCO 并返回 ROUTE_HERMES_OWNED，且不创建 objective/turn
- 长任务提示是否避免误导用户重复提交
- G-01B 缺少隔离环境时只能 BLOCKED_PRECONDITION，不得要求修改生产 route 或伪造 PASS
- 测试是否覆盖了本轮新增风险

请严格只输出一个 JSON 对象，不要 Markdown 围栏，不要前后说明：
{
  "verdict": "APPROVE 或 CHANGES_REQUIRED",
  "blockingIssues": [{"severity":"HIGH|MEDIUM","file":"路径","line":数字或null,"issue":"问题","requiredFix":"必须修复方式"}],
  "nonBlockingSuggestions": [{"file":"路径","suggestion":"建议","rationale":"原因"}],
  "securityReview": "结论",
  "reliabilityReview": "结论",
  "testCoverageReview": "结论",
  "planConformanceReview": "结论",
  "finalRationale": "最终理由"
}
只有会影响安全、正确性、回滚、数据完整性、验收真实性或计划核心目标的问题才列为 blocking issue。不要无限扩大范围。
