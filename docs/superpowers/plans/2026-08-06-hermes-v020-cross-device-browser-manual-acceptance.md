# Hermes v0.20 异机 Codex 浏览器人工验收方案

## 1. 目的

本方案用于验证 Hermes v0.20 修复后，真实 Zulip 用户消息能够经过
`zulip-ingress`、Hermes/HCO、模型提供方和 Zulip delivery 完成一次且仅一次的处理。

浏览器运行在另一台电脑上，由 Codex 驱动已登录的真实 Chrome 会话；Hermes、HCO、
数据库和日志证据留在服务机上。浏览器自动化不改变“真实用户 Web UI 入站”的性质，
但测试必须由人工监督，并遵守本方案的单次发送和证据边界。

本方案取代本轮执行时对以下历史文档的直接照抄，但保留其交互和去重判定原则：

- `docs/HERMES_V019_INTERACTION_MANUAL_TEST.md`
- `docs/superpowers/test-artifacts/2026-07-30-hermes-v019-interaction-atomic-manual/zulip-chrome-mcp-operation-guide.md`
- `docs/superpowers/test-artifacts/2026-07-30-hermes-zulip-terminal-error-single-send-manual/browser-operation-notes.md`

`project_local/v1` 文件交换验收不属于本轮 Zulip 入站修复范围，应按
`docs/superpowers/plans/2026-08-05-project-local-exchange-manual-acceptance-test-plan.md`
单独执行。

## 2. 当前基线

- Hermes Agent：`0.20.0 (2026.8.3)`。
- 模型：`iotwq / gpt-5.6-sol`。
- HCO 插件：`1.0.0`。
- SpecCompass 项目集成和全局 CLI：`0.11.44.dev0`。
- stream 4：`ASK项目`，PROJECT route，项目 `ASK`。
- stream 5：`量化交易stockProfits`，PROJECT route，项目 `stockprofits`。
- stream 6：`hco-hermes-e2e`，HERMES route。
- `zulip-ingress` 是唯一 Jarvis PM Zulip poller，默认收件人策略已启用，
  `context_depth=0`。

执行前由服务机重新记录版本、commit、Gateway/HCO/delivery PID 和 post-deploy
preflight。运行态与本节不一致时，停止测试并更新基线，不能沿用旧证据。

## 3. 范围和结论等级

### 3.1 本次阻塞范围

以下项目全部通过，才能判定“Zulip 入站修复 PC 验收 PASS”：

1. `INGRESS-01` 框架状态问题真实入站。
2. `PC-00` 默认收件人与原生 mention。
3. `PC-01/02` 原生三选一和单次消费。
4. `PC-03` 双标签原子去重。
5. `PC-04` 取消。
6. 页面、Zulip API、Gateway 日志和 HCO 状态四类证据一致。

### 3.2 扩展桌面范围

`PC-05` 至 `PC-07` 和 `COORD-01` 至 `COORD-06` 用于完整桌面交互验收。
若本轮只验证 Zulip adapter 无响应修复，可以在结果中标为 `NOT RUN`，但不能把
结论写成“完整 Hermes/HCO 交互验收 PASS”。

### 3.3 不在本轮自动覆盖的范围

- Android 必须使用真实 App、真机或可控模拟器。只有 PC 时记录 `BLOCKED`，不得用
  Chrome 移动视口冒充。
- `NET-02` 涉及 Gateway/HCO/delivery 重启，只能在维护窗口执行。
- SpecCompass 安装、项目写入、交易、客户数据和生产文件修改均禁止。

## 4. 双端职责

### 4.1 浏览器测试机

浏览器测试机只负责真实 Web UI 行为和页面证据：

- 使用预先登录的 `boss` 或批准的独立人工测试账号。
- 记录操作系统、Chrome 版本、Codex 版本和浏览器驱动方式。
- 记录 stream、topic、RUN_ID、发送文本、时间、消息 ID、页面截图和标签 URL。
- 在点击前记录 zform 按钮标签、enabled 状态和截图。
- `PC-03` 记录两个标签的 URL、本地点击顺序和页面结果。

