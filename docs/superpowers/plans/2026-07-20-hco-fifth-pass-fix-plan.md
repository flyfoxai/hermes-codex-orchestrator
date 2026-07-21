# HCO 五轮缺陷修复方案

**日期**: 2026-07-20
**状态**: 待实施（已自审通过）
**背景**: 四轮修复后复审发现 4 个新问题，全部成立，需五轮根因修复。

---

## 问题确认

### P1-a：缺少 availableDecisions 时非法 choice 永久占用交互

当前 `service.js:516` 在 `availableDecisions` 为 null/缺失/空时直接返回任意 choiceKey，`acceppt` 等错字通过校验，写入 durable settlement，App Server 随后拒绝，正确答案再无法提交。

真实 schema（`CommandExecutionRequestApprovalParams`）明确允许 `availableDecisions` 缺失或为 null。

**修复方向**：当 `availableDecisions` 缺失/为空时，对照已知合法简单决策（`"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`）校验；不在其中则抛错，不写 durable。

### P1-b：CWD 检测与 HCO canonical CWD 不一致

`plugin.py:410` 存储原始配置值，但 HCO `config.js:121` 使用 `realpathSync()`。复现场景：
- 配置 `/workspace/beta/`（含尾斜杠）不命中 `/workspace/beta/src/main.py`
- 根目录 `/` 配置不命中其普通子路径（`_cwd_referenced` 边界检查将 `/` 结尾视为续接）

**修复方向**：在 `_load_project_cwd_map` 中用 `os.path.normpath()` 规范化（去除尾斜杠、多余分隔符）；过滤掉根目录 `/`（过于宽泛）。符号链接解析需要文件系统访问，不在本轮修复范围，记录为已知限制。

### P2：新增业务校验错误在真实 bridge 路径中显示为协议故障

**根因链**：
1. `serviceError()` 创建普通 Error（不是 `stateError`）
2. `bridge/server.js normalizeError` 对非 BridgeError、非 stateError 一律返回 HTTP 500 BRIDGE_INTERNAL
3. `bridge_client.py _parse_response` 对非200 统一抛 `BridgeProtocolError("bridge rejected request")`，不携带 message
4. 插件显示 `"Codex bridge protocol error."`，用户看不到有效 choices 或正确命令提示

**修复方向（三处协同）**：
- `hco/service.js`：`INTERACTION_DECISION_INVALID`、`INTERACTION_COMMAND_MISMATCH`、`INTERACTION_QUESTION_ID_INVALID` 改用 `stateError()`（从 `./state/reducer.js` 导入）
- `hco/bridge/server.js`：将上述三个错误码加入 `INPUT_STATE_CODES`（→ HTTP 400）
- `plugin/hermes-codex-bridge/bridge_client.py`：新增 `BridgeUserError(code, message)` 异常；在 `_parse_response` 中，当 HTTP 4xx 且 error code 在已知用户错误码集合中时，抛 `BridgeUserError` 而非 `BridgeProtocolError`
- `plugin/hermes-codex-bridge/plugin.py`：在 `private_command_handler` 中捕获 `BridgeUserError` 并返回其 message

### P3：missingQuestionIds 元素校验不足

`plugin.py:1035` 仅验证为非空 list，整数 `7` 等非字符串元素会使 `missing_list` 为空字符串；含换行的字符串会注入通知。

**修复方向**：每个元素必须是非空字符串、长度 ≤ 256、不含控制字符（ASCII 0-31，DEL 127）；过滤后若无有效元素则返回协议错误。

---

## 修复范围

### 必改文件

1. `hco/service.js` — P1-a choice 校验 + P2 换用 stateError
2. `hco/bridge/server.js` — P2 INPUT_STATE_CODES 新增三个码
3. `plugin/hermes-codex-bridge/bridge_client.py` — P2 BridgeUserError
4. `plugin/hermes-codex-bridge/plugin.py` — P1-b CWD normpath + P2 BridgeUserError 捕获 + P3 元素校验
5. `test/hco-service.test.js` — P1-a 无 availableDecisions 时的错字拒绝测试
6. `test/hermes_plugin_contract_test.py` — P1-b CWD尾斜杠测试 + P2 用户可见错误消息端到端测试 + P3 非字符串元素过滤测试
7. `docs/superpowers/records/2026-07-20-hco-fifth-pass-fix-record.md` — 新建五轮修复记录

---

## 具体实施方案

### A. P1-a：无 availableDecisions 时的 choice 校验

**文件**: `hco/service.js:498-520`

