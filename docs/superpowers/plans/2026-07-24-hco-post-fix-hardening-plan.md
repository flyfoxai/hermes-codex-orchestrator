# HCO Fix2 后续完善工作计划

## 1. 文档信息

- 日期：2026-07-24
- 仓库：`/Users/hula/Projects/hermes-codex-orchestrator`
- 状态：三方计划审核通过，进入实施阶段
- 前置结果：Fix2 自动测试和人工复测已覆盖未映射 stream、PROJECT stream、Markdown 安全、用户错误分类、bridge 写入不确定性及 interactionId 校验等核心修复。
- 当前人工测试结论：`G-01A`、`G-05`、`G-06A`、`U-01`、`U-02` 通过；`G-01B` 因生产 route snapshot 中没有显式 `owner=HERMES` 的隔离 stream 而保持 `BLOCKED`。
- 相关证据：
  - `docs/superpowers/test-artifacts/2026-07-23-hco-fix2-post-fix-manual/manual-retest-result.md`
  - `docs/superpowers/test-artifacts/2026-07-23-hco-fix2-post-fix-manual/g01a-audit-retest-requirements.md`
  - `docs/superpowers/test-artifacts/2026-07-23-hco-fix2-post-fix-api/result.json`

## 2. 当前基线与问题判断

### 2.1 已确认正常的能力

1. 未映射 stream 上的 `/codex` 命令由 Hermes 插件本地终止，返回登记提示，不进入 HCO。
2. PROJECT stream 能正确路由到指定 `projectId` 和 canonical 工作目录。
3. gateway 本地路由决策已有同步、脱敏的结构化审计记录。
4. 正常标识符不会被 Markdown 转义破坏，输出已单行化并防护危险 Markdown/HTML 字符。
5. bridge 的“未写入”和“可能已写入”错误已区分，避免不确定状态下盲目重试。
6. interaction 回答、用户错误分类、CWD containment 和 URL 百分号解码已有自动测试覆盖。
7. 当前自动门禁基线为 Python `316 passed`、Node `273 passed`、installer `32/32`、真实 Zulip API `13/13 PASS`。

### 2.2 仍需完善的问题

1. **显式 HERMES 路由缺少安全测试条件。** 这是环境前置条件缺失，不等于路由实现已发现缺陷；当前不能通过修改正在使用的生产 route 来制造测试条件。
2. **部署成功的证据分散。** stable symlink、release 内容、gateway PID、attestation、route snapshot 和三个服务状态需要人工拼接，容易出现“源码已更新但运行 gateway 仍加载旧 release”的误判或漏判。
3. **审计记录不便可靠检索。** 当前事件写入 gateway stderr；历史日志可能含 NUL 字节，普通文本检索工具会将其识别为二进制文件。
4. **端到端关联诊断成本高。** 目前需分别查询 gateway 日志和 HCO 多张表，才能判断消息停在 gateway、HCO 接收、objective 创建、turn 提交或 outbox 投递中的哪一层。
5. **部署后冒烟仍依赖多份脚本和人工拼接。** API、route、运行态、审计和 HCO 零派发断言未形成统一、脱敏、机器可读的结果工件。
6. **长任务用户体验仍可改进。** G-06A 从提交到结果约 165 秒，固定短等待窗口容易被误判为失败，并诱导重复提交。
7. **浏览器自动化成熟度有限。** 文本形式的 `@Jarvis PM` 不一定形成真实 mention，自动化可能误选发送者或错误标签页；UI 成功也不能代替 API、gateway 和 HCO 证据。
8. **route generation 容易被误解。** generation 增加不必然代表路由语义改变，缺少稳定的 semantic hash 和部署前后语义 diff。

## 3. 总体目标

1. 建立可重复、可审计、失败即停止的部署一致性门禁。
2. 建立安全、脱敏、可可靠检索的 gateway 本地路由审计通道。
3. 提供以 Zulip `sourceMessageId` 为入口的只读链路诊断工具。
4. 整合部署后自动冒烟，明确 API 可自动化范围和浏览器人工边界。
5. 为显式 HERMES route 提供不污染生产项目的测试方案和配置前置检查。
6. 降低长任务被误判、重复提交和运维排查的概率。
7. 保持现有安全边界、路由语义和兼容性，不扩大插件权限，不记录消息正文或秘密。

## 4. 非目标

