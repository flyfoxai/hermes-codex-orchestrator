#!/bin/bash
set -euo pipefail

ROOT="$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)"
INSTALLER="$ROOT/scripts/install-hermes-codex-bridge.sh"
PYTHON="/Users/hula/Projects/hermesAgent/.venv/bin/python3"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hco-installer-test.XXXXXX")"
HCO_SERVER_PID=''
LOCK_SERVER_PID=''

cleanup() {
  local launchd_hco_pid_path="${LAUNCHCTL_STATE:-}/com.hermes.codex-bridge-hco.pid"
  local launchd_hco_pid=''
  if [[ -f "$launchd_hco_pid_path" ]]; then
    launchd_hco_pid="$(< "$launchd_hco_pid_path")"
    if [[ "$launchd_hco_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "$launchd_hco_pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        kill -0 "$launchd_hco_pid" 2>/dev/null || break
        sleep 0.05
      done
    fi
  fi
  if [[ -n "$HCO_SERVER_PID" ]]; then
    kill "$HCO_SERVER_PID" 2>/dev/null || true
    wait "$HCO_SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$LOCK_SERVER_PID" ]]; then
    kill "$LOCK_SERVER_PID" 2>/dev/null || true
    wait "$LOCK_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (found redacted value)"
}

[[ -f "$INSTALLER" ]] || fail "installer exists"

DRY_ROOT="$TMP_ROOT/dry-run-target"
HCO_CONFIG="$TMP_ROOT/hco.json"
ZULIP_CONFIG="$TMP_ROOT/zuliprc"
SECRET_VALUE="task9-bearer-value-must-never-appear"
printf '{"secret":"%s"}\n' "$SECRET_VALUE" > "$HCO_CONFIG"
printf '[api]\nkey=%s\n' "$SECRET_VALUE" > "$ZULIP_CONFIG"
chmod 600 "$HCO_CONFIG" "$ZULIP_CONFIG"

FAKE_BIN="$TMP_ROOT/fake-bin"
AUDIT_LOG="$TMP_ROOT/process-audit.log"
mkdir -p "$FAKE_BIN"
for command_name in python3 node codex launchctl cp mv ln mkdir chmod chown rm install; do
  printf '#!/bin/bash\nprintf "%%s\\n" "${0##*/}" >> "$HCO_TEST_AUDIT_LOG"\nexit 97\n' \
    > "$FAKE_BIN/$command_name"
  chmod 700 "$FAKE_BIN/$command_name"
done

set +e
DRY_OUTPUT="$(
  PATH="$FAKE_BIN" HCO_TEST_AUDIT_LOG="$AUDIT_LOG" /bin/bash "$INSTALLER" \
    --dry-run \
    --hco-config "$HCO_CONFIG" \
    --zulip-config "$ZULIP_CONFIG" \
    --install-root "$DRY_ROOT" \
    --launch-agents-dir "$DRY_ROOT/LaunchAgents" \
    --node-bin "/usr/local/bin/node" \
    --codex-bin "/usr/local/bin/codex" \
    --launchctl-bin "/bin/launchctl" 2>&1
)"
DRY_STATUS=$?
set -e

[[ $DRY_STATUS -eq 0 ]] || fail "strict dry-run exits successfully: $DRY_OUTPUT"
[[ ! -e "$AUDIT_LOG" ]] || fail "strict dry-run starts no instrumented process"
[[ ! -e "$DRY_ROOT" ]] || fail "strict dry-run writes no target files or lock"
assert_contains "$DRY_OUTPUT" "DRY RUN" "dry-run is clearly identified"
assert_contains "$DRY_OUTPUT" "$HOME/.hermes-codex-bridge-installer.lock" "dry-run reports the stable per-user lock"
assert_contains "$DRY_OUTPUT" "deferred: installed Hermes compatibility" "Hermes process probe is deferred"
assert_contains "$DRY_OUTPUT" "deferred: bridge protocol compatibility" "bridge process probe is deferred"
assert_contains "$DRY_OUTPUT" "deferred: installed Codex App Server canary" "App Server process probe is deferred"
assert_not_contains "$DRY_OUTPUT" "$SECRET_VALUE" "dry-run masks secrets"
pass "strict dry-run is process-free, write-free, and redacted"

DRY_EXISTING_LOCK="$HOME/.hermes-codex-bridge-installer.lock"
DRY_LOCK_BEFORE="$("$PYTHON" - "$DRY_EXISTING_LOCK" <<'PY'
import hashlib
import os
import sys

try:
    info = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("missing")
else:
    digest = hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()
    print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, digest)
PY
)"
rm -f "$AUDIT_LOG"
DRY_EXISTING_OUTPUT="$(
  PATH="$FAKE_BIN" HCO_TEST_AUDIT_LOG="$AUDIT_LOG" /bin/bash "$INSTALLER" \
    --dry-run \
    --hco-config "$HCO_CONFIG" \
    --zulip-config "$ZULIP_CONFIG" \
    --install-root "$DRY_ROOT" \
    --launch-agents-dir "$DRY_ROOT/LaunchAgents" \
    --node-bin "/usr/local/bin/node" \
    --codex-bin "/usr/local/bin/codex" \
    --launchctl-bin "/bin/launchctl" 2>&1
)" || fail "dry-run inspects an existing lock without acquiring it"
DRY_LOCK_AFTER="$("$PYTHON" - "$DRY_EXISTING_LOCK" <<'PY'
import hashlib
import os
import sys

try:
    info = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("missing")
else:
    digest = hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()
    print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, digest)
PY
)"
[[ ! -e "$AUDIT_LOG" ]] || fail "existing-lock dry-run starts no instrumented process"
[[ "$DRY_LOCK_AFTER" == "$DRY_LOCK_BEFORE" ]] || fail "existing-lock dry-run leaves lock metadata and content unchanged"
assert_contains "$DRY_EXISTING_OUTPUT" "$DRY_EXISTING_LOCK" "dry-run reports the stable lock it actually inspected"
pass "dry-run meaningfully inspects the stable lock without mutation"

"$PYTHON" - "$ROOT" <<'PY'
import json
import plistlib
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1])
installer_text = (root / "scripts/install-hermes-codex-bridge.sh").read_text()
hco_path = root / "deploy/com.hermes.codex-bridge-hco.plist.example"
delivery_path = root / "deploy/com.hermes.codex-bridge-delivery.plist.example"
config_path = root / "config/hco.json.example"

assert "_without_secondary_profile_platform_env" in installer_text
assert "_profile_runtime_scope" in installer_text
assert "zulip_module.check_zulip_requirements(platform_config)" in installer_text
assert "zulip_module.ZulipAdapter(platform_config)" in installer_text
assert "load_hermes_dotenv(hermes_home=ingress_home" not in installer_text

with hco_path.open("rb") as stream:
    hco = plistlib.load(stream)
with delivery_path.open("rb") as stream:
    delivery = plistlib.load(stream)

assert hco["Label"] == "com.hermes.codex-bridge-hco"
assert delivery["Label"] == "com.hermes.codex-bridge-delivery"
assert hco["ProgramArguments"] == ["/ABSOLUTE/PATH/TO/node", "/ABSOLUTE/PATH/TO/repository/hco/index.js"]
assert hco["EnvironmentVariables"] == {"HCO_CONFIG_PATH": "/ABSOLUTE/PATH/TO/hco.json"}
assert "HCO_CONFIG_PATH" not in delivery.get("EnvironmentVariables", {})

delivery_args = delivery["ProgramArguments"]
required_flags = {
    "--socket-path",
    "--hco-bearer-file",
    "--zulip-config-file",
    "--worker-id",
    "--claim-limit",
    "--lease-ms",
    "--poll-seconds",
}
assert required_flags.issubset(delivery_args)
for forbidden in ("Bearer ", "api_key", "token="):
    assert forbidden not in "\n".join(map(str, hco))
    assert forbidden not in "\n".join(map(str, delivery_args))

config = json.loads(config_path.read_text(encoding="utf-8"))
manifest = yaml.safe_load(
    (root / "plugin/hermes-codex-bridge/plugin.yaml").read_text(encoding="utf-8")
)
assert "provides_tools" not in manifest
assert config["version"] == 1
assert config["codexExecutablePath"].startswith("/ABSOLUTE/PATH/TO/")
assert set(config["bridge"]) == {"tokenPath", "contextKeyPath", "socketPath", "routeSnapshotPath"}
assert config["snapshot"] == {"ttlMs": 60000, "maxBytes": 262144}
assert isinstance(config["admins"], list)
assert isinstance(config["projects"], list)
for key in ("databasePath", *config["bridge"].keys()):
    value = config["databasePath"] if key == "databasePath" else config["bridge"][key]
    assert value.startswith("/ABSOLUTE/PATH/TO/")
PY
pass "example plists and HCO JSON match runtime contracts"

MUTATE_ROOT="$TMP_ROOT/mutating"
HERMES_HOME="$MUTATE_ROOT/hermes"
INSTALL_ROOT="$MUTATE_ROOT/runtime"
LAUNCH_AGENTS="$MUTATE_ROOT/LaunchAgents"
SOCKET_PATH="$MUTATE_ROOT/hco.sock"
BEARER_PATH="$MUTATE_ROOT/hco.bearer"
CONTEXT_KEY_PATH="$MUTATE_ROOT/context.key"
ROUTES_PATH="$MUTATE_ROOT/routes.json"
DATABASE_PATH="$MUTATE_ROOT/hco.sqlite3"
MUTATE_HCO_CONFIG="$MUTATE_ROOT/source-hco.json"
MUTATE_ZULIP_CONFIG="$MUTATE_ROOT/source-zuliprc"
MUTATE_SECRET="task9-mutating-secret-must-never-appear"
FAKE_CODEX="$MUTATE_ROOT/fake-codex"
mkdir -p "$MUTATE_ROOT" "$HERMES_HOME"
mkdir -p "$HERMES_HOME/plugins/unrelated-fixture" "$HERMES_HOME/profiles/codex-bridge" "$HERMES_HOME/profiles/hermes-general" "$HERMES_HOME/profiles/ask-jarvis-pm"
printf '%s\n' \
  'name: unrelated-fixture' \
  'version: 1.0.0' \
  'description: Installer isolation fixture' \
  'kind: standalone' \
  'provides_tools:' \
  '  - unrelated_fixture_tool' > "$HERMES_HOME/plugins/unrelated-fixture/plugin.yaml"
printf '%s\n' \
  'def register(ctx):' \
  '    ctx.register_tool(' \
  '        name="unrelated_fixture_tool",' \
  '        toolset="unrelated_fixture",' \
  '        schema={"name": "unrelated_fixture_tool", "description": "fixture", "parameters": {"type": "object", "properties": {}}},' \
  '        handler=lambda _args: "fixture",' \
  '    )' > "$HERMES_HOME/plugins/unrelated-fixture/plugin.py"
printf '%s\n' \
  'from .plugin import register' \
  '' \
  '__all__ = ["register"]' > "$HERMES_HOME/plugins/unrelated-fixture/__init__.py"
printf '%s\n' \
  'plugins:' \
  '  enabled: [unrelated-fixture]' \
  'platforms:' \
  '  zulip:' \
  '    enabled: true' \
  '    reply_to_mode: topic' \
  '    typing_indicator: true' \
  '    home_channel:' \
  '      platform: zulip' \
  '      chat_id: stockprofits' \
  '      name: Stockprofits' \
  '    extra:' \
  '      bot_email: root-zulip@example.invalid' \
  '      site_url: https://root-zulip.example.invalid' \
  '      cert_bundle: /operator/zulip-ca.pem' \
  '      allow_insecure: false' \
  '      require_mention: false' \
  '      free_response_streams: [yaml-stream, "84"]' \
  '      context_depth: 9' \
  '      catchup_enabled: false' \
  '  feishu: {enabled: true, port: 9001}' \
  'platform_toolsets:' \
  '  zulip: [hermes-zulip]' \
  '  feishu: [web]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' \
  'mcp_servers:' \
  '  qmd: {enabled: true}' \
  '  stockdata: {enabled: true}' \
  'cwd: /Users/hula/workspace/ASK' \
  'system_prompt: ASK root project prompt' \
  'memory:' \
  '  enabled: true' \
  '  namespace: ask-project-memory' \
  'task_guard:' \
  '  enabled: true' \
  '  ledger: /Users/hula/.hermes/task_guard/tasks.json' \
  'model:' \
  '  provider: openai' \
  '  name: ask-model' \
  'context:' \
  '  engine: lcm' > "$HERMES_HOME/config.yaml"
printf '%s\n' \
  'platform_toolsets:' \
  '  zulip: [hco_bridge, no_mcp]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' \
  'mcp_servers:' \
  '  qmd: {enabled: true}' \
  '  stockdata: {enabled: true}' \
  'context:' \
  '  engine: lcm' > "$HERMES_HOME/profiles/codex-bridge/config.yaml"
printf '%s\n' \
  'platform_toolsets:' \
  '  zulip: [hermes-zulip, hco_bridge, no_mcp]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' \
  'mcp_servers:' \
  '  qmd: {enabled: true}' \
  '  stockdata: {enabled: true}' > "$HERMES_HOME/profiles/hermes-general/config.yaml"
printf '%s\n' \
  'platforms:' \
  '  zulip:' \
  '    enabled: true' \
  '    token: root-zulip-api-key' \
  '    require_mention: true' \
  '  feishu:' \
  '    enabled: true' \
  '    port: 9911' \
  'cwd: /Users/hula/workspace/ASK' \
  'model:' \
  '  provider: openai' \
  '  name: ask-jarvis-model' \
  'custom_profile_setting:' \
  '  preserved: true' > "$HERMES_HOME/profiles/ask-jarvis-pm/config.yaml"
printf '%s\n' \
  'ZULIP_API_KEY=root-zulip-api-key' \
  'PROFILE_ONLY_SETTING=preserved' > "$HERMES_HOME/profiles/ask-jarvis-pm/.env"
printf '%s' "$MUTATE_SECRET" > "$BEARER_PATH"
printf '%064d' 0 > "$CONTEXT_KEY_PATH"
printf '%s\n' \
  'UNRELATED_SETTING=preserved' \
  'OPENAI_API_KEY=root-model-credential' \
  'FEISHU_APP_ID=root-feishu-id' \
  'FEISHU_APP_SECRET=root-feishu-secret' \
  'ZULIP_BOT_EMAIL=root-zulip@example.invalid' \
  'export ZULIP_API_KEY=root-zulip-api-key' \
  'ZULIP_SITE_URL=https://root-zulip.example.invalid' \
  'ZULIP_REQUIRE_MENTION=false' \
  'ZULIP_FREE_RESPONSE_STREAMS=stockprofits,42' \
  'ZULIP_CONTEXT_DEPTH=0' > "$HERMES_HOME/.env"
