# Hermes Clarify 全覆盖路由与安全兜底设计

日期：2026-07-27

状态：方案完成；Codex、Claude、Gemini 与两个独立审查代理复核一致，待实现

范围：Hermes v0.19.0 `SessionSource`、multiplex profile 路由、Gateway Adapter 解析、原生 `clarify`、Zulip zform、命令解析、工作目录与状态查询兜底

关联文档：

- `docs/HERMES_V019_INTERACTION_MANUAL_TEST.md`
- `docs/superpowers/test-artifacts/2026-07-27-hermes-v019-interaction-manual/manual-test-result.md`
- `docs/superpowers/test-artifacts/2026-07-27-hermes-v019-interaction-manual/zulip-api-evidence.json`
- `docs/superpowers/specs/2026-07-26-hco-unified-interaction-exchange-design.md`

## 1. 目标与原则

本方案不要求外部事实永远可得，而要求系统面对任何输入、依赖状态和异常时都有确定行为：

> 系统可以暂时不知道外部事实，但不能不知道下一步怎么处理。

所有核心入口必须是总函数：对允许类型范围内的任何输入，返回定义过的 tagged result，不允许落入未定义分支、裸空字符串、无法区分原因的 `None`/`False` 或未处理异常。

兜底不等于猜测、随意降级或继续执行。无法证明操作安全时，兜底行为必须是有明确错误码、可观察、无业务副作用的安全停止。

## 2. 已验证故障与根因

人工测试消息 `632` 使用了有效的 Jarvis PM mention。模型正确调用原生 `clarify`，工具参数为：

```json
{
  "question": "请选择一个测试选项：",
  "choices": ["选项 A", "选项 B", "取消"]
}
```

但持久化工具结果是：

```json
{
  "question": "请选择一个测试选项：",
  "choices_offered": ["选项 A", "选项 B", "取消"],
  "user_response": ""
}
```

日志显示工具在 `0.00s` 内完成，没有调用 Zulip zform API，也没有创建 HCO pending interaction。因此可以排除模型未调用、用户等待超时、Zulip API 拒绝和 HCO delivery 丢单。

根因是 `SessionSource.profile` 同时承担两个不兼容职责：

1. 物理 Adapter owner：消息由哪个 Bot 接入、授权和回发；
2. Agent runtime profile：使用哪套配置、模型、工具集、工作目录和 session namespace。

真实链路为：

```text
Zulip 入站 Adapter: zulip-ingress
  -> HCO hook 将 source.profile 改为 codex-bridge
  -> Agent 正确加载 clarify + hco_bridge
  -> _adapter_for_source 按 codex-bridge 查 Zulip Adapter
  -> codex-bridge 没有独立 Zulip Adapter，返回 None
  -> clarify callback 返回 ""
  -> 模型误以为用户提交了空答案
```

这不是单个按钮实现错误，而是身份字段职责混合导致的系统性路由错误。

## 3. 身份模型

在 Hermes `SessionSource` 增加显式字段：

```python
profile: Optional[str]
adapter_profile: Optional[str]
```

字段职责如下：

| 字段 | 唯一职责 | 可否由 HCO hook 修改 |
| --- | --- | --- |
| `profile` | Agent runtime config、toolsets、model、cwd、session namespace | 可以 |
| `adapter_profile` | 实际接收入站并负责授权、回发的 Adapter owner | 不可以 |

本次消息的正确状态是：

```text
adapter_profile = zulip-ingress
profile         = codex-bridge
```

### 3.1 写入规则

1. Gateway 在可信 Adapter 接入边界集中写入 `adapter_profile`，不要求每个平台自行实现。
2. Adapter 接入边界必须覆盖外部载荷中的同名字段，不能信任客户端、relay peer 或插件传入的 Adapter owner。
3. HCO `pre_gateway_dispatch` 只能修改 `profile`。
4. `adapter_profile` 在一次消息生命周期内不可变；发现修改尝试时记录审计并拒绝处理。
5. 所有 runtime config、工具和 session namespace 继续使用 `profile`。
6. 所有 authz、typing、clarify、reaction、消息删除和主动回发使用 `adapter_profile`。

### 3.2 旧数据兼容

旧 `SessionSource` 没有 `adapter_profile` 时，仅允许以下受控处理：

1. 当前活跃入站由可信 Adapter handler 重新盖章；
2. 可信本地持久化记录可在迁移期从原始 ingress 信息或旧 `profile` 推断，并记录结构化 warning；
3. 无法唯一证明 Adapter owner 时返回 `ADAPTER_UNAVAILABLE`；
4. 禁止按 platform 任意选择 `self.adapters[platform]`，避免多 Bot 环境跨身份发送。

兼容推断只作为一个发布周期的迁移路径，不作为长期路由规则。

## 4. Clarify 确定性状态机

原生 Hermes `clarify` 不改造成 HCO interaction。二者来源和生命周期不同：

- Hermes clarify：当前 Agent 对话中的同步信息收集；
- HCO interaction：Codex App Server reverse request 的 durable interaction。

