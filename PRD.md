# Hermes Codex Orchestrator 产品需求文档

## 1. 背景

当前存在多种远程 AI 编程入口：

- Codex App：上下文管理和项目感知较完整，但依赖桌面界面。
- Codex CLI：适合远程服务器、tmux 和长任务，但交互体验偏终端。
- CC Pocket：适合移动端和 Windows 远程控制，但其会话上下文和 Codex App 原生上下文不完全一致。
- Hermes：适合作为消息入口、任务调度层、通知层和多端协作入口。

实际需求是：用户希望通过 Hermes 在手机、Windows 或其他聊天入口发起任务，但代码编写过程仍由远程服务器上的 Codex 自己完成上下文管理，包括读取项目规则、SpecCompass 状态、Git 状态、源码、测试结果和历史任务状态。

因此，本项目要构建一套编排层：Hermes 只负责指挥和调度，Codex 负责项目内上下文判断、代码修改、验证和状态回写。

## 2. 产品目标

### 2.1 核心目标

实现一个远程 AI 编程编排系统，使用户可以通过 Hermes 发起代码任务，并由远程服务器上的 Codex 在正确项目目录中执行任务。

系统必须保证：

- Hermes 不直接管理代码上下文。
- Codex 每次执行前从项目目录读取上下文事实。
- 任务状态、计划、决策和验证结果落盘到项目目录。
- 远程任务可在 Hermes、SSH、tmux、Codex CLI 之间保持可追踪。
- 即使 Hermes 客户端断开，远程 Codex 任务仍可继续执行。

### 2.2 设计原则

- 项目文件是事实源，不依赖聊天窗口记忆。
- Hermes 是调度器，不是代码上下文代理。
- Codex 是执行者，负责主动读取、判断和验证。
- Runner 是进程管理器，不参与业务代码决策。
- 所有任务都必须有明确任务文件、状态流转和验收标准。

## 3. 非目标

本项目不追求：

- 复刻 Codex App 的原生 UI。
- 让 Hermes 完整保存 Codex 的内部上下文。
- 让 CC Pocket、Codex App、Codex CLI 的会话列表完全一致。
- 让 Hermes 直接拼接大量源码上下文后调用通用 LLM 写代码。
- 替代 Git、SpecCompass、AGENTS.md 或项目内已有工程规范。

## 4. 用户角色

### 4.1 项目负责人

通过 Hermes 发起任务、查看进度、接收完成结果和风险提示。

### 4.2 Codex 执行代理

运行在远程服务器上，负责读取项目上下文、修改代码、运行验证、更新任务文件。

### 4.3 Runner 服务

运行在远程服务器上，负责根据 Hermes 任务启动或恢复对应项目的 Codex/tmux session。

### 4.4 Hermes Bot

负责接收用户消息、识别项目、创建任务文件、触发 Runner、读取任务结果并通知用户。

## 5. 总体架构

```text
用户
  |
  | Hermes 消息
  v
Hermes Bot
  |
  | 创建任务文件 / 更新任务状态
  v
项目目录 .hermes/tasks/
  |
  | 调用 Runner
  v
Codex Runner
  |
  | 启动或恢复 tmux + codex
  v
Codex CLI
  |
  | 读取项目规则、SpecCompass、Git、源码、测试
  v
项目目录 / Git / 状态文件
```

## 6. 上下文管理模型

### 6.1 上下文事实源

Codex 执行任务时，应按固定顺序读取上下文：

1. `AGENTS.md`：项目级工作规则。
2. `.speccompass/status.md`：当前项目阶段、完成度、开放问题。
3. `.speccompass/current-plan.md`：当前计划。
4. `.speccompass/decisions.md`：关键决策。
5. `.hermes/tasks/<task_id>.md`：当前任务文件。
6. `git status`：工作区状态。
7. 最近提交和相关源码。
8. 测试、构建、lint 配置。

Hermes 不负责解释这些文件，只负责告诉 Codex 当前任务文件路径。

### 6.2 上下文边界

Hermes 传给 Codex 的 prompt 应保持短小，只包含：

```text
项目路径
任务文件路径
任务 ID
是否允许修改代码
是否允许联网
期望输出语言
```

Codex 必须自行读取项目文件，而不是依赖 Hermes 消息里的摘要。

### 6.3 会话连续性

系统需要维护项目到 Codex session 的映射。

推荐文件：

```text
.hermes/sessions.json
```

示例：

```json
{
  "stockprofits": {
    "project_path": "/Users/hula/Projects/stockprofits",
    "tmux_session": "codex-stockprofits",
    "active_task_id": "HERMES-20260713-001",
    "last_codex_thread_id": "019f58ce-892a-7183-9263-8c08d07779cc",
    "updated_at": "2026-07-13T10:30:00+08:00"
  }
}
```

该文件只用于恢复入口，不作为代码上下文事实源。

## 7. 项目目录规范

每个被管理项目建议包含：

