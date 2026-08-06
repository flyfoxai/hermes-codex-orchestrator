# HCO 频道与话题管理操作手册

> **适用版本**：Option C (HCO + Hermes Bridge Plugin)  
> **配置文件**：`~/.hco/hco.json`  
> **路由快照**：`~/.hco/zulip-routes-option-c.json`（HCO 自动生成，勿手动编辑）

---

## 目录

1. [系统架构速览](#1-系统架构速览)
2. [新增频道（Stream）](#2-新增频道stream)
3. [删除频道（Stream）](#3-删除频道stream)
4. [新增话题（Topic）](#4-新增话题topic)
5. [删除话题（Topic）](#5-删除话题topic)
6. [配置文件参考](#6-配置文件参考)
7. [常用命令速查](#7-常用命令速查)
8. [决策流程图](#8-决策流程图)

---

## 1. 系统架构速览

```
Zulip 用户消息
      │
      ▼
Hermes Gateway (zulip-ingress)
      │  读取路由快照
      ▼
Hermes Codex Bridge Plugin (plugin.py)
      │  根据 stream_id 解析项目路由
      ├─ 已登记 stream ──► hco_dispatch ──► HCO service ──► Codex App Server
      └─ 未登记 stream ──► Hermes 直接回复（无 Codex）
```

### 关键映射关系

| 配置项 | 作用 |
|--------|------|
| `staticStreamIds` | Zulip 数字 stream ID → 绑定的 projectId |
| `cwd` | Codex 运行工作目录（绝对路径，**必须已存在**） |
| `acl.contributors` | 可向该项目发消息的 Zulip 用户 ID |
| `admins` | 顶级管理员（可执行所有管理操作） |

### 全局默认收件人规则

所有 Zulip stream/topic 使用同一套收件人规则，不能按频道单独放宽：

1. 消息没有任何 Zulip 原生 mention 时，视为发给配置的默认收件人。默认值是 `self`，即当前 `zulip-ingress` bot（现网为 Jarvis PM）。
2. 消息包含一个或多个原生 mention 时，不再隐式追加默认收件人。只 mention 其他用户或用户组时，Jarvis 不创建 session、不调用模型、不回复。
3. 显式 mention Jarvis 时正常处理；同时 mention Jarvis 和其他人仍只触发一次 Jarvis。Zulip 的 `@all`/`@everyone` 保持显式通配 mention 语义。
4. 一对一或群组 DM 已由 Zulip 收件人列表明确寻址，不使用 stream 的默认 mention 规则。

推荐在 `~/.hermes/profiles/zulip-ingress/config.yaml` 配置：

```yaml
platforms:
  zulip:
    extra:
      default_addressee: self
```

也可以在该 profile 的 owner-only `.env` 中设置 `ZULIP_DEFAULT_ADDRESSEE`。支持 `self`、当前 bot 的完整名称、email 或数字 user ID；`none`、`disabled`、`off` 表示没有默认收件人。`extra.default_addressee` 的优先级高于环境变量。安装器只在其拥有的 `zulip-ingress` 上启用这项策略，不会让同一 Hermes 进程中的其他 bot 自动继承 `self`。若指定另一个 bot，当前 ingress 会忽略无 mention 消息；目标 bot 必须在自己的 profile 中显式启用同一策略，使用自己的凭据和唯一 inbound poller，不能复用同一 credential 启动第二个 poller。

### 话题路由模式

| 模式 | 含义 |
|------|------|
| `CODEX_BOUND` | 消息转发给 Codex 执行 |
| `HERMES_ONLY` | 仅 Hermes 处理，不转 Codex |
| `AUTO`（默认）| 未显式指定时，跟随 stream 级别规则 |

### 当前 Stream 配置

| Stream ID | 频道名称 | 绑定项目 | 工作目录 |
|-----------|----------|----------|----------|
| 3 | general | 无（Hermes 直接处理） | — |
| 4 | ASK项目 | `ASK` | `/Users/hula/workspace/ASK` |
| 5 | 量化交易 | `stockprofits` | `/Users/hula/Projects/stockprofits` |

---

## 2. 新增频道（Stream）

### 2.1 触发场景

在 Zulip 中创建了新 stream，需要决定是否接入 Codex 项目。

### 2.2 交互式向导——主动询问以下问题

操作人员或 bot 应在 Zulip 的 **general 频道**主动发起以下问答：

---

**【Q1】该频道的用途是什么？**

```
A. 新项目专属频道（需绑定 Codex 工作目录）
B. 现有项目的附加频道（绑定已有项目）
C. 纯对话频道（仅 Hermes 回答，不需要 Codex）
```

→ 选 C：无需任何操作，结束。

---

**【Q2】该频道的 Zulip 数字 Stream ID 是多少？**

```
获取方式：Zulip 频道设置 → 频道信息 → Stream ID（纯数字）
例：stream ID = 6
```

---

**【Q3】（选 A）项目工作目录路径是什么？是否需要新建目录？**

```
期望路径：/Users/hula/Projects/______（绝对路径）

A. 已有目录，直接填写路径
B. 需要新建，路径为：____________
```

> ⚠️ `hco.json` 要求目录必须已存在，配置前必须先建好目录。

---

**【Q4】项目 ID（projectId）用什么名称？**

```
规则：字母/数字开头，可包含 . _ -，最长 64 字符
示例：new-project、trading_v2、myApp
```

---

**【Q5】哪些 Zulip 用户 ID 可以使用该项目？**

```
viewers（查看）：[  ]
contributors（发任务，推荐普通用户）：[  ]
maintainers（修改配置）：[  ]

通常三个填相同用户 ID 即可，例：[8]
```

> 获取用户 ID：Zulip → 点击头像 → Profile → User ID

---

**【Q6】配置完成后，是否立即创建 Codex 对话线程进行测试？**

```
A. 是，配置后向该频道 general chat 话题发送初始化测试消息
B. 否，等用户首次发消息时自动创建
```

---

### 2.3 操作步骤

#### 步骤 1：创建工作目录（如需）

```bash
mkdir -p /path/to/new-project
ls -la /path/to/new-project   # 确认存在
```

#### 步骤 2：编辑 `~/.hco/hco.json`，在 `projects` 数组末尾追加

如果需要指定模型或推理深度，先通过 HCO bridge 查询当前 Codex 源可用清单：

```bash
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  "http://localhost/v1/models?includeHidden=false&limit=100"
```

从返回的 `result.models[].id` 选择 `threadOptions.model`，从同一模型的 `supportedReasoningEfforts` 选择 `threadOptions.modelReasoningEffort`。不要用旧文档或记忆里的模型名替代运行时查询结果。

```json
{
  "projectId": "your-project-id",
  "cwd": "/path/to/new-project",
  "backend": "app-server",
  "staticStreamIds": [6],
  "acl": {
    "viewers": [8],
    "contributors": [8],
    "maintainers": [8]
  },
  "threadOptions": {
    "model": "gpt-5",
    "modelReasoningEffort": "high",
    "approvalPolicy": "on-request",
    "sandbox": "workspace-write"
  }
}
```

> **注意**：`staticStreamIds` 中的 stream ID 在所有项目中全局唯一。

#### 步骤 3：重启 HCO 使配置生效

```bash
launchctl stop com.hermes.codex-bridge-hco
sleep 2
launchctl start com.hermes.codex-bridge-hco
sleep 3

# 验证
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  http://localhost/v1/health
# 预期：{"status":"ok","appServer":{"available":true}}
```

#### 步骤 4：验证路由快照已更新

```bash
cat /Users/hula/.hco/zulip-routes-option-c.json | python3 -m json.tool | grep -A5 '"streamId"'
```

#### 步骤 5：（可选）发送测试消息

在 Zulip 新频道的 `general chat` 话题发送：
```
请确认当前 projectId 和工作目录。
```
预期回复中应出现新配置的 `projectId` 和 `cwd` 路径。

---

### 2.4 为现有项目新增频道

只需在现有项目的 `staticStreamIds` 中追加新 stream ID：

```json
"staticStreamIds": [4, 7]   // 原来 [4]，新增 7
```

然后重启 HCO（步骤 3）。

---

## 3. 删除频道（Stream）

### 3.1 触发场景

Zulip stream 废弃，需解除 HCO 绑定，并决定工作目录处理方式。

### 3.2 前置检查——主动询问以下问题

---

**【Q1】该频道是否有正在进行中的 Codex 任务（objective）？**

```bash
sqlite3 /Users/hula/.hco/hco.sqlite3 \
  "SELECT objectiveId, projectId, status FROM objectives
   WHERE projectId='your-project-id'
   AND status NOT IN ('done','cancelled');"
```

```
若有进行中的任务：
A. 等待任务完成后再删除
B. 立即取消（接受数据丢失风险）
```

---

**【Q2】工作目录如何处理？**

```
A. 保留（推荐）：仅解除 HCO 绑定，文件不动
B. 归档：移动到备份位置（如 ~/archives/old-project-YYYYMMDD/）
C. 删除：永久删除（⚠️ 不可恢复，需二次确认）
```

---

**【Q3】是否将整个项目从 hco.json 删除，还是只移除 stream 绑定？**

```
A. 完全删除（projectId 从系统移除）
B. 仅移除 stream 绑定（保留 projectId，待重新分配）
```

---

### 3.3 操作步骤

#### 步骤 1：编辑 `~/.hco/hco.json`

**选 A（完全删除）**：从 `projects` 数组中移除整个项目对象。

**选 B（仅移除绑定）**：清空或减少 `staticStreamIds`：
```json
"staticStreamIds": []
```

#### 步骤 2：重启 HCO

```bash
launchctl stop com.hermes.codex-bridge-hco && sleep 2 && launchctl start com.hermes.codex-bridge-hco
```

#### 步骤 3：（可选）归档工作目录

```bash
mkdir -p ~/archives
mv /path/to/old-project ~/archives/old-project-$(date +%Y%m%d)/
```

#### 步骤 4：验证路由已解除

```bash
# 确认旧 stream ID 不再出现
cat /Users/hula/.hco/zulip-routes-option-c.json | grep '"streamId"'
```

---

## 4. 新增话题（Topic）

### 4.1 默认行为（大多数情况无需操作）

新话题在 Zulip 中首次发消息时自动出现。路由行为取决于所在 stream：

| Stream 状态 | 新话题默认行为 |
|-------------|----------------|
| 已绑定 Codex 项目 | 自动 `CODEX_BOUND`，转发给 Codex |
| 未绑定项目 | 自动 `HERMES` 处理，不经过 Codex |

**通常只需在话题下发消息，系统会自动路由，无需额外配置。**

---

### 4.2 需要显式配置的场景

以下场景需要主动询问和配置：

#### 场景 A：在已绑定 Codex 的频道中，某话题需要**只用 Hermes 回答**（不走 Codex）

例：ASK 项目频道（stream 4）中有"公告"话题，只需 Hermes 直接回复。

#### 场景 B：在某话题下，需要**为这个话题建立独立的 Codex 工作线程**

例：stream 4 下新建"v2功能开发"话题，希望它有独立的 Codex objective，与其他话题隔离。

---

### 4.3 交互式向导（显式配置场景）

---

**【Q1】话题名称是什么？在哪个频道（stream ID）？**

```
话题名：____________
Stream ID：____________
```

---

**【Q2】期望的路由模式？**

```
A. CODEX_BOUND：该话题消息转给 Codex 执行
B. HERMES_ONLY：该话题消息只由 Hermes 处理
C. 恢复 AUTO：移除显式配置，跟随 stream 默认规则
```

---

**【Q3】（选 A，且所在 stream 未绑定项目）要绑定到哪个 projectId？**

```
projectId：____________
```

---

**【Q4】是否需要立即触发一次 Codex 任务来初始化该话题的线程？**

```
A. 是，向该话题发送初始化消息
B. 否，等首次自然消息时自动初始化
```

---

### 4.4 话题模式配置

话题路由模式由 HCO 内部状态管理，通过 bridge 命令设置（需管理员权限）：

- **操作方式**：在对应话题内，由管理员账号通过 Hermes 发送配置命令
- **生效时间**：路由快照 TTL 60 秒内自动刷新

### 4.5 验证

```bash
# 查看路由快照中的话题模式
cat /Users/hula/.hco/zulip-routes-option-c.json | python3 -m json.tool | grep -A3 '"topics"'

# 监控 bridge 活动
tail -f ~/.hermes/logs/agent.log | grep -E "hco_dispatch|CODEX_BOUND|HERMES_ONLY"
```

---

## 5. 删除话题（Topic）

### 5.1 通常无需操作

话题被删除后，不会有新消息进来，系统自然停止处理。以下资源会自动清理：
- Hermes session 缓存：idle TTL（3600s）后自动过期
- 路由快照：TTL 到期后自动刷新

### 5.2 主动询问场景

---

**【Q1】该话题是否有正在进行中的 objective？**

```bash
sqlite3 /Users/hula/.hco/hco.sqlite3 \
  "SELECT objectiveId, status FROM objectives
   WHERE topic='话题名称'
   AND status NOT IN ('done','cancelled');"
```

```
若有：
A. 等待完成
B. 通过 Hermes 发送 CANCEL 指令取消
```

---

**【Q2】是否需要清除该话题的显式路由配置（CODEX_BOUND/HERMES_ONLY）？**

```
通常不需要，路由快照会自动清理。
若需要立即清除：通过管理员命令重置该话题路由模式为 AUTO。
```

---

### 5.3 注意事项

- ⚠️ **不要直接修改 hco.sqlite3**，所有状态变更通过 HCO API 进行。
- 话题名称复用（删除后重建同名话题）时，HCO 将其视为全新话题。
- 工作目录中的文件与话题生命周期无关，不会被自动清理。

---

## 6. 配置文件参考

### 6.1 `~/.hco/hco.json` 完整结构

```json
{
  "version": 1,
  "codexExecutablePath": "/Users/hula/.npm-global/bin/codex",
  "databasePath": "/Users/hula/.hco/hco.sqlite3",
  "bridge": {
    "tokenPath": "/Users/hula/.hco/hco.bearer",
    "contextKeyPath": "/Users/hula/.hco/hco-context.key",
    "socketPath": "/Users/hula/.hco/hco.sock",
    "routeSnapshotPath": "/Users/hula/.hco/zulip-routes-option-c.json"
  },
  "snapshot": {
    "ttlMs": 60000,
    "maxBytes": 262144
  },
  "admins": [8],
  "projects": [
    {
      "projectId": "项目ID（唯一）",
      "cwd": "/绝对/工作目录（必须已存在）",
      "backend": "app-server",
      "staticStreamIds": [4],
      "acl": {
        "viewers": [8],
        "contributors": [8],
        "maintainers": [8]
      },
      "threadOptions": {
        "model": "gpt-5",
        "modelReasoningEffort": "high",
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write"
      }
    }
  ]
}
```

### 6.2 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectId` | string | 唯一标识，规则：`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` |
| `cwd` | string | **必须是已存在的绝对路径**（HCO 启动时会验证） |
| `backend` | string | `"app-server"`（默认）或 `"tmux"` |
| `staticStreamIds` | number[] | 绑定的 Zulip stream ID，**全局唯一** |
| `acl.viewers` | number[] | 可查看项目状态的 Zulip 用户 ID |
| `acl.contributors` | number[] | 可发起 Codex 任务的 Zulip 用户 ID |
| `acl.maintainers` | number[] | 可修改项目配置的 Zulip 用户 ID |
| `threadOptions.model` | string | （可选）指定 Codex 使用的模型；用 `/v1/models` 或 App Server `model/list` 查询当前源可用 ID |
| `threadOptions.modelReasoningEffort` | string | （可选）指定 Codex 推理深度；从对应模型的 `supportedReasoningEfforts` 中选择，HCO 会映射为 Codex App Server 的 `config.model_reasoning_effort` |
| `threadOptions.approvalPolicy` | string | `"untrusted"`、`"on-failure"`、`"on-request"` 或 `"never"` |
| `threadOptions.sandbox` | string | `"read-only"`、`"workspace-write"` 或 `"danger-full-access"` |
| `threadOptions.baseInstructions` | string | （可选）注入 Codex 的基础指令 |
| `threadOptions.developerInstructions` | string | （可选）注入 Codex 的 developer instructions |
| `admins` | number[] | 顶级管理员 Zulip 用户 ID |

模型目录查询是运行时只读能力，不参与 `hco.json` 加载校验。HCO 启动时只检查 `model` 和 `modelReasoningEffort` 是非空字符串；账号权限、模型下线、隐藏模型可见性或源端策略变化，会在实际创建/续接 Codex thread 时由 Codex App Server 决定。

---

## 7. 常用命令速查

### HCO 健康检查

```bash
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  http://localhost/v1/health
```

### 查询 Codex 模型和推理深度

```bash
curl --unix-socket /Users/hula/.hco/hco.sock \
  -H "Authorization: Bearer $(cat /Users/hula/.hco/hco.bearer)" \
  "http://localhost/v1/models?includeHidden=true&limit=100"
```

查看 `result.models[].id`、`supportedReasoningEfforts` 和 `defaultReasoningEffort`，再更新项目的 `threadOptions`。

### 服务管理

```bash
# 查看所有相关服务
launchctl list | grep -E "codex|hermes"

# 重启 HCO
launchctl stop com.hermes.codex-bridge-hco && sleep 2 && launchctl start com.hermes.codex-bridge-hco

# 重启投递代理
launchctl stop com.hermes.codex-bridge-delivery && sleep 1 && launchctl start com.hermes.codex-bridge-delivery

# 重启 Hermes Gateway
launchctl stop ai.hermes.gateway && sleep 2 && launchctl start ai.hermes.gateway
```

### 查看路由

```bash
# 当前路由快照
cat /Users/hula/.hco/zulip-routes-option-c.json | python3 -m json.tool

# 确认特定 stream 的路由
cat /Users/hula/.hco/zulip-routes-option-c.json | python3 -c \
  "import json,sys; d=json.load(sys.stdin); [print(r) for r in d['routes'] if r['streamId']==4]"
```

### 查看 Objective 状态

```bash
# 最近 20 条
sqlite3 /Users/hula/.hco/hco.sqlite3 \
  "SELECT objectiveId, projectId, status, streamId, topic FROM objectives ORDER BY rowid DESC LIMIT 20;"

# 进行中的任务
sqlite3 /Users/hula/.hco/hco.sqlite3 \
  "SELECT * FROM objectives WHERE status NOT IN ('done','cancelled');"
```

### 日志监控

```bash
# Gateway 实时日志
tail -f ~/.hermes/logs/gateway.log

# Bridge 活动（hco_dispatch 调用）
tail -f ~/.hermes/logs/agent.log | grep -E "hco_dispatch|bridge|rejected"

# HCO 错误
tail -50 ~/.hco/runner.err.log
```

---

## 8. 决策流程图

### 新增频道

```
新 Zulip stream 创建
        │
        ▼
    是否需要 Codex？
    /            \
   是              否
   │               └──► 无需操作（Hermes 直接处理）
   ▼
是否绑定新项目？
   /       \
  是         否
  │           └──► 在已有项目 staticStreamIds 追加新 ID → 重启 HCO
  ▼
创建工作目录（如需）
        │
        ▼
  编辑 hco.json 添加项目
        │
        ▼
    重启 HCO 服务
        │
        ▼
  验证路由快照更新
        │
        ▼
  发送测试消息确认 ✓
```

### 删除频道

```
要删除 Zulip stream
        │
        ▼
  是否有进行中的任务？
  /              \
 是               否
 │                │
 ▼                ▼
等待完成         工作目录如何处理？
或主动取消         │
  │          保留 / 归档 / 删除
  └────────────────┤
                   ▼
          编辑 hco.json
          移除 stream ID 或整个项目
                   │
                   ▼
            重启 HCO 服务
                   │
                   ▼
            验证路由已解除 ✓
```

### 新增话题

```
新 topic 首次出现
        │
        ▼
所在 stream 是否已绑定项目？
  /                    \
 是                     否
 │                      │
 ▼                      ▼
自动 CODEX_BOUND        自动 Hermes 处理
（无需操作）            （无需操作）
  │
  ▼
是否需要覆盖为 HERMES_ONLY？
  /      \
 是       否
 │         └──► 无需操作 ✓
 ▼
通过管理员命令
配置 HERMES_ONLY 模式
```

---

*文档生成时间：2026-07-19*  
*适用环境：Option C HCO + Hermes Bridge Plugin*