Clarify 使用以下确定状态：

```text
REGISTERED
  -> DELIVERING
  -> DELIVERED
  -> WAITING
  -> ANSWERED
  -> CONSUMED
  -> PROMPT_DELETED
```

失败分支：

```text
ADAPTER_UNAVAILABLE
DELIVERY_FAILED
TIMEOUT
CANCELLED
ALREADY_CONSUMED
PROMPT_DELETE_PENDING
PROMPT_DELETE_FAILED
```

规则：

1. Zulip API 没有明确成功和 message ID，不得进入 `WAITING`。
2. 只有 `ANSWERED` 可以让 Agent 继续业务流程。
3. `""` 不得表示用户回答、取消、超时或系统错误。
4. Adapter 不存在或投递失败时，工具返回结构化错误，禁止模型将其解释为用户选择。
5. 回答状态与按钮删除状态分离；删除失败不能撤销已接受答案，也不能允许第二次执行。
6. 第一次合法回答以锁或事务完成 `WAITING -> ANSWERED` 原子转换；后续点击统一得到 `ALREADY_CONSUMED`。
7. interaction 必须绑定 adapter、platform、stream、topic、sender、session 和过期时间，任一不匹配即拒绝。

### 4.1 UI 降级规则

```text
Zulip 明确支持 zform
  -> 原生按钮

Zulip 明确拒绝或未协商 zform
  -> 带一次性 opaque action token 的文本命令

Adapter 或消息投递不可确认
  -> DELIVERY_FAILED，停止等待和后续执行
```

文本降级仍必须执行完整身份、话题、期限和一次性消费校验。不得使用裸选项文字触发审批、文件修改或其他敏感操作。

## 5. 全输入命令解析

`/codex` 采用分层、全覆盖解析，不能只匹配少数固定字符串：

```text
原始消息
  -> Unicode、空白和换行规范化
  -> 提取 mention
  -> 识别 /codex
  -> 识别子命令
  -> 解析必要参数
  -> 剩余内容保存为 natural_language_tail
  -> schema 校验
  -> CommandEnvelope
```

示例：

```text
/codex status objective-123
查询实际进度，并说明是否正在等待输入。
```

解析为：

```json
{
  "command": "STATUS",
  "objectiveId": "objective-123",
  "naturalLanguageTail": "查询实际进度，并说明是否正在等待输入。"
}
```

兜底规则：

| 输入 | 确定结果 |
| --- | --- |
| 命令和参数合法 | 执行；尾随文本仅作为说明 |
| 已知命令但参数不完整/非法 | `INVALID_COMMAND_ARGUMENTS`，返回用法，不执行 |
| `/codex` 子命令未知 | `UNKNOWN_COMMAND`，返回支持列表，不进入模型猜测 |
| 非 `/codex` | 普通对话 |
| 解析器内部异常 | `COMMAND_PARSE_ERROR`，不创建 objective，不产生副作用 |

## 6. 工作目录安全兜底

工作目录只能来自受信项目注册表：

```text
projectId
  -> project registry
  -> canonical cwd
  -> resolve(strict=True)
  -> 必须是目录
  -> 必须位于允许的项目根目录
  -> 拒绝符号链接逃逸、大小写绕过和 ../ 穿越
```

任何失败统一返回 `WORKSPACE_UNAVAILABLE` 并停止执行。禁止兜底到进程当前目录、HOME、Hermes 仓库、`/tmp` 或模型推测目录。

## 7. 状态查询与事实优先级

状态来源优先级：

```text
App Server 实时状态
  -> durable submission/turn 状态
  -> objective 本地缓存
```

规则：

1. 实时事实优先于缓存；
2. 多个来源冲突时进入 `RECONCILIATION_NEEDED`；
3. 后端不可达时不得机械返回缓存 `running`；
4. 回复必须区分已确认事实、未确认事实和允许的下一步；
5. `RECONCILIATION_NEEDED` 是定义完备的安全状态，不是未处理异常。

## 8. 统一结果合同

所有入口至少使用以下结果类型：

```text
SUCCESS
NEEDS_USER_INPUT
NOT_FOUND
UNSUPPORTED
INVALID_INPUT
UNAUTHORIZED
CONFLICT
ALREADY_CONSUMED
DELIVERY_FAILED
ADAPTER_UNAVAILABLE
BACKEND_UNAVAILABLE
WORKSPACE_UNAVAILABLE
RECONCILIATION_NEEDED
TIMEOUT
CANCELLED
INTERNAL_ERROR
```

每个结果必须定义：

- 是否允许继续执行；
- 是否允许用户或系统重试；
- 用户可见文案；
- 是否写入 durable state；
- 是否产生业务副作用；
- 对应结构化审计事件。

未知异常在最外层转换为稳定 `INTERNAL_ERROR`。转换过程记录错误类别与 correlation ID，但不向用户暴露堆栈、路径、token、API key 或敏感答案。

## 9. 实现边界

### 9.1 Hermes