1. 不为测试擅自修改当前生产 stream 的 owner、projectId 或 topic mode。
2. 不在本轮引入新的远程日志平台、监控 SaaS 或外部数据库。
3. 不修改 Codex App Server 协议或 Zulip 服务端行为。
4. 不把所有 UI 测试改造成浏览器自动化；只自动化稳定且可安全判定的部分。
5. 不重构与本计划无关的 HCO 状态机、delivery 机制或 installer 事务框架。
6. 不记录 Zulip topic 正文、命令正文、CWD、token、HMAC、bearer、cookie、秘密答案或完整用户消息。

## 5. 安全与变更边界

### 5.1 必须保持的约束

1. route authority 仍只来自数字 stream ID 和经过完整性校验的新鲜 route snapshot。
2. 未映射 route 必须在 gateway 本地终止，不能创建 HCO inbound、objective、turn submission 或 outbox。
3. 显式 `owner=HERMES` route 上的普通消息必须交给 Hermes 原流程；显式 `/codex` 命令仍必须签名进入 HCO，并由 HCO 返回 `ROUTE_HERMES_OWNED` 等安全结果，不能被普通 Hermes 分支吞掉。
4. `owner=PROJECT` route 只能使用配置中的 canonical project CWD，不能由消息正文、topic、模型推断或当前进程 CWD 决定。
5. 所有新增文件必须为当前用户所有；包含运行态或审计信息的文件权限不得宽于 `0600`，目录不得宽于 `0700`。
6. 只读诊断不得改变 route、objective、interaction、outbox 或服务状态。
7. 任何无法证明运行 gateway 已加载目标 release 的安装必须失败并触发现有回滚路径。

### 5.2 兼容性要求

1. 保留现有 stderr 审计输出至少一个兼容周期，避免现有日志采集失效。
2. 新增审计文件失败时的策略必须显式：关键本地终止决策无法落审计时 fail closed；非本地终止路径不得因可选诊断工具失败而改变路由结果。
3. 不改变现有 route snapshot schema 的必填字段；新增 semantic hash 时优先放入部署结果工件，由读取方计算，避免未经迁移直接更改生产 schema。
4. 新增 CLI/脚本默认只读，输出默认脱敏，JSON 输出结构带 `schemaVersion`。

## 6. 分阶段实施方案

## 阶段 A：部署一致性门禁与结果工件（P0）

### A1. 明确安装生命周期

1. 以 `scripts/install-hermes-codex-bridge.sh` 的现有事务为准，记录以下顺序：release staging、stable symlink 激活、HCO 重启与 readiness、gateway `kickstart -k`、attestation 校验、delivery 启动、迁移提交。
2. 不另写第二套服务重启逻辑；新增校验嵌入现有事务和回滚边界。
3. 将“安装文件成功”和“运行 gateway 已加载新 release”视为两个独立条件，二者都满足才允许提交事务。

### A2. 新增部署 manifest

候选实现位置：

- `scripts/install-hermes-codex-bridge.sh`
- installer 内嵌 Python 的独立纯函数和原子写入逻辑
- `test/install-hermes-codex-bridge.test.sh`

manifest 建议字段：

1. `schemaVersion`
2. `installedAtMs`
3. `pluginVersion`
4. `releasePath`
5. `releaseManifestSha256`
6. `sourceManifestSha256`
7. `stableSymlinkTarget`
8. `gatewayPidBefore`、`gatewayPidAfter`
9. `gatewayAttestation` 的安全字段：schema、PID、pluginPath、pluginVersion、hook、ingressProfile
10. HCO、delivery、gateway 的 loaded/running 状态
11. route snapshot generation、computed semantic hash、语义是否变化
12. 安装事务结果：`COMMITTED` 或不落正式成功 manifest

约束：

- manifest 不包含配置正文、route HMAC、token 路径内容、CWD、用户消息或秘密。
- 使用临时文件、`fsync`、`os.replace` 和 `0600` 权限原子写入。
- manifest 只在所有服务和 attestation 校验通过后写入；回滚或失败不得留下“成功”结果。

### A3. 强化运行 release 校验

1. 校验 stable symlink 实际指向目标 release。
2. 校验目标 release 的 installer-owned manifest 和逐文件 hash。
3. 校验 repository source manifest 与 staged/release manifest 一致。
4. 校验 gateway attestation 的 PID 等于 launchd 当前 PID。
5. 校验 attestation `pluginPath` resolve 后等于目标 release，而不是 stable symlink 或旧 release。
6. 校验 attestation `pluginVersion` 和 installer 目标版本一致。
7. 在短稳定窗口后重新读取 PID 和 attestation，防止校验期间进程再次退出或被替换。
8. 任一条件失败时沿用现有回滚，不启动 delivery 消费新 outbox。

