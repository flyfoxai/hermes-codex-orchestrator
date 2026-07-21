# HCO 缺陷修复方案

**日期**: 2026-07-19  
**版本**: v1.0  
**状态**: 待 Codex 审查  
**发现者**: Codex 审核（Jarvis PM 分析 + Boss 确认）

---

## 背景

本次修复针对在 `objective-42b0799a-bd29-4604-be1c-9df338b35531`（项目 stockprofits，话题"框架安装"）运行过程中发现的三个缺陷，以及 `objective-1582ad91`（项目 ASK）的可观测性问题。

---

## 缺陷清单

| ID | 严重性 | 标题 |
|----|--------|------|
| BUG-1 | 高 | 审批通知消息不可操作：缺少 replyToken、原因、可选决策 |
| BUG-2 | 严重 | 跨项目 semantic 上下文污染：stockprofits 任务指令引用 ASK 仓库 |
| BUG-3 | 中 | 任务已接受但响应失败后显示 "bridge unavailable"，缺少状态补偿 |

---

## BUG-1：审批通知不可操作

### 根因

**文件**: `hco/turn-controller.js` 第 48–53 行

```javascript
function defaultInteractionRenderer({ interaction }) {
  return {
    semanticKey: `interaction:${interaction.interactionId}:prompt`,
    payload: { content: "Approval or input requested.", kind: "interaction_request" }
  };
}
```

渲染器将内容硬编码为一句无意义占位文本，丢弃了 `interaction` 对象中所有可操作信息。

**投递链**：`defaultInteractionRenderer` → `zulip_outbox.payload_json.content` → `delivery_sidecar.py:429 process_claim()` 原样发送到 Zulip。

**实际发到 Zulip 的消息**（Zulip 消息 ID 449）：
```
Approval or input requested.
```

**`interaction.request` 实际包含**（取自数据库）：
- `reason`: `"是否允许联网访问 SpecCompass 官方 GitHub 仓库，以核验截至 2026-07-19 的真实最新版本和安装入口？"`
- `availableDecisions`: `["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]`
- `command`: `/bin/zsh -lc "gh api repos/flyfoxai/SpecCompass/releases/latest ..."`
- `cwd`: `/Users/hula/Projects/stockprofits`
- `interactionId`: `interaction-2c61847e-0f43-404b-ab5b-a41cfaacc777`
- `allowedResponderIds`: `[8]`（即 Boss）

**正确的审批命令格式**（plugin.py 第 693–703 行）：
```
/codex approve <replyToken> <choice>
```
例：`/codex approve interaction-2c61847e-0f43-404b-ab5b-a41cfaacc777 accept`

**现有测试盲区**：`test/option-c-e2e.test.js:321` 直接从函数返回值取得 interaction ID，未验证 Zulip 消息内容是否包含可操作信息。

### 修复方案

**修改文件**: `hco/turn-controller.js`

将 `defaultInteractionRenderer` 替换为能生成结构化、可操作消息的实现。

**目标输出格式**（`payload.content`）：

```
⚠️ **[{projectId}] 审批请求**

**原因**: {reason}
**项目目录**: `{cwd}`

**待审批命令**:
\`\`\`
{command}
\`\`\`

**审批操作**（在本话题回复）：
{每个 decision 一行，格式如下}
- 批准：`/codex approve {interactionId} accept`
- 取消：`/codex approve {interactionId} cancel`

_interaction ID: `{interactionId}`_
```

**实现要点**：
1. renderer 接收 `{ interaction }` 对象，从 `interaction.request` 提取 reason、command、cwd、availableDecisions
2. 从 `interaction.interactionId` 构建每个 decision 对应的完整 `/codex approve` 命令
3. `content` 字段为 Markdown 格式（Zulip 支持 Markdown）
4. `availableDecisions` 中的对象类型（如 `acceptWithExecpolicyAmendment`）只展示其 key 作为 choice，不展开内部内容
5. `semanticKey` 不变：`interaction:${interaction.interactionId}:prompt`
6. `kind` 不变：`interaction_request`（sidecar 不依赖 kind 字段过滤消息，只取 content）

**`index.js` 是否需要改动**：不需要。`createController` 默认使用 `defaultInteractionRenderer`，只修改 turn-controller.js 即可覆盖所有场景。

**测试需同步更新**：`test/option-c-e2e.test.js:321` 附近需增加断言，验证 outbox 消息 `payload.content` 包含 interactionId 和 `/codex approve` 命令字符串。

---

## BUG-2：跨项目 semantic 上下文污染

### 根因链

