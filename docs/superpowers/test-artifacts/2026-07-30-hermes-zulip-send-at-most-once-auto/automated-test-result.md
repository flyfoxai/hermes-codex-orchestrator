# Hermes Zulip 非幂等发送去重复自动验证

## 结论

- 执行时间：2026-07-30 10:56-11:14 CST。
- 自动验证：**PASS**。
- 部署：**COMMITTED**。
- 人工 PC-03：**待复测**；Android：**BLOCKED**（无 adb、模拟器或可控真机）。

本轮修复只处理消息 `713/714` 所暴露的重复投递，不改变已经通过的 clarify 原子首次结算。模型供应商失败是独立结果：当时先返回账号并发限流，随后两次返回 HTTP 502；它可以导致首次选择没有正常确认，但不能再导致两条相同 Zulip 告警。

## 机制

1. Zulip 的 `send_message` 使用 `retry_on_errors=False`，SDK 不再自行重复非幂等 POST。
2. POST 内异常和无法确认的 5xx 返回 `SendResult.delivery_uncertain=true`。
3. Gateway 公共发送层看到该状态后立即返回，不重发原内容、不发送纯文本 fallback，也不追加失败通知。
4. 服务端明确返回的格式错误仍可发送一次纯文本 fallback。

## 自动检查

| 检查 | 结果 |
|---|---|
| Zulip、发送重试、delivery ledger、Telegram final delivery | PASS，342 tests |
| Base platform、delivery、stream consumer | PASS，347 tests |
| 合计不重复测试 | PASS，689 tests |
| Python compileall | PASS |
| Ruff changed-files check | PASS |
| 已安装 Zulip SDK 构造器 `retry_on_errors=False` | PASS |
| `git diff --check` | PASS |
| 事务安装器兼容性、staged/activated 探针和 readiness | PASS |
| post-deploy smoke | PASS，12/12 checks |

回归用例直接模拟“服务端已经接收消息，但客户端收到连接异常”和 502 响应；两种情况下均断言 `send_message` 只调用一次。另有负向用例确认明确格式错误仍执行一次安全的纯文本降级。

## 部署证据

| 服务 | 部署前 PID | 部署后 PID |
|---|---:|---:|
| HCO | 16897 | 38934 |
| Zulip ingress Gateway | 16913 | 38954 |
| delivery sidecar | 16956 | 38997 |

部署 manifest 为 `COMMITTED`，route generation 25 且语义 hash 部署前后不变。插件内容未变化，因此 stable release 仍为 `hermes-codex-bridge-1.0.0-45173d2595dc`；Gateway 重启后从当前 Hermes 源码加载新的发送逻辑。另两个独立 Gateway PID 1525/1533 未被本次安装器操作。

## 人工待测

只需重新执行 `PC-03`：两个 PC 标签页对同一个按钮分别选择不同答案。预期一个服务端 winner、一个固定 stale 提示、一次 clarify 完成、一次 Agent 续跑、原 prompt 删除。若供应商仍失败，只允许一条失败告警；供应商恢复时应只有一条正常确认。

Android 仍需真实 App 验证，不能用移动网页替代。