mkdir -p "$HERMES_HOME/profiles/zulip-ingress"
printf '%s\n' \
  'ZULIP_BOT_EMAIL=ingress-zulip@example.invalid' \
  'ZULIP_CERT_BUNDLE=/wrong/dotenv-ca.pem' \
  'ZULIP_ALLOW_INSECURE=true' \
  'ZULIP_REQUIRE_MENTION=true' \
  'ZULIP_FREE_RESPONSE_STREAMS=dotenv-stream,42' \
  'ZULIP_CATCHUP=true' > "$HERMES_HOME/profiles/zulip-ingress/.env"
printf '%s\n' \
  '{' \
  '  "version": 1,' \
  "  \"codexExecutablePath\": \"$FAKE_CODEX\"," \
  "  \"databasePath\": \"$DATABASE_PATH\"," \
  '  "bridge": {' \
  "    \"tokenPath\": \"$BEARER_PATH\"," \
  "    \"contextKeyPath\": \"$CONTEXT_KEY_PATH\"," \
  "    \"socketPath\": \"$SOCKET_PATH\"," \
  "    \"routeSnapshotPath\": \"$ROUTES_PATH\"" \
  '  },' \
  '  "snapshot": {"ttlMs": 60000, "maxBytes": 262144},' \
  '  "admins": [],' \
  '  "projects": []' \
  '}' > "$MUTATE_HCO_CONFIG"
printf '%s\n' \
  '[api]' \
  'email=bridge@example.invalid' \
  "key=$MUTATE_SECRET" \
  'site=https://zulip.example.invalid' > "$MUTATE_ZULIP_CONFIG"
chmod 600 "$BEARER_PATH" "$CONTEXT_KEY_PATH" "$MUTATE_HCO_CONFIG" "$MUTATE_ZULIP_CONFIG" \
  "$HERMES_HOME/.env" "$HERMES_HOME/profiles/zulip-ingress/.env" \
  "$HERMES_HOME/profiles/ask-jarvis-pm/config.yaml" "$HERMES_HOME/profiles/ask-jarvis-pm/.env"

"$PYTHON" - "$SOCKET_PATH" <<'PY' &
import json
import os
import signal
import socket
import sys

socket_path = sys.argv[1]
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

def stop(*_args):
    server.close()
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
server.bind(socket_path)
os.chmod(socket_path, 0o600)
server.listen(8)
while True:
    connection, _ = server.accept()
    with connection:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(65536)
            if not chunk:
                break
            request += chunk
        body = json.dumps({
            "compatibility": {
                "protocolVersion": 1,
                "peerPluginVersion": "1.0.0",
                "capabilities": [],
            }
        }, separators=(",", ":")).encode()
        response = (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        connection.sendall(response)
PY
HCO_SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -S "$SOCKET_PATH" ]] && break
  sleep 0.1
done
[[ -S "$SOCKET_PATH" ]] || fail "compatibility fixture starts"

TURN_START_MARKER="$MUTATE_ROOT/app-server-turn-started"
printf '%s\n' \
  '#!/Users/hula/Projects/hermesAgent/.venv/bin/python3' \
  'import json, os, pathlib, sys' \
  'if sys.argv[1:] != ["app-server", "--stdio"]: raise SystemExit(91)' \
  'initialized = False' \
  'for line in sys.stdin:' \
  '    message = json.loads(line)' \
  '    method = message.get("method")' \
  '    if method == "initialize":' \
  '        result = {"userAgent":"fake-codex/0.142.3","codexHome":"/tmp/fake-codex","platformFamily":"unix","platformOs":"test"}' \
  '        print(json.dumps({"id":message["id"],"result":result}), flush=True)' \
  '    elif method == "initialized": initialized = True' \
  '    elif not initialized: print(json.dumps({"id":message["id"],"error":{"code":-32002,"message":"not initialized"}}), flush=True)' \
  '    elif method == "thread/start":' \
  '        print(json.dumps({"method":"thread/started","params":{"thread":{"id":"canary-thread"}}}), flush=True)' \
  '        print(json.dumps({"id":message["id"],"result":{"thread":{"id":"canary-thread"}}}), flush=True)' \
  '    elif method == "thread/read":' \
  '        if message.get("params", {}).get("includeTurns") is True: print(json.dumps({"id":message["id"],"error":{"code":-32600,"message":"ephemeral threads do not support includeTurns"}}), flush=True)' \
  '        else: print(json.dumps({"id":message["id"],"result":{"thread":{"id":"canary-thread","turns":[]}}}), flush=True)' \
  '    elif method == "turn/start":' \
  '        if "input" not in message.get("params", {}): print(json.dumps({"id":message["id"],"error":{"code":-32602,"message":"missing input"}}), flush=True)' \
  '        else:' \
  '            pathlib.Path(os.environ["HCO_TEST_TURN_START_MARKER"]).write_text("called")' \
  '            print(json.dumps({"id":message["id"],"result":{"turn":{"id":"canary-turn"}}}), flush=True)' \
  '    elif "id" in message: print(json.dumps({"id":message["id"],"error":{"code":-32601,"message":"unknown method"}}), flush=True)' \
  > "$FAKE_CODEX"
chmod 700 "$FAKE_CODEX"

FAKE_LAUNCHCTL="$MUTATE_ROOT/fake-launchctl"
LAUNCHCTL_LOG="$MUTATE_ROOT/launchctl.log"
LAUNCHCTL_STATE="$MUTATE_ROOT/launchctl-state"
HCO_LIFECYCLE_LOG="$MUTATE_ROOT/hco-lifecycle.log"
FAKE_HCO_SERVER="$MUTATE_ROOT/fake-hco-server"
printf '%s\n' \
  '#!/Users/hula/Projects/hermesAgent/.venv/bin/python3' \
  'import json, os, signal, socket, sys' \
  'config = json.loads(open(sys.argv[1], encoding="utf-8").read())' \
  'socket_path = config["bridge"]["socketPath"]' \
  'log_path = os.environ["HCO_TEST_HCO_LIFECYCLE_LOG"]' \
  'server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)' \
  'def stop(*_args):' \
  '    server.close()' \
  '    try: os.unlink(socket_path)' \
  '    except FileNotFoundError: pass' \
  '    with open(log_path, "a", encoding="utf-8") as stream: stream.write("stopped\n")' \
  '    raise SystemExit(0)' \
  'signal.signal(signal.SIGTERM, stop)' \
  'signal.signal(signal.SIGINT, stop)' \
  'try: os.unlink(socket_path)' \
  'except FileNotFoundError: pass' \
  'server.bind(socket_path)' \
  'os.chmod(socket_path, 0o600)' \
  'server.listen(8)' \
  'if os.environ.get("HCO_TEST_HCO_REWRITE_ROUTE_ON_START") == "1":' \
  '    route_path = config["bridge"]["routeSnapshotPath"]' \
  '    with open(route_path, "w", encoding="utf-8") as stream: stream.write("renewed-by-restored-hco\n")' \
  '    os.chmod(route_path, 0o600)' \
  'with open(log_path, "a", encoding="utf-8") as stream: stream.write("started\n")' \
  'while True:' \
  '    connection, _ = server.accept()' \
  '    with connection:' \
  '        request = b""' \
  '        while b"\r\n\r\n" not in request:' \
  '            chunk = connection.recv(65536)' \
  '            if not chunk: break' \
  '            request += chunk' \
  '        body = json.dumps({"compatibility":{"protocolVersion":1,"peerPluginVersion":"1.0.0","capabilities":[]}}, separators=(",", ":")).encode()' \
  '        connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)' \
  > "$FAKE_HCO_SERVER"
chmod 700 "$FAKE_HCO_SERVER"
FAKE_NODE="$MUTATE_ROOT/fake-node"
printf '%s\n' \
  '#!/bin/bash' \
  'exec "$HCO_TEST_FAKE_HCO_SERVER" "$HCO_CONFIG_PATH"' \
  > "$FAKE_NODE"
chmod 700 "$FAKE_NODE"
printf '%s\n' \
  '#!/bin/bash' \
  'set -euo pipefail' \
  'start_hco() {' \
  '  local pid_path="$HCO_TEST_LAUNCHCTL_STATE/com.hermes.codex-bridge-hco.pid"' \
  '  if [[ ! -S "$HCO_TEST_HCO_SOCKET" ]]; then' \
  '    HCO_CONFIG_PATH="$HCO_TEST_HCO_CONFIG" HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_TEST_HCO_LIFECYCLE_LOG" HCO_TEST_FAKE_HCO_SERVER="$HCO_TEST_FAKE_HCO_SERVER" "$HCO_TEST_FAKE_NODE" ignored </dev/null >/dev/null 2>&1 &' \
  '    printf "%s" "$!" > "$pid_path"' \
  '    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [[ -S "$HCO_TEST_HCO_SOCKET" ]] && return; sleep 0.05; done' \
  '    exit 93' \
  '  fi' \
  '}' \
  'stop_hco() {' \
  '  local pid_path="$HCO_TEST_LAUNCHCTL_STATE/com.hermes.codex-bridge-hco.pid"' \
  '  if [[ -f "$pid_path" ]]; then pid="$(< "$pid_path")"; kill "$pid" 2>/dev/null || true; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [[ ! -S "$HCO_TEST_HCO_SOCKET" ]] && break; sleep 0.05; done; rm -f "$pid_path"; fi' \
  '}' \
  'write_gateway_evidence() {' \
  '  local pid="$1" plugin_path plugin_version="1.0.0"' \
  '  mkdir -p "$HERMES_HOME"' \
  '  if [[ "${HCO_TEST_GATEWAY_ZULIP_ONLY:-}" == "1" ]]; then printf '\''{"pid":%s,"gateway_state":"running","served_profiles":["default","zulip-ingress"],"platforms":{"zulip":{"state":"connected"}}}\n'\'' "$pid" > "$HERMES_HOME/gateway_state.json"; else printf '\''{"pid":%s,"gateway_state":"running","served_profiles":["default","zulip-ingress"],"platforms":{"feishu":{"state":"connected"},"zulip":{"state":"connected"}}}\n'\'' "$pid" > "$HERMES_HOME/gateway_state.json"; fi' \
  '  [[ -L "$HERMES_HOME/plugins/hermes-codex-bridge" ]] || return 0' \
  '  plugin_path="$(cd -P "$HERMES_HOME/plugins/hermes-codex-bridge" && pwd)"' \
  '  if [[ -f "$plugin_path/legacy-no-attestation.marker" ]]; then printf '\''{"pid":%s,"gateway_state":"running","served_profiles":["default"],"platforms":{"feishu":{"state":"connected"}}}\n'\'' "$pid" > "$HERMES_HOME/gateway_state.json"; rm -f "$HERMES_HOME/hermes-codex-bridge-attestation.json"; return 0; fi' \
  '  if [[ -f "$plugin_path/attestation-version" ]]; then plugin_version="$(< "$plugin_path/attestation-version")"; fi' \
  '  if [[ "${HCO_TEST_GATEWAY_ATTESTATION_FAILURE:-}" != "missing" ]]; then' \
  '    printf '\''{"schemaVersion":1,"pid":%s,"pluginVersion":"%s","pluginPath":"%s","hook":"pre_gateway_dispatch","ingressProfile":"zulip-ingress"}\n'\'' "$pid" "$plugin_version" "$plugin_path" > "$HERMES_HOME/hermes-codex-bridge-attestation.json"' \
  '    chmod 600 "$HERMES_HOME/hermes-codex-bridge-attestation.json"' \
  '  fi' \
  '}' \
  'restart_gateway() {' \
  '  local mode="$1" pid counter failure_marker' \
  '  pid="$(< "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.pid")"' \
  '  counter="$(< "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.pid-counter")"' \
  '  if [[ "$mode" != "-k" || "${HCO_TEST_GATEWAY_NO_ROTATION:-}" != "1" ]]; then counter=$((counter + 1)); pid="$counter"; fi' \
  '  printf "%s" "$counter" > "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.pid-counter"' \
  '  printf "%s" "$pid" > "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.pid"' \
  '  printf running > "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway"' \
  '  failure_marker="$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.attestation-failure-injected"' \
  '  if [[ "$mode" == "-k" && "${HCO_TEST_GATEWAY_ATTESTATION_FAILURE:-}" == "missing" && ! -e "$failure_marker" ]]; then touch "$failure_marker"; write_gateway_evidence "$pid"; else HCO_TEST_GATEWAY_ATTESTATION_FAILURE= write_gateway_evidence "$pid"; fi' \
  '}' \
  'printf "%s\n" "$*" >> "$HCO_TEST_LAUNCHCTL_LOG"' \
  'command_name="${1:-}"' \
  'target="${2:-}"' \
  'label="${target##*/}"' \
  'case "$command_name" in' \
  '  print) if [[ "$label" == "ai.hermes.gateway" ]]; then if [[ "$target" == "$(< "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.domain")/ai.hermes.gateway" ]]; then state_path="$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway"; pid_path="$state_path.pid"; elif [[ "$target" == "gui/$(id -u)/ai.hermes.gateway" && -f "$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.gui" ]]; then state_path="$HCO_TEST_LAUNCHCTL_STATE/ai.hermes.gateway.gui"; pid_path="$state_path.pid"; else exit 1; fi; printf "domain = %s\nstate = %s\npid = %s\n" "${target%/*}" "$(< "$state_path")" "$(< "$pid_path")"; elif [[ -f "$HCO_TEST_LAUNCHCTL_STATE/$label" ]]; then printf "domain = %s\nstate = %s\n" "${target%/*}" "$(< "$HCO_TEST_LAUNCHCTL_STATE/$label")"; [[ ! -f "$HCO_TEST_LAUNCHCTL_STATE/$label.pid" ]] || printf "pid = %s\n" "$(< "$HCO_TEST_LAUNCHCTL_STATE/$label.pid")"; else exit 1; fi ;;' \
  '  bootstrap) plist="${3:?}"; label="$(basename "$plist" .plist)"; mkdir -p "$HCO_TEST_LAUNCHCTL_STATE"; [[ "$label" != "com.hermes.codex-bridge-hco" ]] || start_hco; printf running > "$HCO_TEST_LAUNCHCTL_STATE/$label" ;;' \
  '  bootout) label="${target##*/}"; if [[ "$label" == "com.hermes.codex-bridge-hco" && "${HCO_TEST_ASYNC_BOOTOUT:-}" == "1" ]]; then stop_hco; printf stopping > "$HCO_TEST_LAUNCHCTL_STATE/$label"; (sleep 0.2; rm -f "$HCO_TEST_LAUNCHCTL_STATE/$label") </dev/null >/dev/null 2>&1 & else [[ "$label" != "com.hermes.codex-bridge-hco" ]] || stop_hco; rm -f "$HCO_TEST_LAUNCHCTL_STATE/$label"; fi ;;' \
  '  kickstart) mode=""; if [[ "$target" == "-k" ]]; then mode="-k"; target="${3:?}"; fi; label="${target##*/}"; if [[ "$label" == "ai.hermes.gateway" ]]; then restart_gateway "$mode"; else [[ "$label" != "com.hermes.codex-bridge-hco" ]] || start_hco; printf running > "$HCO_TEST_LAUNCHCTL_STATE/$label"; fi ;;' \
  '  kill) target="${3:?}"; label="${target##*/}"; if [[ "$label" == "ai.hermes.gateway" ]]; then restart_gateway ""; else [[ "$label" != "com.hermes.codex-bridge-hco" ]] || stop_hco; printf stopped > "$HCO_TEST_LAUNCHCTL_STATE/$label"; fi ;;' \
  '  *) exit 92 ;;' \
  'esac' > "$FAKE_LAUNCHCTL"
