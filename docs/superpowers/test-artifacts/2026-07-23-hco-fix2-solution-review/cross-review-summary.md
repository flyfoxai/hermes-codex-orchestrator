# HCO Fix2 修复方案交叉审核结论

**日期**：2026-07-23  
**审核模型**：Claude Code、Gemini CLI  
**总体结论**：附条件批准；修订测试与审计定义后可实施，不建议依据模型推断直接进行路由架构重构。

## 共同确认

1. G-06 应拆分为两类：G-06A 验证正常标识符保真，G-06B 自动化验证 Markdown/HTML/mention 危险字符防护。
2. API 回读必须断言 Zulip rendered HTML 中存在真实 `user-mention` 元素，不能只检查发送文本。
3. 插件前置返回登记提示的路径需要明确脱敏审计策略，至少记录 message ID、sender ID、stream ID、解析后的 command type、结果码、字节长度和不可逆摘要。
4. 日志不得记录命令参数、正文、CWD、token、HMAC、秘密答案；摘要应使用 SHA-256，不使用可逆或保留明文片段的掩码。
5. 必须增加 snapshot 并发/最终一致性、HCO crash/restart/timeout、`BridgeUncertainError` 防重复和错误不泄漏测试。

## 代码核对后的裁决

1. 未映射 stream 中，插件只拦截 RUN、OBJECTIVE_NEW、OBJECTIVE_CONTINUE、STATUS、CANCEL、TOPIC；ROUTE 命令会签名进入 HCO。因此“ROUTE.SET 被插件直接执行”不符合当前控制流。
2. HCO 对 ROUTE.SET 会验证目标项目存在，并要求发起者具备目标项目 `route.manage`；已有 PROJECT route 还会校验原项目权限。因此不能把它定性为“绕过 ACL”。是否允许项目 maintainer 从未映射 stream 建立 route，是产品授权边界，需要显式写入合同和测试。
3. route snapshot 已包含 `generation`、有效期和 SHA-256 完整性，并通过临时文件、fsync、rename 原子发布。因此“缺少 generation 机制”是误判；并发窗口仍应测试，但当前证据不足以列为已证实阻断漏洞。
4. 显式 `/codex` 命令在普通消息 HERMES 分支之前处理；显式 HERMES route 的 `/codex` 命令会进入 HCO，而非直接交给 Hermes 普通对话处理。

## G-01 原因拆分

1. 早期“gateway/HCO 无入站”来自浏览器自动化没有生成真实 Zulip mention，属于测试输入/界面自动化问题。
2. 后续 G-01 在未映射沙箱返回登记提示，属于测试预期与现有路由契约不一致，不是入站消费故障。
3. 显式 HERMES route 应由独立的 G-01B 验证 `ROUTE_HERMES_OWNED` 控制流，不应使用未映射 stream 代替。

## 修订后的实施方向

1. 保持插件负责 snapshot 有效性、命令解析和最小安全路由，HCO 负责 ACL、route mutation、幂等状态与核心审计。
2. 明确未映射 stream 的 ROUTE.SHOW、ROUTE.SET、ROUTE.NONE、ROUTE.UNSET 合同；建议继续穿透 HCO，由 HCO ACL 决策。
3. 为插件本地登记提示增加脱敏结构化审计，避免未进入 HCO 的命令尝试完全不可见。
4. 保留 G-06A 已通过结论，新增 G-06B 自动化渲染测试，不把危险字符塞入受限的 route marker。
5. 发布前执行 G-01A、G-01B、真实 mention、snapshot 并发、HCO 故障和 uncertain 幂等回归。

## 发布门槛

- 新增测试全部通过，且现有 Python、Node、installer、Zulip API 测试无回归。
- 未映射 route 管理行为有明确合同和 ACL 用例。
- 插件与 HCO 日志通过秘密泄漏检查。
- 人工复测分别使用未映射 stream 和显式 HERMES route，不修改生产项目 route。
