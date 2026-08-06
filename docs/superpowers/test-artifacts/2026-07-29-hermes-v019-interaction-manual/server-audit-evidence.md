# Hermes v0.19.0 服务端审计证据

取证日期：2026-07-29。所有查询均为只读。

## 运行进程

```text
PID 1525   Hermes gateway (started 2026-07-24 20:49:42)
PID 1533   Hermes gateway (started 2026-07-24 20:49:42)
PID 14176  Hermes gateway (started 2026-07-29 06:18:49)
PID 14160  HCO index.js (started 2026-07-29 06:18:44)
PID 14228  delivery sidecar (started 2026-07-29 06:18:54)
```

delivery 命令行显示活动 release 为：

```text
/Users/hula/.hermes/plugin-releases/hermes-codex-bridge-1.0.0-18c91b8dc930/delivery_sidecar.py
```

## Route 快照

静态 route：

```text
stream 4 -> project ASK
stream 5 -> project stockprofits
```

运行时 override：

```text
stream 6 -> hermes (source zulip-message 545)
```

## HCO 摘要

- `agent_sessions`: 0
- `pending_interactions`: 6
- `interaction_actions`: 12
- 正式 COORD 消息创建 6 个 work 和 6 个 call，全部 call 的 `invocation_origin=JARVIS`，全部 `agent_session_id=NULL`。
- 消息 `679`（从话题 B 尝试继续话题 A objective）对应新增 work 数为 0，新增 call 数为 0。

状态异常：

```text
662  work WAITING_CODEX/codex_running  call RUNNING
665  work WAITING_CODEX/codex_running  call RUNNING
667  work WAITING_CODEX/codex_running  call RUNNING
669  work WAITING_CODEX/codex_running  call RUNNING
674  work RUNNING/caller_review        call FAILED
675  work RUNNING/caller_review        call FAILED
```

这说明 Jarvis 对 `674/675` 回复“未生成 objective/work”与持久化事实不一致；数据库实际生成了两个 work、objective 和 call。

## Hermes 状态库

对 `/Users/hula/.hermes/state.db` 的 `messages.platform_message_id` 查询未找到本轮正式入站消息 ID。PC-00 的负向项因此主要由 Zulip API“无 Jarvis 回复”和 HCO“无对应业务 work/call”联合判定。

未在结果中复制 bearer、API key、Authorization header 或完整日志。