### A4. route 语义摘要

1. 对 route snapshot 读取后提取与路由相关的稳定字段，按 stream ID 排序并 canonical JSON 序列化。
2. 计算 SHA-256 semantic hash，排除 generation、generatedAt、signature 等非语义字段。
3. manifest 同时保存部署前后 generation 和 semantic hash。
4. 结果分类：
   - generation 不变、semantic hash 不变：`UNCHANGED`
   - generation 变化、semantic hash 不变：`REISSUED_EQUIVALENT`
   - semantic hash 变化：`SEMANTIC_CHANGED`
5. 不在安装器中自动批准语义变化；只忠实记录和输出。

### A5. 阶段 A 验收

1. installer 正常路径生成一份权限为 `0600` 的成功 manifest。
2. 模拟旧 attestation、错误 PID、错误 pluginPath、release 内容篡改、stable 指向错误目标时安装失败并回滚。
3. 模拟 generation 改变但 route 内容不变时标记 `REISSUED_EQUIVALENT`。
4. 模拟 route owner/projectId 改变时标记 `SEMANTIC_CHANGED`。
5. manifest 不含已定义的敏感字段和生产正文。

## 阶段 B：可靠的本地路由审计（P0/P1）

### B1. 审计 sink 设计

候选实现位置：

- `plugin/hermes-codex-bridge/plugin.py`
- installer 生成的插件环境配置
- `test/hermes_plugin_contract_test.py`
- `docs/OPERATIONS.md`

设计要求：

1. 新增 owner-only JSONL 文件，例如 Hermes home 下固定的 bridge audit 路径；路径由受限配置或固定安全位置决定，不接受消息输入。
2. 每条记录保持单行 canonical JSON，带 `schemaVersion`、事件名、时间、sender/stream/message 数字标识、commandType、resultCode、topic 字节数和 topic SHA-256。
3. 不写 topic 正文、命令正文、CWD、项目 instruction、token 或用户回答。
4. 使用 `O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW`，验证 regular file、owner UID 和 mode，避免 symlink/hardlink/权限放宽问题。
5. 单条记录必须在一次受锁保护的写循环中完整写入并同步；不得出现部分 JSON 被当作成功。
6. stderr 保持兼容输出；独立 sink 是可检索的权威证据。
7. 本地终止决策若 sink 写入失败，返回安全、泛化的内部错误，不继续向 HCO 派发；PROJECT/HERMES 正常转交路径不因“没有本地终止审计事件”而改变。

### B2. 轮转与边界

1. 插件不实现复杂后台日志轮转器；优先由受控运维脚本或服务启动前检查完成大小轮转。
2. 定义最大保留大小、最多文件数和 owner-only 权限。
3. 轮转不得跟随 symlink，不得覆盖非 regular file，不得跨文件系统做非原子替换。
4. 如果本轮实现轮转风险过高，先实现可靠 sink 和只读查询，把自动轮转列为后续独立变更；不得用不安全的简化轮转阻塞核心审计落地。

### B3. 审计查询工具

新增候选脚本：`scripts/query-hermes-route-audit.py`

功能：

1. 必填 `--source-message-id`；可选 `--stream-id`、`--result-code`、`--json`。
2. 二进制安全逐行读取，不受历史 gateway 日志 NUL 字节影响。
3. 拒绝 symlink、非 owner 文件和权限过宽的审计文件。
4. 对 malformed JSON 行报告计数但不回显原始行。
5. 默认输出匹配数量和安全字段；退出码区分“唯一命中”“无命中”“多命中”“审计文件不可信”。

### B4. 阶段 B 验收

1. 未映射 `/codex run` 产生且只产生一条可查询审计事件。
2. 审计文件含 NUL 或 malformed 行时查询工具仍能定位后续合法记录并报告异常计数。
3. symlink、其他用户 owner 或 group/world-readable 文件被拒绝。
4. sink 写失败时未映射命令不进入 HCO，并返回不含内部路径的泛化错误。
5. 单元测试扫描记录，确认不含敏感字段和输入正文。

## 阶段 C：以 sourceMessageId 为入口的链路诊断（P1）