浏览器测试机不得：

- 使用 Jarvis bot API 发送正式请求。
- 读取或导出 cookie、密码、localStorage、Authorization header、API key 或按钮签名。
- 在工具超时、502、403 或结果不确定时自动重发。
- 默认保存 Playwright trace 或网络请求详情；它们可能包含认证信息。确需诊断时先
  脱敏并单独审批。

### 4.2 服务机

服务机只做只读运行态和后端取证：

- 通过 Zulip API 回查原文、rendered HTML、sender、消息 ID 和时间。
- 按 source message ID 查询 Gateway inbound 和 HCO 记录。
- 统计 `agent.turn_context`、provider attempts、`response ready` 和 Zulip send 次数。
- 检查 objective、turn、work、call、outbox 是否重复。
- 确认实际 provider/model 和 Gateway/HCO/delivery PID。

服务机不得把 `.zuliprc`、token、完整日志或供应商 URL复制到测试机或证据目录。

## 5. 浏览器驱动前置条件

1. 人工先在专用 Chrome profile 中登录 Zulip，确认能够看到目标 stream。
2. 测试机确认 Node.js/npm 和 `npx` 可用：

   ```bash
   node --version
   npm --version
   command -v npx
   ```

3. Codex 优先使用 Playwright CLI 或批准的 Chrome MCP/浏览器扩展接管现有会话。
4. 使用 headed 模式。开始前先列出标签并获取页面 snapshot，确认 URL、标题和登录用户。
5. 每次导航、页面显著变化或标签切换后重新 snapshot；不得复用失效元素引用。
6. 常规用例只保留一个 Zulip 标签。只有 `PC-03` 临时创建第二标签，完成后立即关闭。
7. 测试开始前，浏览器执行方把本轮 `RUN_ID`、stream 和 topic 提供给服务机取证方。

浏览器无法稳定接管现有登录会话时，状态为 `BLOCKED`。不得改用 bot API 或伪造
source message ID 代替真实入站。

## 6. 通用执行规则

- RUN_ID 格式：`YYYYMMDD-HHMMSS-<short-random>`。
- 每个会消费状态的用例使用独立 RUN_ID 和独立 topic。
- topic 格式：`hermes-v020-browser-<CASE>-<RUN_ID>`。
- 填写消息后必须回读 compose 内容和目标 topic，再按一次 Enter。
- 浏览器工具返回成功不等于消息已发送；必须等待页面出现 Boss 消息并记录 ID。
- 正向用例最多等待 180 秒。等待期间允许刷新和只读回查，不允许重发。
- 负向无回复用例至少等待 120 秒，并由服务机证明没有 session 或业务记录。
- mention 用例必须从 Zulip 候选列表选择用户。普通文本中的 `@名字` 不算原生 mention。
- 每次正式发送使用唯一标识，避免把历史消息或缓存回复计入本轮。

## 7. 阻塞用例

### INGRESS-01 框架状态问题真实入站

在 stream 5 的新 topic 中，通过 Zulip 候选列表选择 Jarvis PM 后发送一次：

```text
@Jarvis PM 请检查现在框架的安装情况、当前版本和下一步工作。只做只读检查。测试标识：<RUN_ID>
```

通过条件：

- Boss 请求只有一个 source message ID。
- Gateway 对该 source message 只有一次 inbound。
- 实际模型是 `gpt-5.6-sol`，不发生旧模型回退。
- 180 秒内只有一条 Jarvis 最终回复。
- 没有 HTTP 403、502、provider failure 或重复失败告警。
- 没有重复 objective、turn、work、outbox 或 Zulip 消息。
- 回复说明安装状态、版本和下一步，且没有执行项目写入。

任何失败或不确定结果都保留现场并停止自动重发。

### PC-00 默认收件人与原生 mention

将下列五项分布在 stream 5 和 stream 6 的至少两个新 topic 中。每项使用不同 RUN_ID：

