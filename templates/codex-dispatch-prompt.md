你现在在项目目录：

```text
{projectPath}
```

请读取任务文件：

```text
{taskFile}
```

执行要求：

1. 先读取项目规则文件 `AGENTS.md`，如不存在则记录风险后继续。
2. 再读取 `.speccompass/status.md`、`.speccompass/current-plan.md`、`.speccompass/decisions.md`，如不存在则记录风险后继续。
3. 读取当前任务文件，明确目标、约束和验收标准。
4. 执行 `git status`，确认工作区状态。
5. 制定简短计划后执行任务。
6. 如涉及代码修改，必须运行必要验证。
7. 开始执行时将任务文件可见区的 `Status` 更新为 `running`；执行完成后更新为 `completed` 或 `failed`。
8. 同步更新文件顶部 `hco:metadata` JSON 中的 `status`、`updatedAt` 和 `resultSummary`，并更新可见区的 `UpdatedAt`、`Codex Execution Log` 和 `Result`。
9. 不要依赖 Hermes 聊天上下文；项目文件和任务文件才是事实源。