### C1. 诊断模型

新增候选脚本：`scripts/trace-zulip-message.py`

只读汇总以下层次：

1. gateway local route audit
2. HCO inbound intent
3. objective
4. turn submission
5. Zulip outbox
6. 已知 reply message ID 或 delivery 状态

每层输出：`FOUND`、`NOT_FOUND`、`NOT_APPLICABLE`、`AMBIGUOUS`、`ERROR`。

### C2. 关联原则

1. 优先复用数据库已有的 source message 绑定和外键，不为诊断工具修改业务状态。
2. 若当前 schema 无法直接关联 reply ID，先输出“outbox 已创建/已发送但 reply ID 不可用”，不得通过正文模糊匹配。
3. 如确需新增持久字段，必须通过 `hco/state/migrations.js` 正式迁移，并更新 reducer/store/contract 测试；不得临时解析日志代替数据库事实。
4. 未映射 route 的期望终点是 gateway：audit `FOUND`，HCO 各层 `NOT_APPLICABLE`。
5. 显式 HERMES route 必须按消息类型区分：普通消息的期望终点是 Hermes，HCO 各层 `NOT_APPLICABLE`；显式 `/codex` 命令的期望链路包含 HCO inbound，并应得到 `ROUTE_HERMES_OWNED` 安全结果，不能误报为 gateway 丢消息。
6. PROJECT route 的期望链路是 inbound → objective/turn → outbox/delivery；在哪一层首次缺失即标记 stop point。

### C3. 输出与隐私

1. 支持人读文本和 `--json`。
2. 只输出 ID、状态、时间、result code、projectId 等安全元数据。
3. 默认不输出 instruction、topic 正文、rendered content、CWD 或错误堆栈中的秘密。
4. 数据库和 audit 文件均以只读模式打开。

### C4. 阶段 C 验收

1. 用 message `542` 的脱敏 fixture 验证终点为 gateway，HCO 零派发。
2. 用 PROJECT route fixture 验证完整链路和 stop point。
3. 用重复/冲突记录 fixture 验证 `AMBIGUOUS`，不擅自选择一条。
4. 运行工具前后数据库文件 hash、行计数和 mtime 不因工具自身改变。

## 阶段 D：统一部署后冒烟（P1）

### D1. 自动化入口

整合候选文件：

- `scripts/hco-fix2-automated-acceptance.sh`
- `scripts/hco-fix2-api-acceptance.py`
- 可新增 `scripts/hco-post-deploy-smoke.sh`

自动部分：

1. 校验部署 manifest、stable symlink、attestation、gateway/HCO/delivery 状态。
2. 校验 route snapshot 签名、新鲜度、generation 和 semantic hash。
3. 选择已明确授权的测试 stream，不从名称或 topic 猜测 route。
4. API 发送唯一 RUN_ID/topic 的安全消息并回读 rendered HTML。
5. 未映射 route：登记提示、唯一 gateway audit、HCO 零派发。
6. PROJECT route：HCO 入站、正确 projectId、只读任务结果、标识符保真。
7. 显式 HERMES route：仅在 preflight 找到明确授权的隔离 stream 时发送 `/codex status`；断言命令进入 HCO 并返回 `ROUTE_HERMES_OWNED` 安全提示，不能被普通 Hermes 回复吞掉。没有隔离 stream 时状态为 `BLOCKED_PRECONDITION`，不得修改 route。
8. 输出统一 JSON 和 Markdown 报告，不写 Zulip 凭据。

### D2. UI/人工边界

仍需人工或浏览器验证的项目：

1. 真实登录用户在 Zulip Web UI 的 mention 选择体验。
2. UI 中回复线程、topic 和发送者的视觉正确性。
3. 必须通过 API 回读确认 rendered HTML 含 `class="user-mention"`，不能只凭浏览器显示或自动化成功返回。
4. 单标签、固定 stream、固定 topic、唯一 RUN_ID；不得误选 `boss` 作为 mention 目标。

### D3. 安全护栏

1. 默认为 dry-run/preflight；发送真实消息需要显式 `--send`。
2. PROJECT 用例只允许只读 instruction，并在发送前进行允许列表校验。
3. 每轮限制消息数量，失败后不自动重试不确定写入。
4. 发现 route、PID、attestation 或服务状态在测试期间变化时立即停止。
5. 报告记录 message ID 和 hash，不记录凭据。

### D4. 阶段 D 验收

