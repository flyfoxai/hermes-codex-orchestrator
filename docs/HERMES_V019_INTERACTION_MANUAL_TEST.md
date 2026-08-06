# Hermes v0.19.0 交互功能人工验收方案

## 1. 测试目标

验证 Hermes v0.19.0 升级后，Jarvis PM 在 Zulip 中能够：

- 对明确的多选信息收集请求生成原生可点击按钮，而不是纯文本选项。
- 点击一次后只提交一次答案，并删除或失效原按钮消息。
- 拒绝重复点击、重复命令和跨话题回答，不重复创建任务或继续执行。
- 正确解析带尾随说明文字的 `/codex` 命令。
- 查询后端实时状态，避免只复述过期的本地 `running` 登记。
- 在 PC 网页版和 Android App 中保持可用。
- 验证零 mention 默认发给 Jarvis，而 mention 其他人时不会隐式追加 Jarvis。

## 2. 测试环境与记录

- Zulip 频道：`量化交易`
- 测试话题：新建 `hermes-v019-interaction-YYYYMMDD-HHMM`
- 默认收件人 Bot：`Jarvis PM`；先确认 `default_addressee=self` 或精确匹配该 bot。
- PC：记录浏览器名称和版本。
- Android：记录 Zulip App 版本、Android 版本和设备型号。
- 每个用例记录：发送时间、请求消息 ID、按钮消息 ID、回复消息 ID、任务 ID、实际结果和截图。
- 测试只使用无副作用的示例内容；不要在本轮触发 SpecCompass 安装或真实项目修改。

### 2.1 自动化与人工验收边界

部署后先运行自动化合同和只读冒烟。自动化必须覆盖：零 mention 合成内部 self mention、只 mention 其他用户或用户组时忽略、显式 mention Jarvis 时放行、Jarvis 与其他用户同时被 mention 时只处理一次、`@all`/`@everyone` 语义、私聊不套用 stream 默认收件人，以及原始 Zulip message/event 不被就地修改。安装器还必须证明只有它管理的 `zulip-ingress` 启用默认收件人策略。

上述自动化通过不能代替 `PC-00` 的真实用户入站验收。`~/.zuliprc` 是 Jarvis bot 凭据，而 Zulip adapter 会忽略 bot 自己发送的消息；禁止用 bot API 自发消息冒充 Boss 的无 mention 对话。`PC-00` 必须由已登录的 Boss Web UI 或独立的人工测试账号发送，并用 API 只读回查。

每次部署生成独立结果目录，至少保存自动化命令状态、post-deploy smoke、当前 release、Gateway PID 和人工待测清单。本次部署结果见 [2026-07-29 default-addressee deployment](superpowers/test-artifacts/2026-07-29-default-addressee-deployment/test-result.md)。

2026-07-30 二次修复后的自动验证新增覆盖：每个按钮回复绑定唯一 `clarify_id`、两个客户端同时提交时只有一个原子结算成功、结算记录清理后 stale 回复仍被拦截、解析异常时 fail closed，以及 HCO 插件不把按钮回复创建为自然语言 Codex 请求。随后针对 Zulip 出站重复投递补充了非幂等发送保护：消息 POST 禁用 SDK 内部重试；POST 异常或 5xx 被明确标记为“结果可能已落地”，公共发送层不得重发原文、发送纯文本 fallback 或追加失败告警；明确的格式错误仍可安全降级。PC/Android 客户端的同步、实际显示与点击仍按本文人工复测。

## 3. PC 网页版

### PC-00 默认收件人与显式 mention

分别在至少两个频道、两个话题执行以下消息；mention 必须通过 Zulip 候选列表生成，并通过 API rendered HTML 确认真正的 `user-mention`：

1. 不 mention 任何人：`请只回复 DEFAULT-JARVIS-<RUN_ID>`。预期 Jarvis 回复一次。
2. 只 mention 一个非 Jarvis 用户：预期 Jarvis 不回复，且 Gateway 不创建对应 Hermes session。
3. mention 两个非 Jarvis 用户：预期同上，不隐式追加 Jarvis。
4. 显式 mention Jarvis：预期 Jarvis 回复一次。
5. 同时 mention Jarvis 和其他用户：预期 Jarvis 仍只回复一次。

API 回查必须同时保存原文和 rendered HTML。普通文本中的 `@名字` 不算 Zulip 原生 mention，不能用于第 2 至第 5 项。

