# HCO Fix2 修复后测试方案

**日期**：2026-07-23  
**目标**：验证本轮修复没有回归，并关闭此前发现的路由契约、mention、Markdown 安全、审计和故障边界问题。  
**环境原则**：不修改生产 route；人工测试使用专用 topic，自动化 API 测试使用独立 run topic；所有 token、API key、HMAC、cookie、正文秘密和完整环境变量不写入结果。

## 一、修复内容与验收边界

1. 未映射 stream 的执行类 `/codex` 命令返回登记提示，并写入同步脱敏结构化审计事件。
2. 未映射 stream 的 `ROUTE.SHOW/SET/NONE/UNSET` 不被插件提前拦截，必须签名穿透 HCO，由 HCO 完成 ACL 与 route mutation 决策。
3. 显式 HERMES route 的 `/codex` 命令仍进入 HCO，不能被普通 Hermes 分支吞掉。
4. `G-06A` 验证 `obj-1-LIVE-POSTFIX.S-001` 等正常标识符保真；`G-06B` 自动化验证 `*`、`_`、`<`、`>`、`|`、链接、提及和实体文本不形成危险 Markdown/HTML。
5. API 回读必须验证 Zulip `rendered HTML` 包含真实 `user-mention` 元素；仅看到原始 `@**Name**` 不算通过。
6. 日志只允许出现事件类型、数字 ID、解析后的命令类型、结果码、字节长度和 SHA-256；不得出现命令参数、消息正文、CWD、token、HMAC 或秘密答案。

## 二、自动化测试

### A-01 现有回归门禁

```bash
cd /Users/hula/Projects/hermes-codex-orchestrator
PYTHON=/Users/hula/Projects/hermesAgent/.venv/bin/python3
"$PYTHON" -m pytest -q test/hermes_plugin_contract_test.py test/delivery_sidecar_test.py
node --test test/*.test.js
bash test/install-hermes-codex-bridge.test.sh
"$PYTHON" -m py_compile plugin/hermes-codex-bridge/*.py scripts/hco-fix2-api-acceptance.py
node --check hco/service.js
git diff --check
```

通过标准：Python、Node、installer 全部通过；无语法错误、无 whitespace 错误；失败不得以跳过或降级安全断言方式处理。

### A-02 插件路由合同

在 `test/hermes_plugin_contract_test.py` 验证：

- 无效、过期、损坏 snapshot 对执行命令 fail closed，返回 `ROUTE_UNAVAILABLE`。
- 未映射 stream 的 `RUN/STATUS/CANCEL/TOPIC/OBJECTIVE_*` 返回登记模板。
- 未映射 stream 的四种 ROUTE 管理命令均生成签名 HCO token，不在插件本地返回登记模板。
- 显式 HERMES route 的 `/codex status` 生成签名 HCO token。
- 本地登记拦截产生一行 JSON 审计；审计写失败时请求 fail closed。
- 审计记录不包含原始命令参数或正文，topic 仅保留字节数与 SHA-256。

### A-03 HCO ACL、幂等与并发

在 Node HCO 测试中验证：

- ROUTE.SET 目标项目不存在时返回 `PROJECT_NOT_FOUND`。
- ROUTE.SET、NONE、UNSET 按目标项目和既有 route 执行 `route.manage` ACL。
- 同一 `sourceMessageId` 重放不重复改变 route 或 generation。
- 并发 route mutation 不发布旧 generation 覆盖新 generation。
- snapshot 采用 fsync + rename，损坏或过期时读取方拒绝执行。

### A-04 Markdown、containment、interaction

- 正常标识符保留连字符、点号、数字和大小写。
- `*bold*`、`_italic_`、`` `code` ``、`<tag>`、`>`、`|`、`[link](...)`、`@**all**` 均被安全编码。
- `&` 先编码，不能让已有实体再次被解释。
- 控制字符和 Unicode 行分隔符统一折叠为单行。
- `%62eta` 等 URL 百分号编码不能绕过 project containment。
- macOS/Windows CWD containment 大小写不敏感；其他平台保持大小写敏感。
- unsafe `interactionId` 不生成可执行 CLI 命令；合法 ID 保持原样。
- `BridgeUnavailableError` 文案明确“请求未提交”；`BridgeUncertainError` 文案明确“可能已经写入，先查询状态”，两者不混淆。

### A-05 真实 Zulip API 自动化

使用：