1. 无 `--send` 时不产生 Zulip 消息、不写 HCO 业务数据。
2. preflight 能准确区分未映射、PROJECT、显式 HERMES 和没有测试条件。
3. API 发送失败、bridge uncertain、回复超时和审计缺失分别给出不同结果码。
4. 重复运行使用不同 RUN_ID，不把历史消息误判为当前结果。

## 阶段 E：长任务状态与超时体验（P1/P2）

### E1. 先做协议与现状审计

1. 检查当前 objective 创建回复、turn 状态查询和 final outbox 语义。
2. 优先复用已有 objective ID 和 `/codex status`，避免增加数据库状态或高频状态消息。
3. 明确“提交已确认”和“执行完成”是两个不同的等待条件。

### E2. 最小改进方案

1. 提交成功后立即给出 objective ID 和明确提示：“已提交，执行可能需要数分钟；请用 status 查询，未确认失败前不要重复 run”。
2. 自动测试等待策略改为分阶段超时：短窗口等提交确认，长窗口轮询 objective/outbox 状态。
3. `BridgeUncertainError` 始终提示先查状态，不自动重发。
4. 默认不发送周期性“仍在运行”消息，避免刷屏；如后续需要进度消息，应另行设计节流和幂等键。

### E3. 阶段 E 验收

1. 165 秒级任务不会在 30 秒时被报告为功能失败。
2. 用户能从首条确认中获得 objective ID 和下一步查询命令。
3. 同一 source message 不因测试 runner 超时自动创建第二个 objective。
4. 现有 final delivery once、restart reconciliation 和 uncertain write 测试继续通过。

## 阶段 F：G-01B 隔离测试条件（P0 环境工作）

### F1. 首选方案

1. 由运维在非项目生产用途的专用 stream 中配置显式 `owner=HERMES` route。
2. stream 必须隔离、可清理、无真实项目任务，不复用当前 PROJECT stream。
3. 变更前后保存 route snapshot generation 和 semantic hash，并经过现有签名/发布流程。
4. 测试只发送一条带唯一 RUN_ID 的只读命令。

### F2. 无法创建生产隔离 stream 时

1. 在受控测试环境使用独立 route/config fixture 和 Zulip 测试组织。
2. 自动 contract 测试分别覆盖：普通消息切换到 `hermes-general`；`/codex` 命令改写为签名 HCO token，并由 HCO route policy 返回 `ROUTE_HERMES_OWNED`。
3. 真实生产结论保持 `BLOCKED_PRECONDITION`，不得用 fixture 冒充生产 E2E PASS。

### F3. G-01B 验收证据

1. Zulip 入站 message ID、时间、stream ID、topic 和 rendered mention HTML。
2. gateway 未将 `/codex` 命令交给普通 Hermes 回复的证据。
3. HCO 收到该命令并返回 `ROUTE_HERMES_OWNED` 对应的安全用户提示；不得创建项目 objective、turn submission 或项目执行 outbox。
4. route snapshot 明确显示该 stream 为 `owner=HERMES`。
5. 测试前后 route 语义除预先批准的隔离 stream 外无变化。

## 阶段 G：浏览器自动化操作规范（P2）

1. 将现有浏览器操作手册固化为 preflight 清单：账号、活动标签、stream、topic、mention 目标和 API 可读性。
2. 发送文本必须使用 Zulip 可识别的 mention 操作；记录原始输入仅作辅助，最终以 API rendered HTML 为准。
3. 发送后立即记录 message ID，不用屏幕文本相似度寻找消息。
4. UI 自动化仅判定“操作是否完成”；路由和业务结论由 API、audit、HCO 数据共同决定。
5. 失败分类至少区分：UI 操作失败、非真实 mention、gateway 未消费、route 终止、HCO 未接收、任务仍运行、delivery 未完成。

## 7. 预计文件变更

以下为候选范围，实施时应以最小改动为原则：

