# Hermes Codex Orchestrator 开发计划

## 1. 开发目标

本计划用于把 `PRD.md` 落地为可实现的 MVP。

MVP 的核心不是先做复杂平台，而是先打通最小闭环：

```text
Hermes 产生任务
  -> 项目目录落盘任务文件
  -> Runner 启动或恢复 tmux + Codex
  -> Codex 读取任务文件和项目上下文
  -> Codex 更新任务状态
  -> Hermes 读取结果并通知用户
```

## 2. 文件设计总览

建议 MVP 至少需要 15 个核心文件，分为 6 类：

| 类别 | 文件数 | 目的 |
|---|---:|---|
| 项目配置 | 2 | 注册项目和全局运行配置 |
| 任务协议 | 3 | 定义任务结构、状态流转和模板 |
| Runner 实现 | 4 | 管理 tmux、Codex 启动、任务投递和状态更新 |
| Hermes 适配 | 3 | 接收 Hermes 消息、创建任务、查询结果 |
| Codex 指令模板 | 1 | 约束 Codex 每次如何读取上下文和回写结果 |
| 文档与运维 | 2 | 安装、运行、排错 |

## 3. 推荐目录结构

```text
hermes-codex-orchestrator/
  README.md
  PRD.md
  DEVELOPMENT_PLAN.md
  config/
    orchestrator.json
    projects.json
  templates/
    task.md
    codex-dispatch-prompt.md
  schemas/
    task.schema.json
    project.schema.json
  runner/
    index.js
    config.js
    task-store.js
    tmux.js
    codex.js
    logger.js
  hermes/
    bot-adapter.js
    commands.js
    notifier.js
  docs/
    setup.md
    operations.md
```

说明：目录结构先按 Node.js 设计，因为远程主机已有 Node 环境，且 CC Pocket / Hermes 生态更容易对接 JS。后续如果要改 Python，协议文件和模板仍可复用。

## 4. 核心文件清单

### 4.1 `config/orchestrator.json`

目的：保存编排器全局配置。

负责内容：

- 默认 shell 环境。
- Codex CLI 路径或 PATH。
- tmux 默认前缀。
- 任务 ID 生成规则。
- 日志目录。
- 是否允许联网。
- 是否允许自动创建项目 `.hermes/` 目录。

示例字段：

```json
{
  "defaultLanguage": "zh-CN",
  "codexPath": "codex",
  "pathEnv": "$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  "tmuxPrefix": "codex",
  "taskIdPrefix": "HERMES",
  "logLevel": "info"
}
```

### 4.2 `config/projects.json`

目的：保存 Hermes 可调度的项目白名单。

负责内容：

- 项目 ID。
- 项目显示名称。
- 远程项目路径。
- 默认 tmux session。
- 是否允许写代码。
- 是否允许并发。

示例字段：

```json
{
  "stockprofits": {
    "name": "Stock Profits",
    "path": "/Users/hula/Projects/stockprofits",
    "tmuxSession": "codex-stockprofits",
    "allowCodeChanges": true,
    "allowNetwork": true,
    "concurrency": "single-writer"
  }
}
```

### 4.3 `templates/task.md`

目的：定义每个 Hermes 任务落盘后的 Markdown 模板。

负责内容：

- 任务元数据。
- 用户目标。
- 约束。
- 验收标准。
- Codex 执行日志。
- 最终结果。

该文件是 Codex 和 Hermes 之间最重要的任务契约。

### 4.4 `templates/codex-dispatch-prompt.md`

目的：定义 Runner 投递给 Codex 的固定提示词。

负责内容：

- 告诉 Codex 当前项目路径。
- 告诉 Codex 当前任务文件。
- 要求 Codex 先读 `AGENTS.md`、`.speccompass/`、任务文件、Git 状态。
- 要求 Codex 执行后回写任务文件。
- 要求 Codex 不依赖 Hermes 聊天上下文。

示例核心内容：

```text
你现在在 {project_path}。
请读取 {task_file} 并按项目规则执行。
必须先读取 AGENTS.md、.speccompass 状态文件和 git status。
执行完成后更新任务文件中的 Codex Execution Log 和 Result。
```