chmod 700 "$FAKE_LAUNCHCTL"
mkdir -p "$LAUNCHCTL_STATE"
printf running > "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco"
printf '%s' "$HCO_SERVER_PID" > "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco.pid"
printf 'user/%s' "$(id -u)" > "$LAUNCHCTL_STATE/ai.hermes.gateway.domain"
printf running > "$LAUNCHCTL_STATE/ai.hermes.gateway"
printf 4100 > "$LAUNCHCTL_STATE/ai.hermes.gateway.pid"
printf 4100 > "$LAUNCHCTL_STATE/ai.hermes.gateway.pid-counter"
printf '{"pid":4100,"gateway_state":"running","served_profiles":["default","zulip-ingress"],"platforms":{"feishu":{"state":"connected"},"zulip":{"state":"connected"}}}\n' > "$HERMES_HOME/gateway_state.json"
printf '{"schemaVersion":0,"pid":4100,"pluginPath":"stale"}\n' > "$HERMES_HOME/hermes-codex-bridge-attestation.json"
chmod 600 "$HERMES_HOME/hermes-codex-bridge-attestation.json"

set +e
MUTATE_OUTPUT="$(
  HERMES_HOME="$HERMES_HOME" \
  HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
  HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
  HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
  HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
  HCO_TEST_FAKE_NODE="$FAKE_NODE" \
  HCO_TEST_TURN_START_MARKER="$TURN_START_MARKER" \
  PYTHONDONTWRITEBYTECODE=1 \
  /bin/bash "$INSTALLER" \
    --hco-config "$MUTATE_HCO_CONFIG" \
    --zulip-config "$MUTATE_ZULIP_CONFIG" \
    --install-root "$INSTALL_ROOT" \
    --launch-agents-dir "$LAUNCH_AGENTS" \
    --node-bin "$(command -v node)" \
    --codex-bin "$FAKE_CODEX" \
    --launchctl-bin "$FAKE_LAUNCHCTL" 2>&1
)"
MUTATE_STATUS=$?
set -e

[[ $MUTATE_STATUS -eq 0 ]] || fail "fresh mutating install succeeds: $MUTATE_OUTPUT"
[[ ! -e "$TURN_START_MARKER" ]] || fail "App Server compatibility canary must not consume a model turn"
assert_contains "$MUTATE_OUTPUT" "bridge protocol compatibility: passed" "bridge gate is distinct"
assert_contains "$MUTATE_OUTPUT" "installed Hermes compatibility: passed" "Hermes gate is distinct"
assert_contains "$MUTATE_OUTPUT" "staged valid PROJECT route rewrite fixture: passed" "effective Hermes probe covers a valid routed PROJECT rewrite"
assert_contains "$MUTATE_OUTPUT" "installed Codex App Server compatibility: passed" "App Server gate is distinct"
assert_not_contains "$MUTATE_OUTPUT" "$MUTATE_SECRET" "mutating output masks secrets"
assert_contains "$(< "$LAUNCHCTL_LOG")" "kickstart -k user/$(id -u)/ai.hermes.gateway" "activation restarts the discovered user-domain Hermes Gateway"

PLUGIN_LINK="$HERMES_HOME/plugins/hermes-codex-bridge"
[[ -L "$PLUGIN_LINK" ]] || fail "stable plugin path is a symlink"
PLUGIN_TARGET="$(readlink "$PLUGIN_LINK")"
[[ "$PLUGIN_TARGET" == *"hermes-codex-bridge-1.0.0-"* ]] || fail "plugin uses immutable version directory"
[[ -f "$PLUGIN_LINK/plugin.py" && -f "$PLUGIN_LINK/delivery_sidecar.py" && -f "$PLUGIN_LINK/plugin.yaml" ]] || fail "plugin release is complete"
"$PYTHON" - "$HERMES_HOME" "$PLUGIN_LINK" <<'PY'
import json
import os
import stat
import sys
from pathlib import Path

home = Path(sys.argv[1])
release = Path(sys.argv[2]).resolve(strict=True)
gateway = json.loads((home / "gateway_state.json").read_text())
attestation_path = home / "hermes-codex-bridge-attestation.json"
attestation = json.loads(attestation_path.read_text())
assert gateway["pid"] != 4100
assert gateway["gateway_state"] == "running"
assert {"default", "zulip-ingress"} <= set(gateway["served_profiles"])
assert gateway["platforms"]["feishu"]["state"] == "connected"
assert gateway["platforms"]["zulip"]["state"] == "connected"
assert stat.S_IMODE(attestation_path.lstat().st_mode) == 0o600
assert not attestation_path.is_symlink()
assert attestation == {
    "schemaVersion": 1,
    "pid": gateway["pid"],
    "pluginVersion": "1.0.0",
    "pluginPath": str(release),
    "hook": "pre_gateway_dispatch",
    "ingressProfile": "zulip-ingress",
}
PY
assert_contains "$(< "$HERMES_HOME/.env")" "UNRELATED_SETTING=preserved" "root dotenv preserves unrelated values"
assert_contains "$(< "$HERMES_HOME/.env")" "HCO_CONFIG_PATH=$MUTATE_HCO_CONFIG" "root dotenv injects HCO config path"
assert_contains "$(< "$HERMES_HOME/.env")" "OPENAI_API_KEY=root-model-credential" "root dotenv preserves model credentials"
assert_contains "$(< "$HERMES_HOME/.env")" "FEISHU_APP_ID=root-feishu-id" "root dotenv preserves Feishu credentials"
assert_contains "$(< "$HERMES_HOME/.env")" "FEISHU_APP_SECRET=root-feishu-secret" "root dotenv preserves Feishu secrets"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_BOT_EMAIL=" "root dotenv relinquishes Zulip email"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_API_KEY=" "root dotenv relinquishes Zulip API key"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_SITE_URL=" "root dotenv relinquishes Zulip site"
assert_not_contains "$(< "$HERMES_HOME/.env")" "export ZULIP_" "root dotenv relinquishes exported Zulip settings"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_REQUIRE_MENTION=" "root dotenv relinquishes Zulip adapter settings"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_CONTEXT_DEPTH=" "root dotenv relinquishes Zulip context settings"
[[ -f "$HERMES_HOME/profiles/zulip-ingress/config.yaml" ]] || fail "zulip-ingress config is installed"
[[ -f "$HERMES_HOME/profiles/zulip-ingress/.env" ]] || fail "zulip-ingress credentials are installed"
[[ -f "$HERMES_HOME/profiles/zulip-ingress/SOUL.md" ]] || fail "zulip-ingress project-neutral reminder is installed"
[[ ! -e "$HERMES_HOME/ai.hermes.gateway.plist" ]] || fail "generated Hermes gateway plist is untouched"

PYTHONDONTWRITEBYTECODE=1 "$PYTHON" - "$HERMES_HOME" "$LAUNCH_AGENTS" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" "$PYTHON" <<'PY'
import inspect
import json
import os
import plistlib
import sys
from pathlib import Path

import yaml

home = Path(sys.argv[1])
sys.path.insert(0, "/Users/hula/Projects/hermesAgent")
os.environ["HERMES_HOME"] = str(home)
from hermes_cli.config import load_config
from hermes_cli.env_loader import load_hermes_dotenv
from hermes_cli.profiles import get_profile_dir
from hermes_cli.tools_config import _get_platform_tools
from hermes_cli.toolset_validation import validate_platform_toolsets
from toolsets import validate_toolset
import hermes_cli.plugins as plugin_module
from gateway.config import Platform, PlatformConfig, load_gateway_config
from gateway.run import (
    _profile_runtime_scope,
    _without_secondary_profile_platform_env,
)
import gateway.platforms.zulip as zulip_module

launch_agents = Path(sys.argv[2])
hco_config_text = sys.argv[3]
hco_config_path = Path(hco_config_text)
configured_codex = sys.argv[4]
expected_python = sys.argv[5]
assert hco_config_path.stat().st_mode & 0o777 == 0o600
assert json.loads(hco_config_path.read_text())["codexExecutablePath"] == configured_codex
root = yaml.safe_load((home / "config.yaml").read_text())
ingress = yaml.safe_load((home / "profiles/zulip-ingress/config.yaml").read_text())
bridge = yaml.safe_load((home / "profiles/codex-bridge/config.yaml").read_text())
general = yaml.safe_load((home / "profiles/hermes-general/config.yaml").read_text())
ask_jarvis = yaml.safe_load((home / "profiles/ask-jarvis-pm/config.yaml").read_text())
assert "hermes-codex-bridge" in root["plugins"]["enabled"]
assert "unrelated-fixture" in root["plugins"]["enabled"]
assert root["gateway"]["multiplex_profiles"] is True
assert root["multiplex_profiles"] is True
assert root["platforms"]["zulip"]["enabled"] is False
assert root["platforms"]["feishu"] == {"enabled": True, "port": 9001}
assert root["platform_toolsets"]["zulip"] == ["hermes-zulip"]
assert root["platform_toolsets"]["feishu"] == ["web"]
assert root["cwd"] == "/Users/hula/workspace/ASK"
assert root["system_prompt"] == "ASK root project prompt"
assert root["memory"] == {"enabled": True, "namespace": "ask-project-memory"}
assert root["task_guard"] == {
    "enabled": True,
    "ledger": "/Users/hula/.hermes/task_guard/tasks.json",
}
assert root["model"] == {"provider": "openai", "name": "ask-model"}
assert root["mcp_servers"]["qmd"]["enabled"] is True
assert root["mcp_servers"]["stockdata"]["enabled"] is True
assert ingress["platforms"]["zulip"]["enabled"] is True
assert ingress["platforms"]["zulip"] == {
    "enabled": True,
    "reply_to_mode": "topic",
    "typing_indicator": True,
    "home_channel": {
        "platform": "zulip",
        "chat_id": "stockprofits",
        "name": "Stockprofits",
    },
    "extra": {
        "bot_email": "root-zulip@example.invalid",
        "site_url": "https://root-zulip.example.invalid",
        "cert_bundle": "/operator/zulip-ca.pem",
        "allow_insecure": False,
        "require_mention": False,
        "free_response_streams": ["yaml-stream", "84"],
        "context_depth": 0,
        "catchup_enabled": False,
    },
}
assert ingress["platform_toolsets"]["zulip"] == ["zulip-history"]
assert set(ingress) <= {
    "platforms",
    "platform_toolsets",
    "known_plugin_toolsets",
    "agent",
    "mcp_servers",
    "context",
}
assert ingress.get("cwd") is None
assert ingress.get("system_prompt") is None
assert ingress.get("memory") is None
assert ingress.get("task_guard") is None
assert ingress.get("skills") is None
assert ingress.get("model") is None
assert ingress.get("plugins") is None
assert ingress.get("mcp_servers", {}) == {}
assert ingress.get("context", {}).get("engine") in (None, "none", "disabled")
assert "zulip-history" in ingress["agent"]["disabled_toolsets"]
assert bridge["platform_toolsets"]["zulip"] == ["zulip-history"]
assert bridge.get("cwd") is None
assert bridge.get("memory") is None
assert bridge.get("task_guard") is None
assert bridge["mcp_servers"]["qmd"]["enabled"] is False
assert bridge["mcp_servers"]["stockdata"]["enabled"] is False
assert validate_platform_toolsets(ingress["platform_toolsets"], validate_toolset) == []
assert validate_platform_toolsets(bridge["platform_toolsets"], validate_toolset) == []
assert "zulip-history" in bridge["agent"]["disabled_toolsets"]
assert "hco_bridge" in root.get("known_plugin_toolsets", {}).get("zulip", [])
assert "hco_bridge" not in ingress.get("known_plugin_toolsets", {}).get("zulip", [])
assert "hco_bridge" not in bridge.get("known_plugin_toolsets", {}).get("zulip", [])
assert "operator-known" in root["known_plugin_toolsets"]["zulip"]
assert "unrelated_fixture" in ingress["known_plugin_toolsets"]["zulip"]
assert "unrelated_fixture" in bridge["known_plugin_toolsets"]["zulip"]
assert "hco_bridge" not in general["platform_toolsets"]["zulip"]
assert "hco_bridge" not in general.get("known_plugin_toolsets", {}).get("zulip", [])
assert "operator-known" in general["known_plugin_toolsets"]["zulip"]
assert general["platform_toolsets"]["zulip"]
assert "no_mcp" not in general["platform_toolsets"]["zulip"]
assert validate_platform_toolsets(general["platform_toolsets"], validate_toolset) == []
assert general["mcp_servers"]["qmd"]["enabled"] is False
assert general["mcp_servers"]["stockdata"]["enabled"] is False
assert ask_jarvis == {
    "platforms": {
        "zulip": {
            "enabled": False,
            "token": "root-zulip-api-key",
            "require_mention": True,
        },
        "feishu": {"enabled": True, "port": 9911},
    },
    "cwd": "/Users/hula/workspace/ASK",
    "model": {"provider": "openai", "name": "ask-jarvis-model"},
    "custom_profile_setting": {"preserved": True},
}
assert (home / "profiles/ask-jarvis-pm/.env").read_text() == (
    "ZULIP_API_KEY=root-zulip-api-key\n"
    "PROFILE_ONLY_SETTING=preserved\n"
)

ingress_env_lines = [
    line
    for line in (home / "profiles/zulip-ingress/.env").read_text().splitlines()
    if line and not line.startswith("#")
]
assert set(ingress_env_lines) == {
    "ZULIP_BOT_EMAIL=ingress-zulip@example.invalid",
    "ZULIP_API_KEY=root-zulip-api-key",
    "ZULIP_SITE_URL=https://root-zulip.example.invalid",
    "ZULIP_CERT_BUNDLE=/wrong/dotenv-ca.pem",
    "ZULIP_ALLOW_INSECURE=true",
    "ZULIP_REQUIRE_MENTION=true",
    "ZULIP_FREE_RESPONSE_STREAMS=dotenv-stream,42",
    "ZULIP_CONTEXT_DEPTH=0",
    "ZULIP_CATCHUP=true",
}
assert all(line.startswith("ZULIP_") for line in ingress_env_lines)
reminder = (home / "profiles/zulip-ingress/SOUL.md").read_text()
assert "project-neutral" in reminder
assert "Codex" in reminder
assert "numeric Zulip stream ID" in reminder
assert "integrity-checked HCO route snapshot" in reminder
assert "channel name" in reminder
assert "topic" in reminder
assert "/Users/hula/workspace/ASK" not in reminder