```text
project-root/
  AGENTS.md
  .speccompass/
    status.md
    current-plan.md
    decisions.md
    verification.md
  .hermes/
    project.json
    sessions.json
    tasks/
      HERMES-20260713-001.md
    logs/
      HERMES-20260713-001.log
```

### 7.1 `.hermes/project.json`

```json
{
  "project_id": "stockprofits",
  "project_name": "Stock Profits",
  "project_path": "/Users/hula/Projects/stockprofits",
  "default_runner": "codex",
  "default_tmux_session": "codex-stockprofits",
  "language": "zh-CN",
  "created_at": "2026-07-13T10:00:00+08:00"
}
```

### 7.2 任务文件格式

```md
# HERMES-20260713-001

Project: stockprofits
ProjectPath: /Users/hula/Projects/stockprofits
Status: pending
Owner: codex
CreatedAt: 2026-07-13T10:00:00+08:00
UpdatedAt: 2026-07-13T10:00:00+08:00
AllowCodeChanges: false
AllowNetwork: true

## Goal

检查当前项目进度，并确认 SpecCompass 是否为最新版。

## Constraints

- 先只读检查，不修改代码。
- 必须读取项目状态文件。
- 必须核对本地版本与官方最新版本。
- 输出中文结论。

## Acceptance Criteria

- 给出当前项目阶段。
- 给出当前完成度和未完成项。
- 给出本地 SpecCompass 版本。
- 给出官方最新版本。
- 明确是否需要升级。

## Codex Execution Log

待执行。

## Result

待填写。
```

## 8. 状态流转

任务状态：

```text
pending -> queued -> running -> waiting_user -> verifying -> completed
                              -> failed
                              -> cancelled
```

状态说明：

| 状态 | 含义 |
|---|---|
| pending | Hermes 已创建任务，但未交给 Runner |
| queued | Runner 已接收，等待 Codex session |
| running | Codex 正在读取上下文或执行任务 |
| waiting_user | Codex 需要用户确认或补充信息 |
| verifying | Codex 正在运行验证 |
| completed | 任务完成并写入结果 |
| failed | 执行失败，需记录原因 |
| cancelled | 用户取消 |

## 9. 关键流程

### 9.1 创建任务

1. 用户在 Hermes 中发送任务。
2. Hermes Bot 识别项目名或路径。
3. Hermes Bot 创建 `.hermes/tasks/<task_id>.md`。
4. Hermes Bot 将任务状态置为 `pending`。
5. Hermes Bot 调用 Runner。

### 9.2 启动或恢复 Codex

1. Runner 读取 `.hermes/project.json`。
2. Runner 检查 `.hermes/sessions.json`。
3. 如果项目 tmux session 存在，则向该 session 投递任务。
4. 如果不存在，则创建新的 tmux session。
5. Runner 在项目目录中启动 Codex CLI。
6. Runner 将状态更新为 `queued` 或 `running`。

### 9.3 Codex 执行协议

Codex 收到任务后必须执行：

1. 读取 `AGENTS.md`。
2. 读取 `.speccompass/` 状态文件。
3. 读取当前任务文件。
4. 检查 `git status`。
5. 制定执行计划。
6. 执行任务。
7. 运行必要验证。
8. 更新任务文件 `Codex Execution Log` 和 `Result`。
9. 如有代码变更，说明变更文件和验证结果。

### 9.4 通知结果

1. Hermes Bot 监听任务文件状态变化，或轮询 Runner。
2. 任务完成后读取 `Result`。
3. Hermes Bot 将结果摘要发送给用户。
4. 如任务失败，发送失败原因、日志路径和建议下一步。

## 10. 功能需求

### 10.1 Hermes Bot

- 支持通过项目别名识别项目。
- 支持创建任务文件。
- 支持查询任务状态。
- 支持取消任务。
- 支持查看最近任务。
- 支持将 Codex 输出摘要发送回 Hermes。

### 10.2 Runner

- 支持远程服务器本地运行。
- 支持 tmux session 创建、检查、恢复。
- 支持按项目路径启动 Codex。
- 支持将任务 prompt 投递到已有 Codex session。
- 支持记录 Runner 日志。
- 支持防止同一项目并发写代码冲突。

### 10.3 Codex 执行规范

- 每次任务先读项目规则。
- 每次任务先检查 Git 状态。
- 有代码改动必须运行验证。
- 必须更新任务文件。
- 遇到高风险操作必须进入 `waiting_user`。
- 不允许仅依赖 Hermes 聊天历史做代码判断。

### 10.4 状态监控

- 支持查看运行中的任务。
- 支持查看最近完成任务。
- 支持查看失败任务和错误原因。
- 支持查看对应 tmux session 名称。

## 11. 非功能需求

### 11.1 可靠性

- Hermes 客户端断开不影响远程任务继续执行。
- Runner 重启后可以通过 `.hermes/sessions.json` 恢复任务映射。
- 任务文件必须可人工阅读和编辑。

### 11.2 可审计性

- 每个任务必须有唯一 ID。
- 每个任务必须记录创建时间、更新时间、状态和结果。
- 代码变更必须能通过 Git diff 审计。

### 11.3 安全性