1. 无 mention：`请只回复 DEFAULT-JARVIS-<RUN_ID>，不要调用工具。`
2. 只 mention 一个非 Jarvis 测试用户：Jarvis 不回复。
3. mention 两个非 Jarvis 测试用户：Jarvis 不回复。
4. 显式 mention Jarvis：`请只回复 EXPLICIT-JARVIS-<RUN_ID>，不要调用工具。`
5. 同时 mention Jarvis 和一个测试用户：Jarvis 只回复一次。

第 2、3 项除页面无回复外，服务机还必须证明没有 Hermes session、HCO inbound 或
业务记录。API rendered HTML 必须证明第 2 至第 5 项使用了真实 `user-mention`。

### PC-01/02 原生按钮和单次消费

在 stream 6 的新 topic 中发送：

```text
我需要收集一个测试选择。请让我在“选项 A”“选项 B”“取消”三个选项中选择；这只是交互测试，不执行项目操作。测试标识：<RUN_ID>
```

先完成 `PC-01` 取证，再在同一 prompt 上执行 `PC-02`：

1. 记录请求 ID、prompt ID、三个真实按钮标签和 enabled 状态。
2. 保存点击前截图。不能只依据正文中的编号判断有按钮。
3. 单击“选项 A”一次。
4. 只出现一条确认，明确选择 A。
5. 原 prompt 删除；刷新后也不得恢复。
6. HCO work/call/objective/inbound intent 均不新增。

### PC-03 双标签原子去重

使用新的 RUN_ID 和新 topic，重新生成一份未消费的三选一 prompt。按钮出现并完成
点击前取证后，才创建第二标签。

1. 第二标签打开同一 narrow URL，并增加唯一 query 参数，防止工具复用原标签。
2. 两个标签都确认同一个 prompt 的 A/B 按钮可用。
3. 激活标签一点击 A，立即激活标签二点击 B；不使用异步 timer 或伪造 action ID。
4. 若第二标签按钮已同步消失，记录“删除及时”，不强造第二次点击。
5. 若两个点击都送达，服务端只接受一个 winner；后到者收到固定 stale 提示。
6. 两条 Boss 选择必须拥有相同 `clarify_id` 和不同选项序号。
7. 只允许一次 clarify completion、一次 Agent 续跑和一条正常确认或固定失败告警。
8. 不得创建 HCO work/call/objective/inbound intent。
9. 关闭第二标签并确认恢复为单标签。

浏览器本地点击顺序不等于服务端写入顺序。winner 以服务端记录为准。

### PC-04 取消

使用新的 RUN_ID 和新 topic，重新生成三选一 prompt 并单击“取消”。

通过条件：prompt 删除，只出现一条取消确认，不继续 Agent/Codex 工作，不创建 HCO 记录。

## 8. 扩展桌面用例

### PC-05 命令尾随文本

使用当前 topic 内真实 `work-request-...` 和 `objective-...` ID 分别测试：

```text
/codex status <任务ID>
查询实际进度，并说明是否正在等待输入。
```

不得把尾随中文并入任务 ID，不得返回 invalid command；结果应包含后端状态和下一动作。

### PC-06 过期 running 状态

对一个无副作用且运行较久的测试任务查询状态。Zulip 文本必须与 App Server、submission
和持久化状态一致，不能机械复述陈旧 `running`。

### PC-07 跨 topic 隔离

在 topic A 创建只读 work，在 topic B 查询或继续。必须返回 scope mismatch，且不创建
新 turn、work 或最终消息。

### COORD-01 至 COORD-06

沿用历史主方案中的 Agent/Codex 分层汇报用例，但只允许只读任务。每个 PASS 都必须
同时记录 `workRequestId`、`codexCallId`、Agent 角色、父子关系和最终 Zulip 消息 ID。

## 9. 最小证据集合

服务机建立：

```text
docs/superpowers/test-artifacts/2026-08-06-hermes-v020-cross-device-browser/<RUN_ID>/
```

至少保存：

