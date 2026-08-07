# INGRESS-01 根因与修复记录

## 结论

本轮 `INGRESS-01` 的授权和只读 sandbox 修复已经生效。失败发生在 Codex 第二批只读工具输出返回 HCO 时：App Server NDJSON 响应超过 HCO 原有的 1 MiB 单帧上限，HCO 因此终止连接并重启 App Server，turn 随后进入 `reconciliation_needed`，没有生成 Jarvis 最终结果。

## 证据链

- Zulip source message：`742`。
- work request：`work-request-83a3dadb-de5d-4f2e-a91e-ef4de2a74613`。
- objective：`objective-fffbfcc3-3382-48b7-84a4-0bd02f8f4470`。
- Codex call：`codex-call-47d60066-6c74-4c14-8b7b-16847455c6fb`。
- HCO 已创建真实 thread 和 turn，证明入站、授权、路由和调用已成功。
- Codex rollout 中第一次 `exec` 有完整 tool output；第二次 `exec` 只有 tool call，没有 tool output 或 final answer。
- 第二批命令中的只读 `git status --short --branch --untracked-files=all` 原始输出约为 1.85 MiB。
- HCO 当时的 `DEFAULT_MAX_FRAME_BYTES` 为 1 MiB。
- 第二次 tool call 后 HCO 的 Codex App Server 子进程被替换，HCO 将 submission 和 objective 标记为 `reconciliation_needed`；Codex call 保持 `RUNNING`。
- 没有对应的 HTTP 403、HTTP 502、provider failure 或重复发送。

## 修复

- 将受信本地 Codex App Server NDJSON 单帧上限从 1 MiB 提高到 8 MiB。
- 仍保留有限上限；超过 8 MiB 的帧继续以 `APP_SERVER_TRANSPORT_FRAME_TOO_LARGE` 失败关闭。
- 增加 2 MiB App Server tool result 回归测试，覆盖此前会断开连接的范围。

## 验证

- `npm run check`：PASS。
- App Server transport 专项：71 tests passed，0 failed。
- App Server、runtime、service、controller 和 Option C 相关回归：255 tests passed，0 failed。
- 独立真实 Codex App Server 验证使用 `gpt-5.6-sol`、`approvalPolicy: never` 和 `sandbox: read-only` 执行同类大输出 Git 检查，收到一次 `turn/completed`，没有 transport terminal。

## 验收边界

没有重发消息 `742`，没有执行 `PC-00` 至 `PC-04`。修复部署后必须使用新的唯一 `RUN_ID` 重跑 `INGRESS-01`；旧 objective 的非终态记录保留用于审计，不作为新一轮通过证据。