1. `scripts/install-hermes-codex-bridge.sh`：部署 manifest、route semantic hash、最终一致性门禁。
2. `plugin/hermes-codex-bridge/plugin.py`：独立 audit sink 和 fail-closed 行为。
3. `scripts/query-hermes-route-audit.py`：只读审计查询。
4. `scripts/trace-zulip-message.py`：只读端到端关联诊断。
5. `scripts/hco-fix2-automated-acceptance.sh`：统一调用和报告整合。
6. `scripts/hco-fix2-api-acceptance.py`：保留 Markdown/API 用例，增加显式发送护栏和结构化结果码。
7. `test/install-hermes-codex-bridge.test.sh`：部署一致性和回滚测试。
8. `test/hermes_plugin_contract_test.py`：audit sink、安全文件和 HERMES/未映射 route 测试。
9. HCO state/store 测试：仅在诊断关联确实需要 schema 变更时修改。
10. `docs/OPERATIONS.md`：部署校验、审计查询、链路诊断、冒烟和回滚操作。
11. `docs/superpowers/test-artifacts/2026-07-24-hco-hardening-review/`：三方审核和测试工件。

## 8. 测试矩阵

### 8.1 静态与单元测试

1. Python syntax/pytest：插件、delivery、审计查询、诊断脚本。
2. Node syntax/node:test：HCO service、state、runtime、renderer、turn controller。
3. Shell installer 测试：正常安装、失败回滚、旧 release、错误 attestation、PID 变化、manifest 原子性、semantic diff。
4. `git diff --check`。

### 8.2 安全测试

1. audit/manifest 路径为 symlink、FIFO、directory、其他用户 owner、权限过宽。
2. NUL、malformed JSON、超长行、重复记录和部分写入。
3. 审计内容秘密扫描：token、authorization、cookie、HMAC、secret answer、topic/command/CWD 正文。
4. sourceMessageId、streamId 的类型和边界校验。
5. 查询和 trace 工具确认只读，不更改数据库或 route 文件。

### 8.3 集成测试

1. installer fixture 中 gateway kickstart 后加载目标 release。
2. attestation 与 launchd PID 稳定窗口。
3. 未映射 route 的 audit + HCO 零派发。
4. PROJECT route 的完整链路。
5. 显式 HERMES fixture 中普通消息归 Hermes，而 `/codex` 命令进入 HCO 并返回 `ROUTE_HERMES_OWNED`。
6. bridge unavailable/uncertain 不同用户提示。
7. 长任务分阶段等待不自动重复提交。

### 8.4 真实 Zulip 测试

1. API Markdown/HTML 安全用例。
2. 未映射 stream G-01A 快速冒烟。
3. PROJECT stream 只读冒烟。
4. 显式 HERMES stream G-01B：仅在隔离前置条件存在时执行。
5. UI mention：人工发送，API 回读确认 `user-mention`。

## 9. 验收标准

全部满足才视为本计划完成：

1. Claude、Gemini、Codex 对本计划均明确 `APPROVE`，无 blocking issue。
2. 实施变更通过新增的最窄测试。
3. Python 全量、Node 全量、installer 全量和 `git diff --check` 通过。
4. 部署一致性 manifest 能证明运行 gateway 加载目标 release。
5. 审计查询对指定 sourceMessageId 可稳定给出唯一结论，不依赖 grep/rg 处理混合日志。
6. trace 工具能明确消息停止层，且不输出正文或秘密。
7. 自动冒烟 dry-run 不产生外部副作用，真实发送必须显式授权。
8. G-01B 若具备隔离环境则 PASS；若仍无环境，只允许标记 `BLOCKED_PRECONDITION`，不能伪造 PASS，也不阻塞代码完善项的完成判定。
9. Claude、Gemini 对实际 diff、测试结果和安全边界再次明确 `APPROVE`，Codex 复核无异议。

## 10. 回滚策略

1. installer 变更必须复用现有事务快照和服务回滚，不创建不可逆迁移。
2. 新 audit sink 可通过恢复旧插件 release 回滚；保留 stderr 输出保证观测兼容。
3. 新 manifest、查询和 trace 工具均为附加能力，不应成为旧 release 启动的硬依赖。
4. 如新增 HCO schema 字段，迁移必须向前兼容旧行，回滚不得删除历史业务数据；若无法保证，取消 schema 变更并降低诊断粒度。
5. route 变更不由代码部署自动完成；G-01B 隔离 stream 由独立、审批后的运维操作回滚。

## 11. 实施顺序与停止条件

1. 三方审核计划；存在 blocking issue 时只修订计划，不实施。
2. 先完成阶段 A、B，因为它们为后续部署和测试提供可信证据。
3. 再完成阶段 C、D，优先用现有 schema，不为“完美追踪”过度迁移。
4. 阶段 E 仅实施最小用户体验改进，不引入周期性刷屏。
5. 阶段 F 只准备和验证前置条件，不擅自修改生产 route。
6. 每个阶段先跑最窄测试；失败时停止进入下一阶段，修复后重跑。
7. 全量测试通过后，Claude、Gemini 审核实际 diff 和测试工件。
8. 任一审核方提出 blocking issue，Codex 复核后修复并重新测试、重新审核。
9. 仅当三方均无 blocking issue，才更新本计划状态为“完成”。

