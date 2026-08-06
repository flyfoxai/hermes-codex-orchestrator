# Claude Review Request: HCO Unified Interaction Exchange

请对以下设计做严格、只读的架构审查，不要修改任何文件：

- 主设计：`docs/superpowers/specs/2026-07-26-hco-unified-interaction-exchange-design.md`
- 现有 artifact 协议：`docs/ARTIFACT_PROTOCOL.md`
- 关键现状代码：`hco/turn-controller.js`、`hco/service.js`、`hco/state/store.js`、`hco/state/migrations.js`
- 投递链路：`plugin/hermes-codex-bridge/delivery_sidecar.py`、`plugin/hermes-codex-bridge/zulip_sender.py`
- 入站解析：`plugin/hermes-codex-bridge/plugin.py`
- 可参考的 zform 实现：`/Users/hula/Projects/hermesAgent/gateway/platforms/zulip.py`

背景：当前审批 request 同时含普通 `accept`、对象型 exec-policy amendment 和 `cancel`。HCO 因请求中存在扩展权限选项及命令超过 400 字符而隐藏普通 accept，导致 Zulip 只能取消。用户要求支持长命令完整展示、原生按钮、直接回复“同意/可以/OK”、询问和文档中转。

请重点检查：

1. 是否真正按“用户选中的 action”判定风险，仍有无意扩大一次性批准范围的路径。
2. zform 可见回复、sender/target ACL、opaque action ID 和 source-message 幂等是否形成闭环。
3. 自然语言别名的零候选、多候选、并发、过期和普通聊天边界是否安全。
4. detail chunk/document 必须先完整交付再显示 action 的状态机是否可实现，是否有 ACK 竞态或死锁。
5. document upload 的 durability、重复窗口、URI 生命周期、访问控制、GC 和 artifact v1 兼容性。
6. secret input 设计是否与 durable state 和 App Server response 语义矛盾。
7. capability 协商和滚动升级是否可落地，旧 sidecar/plugin 是否会错误处理新 payload。
8. schema、状态机、失败恢复、审计和测试矩阵是否遗漏关键约束。
9. 方案中是否有自相矛盾、过度设计或无法用当前 HCO 边界实现的部分。

输出中文 Markdown，按严重程度给出具体 findings。每条 finding 包含：严重级别、设计章节/相关代码位置、为什么有问题、建议的准确修改。最后给出：

- `结论：APPROVE` 或 `结论：REVISE`
- 必须修改项清单
- 可选优化项清单

不要泛泛总结，不要泄露任何凭证，不要执行安装、网络发布或代码写入。