```
全局 Hermes config.yaml (line ~601)
  default terminal cwd = /Users/hula/workspace/ASK
    ↓
codex-bridge profile 未覆盖 terminal cwd
    ↓
plugin.py:1472 channel_prompt 仅要求调用 hco_dispatch，
  未显式注入可信 projectId 和 cwd
    ↓
Hermes LLM (Jarvis PM) 生成 DISPATCH semantic 时受默认上下文影响，
  在 instruction 正文中写入 "ASK 仓库"、"ASK 项目"
    ↓
plugin.py:1598 hco_dispatch_handler 验证 semantic 结构合法性，
  但不检查 instruction 正文是否与可信 projectId 冲突
    ↓
HCO service.js:313 executionOptions 使用可信路由设置真实 cwd，
  但将模型生成正文 text 原样提交给 Codex
    ↓
Codex 在 /Users/hula/Projects/stockprofits 执行，
  但收到的指令说"在 ASK 仓库中操作"
```

**实际发生了两次**（inbound_intents 中的 message 447 和 468 均包含 ASK 相关正文）。

**执行路由始终正确**：stream 5 → stockprofits，cwd 为 `/Users/hula/Projects/stockprofits`，审批命令 cwd 也为 stockprofits。本次任务在联网审批处停住，**未实际写入 ASK**，但如果指令包含 ASK 绝对路径，当前机制无法阻止 Codex 主动访问 ASK。

### 修复方案

本缺陷需要两层修复：

#### 层 1（HCO/plugin 防御层）—— 冲突检测拦截

**修改文件**: `plugin/hermes-codex-bridge/plugin.py`，`hco_dispatch_handler` 函数（约第 1598 行）

在 `_valid_semantic(semantic)` 通过后、提交给 HCO 之前，增加可信 projectId 一致性检查：

```python
# 伪代码
def _instruction_references_foreign_project(instruction_text, trusted_project_id, all_project_cwds):
    """
    检测 instruction 正文是否包含其他项目的 projectId 或 cwd 路径。
    """
    for pid, cwd in all_project_cwds.items():
        if pid == trusted_project_id:
            continue
        if pid.lower() in instruction_text.lower():
            return True, pid
        if cwd and cwd in instruction_text:
            return True, pid
    return False, None
```

如果检测到污染，**拒绝提交并向 Boss 回复警告消息**，而不是静默执行：
```
⚠️ 指令上下文冲突：任务路由到 {trusted_project_id}，
但指令正文引用了 {foreign_project_id}。已拒绝执行。
请重新在正确的项目频道发起请求，或联系 Jarvis PM。
```

**所需信息来源**：NLP 上下文 token 中已有 `projectId`（可信），项目 cwd 映射可从 route_snapshot（`routeSnapshotPath`）读取。

#### 层 2（Hermes prompt 根本修复）—— 注入可信上下文

**修改文件**: `plugin/hermes-codex-bridge/plugin.py`，`pre_gateway_dispatch` 中生成 `channel_prompt` 的部分（约第 1472 行）

在 channel_prompt 中显式注入当前路由上下文：

```python
# 当前：
event.channel_prompt = (
    "Hermes Codex bridge context.\n"
    "For executable project work, call hco_dispatch exactly once with the "
    "strict semantic object. For ordinary conversation, answer normally without "
    "calling hco_dispatch."
)

# 修改后：
event.channel_prompt = (
    f"Hermes Codex bridge context.\n"
    f"Current project: {context.project_id}. "
    f"Project working directory: {project_cwd}. "
    f"When generating hco_dispatch instruction, MUST reference this project "
    f"({context.project_id}) and its working directory ({project_cwd}). "
    f"Do NOT reference any other project name or path.\n"
    f"For executable project work, call hco_dispatch exactly once with the "
    f"strict semantic object. For ordinary conversation, answer normally without "
    f"calling hco_dispatch."
)
```

`project_cwd` 的来源：`Route` 数据类（route_snapshot.py）不含 cwd 字段。cwd 需从 HCO 配置文件（`hco.json`）读取——plugin 已通过 `_load_registration_config()` 知道配置文件路径，在 hook 闭包初始化时一次性解析 `config["projects"]` 列表，构建 `{project_id: cwd}` 映射即可。

> **Codex 审查修正**：v1.0 草稿中"从 route_snapshot 查找 cwd"表述有误，已更正为从 hco.json 读取。route_snapshot 中 `Route` 只有 stream_id/owner/project_id/source/topics，无 cwd。