```javascript
const KNOWN_SIMPLE_DECISIONS = Object.freeze(
  new Set(["accept", "acceptForSession", "decline", "cancel"])
);

function resolveApprovalDecision(interaction, choiceKey) {
  const available = interaction?.request?.availableDecisions;
  if (Array.isArray(available) && available.length > 0) {
    // 现有逻辑：在 availableDecisions 中查找
    for (const decision of available) {
      if (typeof decision === "string" && decision === choiceKey) return decision;
      if (isPlainObject(decision)) {
        const keys = Object.keys(decision);
        if (keys.length === 1 && keys[0] === choiceKey) return decision;
      }
    }
    const valid = available.map((d) =>
      typeof d === "string" ? d : (isPlainObject(d) ? Object.keys(d)[0] : null)
    ).filter(Boolean);
    throw stateError(
      "INTERACTION_DECISION_INVALID",
      `Invalid decision '${choiceKey}'. Valid choices: ${valid.join(", ")}.`
    );
  }
  // availableDecisions 缺失/为空：只允许已知简单决策
  if (KNOWN_SIMPLE_DECISIONS.has(choiceKey)) return choiceKey;
  throw stateError(
    "INTERACTION_DECISION_INVALID",
    `Invalid decision '${choiceKey}'. Without available decisions, valid choices are: ${[...KNOWN_SIMPLE_DECISIONS].join(", ")}.`
  );
}
```

注意：这里已经是 `stateError`（见下文 P2 统一修改）。

**测试**（`test/hco-service.test.js`）：
- `availableDecisions` 缺失，提交 `"accept"` → 成功
- `availableDecisions` 缺失，提交 `"acceppt"` → 抛 `INTERACTION_DECISION_INVALID`，不调用 backend
- `availableDecisions: null`，提交 `"decline"` → 成功

---

### B. P1-b：CWD normpath 规范化

**文件**: `plugin/hermes-codex-bridge/plugin.py` `_load_project_cwd_map`

```python
import os  # already imported

def _load_project_cwd_map(config_path: str) -> dict[str, str]:
    try:
        raw = _read_owner_file(config_path, MAX_CONFIG_BYTES)
        config = json.loads(raw.decode("utf-8"))
        projects = config.get("projects", [])
        if not isinstance(projects, list):
            return {}
        result: dict[str, str] = {}
        for p in projects:
            if not isinstance(p, dict):
                continue
            pid = p.get("projectId")
            cwd = p.get("cwd")
            if isinstance(pid, str) and pid and isinstance(cwd, str) and cwd:
                normalized = os.path.normpath(cwd)
                # 过滤根目录（太宽泛，会命中任何路径）
                if normalized and normalized != os.sep:
                    result[pid] = normalized
        return result
    except Exception:
        return {}
```

**已知限制**（记录在修复记录中）：
- `os.path.normpath` 不解析符号链接；HCO 使用 `realpathSync()`，符号链接路径仍可能不匹配。需要文件系统访问才能完全对齐，超出本轮修复范围。

**测试**（`test/hermes_plugin_contract_test.py`）：
- 配置尾斜杠 `/workspace/beta/`，指令引用 `/workspace/beta/src/main.py` → 应拒绝（normpath 后一致）
- 根目录 `/` 不加入 cwd_map（跳过），不触发任何拦截

---

### C. P2：业务错误三处协同修复

#### C1. `hco/service.js`：import stateError，用于三个校验错误

在 service.js 顶部（或适当位置）新增 import：

```javascript
import { stateError } from "./state/reducer.js";
```

将 `INTERACTION_DECISION_INVALID`、`INTERACTION_COMMAND_MISMATCH`、`INTERACTION_QUESTION_ID_INVALID` 改用 `stateError()` 而非 `serviceError()`：

```javascript
throw stateError("INTERACTION_DECISION_INVALID", "...");
throw stateError("INTERACTION_COMMAND_MISMATCH", "...");
throw stateError("INTERACTION_QUESTION_ID_INVALID", "...");
```

**注意**：不要修改其他 `serviceError` 调用（仅这三处）。

#### C2. `hco/bridge/server.js`：INPUT_STATE_CODES 新增

```javascript
const INPUT_STATE_CODES = new Set([
  "FACT_INVALID",
  "OUTBOX_CLAIM_INVALID",
  "OUTBOX_ACK_INVALID",
  "OUTBOX_NACK_INVALID",
  "INTERACTION_DECISION_INVALID",    // 新增
  "INTERACTION_COMMAND_MISMATCH",    // 新增
  "INTERACTION_QUESTION_ID_INVALID", // 新增（三轮已有）
]);
```

这使这三个错误返回 HTTP 400 而非 500。

#### C3. `plugin/hermes-codex-bridge/bridge_client.py`：BridgeUserError

