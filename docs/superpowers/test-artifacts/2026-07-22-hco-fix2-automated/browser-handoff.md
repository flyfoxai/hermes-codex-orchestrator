# 授权用户浏览器测试资料

此文件供另一台主机执行第二批 16 个浏览器自动化用例。测试目标是已登录的、合法授权的 Zulip 用户；不要复制密码、API key、cookie 或 token 到文件或聊天中。

## 前置参数

```text
REPO=/Users/hula/Projects/hermes-codex-orchestrator
TEST_STREAM_ID=2
TEST_STREAM_NAME=沙箱
RUN_ID=<每次执行生成唯一值，例如 hco-browser-20260722T220000Z-a1b2c3d4>
TEST_TOPIC=<RUN_ID>
```

用户只需要在浏览器中完成登录、2FA 和组织选择，然后将页面停留在测试组织。自动化脚本负责发送消息、记录 message ID，并使用 Zulip API 回读消息和渲染 HTML；不能用 bot 身份替代授权用户入站测试。

## 用例清单

| 用例 | 浏览器动作 | 必须验证 |
|---|---|---|
| C-01 | 发送无效审批选项 | 出现 `INTERACTION_DECISION_INVALID`，不出现内部异常、socket 路径或 token |
| F-01 | 对 secret question 尝试 CLI answer | 出现 `INTERACTION_SECRET_ANSWER_FORBIDDEN`；答案不出现在消息、状态、日志 |
| F-02 | 对非 secret question 提交合法 answer | 正常提交，证明不是全局禁止 answer |
| F-03 | 混合普通/secret interaction 尝试 answer | CLI 不绕过 secret 限制；UI 仍可继续 |
| G-01 | Hermes-owned stream 发送 `/codex run <RUN_ID>-G01 no-op` | `ROUTE_HERMES_OWNED` 用户错误，不创建 objective |
| G-02 | 管理员发送不存在项目 route 命令 | `PROJECT_NOT_FOUND`，route generation 不变 |
| G-03 | 设置 topic 为 Hermes-only 后发送 run | `TOPIC_HERMES_ONLY`，结束时恢复 AUTO |
| G-05 | 查询不存在 objective | `OBJECTIVE_NOT_FOUND`，无内部异常 |
| H-01 | 在 alpha 上引用 beta project | 拒绝派发，beta 无状态变化 |
| H-02 | 引用 `file:///workspace/%62eta/src/main.py` | 百分号解码后仍拒绝 |
| H-03 | 使用大写十六进制百分号编码 | 同样拒绝 |
| H-04 | 百分号编码外部 cwd | 解码后命中 containment |
| H-05 | 引用当前 alpha project/cwd | 不误报 containment |
| H-06 | 引用 `betamax`、`alphabet`、`/workspace/beta-other` | 不因无边界子串误报 |
| H-07 | 将 beta 引用分别放入 instruction、constraints、acceptanceCriteria、reminders | 每个字段均触发 containment，且无 HCO 执行调用 |
| L-03 | 完成 topic/project 恢复操作 | topic 恢复 AUTO，route generation 和生产 route 无变化 |

## 每个用例的操作协议

1. 在执行前记录 route snapshot generation、HCO/delivery PID 和当前 topic mode。
2. 生成唯一 `RUN_ID`，只在测试 stream/topic 发送测试消息。
3. 等待回复出现后记录 inbound/reply message ID；使用 API 回读 `content`，不要只看截图。
4. 对回复做 HTML 断言：无意外 `<em>`、`<strong>`、`<a>`、`<code>`、mention class；危险 ID 不应出现在可复制 CLI 命令中。
5. 通过状态 API、SQLite 摘要和日志核对 objective/interaction/outbox；不得保存完整 prompt、secret answer 或 token。
6. 用例结束后清理测试 topic、临时 objective 和 topic mode；保留 PASS 消息 ID，失败样例按维护者决定删除并记录原 ID。

## 禁止事项

- 不扩大 ACL，不伪造用户，不批准或取消非测试任务。
- 不修改生产 route，不在生产维护窗口外注入 transport 故障。
- 不把浏览器 profile、cookie、密码、API key 或 signed context token 放入证据目录。

## 结果格式

每个用例输出一行 JSON，至少包含：`run_id`、`case_id`、`message_id`、`reply_message_id`、`objective_hash`、`raw_sha256`、`rendered_sha256`、`status`、`cleanup`。只保留摘要哈希，不保存秘密或完整消息正文。
