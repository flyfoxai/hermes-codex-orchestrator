# HCO 修复结果 2：人工验收测试方案

**日期**: 2026-07-22  
**状态**: 待执行  
**目标**: 对“修复结果 2”的 10 项变更做真实 Zulip、隔离故障注入、跨平台和安装事务人工验收。  
**判定原则**: 任何安全边界、重复提交风险、错误提示语义或跨项目 containment 失败均阻断发布。

---

## 1. 验收范围

本方案覆盖以下修复：

1. `writer.write()` 返回后立即进入 uncertain 边界；`drain()` 失败不得报告为未提交。
2. Markdown 防护不得破坏 `obj-1`、`LIVE-POSTFIX.S-001` 等正常标识符。
3. Markdown 输出折叠为单行，并防护 `<`、`>`、`|`、提及、链接和格式注入。
4. `INTERACTION_SECRET_ANSWER_FORBIDDEN` 作为用户可见错误返回。
5. `BridgeUnavailableError` 与 `BridgeUncertainError` 提示和重试建议严格分离。
6. partial answer 的 `interactionId` 只有通过 CLI token 校验时才展示命令。
7. 所有 `BridgeUserError` 文本在返回 Zulip 前统一安全编码。
8. containment 检测对 URL 百分号编码执行一次解码，`%62eta` 不得绕过 `beta`。
9. macOS/Windows CWD containment 大小写不敏感；相关业务错误使用 `stateError` 并进入 Python 用户错误白名单。
10. 仓库和安装产物不再跟踪 Python 字节码；installer 测试不依赖 `rg`。

不在本轮范围内：扩大 Zulip ACL、伪造授权用户、改变 route snapshot、修改生产项目映射、验证与本轮无关的模型质量。

---

## 2. 测试角色与环境

### 2.1 必需角色

| 角色 | 要求 | 用途 |
|---|---|---|
| `OPERATOR` | 可查看服务状态、日志和测试实例配置 | 基线、故障注入、证据收集 |
| `AUTHORIZED_USER` | 已在测试项目 ACL 中合法授权的真人 Zulip 用户 | 真实入站命令和任务验收 |
| `UNAUTHORIZED_USER` | 不在测试项目 ACL 中的测试账号 | ACL 和用户错误验证 |
| `SEND_ONLY_BOT` | 仅用于 Zulip API 出站和渲染回读 | Markdown、单行化、消息 ID 证据 |

禁止把 bot 加入项目 ACL 只为使测试通过，禁止复用或伪造其他用户会话。

### 2.2 测试目标

- 优先 stream：`沙箱` 或专用测试 stream。
- topic：`hco-fix2-manual-<YYYYMMDD-HHMMSS>`。
- 真实项目执行必须使用专用测试项目和可回滚工作目录。
- unavailable/uncertain 故障注入必须在隔离 HCO/bridge 实例执行，不直接破坏生产 socket。

### 2.3 统一测试变量

```bash
export RUN_ID="HCO-FIX2-MANUAL-$(date +%Y%m%d-%H%M%S)"
export TEST_STREAM="沙箱"
export TEST_TOPIC="hco-fix2-manual-${RUN_ID#HCO-FIX2-MANUAL-}"
export REPO="/Users/hula/Projects/hermes-codex-orchestrator"
export PYTHON="/Users/hula/Projects/hermesAgent/.venv/bin/python3"
```

不得把 API key、bearer、HMAC key、完整 `.env` 或 signed context token 写入记录。敏感值统一记为 `***MASKED***`。

---

## 3. 证据和通过标准

每个用例至少记录：

- 用例 ID、执行者、开始和结束时间。
- release 或工作区 commit/hash；若有未提交变更，记录 `git diff --stat`。
- Gateway、HCO、delivery PID；隔离实例另记 socket 和临时目录。
- Zulip stream ID、topic、入站 message ID、回复 message ID。
- API 回读的原始内容摘要和服务端渲染 HTML 检查结果。
- HCO durable objective/interaction/outbox 状态摘要，不记录 prompt 或秘密答案。
- PASS/FAIL、实际结果、偏差和清理结果。

统一判定：

