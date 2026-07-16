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
hco_path = root / "deploy/com.hermes.codex-bridge-hco.plist.example"
delivery_path = root / "deploy/com.hermes.codex-bridge-delivery.plist.example"
config_path = root / "config/hco.json.example"

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
mkdir -p "$HERMES_HOME/plugins/unrelated-fixture" "$HERMES_HOME/profiles/codex-bridge" "$HERMES_HOME/profiles/hermes-general"
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
  'platform_toolsets:' \
  '  zulip: [hco_bridge, no_mcp]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' \
  'context:' \
  '  engine: lcm' > "$HERMES_HOME/config.yaml"
printf '%s\n' \
  'platform_toolsets:' \
  '  zulip: [hco_bridge, no_mcp]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' \
  'context:' \
  '  engine: lcm' > "$HERMES_HOME/profiles/codex-bridge/config.yaml"
printf '%s\n' \
  'platform_toolsets:' \
  '  zulip: [hermes-zulip, hco_bridge, no_mcp]' \
  'known_plugin_toolsets:' \
  '  zulip: [hco_bridge, operator-known]' > "$HERMES_HOME/profiles/hermes-general/config.yaml"
printf '%s' "$MUTATE_SECRET" > "$BEARER_PATH"
printf '%064d' 0 > "$CONTEXT_KEY_PATH"
printf '%s\n' "UNRELATED_SETTING=preserved" > "$HERMES_HOME/.env"
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
chmod 600 "$BEARER_PATH" "$CONTEXT_KEY_PATH" "$MUTATE_HCO_CONFIG" "$MUTATE_ZULIP_CONFIG" "$HERMES_HOME/.env"

"$PYTHON" - "$SOCKET_PATH" <<'PY' &
import json
import os
import socket
import sys

socket_path = sys.argv[1]
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
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
  '  if [[ -f "$pid_path" ]]; then kill "$(< "$pid_path")" 2>/dev/null || true; rm -f "$pid_path"; fi' \
  '}' \
  'printf "%s\n" "$*" >> "$HCO_TEST_LAUNCHCTL_LOG"' \
  'command_name="${1:-}"' \
  'target="${2:-}"' \
  'label="${target##*/}"' \
  'case "$command_name" in' \
  '  print) [[ -f "$HCO_TEST_LAUNCHCTL_STATE/$label" ]] && printf "state = %s\n" "$(< "$HCO_TEST_LAUNCHCTL_STATE/$label")" ;;' \
  '  bootstrap) plist="${3:?}"; label="$(basename "$plist" .plist)"; mkdir -p "$HCO_TEST_LAUNCHCTL_STATE"; [[ "$label" != "com.hermes.codex-bridge-hco" ]] || start_hco; printf running > "$HCO_TEST_LAUNCHCTL_STATE/$label" ;;' \
  '  bootout) label="${target##*/}"; [[ "$label" != "com.hermes.codex-bridge-hco" ]] || stop_hco; rm -f "$HCO_TEST_LAUNCHCTL_STATE/$label" ;;' \
  '  kickstart) label="${target##*/}"; [[ "$label" != "com.hermes.codex-bridge-hco" ]] || start_hco; printf running > "$HCO_TEST_LAUNCHCTL_STATE/$label" ;;' \
  '  kill) target="${3:?}"; label="${target##*/}"; [[ "$label" != "com.hermes.codex-bridge-hco" ]] || stop_hco; printf stopped > "$HCO_TEST_LAUNCHCTL_STATE/$label" ;;' \
  '  *) exit 92 ;;' \
  'esac' > "$FAKE_LAUNCHCTL"
chmod 700 "$FAKE_LAUNCHCTL"
mkdir -p "$LAUNCHCTL_STATE"
printf running > "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco"

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