```python
USER_FACING_ERROR_CODES = frozenset({
    "INTERACTION_DECISION_INVALID",
    "INTERACTION_COMMAND_MISMATCH",
    "INTERACTION_QUESTION_ID_INVALID",
})

class BridgeUserError(Exception):
    """An error with a user-readable message, returned as 4xx from the bridge."""
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.user_message = message
```

在 `_parse_response` 的非200处理中：

```python
    if status != 200:
        error = body.get("error")
        if (
            set(body) != {"error"}
            or type(error) is not dict
            or set(error) != {"code", "message"}
            or type(error.get("code")) is not str
            or type(error.get("message")) is not str
        ):
            raise BridgeProtocolError("invalid error response")
        # 已知用户可见错误：抛 BridgeUserError 保留消息
        if error["code"] in USER_FACING_ERROR_CODES:
            raise BridgeUserError(error["code"], error["message"])
        raise BridgeProtocolError("bridge rejected request")
```

#### C4. `plugin/hermes-codex-bridge/plugin.py`：命令处理器捕获 BridgeUserError

在 `from .bridge_client import BridgeClient, BridgeProtocolError, BridgeUnavailableError` 中新增 `BridgeUserError`。

在 `private_command_handler`（处理 `/codex approve` 和 `/codex answer`）中：

```python
    try:
        result = await client.submit(event)
    except BridgeUnavailableError:
        return "Codex bridge unavailable."
    except BridgeUserError as exc:
        return str(exc)          # 显示用户可读的 message
    except BridgeProtocolError:
        return "Codex bridge protocol error."
    return _render_bridge_result(result, payload.get("replyMarker"))
```

**测试**（`test/hermes_plugin_contract_test.py`）：
- 端到端：用户提交 `/codex approve <id> acceppt`（错字），通过真实 bridge 路径后，用户看到包含有效 choices 的错误提示，而非 "Codex bridge protocol error."
- 模拟 400 + `INTERACTION_DECISION_INVALID` 响应 → 插件返回具体消息

---

### D. P3：missingQuestionIds 元素校验

**文件**: `plugin/hermes-codex-bridge/plugin.py` partial 渲染分支

```python
def _is_safe_question_id(value: object) -> bool:
    """Non-empty string, max 256 bytes, no control chars."""
    if type(value) is not str or not value:
        return False
    try:
        if len(value.encode("utf-8")) > 256:
            return False
    except Exception:
        return False
    return all(ord(c) >= 32 and c != "\x7f" for c in value)
```

在 partial 分支中：

```python
valid_missing = [q for q in missing if _is_safe_question_id(q)]
if not valid_missing:
    return "Codex bridge protocol error."
missing_list = "、".join(valid_missing)
```

**测试**（`test/hermes_plugin_contract_test.py`）：
- `missingQuestionIds: [7, "q2"]` → 显示 `q2`，整数7被过滤
- `missingQuestionIds: ["q1\ninjected"]` → 被过滤（含控制字符）
- `missingQuestionIds: [7]` → 无有效元素，返回协议错误

---

## 验证命令

```bash
npm run check
node --test test/turn-controller.test.js test/hco-service.test.js test/option-c-e2e.test.js
/Users/hula/Projects/hermesAgent/.venv/bin/python -m pytest test/hermes_plugin_contract_test.py -q
node --test test/*.test.js
```

---

## 验收标准

### P1-a
- [ ] `availableDecisions` 缺失时，`"acceppt"` 抛 `INTERACTION_DECISION_INVALID`，不写 durable
- [ ] `availableDecisions` 缺失时，`"accept"` 等已知决策通过

### P1-b
- [ ] 尾斜杠路径 `/workspace/beta/` 与 `/workspace/beta/src/main.py` 子路径命中
- [ ] 根目录 `/` 不加入 cwd_map

### P2
- [ ] `/codex approve <id> acceppt` 返回包含 "Valid choices" 的用户可读消息，不显示 "protocol error"
- [ ] `/codex answer` 用于审批 interaction 返回方法不匹配的用户消息
- [ ] 测试覆盖 bridge → plugin 端到端路径

### P3
- [ ] 整数 `7` 等非字符串元素被过滤
- [ ] 含控制字符的字符串被过滤
- [ ] 过滤后无有效元素 → 返回协议错误，不显示空的 "还需回答：。"

---

## 注意事项

1. 只将 **三个新校验错误码** 改用 `stateError`；不得修改其他 `serviceError` 调用。
2. `BridgeUserError` 的 `USER_FACING_ERROR_CODES` 集合须与 `INPUT_STATE_CODES` 一致，否则400响应不会触发 BridgeUserError。
3. 符号链接 CWD 不在本轮修复范围，在修复记录中明确说明。
4. 不提交 git commit，不执行 git push。
5. 测试 fixture 必须覆盖 bridge → plugin 完整路径（不能只测 service 直接调用）。