人工执行时，每条消息使用不同的 `RUN_ID`，并至少等待 120 秒。第 2、3 项不仅要确认话题中没有 Jarvis 回复，还要确认 Gateway/Hermes 没有为该 source message 创建 session 或业务记录；仅凭“暂时没看到回复”不能判定通过。

### PC-01 三选一按钮生成

发送：

```text
我需要收集一个测试选择。请让我在“选项 A”“选项 B”“取消”三个选项中选择；这只是交互测试，不执行项目操作。
```

预期：

1. 回复中出现 Zulip 原生 zform 可点击按钮，按钮标签与选项完全一致。
2. 不得仅显示编号、项目符号或“请回复原文”。
3. 不得回复“当前没有 native clarify 工具”。

### PC-02 单击消费与按钮删除

在 `PC-01` 中单击“选项 A”。

预期：

1. 只出现一条确认回复，结果明确为“选项 A”。
2. 原按钮消息被删除；若 Zulip 客户端不支持即时删除刷新，刷新页面后必须消失。
3. 不创建 Codex objective，不启动项目工作。

### PC-03 重复点击与重放

操作：在点击前用两个浏览器标签同时打开该话题；标签一点击“选项 A”后，立即在标签二点击“选项 B”。如果第一个点击后按钮已从标签二同步消失，则记录为删除及时，无须人为构造内部 interaction/action ID。

预期：

1. 只有第一个合法选择被接受。
2. 后到选择必须收到固定提示：原选择已由另一客户端或标签页先行提交，提示包含首次选择和服务端记录时间；不得生成第二条普通确认。
3. 通过 Zulip API 回查两条 Boss 回复：二者携带相同 `clarify_id`、不同选项序号；不得把内部标识作为新的自然语言请求处理。
4. 不出现第二条继续执行记录，不产生 objective，不创建 HCO NLP capability，不重复执行 clarify 后续逻辑。
5. Gateway 日志不得出现第二条回复进入 `agent.turn_context`；结算状态以服务端首次写入为准，按钮删除速度不影响结果。
6. 首次选择续跑成功时只出现一条正常确认；若模型供应商失败，只允许出现一条固定失败告警。相隔约一秒的两条相同告警仍判定为投递失败，但不得误记为第二次选择结算或第二次 Agent/Codex 工作。

### PC-04 取消

重新发送 `PC-01` 请求并点击“取消”。

预期：按钮消息消失，只确认取消，不继续任何后续步骤。

### PC-05 命令尾随文本

先使用当前话题内一个已知 `work-request-...` ID 发送：

```text
/codex status <任务ID>
查询实际进度，并说明是否正在等待输入。
```

预期：

1. 命令被识别为 `STATUS`，不得返回 `Invalid /codex command` 或 `Codex bridge protocol error`。
2. 尾随中文作为查询说明处理，不进入任务 ID。
3. 回复包含 work 状态、active call/Agent 数量和下一动作。

随后对当前话题内一个已知 `objective-...` ID重复测试。预期返回 objective 执行状态和后端验证状态。不要用其他话题的 ID 做本用例；跨话题 ID只用于 `PC-07`。

### PC-06 过期 running 状态

对一个已持续运行较久的无副作用测试任务执行 `PC-05`，并准备以下任一种可核实后端事实：已完成、已失败、会话不存在或等待用户输入。

预期：回复以 App Server/持久化 submission 的实际状态为准；发现登记状态与后端不一致时明确说明正在协调或已协调，不得机械地只返回 `running`。

### PC-07 跨话题隔离

先在话题 A 创建一个 `work-request-...`，再到同频道话题 B 查询该 work；另用一个仍未处理的 HCO interaction 在话题 B 重放 `/codex interact <interactionId> <actionId>`。Hermes 原生 clarify zform 没有 HCO action ID，不要从 zform 按钮值伪造该命令。

预期：work 查询明确返回 topic/scope mismatch；interaction 因 stream/topic/sender 绑定不匹配而拒绝；不得返回 `Invalid /codex command`，不得新增 work/call/turn，原话题中的 interaction 保持可处理。

## 4. Android App

在同一测试话题重复 `PC-01`、`PC-02`、`PC-03`、`PC-04` 和 `PC-05`。

重点检查：