load_hermes_dotenv(hermes_home=home)
manager = plugin_module.PluginManager()
plugin_module._plugin_manager = manager
manager.discover_and_load()
assert "unrelated_fixture_tool" in manager._plugin_tool_names
assert set(manager._plugin_commands) == {
    "codex",
    "hermes-codex-bridge-internal",
    "hermes-codex-bridge-natural",
    "hermes-codex-bridge-route-unavailable",
}
callbacks = manager._hooks.get("pre_gateway_dispatch", [])
assert callbacks and callbacks[0].__module__.startswith(
    "hermes_plugins.hermes_codex_bridge"
)
natural_handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
plugin_llm = inspect.getclosurevars(natural_handler).nonlocals["llm"]
assert callable(plugin_llm.acomplete_structured)
assert manager._plugins["hermes-codex-bridge"].tools_registered == []

ingress_home = get_profile_dir("zulip-ingress")
conflicting_zulip_env = {
    "ZULIP_API_KEY": "wrong-global-api-key",
    "ZULIP_BOT_EMAIL": "wrong-global@example.invalid",
    "ZULIP_SITE_URL": "https://wrong-global.example.invalid",
    "ZULIP_REQUIRE_MENTION": "false",
    "ZULIP_FREE_RESPONSE_STREAMS": "wrong-global-stream",
    "ZULIP_CONTEXT_DEPTH": "99",
}
os.environ.update(conflicting_zulip_env)
with _without_secondary_profile_platform_env(), _profile_runtime_scope(ingress_home):
    assert not any(name in os.environ for name in conflicting_zulip_env)
    ingress_gateway = load_gateway_config()
    platform_config = ingress_gateway.platforms.get(Platform.ZULIP, PlatformConfig())
    assert platform_config.enabled is True
    assert zulip_module.check_zulip_requirements(platform_config) is True
    adapter = zulip_module.ZulipAdapter(platform_config)
    assert adapter._api_key == "root-zulip-api-key"
    assert adapter._bot_email == "root-zulip@example.invalid"
    assert adapter._site_url == "https://root-zulip.example.invalid"
    assert adapter._cert_bundle == "/operator/zulip-ca.pem"
    assert adapter._allow_insecure is False
    assert adapter._context_depth == 0
    assert adapter._require_mention is False
    assert adapter._free_response_streams == {"yaml-stream", "84"}
    assert adapter._catchup_enabled is False
assert {
    name: os.environ.get(name)
    for name in conflicting_zulip_env
} == conflicting_zulip_env

os.environ["HERMES_HOME"] = str(home)
root_effective = load_config()
assert root_effective["cwd"] == "/Users/hula/workspace/ASK"
assert root_effective["mcp_servers"]["qmd"]["enabled"] is True
os.environ["HERMES_HOME"] = str(get_profile_dir("zulip-ingress"))
assert _get_platform_tools(load_config(), "zulip") == set()
os.environ["HERMES_HOME"] = str(get_profile_dir("codex-bridge"))
assert _get_platform_tools(load_config(), "zulip") == set()
for label in ("com.hermes.codex-bridge-hco", "com.hermes.codex-bridge-delivery"):
    path = launch_agents / f"{label}.plist"
    with path.open("rb") as stream:
        plist = plistlib.load(stream)
    assert plist["Label"] == label
    assert all(not isinstance(value, str) or "task9-mutating-secret" not in value for value in plist.values()), label
    if label == "com.hermes.codex-bridge-hco":
        assert plist["EnvironmentVariables"] == {"HCO_CONFIG_PATH": hco_config_text}, plist["EnvironmentVariables"]
    else:
        assert plist["ProgramArguments"][0] == expected_python
        assert plist["ProgramArguments"][1] == "-B"
        assert plist["ProgramArguments"][2].endswith("/delivery_sidecar.py")
PY
assert_contains "$(< "$LAUNCHCTL_LOG")" "bootstrap gui/$(id -u) $LAUNCH_AGENTS/com.hermes.codex-bridge-hco.plist" "HCO is bootstrapped independently"
assert_contains "$(< "$LAUNCHCTL_LOG")" "bootstrap gui/$(id -u) $LAUNCH_AGENTS/com.hermes.codex-bridge-delivery.plist" "delivery is bootstrapped independently"
pass "fresh install passes compatibility gates and atomically provisions isolated runtimes"

invoke_installer() {
  local hermes_home="$1"
  local config_path="$2"
  local codex_path="$3"
  local node_path="${HCO_TEST_NODE_BIN:-$(command -v node)}"
  local target_install_root="${HCO_TEST_INSTALL_ROOT:-$INSTALL_ROOT}"
  local installer_path="${HCO_TEST_INSTALLER:-$INSTALLER}"
  shift 3
  HERMES_HOME="$hermes_home" \
  HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
  HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
  HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
  HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
  HCO_TEST_FAKE_NODE="$FAKE_NODE" \
  HCO_TEST_TURN_START_MARKER="$TURN_START_MARKER" \
  PYTHONDONTWRITEBYTECODE=1 \
  /bin/bash "$installer_path" \
    --hco-config "$config_path" \
    --zulip-config "$MUTATE_ZULIP_CONFIG" \
    --install-root "$target_install_root" \
    --launch-agents-dir "$LAUNCH_AGENTS" \
    --node-bin "$node_path" \
    --codex-bin "$codex_path" \
    --launchctl-bin "$FAKE_LAUNCHCTL" \
    "$@"
}

control_launchctl() {
  HERMES_HOME="$HERMES_HOME" \
  HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
  HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
  HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
  HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
  HCO_TEST_FAKE_NODE="$FAKE_NODE" \
    "$FAKE_LAUNCHCTL" "$@"
}

seed_gateway_runtime_state() {
  local hermes_home="$1"
  mkdir -p "$hermes_home"
  printf '{"pid":%s,"gateway_state":"running","served_profiles":["default"],"platforms":{"feishu":{"state":"connected"}}}\n' \
    "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" > "$hermes_home/gateway_state.json"
  chmod 600 "$hermes_home/gateway_state.json"
}

launchctl_mutation_count() {
  rg -c '^(bootstrap|bootout|kickstart|kill) ' "$LAUNCHCTL_LOG" || true
}

printf '%s\n' \
  '' \
  'export ZULIP_REQUIRE_MENTION="alerts # urgent"' \
  'ZULIP_MULTILINE="line one' \
  'line two"' >> "$HERMES_HOME/profiles/zulip-ingress/.env"
"$PYTHON" - "$HERMES_HOME/profiles/zulip-ingress/config.yaml" <<'PY'
import sys
from pathlib import Path

import yaml

path = Path(sys.argv[1])
config = yaml.safe_load(path.read_text())
config["platforms"]["zulip"].update(
    {
        "enabled": False,
        "reply_to_mode": "stream",
        "typing_indicator": False,
        "extra": {"default_stream": "operator-stream"},
    }
)
path.write_text(yaml.safe_dump(config, sort_keys=False))
PY
REINSTALL_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)" \
  || fail "reinstall with existing ingress dotenv succeeds: $REINSTALL_OUTPUT"
PYTHONDONTWRITEBYTECODE=1 "$PYTHON" - "$HERMES_HOME/profiles/zulip-ingress/.env" "$HERMES_HOME/profiles/zulip-ingress/config.yaml" <<'PY'
import sys
from pathlib import Path

import yaml
from dotenv import dotenv_values

values = dotenv_values(Path(sys.argv[1]), interpolate=False)
assert values["ZULIP_BOT_EMAIL"] == "ingress-zulip@example.invalid"
assert values["ZULIP_API_KEY"] == "root-zulip-api-key"
assert values["ZULIP_SITE_URL"] == "https://root-zulip.example.invalid"
assert values["ZULIP_FREE_RESPONSE_STREAMS"] == "dotenv-stream,42"
assert values["ZULIP_REQUIRE_MENTION"] == "alerts # urgent"
assert values["ZULIP_MULTILINE"] == "line one\nline two"
assert values["ZULIP_CONTEXT_DEPTH"] == "0"
config = yaml.safe_load(Path(sys.argv[2]).read_text())
assert config["platforms"]["zulip"] == {
    "enabled": True,
    "reply_to_mode": "stream",
    "typing_indicator": False,
    "home_channel": {
        "platform": "zulip",
        "chat_id": "stockprofits",
        "name": "Stockprofits",
    },
    "extra": {
        "bot_email": "root-zulip@example.invalid",
        "site_url": "https://root-zulip.example.invalid",
        "cert_bundle": "/operator/zulip-ca.pem",
        "allow_insecure": False,
        "require_mention": False,
        "free_response_streams": ["yaml-stream", "84"],
        "context_depth": 0,
        "catchup_enabled": False,
        "default_stream": "operator-stream",
    },
}
PY
pass "install and reinstall merge Zulip YAML and dotenv without losing adapter settings"

cp "$HERMES_HOME/config.yaml" "$MUTATE_ROOT/config-before-zulip-only.yaml"
"$PYTHON" - "$HERMES_HOME/config.yaml" <<'PY'
import sys
from pathlib import Path

import yaml

path = Path(sys.argv[1])
config = yaml.safe_load(path.read_text())
config.setdefault("platforms", {}).setdefault("feishu", {})["enabled"] = False
path.write_text(yaml.safe_dump(config, sort_keys=False))
PY
printf '{"pid":%s,"gateway_state":"running","served_profiles":["default","zulip-ingress"],"platforms":{"zulip":{"state":"connected"}}}\n' \
  "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" > "$HERMES_HOME/gateway_state.json"
ZULIP_ONLY_OUTPUT="$(HCO_TEST_GATEWAY_ZULIP_ONLY=1 HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)" \
  || fail "Zulip-only Gateway install succeeds without requiring Feishu: $ZULIP_ONLY_OUTPUT"
"$PYTHON" - "$HERMES_HOME/config.yaml" "$HERMES_HOME/gateway_state.json" <<'PY'
import json
import sys
from pathlib import Path

import yaml

config = yaml.safe_load(Path(sys.argv[1]).read_text())
state = json.loads(Path(sys.argv[2]).read_text())
assert config["platforms"]["feishu"]["enabled"] is False
assert state["platforms"] == {"zulip": {"state": "connected"}}
PY
cp "$MUTATE_ROOT/config-before-zulip-only.yaml" "$HERMES_HOME/config.yaml"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"
pass "activation preserves a legitimate Zulip-only Gateway platform set"

DUAL_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
printf running > "$LAUNCHCTL_STATE/ai.hermes.gateway.gui"
printf 4200 > "$LAUNCHCTL_STATE/ai.hermes.gateway.gui.pid"
set +e
DUAL_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
DUAL_STATUS=$?
set -e
rm -f "$LAUNCHCTL_STATE/ai.hermes.gateway.gui" "$LAUNCHCTL_STATE/ai.hermes.gateway.gui.pid"
[[ $DUAL_STATUS -ne 0 ]] || fail "Gateway loaded in user and gui domains is rejected"
assert_contains "$DUAL_OUTPUT" "multiple launch domains" "dual-domain refusal is actionable"
[[ "$(launchctl_mutation_count)" == "$DUAL_MUTATIONS_BEFORE" ]] || fail "dual-domain refusal precedes launchd mutation"
pass "Gateway loaded in both launchd domains fails closed before mutation"

printf stopped > "$LAUNCHCTL_STATE/ai.hermes.gateway"
STOPPED_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
set +e
STOPPED_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
STOPPED_STATUS=$?
set -e
printf running > "$LAUNCHCTL_STATE/ai.hermes.gateway"
[[ $STOPPED_STATUS -ne 0 ]] || fail "loaded-but-stopped Gateway is rejected"
assert_contains "$STOPPED_OUTPUT" "Gateway is loaded but not running" "stopped Gateway refusal is actionable"
[[ "$(launchctl_mutation_count)" == "$STOPPED_MUTATIONS_BEFORE" ]] || fail "stopped Gateway refusal precedes launchd mutation"
pass "loaded-but-stopped Gateway fails before mutation"

cp "$HERMES_HOME/gateway_state.json" "$MUTATE_ROOT/gateway-state-valid.json"
for INVALID_GATEWAY_STATE in missing corrupt pid-mismatch; do
  case "$INVALID_GATEWAY_STATE" in
    missing)
      rm -f "$HERMES_HOME/gateway_state.json"
      ;;
    corrupt)
      printf '{not-json\n' > "$HERMES_HOME/gateway_state.json"
      ;;
    pid-mismatch)
      printf '{"pid":1,"gateway_state":"running","served_profiles":["default","zulip-ingress"],"platforms":{"feishu":{"state":"connected"},"zulip":{"state":"connected"}}}\n' \
        > "$HERMES_HOME/gateway_state.json"
      ;;
  esac
  INVALID_STATE_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
  set +e
  INVALID_STATE_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
  INVALID_STATE_STATUS=$?
  set -e
  cp "$MUTATE_ROOT/gateway-state-valid.json" "$HERMES_HOME/gateway_state.json"
  [[ $INVALID_STATE_STATUS -ne 0 ]] || fail "$INVALID_GATEWAY_STATE prior Gateway runtime evidence is rejected"
  assert_contains "$INVALID_STATE_OUTPUT" "Gateway runtime state" "$INVALID_GATEWAY_STATE runtime-evidence refusal is actionable"
  [[ "$(launchctl_mutation_count)" == "$INVALID_STATE_MUTATIONS_BEFORE" ]] || fail "$INVALID_GATEWAY_STATE runtime-evidence refusal precedes launchd mutation"
done
pass "untrusted prior Gateway runtime evidence fails closed before mutation"