- Hermes 不应直接暴露 shell 执行能力给普通用户。
- Runner 只能访问白名单项目目录。
- 高风险命令必须要求人工确认。
- API Key 不写入任务文件。
- 日志中必须避免记录密钥、token 和敏感环境变量。

### 11.4 可移植性

- MVP 优先支持 macOS 远程主机。
- 后续支持 Linux。
- Windows 作为控制端，不作为 Runner 首选运行环境。

## 12. 并发策略

默认策略：同一项目同一时间只允许一个写代码任务运行。

并发规则：

- 只读任务可以并发。
- 写代码任务必须串行。
- 如已有写任务运行，新写任务进入 `queued`。
- 如果用户强制并发，Runner 必须创建独立 Git worktree。

## 13. 错误处理

### 13.1 Codex 启动失败

记录：

- Codex 路径。
- Codex 版本。
- PATH。
- 当前工作目录。
- 错误输出。

### 13.2 项目上下文缺失

如果缺少 `AGENTS.md` 或 `.speccompass/status.md`，Codex 应继续执行但记录风险。

### 13.3 Git 状态不干净

Codex 必须说明：

- 哪些文件已有改动。
- 是否看起来与当前任务相关。
- 是否可以继续。

### 13.4 验证失败

Codex 必须记录：

- 执行的验证命令。
- 失败摘要。
- 已尝试的修复。
- 剩余风险。

## 14. MVP 范围

### 14.1 MVP 必须实现

- 项目注册文件 `.hermes/project.json`。
- 任务文件创建。
- tmux session 启动。
- Codex CLI 启动。
- 任务投递。
- 状态文件更新。
- Hermes 查询任务状态。

### 14.2 MVP 暂不实现

- 图形化任务看板。
- 多用户权限系统。
- 自动代码评审。
- 自动创建 GitHub PR。
- 复杂 worktree 并发调度。

## 15. 验收标准

MVP 完成后，应能验证：

1. 用户通过 Hermes 发起 `stockprofits` 项目任务。
2. 系统在项目目录创建 `.hermes/tasks/<task_id>.md`。
3. Runner 在远程服务器启动或恢复 `tmux`。
4. Codex 在正确项目路径运行。
5. Codex 读取项目规则和 SpecCompass 状态。
6. Codex 完成任务后更新任务文件。
7. Hermes 能读取结果并通知用户。
8. 断开 Hermes 客户端后，远程任务仍可继续。

## 16. 推荐技术实现

### 16.1 Hermes Bot

- 使用现有 Hermes 消息处理框架。
- 将项目别名映射到远程项目路径。
- 通过 SSH、HTTP API 或本地队列触发 Runner。

### 16.2 Runner

推荐实现为远程主机上的轻量 Node.js 或 Python 服务。

基础命令：

```bash
tmux has-session -t codex-stockprofits
tmux new-session -d -s codex-stockprofits -c /Users/hula/Projects/stockprofits
tmux send-keys -t codex-stockprofits 'codex' C-m
```

任务投递：

```bash
tmux send-keys -t codex-stockprofits '请读取 .hermes/tasks/HERMES-20260713-001.md 并按项目规则执行。' C-m
```

### 16.3 Codex 配置

Runner 启动 Codex 前必须固定环境：

```bash
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/hula"
cd /Users/hula/Projects/stockprofits
codex
```

## 17. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Codex 和 Hermes 上下文不一致 | 任务误判 | 以上下文文件为事实源 |
| 多任务同时改同一项目 | 代码冲突 | 默认串行，必要时 worktree |
| tmux session 丢失 | 任务中断 | 任务文件落盘，支持重新投递 |
| Codex CLI 版本不一致 | 工具行为不同 | Runner 固定 PATH 和版本检查 |
| Hermes 误识别项目 | 任务跑错目录 | 项目别名白名单和人工确认 |
| 日志泄露密钥 | 安全风险 | 日志脱敏，禁止写入 API Key |

## 18. 后续路线图

### 阶段 1：文件协议和手动 Runner

- 建立 `.hermes/` 目录规范。
- 手动创建任务文件。
- 手动用 tmux 投递给 Codex。

### 阶段 2：Runner 自动化

- 实现任务队列。
- 实现 tmux session 自动创建和恢复。
- 实现状态轮询。

### 阶段 3：Hermes 集成

- Hermes 支持创建任务。
- Hermes 支持查询进度。
- Hermes 支持通知完成结果。

### 阶段 4：工程增强

- 支持 Git worktree 并发。
- 支持任务看板。
- 支持自动 PR。
- 支持失败任务重试。

## 19. 关键结论

本项目的正确方向不是让 Hermes 接管 Codex 上下文，而是让 Hermes 指挥 Codex 去项目里重新建立上下文。

最终系统应满足：

```text
Hermes 负责发号施令。
Runner 负责启动和恢复。
Codex 负责理解项目和写代码。
项目目录负责保存事实。
```

这样可以同时获得 Hermes 的多端入口能力，以及 Codex 在代码项目中的上下文管理能力。