1. 三个按钮均可见、标签不截断，竖屏下不会互相遮挡。
2. 点击区域正确，不会误选相邻按钮。
3. 点击后有明确加载或结果反馈；网络较慢时连续点击仍只提交一次。
4. 返回频道列表再进入话题后，已处理按钮不会重新出现。
5. PC 与 Android 同时打开同一按钮消息，分别选择不同选项时只接受服务端先收到的一次；后到客户端显示“另一客户端或标签页已先行提交”的固定提示。
6. App 不支持 Zulip zform 时必须显示可执行的文本降级命令；不得显示看似可点但无响应的伪按钮。

## 5. 弱网与恢复

### NET-01 点击后断网

点击按钮后立即断开网络，恢复网络并重新进入话题。

预期：能够看到最终已接受或仍待回答的确定状态；不得因客户端重试产生两次回答。

### NET-02 服务重启后待处理选择

仅在维护窗口执行：创建选择后、点击前重启 Gateway/HCO/delivery，然后点击。

预期：Hermes 原生 clarify 不冒充持久化 HCO interaction。Gateway 重启后，旧按钮回复必须被判定为不再有效并在模型前拒绝，提示用户使用最新选择框；不得继续旧等待流程或创建新 turn。重新发起选择后仍只接受一次。

## 6. Agent/Codex 分层汇报

以下用例使用只读检查任务，不修改项目文件。每次记录 Zulip 消息 ID、`workRequestId`、`codexCallId` 和 Agent 角色。

### COORD-01 Jarvis 与 Agent 并行调用

让 Jarvis 委派一个 Agent 检查测试目录，同时由 Jarvis 自己调用 Codex 检查 package scripts。

预期：两个 Codex 调用拥有不同 `codexCallId`；结果分别先回到原调用者，Zulip 中不直接出现 Agent/Jarvis 调用的原始 Codex 完成消息；最终只由 Jarvis 给 Boss 一次综合答复。

### COORD-02 单个 Agent 多次调用

让一个 Agent 分别调用 Codex 检查两项独立的只读事实。

预期：同一 Hermes turn 最多允许 8 次调用；两次调用使用不同 token、conversation/call ID，乱序完成也都回到同一 Agent，不进入其他 Agent 或直接进入 Zulip。

### COORD-03 Agent 等待 Codex

让 Agent 启动一个需要数十秒的只读 Codex 检查，并在结果返回前结束当前子 Agent 执行；随后查询 `workRequestId`。

预期：Agent 和 work 明确显示 `WAITING_CODEX`，原因是 `agent_waiting_codex`，不得显示普通 `RUNNING` 或错误地标记完成。Codex 结果进入 Hermes durable mailbox 后，准确唤醒该 Agent；Agent 再报告后变为 `REPORTED` 或 `FAILED`。

### COORD-04 嵌套 Agent 汇报

让 Agent A 委派 Agent B，Agent B 调用 Codex 并完成报告。

预期：Codex 原始结果只回 Agent B；Agent B 的结构化报告只回 Agent A；Agent A 检查后再向 Jarvis 报告；Jarvis 最终向 Boss 回复。任一层不得跳过父级直接发送原始结果。

### COORD-05 话题隔离

在同一频道两个话题同时启动只读任务，并尝试在话题 B 查询或继续话题 A 的 objective/work。

预期：两个话题拥有独立主 Codex conversation；跨话题继续返回 scope mismatch，不产生新 turn；频道项目和 canonical cwd 保持相同且不被 topic 覆盖。

### COORD-06 未跟踪 Agent 兜底

让一个不调用 Codex 的 Agent 完成普通 Hermes 工作。

预期：父级仍通过 Hermes 原生子 Agent 汇报收到结果；HCO 将 stop 事件明确视为 `UNTRACKED`，不伪造 work/Agent scope，也不影响父级继续处理。

## 7. 通过标准

- `PC-01` 至 `PC-07` 全部通过。
- Android 第 4 节六项全部通过；不支持 zform 的客户端按明确文本降级路径通过。
- 没有重复 objective、重复 turn、重复 interaction response 或重复 Zulip 确认消息。
- 状态查询与 App Server/持久化记录一致。
- 任一重复执行、跨话题越权、按钮无法消失或过期状态误报均判定为失败，不以刷新或人工删除规避。
- `COORD-01` 至 `COORD-06` 不得出现错误调用者、错误父级、原始结果越级发送或 Agent 长期停留在无原因的 `RUNNING`。

## 8. 失败时提交的信息

提供用例编号、客户端版本、发生时间、频道/话题、相关 Zulip 消息 ID、任务 ID、截图和复现步骤。不要提供 API key、bearer、完整日志或按钮内部签名 token。