PLUGIN_LINK="$HERMES_HOME/plugins/hermes-codex-bridge"
[[ -L "$PLUGIN_LINK" ]] || fail "stable plugin path is a symlink"
PLUGIN_TARGET="$(readlink "$PLUGIN_LINK")"
[[ "$PLUGIN_TARGET" == *"hermes-codex-bridge-1.0.0-"* ]] || fail "plugin uses immutable version directory"
[[ -f "$PLUGIN_LINK/plugin.py" && -f "$PLUGIN_LINK/delivery_sidecar.py" && -f "$PLUGIN_LINK/plugin.yaml" ]] || fail "plugin release is complete"
assert_contains "$(< "$HERMES_HOME/.env")" "UNRELATED_SETTING=preserved" "root dotenv preserves unrelated values"
assert_contains "$(< "$HERMES_HOME/.env")" "HCO_CONFIG_PATH=$MUTATE_HCO_CONFIG" "root dotenv injects HCO config path"
[[ ! -e "$HERMES_HOME/ai.hermes.gateway.plist" ]] || fail "generated Hermes gateway plist is untouched"

PYTHONDONTWRITEBYTECODE=1 "$PYTHON" - "$HERMES_HOME" "$LAUNCH_AGENTS" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" <<'PY'
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
import hermes_cli.plugins as plugin_module

launch_agents = Path(sys.argv[2])
hco_config_text = sys.argv[3]
hco_config_path = Path(hco_config_text)
configured_codex = sys.argv[4]
assert hco_config_path.stat().st_mode & 0o777 == 0o600
assert json.loads(hco_config_path.read_text())["codexExecutablePath"] == configured_codex
root = yaml.safe_load((home / "config.yaml").read_text())
bridge = yaml.safe_load((home / "profiles/codex-bridge/config.yaml").read_text())
general = yaml.safe_load((home / "profiles/hermes-general/config.yaml").read_text())
assert "hermes-codex-bridge" in root["plugins"]["enabled"]
assert "unrelated-fixture" in root["plugins"]["enabled"]
assert root["gateway"]["multiplex_profiles"] is True
assert root["platform_toolsets"]["zulip"] == []
assert bridge["platform_toolsets"]["zulip"] == []
assert "hco_bridge" not in root.get("known_plugin_toolsets", {}).get("zulip", [])
assert "hco_bridge" not in bridge.get("known_plugin_toolsets", {}).get("zulip", [])
assert "unrelated_fixture" in root["known_plugin_toolsets"]["zulip"]
assert "unrelated_fixture" in bridge["known_plugin_toolsets"]["zulip"]
assert "hco_bridge" not in general["platform_toolsets"]["zulip"]
assert "hco_bridge" not in general.get("known_plugin_toolsets", {}).get("zulip", [])
assert "operator-known" in general["known_plugin_toolsets"]["zulip"]
assert general["platform_toolsets"]["zulip"]

load_hermes_dotenv(hermes_home=home)
manager = plugin_module.PluginManager()
plugin_module._plugin_manager = manager
manager.discover_and_load()
assert "unrelated_fixture_tool" in manager._plugin_tool_names
assert set(manager._plugin_commands) == {
    "codex",
    "hermes-codex-bridge-internal",
    "hermes-codex-bridge-natural",
}
callbacks = manager._hooks.get("pre_gateway_dispatch", [])
assert callbacks and callbacks[0].__module__.startswith(
    "hermes_plugins.hermes_codex_bridge"
)
natural_handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
plugin_llm = inspect.getclosurevars(natural_handler).nonlocals["llm"]
assert callable(plugin_llm.acomplete_structured)
assert manager._plugins["hermes-codex-bridge"].tools_registered == []

os.environ["HERMES_HOME"] = str(home)
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
  HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  HCO_TEST_HCO_CONFIG="$MUTATE_HCO_CONFIG" \
  HCO_TEST_HCO_SOCKET="$SOCKET_PATH" \
  HCO_TEST_HCO_LIFECYCLE_LOG="$HCO_LIFECYCLE_LOG" \
  HCO_TEST_FAKE_HCO_SERVER="$FAKE_HCO_SERVER" \
  HCO_TEST_FAKE_NODE="$FAKE_NODE" \
    "$FAKE_LAUNCHCTL" "$@"
}