- **PASS**：实际结果与全部预期一致，且无秘密泄漏、无重复 objective/turn、无跨项目状态变化。
- **FAIL**：任一安全断言失败、无法取得必要证据、出现无法解释的重复消息或状态写入。
- **BLOCKED**：测试环境缺少合法账号、平台或隔离能力；不得用降低安全要求的方式改成 PASS。

---

## 4. 阶段 A：执行前基线

### A-01 工作区和测试版本冻结

步骤：

```bash
cd "$REPO"
git status --short
git diff --stat
git diff --check
```

预期：

- `git diff --check` 返回 0。
- 记录所有已有修改；不得清理或覆盖非本轮改动。

### A-02 服务和健康基线

步骤：

```bash
DOMAIN="gui/$(id -u)"
launchctl print "$DOMAIN/com.hermes.codex-bridge-hco"
launchctl print "$DOMAIN/com.hermes.codex-bridge-delivery"
```

使用现有 secret loader 取得健康检查凭据后执行仓库文档中的 `/health` 或 Unix socket compatibility probe，不在 shell history 中直接展开密钥。

预期：

- HCO 和 delivery 处于预期运行状态。
- socket、release symlink、live attestation 和进程 PID 一致。
- 基线日志不存在持续重启、重复 poller 或未处理异常。

### A-03 自动测试门禁

步骤：

```bash
cd "$REPO"
"$PYTHON" -m pytest -q test/hermes_plugin_contract_test.py
node --test test/*.test.js
bash test/install-hermes-codex-bridge.test.sh
"$PYTHON" -m py_compile plugin/hermes-codex-bridge/*.py
node --check hco/service.js
git diff --check
```

预期：全部返回 0。任何失败先归因，不能跳过后继续真实发送验收。

---

## 5. 阶段 B：真实 Zulip Markdown 与单行化

本阶段通过仓库 `ZulipSender` 或 Zulip REST API 发送，随后分别调用 raw-message 和 messages API 回读。不能只依据客户端截图。

### B-01 正常标识符保持

发送内容：

```text
<RUN_ID>-B01 obj-1 LIVE-POSTFIX.S-001 release-2.4.1 alpha_beta
```

预期：

- `obj-1`、`LIVE-POSTFIX.S-001`、`release-2.4.1` 原样显示。
- `alpha_beta` 的下划线显示为普通字符，不产生 `<em>`。
- rendered HTML 中不存在意外的 `<em>`、`<strong>`、`<a>`、mention class。

### B-02 全部行分隔符折叠

分别测试以下分隔符：CRLF、CR、LF、VT `U+000B`、FF `U+000C`、NEL `U+0085`、LS `U+2028`、PS `U+2029`。

原始逻辑内容：

```text
<RUN_ID>-B02 before<SEPARATOR>after
```

预期：

- raw message 中对应分隔符不存在。
- 显示为 `before after`，只形成一个 Zulip 段落。
- 不生成列表、引用、代码块或第二段。

### B-03 Markdown 控制字符

输入文本：

```text
<tag>|@**all**_[x](https://example.invalid)#bang!`code`\
```

预期：

- 浏览器可见文本保留原字符含义。
- 无全员提及或用户组提及。
- 无 `<em>`、`<strong>`、`<a href="https://example.invalid">`、意外 `<code>`。
- `<tag>` 不被解释为 HTML，`|` 不形成表格。

### B-04 原始 HTML 实体不可递归解释

输入文本：

```text
&#42; &#64;all &#60;tag&#62;
```

预期：

- 用户看到原始字符串 `&#42;`、`&#64;all`、`&#60;tag&#62;`，而不是二次解码后的 `*`、mention 或 tag。
- raw content 中原始 `&` 被编码为 `&#38;`。

### B-05 长文本边界

发送接近 `MAX_VISIBLE_TEXT_BYTES` 的内容，尾部放置：

```text
END-obj-1-@**all**-<tag>-|
```

预期：

- 不发生多字节 UTF-8 截断乱码。
- 尾部若在允许范围内必须完整显示；若协议明确拒绝超限，返回稳定用户错误而非部分危险输出。
- 日志不包含完整被拒绝文本。

