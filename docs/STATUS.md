# 开发状态

UpdatedAt: 2026-07-13

## 当前阶段

MVP Runner HTTP API 稳定化和 devmac dispatch 验证。

## 已确认决策

- 使用 Node.js。
- 项目必须可通过 API 注册和配置，不能只写死在配置文件。
- Runner 可以部署在 `/Users/hula/Projects/hermes-codex-orchestrator`，但设计上要考虑 macOS、Linux、Windows。
- MVP 执行链路是 HTTP API -> 任务文件 -> tmux -> Codex CLI。

## 已完成

- 健康检查。
- 项目注册和查询。
- 任务创建和查询。
- 任务日志查询。
- tmux session 查询。
- tmux/Codex dispatch 预检、失败回写和 prompt 文件投递。
- API 请求参数校验、任务原文查询和统一错误响应。
- Codex 修改任务 Markdown 后的状态/结果协调。
- Runner 与任务日志脱敏。
- smoke test 使用独立临时配置，不污染真实 `config/projects.json`。
- tmux 粘贴与提交之间支持可配置的 `pasteSubmitDelayMs`，兼容 macOS tmux 3.6a 下 Codex TUI 的输入时序。
- 部署和运维文档。

## 已验证

- `npm run check`
- `npm run smoke`
- `npm run contract`
- `npm run dispatch`
- `npm run dispatch:success`
- devmac 真实项目 `stockprofits` 的任务文件创建、日志和查询链路。
- devmac 真实 Codex 0.142.3 的 tmux dispatch、任务读取，以及状态、执行日志和结果回写。
- devmac 真实 Codex 在修复后的自动提交链路：第二个只读任务无需人工补发回车即完成回写。

## 下一步

- 实现 Hermes adapter。
- 增强 Codex 回写结果解析和任务完成通知。

## 交接文档

- `docs/DEVMAC_CODEX_HANDOFF.md`：交给 devmac 上 Codex 继续开发的任务说明。