launchctl_mutation_count() {
  rg -c '^(bootstrap|bootout|kickstart|kill) ' "$LAUNCHCTL_LOG" || true
}

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
[[ "$(rg -c '^ZULIP_CONTEXT_DEPTH=' "$HERMES_HOME/.env")" == "1" ]] || fail "authorized correction removes duplicate depth settings"
assert_contains "$(< "$HERMES_HOME/.env")" "ZULIP_CONTEXT_DEPTH=0" "authorized correction writes zero"
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
[[ "$(rg -c '^ZULIP_CONTEXT_DEPTH=' "$PROJECT_FALLBACK_HOME/.env")" == "1" ]] || fail "project-fallback correction writes exactly one depth setting"
[[ "$(rg -c '^ZULIP_CONTEXT_DEPTH=0$' "$PROJECT_FALLBACK_HOME/.env")" == "1" ]] || fail "project-fallback correction writes exactly one zero depth"
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

kill "$HCO_SERVER_PID"
wait "$HCO_SERVER_PID" 2>/dev/null || true
HCO_SERVER_PID=''
rm -f "$SOCKET_PATH"
HCO_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
HCO_TEST_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  "$FAKE_LAUNCHCTL" bootout "gui/$(id -u)/com.hermes.codex-bridge-delivery"
control_launchctl kickstart "gui/$(id -u)/com.hermes.codex-bridge-hco"
[[ -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco" ]] || fail "HCO remains independently loaded"
[[ "$(< "$LAUNCHCTL_STATE/com.hermes.codex-bridge-hco")" == "running" ]] || fail "HCO is running before rollback drill"
[[ ! -f "$LAUNCHCTL_STATE/com.hermes.codex-bridge-delivery" ]] || fail "delivery is independently unloaded"
ROLLBACK_ENV_BEFORE="$(< "$HERMES_HOME/.env")"
ROLLBACK_CONFIG_BEFORE="$(< "$HERMES_HOME/config.yaml")"
ROLLBACK_BRIDGE_CONFIG_BEFORE="$(< "$HERMES_HOME/profiles/codex-bridge/config.yaml")"
ROLLBACK_GENERAL_CONFIG_BEFORE="$(< "$HERMES_HOME/profiles/hermes-general/config.yaml")"
ROLLBACK_LINK_BEFORE="$(readlink "$PLUGIN_LINK")"
set +e
ROLLBACK_OUTPUT="$(HCO_TEST_NODE_BIN="$FAKE_NODE" HCO_INSTALLER_TEST_FAILPOINT=after_hco_bootstrap invoke_installer "$HERMES_HOME" "$MUTATE_HCO_CONFIG" "$FAKE_CODEX" 2>&1)"
ROLLBACK_STATUS=$?
set -e
[[ $ROLLBACK_STATUS -ne 0 ]] || fail "injected post-HCO failure aborts installation"
assert_contains "$ROLLBACK_OUTPUT" "injected failure" "rollback test reaches injected failure"
[[ "$(< "$HERMES_HOME/.env")" == "$ROLLBACK_ENV_BEFORE" ]] || fail "rollback restores root dotenv exactly"
[[ "$(< "$HERMES_HOME/config.yaml")" == "$ROLLBACK_CONFIG_BEFORE" ]] || fail "rollback restores root config exactly"
[[ "$(< "$HERMES_HOME/profiles/codex-bridge/config.yaml")" == "$ROLLBACK_BRIDGE_CONFIG_BEFORE" ]] || fail "rollback restores codex-bridge config exactly"
[[ "$(< "$HERMES_HOME/profiles/hermes-general/config.yaml")" == "$ROLLBACK_GENERAL_CONFIG_BEFORE" ]] || fail "rollback restores hermes-general config exactly"
[[ "$(readlink "$PLUGIN_LINK")" == "$ROLLBACK_LINK_BEFORE" ]] || fail "rollback restores stable symlink target"
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

STAGING_FAILURE_HOME="$MUTATE_ROOT/staging-failure-hermes"
mkdir -p "$STAGING_FAILURE_HOME/plugins"
chmod 700 "$STAGING_FAILURE_HOME" "$STAGING_FAILURE_HOME/plugins"
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

printf '1..22\n'
