# HCO Fix2 Automated Acceptance

本目录保存一次自动化验收的非敏感证据。凭据从本机 `~/.zuliprc` 读取，不复制到目录；原始消息正文、秘密答案和 token 不写入报告。

## 执行

```bash
/Users/hula/Projects/hermes-codex-orchestrator/scripts/hco-fix2-automated-acceptance.sh
```

可单独运行真实 API 回读：

```bash
/Users/hula/Projects/hermesAgent/.venv/bin/python3 /Users/hula/Projects/hermes-codex-orchestrator/scripts/hco-fix2-api-acceptance.py \
  --stream-id 2 \
  --output /Users/hula/Projects/hermes-codex-orchestrator/docs/superpowers/test-artifacts/2026-07-22-hco-fix2-automated/zulip-api.json
```

## 证据文件

- `commands.tsv`：命令名和退出码。
- `python-contract.log`：Bridge/Markdown/interaction/containment 等 Python 合同测试。
- `node-tests.log`：HCO Node 测试。
- `installer.log`：installer 隔离测试。
- `installer-portable.log`：前置 fake `rg` 且保留 Node/Python 系统路径的完整 installer 测试。
- `installer-no-rg.log`：无 `rg` PATH 测试。
- `fake-rg.log`：fake `rg` 调用记录，空文件表示未调用。
- `zulip-api.json`：B-01～B-05 的消息 ID、摘要哈希、原始/渲染字节数和断言结果。
- `browser-handoff.md`：另一台主机执行 16 个授权用户浏览器用例所需的参数、步骤和安全边界。

消息发送到 stream ID `2` 的唯一测试 topic；运行完成后按 topic 清理测试消息，保留 JSON 中的 message ID 作为审计索引。