## 12. 三方审核规则

每轮审核必须输出：

1. `verdict`: `APPROVE` 或 `CHANGES_REQUIRED`
2. `blockingIssues`: 会导致安全、正确性、数据损坏、不可回滚、错误测试结论或明显缺失目标的问题
3. `nonBlockingSuggestions`: 可延期或不影响验收的优化
4. `securityReview`
5. `reliabilityReview`
6. `testCoverageReview`
7. `exactEdits`: 针对文档或实现的具体修改建议

审核原则：

- 不以“增加更多功能”为由无限扩大范围。
- G-01B 环境前置条件缺失可保持 blocked，不应要求未经批准修改生产 route。
- 对安全、部署一致性、审计完整性和不确定写入采取高标准。
- 对非阻塞体验优化允许明确延期，但必须记录剩余风险。

## 13. 审核记录

| 轮次 | 审核对象 | Claude | Gemini | Codex | 结论 |
|---|---|---|---|---|---|
| 1 | 计划初稿 | APPROVE | APPROVE | CHANGES_REQUIRED | Codex 实施核对发现显式 HERMES `/codex` 路由语义写反 |
| 2 | 修订计划 | APPROVE | APPROVE | APPROVE | 三方计划审核通过；无 blocking issue |
| 3 | 实际实现初审 | APPROVE | 调用故障，无有效结论 | APPROVE | 采纳 Claude 非阻塞建议后继续复审 |
| 4 | 实际实现终审 | APPROVE | APPROVE | APPROVE | 三方一致通过；无 blocking issue、无剩余建议 |

原始审核工件保存目录：

`docs/superpowers/test-artifacts/2026-07-24-hco-hardening-review/`

### 13.1 已采纳的非阻塞建议

1. 初版不实现复杂后台日志轮转器；先完成安全 sink、大小边界和运维轮转指引。
2. trace 无法从现有 schema 取得 reply ID 时明确报告不可用，不为诊断强制迁移。
3. 长任务只做提交确认、objectiveId 和分阶段等待提示，不增加周期性进度消息。
4. route semantic hash 明确排除 generation、generatedAt、signature、expiresAt、ttlMs 等非语义字段。
5. `docs/OPERATIONS.md` 增加审计文件轮转和旧 release/临时工件清理指引，但不自动删除未确认安全的历史文件。

### 13.2 审核工件

- `claude-plan-review-round1.json`：Claude CLI 原始包装结果
- `claude-plan-review-round1-normalized.json`：Claude 结构化审核内容
- `gemini-plan-review-round1.json`：Gemini 首次 CLI 故障工件，返回 `INVALID_STREAM`，不视为审核结论
- `gemini-plan-review-round1-retry.json`：Gemini CLI 重试原始包装结果
- `gemini-plan-review-round1-normalized.json`：Gemini 结构化审核内容

### 13.3 实现终审结论

1. Claude 最终结论：`APPROVE`，`blockingIssues=[]`，`nonBlockingSuggestions=[]`。
2. Gemini 最终结论：`APPROVE`，`blockingIssues=[]`，`nonBlockingSuggestions=[]`。
3. Codex 独立核对实际 diff、安全边界、路由语义、事务回滚和测试结果后结论：`APPROVE`。
4. Python 全量：397 passed。
5. installer：32/32 PASS。
6. Node 全量：273/273 PASS。
7. `npm run check`、`npm run verify`、`git diff --check`：PASS。
8. G-01B 因当前没有显式 HERMES 隔离 stream，保持 `BLOCKED_PRECONDITION`；这是环境前置条件，不伪造真实 E2E PASS，也不影响本轮代码完善项验收。

实现审核原始工件：

- `claude-implementation-review-round1.json`
- `claude-implementation-review-round2.json`
- `claude-implementation-review-round3.json`
- `gemini-implementation-review-round1.json`：代理重试中断，无审核结论
- `gemini-implementation-review-round2.json`：`INVALID_STREAM`，无审核结论
- `gemini-implementation-review-round3.json`：最终有效审核结论
