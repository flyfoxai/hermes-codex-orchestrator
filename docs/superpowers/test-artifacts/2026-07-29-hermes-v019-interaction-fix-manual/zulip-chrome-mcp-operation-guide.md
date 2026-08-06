# Zulip Chrome MCP 浏览器验收操作手册（2026-07-29 更新）

本文继承 `2026-07-29-hermes-v019-interaction-manual/zulip-chrome-mcp-operation-guide.md` 的通用规则，并补充交互修复复测中的可复用经验。

## 基本约束

- 发送动作必须来自已登录 Boss 的 Zulip Web UI；`~/.zuliprc` 只能用于发送后的只读回查。
- 正式消息使用 `@**Jarvis PM**`，发送后用 API rendered HTML 确认存在真实 `user-mention`。
- Chrome 不需要保持在 Windows 前台。操作前先用 `get_windows_and_tabs` 核对窗口、标签、URL 和标题。
- 复用已登录页面；不要点击登录，不要读取 cookie、密码或认证配置。
- 常规用例保持单标签；只有测试方案明确要求双标签竞态时才临时创建第二标签，完成后立即关闭并恢复单标签。

## 标准发送与确认

1. 确认目标频道和话题；`#compose-textarea` 的 placeholder 必须包含正确频道和话题。
2. 用 `chrome_fill_or_select` 填入完整消息，并回读 textarea value。
3. 对 `#compose-textarea` 发送 `Enter`。
4. 浏览器工具返回成功不等于发送成功；必须用 Zulip API 回读授权用户消息 ID。
5. API 同时保存 `apply_markdown=false` 原文和 rendered HTML；脚本不得输出凭据或 Authorization header。

## zform 按钮取证顺序

Zulip prompt 被消费后会从消息 API 中消失，所以必须在第一次点击前完成取证：

1. 记录请求消息 ID 和 prompt 消息 ID。
2. 用 `chrome_get_interactive_elements` 分别查询“选项”和“取消”，记录实际 button 标签、enabled 状态和坐标。
3. 保存点击前截图，并核对工具返回的准确 tab ID 和 URL。
4. 再执行点击；点击后用 API 记录 Boss 选择消息和 Jarvis 确认消息。
5. 确认 prompt ID 已从 API 消息集合消失，并查询 HCO 是否意外创建 work/call/objective。

不要只看 prompt 正文中的 `1/2/3`。PC-01 的判断依据是实际按钮标签；正文可以有编号，但不能仅提供编号或文本选项。

## 双标签竞态操作

- 对完全相同的 URL，`chrome_navigate` 可能只激活现有标签，不会创建副本。
- 需要第二标签时，在 origin 后增加唯一 query 参数，例如：

```text
https://zulip.example/?pc03-tab=2#narrow/channel/5/topic/<topic>/with/<message-id>
```

- 等待第二标签加载，并在两个标签中分别确认同一个 prompt 的按钮均可用。
- 记录两个精确 URL。通过导航到精确 URL 激活标签一，点击 A；随即激活带 query 参数的标签二，点击 B。
- 若第二标签按钮已经同步消失，记录“删除及时”，不要伪造 action ID 或内部命令。
- 若第二次点击工具返回成功，必须继续回查 API。prompt 最终被删除不等于重复消费已拒绝；本轮实测中，两个 stale-tab 点击都成功并分别获得 Jarvis 确认，这是明确 FAIL。
- 截图后关闭第二标签，并用 `get_windows_and_tabs` 确认测试窗口恢复为一个标签。

## status 与终态核验

- PC-05 必须使用当前话题内真实 work/objective ID。若没有，可先发送一个明确无副作用的小型只读任务生成 ID。
- work 和 objective 两条 status 指令都保留尾随中文，分别检查命令解析、活动 call/Agent 数、下一动作和后端验证状态。
- Zulip 文本不能单独证明 PC-06。同步读取 HCO 的 work、call、objective execution 和 turn submission；只选非敏感字段，不复制 request、mailbox payload 或内部 token。
- work 可能处于 `caller_review`，而 call/submission/objective 已 completed。此时回复应明确活动 call 为 0、下一动作是 caller review，或直接对 objective 返回 app-server 核验的 completed；不能只给陈旧 running。

## Android 边界

- Android 验收必须使用真实 Zulip Android App 或可控 Android 模拟器，并记录 App 版本、Android 版本和设备型号。
- 没有 `adb`、设备或模拟器时，记录 `NOT RUN / BLOCKED`。
- 不得用 Chrome 手机视口、响应式网页或桌面页面缩放冒充 Android App 验收。

## 本轮实测索引

- PC-01：`688 -> 689`，按钮标签正确。
- PC-03：`690/691 -> 692/693`，两个标签均被接受，FAIL。
- PC-02 独立单击：`694 -> 695 -> 696/697`，PASS。
- PC-04：`698 -> 699 -> 700/701`，PASS。
- PC-05/06：`704/705`、`706/707`，尾随文本解析和 app-server completed 核验通过。
- 结束时测试窗口已恢复为一个 Zulip 标签。

## 2026-07-30 原子结算修复后的经验

- 两个标签的本地点击调用顺序不代表服务端结算顺序。本轮先调用标签一的 A，再调用标签二的 B，但服务端先写入 B；判定必须使用固定提示中的首次选择和服务端时间。
- 修复后两条 Boss 回复应保留相同 `clarify_id` 和不同选项序号。后到请求必须收到“首次选择继续有效”的固定提示，不能只依据 prompt 最终删除判断去重成功。
- 服务端核验至少同时计数：clarify intercept、`tool clarify completed`、`agent.turn_context`、`response ready`，以及 HCO work/call/inbound intent。两个 intercept 配合一个 clarify completion 才能证明竞态被原子收敛。
- 模型供应商错误要与原子结算结果分开记录。固定拒绝提示和零业务记录可以证明 loser 被拦截；若 winner 后续因 provider 失败而没有正常确认，严格端到端 PC-03 仍不能判为 PASS。
- Zulip API 消息数也要单独核对。本轮 Gateway 只有一次 `response ready` 和一次 send 日志，但页面/API 出现两条相同 provider failure 告警；这属于需要独立调查的重复投递迹象，不能当作第二次 clarify 工作。
- 竞态完成后关闭第二标签并确认测试窗口恢复单标签。MCP streamable HTTP session 也应显式结束，但不要停止用户启动的 Chrome MCP server。