1. `gateway/session.py`：新增 `adapter_profile` 及受控持久化兼容。
2. Adapter 接入 wrapper：集中盖章不可变 Adapter owner。
3. `gateway/authz_mixin.py`：Adapter 和授权解析使用 `adapter_profile`。
4. 审计所有直接使用 `source.profile` 做 authz/egress 的路径并改用统一 resolver。
5. 新增 `gateway/clarify_runtime.py`：封装注册、发送、等待、超时、清理和结构化结果。
6. `gateway/run.py`：只负责注入 Adapter、loop、chat、session 和 metadata；不保留大段交互状态逻辑。
7. `tools/clarify_gateway.py`：保持线程安全 primitive，禁止空值混合状态。
8. `gateway/platforms/zulip.py`：保持 zform Adapter，发送成功后登记 message ID 和一次性删除回调。

### 9.2 HCO

1. Bridge plugin 只修改 runtime `profile`，不得修改 `adapter_profile`。
2. 保留现有 HCO durable interaction、settlement、outbox 和 prompt-delete 协议。
3. 不把普通 Hermes clarify 写入 HCO objective interaction。
4. HCO 只需补充 hook 字段合同测试并保持原 interaction 回归通过。

## 10. 可观察性

Clarify 必须记录：

```text
clarify.registered
clarify.delivery_scheduled
clarify.delivered
clarify.waiting
clarify.answered
clarify.duplicate_rejected
clarify.timeout
clarify.delivery_failed
clarify.prompt_deleted
clarify.prompt_delete_failed
```

日志允许记录 `clarify_id`、session 摘要、platform、Adapter 类型、消息 ID、状态和耗时；禁止记录用户答案、完整 prompt、凭据或按钮内部签名。

## 11. 测试矩阵与发布门槛

### 11.1 单元与合同测试

- `profile=codex-bridge`、`adapter_profile=zulip-ingress` 时解析到 ingress Zulip Adapter；
- 没有唯一 Adapter owner 时 fail closed，不按 platform 任意回退；
- HCO hook 修改 `profile` 后保持 `adapter_profile` 不变；
- 旧 source 兼容推断与 warning；
- 新 source 序列化/反序列化保持 Adapter owner；
- Adapter 缺失、schedule 失败、Zulip 失败、超时和 session 清理均不返回空答案；
- 命令解析覆盖空白、多行、尾随中文、未知命令、超长输入、控制字符和 Unicode；
- workspace 覆盖不存在目录、symlink、大小写与 traversal；
- 每个 tagged result 的用户行为和副作用合同均有断言。

### 11.2 集成测试

- `zulip-ingress -> HCO profile rewrite -> codex-bridge -> clarify -> Zulip zform` 完整 wiring；
- 用户回复前 callback 保持等待，不得立即完成；
- zform request 包含全部 choices；
- 双标签、PC/Android 并发回答只消费一次；
- 删除失败不造成重复 settlement；
- cached Agent 下一轮重新绑定当前 Adapter、topic 和 event loop；
- 两个同平台 Bot 并存时不串 Bot；
- HCO App Server interaction 原有创建、回答、幂等、删除回归独立通过；
- App Server 状态冲突与不可达进入明确 reconciliation 状态。

### 11.3 模糊与故障注入

- 对命令 parser 进行 property/fuzz 测试，任何字符串不得产生未处理异常；
- 对状态转换做穷举测试，非法转换必须拒绝；
- 对 Adapter、Zulip API、数据库、App Server 每个外部失败点注入异常；
- 所有兜底分支断言无 objective、turn、interaction response 或工作目录副作用。

### 11.4 真实验收

自动测试通过后，重新执行 `docs/HERMES_V019_INTERACTION_MANUAL_TEST.md` 中 PC-01 至 PC-07、Android 和弱网用例。真实 Zulip API 必须证明 zform 渲染、点击回复、提示删除和重复点击行为；mock request 不能替代真实客户端验收。

发布必须同时满足：

1. 所有自动测试通过；
2. 没有裸 `""`/`None` 表达交互状态；
3. 每个输入和外部失败点均映射到定义过的结果；
4. 所有兜底路径无未授权副作用；
5. PC 与 Android 真实验收通过；
6. 状态查询不把缓存状态冒充后端事实；
7. 日志足以定位阶段且不泄露秘密。

## 12. 多模型审查结论

Codex、Claude、Gemini 和两个独立审查代理结论一致：

1. 推荐拆分 `adapter_profile` 与 runtime `profile`；
2. 禁止按 platform 回退任意 Adapter，避免跨 Bot 数据泄露；
3. 禁止把 transport failure 表示为用户空答案；
4. Hermes clarify 与 HCO App Server interaction 应保持边界清晰；
5. 当前大量单元测试仍漏掉了 `GatewayRunner -> HCO profile rewrite -> AIAgent -> clarify -> Zulip Adapter` 的完整 wiring；
6. 机制稳健性的关键不是增加更多自然语言规则，而是不可变身份、总函数、显式状态、原子转换、安全终态和端到端证据。
