# Zulip Chrome MCP 浏览器验收操作手册

## 适用范围

本手册用于在已经登录 Zulip 的授权用户 Chrome 会话中执行 HCO/Hermes 浏览器验收。发送动作必须走 Zulip Web UI；Zulip API 只用于发送后的只读回查，不能用 bot/API 发送替代授权用户入站测试。

## 浏览器和窗口约定

- 当前验收环境必须连接用户配置的 Streamable HTTP Chrome MCP：`http://127.0.0.1:12306/mcp`。不要误用另一套 Chrome 插件控制通道。
- Chrome 不需要一直保持在 Windows 最前台。
- 测试期间不要切换测试窗口中的活动标签页，也不要关闭或刷新 Zulip 标签页。
- 当前环境有两个 Chrome 窗口。测试窗口只有一个标签页，页面是已登录的 Zulip；另一个多标签窗口不属于本次测试。
- 测试窗口默认已登录并位于 Zulip 对话页；直接复用当前页面，不要点击登录，也不要为每个用例新开标签页。
- 每次操作前先调用 `get_windows_and_tabs`，按窗口、标签数量、URL 和标题确认目标。不要只按“当前活动标签”猜测。
- Chrome MCP 重启后需要重新初始化会话；会话 ID 是临时值，不得写入证据文件。

## 标准 UI 发送流程

1. 在左侧“频道”区域找到目标频道并点击，使其展开。
2. 点击目标话题，确认中间消息流标题同时显示目标频道和话题。
3. 点击中间栏底部“在 XXX 发送消息”。输入区域会在同一页面向上展开，不是弹窗。
4. 如果 `#compose-textarea` 已经可见，说明输入区域已经展开，不要重复点击底部发送入口。
5. 正式测试消息使用 `@**Jarvis PM**` 作为开头，再用 `chrome_fill_or_select` 向 `#compose-textarea` 填入完整消息。
6. 回读输入框 value，确认内容完整且话题未变化。
7. 用 `chrome_keyboard` 对 `#compose-textarea` 发送 `Enter`。
8. 用 `chrome_get_web_content` 确认消息以当前授权用户身份出现在中间消息流。
9. 在 devmac 使用 `~/.zuliprc` 做只读 API 回查，核对 message ID、stream、topic、sender 和原始 content。脚本不得输出账号凭据。

同一频道/topic 的后续用例应继续使用当前标签和已经展开的 `#compose-textarea`。只有目标 topic 在页面中确实无法到达时才考虑其他导航方式；优先点击左侧频道和话题，避免调用会新开标签的 `chrome_navigate`。

## Jarvis PM mention 规则

- 当前登录并发送消息的人工账号是 `boss`；`boss` 不是要选择的 mention 对象。
- Chrome MCP 输入 `@` 后不一定能稳定显示或操作候选列表。可直接输入 Zulip 原生语法 `@**Jarvis PM**`，即一个 `@`，人名前后各两个星号。
- 不要写成普通文本 `@Jarvis PM`，也不要在人名前后各放四个星号。
- 发送后必须用 Zulip API 验证。`apply_markdown=false` 的原文应保留 `@**Jarvis PM**`；渲染内容应包含类似 `<span class="user-mention" data-user-id="9">@Jarvis PM</span>` 的真实 mention 标记。
- 只有 API 渲染结果包含 `user-mention` 时，正式用例才有效。页面上仅看见字样不足以证明 mention gate 会放行。

## 结果判定

- 键盘工具返回成功不等于消息已发送，必须同时通过页面消息流和 Zulip API 回查。
- 页面出现消息且 API 能回读 message ID，才判定“授权用户 UI 发送”通过。
- “Codex 请求已提交”只表示入站被接受，不是最终任务结果。必须继续等待独立的最终结果 message ID，并核对 objective/submission/outbox 的终态。
- 对 `no-op` 等小任务，先观察是否出现 gateway 入站日志。没有入站日志时，不能把无回复归因于 Codex 任务耗时。
- gateway 已收到消息但任务仍运行时，再按任务规模延长等待，并检查 objective/turn/outbox 状态。
- 每个正式用例使用唯一 RUN_ID，记录 inbound message ID、reply message ID、预期错误码、objective 数量和清理结果。

