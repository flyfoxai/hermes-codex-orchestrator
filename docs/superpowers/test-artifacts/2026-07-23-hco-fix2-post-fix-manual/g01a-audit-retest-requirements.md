# HCO Fix2 G-01A 审计复测要求

## 目的与范围

本次只关闭先前 G-01A 的部署与审计证据项。不要重复 G-05、G-06A、U-01 或 U-02；G-01B 继续保持 BLOCKED，直到已有显式 `owner=HERMES` 的隔离 stream。

复测前已完成以下准备：

- 已部署 release：`hermes-codex-bridge-1.0.0-f50d205c0267`。
- gateway attestation 已指向该 release，且 release 与仓库源码哈希一致。
- release 含 `hermes_codex_bridge.local_route_decision` 审计实现。
- gateway、HCO、delivery 均为运行状态；route snapshot generation 为 `15`。
- 路由语义未改变：stream `2` 仍未映射；stream `5` 仍为 `PROJECT`、projectId=`stockprofits`；没有显式 `HERMES` stream。

## 人工发送要求

1. 使用已登录的 Zulip Web UI，以 `boss` 身份操作；不要用 API 发送正式消息。
2. 目标 stream 固定为 `沙箱`（数字 stream ID `2`）。不要使用 `量化交易stockProfits`。
3. 新建唯一 topic，例如：`hco-fix2-g01a-audit-retest-20260724-070422`。不要复用先前测试 topic。
4. 在消息开头精确输入真实 mention 语法 `@**Jarvis PM**`，然后发送：

   ```text
   @**Jarvis PM** /codex run 只做审计复测，不修改文件，并返回一句确认。回显 G01A-AUDIT-RETEST-20260724-070422
   ```

5. 不要选择或 mention `boss`，不要把 `@Jarvis PM` 当作普通文本发送，也不要通过候选列表误选其他机器人。
6. 发送后不要继续在这个 topic 发送任何命令；等待 Jarvis PM 的单条回复。

## UI 与 API 证据

发送完成后，记录并提供以下信息：

- UI 入站 message ID、Jarvis PM 回复 message ID、发送时间（含时区）。
- 入站原文仍为 `@**Jarvis PM** ...`。
- Zulip API 只读回查的入站 rendered HTML 包含 `class="user-mention"`，且对象为 `@Jarvis PM`。
- Jarvis PM 的回复是未登记 stream 的登记提示，要求确认 `projectId`、canonical 绝对工作目录、stream 登记和 objective 选择。
- 回复不得显示任务已提交、objective ID、项目工作目录，或任何执行结果。

浏览器截图只作辅助；最终判定以 Zulip API 原文与 rendered HTML 为准。Chrome 不需要保持在前台。

## 服务端审计判定

将两个 message ID 和时间回传给服务宿主操作员。服务宿主仅需在 gateway `stderr` 日志中检索该入站 ID：

```sh
rg -n 'hermes_codex_bridge\.local_route_decision|ROUTE_UNMAPPED_REGISTRATION|<入站-message-id>' \
  "$HOME/.hermes/logs/gateway.error.log"
```

同一条 JSON 审计记录必须满足：

- `event` 为 `hermes_codex_bridge.local_route_decision`。
- `sourceMessageId` 等于本次 UI 入站 message ID。
- `streamId` 为 `2`，`commandType` 为 `RUN`，`resultCode` 为 `ROUTE_UNMAPPED_REGISTRATION`。
- 可包含 `senderId`、时间、`topicBytes` 与 `topicSha256`；不得包含 topic 正文、命令正文、CWD、token、HMAC、bearer 或其他秘密。

服务宿主还需确认本次消息前后 HCO 的 objective、turn submission、outbox、inbound intent 计数均未增加。该内部核验由 devmac 侧完成，浏览器操作者不必访问 HCO 数据库或日志。

## 结果模板

```text
RUN_ID:
topic:
UI 入站 message ID / 时间:
Jarvis PM 回复 message ID / 时间:
入站 API rendered HTML 含 user-mention: PASS / FAIL
登记提示符合预期: PASS / FAIL
HCO 计数未变化（服务宿主填写）: PASS / FAIL
gateway stderr 审计记录（服务宿主填写）: PASS / FAIL
最终结论: PASS / FAIL / BLOCKED
```

若 UI/API 行为通过但审计记录缺失，不要重发消息；直接将本轮标记为 FAIL，并附上 message ID 和检索时间范围，供部署排查。
