# Gateway 授权修复记录

## 结论

2026-08-07 00:41 (Asia/Shanghai) 已修复 `zulip-ingress` 对 boss 的 Zulip 授权。原始验收 run `20260806-210322-2cpi` 的 FAIL 证据保持不变，消息 `739` 未重发。

## 根因

- boss 的 Zulip 身份是 `user8@zulip.dounetwork.duckdns.org`。
- 默认 Hermes pairing store 有 boss 的批准记录。
- 多 profile Gateway 对 `zulip-ingress` 使用独立 pairing store，该 store 为空；因此原消息在 profile 隔离后的授权检查处被拒绝。

## 修复

在服务机 owner-only 文件 `~/.hermes/profiles/zulip-ingress/.env` 增加精确 allowlist：

```text
ZULIP_ALLOWED_USERS=user8@zulip.dounetwork.duckdns.org
```

没有启用 `ZULIP_ALLOW_ALL_USERS`、`GATEWAY_ALLOW_ALL_USERS` 或全局用户 allowlist，也没有改动 Zulip bot 凭据、HCO 数据库或旧失败消息。

## 验证

- profile secret scope 授权判定：boss `True`；`intruder@example.invalid` `False`。
- Hermes Zulip 授权回归：`7 passed, 248 deselected`。
- provider smoke check：`iotwq / gpt-5.6-sol`、`codex_responses` 返回 `PROVIDER_HEALTH_OK`。
- Gateway 已重启并轮换 PID：旧 `11518`，当前 `77126`。
- HCO PID `11484`、delivery PID `11635` 未改变。
- 当前 Zulip ingress 在 Gateway 启动日志中成功认证。

## 重测门槛

浏览器控制端点不在本服务机上，不能由服务机代发或伪造入站。另一台测试机必须使用新的唯一 `RUN_ID` 重新执行 `INGRESS-01`，不得复用消息 `739`；只有服务端确认一次 inbound、`gpt-5.6-sol` 调用和一次 Jarvis 回复后，才继续 `PC-00` 至 `PC-04`。任何失败或不确定结果继续保留现场并停止，不自动重发。