### 4.5 `schemas/task.schema.json`

目的：定义任务数据结构，供程序校验。

负责内容：

- task_id 格式。
- project_id 必填。
- status 枚举。
- allow_code_changes 布尔值。
- allow_network 布尔值。
- created_at / updated_at 时间格式。

注意：即使任务主体是 Markdown，也建议在 front matter 或解析结果上做 schema 校验。

### 4.6 `schemas/project.schema.json`

目的：定义项目注册结构，防止 Hermes 跑错目录。

负责内容：

- project_id。
- project_path。
- tmux_session。
- allow_code_changes。
- concurrency。
- language。

### 4.7 `runner/index.js`

目的：Runner 的命令入口。

负责内容：

- 解析命令行参数。
- 加载配置。
- 执行 `create-task`、`dispatch-task`、`status`、`cancel` 等命令。
- 调用其他 runner 模块。

建议命令：

```bash
node runner/index.js create-task --project stockprofits --goal "检查项目进度"
node runner/index.js dispatch-task --task HERMES-20260713-001
node runner/index.js status --task HERMES-20260713-001
```

### 4.8 `runner/config.js`

目的：统一读取和校验配置。

负责内容：

- 读取 `config/orchestrator.json`。
- 读取 `config/projects.json`。
- 校验项目路径是否在白名单。
- 生成 tmux session 名。
- 生成项目 `.hermes/` 路径。

### 4.9 `runner/task-store.js`

目的：管理任务文件。

负责内容：

- 创建 `.hermes/tasks/<task_id>.md`。
- 更新任务状态。
- 读取任务结果。
- 追加 Codex 执行日志。
- 创建 `.hermes/logs/<task_id>.log`。

这是系统的持久化核心。

### 4.10 `runner/tmux.js`

目的：封装 tmux 操作。

负责内容：

- 检查 tmux 是否存在。
- 检查 session 是否存在。
- 创建 session。
- 发送命令到 session。
- 捕获 session 当前输出。
- 停止 session。

关键命令：

```bash
tmux has-session -t <session>
tmux new-session -d -s <session> -c <project_path>
tmux send-keys -t <session> '<prompt>' C-m
tmux capture-pane -t <session> -p
```

### 4.11 `runner/codex.js`

目的：封装 Codex 启动和任务投递逻辑。

负责内容：

- 构造稳定环境变量。
- 在项目目录启动 Codex CLI。
- 判断 Codex 是否已经在 tmux 中运行。
- 用 `templates/codex-dispatch-prompt.md` 生成投递 prompt。
- 投递任务文件路径给 Codex。

重点：该模块必须保证使用与 SSH 中一致的 Codex CLI 环境。

### 4.12 `runner/logger.js`

目的：统一日志记录和脱敏。

负责内容：

- 写入 Runner 日志。
- 写入任务日志。
- 脱敏 API Key、token、Authorization header。
- 标准化错误输出。

### 4.13 `hermes/bot-adapter.js`

目的：对接现有 Hermes 消息入口。

负责内容：

- 接收 Hermes 消息事件。
- 识别用户、stream、topic、项目别名。
- 调用 `runner/index.js` 或 Runner API。
- 将结果交给 notifier。

该文件要保持薄，不直接管理代码上下文。

### 4.14 `hermes/commands.js`

目的：定义 Hermes 中可用命令。

负责内容：

- `/codex run <project> <goal>`
- `/codex status <task_id>`
- `/codex cancel <task_id>`
- `/codex projects`
- `/codex recent <project>`

命令层只负责参数解析，不直接读源码。

### 4.15 `hermes/notifier.js`

目的：负责向 Hermes 回发消息。

负责内容：

- 任务创建成功通知。
- 任务状态变化通知。
- 任务完成摘要。
- 失败原因和日志路径。
- 需要人工确认时的提示。

## 5. 项目内 `.hermes/` 文件

除了本编排器项目自身的文件，每个被管理项目还会生成自己的 `.hermes/` 文件。

### 5.1 `.hermes/project.json`

目的：保存该项目被 Hermes 管理时的本地配置快照。

用途：