---

## 6. 阶段 C：BridgeUserError 安全输出

### C-01 无效审批选择

前置：创建允许 `accept`、`decline` 的测试审批，取得合法 `replyToken`。

操作：

```text
/codex approve <replyToken> acceppt
```

预期：

- 返回用户可理解的 `INTERACTION_DECISION_INVALID` 文本和有效选项。
- 不返回 `Codex bridge protocol error.`。
- 不显示内部堆栈、socket 路径、token 或异常 cause。

### C-02 恶意错误文本渲染

在隔离 HCO fixture 中令用户错误 message 包含：

```text
error<LS>*bold*<PS><tag>|@**all**_[x](https://example.invalid)
```

预期：

- Zulip 输出单行。
- rendered HTML 无强调、链接、提及或标签注入。
- 错误 code 仍保持用户错误分类。

### C-03 非白名单错误不反射

隔离实例返回一个随机错误 code 和包含秘密标记的 message。

预期：

- Zulip 只显示稳定 protocol error。
- 随机 message 和秘密标记不出现在 Zulip、普通诊断输出或未脱敏日志中。

---

## 7. 阶段 D：unavailable 与 uncertain 语义

本阶段必须使用隔离 Unix socket 和专用 SQLite。每个故障注入前后统计 objective、submission、turn 和 outbox 行数。

### D-01 连接前失败

注入：socket 路径不存在或 connect 立即返回 `ENOENT`。

预期：

- 返回：`Codex bridge 不可用，请求未提交。请稍后重试。`
- 不包含“可能已经写入”。
- HCO 端不存在对应 objective/turn/outbox 记录。
- 允许用户稍后重试。

### D-02 `writer.write()` 抛错

注入：fake writer 的 `write()` 在返回前抛出 `OSError`。

预期：与 D-01 相同，分类为 unavailable。

### D-03 `write()` 返回后 `drain()` 失败

注入：`write()` 正常返回，`drain()` 抛出 `OSError`。

预期：

- 分类为 `BridgeUncertainError`。
- Zulip 提示包含“请求可能已经写入”和“先用 `/codex status` 查询”。
- 不得声称“请求未提交”。
- 操作者在确认 durable 状态前不得重发。

### D-04 `drain()` 超时

注入：`write()` 返回，`drain()` 超过 `IO_TIMEOUT_SECONDS`。

预期：与 D-03 相同。

### D-05 请求已写入、响应读取失败

注入：服务端完整读取并处理请求，但客户端读取响应时断开或超时。

预期：

- uncertain 提示。
- durable store 最多存在一个对应 submission。
- 执行 `/codex status <objectiveId>` 能找到已有任务时，禁止创建替代任务。

### D-06 uncertain 安全 objective ID

使用 objective ID：

```text
obj-1
```

预期：uncertain 提示显示 `任务：obj-1。`。

### D-07 uncertain 危险 objective ID

分别注入：

