# Fix2 第一批自动化验收报告

执行日期：2026-07-22（Asia/Shanghai）。

## 结论

第一批 37 项已纳入自动化证据：本地合同测试、Node HCO 测试、installer 隔离测试、无 `rg` 检查、Python 编译检查、服务基线和真实 Zulip API 回读均完成。真实 API B 类发送 12 条消息，全部通过。

## 结果摘要

| 范围 | 结果 | 证据 |
|---|---|---|
| A-01..A-03 | PASS | `diff-check.log`、`service-baseline.log`、`python-contract.log`、`node-tests.log`、`installer.log` |
| B-01..B-05 | PASS | `zulip-api.json`；message ID 490–501 |
| C-02..C-03 | PASS | `python-contract.log` 中 BridgeUserError 单行化、未知错误不反射测试 |
| D-01..D-08 | PASS | `python-contract.log` 和 `node-tests.log` 中 unavailable/uncertain、重启和幂等测试 |
| E-01..E-05 | PASS | `python-contract.log` 中 interaction ID 安全边界和 partial answer 测试 |
| F-04 | PASS | `python-contract.log` 中 secret 标记和 fail-closed 测试 |
| G-04 | PASS | `node-tests.log` 中 ACL 与 user-facing state error 测试 |
| I-01 | PASS | `python-contract.log` 中 macOS 大小写 containment 测试 |
| J-01..J-04 | PASS | `tracked-bytecode`、`pycompile`、`installer.log` |
| K-01..K-03 | PASS | `rg-static.log`、`installer-portable`、`fake-rg.log` |
| L-01..L-02、L-04..L-05 | PASS | service baseline、Node durable recovery/idempotency 测试、最终 diff check |

## 测试计数

- Python contract：310 passed。
- Node：273 passed。
- installer：32 个隔离场景通过。
- Zulip API：12/12 消息回读和渲染断言通过。
- tracked Python bytecode：0。
- `git diff --check`：通过。

`commands.tsv` 的退出码以最终重跑结果为准；历史失败尝试不作为最终判定依据。