- `test-result.md`：用例、预期、实际、PASS/FAIL/BLOCKED/NOT RUN。
- `browser-evidence.md`：测试机、浏览器、Codex、URL、操作时间、消息 ID 和点击顺序。
- `zulip-api-evidence.json`：脱敏的消息 ID、sender、时间、原文摘要和 rendered HTML。
- `server-audit-evidence.json`：PID、模型、Gateway/HCO 计数和安全 ID。
- 点击前、最终状态和必要失败现场截图。

禁止保存 API key、Authorization header、cookie、MCP session ID、按钮签名 token、
供应商 URL、完整日志或完整 Playwright trace。

每个用例至少记录：

```text
case_id:
run_id:
started_at:
browser_host/browser_version/codex_version:
zulip_stream/topic:
source_message_id:
prompt_message_id:
reply_message_ids:
work_request_id:
objective_id:
expected:
actual:
evidence_files:
status: PASS | FAIL | BLOCKED | NOT RUN
```

## 10. 判定规则

### PASS

- 浏览器、API、Gateway 和 HCO 证据一致。
- 每个正向请求只有一次 inbound、一次逻辑处理和最多一条最终回复。
- 每个负向请求在等待窗口内无 Jarvis 回复，且服务端无 session/业务记录。
- 没有重复 objective、turn、clarify completion、outbox 或 Zulip 消息。
- 模型使用 `gpt-5.6-sol`，没有 403/502 或 provider failure。

### FAIL

出现以下任一项即失败：

- 正式消息由 bot API 发送或 source identity 不能证明。
- 正向请求无回复、重复回复、错误模型或 provider failure。
- 负向请求被 Jarvis 处理。
- 两个竞态选择都被正常接受，或出现第二次 Agent/HCO 工作。
- 工具超时后自动重发，导致请求是否唯一无法证明。
- 页面结论与 API、日志或数据库事实冲突。

### BLOCKED

- Codex 无法接管真实已登录浏览器。
- 测试账号、目标 stream、服务端取证或维护窗口不可用。
- Android 设备/App 不可用。
- 环境在用例中途重启、PID/route/model 改变，证据无法保持同一发布版本。

`BLOCKED` 不能记为 PASS，也不能通过 bot 自发消息、伪造 message ID 或修改数据库规避。

## 11. 给浏览器测试机 Codex 的执行指令

将以下内容交给另一台电脑上的 Codex，并替换 RUN_ID：

```text
你是本轮 Zulip 浏览器侧人工验收执行者。只操作已经登录 boss 用户的真实 Zulip Web UI，
不读取 cookie、密码、localStorage、API key、Authorization header 或按钮内部 token。

开始前记录操作系统、Chrome 版本、Codex 版本，列出当前标签并对目标页面做 snapshot。
使用 headed 浏览器。每次导航、页面变化或标签切换后重新 snapshot。

本轮 RUN_ID：<RUN_ID>
目标频道和话题由用例指定。每条消息填入后先回读频道、话题和正文，再只按一次 Enter。
浏览器工具超时、网络错误、403、502 或结果不确定时禁止自动重发。

按方案依次执行 INGRESS-01、PC-00、PC-01/02、PC-03、PC-04。每个会消费按钮的用例
使用独立话题。mention 必须从 Zulip 候选列表选择。PC-03 只有在真实按钮出现并完成截图
后才能创建第二标签；结束后关闭第二标签。

你只采集页面侧证据，不调用 Zulip API，不读取服务机日志，不修改任何项目文件。
每个用例输出：stream/topic、发送文本、发送时间、可见消息 ID、页面结果、截图路径、
两个标签 URL/点击顺序（如适用）、PASS/FAIL/BLOCKED 和原因。不要宣称服务端最终 PASS，
服务端取证方会按 source message ID 补充 API、Gateway 和 HCO 证据。
```

## 12. 收尾

1. 浏览器测试机关闭本轮临时第二标签和浏览器自动化 session，不关闭用户原有 Zulip 标签。
2. 服务机完成所有 message ID 的只读回查和脱敏证据归档。
3. 任一失败保留现场，不删除消息、不修改数据库、不重发同一 RUN_ID。
4. 汇总结论必须区分：本次阻塞范围、扩展桌面范围、Android、维护窗口用例。