## 常见误区

- 不要通过 Zulip API 直接发送测试指令。
- 不要为了 API 回查在活动测试标签页中导航到 `/api/v1/messages`；应从 devmac 独立查询，避免干扰页面。
- 不要在输入框已经展开时重复点击发送入口。
- 发送一条消息后输入框可能仍保持展开。如果底部发送按钮不可见，但 `#compose-textarea` 可见，应直接填入下一条消息。
- 不要把“页面存在用户消息”表述成“Hermes 已形成回复对话”。回复必须有独立 message ID 和 API 证据。
- 这个 Chrome MCP 的 `chrome_navigate` 即使传入 `newWindow=false` 也可能在测试窗口中新建标签。若不得不用它切换不存在的新话题，应先确认新标签 URL 正确，再关闭旧标签，恢复测试窗口只有一个标签页；日常优先按左侧频道和话题导航。
- 多窗口环境中，不带 `url` 的 `chrome_get_web_content` 可能读取全局活动窗口，而不是测试窗口。测试标签不在前台时，传入从 `get_windows_and_tabs` 取得的精确 Zulip URL；这只读取现有标签，不需要新开页面。
- 不要点击登录、输入密码或处理 2FA；这些步骤由用户完成。
- 不修改生产 route，不借用真实审批或 secret interaction，不擅自重启 gateway。

## 最小复测顺序

1. 记录 route generation、HCO/gateway/delivery PID、topic mode。
2. 先发一条唯一的普通 UI 验证消息，完成页面和 API 双重回查。
3. 再发送正式最小指令，例如 G-01 的 `/codex run <RUN_ID>-G01 no-op`。
4. 先确认 gateway 入站，再等待预期业务回复。
5. 回查 reply message ID、HCO SQLite、objective/outbox 和日志。
6. 按测试计划恢复 topic mode 和临时状态。

## 沙箱与项目频道的对照

- 不要仅凭频道名称把`沙箱`视为 Hermes-owned stream；执行前必须读取实时 route snapshot。2026-07-23 的 generation `14` 中，stream `2`（沙箱）未显式映射，因此只适合验证未映射 stream 的登记提示，不能代替 G-01B 的显式 HERMES route 前置条件。
- G-01B 必须使用已经显式配置为 owner=`HERMES` 的隔离 stream；若实时 snapshot 中不存在该条件，应记为 BLOCKED，不得临时修改生产 route 制造条件。
- 要验证项目路由，可进入已经映射项目的频道，在专用测试话题发送只读状态查询，例如 `/codex status <唯一且不存在的-objective-id>`。
- 项目频道的只读查询应快速返回 `OBJECTIVE_NOT_FOUND`。如果沙箱和项目频道都没有 gateway inbound 记录，则应判断为 Zulip 入站消费故障，而不是频道限制或大型任务耗时。

## 2026-07-23 实测补充

- `@**Jarvis PM** 请只回复：HCO-FIX2-POSTDEPLOY-20260723-112358-P00` 通过 UI 发送后，Zulip API 将其渲染为真实 `user-mention`，Jarvis PM 正常回复，证明双星号语法可稳定绕过候选列表操作问题。
- 测试窗口不需要始终位于 Windows 最前台；关键是不要让其他标签替换测试窗口中的活动 Zulip 标签。
- 键盘工具返回 `Enter` 成功后仍需 API 回查。本次消息 `512`、`514`、`516`、`518` 均通过 API 确认，不能只依赖浏览器工具的成功返回。
- 修复后复测确认：正确控制端点是 `127.0.0.1:12306/mcp`，测试 profile 已登录。G-05 入站/回复为 `537/538`；G-06A 入站、提交确认、最终结果为 `539/540/541`。
- G-06A 的提交确认后约 165 秒才出现最终结果。页面一度只显示“正在输入”或提交确认，但 HCO 最终记录为 objective/submission `completed`、outbox `delivered`；因此大型或 Codex-backed 任务应等待最终消息，不能用固定 30 秒超时直接判失败。
- 结束时应让测试窗口恢复为一个 Zulip 标签。后续用例直接在这个标签的同一页面继续，不需要重新导航或登录。