ROLLBACK_GATEWAY_PID_BEFORE="$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")"
ROLLBACK_GATEWAY_LINK_BEFORE="$(readlink "$PLUGIN_LINK")"
set +e
ROLLBACK_GATEWAY_OUTPUT="$(HCO_TEST_GATEWAY_ATTESTATION_FAILURE=missing HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
ROLLBACK_GATEWAY_STATUS=$?
set -e
[[ $ROLLBACK_GATEWAY_STATUS -ne 0 ]] || fail "missing Gateway attestation aborts activation"
assert_contains "$ROLLBACK_GATEWAY_OUTPUT" "attestation" "Gateway attestation failure is explicit: $ROLLBACK_GATEWAY_OUTPUT"
[[ "$(readlink "$PLUGIN_LINK")" == "$ROLLBACK_GATEWAY_LINK_BEFORE" ]] || fail "Gateway failure rollback restores the stable plugin link"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway")" == "running" ]] || fail "Gateway failure rollback restores running intent"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" != "$ROLLBACK_GATEWAY_PID_BEFORE" ]] || fail "Gateway rollback restarts the prior configuration with a fresh PID"
assert_not_contains "$(< "$LAUNCHCTL_LOG")" "kill SIGTERM user/$(id -u)/ai.hermes.gateway" "Gateway rollback does not wait for a KeepAlive service to stop"
assert_contains "$(< "$LAUNCHCTL_LOG")" "kickstart -k user/$(id -u)/ai.hermes.gateway" "Gateway rollback atomically restarts the prior configuration"
pass "Gateway activation failure rolls back files and restores running intent"

rm -f "$LAUNCHCTL_STATE/ai.hermes.gateway.attestation-failure-injected"
set +e
RUNTIME_RENEWAL_ROLLBACK_OUTPUT="$(HCO_TEST_HCO_REWRITE_ROUTE_ON_START=1 HCO_TEST_GATEWAY_ATTESTATION_FAILURE=missing HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
RUNTIME_RENEWAL_ROLLBACK_STATUS=$?
set -e
[[ $RUNTIME_RENEWAL_ROLLBACK_STATUS -ne 0 ]] || fail "missing Gateway attestation still aborts activation when restored HCO renews runtime state"
assert_contains "$RUNTIME_RENEWAL_ROLLBACK_OUTPUT" "attestation" "runtime renewal rollback preserves the original activation failure"
assert_not_contains "$RUNTIME_RENEWAL_ROLLBACK_OUTPUT" "rollback verification failed" "restored HCO runtime renewal is not mistaken for rollback corruption"
[[ -f "$ROUTES_PATH" ]] || fail "restored HCO is allowed to republish its route snapshot after rollback"
pass "rollback accepts HCO-owned runtime renewal after restored service readiness"

LEGACY_ROLLBACK_RELEASE="$HERMES_HOME/plugins/hermes-codex-bridge-0.8.0-legacy"
mkdir -p "$LEGACY_ROLLBACK_RELEASE"
printf 'legacy plugin without schema v1 attestation\n' > "$LEGACY_ROLLBACK_RELEASE/legacy-no-attestation.marker"
CURRENT_PLUGIN_TARGET="$(readlink "$PLUGIN_LINK")"
rm "$PLUGIN_LINK"
ln -s "$(basename "$LEGACY_ROLLBACK_RELEASE")" "$PLUGIN_LINK"
LEGACY_ROLLBACK_PID_BEFORE="$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")"
printf '{"pid":%s,"gateway_state":"running","served_profiles":["default"],"platforms":{"feishu":{"state":"connected"}}}\n' \
  "$LEGACY_ROLLBACK_PID_BEFORE" > "$HERMES_HOME/gateway_state.json"
rm -f "$HERMES_HOME/hermes-codex-bridge-attestation.json"
rm -f "$LAUNCHCTL_STATE/ai.hermes.gateway.attestation-failure-injected"
set +e
LEGACY_ROLLBACK_OUTPUT="$(HCO_TEST_GATEWAY_ATTESTATION_FAILURE=missing HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
LEGACY_ROLLBACK_STATUS=$?
set -e
[[ $LEGACY_ROLLBACK_STATUS -ne 0 ]] || fail "missing new-plugin attestation aborts legacy upgrade activation"
assert_contains "$LEGACY_ROLLBACK_OUTPUT" "attestation" "legacy upgrade preserves the activation failure"
assert_not_contains "$LEGACY_ROLLBACK_OUTPUT" "rollback verification failed" "legacy rollback does not require a schema the old plugin cannot produce"
[[ "$(readlink "$PLUGIN_LINK")" == "$(basename "$LEGACY_ROLLBACK_RELEASE")" ]] || fail "legacy rollback restores the old stable plugin link"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway")" == "running" ]] || fail "legacy rollback restores Gateway running intent"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" != "$LEGACY_ROLLBACK_PID_BEFORE" ]] || fail "legacy rollback restarts the old Gateway with a fresh PID"
[[ ! -e "$HERMES_HOME/hermes-codex-bridge-attestation.json" ]] || fail "legacy rollback does not synthesize unsupported attestation"
"$PYTHON" - "$HERMES_HOME/gateway_state.json" "$LAUNCHCTL_STATE/ai.hermes.gateway.pid" <<'PY'
import json
import sys
from pathlib import Path

state = json.loads(Path(sys.argv[1]).read_text())
pid = int(Path(sys.argv[2]).read_text())
assert state == {
    "pid": pid,
    "gateway_state": "running",
    "served_profiles": ["default"],
    "platforms": {"feishu": {"state": "connected"}},
}
PY
rm "$PLUGIN_LINK"
ln -s "$CURRENT_PLUGIN_TARGET" "$PLUGIN_LINK"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"
pass "pre-remediation plugin rollback verifies only capabilities present before upgrade"

VERSIONED_ROLLBACK_RELEASE="$HERMES_HOME/plugins/hermes-codex-bridge-0.9.0-attested"
mkdir -p "$VERSIONED_ROLLBACK_RELEASE"
printf '0.9.0\n' > "$VERSIONED_ROLLBACK_RELEASE/attestation-version"
rm "$PLUGIN_LINK"
ln -s "$(basename "$VERSIONED_ROLLBACK_RELEASE")" "$PLUGIN_LINK"
VERSIONED_ROLLBACK_PID_BEFORE="$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"
rm -f "$LAUNCHCTL_STATE/ai.hermes.gateway.attestation-failure-injected"
set +e
VERSIONED_ROLLBACK_OUTPUT="$(HCO_TEST_GATEWAY_ATTESTATION_FAILURE=missing HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
VERSIONED_ROLLBACK_STATUS=$?
set -e
[[ $VERSIONED_ROLLBACK_STATUS -ne 0 ]] || fail "missing new-plugin attestation aborts versioned upgrade activation"
assert_contains "$VERSIONED_ROLLBACK_OUTPUT" "attestation" "versioned upgrade preserves the activation failure"
assert_not_contains "$VERSIONED_ROLLBACK_OUTPUT" "rollback verification failed" "versioned rollback accepts the restored old plugin version"
[[ "$(readlink "$PLUGIN_LINK")" == "$(basename "$VERSIONED_ROLLBACK_RELEASE")" ]] || fail "versioned rollback restores the old stable plugin link"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" != "$VERSIONED_ROLLBACK_PID_BEFORE" ]] || fail "versioned rollback restarts the old Gateway with a fresh PID"
"$PYTHON" - "$HERMES_HOME/hermes-codex-bridge-attestation.json" "$LAUNCHCTL_STATE/ai.hermes.gateway.pid" "$VERSIONED_ROLLBACK_RELEASE" <<'PY'
import json
import sys
from pathlib import Path

attestation = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "schemaVersion": 1,
    "pid": int(Path(sys.argv[2]).read_text()),
    "pluginVersion": "0.9.0",
    "pluginPath": str(Path(sys.argv[3]).resolve()),
    "hook": "pre_gateway_dispatch",
    "ingressProfile": "zulip-ingress",
}
assert attestation == expected, (attestation, expected)
PY
rm "$PLUGIN_LINK"
ln -s "$CURRENT_PLUGIN_TARGET" "$PLUGIN_LINK"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"
pass "attestation-capable cross-version rollback validates the restored release version"

hco_lifecycle_count() {
  if [[ -f "$HCO_LIFECYCLE_LOG" ]]; then
    wc -l < "$HCO_LIFECYCLE_LOG"
  else
    printf '0\n'
  fi
}

for KEEPALIVE_CASE in hco delivery both; do
  control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-hco"
  control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-delivery"
  case "$KEEPALIVE_CASE" in
    hco)
      control_launchctl kill SIGTERM "gui/$(id -u)/com.hermes.codex-bridge-hco"
      KEEPALIVE_STOPPED_LABELS="com.hermes.codex-bridge-hco"
      ;;
    delivery)
      control_launchctl kill SIGTERM "gui/$(id -u)/com.hermes.codex-bridge-delivery"
      KEEPALIVE_STOPPED_LABELS="com.hermes.codex-bridge-delivery"
      ;;
    both)
      control_launchctl kill SIGTERM "gui/$(id -u)/com.hermes.codex-bridge-hco"
      control_launchctl kill SIGTERM "gui/$(id -u)/com.hermes.codex-bridge-delivery"
      KEEPALIVE_STOPPED_LABELS="com.hermes.codex-bridge-hco com.hermes.codex-bridge-delivery"
      ;;
  esac
  KEEPALIVE_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
  KEEPALIVE_LIFECYCLE_BEFORE="$(hco_lifecycle_count)"
  KEEPALIVE_HCO_STATE_BEFORE="$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")"
  KEEPALIVE_DELIVERY_STATE_BEFORE="$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery")"
  set +e
  KEEPALIVE_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
  KEEPALIVE_STATUS=$?
  set -e
  [[ $KEEPALIVE_STATUS -ne 0 ]] || fail "$KEEPALIVE_CASE loaded-but-stopped KeepAlive state is rejected"
  assert_contains "$KEEPALIVE_OUTPUT" "loaded but stopped" "$KEEPALIVE_CASE refusal identifies the unsupported state"
  for KEEPALIVE_LABEL in $KEEPALIVE_STOPPED_LABELS; do
    assert_contains "$KEEPALIVE_OUTPUT" "$KEEPALIVE_LABEL" "$KEEPALIVE_CASE refusal identifies every stopped label"
  done
  [[ "$(launchctl_mutation_count)" == "$KEEPALIVE_MUTATIONS_BEFORE" ]] || fail "$KEEPALIVE_CASE refusal precedes launchd mutation"
  [[ "$(hco_lifecycle_count)" == "$KEEPALIVE_LIFECYCLE_BEFORE" ]] || fail "$KEEPALIVE_CASE refusal precedes temporary HCO handoff"
  [[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")" == "$KEEPALIVE_HCO_STATE_BEFORE" ]] || fail "$KEEPALIVE_CASE refusal preserves HCO state"
  [[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery")" == "$KEEPALIVE_DELIVERY_STATE_BEFORE" ]] || fail "$KEEPALIVE_CASE refusal preserves delivery state"
done
control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-hco"
control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-delivery"
pass "loaded-but-stopped KeepAlive states fail before mutation or temporary HCO handoff"

LOCK_TEST_ROOT_A="$MUTATE_ROOT/lock-target-a"
LOCK_TEST_ROOT_B="$MUTATE_ROOT/lock-target-b"
LOCK_TEST_SOCKET="$MUTATE_ROOT/lock-gate.sock"
LOCK_TEST_CONFIG="$MUTATE_ROOT/lock-hco.json"
LOCK_TEST_REQUESTS="$MUTATE_ROOT/lock-gate-requests"
LOCK_TEST_RELEASE="$MUTATE_ROOT/lock-gate-release"
LOCK_TEST_WINNER_OUTPUT="$MUTATE_ROOT/lock-winner.out"
LOCK_TEST_LOSER_A_OUTPUT="$MUTATE_ROOT/lock-loser-a.out"
LOCK_TEST_LOSER_B_OUTPUT="$MUTATE_ROOT/lock-loser-b.out"
PERSISTENT_LOCK="$($PYTHON - <<'PY'
import os
import pwd
from pathlib import Path

print(Path(pwd.getpwuid(os.getuid()).pw_dir) / ".hermes-codex-bridge-installer.lock")
PY
)"
mkdir -m 700 "$LOCK_TEST_ROOT_A" "$LOCK_TEST_ROOT_B"
printf 'preserve-a\n' > "$LOCK_TEST_ROOT_A/operator-marker"
printf 'preserve-b\n' > "$LOCK_TEST_ROOT_B/operator-marker"
chmod 600 "$LOCK_TEST_ROOT_A/operator-marker" "$LOCK_TEST_ROOT_B/operator-marker"
"$PYTHON" - "$MUTATE_HCO_CONFIG" "$LOCK_TEST_CONFIG" "$LOCK_TEST_SOCKET" <<'PY'
import json
import sys
from pathlib import Path

document = json.loads(Path(sys.argv[1]).read_text())
document["bridge"]["socketPath"] = sys.argv[3]
Path(sys.argv[2]).write_text(json.dumps(document))
PY
chmod 600 "$LOCK_TEST_CONFIG"
: > "$LOCK_TEST_REQUESTS"
"$PYTHON" - "$LOCK_TEST_SOCKET" "$LOCK_TEST_REQUESTS" "$LOCK_TEST_RELEASE" <<'PY' &
import json
import os
import socket
import sys
import threading
import time

socket_path, requests_path, release_path = sys.argv[1:]
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(8)

def serve(connection):
    with connection:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(65536)
            if not chunk:
                return
            request += chunk
        while not os.path.exists(release_path):
            time.sleep(0.02)
        body = json.dumps({
            "compatibility": {
                "protocolVersion": 1,
                "peerPluginVersion": "1.0.0",
                "capabilities": [],
            }
        }, separators=(",", ":")).encode()
        connection.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )

while True:
    connection, _ = server.accept()
    with open(requests_path, "a", encoding="utf-8") as stream:
        stream.write("entered\n")
        stream.flush()
    threading.Thread(target=serve, args=(connection,), daemon=True).start()
PY
LOCK_SERVER_PID=$!
for _ in {1..100}; do
  [[ -S "$LOCK_TEST_SOCKET" ]] && break
  sleep 0.02
done
[[ -S "$LOCK_TEST_SOCKET" ]] || fail "three-contender lock fixture starts"

(
  set +e
  HCO_INSTALLER_TEST_FAILPOINT=after_hermes_preflight \
  HCO_TEST_INSTALL_ROOT="$LOCK_TEST_ROOT_A" \
    invoke_installer "$HERMES_HOME" "$LOCK_TEST_CONFIG" "$FAKE_CODEX" > "$LOCK_TEST_WINNER_OUTPUT" 2>&1
  printf '%s\n' "$?" > "$LOCK_TEST_WINNER_OUTPUT.status"
) &
LOCK_WINNER_PID=$!
for _ in {1..200}; do
  [[ "$(wc -l < "$LOCK_TEST_REQUESTS")" -ge 1 ]] && break
  sleep 0.02
done
LOCK_WINNER_REQUEST_COUNT="$(wc -l < "$LOCK_TEST_REQUESTS")"
if [[ "$LOCK_WINNER_REQUEST_COUNT" -lt 1 ]]; then
  if kill -0 "$LOCK_WINNER_PID" 2>/dev/null; then
    LOCK_WINNER_STATE="running"
  else
    LOCK_WINNER_STATE="exited"
  fi
  fail "winner reaches compatibility gate while holding installer lock (state=$LOCK_WINNER_STATE status=$(< "$LOCK_TEST_WINNER_OUTPUT.status" 2>/dev/null || printf pending) target=$(find "$LOCK_TEST_ROOT_A" -maxdepth 1 -print | sort)): $(< "$LOCK_TEST_WINNER_OUTPUT")"
