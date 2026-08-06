# Chrome MCP 操作经验

## Zulip 唯一话题发送

1. 在现有已登录 Chrome 中打开目标频道和唯一话题 URL，不读取 cookie、local storage 或登录凭据。
2. 页面显示“目前没有消息”时，点击底部“在 #频道 > 话题发送消息”，展开同页 compose。
3. 明确回读 `#stream_message_recipient_topic` 的值，避免发送到旧话题。
4. 正文使用 `@**Jarvis PM**`。本次 API rendered HTML 为 `<span class="user-mention" ...>@Jarvis PM</span>`，证明该写法生成真实 mention。
5. 先填充并回读正文，再按一次 Enter。网络错误、502 或超时都不自动重发正式请求。

## PC 双标签竞态

1. 选择框出现后先记录消息 ID、截图和三个按钮状态。
2. 第二标签使用同一 narrow URL，并增加唯一 query 参数，避免工具复用同一个标签。
3. 两标签分别点击不同按钮。本次 A/B 点击 API 时间相隔约 1 秒，满足竞态覆盖。
4. 定时注入脚本的异步 timer 在当前 Chrome MCP 中不会可靠保留；不要把 `injected=true` 当作点击成功。立即 DOM click 可以作用于按 URL 指定的非活动标签。
5. 必须用 Zulip API 确认两条 Boss 回复携带相同 `clarify_id`、不同选项序号；不能只凭页面外观判断。
6. 处理后确认原选择框消息查询失败、固定 stale 提示只有一条、正常确认或失败告警也只有一条。

## 证据与收尾

- API 仅用于发送后的只读回查；正式 Boss 消息必须由 Web UI 发送。
- 服务端只保存相关计数和脱敏关键行，不保存 API key、Authorization header、cookie、供应商 URL或完整敏感日志。
- 任务结束前显式关闭本次 MCP session，但不停止用户的 `12306` 服务，也不关闭用户原有 Zulip 标签。