```text
bad/id
bad id
bad|id
bad`id
bad<id>
<257-byte-token>
```

预期：

- uncertain 主提示和 status 建议仍显示。
- 危险 objective ID 完全不显示。
- 不生成可复制的危险 CLI 命令。

### D-08 恢复后的重试规则

步骤：恢复 bridge 后，分别处理 unavailable 和 uncertain 用例。

预期：

- unavailable 可直接重试，产生一个新且唯一的 submission。
- uncertain 必须先查 status；已有记录时不重试，无记录且经过人工确认后才重试。
- 全过程无两个相同 source identity 的执行。

---

## 8. 阶段 E：partial answer 与 interaction ID

### E-01 安全 interaction ID

构造 partial answer：

```text
interactionId = interaction-123
missingQuestionIds = [q2]
```

预期：显示可复制的 `/codex answer interaction-123 ...` 指引。

### E-02 空白和控制字符

分别使用 interaction ID：空字符串、空格、tab、CR、LF、NEL、LS、PS。

预期：

- 仍显示 partial 状态和缺失问题信息。
- 不显示 `/codex answer` 命令。

### E-03 shell/Markdown 危险字符

逐项测试：反引号、单双引号、`< > [ ] { } ( ) | ; \\ /`。

预期：不显示 answer 命令，危险 ID 不被反射为命令参数。

### E-04 UTF-8 长度边界

- 256 bytes 的安全 ASCII token：允许。
- 257 bytes：拒绝展示命令。
- 使用多字节字符分别构造恰好 256 bytes 和超过 256 bytes 的 token。

预期：按 UTF-8 bytes 判定，不按字符数量误判。

### E-05 多问题 partial

构造两个安全 missing question IDs 和一个不安全 ID。

预期：只要交互标识不可安全寻址，就不输出可能误导用户的命令；缺失问题摘要仍可见且已安全编码。

---

## 9. 阶段 F：secret answer 用户错误

### F-01 secret question 禁止 CLI 回答

前置：App Server 创建 `isSecret: true` 的 user-input interaction。

操作：

```text
/codex answer <replyToken> <questionId>=DO_NOT_STORE
```

预期：

- 返回用户可理解的敏感答案禁止提示。
- 错误分类为 `INTERACTION_SECRET_ANSWER_FORBIDDEN`，不退化为 protocol error。
- 秘密答案不进入 interaction answer、journal、outbox、Zulip 回复或普通日志。
- interaction 保持可通过安全 UI 处理的状态。

### F-02 非 secret question 对照

使用相同结构但 `isSecret: false`。

预期：合法答案正常提交，证明 F-01 不是全局禁止 answer。

### F-03 混合问题

同一 interaction 同时包含普通问题和 secret 问题。

预期：CLI 不得借由只回答普通问题绕过 secret interaction 的限制；UI 路径仍可用。

### F-04 secret 标记异常

分别测试缺失 `isSecret`、`false`、`true`、字符串 `"true"`。

预期：只接受协议规定的布尔语义；畸形 schema 失败关闭，不把秘密内容写入状态。

---

## 10. 阶段 G：业务 `stateError` 与 Python 白名单

### G-01 Hermes-owned stream 执行

在 Hermes-owned 测试 stream 发送：

```text
/codex run <RUN_ID>-G01 no-op
```

预期：返回 `ROUTE_HERMES_OWNED` 用户错误，不返回 protocol error，不创建 objective。

### G-02 不存在项目

由有 route 管理权限的测试管理员执行：

```text
/codex route set project-does-not-exist
```

预期：返回 `PROJECT_NOT_FOUND` 用户错误；route snapshot generation 和现有映射不改变。

### G-03 HERMES_ONLY topic 执行

步骤：在测试 topic 执行 `/codex topic hermes`，再发送 `/codex run <RUN_ID>-G03 no-op`。

预期：返回 `TOPIC_HERMES_ONLY` 用户错误，不创建执行；最后用 `/codex topic auto` 清理。

### G-04 ACL 对照

由 `UNAUTHORIZED_USER` 在项目 stream 发起执行。

预期：返回稳定 `ACL_FORBIDDEN` 用户错误；不得泄漏项目 cwd、ACL 列表或其他用户信息。

### G-05 不存在 objective

操作：

```text
/codex status objective-does-not-exist
```

预期：返回 `OBJECTIVE_NOT_FOUND` 用户错误；不返回内部异常。

---

## 11. 阶段 H：项目 containment 与百分号解码

至少配置两个测试项目：当前路由项目 `alpha`，外部项目 `beta`，并记录二者 config cwd 和 canonical cwd。

### H-01 原始 project ID

在 `alpha` stream 请求操作 `beta`。

预期：拒绝派发，提示上下文冲突；beta 工作区无文件和状态变化。

### H-02 小写百分号编码

文本包含：

```text
file:///workspace/%62eta/src/main.py
```

预期：解码后识别 `beta`，拒绝派发。

### H-03 大写十六进制百分号编码

文本包含 `%42eta` 或与实际 project ID 对应的大写 hex 编码。

预期：同样拒绝，不能只支持小写 hex。

### H-04 编码 cwd

把外部 canonical cwd 中至少一个字符百分号编码。

预期：`_cwd_referenced` 解码后命中并拒绝。

### H-05 当前项目路径对照

引用 `alpha` 自己的 project ID 和 cwd。

预期：不因 containment 误报而拒绝；仍受普通 ACL 和 topic mode 约束。

### H-06 子串误报对照

使用 `betamax`、`alphabet`、`/workspace/beta-other`。

预期：不应仅因无边界子串而判定引用 `beta`。

### H-07 多字段覆盖

分别把外部项目引用放入 `instruction`、`constraints`、`acceptanceCriteria`、`reminders`。

预期：每个字段都能触发 containment，错误提示指出对应字段；无 HCO 执行调用。

---

## 12. 阶段 I：跨平台 CWD 大小写

### I-01 macOS 大小写变化

注册 cwd：

```text
/workspace/beta
```

输入：

```text
/WORKSPACE/BETA/src/main.py
```

预期：macOS 上命中外部 cwd 并拒绝。

### I-02 Windows 大小写和分隔符

在 Windows runner 注册规范化测试 cwd，并用不同大小写引用。

预期：大小写不敏感命中；测试记录实际传入 containment 的规范化路径形式。若上游统一使用 `/`，不得用未经协议支持的 `\\` 形式替代测试。

### I-03 Linux 大小写对照

在 Linux runner 使用 `/workspace/beta` 与 `/WORKSPACE/BETA`。

预期：大小写不同不命中，完全相同大小写才命中，证明平台条件没有错误扩大。

### I-04 百分号编码加大小写组合

macOS/Windows 输入编码且变更大小写的外部 cwd。

预期：先解码后按平台大小写规则命中。

---

## 13. 阶段 J：Python 字节码和 `.gitignore`

### J-01 已跟踪字节码为零

```bash
cd "$REPO"
if git ls-files | grep -E '(^|/)(__pycache__/|.*\.(pyc|pyo|pyd)$)'; then
  echo "FAIL: tracked Python bytecode found" >&2
  false