```bash
cd /Users/hula/Projects/hermes-codex-orchestrator
PYTHON=/Users/hula/Projects/hermesAgent/.venv/bin/python3
OUT="docs/superpowers/test-artifacts/$(date +%Y-%m-%d)-hco-fix2-api"
mkdir -p "$OUT"
"$PYTHON" scripts/hco-fix2-api-acceptance.py \
  --config "$HOME/.zuliprc" \
  --stream-id <专用测试 stream_id> \
  --output "$OUT/result.json"
```

脚本覆盖正常标识符、单行化、危险字符、已有实体、长消息边界和真实 mention。B-06 使用 Zulip profile 的真实 `full_name` 发送 `@**Name**`，并断言回读 HTML 的 class 包含 `user-mention`。

通过标准：所有记录为 PASS；结果文件只保留 message ID、摘要、字节长度和断言结果，不记录消息正文或凭据。

## 三、人工 Zulip 复测

### 环境准备

- stream：专用测试 stream；不要使用生产项目频道做变更型命令。
- topic：`hco-fix2-post-fix-<时间戳>`。
- 账号：合法授权用户；如需 ACL 失败场景，使用明确未授权测试账号。
- 每条消息发送后用 Zulip API 回读 message ID，并检查 `rendered_content`/`content`，不要只看浏览器页面。

### P-00 服务基线

确认 gateway、HCO、delivery PID、socket、snapshot generation 和日志采集均正常。记录版本、时间、topic 和进程状态，不记录秘密。

### G-01A 未映射 stream

发送：

```text
/codex run 只做测试，不修改文件，并返回一句确认
```

预期：返回登记提示；不创建 objective、不产生 HCO 执行入站；插件日志出现脱敏 `ROUTE_UNMAPPED_REGISTRATION` 事件。该用例不期待 `ROUTE_HERMES_OWNED`。

### G-01B 显式 HERMES route

在隔离测试 route 已明确为 HERMES 的 stream 发送：

```text
/codex status
```

预期：消息进入 HCO 并返回 `ROUTE_HERMES_OWNED` 对应的安全用户提示；不能被普通 Hermes 回复吞掉；日志不泄露 token 或内部堆栈。

### G-05 只读 route 查询

在已登记 PROJECT route 的专用 topic 发送：

```text
@**Jarvis PM** 请回复当前 projectId、工作目录，并用一句话汇报项目进度。回显 G05-<唯一标识>
```

预期：只读查询返回正确 projectId、canonical 工作目录和一句进度；回显标识完整；不得执行项目修改。API 回读必须确认回复存在真实 `user-mention` HTML。

### G-06A 正常标识符

发送：

```text
@**Jarvis PM** 请执行只读 route 查询，并原样回显 obj-1-LIVE-POSTFIX.S-001
```

预期：`obj-1-LIVE-POSTFIX.S-001` 字符完全保真，不被 Markdown 解释或拆分。

### G-06B 危险字符

不要把危险字符串放入真实 projectId、route marker 或可执行参数；使用自动化 API/单元测试验证以下回显数据：

```text
*bold* _italic_ `code` <tag> >quote |pipe [link](https://example.invalid) @**all** &
```

预期：单行输出；危险字符被编码；rendered HTML 不出现非预期 `em`、`strong`、`a`、原始 tag 或群组提及。

### U-01/U-02 故障边界

仅在隔离 HCO/bridge 实例注入：

- 写入前连接失败：提示请求未提交，可稍后重试。
- `writer.write()` 已返回后 `drain()`/响应读取失败：提示可能已经写入，先查询状态；重复发送前不得自动重试。

预期：没有重复 objective、重复 turn 或重复 Zulip 回复；状态查询能区分已提交、未知和未提交。

## 四、失败分类与证据

- **PASS**：所有预期、API HTML、日志脱敏和状态断言均满足。
- **FAIL**：出现错误提示语义混淆、危险 HTML、重复提交、ACL 越权、秘密泄漏或无法取得关键证据。
- **BLOCKED**：缺少合法账号、隔离实例或 API 权限；不得把未执行改为 PASS。

每个用例保存：case ID、绝对时间、版本/hash、stream/topic、入站和回复 message ID、API 回读摘要、rendered HTML 断言、HCO 状态摘要、日志脱敏检查、清理结果。

## 五、发布门槛

1. A-01 至 A-05 全部通过。
2. G-01A、G-01B、G-05、G-06A 人工通过；U-01/U-02 在隔离实例通过。
3. 真实 mention API 断言通过，不能以浏览器页面显示代替。
4. 未映射 stream 的 ROUTE 管理行为已有明确 ACL 合同，不修改生产 route。
5. 所有结果文件和日志通过秘密泄漏检查，工作区不重新产生被跟踪的 Python 字节码。