fi

LOCK_INODE_BEFORE="$($PYTHON - "$PERSISTENT_LOCK" <<'PY'
import os
import sys

try:
    print(os.lstat(sys.argv[1]).st_ino)
except FileNotFoundError:
    print("missing")
PY
)"
LOCK_TARGETS_BEFORE="$($PYTHON - "$LOCK_TEST_ROOT_A" "$LOCK_TEST_ROOT_B" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

result = []
for root_text in sys.argv[1:]:
    root = Path(root_text)
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        entry = [str(path.relative_to(root.parent)), info.st_ino, stat.S_IMODE(info.st_mode)]
        if path.is_file():
            entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
        elif path.is_symlink():
            entry.append(os.readlink(path))
        result.append(entry)
print(json.dumps(result, sort_keys=True))
PY
)"

(
  set +e
  HCO_INSTALLER_TEST_FAILPOINT=after_hermes_preflight \
  HCO_TEST_INSTALL_ROOT="$LOCK_TEST_ROOT_A" \
    invoke_installer "$HERMES_HOME" "$LOCK_TEST_CONFIG" "$FAKE_CODEX" > "$LOCK_TEST_LOSER_A_OUTPUT" 2>&1
  printf '%s\n' "$?" > "$LOCK_TEST_LOSER_A_OUTPUT.status"
) &
LOCK_LOSER_A_PID=$!
(
  set +e
  HCO_INSTALLER_TEST_FAILPOINT=after_hermes_preflight \
  HCO_TEST_INSTALL_ROOT="$LOCK_TEST_ROOT_B" \
    invoke_installer "$HERMES_HOME" "$LOCK_TEST_CONFIG" "$FAKE_CODEX" > "$LOCK_TEST_LOSER_B_OUTPUT" 2>&1
  printf '%s\n' "$?" > "$LOCK_TEST_LOSER_B_OUTPUT.status"
) &
LOCK_LOSER_B_PID=$!
for _ in {1..200}; do
  if [[ -f "$LOCK_TEST_LOSER_A_OUTPUT.status" && -f "$LOCK_TEST_LOSER_B_OUTPUT.status" ]]; then
    break
  fi
  [[ "$(wc -l < "$LOCK_TEST_REQUESTS")" -gt "$LOCK_WINNER_REQUEST_COUNT" ]] && break
  sleep 0.02
done
touch "$LOCK_TEST_RELEASE"
wait "$LOCK_WINNER_PID"
wait "$LOCK_LOSER_A_PID"
wait "$LOCK_LOSER_B_PID"

LOCK_INODE_AFTER="$($PYTHON - "$PERSISTENT_LOCK" <<'PY'
import os
import sys

try:
    print(os.lstat(sys.argv[1]).st_ino)
except FileNotFoundError:
    print("missing")
PY
)"
LOCK_TARGETS_AFTER="$($PYTHON - "$LOCK_TEST_ROOT_A" "$LOCK_TEST_ROOT_B" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

result = []
for root_text in sys.argv[1:]:
    root = Path(root_text)
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        entry = [str(path.relative_to(root.parent)), info.st_ino, stat.S_IMODE(info.st_mode)]
        if path.is_file():
            entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
        elif path.is_symlink():
            entry.append(os.readlink(path))
        result.append(entry)
print(json.dumps(result, sort_keys=True))
PY
)"
[[ "$LOCK_INODE_BEFORE" != "missing" ]] || fail "winner uses the stable per-user lock path"
[[ "$LOCK_INODE_AFTER" == "$LOCK_INODE_BEFORE" ]] || fail "stable lock pathname retains the winner's authoritative inode"
[[ "$(wc -l < "$LOCK_TEST_REQUESTS")" == "$LOCK_WINNER_REQUEST_COUNT" ]] || fail "neither same-target nor different-target loser enters transaction planning"
[[ "$LOCK_TARGETS_AFTER" == "$LOCK_TARGETS_BEFORE" ]] || fail "both losing installers perform zero target mutation"
assert_contains "$(< "$LOCK_TEST_LOSER_A_OUTPUT")" "another installer transaction is active" "same-target loser reports lock contention"
assert_contains "$(< "$LOCK_TEST_LOSER_B_OUTPUT")" "another installer transaction is active" "different-target loser reports global per-user contention"
pass "persistent per-user lock serializes three contenders before target mutation"

OLD_RELEASE="$HERMES_HOME/plugins/hermes-codex-bridge-0.9.0-previous"
mkdir -p "$OLD_RELEASE"
printf 'previous release\n' > "$OLD_RELEASE/installer-owned.marker"
rm "$PLUGIN_LINK"
ln -s "$(basename "$OLD_RELEASE")" "$PLUGIN_LINK"
UPGRADE_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)" || fail "upgrade succeeds: $UPGRADE_OUTPUT"
[[ -d "$OLD_RELEASE" ]] || fail "upgrade retains prior release through commit"
[[ "$(readlink "$PLUGIN_LINK")" == *"hermes-codex-bridge-1.0.0-"* ]] || fail "upgrade atomically selects current release"
[[ "$(rg -c '^HCO_CONFIG_PATH=' "$HERMES_HOME/.env")" == "1" ]] || fail "upgrade does not duplicate HCO_CONFIG_PATH"
pass "upgrade preserves the prior release and atomically switches the stable symlink"

ACTIVE_RELEASE="$(cd "$PLUGIN_LINK" && pwd -P)"
cp "$ACTIVE_RELEASE/plugin.py" "$MUTATE_ROOT/plugin.py.clean"
printf '\n# installer tamper fixture\n' >> "$ACTIVE_RELEASE/plugin.py"
set +e
TAMPER_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
TAMPER_STATUS=$?
set -e
cp "$MUTATE_ROOT/plugin.py.clean" "$ACTIVE_RELEASE/plugin.py"
chmod 600 "$ACTIVE_RELEASE/plugin.py"
[[ $TAMPER_STATUS -ne 0 ]] || fail "tampered digest-named plugin release is rejected"
assert_contains "$TAMPER_OUTPUT" "release integrity" "tampered release failure is explicit"
chmod 644 "$ACTIVE_RELEASE/plugin.py"
set +e
RELEASE_MODE_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
RELEASE_MODE_STATUS=$?
set -e
chmod 600 "$ACTIVE_RELEASE/plugin.py"
[[ $RELEASE_MODE_STATUS -ne 0 ]] || fail "plugin release with altered mode is rejected"
assert_contains "$RELEASE_MODE_OUTPUT" "release integrity" "release mode failure is explicit"
pass "digest-named releases require exact content, ownership, and modes"

UNMANAGED_HOME="$MUTATE_ROOT/unmanaged-hermes"
mkdir -p "$UNMANAGED_HOME/plugins/hermes-codex-bridge"
printf 'operator-owned\n' > "$UNMANAGED_HOME/plugins/hermes-codex-bridge/keep.txt"
LAUNCH_LINES_BEFORE="$(wc -l < "$LAUNCHCTL_LOG")"
set +e
UNMANAGED_OUTPUT="$(invoke_installer "$UNMANAGED_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
UNMANAGED_STATUS=$?
set -e
[[ $UNMANAGED_STATUS -ne 0 ]] || fail "unmanaged plugin directory is rejected"
assert_contains "$UNMANAGED_OUTPUT" "unmanaged plugin directory" "unmanaged refusal is actionable"
[[ "$(< "$UNMANAGED_HOME/plugins/hermes-codex-bridge/keep.txt")" == "operator-owned" ]] || fail "unmanaged directory is preserved"
[[ "$(wc -l < "$LAUNCHCTL_LOG")" == "$LAUNCH_LINES_BEFORE" ]] || fail "unmanaged refusal performs no launchctl mutation"
pass "unmanaged plugin directories are never destructively replaced"

BAD_HCO_CONFIG="$MUTATE_ROOT/bad-socket-hco.json"
"$PYTHON" - "$MUTATE_HCO_CONFIG" "$BAD_HCO_CONFIG" <<'PY'
import json
import sys
from pathlib import Path

document = json.loads(Path(sys.argv[1]).read_text())
document["bridge"]["socketPath"] = str(Path(sys.argv[2]).with_suffix(".missing.sock"))
Path(sys.argv[2]).write_text(json.dumps(document))
PY
chmod 600 "$BAD_HCO_CONFIG"
set +e
BAD_BRIDGE_OUTPUT="$(invoke_installer "$HERMES_HOME" "$BAD_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
BAD_BRIDGE_STATUS=$?
set -e
[[ $BAD_BRIDGE_STATUS -ne 0 ]] || fail "bridge incompatibility fails closed"
assert_contains "$BAD_BRIDGE_OUTPUT" "bridge protocol compatibility: failed" "bridge failure has its own label"

BAD_CODEX="$MUTATE_ROOT/bad-codex"
printf '#!/bin/bash\nexit 93\n' > "$BAD_CODEX"
chmod 700 "$BAD_CODEX"
set +e
CODEX_MISMATCH_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$BAD_CODEX" 2>&1)"
CODEX_MISMATCH_STATUS=$?
set -e
[[ $CODEX_MISMATCH_STATUS -ne 0 ]] || fail "configured and requested Codex path mismatch is rejected"
assert_contains "$CODEX_MISMATCH_OUTPUT" "does not match --codex-bin" "Codex path mismatch is explicit"

BAD_CODEX_CONFIG="$MUTATE_ROOT/bad-codex-hco.json"
"$PYTHON" - "$MUTATE_HCO_CONFIG" "$BAD_CODEX_CONFIG" "$BAD_CODEX" <<'PY'
import json
import sys
from pathlib import Path

document = json.loads(Path(sys.argv[1]).read_text())
document["codexExecutablePath"] = sys.argv[3]
Path(sys.argv[2]).write_text(json.dumps(document))
PY
chmod 600 "$BAD_CODEX_CONFIG"
set +e
BAD_CODEX_OUTPUT="$(invoke_installer "$HERMES_HOME" "$BAD_CODEX_CONFIG" "$BAD_CODEX" 2>&1)"
BAD_CODEX_STATUS=$?
set -e
[[ $BAD_CODEX_STATUS -ne 0 ]] || fail "App Server incompatibility fails closed"
assert_contains "$BAD_CODEX_OUTPUT" "installed Codex App Server compatibility: failed" "App Server failure has its own label"

PROFILE_HOME="$HERMES_HOME/profiles/not-default"
mkdir -p "$PROFILE_HOME"
set +e
BAD_HERMES_OUTPUT="$(invoke_installer "$PROFILE_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
BAD_HERMES_STATUS=$?
set -e
[[ $BAD_HERMES_STATUS -ne 0 ]] || fail "Hermes incompatibility fails closed"
assert_contains "$BAD_HERMES_OUTPUT" "installed Hermes compatibility: failed" "Hermes failure has its own label"
for output in "$BAD_BRIDGE_OUTPUT" "$BAD_CODEX_OUTPUT" "$BAD_HERMES_OUTPUT"; do
  assert_not_contains "$output" "$MUTATE_SECRET" "compatibility diagnostics redact secrets"
done
pass "three compatibility failures are distinct and secret-free"

printf '%s\n' 'ZULIP_CONTEXT_DEPTH=2' >> "$HERMES_HOME/.env"
set +e
DEPTH_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
DEPTH_STATUS=$?
set -e
[[ $DEPTH_STATUS -ne 0 ]] || fail "nonzero effective context depth requires authorization"
assert_contains "$DEPTH_OUTPUT" "--authorize-context-depth-zero" "context-depth refusal is actionable"
AUTHORIZED_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" --authorize-context-depth-zero 2>&1)" || fail "authorized context correction succeeds: $AUTHORIZED_OUTPUT"
assert_not_contains "$(< "$HERMES_HOME/.env")" "ZULIP_CONTEXT_DEPTH=" "authorized correction removes root depth settings"
[[ "$(rg -c '^ZULIP_CONTEXT_DEPTH=0$' "$HERMES_HOME/profiles/zulip-ingress/.env")" == "1" ]] || fail "authorized correction writes exactly one ingress zero depth"
pass "effective Zulip context depth requires explicit correction authorization"

printf '%s\n' \
  'UNRELATED_SETTING=preserved' \
  'HCO_CONFIG_PATH=/operator/dotenv/path.json' \
  'ZULIP_CONTEXT_DEPTH=7' > "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"
set +e
PROCESS_ENV_OUTPUT="$(
  HCO_CONFIG_PATH="$MUTATE_HCO_CONFIG" \
  ZULIP_CONTEXT_DEPTH=0 \
  invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
PROCESS_ENV_STATUS=$?
set -e
[[ $PROCESS_ENV_STATUS -ne 0 ]] || fail "root dotenv context depth cannot be shadowed by shell value"
assert_contains "$PROCESS_ENV_OUTPUT" "--authorize-context-depth-zero" "root dotenv context depth refusal is actionable"
assert_contains "$(< "$HERMES_HOME/.env")" "HCO_CONFIG_PATH=/operator/dotenv/path.json" "refused context correction preserves root dotenv"
set +e
CONFLICTING_HCO_OUTPUT="$(
  HCO_CONFIG_PATH="$MUTATE_ROOT/different-hco.json" \
  invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
CONFLICTING_HCO_STATUS=$?
set -e
[[ $CONFLICTING_HCO_STATUS -ne 0 ]] || fail "conflicting process HCO_CONFIG_PATH is rejected"
assert_contains "$CONFLICTING_HCO_OUTPUT" "process HCO_CONFIG_PATH" "HCO environment conflict is actionable"
printf '%s\n' \
  'UNRELATED_SETTING=preserved' \
  "HCO_CONFIG_PATH=$MUTATE_HCO_CONFIG" \
  'ZULIP_CONTEXT_DEPTH=0' > "$HERMES_HOME/.env"
chmod 600 "$HERMES_HOME/.env"
pass "root dotenv precedence is enforced while process HCO conflicts remain actionable"

MANAGED_HERMES_DIR="$MUTATE_ROOT/managed-hermes"
mkdir -p "$MANAGED_HERMES_DIR"
printf '%s\n' \
  "HCO_CONFIG_PATH=$MUTATE_HCO_CONFIG" \
  'ZULIP_CONTEXT_DEPTH=9' > "$MANAGED_HERMES_DIR/.env"