fi
```

预期：无输出。

### J-02 生成后仍被忽略

```bash
cd "$REPO"
"$PYTHON" -m py_compile plugin/hermes-codex-bridge/*.py
if git status --short --untracked-files=all | grep -E '(__pycache__/|\.(pyc|pyo|pyd)$)'; then
  echo "FAIL: Python bytecode is visible to git" >&2
  false
fi
```

预期：无字节码出现在 git status。

### J-03 三类扩展名

在临时目录创建 `sample.pyc`、`sample.pyo`、`sample.pyd` 和 `__pycache__/sample.pyc`，用 `git check-ignore -v` 验证。

预期：全部由仓库 `.gitignore` 对应规则命中。

### J-04 安装产物检查

完成隔离 installer 后扫描 release 和 profile plugin 目录。

预期：安装包不依赖仓库中已跟踪的字节码；运行时临时生成的字节码不改变 release 内容哈希或 stable symlink。

---

## 14. 阶段 K：installer 无 `rg` 环境

### K-01 命令依赖静态检查

```bash
cd "$REPO"
grep -nE '(^|[^[:alnum:]_-])rg([^[:alnum:]_-]|$)' test/install-hermes-codex-bridge.test.sh
```

预期：测试逻辑中没有运行 `rg` 的依赖；文档文本命中需人工区分。

### K-02 隔离 PATH 执行

使用 installer 测试脚本现有的隔离 fixture，在 PATH 中明确不提供 `rg`，但保留脚本声明所需的系统工具、Node 和 Python。

预期：

- 不出现 `rg: command not found`。
- 所有 installer transaction 场景通过。
- grep 检查的匹配数量与原测试断言一致。

### K-03 提供故障 `rg` 对照

在 PATH 前置一个若被调用就返回 99 并记录日志的 fake `rg`。

预期：installer 测试成功，fake `rg` 调用日志为空，证明不是恰好由系统安装的 `rg` 兜底。

### K-04 grep 可移植性

在 macOS BSD grep 和 Linux GNU grep 各执行一次 installer 测试。

预期：无 GNU-only 参数依赖，匹配和退出码一致。

---

## 15. 阶段 L：恢复、重复和清理

### L-01 服务恢复

故障注入结束后恢复原 socket、LaunchAgent 和测试 profile。

预期：HCO 先 ready，delivery 后 ready；无持续重启或重复 Zulip poller。

### L-02 重复提交审计

按 RUN_ID 查询 objective、submission、turn、outbox 和 Zulip 回复。

预期：

- 每个明确提交的 source identity 最多一个执行。
- uncertain 场景若服务端已处理，不存在替代 turn。
- delivery 重试最多造成可解释的 at-least-once 投递记录，不造成第二次执行。

### L-03 项目和 topic 恢复

预期：

- 临时 `HERMES_ONLY` topic 恢复为 `AUTO`。
- 未修改生产 route；如使用专用测试 route，按记录回滚并验证 generation。
- 测试工作区仅包含预期 canary 文件，随后删除。

### L-04 测试消息处理

保留最终 PASS 消息 ID 作为审计证据；删除包含故障演示或可能误导普通用户的失败样例时，记录删除者、原 message ID 和时间。

### L-05 最终门禁

重新执行 A-02 和 A-03，比较测试前后：

- 服务 PID/restart 是否符合预期。
- route snapshot、attestation、SQLite 主库和 WAL/SHM 无异常所有权。
- 生产配置、凭据文件和 ACL 未被测试扩大。
- `git diff --check` 和自动测试仍通过。

---

## 16. 推荐执行顺序

1. A：冻结版本、健康和自动门禁。
2. B、C：低风险真实 Zulip 渲染与用户错误。
3. E、F、G：interaction 和业务错误。
4. H：项目 containment。
5. D：维护窗口内隔离 transport 故障注入。
6. I：macOS、Windows、Linux 平台矩阵。
7. J、K：仓库清理和 installer 可移植性。
8. L：恢复、重复审计和最终门禁。

不要先做 D 再补基线；否则无法证明 objective 或消息是否由故障注入新增。

---

## 17. 发布判定

### 必须通过

- D-03、D-04、D-05 均严格进入 uncertain，D-01、D-02 严格进入 unavailable。
- uncertain 场景无盲目重试和重复执行。
- B、C 所有 rendered HTML 安全断言通过。
- F-01 秘密答案未进入任何持久化或消息输出。
- H-02、H-04、I-01、I-02 containment 通过。
- G 的业务错误保持用户可见，不退化为 protocol error。
- J、K 无跟踪字节码和 `rg` 运行依赖。
- L 的恢复、重复审计和最终门禁通过。

### 立即阻断

- unavailable 错误实际可能已写入。
- uncertain 提示声称请求未提交，或引导直接重试。
- Zulip rendered HTML 出现非预期 mention、link、emphasis、code、table 或结构注入。
- 危险 interaction/objective ID 被拼入 CLI 命令。
- `%62eta`、编码 cwd 或 macOS/Windows 大小写变化绕过 containment。
- secret answer 出现在数据库、outbox、日志或 Zulip。
- 为通过测试而扩大 ACL、伪造用户或修改生产 route。

---

## 18. 执行记录模板

```text
RUN_ID:
Release / commit:
Workspace diff stat:
Operator:
Authorized user ID:
Test stream ID / name:
Test topic:
Gateway PID:
HCO PID:
Delivery PID:
Route snapshot generation:

Case ID:
Start / end time:
Inbound message ID:
Reply message ID:
Objective / interaction ID (安全值或哈希):
Actual result:
Raw readback check:
Rendered HTML check:
Durable state check:
Log check:
Cleanup:
Result: PASS / FAIL / BLOCKED
Deviation / incident reference:
```

最终记录只保存必要证据和哈希，不保存凭据、完整 prompt、秘密答案或 signed context token。

---

## 19. 自动化可行性评估

结论：**本方案 57 个用例均可以纳入自动化流水线，但不应全部使用同一种入口。**

### 19.1 三类执行边界

| 类别 | 用例 | 数量 | 执行方式 | 是否需要用户人工输入 |
|---|---|---:|---|---|
| API / shell / 隔离 fixture | `A-*`、`B-*`、`C-02..03`、`D-*`、`E-*`、`F-04`、`G-04`、`I-01`、`J-*`、`K-01..03`、`L-01..02`、`L-04..05` | 37 | Python/Node 测试、Zulip API、HCO socket、SQLite/日志检查 | 否 |
| 浏览器自动化 | `C-01`、`F-01..03`、`G-01..03`、`G-05`、`H-01..07`、`L-03` | 16 | 已登录授权用户的 Zulip Web UI + API 回读 | 仅首次登录、2FA 或人工确认 |
| 额外平台 runner | `I-02..04`、`K-04` | 4 | Windows/Linux runner；macOS 可在当前机器完成对应子集 | 否 |

这里的“浏览器自动化”不是让人工逐条点击：用户只需提供一个已登录、合法授权的浏览器会话，Playwright 负责填写和发送消息，随后脚本用 message ID/API/服务状态完成断言。不能用 bot API 冒充 `AUTHORIZED_USER`，否则只能证明出站传输，不能证明授权入站链路。

### 19.2 当前机器的可用性

当前环境已确认：

- `npx` 可用。
- 全局 `/Users/hula/.npm-global/bin/playwright-cli` 可用。
- Playwright skill wrapper 存在但当前没有 executable bit；可直接使用全局 CLI，或用 `bash /Users/hula/.codex/skills/playwright/scripts/playwright_cli.sh`。
- 当前已知的 Zulip 本地凭据是 send-only bot，适合 API 出站和回读；授权用户相关用例仍需浏览器会话。

### 19.3 推荐自动化架构

```text
test-runner
  ├─ api_sender       -> Zulip API 发送/回读、message ID、rendered HTML
  ├─ bridge_fixture   -> 隔离 socket、write/drain/read 故障注入
  ├─ state_inspector  -> SQLite、WAL/SHM、outbox、objective、interaction
  ├─ service_probe    -> HCO health、compatibility、PID、route snapshot、日志
  ├─ browser_driver   -> 已登录授权用户的 Zulip Web UI
  └─ platform_runner  -> macOS / Windows / Linux containment 与 grep 矩阵
```

每个执行器都使用同一个 `RUN_ID`，并输出一份结构化 JSON 证据；浏览器只负责产生合法入站消息，所有“是否真的执行、是否重复、是否跨项目”的判定仍通过 API、SQLite 和日志完成。

### 19.4 浏览器会话要求

开始浏览器自动化前，用户需要：

1. 在浏览器中打开 Zulip，并完成登录、2FA 和必要的组织选择。
2. 确认当前账户确实是测试项目 ACL 中的授权用户；不要在聊天中发送密码或 token。
3. 将浏览器停留在测试组织/测试 stream 可见的页面。
4. 明确授权本次自动化可以发送带 `RUN_ID` 的测试消息，并在结束后按 L-04 清理。

浏览器自动化不得执行：扩大 ACL、确认未审阅的生产审批、取消非测试任务、修改生产 route、发送真实业务指令。

### 19.5 自动化优先级

建议分三批实现：

**第一批：立即自动化，当前机器可执行**

- A、B、C-02/C-03、D、E、F-04、G-04、I-01、J、K-01..03、L-01/L-02/L-04/L-05。
- 这些用例不依赖授权用户浏览器，可在隔离临时 home/profile 下无人值守运行。

**第二批：提供浏览器后自动化**

- C-01、F-01..03、G-01..03/G-05、H、L-03。
- 每个浏览器用例必须先创建测试前置状态，再发送一条唯一 RUN_ID 消息，最后通过 API 精确回读回复。

**第三批：CI 或虚拟机自动化**

- I-02..04、K-04。
- Windows 必须使用真实 Windows 文件系统行为；Linux 必须验证大小写敏感对照；不能在 macOS 上伪造 `sys.platform` 后宣称跨平台通过。

### 19.6 自动化仍需人工批准的节点

以下不是技术上不能自动化，而是为了避免不可逆或高影响操作，必须保留人工 gate：

- 首次复用浏览器登录态和 2FA。
- 进入生产维护窗口并启用 live transport 故障注入。
- 任何可能取消、批准、执行真实项目任务的步骤。
- 测试消息最终删除或保留的决定。
- 发布前确认没有扩大 ACL、没有使用伪造身份。