## 2026-07-29 v0.19 完整人工验收补充

- 在同一频道新建多个测试话题时，不需要导航或新开标签。展开撰写框后填写 `#stream_message_recipient_topic` 即可切换/创建目标 topic，然后继续使用同一个 `#compose-textarea`。
- 对跨话题隔离测试，应先从 HCO 只读回查话题 A 的真实 objective ID，再在话题 B 用 UI 发送 continue。仅使用 Jarvis 聊天回复里的 ID 可能遗漏“回复称未生成、数据库实际已生成”的协议错误。
- `chrome_network_request` 在当前 12306 服务中可能对 Zulip API 请求超时。此时保持浏览器页面不动，从 devmac 使用 `~/.zuliprc` 做独立只读 API 回查；不得输出配置内容或认证头。
- API 证据应同时保存 `apply_markdown=false` 的原始正文和默认 rendered HTML。本轮消息 `679` 原文保留 `@**Jarvis PM**`，HTML 包含 `span.user-mention[data-user-id=9]`，可确认正式 mention 有效。
- legacy zform 的页面按钮可能显示数字 `1/2/3`，而 submessage 中 `long_name` 才是“选项 A/选项 B/取消”。验收要求是按钮标签完全一致时，必须检查 `short_name` 和实际页面显示，不能只看说明文字。
- 按钮点击会生成一条 Boss mention 消息并不代表 interaction 已消费。必须继续确认 Jarvis 确认消息、原按钮删除/失效，以及 HCO interaction settlement；三者缺一不可。
- 命令返回 `Invalid /codex command.` 与 `scope mismatch` 不是等价结果。跨话题测试还要查询该 source message 是否新增 work/call，区分“解析阶段拒绝”与“scope 校验拒绝”。
- 结束截图应核对工具返回的精确 tab ID 和 URL。多窗口下仅凭截图文件名仍不足以证明来源。
- 本轮 Chrome UA：`Chrome/150.0.0.0`，`Windows NT 10.0; Win64; x64`；测试窗口 `1777374370` 保持唯一标签 `1777374382`。窗口/标签 ID 只用于当次取证，不应作为未来固定配置。

## 2026-07-27 v0.19 交互测试补充

- 浏览器窗口数量是动态的。本次 Chrome 有三个窗口，测试窗口仍通过“唯一 Zulip 标签 + 精确 URL”识别；不要继续依赖“两窗口”这一历史数量。
- 多窗口中普通点击/键盘工具可能落到其他窗口。若已用 `get_windows_and_tabs` 确认目标 URL，可用 URL 定向的 `chrome_inject_script` 在 `MAIN` world 点击 `#compose-send-button`；发送前仍须回读 `#compose-textarea`，发送后仍须做页面与 API 双重确认。
- URL 定向发送示例：`const button = document.querySelector("#compose-send-button"); if (!button) throw new Error("send button missing"); button.click();`。只在用户已经授权发送且草稿正文已回读一致后执行。
- `chrome_screenshot` 没有 URL 参数，多窗口下不能证明截图来自测试标签。无法可靠定向时，不要把截图作为强证据；保存 URL 定向 DOM 内容和 Zulip API rendered HTML，并在结果中明确截图缺口。
- v0.19 本次 PC-01 的消息 `632` 已被 API 证明确认为真实 mention，但回复 `633` 没有原生按钮。没有按钮时，PC-02/03/04/07 应记为 BLOCKED，不能伪造 interaction ID 或点击行为。
- status 查询消息 `634` 证明尾随中文不会进入 objective ID；回复 `635` 返回 `reconciliation_needed` 并明确后端不可确认。此结果可通过 PC-05 命令解析检查，但不能替代 PC-06 的真实后端终态证据。