chmod 600 "$MANAGED_HERMES_DIR/.env"
set +e
MANAGED_DEPTH_OUTPUT="$(
  HERMES_MANAGED_DIR="$MANAGED_HERMES_DIR" \
  invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" --authorize-context-depth-zero 2>&1
)"
MANAGED_DEPTH_STATUS=$?
set -e
[[ $MANAGED_DEPTH_STATUS -ne 0 ]] || fail "managed context depth cannot be shadowed by staged root dotenv"
assert_contains "$MANAGED_DEPTH_OUTPUT" "staged effective Hermes enabled fixture failed" "managed context depth refusal comes from effective loader probe"
pass "managed scope remains the final effective dotenv override"

PROJECT_FALLBACK_REPO="$MUTATE_ROOT/project-fallback-repository"
PROJECT_FALLBACK_HOME="$MUTATE_ROOT/project-fallback-hermes"
PROJECT_FALLBACK_ENV="$MUTATE_ROOT/project-fallback.env"
ADJACENT_HERMES_ENV="/Users/hula/Projects/hermesAgent/.env"
mkdir -p "$PROJECT_FALLBACK_REPO/scripts" "$PROJECT_FALLBACK_REPO/plugin" "$PROJECT_FALLBACK_REPO/hco"
cp "$INSTALLER" "$PROJECT_FALLBACK_REPO/scripts/install-hermes-codex-bridge.sh"
cp -R "$ROOT/plugin/hermes-codex-bridge" "$PROJECT_FALLBACK_REPO/plugin/hermes-codex-bridge"
cp "$ROOT/hco/index.js" "$PROJECT_FALLBACK_REPO/hco/index.js"
printf 'ZULIP_CONTEXT_DEPTH=7\0\n' > "$PROJECT_FALLBACK_ENV"
chmod 600 "$PROJECT_FALLBACK_ENV"
"$PYTHON" - "$PROJECT_FALLBACK_REPO/scripts/install-hermes-codex-bridge.sh" "$PROJECT_FALLBACK_ENV" <<'PY'
import sys
from pathlib import Path

installer = Path(sys.argv[1])
project_env = sys.argv[2]
source = installer.read_text(encoding="utf-8")
pinned = "/Users/hula/Projects/hermesAgent/.env"
if source.count(pinned) != 1:
    raise SystemExit("expected exactly one pinned Hermes project dotenv reference")
installer.write_text(source.replace(pinned, project_env), encoding="utf-8")
PY
chmod 700 "$PROJECT_FALLBACK_REPO/scripts/install-hermes-codex-bridge.sh"
PROJECT_FALLBACK_ENV_BEFORE="$("$PYTHON" - "$PROJECT_FALLBACK_ENV" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
info = os.lstat(path)
with open(path, "rb") as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, digest)
PY
)"
PROJECT_FALLBACK_ADJACENT_BEFORE="$("$PYTHON" - "$ADJACENT_HERMES_ENV" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
info = os.lstat(path)
with open(path, "rb") as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, digest)
PY
)"
seed_gateway_runtime_state "$PROJECT_FALLBACK_HOME"
set +e
PROJECT_FALLBACK_OUTPUT="$(
  HCO_TEST_INSTALLER="$PROJECT_FALLBACK_REPO/scripts/install-hermes-codex-bridge.sh" \
  invoke_installer "$PROJECT_FALLBACK_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
PROJECT_FALLBACK_STATUS=$?
set -e
[[ $PROJECT_FALLBACK_STATUS -ne 0 ]] || fail "project-fallback context depth requires authorization"
PROJECT_FALLBACK_AUTHORIZED_OUTPUT="$(
  HCO_TEST_INSTALLER="$PROJECT_FALLBACK_REPO/scripts/install-hermes-codex-bridge.sh" \
  invoke_installer "$PROJECT_FALLBACK_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" --authorize-context-depth-zero 2>&1
)" || fail "authorized project-fallback context correction succeeds: $PROJECT_FALLBACK_AUTHORIZED_OUTPUT"
assert_contains "$PROJECT_FALLBACK_OUTPUT" "--authorize-context-depth-zero" "project-fallback context-depth refusal is actionable"
assert_not_contains "$(< "$PROJECT_FALLBACK_HOME/.env")" "ZULIP_CONTEXT_DEPTH=" "project-fallback correction removes root depth settings"
[[ "$(rg -c '^ZULIP_CONTEXT_DEPTH=0$' "$PROJECT_FALLBACK_HOME/profiles/zulip-ingress/.env")" == "1" ]] || fail "project-fallback correction writes exactly one ingress zero depth"
PROJECT_FALLBACK_ENV_AFTER="$("$PYTHON" - "$PROJECT_FALLBACK_ENV" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
info = os.lstat(path)
with open(path, "rb") as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, digest)
PY
)"
[[ "$PROJECT_FALLBACK_ENV_AFTER" == "$PROJECT_FALLBACK_ENV_BEFORE" ]] || fail "project-fallback resolution never sanitizes the source dotenv in place"
PROJECT_FALLBACK_ADJACENT_AFTER="$("$PYTHON" - "$ADJACENT_HERMES_ENV" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
info = os.lstat(path)
with open(path, "rb") as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
print(info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, digest)
PY
)"
[[ "$PROJECT_FALLBACK_ADJACENT_AFTER" == "$PROJECT_FALLBACK_ADJACENT_BEFORE" ]] || fail "project-fallback regression leaves adjacent Hermes dotenv unchanged"
pass "Hermes project-fallback depth requires explicit transactional correction authorization"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"

chmod 644 "$BEARER_PATH"
set +e
PERMISSION_OUTPUT="$(invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
PERMISSION_STATUS=$?
set -e
chmod 600 "$BEARER_PATH"
[[ $PERMISSION_STATUS -ne 0 ]] || fail "permissive protected files are rejected"
assert_contains "$PERMISSION_OUTPUT" "owner-only regular file" "protected-mode failure is actionable"
SYMLINK_BEARER="$MUTATE_ROOT/symlink.bearer"
ln -s "$BEARER_PATH" "$SYMLINK_BEARER"
SYMLINK_HCO_CONFIG="$MUTATE_ROOT/symlink-hco.json"
"$PYTHON" - "$MUTATE_HCO_CONFIG" "$SYMLINK_HCO_CONFIG" "$SYMLINK_BEARER" <<'PY'
import json
import sys
from pathlib import Path

document = json.loads(Path(sys.argv[1]).read_text())
document["bridge"]["tokenPath"] = sys.argv[3]
Path(sys.argv[2]).write_text(json.dumps(document))
PY
chmod 600 "$SYMLINK_HCO_CONFIG"
set +e
SYMLINK_OUTPUT="$(invoke_installer "$HERMES_HOME" "$SYMLINK_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
SYMLINK_STATUS=$?
set -e
[[ $SYMLINK_STATUS -ne 0 ]] || fail "symlinked protected files are rejected"
assert_not_contains "$SYMLINK_OUTPUT" "$MUTATE_SECRET" "protected-file failures redact secrets"
pass "protected installer inputs fail closed on mode and symlink violations"

