# HCO 十二轮缺陷修复记录

**日期**: 2026-07-21
**状态**: 已完成
**执行方案**: 上一轮（十一轮）审查后发现的4项遗留问题

## 修复项目

### P1a: escapeMarkdownCodeBlock 修改命令内容（turn-controller.js）

**问题**: `escapeMarkdownCodeBlock` 把换行替换为空格、把反引号加反斜杠，导致围栏代码块内显示与实际执行命令不一致，审批场景存在展示/执行不一致风险。

**修复**:
- 删除 `escapeMarkdownCodeBlock` 函数
- 新增 `fencedCodeBlock(content)` 函数：根据内容中最长连续反引号序列动态计算 fence 长度（≥3，超过即延长），content 原样写入代码块
- `defaultInteractionRenderer` 的命令显示改用 `...fencedCodeBlock(displayCmd)` 展开

### P1b: escapeMarkdownInline 用于 code span 的反引号注入（turn-controller.js）

**问题**: `escapeMarkdownInline` 用 `\`` 转义反引号，但 CommonMark code span 内反斜杠不起转义作用；cwd、option.label、question.id 等字段中的反引号仍可提前结束 span 并伪造后续文本。

**修复**:
- 新增 `codeSpan(value)` 函数：动态计算 fence 长度（最长反引号run+1），content 起止为反引号时加一个空格；content 原样写入
- 所有把 `escapeMarkdownInline` 结果放进 backtick code span 的位置（cwd、option.label、question.id、interactionId 的 reply token、hardFallbackContent 等）统一替换为 `codeSpan(value)`
- `escapeMarkdownInline` 仅保留用于纯 Markdown inline 文本（reason、header、description 等不在 code span 内的字段）

### P2: interactionId 在命令生成路径缺少 isSafeCliToken 校验（turn-controller.js）

**问题**: `safeApprovalCommands`、`toCompactContent` 的 answer 命令路径、`defaultInteractionRenderer` 的命令路径直接将 `interactionId` 拼入 slash 命令字符串，未经 `isSafeCliToken` 校验。

**修复**:
- `safeApprovalCommands`：首行加 `if (!isSafeCliToken(interactionId)) return [];`
- `toCompactContent`：计算 `safeId = isSafeCliToken(interactionId)`，answer 命令路径加 `!safeId` 守卫，走 UI 提示分支
- `defaultInteractionRenderer`：多问题 per-question answer 命令、单问题 answer 命令路径均加 `isSafeCliToken(interactionId)` 守卫

### P3: Python `_is_safe_question_id` 未拒绝 Node 拒绝的特殊字符（plugin.py）

**问题**: Node `isSafeCliToken` 拒绝 `` `"'<>[]{}()|;\/ ``，Python `_is_safe_question_id` 只拒绝空白和控制字符，两侧规则不对称；异常 bridge 响应中含这些字符的 missingQuestionIds 可能通过 Python 校验并未经转义进入 Zulip 文本。

**修复**:
- `plugin.py` 新增 `_UNSAFE_QUESTION_ID_CHARS = frozenset('` `` `"'<>[]{}()|;\\/` ``')`
- `_is_safe_question_id` 末尾加 `if any(c in _UNSAFE_QUESTION_ID_CHARS for c in value): return False`
- 更新 docstring，说明与 Node 对齐

## 验证结果

- `npm run check` 通过
- Node tests: **245/245** 通过（含4个新增/修改测试）
- Python pytest: **295/295** 通过（含1个新增测试 `test_safe_question_id_rejects_node_special_chars`）
- `git diff --check` 通过（无 trailing whitespace）

## 新增/修改的测试

**turn-controller.test.js**:
- `approval renderer uses extended fence for commands containing backticks`（原 triple-backtick 测试更新，反映新的 fencedCodeBlock 行为）
- `approval renderer uses codeSpan for cwd containing backticks`（新增 P1b）
- `input renderer uses codeSpan for option labels containing backticks`（新增 P1b）
- `unsafe interactionId suppresses approval commands`（已有框架验证正常路径）
- `safeApprovalCommands returns empty array for unsafe interactionId`（新增 P2，注入 unsafe idFactory）

**hermes_plugin_contract_test.py**:
- `test_safe_question_id_rejects_node_special_chars`（新增 P3）