**注意**：层 2 是根本修复，需要理解 Hermes channel_prompt 的作用域和注入机制。如果 channel_prompt 确实传递给了 Hermes LLM，层 2 可阻断问题源头。如果无法确认，层 1 作为防御兜底仍然必要。

---

## BUG-3：任务已接受但响应失败后显示 "bridge unavailable"

### 现象

`objective-1582ad91`（ASK，stream 4）已成功创建并运行，但 Boss 在 Zulip 消息 455 收到：
```
Codex bridge unavailable.
```

### 根因

`plugin.py:hco_dispatch_handler`（约第 1632 行）：

```python
try:
    result = await client.submit(event)
except BridgeUnavailableError:
    return "Codex bridge unavailable."
```

当 HCO 提交成功但 HTTP 响应超时，或提交后 bridge 连接断开时，客户端抛出 `BridgeUnavailableError`，直接向 Zulip 回复错误文本。此时 HCO 侧任务已创建（objective_id 已存在），但 Boss 无法知道任务实际已在运行。

### 修复方案

**修改文件**: `plugin/hermes-codex-bridge/plugin.py`，`hco_dispatch_handler`

在 `BridgeUnavailableError` 捕获中，尝试从本地状态或 pending_vault 中恢复 objectiveId（如果已知），并在错误消息中附加提示：

```python
except BridgeUnavailableError:
    # 如果能从 entry.context 或提交前状态恢复 objectiveId
    # 则告知 Boss 任务可能已提交
    return (
        "Codex bridge 响应异常。任务可能已提交，请稍后用 `/codex status` 查询状态。"
        "\n如任务未出现，请重新发起。"
    )
```

如无法恢复 objectiveId，至少改为更清晰的提示，避免误导 Boss 认为"什么都没发生"。

**更完善的方案**（可选）：在 HCO 侧 `service.js` 的 `dispatch()` 返回结果中包含 `objectiveId`，plugin 在 `BridgeUnavailableError` 前已记录该 ID，可在错误消息中引用。

---

## 修复优先级

| 优先级 | 缺陷 | 理由 |
|--------|------|------|
| P0 | BUG-2 层 1（冲突检测拦截） | 防止 Codex 访问错误项目，保护数据安全 |
| P1 | BUG-1（审批通知完善） | 审批卡死会导致任务永久挂起 |
| P2 | BUG-2 层 2（channel_prompt 注入） | 根本解决 LLM 上下文混淆 |
| P3 | BUG-3（可观测性补偿） | 影响用户体验，但不影响正确性 |

---

## 文件改动范围

| 文件 | 改动类型 | 涉及缺陷 |
|------|----------|----------|
| `hco/turn-controller.js` | 修改 `defaultInteractionRenderer` | BUG-1 |
| `plugin/hermes-codex-bridge/plugin.py` | 增加 `_instruction_references_foreign_project`，修改 `hco_dispatch_handler`，修改 `pre_gateway_dispatch` channel_prompt | BUG-2（两层），BUG-3 |
| `test/option-c-e2e.test.js` | 增加对 outbox content 的断言 | BUG-1 测试 |
| `test/hermes_plugin_contract_test.py`（若存在） | 增加跨项目 semantic 拒绝测试 | BUG-2 测试 |

---

## 不改动范围

- `hco/bridge/server.js` — 投递通道层正确，不需改动
- `plugin/hermes-codex-bridge/delivery_sidecar.py` — 原样投递 content，设计正确，不改动
- `hco/state/store.js` — 数据库状态机逻辑正确
- `hco/service.js` — 路由逻辑和 cwd 设置正确（BUG-2 根因在 plugin 层）
- Zulip 路由配置 — stream → project 映射正确

---

## 验收标准

### BUG-1
- [ ] 审批 Zulip 消息包含 reason、cwd、interactionId
- [ ] 每个 availableDecision 均有对应的 `/codex approve <id> <choice>` 命令
- [ ] Boss 只凭 Zulip 消息即可完成审批，无需其他信息
- [ ] 测试验证 outbox payload.content 包含 interactionId

### BUG-2
- [ ] 当 DISPATCH 指令正文包含其他项目名或路径时，hco_dispatch_handler 拒绝提交并回复警告
- [ ] channel_prompt 显式包含当前 projectId 和 cwd
- [ ] 连续两次 stockprofits 消息不再生成 ASK 引用

### BUG-3
- [ ] bridge 响应异常时，提示语明确区分"未提交"和"已提交但响应失败"两种情况

---

*文档生成时间: 2026-07-19*  
*待 Codex 审查后方可开始实施*