HCO_SERVER_PID=''
HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  "$FAKE_LAUNCHCTL" bootout "gui/$(id -u)/com.hermes.codex-bridge-delivery"
control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-hco"
[[ -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco" ]] || fail "HCO remains independently loaded"
[[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")" == "running" ]] || fail "HCO is running before rollback drill"
[[ ! -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery" ]] || fail "delivery is independently unloaded"
ROLLBACK_PLUGIN_RELEASE="$(cd -P "$PLUGIN_LINK" && pwd)"
ROLLBACK_STALE_ATTESTATION_PID=$(( $(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid") - 1 ))
printf '{"schemaVersion":1,"pid":%s,"pluginVersion":"1.0.0","pluginPath":"%s","hook":"pre_gateway_dispatch","ingressProfile":"zulip-ingress"}\n' \
  "$ROLLBACK_STALE_ATTESTATION_PID" "$ROLLBACK_PLUGIN_RELEASE" > "$HERMES_HOME/hermes-codex-bridge-attestation.json"
chmod 600 "$HERMES_HOME/hermes-codex-bridge-attestation.json"
"$PYTHON" - "$HERMES_HOME/profiles/ask-jarvis-pm/config.yaml" <<'PY'
import sys
from pathlib import Path

import yaml

path = Path(sys.argv[1])
config = yaml.safe_load(path.read_text())
config["platforms"]["zulip"]["enabled"] = True
path.write_text(yaml.safe_dump(config, sort_keys=False))
PY
ROLLBACK_ENV_BEFORE="$(< "$HERMES_HOME/.env")"
ROLLBACK_CONFIG_BEFORE="$(< "$HERMES_HOME/config.yaml")"
ROLLBACK_INGRESS_CONFIG_BEFORE="$(< "$HERMES_HOME/profiles/zulip-ingress/config.yaml")"
ROLLBACK_INGRESS_ENV_BEFORE="$(< "$HERMES_HOME/profiles/zulip-ingress/.env")"
ROLLBACK_INGRESS_REMINDER_BEFORE="$(< "$HERMES_HOME/profiles/zulip-ingress/SOUL.md")"
ROLLBACK_BRIDGE_CONFIG_BEFORE="$(< "$HERMES_HOME/profiles/codex-bridge/config.yaml")"
ROLLBACK_GENERAL_CONFIG_BEFORE="$(< "$HERMES_HOME/profiles/hermes-general/config.yaml")"
ROLLBACK_ASK_CONFIG_HASH_BEFORE="$(shasum -a 256 "$HERMES_HOME/profiles/ask-jarvis-pm/config.yaml")"
ROLLBACK_ASK_ENV_HASH_BEFORE="$(shasum -a 256 "$HERMES_HOME/profiles/ask-jarvis-pm/.env")"
ROLLBACK_LINK_BEFORE="$(readlink "$PLUGIN_LINK")"
set +e
ROLLBACK_OUTPUT="$(HCO_TEST_ASYNC_BOOTOUT=1 HCO_TEST_NODE_BIN="$FAKE_NODE" HCO_INSTALLER_TEST_FAILPOINT=after_hco_bootstrap invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
ROLLBACK_STATUS=$?
set -e
[[ $ROLLBACK_STATUS -ne 0 ]] || fail "injected post-HCO failure aborts installation"
assert_contains "$ROLLBACK_OUTPUT" "injected failure" "rollback test reaches injected failure: $ROLLBACK_OUTPUT"
[[ "$(< "$HERMES_HOME/.env")" == "$ROLLBACK_ENV_BEFORE" ]] || fail "rollback restores root dotenv exactly"
[[ "$(< "$HERMES_HOME/config.yaml")" == "$ROLLBACK_CONFIG_BEFORE" ]] || fail "rollback restores root config exactly"
[[ "$(< "$HERMES_HOME/profiles/zulip-ingress/config.yaml")" == "$ROLLBACK_INGRESS_CONFIG_BEFORE" ]] || fail "rollback restores zulip-ingress config exactly"
[[ "$(< "$HERMES_HOME/profiles/zulip-ingress/.env")" == "$ROLLBACK_INGRESS_ENV_BEFORE" ]] || fail "rollback restores zulip-ingress dotenv exactly"
[[ "$(< "$HERMES_HOME/profiles/zulip-ingress/SOUL.md")" == "$ROLLBACK_INGRESS_REMINDER_BEFORE" ]] || fail "rollback restores zulip-ingress reminder exactly"
[[ "$(< "$HERMES_HOME/profiles/codex-bridge/config.yaml")" == "$ROLLBACK_BRIDGE_CONFIG_BEFORE" ]] || fail "rollback restores codex-bridge config exactly"
[[ "$(< "$HERMES_HOME/profiles/hermes-general/config.yaml")" == "$ROLLBACK_GENERAL_CONFIG_BEFORE" ]] || fail "rollback restores hermes-general config exactly"
[[ "$(shasum -a 256 "$HERMES_HOME/profiles/ask-jarvis-pm/config.yaml")" == "$ROLLBACK_ASK_CONFIG_HASH_BEFORE" ]] || fail "rollback restores external profile config byte-for-byte"
[[ "$(shasum -a 256 "$HERMES_HOME/profiles/ask-jarvis-pm/.env")" == "$ROLLBACK_ASK_ENV_HASH_BEFORE" ]] || fail "rollback leaves external profile dotenv byte-for-byte unchanged"
[[ "$(readlink "$PLUGIN_LINK")" == "$ROLLBACK_LINK_BEFORE" ]] || fail "rollback restores stable symlink target"
"$PYTHON" - "$HERMES_HOME/hermes-codex-bridge-attestation.json" "$LAUNCHCTL_STATE/ai.hermes.gateway.pid" "$ROLLBACK_PLUGIN_RELEASE" <<'PY'
import json
import sys
from pathlib import Path

attestation = json.loads(Path(sys.argv[1]).read_text())
assert attestation == {
    "schemaVersion": 1,
    "pid": int(Path(sys.argv[2]).read_text()),
    "pluginVersion": "1.0.0",
    "pluginPath": sys.argv[3],
    "hook": "pre_gateway_dispatch",
    "ingressProfile": "zulip-ingress",
}
PY
[[ -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco" ]] || fail "rollback restores prior HCO loaded state"
[[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")" == "running" ]] || fail "rollback restores prior HCO running state"
[[ ! -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery" ]] || fail "rollback restores prior delivery unloaded state"
assert_not_contains "$ROLLBACK_OUTPUT" "$MUTATE_SECRET" "rollback output redacts secrets"
pass "rollback restores files, symlink, and supported independent prior service states"

PREFLIGHT_CONFIG_BEFORE="$(< "$HERMES_HOME/config.yaml")"
set +e
PREFLIGHT_ROLLBACK_OUTPUT="$(
  HCO_INSTALLER_TEST_PREFLIGHT_TOUCH=1 \
  HCO_INSTALLER_TEST_FAILPOINT=after_hermes_preflight \
  HCO_TEST_NODE_BIN="$FAKE_NODE" \
  invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
PREFLIGHT_ROLLBACK_STATUS=$?
set -e
[[ $PREFLIGHT_ROLLBACK_STATUS -ne 0 ]] || fail "injected Hermes preflight failure aborts installation"
assert_contains "$PREFLIGHT_ROLLBACK_OUTPUT" "after Hermes preflight" "preflight rollback reaches injected failure"
[[ "$(< "$HERMES_HOME/config.yaml")" == "$PREFLIGHT_CONFIG_BEFORE" ]] || fail "preflight side effect is restored from the earlier manifest"
pass "transaction snapshots precede potentially mutating Hermes loaders"

STAGED_PROBE_STATE_BEFORE="$("$PYTHON" - "$HERMES_HOME" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
paths = [
    root / ".env",
    root / "config.yaml",
    root / "profiles/zulip-ingress/config.yaml",
    root / "profiles/zulip-ingress/.env",
    root / "profiles/zulip-ingress/SOUL.md",
    root / "profiles/codex-bridge/config.yaml",
    root / "profiles/hermes-general/config.yaml",
]
state = {
    "files": {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in paths
    },
    "stable_target": os.readlink(root / "plugins/hermes-codex-bridge"),
    "releases": sorted(
        path.name
        for path in (root / "plugins").iterdir()
        if path.is_dir() and path.name.startswith("hermes-codex-bridge-")
    ),
}
print(json.dumps(state, sort_keys=True))
PY
)"
STAGED_PROBE_LAUNCH_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
set +e
STAGED_PROBE_OUTPUT="$(
  HCO_INSTALLER_TEST_FAILPOINT=staged_hermes_probe \
  HCO_TEST_NODE_BIN="$FAKE_NODE" \
  invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
STAGED_PROBE_STATUS=$?
set -e
[[ $STAGED_PROBE_STATUS -ne 0 ]] || fail "staged effective Hermes probe runs before live activation"
assert_contains "$STAGED_PROBE_OUTPUT" "staged Hermes probe" "staged probe failpoint is explicit"
STAGED_PROBE_STATE_AFTER="$("$PYTHON" - "$HERMES_HOME" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
paths = [
    root / ".env",
    root / "config.yaml",
    root / "profiles/zulip-ingress/config.yaml",
    root / "profiles/zulip-ingress/.env",
    root / "profiles/zulip-ingress/SOUL.md",
    root / "profiles/codex-bridge/config.yaml",
    root / "profiles/hermes-general/config.yaml",
]
state = {
    "files": {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in paths
    },
    "stable_target": os.readlink(root / "plugins/hermes-codex-bridge"),
    "releases": sorted(
        path.name
        for path in (root / "plugins").iterdir()
        if path.is_dir() and path.name.startswith("hermes-codex-bridge-")
    ),
}
print(json.dumps(state, sort_keys=True))
PY
)"
[[ "$STAGED_PROBE_STATE_AFTER" == "$STAGED_PROBE_STATE_BEFORE" ]] || fail "staged probe failure preserves every live Hermes artifact"
[[ "$(launchctl_mutation_count)" == "$STAGED_PROBE_LAUNCH_MUTATIONS_BEFORE" ]] || fail "staged probe failure precedes launchctl mutation"
pass "effective Hermes behavior is staged and probed before live activation"

SOURCE_MUTATION_REPO="$MUTATE_ROOT/source-mutation-repository"
SOURCE_MUTATION_HOME="$MUTATE_ROOT/source-mutation-hermes"
SOURCE_MUTATION_MARKER="$MUTATE_ROOT/source-mutation-observed"
seed_gateway_runtime_state "$SOURCE_MUTATION_HOME"
mkdir -p "$SOURCE_MUTATION_REPO/scripts" "$SOURCE_MUTATION_REPO/plugin" "$SOURCE_MUTATION_REPO/hco"
cp "$INSTALLER" "$SOURCE_MUTATION_REPO/scripts/install-hermes-codex-bridge.sh"
cp -R "$ROOT/plugin/hermes-codex-bridge" "$SOURCE_MUTATION_REPO/plugin/hermes-codex-bridge"
cp "$ROOT/hco/index.js" "$SOURCE_MUTATION_REPO/hco/index.js"
(
  for _ in $(seq 1 3000); do
    if [[ -n "$(find "$MUTATE_ROOT" -maxdepth 1 -type d -name '.source-mutation-hermes.hco-staged-probe-*' -print -quit)" ]]; then
      printf '%s\n' '# source changed after staged probe began' >> "$SOURCE_MUTATION_REPO/plugin/hermes-codex-bridge/__init__.py"
      : > "$SOURCE_MUTATION_MARKER"
      exit 0
    fi
    sleep 0.01
  done
  exit 1
) &
SOURCE_MUTATION_WATCHER_PID=$!
set +e
SOURCE_MUTATION_OUTPUT="$(
  HCO_TEST_INSTALLER="$SOURCE_MUTATION_REPO/scripts/install-hermes-codex-bridge.sh" \
  invoke_installer "$SOURCE_MUTATION_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
SOURCE_MUTATION_STATUS=$?
wait "$SOURCE_MUTATION_WATCHER_PID"
SOURCE_MUTATION_WATCHER_STATUS=$?
set -e
[[ $SOURCE_MUTATION_STATUS -eq 0 ]] || fail "source-mutation install succeeds: $SOURCE_MUTATION_OUTPUT"
[[ $SOURCE_MUTATION_WATCHER_STATUS -eq 0 && -f "$SOURCE_MUTATION_MARKER" ]] || fail "source mutation occurs while the staged probe is active"
assert_not_contains "$(< "$SOURCE_MUTATION_HOME/plugins/hermes-codex-bridge/__init__.py")" "source changed after staged probe began" "activated release is the exact artifact that passed the staged probe"
pass "activation promotes the exact probed plugin artifact without rereading source"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"

STAGING_FAILURE_HOME="$MUTATE_ROOT/staging-failure-hermes"
mkdir -p "$STAGING_FAILURE_HOME/plugins"
chmod 700 "$STAGING_FAILURE_HOME" "$STAGING_FAILURE_HOME/plugins"
seed_gateway_runtime_state "$STAGING_FAILURE_HOME"
printf 'operator sibling\n' > "$STAGING_FAILURE_HOME/plugins/operator-marker"
chmod 600 "$STAGING_FAILURE_HOME/plugins/operator-marker"
STAGING_FAILURE_STATE_BEFORE="$($PYTHON - "$STAGING_FAILURE_HOME" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
state = []
for path in sorted(root.rglob("*")):
    info = path.lstat()
    entry = [str(path.relative_to(root)), stat.S_IMODE(info.st_mode)]
    if path.is_file() and not path.is_symlink():
        entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
    elif path.is_symlink():
        entry.append(os.readlink(path))
    state.append(entry)
print(json.dumps(state, sort_keys=True))
PY
)"
for STAGING_FAILPOINT in release_copy release_chmod release_replace stable_symlink stable_replace; do
  STAGING_FAILURE_LAUNCH_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
  set +e
  STAGING_FAILURE_OUTPUT="$(
    HCO_INSTALLER_TEST_FAILPOINT="$STAGING_FAILPOINT" \
    HCO_TEST_NODE_BIN="$FAKE_NODE" \
    invoke_installer "$STAGING_FAILURE_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
  )"
  STAGING_FAILURE_STATUS=$?
  set -e
  [[ $STAGING_FAILURE_STATUS -ne 0 ]] || fail "$STAGING_FAILPOINT injected staging failure aborts installation"
  assert_contains "$STAGING_FAILURE_OUTPUT" "injected failure" "$STAGING_FAILPOINT failure is explicit"
  [[ "$(launchctl_mutation_count)" == "$STAGING_FAILURE_LAUNCH_MUTATIONS_BEFORE" ]] || fail "$STAGING_FAILPOINT failure precedes launchctl mutation"
  [[ -z "$(find "$STAGING_FAILURE_HOME/plugins" -maxdepth 1 \( -name '.*.staging-*' -o -name '.*.next-*' \) -print -quit)" ]] || fail "$STAGING_FAILPOINT leaves no release or symlink staging residue"
  [[ -z "$(find "$STAGING_FAILURE_HOME/.." -maxdepth 1 -name ".$(basename "$STAGING_FAILURE_HOME").hco-*" -print -quit)" ]] || fail "$STAGING_FAILPOINT leaves no effective-Hermes stage or probe residue"
  STAGING_FAILURE_STATE_AFTER="$($PYTHON - "$STAGING_FAILURE_HOME" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
state = []
for path in sorted(root.rglob("*")):
    info = path.lstat()
    entry = [str(path.relative_to(root)), stat.S_IMODE(info.st_mode)]
    if path.is_file() and not path.is_symlink():
        entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
    elif path.is_symlink():
        entry.append(os.readlink(path))
    state.append(entry)
print(json.dumps(state, sort_keys=True))
PY
)"
  if [[ "$STAGING_FAILURE_STATE_AFTER" != "$STAGING_FAILURE_STATE_BEFORE" ]]; then
    printf 'before=%s\nafter=%s\n' "$STAGING_FAILURE_STATE_BEFORE" "$STAGING_FAILURE_STATE_AFTER" >&2
    fail "$STAGING_FAILPOINT rollback preserves every pre-existing sibling"
  fi
done
pass "release and symlink staging failures leave no residue or sibling damage"

FAILED_FIRST_PROFILE_HOME="$MUTATE_ROOT/failed-first-profile-hermes"
mkdir -m 700 "$FAILED_FIRST_PROFILE_HOME"
printf 'pre-existing Hermes home\n' > "$FAILED_FIRST_PROFILE_HOME/operator-marker"
FAILED_FIRST_PROFILE_GATEWAY_PID_BEFORE="$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")"
seed_gateway_runtime_state "$FAILED_FIRST_PROFILE_HOME"
set +e
FAILED_FIRST_PROFILE_OUTPUT="$(
  HCO_INSTALLER_TEST_FAILPOINT=after_hco_bootstrap \
  HCO_TEST_NODE_BIN="$FAKE_NODE" \
  invoke_installer "$FAILED_FIRST_PROFILE_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
FAILED_FIRST_PROFILE_STATUS=$?
set -e
[[ $FAILED_FIRST_PROFILE_STATUS -ne 0 ]] || fail "failed first profile install reaches injected post-activation failure"
assert_contains "$FAILED_FIRST_PROFILE_OUTPUT" "injected failure" "failed first profile install preserves the original failure"
[[ "$(< "$FAILED_FIRST_PROFILE_HOME/operator-marker")" == "pre-existing Hermes home" ]] || fail "failed first profile install preserves the pre-existing Hermes home"
[[ ! -e "$FAILED_FIRST_PROFILE_HOME/profiles/zulip-ingress" ]] || fail "failed first profile install removes its transaction-created ingress profile"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway")" == "running" ]] || fail "failed first profile install restores Gateway running intent"
[[ "$(< "$LAUNCHCTL_STATE/ai.hermes.gateway.pid")" != "$FAILED_FIRST_PROFILE_GATEWAY_PID_BEFORE" ]] || fail "failed first profile install restarts the prior Gateway with a fresh PID"
[[ ! -e "$FAILED_FIRST_PROFILE_HOME/plugins/hermes-codex-bridge" ]] || fail "failed first profile install leaves the prior plugin absent"
[[ ! -e "$FAILED_FIRST_PROFILE_HOME/hermes-codex-bridge-attestation.json" ]] || fail "failed first profile install leaves the prior attestation absent"
control_launchctl kickstart -k "user/$(id -u)/ai.hermes.gateway"

FAILED_CREATED_HOME="$MUTATE_ROOT/failed-created-hermes"
FAILED_CREATED_MUTATIONS_BEFORE="$(launchctl_mutation_count)"
set +e
FAILED_CREATED_OUTPUT="$(
  HCO_TEST_NODE_BIN="$FAKE_NODE" \
  invoke_installer "$FAILED_CREATED_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1
)"
FAILED_CREATED_STATUS=$?
set -e
[[ $FAILED_CREATED_STATUS -ne 0 ]] || fail "transaction-created Hermes home without a runtime baseline is rejected"
assert_contains "$FAILED_CREATED_OUTPUT" "Gateway runtime state cannot be read safely" "missing runtime baseline remains explicit"
[[ ! -e "$FAILED_CREATED_HOME" ]] || fail "runtime-baseline refusal removes its transaction-created Hermes home"
[[ "$(launchctl_mutation_count)" == "$FAILED_CREATED_MUTATIONS_BEFORE" ]] || fail "runtime-baseline refusal precedes Gateway mutation"
pass "first profile failure restores plugin-absent Gateway state and pre-activation roots"

FAILED_NEW_ROOT="$MUTATE_ROOT/failed-new-runtime"
set +e
FAILED_NEW_ROOT_OUTPUT="$(
  HCO_TEST_NODE_BIN="$FAKE_NODE" \
  HCO_TEST_INSTALL_ROOT="$FAILED_NEW_ROOT" \
  invoke_installer "$HERMES_HOME" "$BAD_CODEX_CONFIG" "$BAD_CODEX" 2>&1
)"
FAILED_NEW_ROOT_STATUS=$?
set -e
[[ $FAILED_NEW_ROOT_STATUS -ne 0 ]] || fail "failed first install reaches compatibility failure"
assert_contains "$FAILED_NEW_ROOT_OUTPUT" "installed Codex App Server compatibility: failed" "failed first install preserves the original failure"
[[ ! -e "$FAILED_NEW_ROOT" ]] || fail "failed first install removes its transaction-created install root"
pass "failed first install removes transaction-created parent directories"

rm -f "$SOCKET_PATH"
HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
HCO_TEST_FAKE_NODE="$FAKE_NODE" \
  "$FAKE_LAUNCHCTL" bootout "gui/$(id -u)/com.hermes.codex-bridge-hco"
HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
HCO_TEST_FAKE_NODE="$FAKE_NODE" \
  "$FAKE_LAUNCHCTL" bootout "gui/$(id -u)/com.hermes.codex-bridge-delivery"
rm -f "$HCO_LIFECYCLE_LOG"
set +e
FIRST_HANDOFF_OUTPUT="$(
  HERMES_HOME="$HERMES_HOME" \
  HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
  HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
  HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
  HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
  HCO_TEST_FAKE_NODE="$FAKE_NODE" \
  HCO_TEST_TURN_START_MARKER="$TURN_START_MARKER" \
  PYTHONDONTWRITEBYTECODE=1 \
  /bin/bash "$INSTALLER" \
    --hco-config "$MUTATE_HCO_CONFIG" \
    --zulip-config "$MUTATE_ZULIP_CONFIG" \
    --install-root "$INSTALL_ROOT" \
    --launch-agents-dir "$LAUNCH_AGENTS" \
    --node-bin "$FAKE_NODE" \
    --codex-bin "$FAKE_CODEX" \
    --launchctl-bin "$FAKE_LAUNCHCTL" 2>&1
)"
FIRST_HANDOFF_STATUS=$?
set -e
[[ $FIRST_HANDOFF_STATUS -eq 0 ]] || fail "first install uses a temporary HCO compatibility handoff: $FIRST_HANDOFF_OUTPUT"
[[ "$(rg -c '^started$' "$HCO_LIFECYCLE_LOG")" == "2" ]] || fail "temporary and launchd-owned HCO instances both started"
[[ "$(rg -c '^stopped$' "$HCO_LIFECYCLE_LOG")" == "1" ]] || fail "temporary HCO was stopped before launchd handoff"
[[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")" == "running" ]] || fail "intended HCO LaunchAgent is running after handoff"
[[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery")" == "running" ]] || fail "delivery starts only after intended HCO readiness"
[[ -S "$SOCKET_PATH" ]] || fail "intended HCO socket is ready after handoff"
pass "first install gates a temporary HCO and waits for the intended service before delivery"

printf '1..28\n'