- Codex 可直接读取项目配置。
- Runner 可快速确认项目身份。
- 人工 SSH 进入项目时也能看懂调度规则。

### 5.2 `.hermes/sessions.json`

目的：保存项目与 tmux/Codex session 的映射。

用途：

- 恢复上次 session。
- 查看当前 active task。
- 记录最后一次 Codex thread id。

注意：这只是恢复入口，不是代码上下文事实源。

### 5.3 `.hermes/tasks/<task_id>.md`

目的：保存单个任务的事实状态。

用途：

- Hermes 创建任务。
- Codex 读取任务。
- Codex 回写执行日志和结果。
- Hermes 读取结果。

### 5.4 `.hermes/logs/<task_id>.log`

目的：保存 Runner 和 Codex 执行摘要日志。

用途：

- 排错。
- 审计。
- 断线后恢复。

## 6. 阶段开发计划

### 阶段 1：协议和手动闭环

目标：不写复杂服务，先验证文件协议能跑通。

交付文件：

- `templates/task.md`
- `templates/codex-dispatch-prompt.md`
- `config/projects.json`
- `docs/setup.md`

验收：

- 能手动创建任务文件。
- 能手动用 tmux 启动 Codex。
- Codex 能按任务文件执行并回写结果。

### 阶段 2：Runner CLI

目标：用命令行自动完成任务创建、投递和状态查询。

交付文件：

- `runner/index.js`
- `runner/config.js`
- `runner/task-store.js`
- `runner/tmux.js`
- `runner/codex.js`
- `runner/logger.js`

验收：

- 一条命令创建任务。
- 一条命令投递任务。
- 一条命令查询任务状态。
- 任务文件和日志正确生成。

### 阶段 3：Hermes Bot 适配

目标：从 Hermes 消息中触发 Runner。

交付文件：

- `hermes/bot-adapter.js`
- `hermes/commands.js`
- `hermes/notifier.js`

验收：

- Hermes 可以创建任务。
- Hermes 可以查询任务状态。
- Hermes 可以收到完成通知。

### 阶段 4：可靠性增强

目标：处理实际远程开发中的中断、并发和错误。

交付内容：

- 任务锁。
- 单项目单写任务限制。
- tmux session 恢复。
- Runner 日志脱敏。
- 失败任务重试。

验收：

- Hermes 断开不影响任务继续。
- Runner 重启后能找到已有任务。
- 多个写任务不会同时改同一项目。

## 7. MVP 优先级

### P0 必须做

- `templates/task.md`
- `templates/codex-dispatch-prompt.md`
- `config/projects.json`
- `runner/index.js`
- `runner/task-store.js`
- `runner/tmux.js`
- `runner/codex.js`

### P1 应该做

- `config/orchestrator.json`
- `runner/config.js`
- `runner/logger.js`
- `hermes/commands.js`
- `hermes/notifier.js`

### P2 后续做

- `schemas/task.schema.json`
- `schemas/project.schema.json`
- `hermes/bot-adapter.js`
- `docs/operations.md`
- 自动 worktree 并发支持。

## 8. 推荐第一步

第一步不要直接做完整 Hermes Bot。

建议先做：

```text
Runner CLI + 文件协议 + tmux 投递
```

原因：

- 能最快验证 Codex 是否真的能按项目文件管理上下文。
- 不依赖 Hermes 平台细节。
- 方便在 SSH 中调试。
- 后续 Hermes 只需要调用 Runner CLI 或 Runner API。

最小可运行命令目标：

```bash
node runner/index.js create-task --project stockprofits --goal "检查当前项目进度"
node runner/index.js dispatch-task --task HERMES-20260713-001
node runner/index.js status --task HERMES-20260713-001
```

## 9. 完成定义

当以下条件满足时，MVP 可认为完成：

1. 可以注册至少一个真实项目。
2. 可以创建任务文件。
3. 可以启动或恢复项目 tmux session。
4. 可以投递任务给 Codex。
5. Codex 会读取项目上下文，而不是依赖 Hermes 上下文。
6. Codex 会回写任务状态和结果。
7. 可以从命令行查询任务状态。
8. 可以从 Hermes 收到任务完成摘要。

