#!/bin/bash
set -euo pipefail

HERMES_PYTHON="/Users/hula/Projects/hermesAgent/.venv/bin/python3"
SCRIPT_PATH="${BASH_SOURCE[0]}"
REPOSITORY_ROOT="${SCRIPT_PATH%/*}/.."

usage() {
  printf '%s\n' \
    'Usage: install-hermes-codex-bridge.sh [--dry-run] --hco-config PATH --zulip-config PATH [options]' \
    '' \
    'Options:' \
    '  --install-root PATH         Runtime state root.' \
    '  --launch-agents-dir PATH    Per-user LaunchAgents directory.' \
    '  --node-bin PATH             Absolute Node executable path.' \
    '  --codex-bin PATH            Absolute Codex executable path.' \
    '  --launchctl-bin PATH        Absolute launchctl executable path.' \
    '  --authorize-context-depth-zero' \
    '                              Permit replacing a nonzero/invalid effective depth.' \
    '  --dry-run                   Print a redacted, process-free plan.'
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    printf 'installer argument error: %s requires a value\n' "$1" >&2
    exit 2
  fi
}

dry_run=false
authorize_context_depth_zero=false
hco_config=''
zulip_config=''
install_root="${HOME}/Library/Application Support/HermesCodexBridge"
launch_agents_dir="${HOME}/Library/LaunchAgents"
node_bin=''
codex_bin=''
launchctl_bin='/bin/launchctl'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --authorize-context-depth-zero)
      authorize_context_depth_zero=true
      shift
      ;;
    --hco-config|--zulip-config|--install-root|--launch-agents-dir|--node-bin|--codex-bin|--launchctl-bin)
      require_value "$@"
      option="$1"
      value="$2"
      case "$option" in
        --hco-config) hco_config="$value" ;;
        --zulip-config) zulip_config="$value" ;;
        --install-root) install_root="$value" ;;
        --launch-agents-dir) launch_agents_dir="$value" ;;
        --node-bin) node_bin="$value" ;;
        --codex-bin) codex_bin="$value" ;;
        --launchctl-bin) launchctl_bin="$value" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'installer argument error: unknown option %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

for required_pair in \
  "--hco-config:$hco_config" \
  "--zulip-config:$zulip_config" \
  "--install-root:$install_root" \
  "--launch-agents-dir:$launch_agents_dir" \
  "--node-bin:$node_bin" \
  "--codex-bin:$codex_bin" \
  "--launchctl-bin:$launchctl_bin"; do
  option_name="${required_pair%%:*}"
  option_value="${required_pair#*:}"
  if [[ -z "$option_value" ]]; then
    printf 'installer argument error: %s is required\n' "$option_name" >&2
    exit 2
  fi
  if [[ "$option_value" != /* ]]; then
    printf 'installer argument error: %s must be an absolute path\n' "$option_name" >&2
    exit 2
  fi
done

if $dry_run; then
  if [[ -z "${HOME:-}" || "$HOME" != /* || ! -d "$HOME" || -L "$HOME" || ! -O "$HOME" ]]; then
    printf 'installer dry-run error: HOME must be an absolute invoking-user directory\n' >&2
    exit 1
  fi
  lock_path="$HOME/.hermes-codex-bridge-installer.lock"
  if [[ -L "$lock_path" ]]; then
    printf 'installer dry-run error: lock path is a symlink: %s\n' "$lock_path" >&2
    exit 1
  elif [[ -e "$lock_path" ]]; then
    if [[ ! -f "$lock_path" || ! -O "$lock_path" || ! -r "$lock_path" ]]; then
      printf 'installer dry-run error: existing lock is not a readable owner file: %s\n' "$lock_path" >&2
      exit 1
    fi
    lock_report="lock inspection: existing owner lock file found at $lock_path; active-lock probe deferred to real install"
  else
    lock_report="lock inspection: no existing lock at $lock_path"
  fi
  printf '%s\n' \
    'Hermes Codex Bridge installer - DRY RUN' \
    "repository: $REPOSITORY_ROOT" \
    "install root: $install_root" \
    "LaunchAgents: $launch_agents_dir" \
    "HCO config path: $hco_config (contents not read)" \
    "Zulip config path: $zulip_config (contents not read)" \
    "$lock_report" \
    'would create a transaction manifest before deployment mutation' \
    'would stage and atomically activate the versioned plugin release' \
    'would install two independent LaunchAgents after all gates pass' \
    'deferred: installed Hermes compatibility' \
    'deferred: bridge protocol compatibility' \
    'deferred: installed Codex App Server canary'
  if $authorize_context_depth_zero; then
    printf '%s\n' 'context-depth correction: authorized if required'
  else
    printf '%s\n' 'context-depth correction: not authorized'
  fi
  exit 0
fi

export PYTHONDONTWRITEBYTECODE=1
exec "$HERMES_PYTHON" - \
  "$REPOSITORY_ROOT" \
  "$hco_config" \
  "$zulip_config" \
  "$install_root" \
  "$launch_agents_dir" \
  "$node_bin" \
  "$codex_bin" \
  "$launchctl_bin" \
  "$authorize_context_depth_zero" <<'PY'
from __future__ import annotations

import atexit
import configparser
import copy
import fcntl
import hashlib
import io
import json
import os
import plistlib
import pwd
import queue
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from dotenv.parser import parse_stream


PLUGIN_NAME = "hermes-codex-bridge"
PLUGIN_VERSION = "1.0.0"
HCO_LABEL = "com.hermes.codex-bridge-hco"
DELIVERY_LABEL = "com.hermes.codex-bridge-delivery"
GATEWAY_LABEL = "ai.hermes.gateway"
ATTESTATION_FILE = "hermes-codex-bridge-attestation.json"
GATEWAY_STATE_FILE = "gateway_state.json"
MAX_CONFIG_BYTES = 262_144
MAX_SECRET_BYTES = 4_096
RESTRICTED_TOOLSETS: list[str] = ["zulip-history"]
HERMES_CHECKOUT = Path("/Users/hula/Projects/hermesAgent")
HERMES_PROJECT_ENV = Path("/Users/hula/Projects/hermesAgent/.env")
GENERAL_TOOLSETS = ["hermes-zulip"]
RESTRICTED_DISABLED_TOOLSETS = ["context_engine", "kanban", "zulip-history"]
OWNED_PROFILE_NAMES = frozenset({"zulip-ingress", "codex-bridge", "hermes-general"})
INGRESS_REMINDER = b"""# Zulip Ingress\n\nThis profile is project-neutral. It only receives Zulip events and lets the Codex routing hook choose an explicit project profile. A numeric Zulip stream ID plus a fresh, integrity-checked HCO route snapshot are the only project-routing authority. A channel name, topic, message text, cwd, memory, or model inference must never choose or change a project. Never infer a project, workspace, memory, credential, or task context from the default Hermes profile.\n"""


class InstallError(RuntimeError):
    pass


class CompatibilityError(InstallError):
    pass


@dataclass
class Snapshot:
    path: Path
    kind: str
    data: bytes | None
    target: str | None
    mode: int | None
    uid: int | None
    gid: int | None


@dataclass(frozen=True)
class ServiceState:
    domain: str
    loaded: bool
    running: bool
    pid: int | None


@dataclass(frozen=True)
class ExternalProfile:
    name: str
    home: Path
    config_path: Path
    env_path: Path


(
    repository_text,
    hco_config_text,
    zulip_config_text,
    install_root_text,
    launch_agents_text,
    node_text,
    codex_text,
    launchctl_text,
    authorize_text,
) = sys.argv[1:]

repository = Path(repository_text).resolve()
hco_config_path = Path(hco_config_text)
zulip_config_path = Path(zulip_config_text)
install_root = Path(install_root_text)
launch_agents_dir = Path(launch_agents_text)
node_bin = Path(node_text)
codex_bin = Path(codex_text)
launchctl_bin = Path(launchctl_text)
authorize_context_depth_zero = authorize_text == "true"
python_bin = Path(sys.executable)
uid = os.getuid()
bridge_launch_domain = f"gui/{uid}"
gateway_launch_domains = (f"user/{uid}", f"gui/{uid}")


def diagnostic(message: str) -> None:
    print(message, flush=True)


def fail(layer: str, error: BaseException) -> None:
    detail = str(error).replace("\n", " ").strip()
    if len(detail) > 300:
        detail = detail[:300] + "..."
    raise CompatibilityError(
        f"{layer}: failed" + (f" ({detail})" if detail else "")
    ) from error


def validate_executable(path: Path, label: str) -> None:
    try:
        info = path.stat()
    except OSError as error:
        raise InstallError(f"{label} is unavailable") from error
    if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or not os.access(path, os.X_OK):
        raise InstallError(f"{label} must be an absolute executable file")


def read_owner_file(path: Path, maximum: int, label: str) -> bytes:
    if not path.is_absolute():
        raise InstallError(f"{label} must be an absolute path")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != uid
            or info.st_mode & 0o077
            or info.st_size < 1
            or info.st_size > maximum
        ):
            raise InstallError(f"{label} must be a nonempty owner-only regular file")
        data = os.read(descriptor, maximum + 1)
        if not data or len(data) > maximum:
            raise InstallError(f"{label} has an invalid size")
        return data
    except OSError as error:
        raise InstallError(f"{label} cannot be read safely") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def parse_hco_config() -> tuple[dict[str, Any], bytes]:
    raw = read_owner_file(hco_config_path, MAX_CONFIG_BYTES, "HCO config")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InstallError("HCO config is not valid JSON") from error
    if type(document) is not dict or document.get("version") != 1:
        raise InstallError("HCO config version must be 1")
    configured_codex = document.get("codexExecutablePath")
    if type(configured_codex) is not str or not os.path.isabs(configured_codex):
        raise InstallError("HCO codexExecutablePath must be absolute")
    if Path(configured_codex) != codex_bin:
        raise InstallError("HCO codexExecutablePath does not match --codex-bin")
    bridge = document.get("bridge")
    if type(bridge) is not dict or set(bridge) != {
        "tokenPath", "contextKeyPath", "socketPath", "routeSnapshotPath"
    }:
        raise InstallError("HCO bridge config has an invalid shape")
    for name in ("databasePath",):
        if type(document.get(name)) is not str or not os.path.isabs(document[name]):
            raise InstallError(f"HCO {name} must be absolute")
    for name in ("tokenPath", "contextKeyPath", "socketPath", "routeSnapshotPath"):
        if type(bridge.get(name)) is not str or not os.path.isabs(bridge[name]):
            raise InstallError(f"HCO bridge.{name} must be absolute")
    bearer = read_owner_file(Path(bridge["tokenPath"]), MAX_SECRET_BYTES, "HCO bearer")
    context_key = read_owner_file(
        Path(bridge["contextKeyPath"]), MAX_SECRET_BYTES, "HCO context key"
    )
    if len(context_key) < 32:
        raise InstallError("HCO context key must contain at least 32 bytes")
    return document, bearer


def zulip_config_credentials() -> dict[str, str]:
    raw = read_owner_file(zulip_config_path, MAX_CONFIG_BYTES, "Zulip config")
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read_string(raw.decode("utf-8"))
    except (UnicodeDecodeError, configparser.Error) as error:
        raise InstallError("Zulip config is invalid") from error
    if not parser.has_section("api"):
        raise InstallError("Zulip config requires an [api] section")
    for key in ("email", "key", "site"):
        if not parser.get("api", key, fallback="").strip():
            raise InstallError(f"Zulip config requires api.{key}")
    return {
        "ZULIP_BOT_EMAIL": parser.get("api", "email").strip(),
        "ZULIP_API_KEY": parser.get("api", "key").strip(),
        "ZULIP_SITE_URL": parser.get("api", "site").strip(),
    }


def check_bridge_compatibility(document: dict[str, Any], bearer: bytes) -> None:
    source = repository / "plugin" / PLUGIN_NAME
    old_path = list(sys.path)
    sys.path.insert(0, str(source))
    try:
        from delivery_sidecar import HcoClient

        client = HcoClient(
            document["bridge"]["socketPath"], bearer, "installer-canary", 1, 1000
        )
        client.check_compatibility()
    finally:
        sys.path[:] = old_path
        sys.modules.pop("delivery_sidecar", None)
        sys.modules.pop("zulip_sender", None)


def bridge_gate(document: dict[str, Any], bearer: bytes) -> None:
    try:
        check_bridge_compatibility(document, bearer)
    except Exception as error:
        fail("bridge protocol compatibility", error)
    diagnostic("bridge protocol compatibility: passed")


def wait_bridge_gate(
    document: dict[str, Any],
    bearer: bytes,
    *,
    timeout: float = 8.0,
    process: subprocess.Popen[Any] | None = None,
) -> None:
    deadline = time.monotonic() + timeout
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise CompatibilityError("bridge protocol compatibility: failed (temporary HCO exited before readiness)")
        try:
            check_bridge_compatibility(document, bearer)
            diagnostic("bridge protocol compatibility: passed")
            return
        except BaseException as error:
            last_error = error
        time.sleep(0.1)
    fail("bridge protocol compatibility", last_error or TimeoutError("HCO readiness timed out"))


def app_server_gate(document: dict[str, Any]) -> None:
    process: subprocess.Popen[str] | None = None
    reader: threading.Thread | None = None
    messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()

    def collect(stream) -> None:
        try:
            for line in stream:
                value = json.loads(line)
                if type(value) is not dict:
                    raise ValueError("non-object App Server message")
                messages.put(value)
        except BaseException as error:
            messages.put(error)

    def send(message: dict[str, Any]) -> None:
        assert process is not None and process.stdin is not None
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def receive_until(predicate, timeout: float = 8.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("App Server canary timed out")
            item = messages.get(timeout=remaining)
            if isinstance(item, BaseException):
                raise item
            if item.get("method") and "id" in item:
                send({"id": item["id"], "result": {"answers": {}}})
            if predicate(item):
                return item

    try:
        process = subprocess.Popen(
            [document["codexExecutablePath"], "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        assert process.stdout is not None
        reader = threading.Thread(target=collect, args=(process.stdout,), daemon=True)
        reader.start()
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "hco-installer", "version": "1.0.0"}, "capabilities": {"experimentalApi": False}}})
        initialized = receive_until(lambda item: item.get("id") == 1)
        if type(initialized.get("result")) is not dict:
            raise ValueError("initialize response is missing result")
        send({"method": "initialized", "params": {}})
        send({"id": 2, "method": "thread/start", "params": {"ephemeral": True, "experimentalRawEvents": False}})
        started = None
        saw_thread_started = False
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and (started is None or not saw_thread_started):
            item = receive_until(lambda _item: True, deadline - time.monotonic())
            if item.get("id") == 2:
                started = item
            if item.get("method") == "thread/started":
                saw_thread_started = True
        if started is None or not saw_thread_started:
            raise ValueError("thread/start response or notification is missing")
        thread_id = started.get("result", {}).get("thread", {}).get("id")
        if type(thread_id) is not str or not thread_id:
            raise ValueError("thread/start response is invalid")
        send({"id": 3, "method": "thread/read", "params": {"threadId": thread_id}})
        read = receive_until(lambda item: item.get("id") == 3)
        if type(read.get("result", {}).get("thread")) is not dict:
            raise ValueError("thread/read response is invalid")
        # Missing input must be rejected during request validation, before a
        # model turn exists. Any error except method-not-found proves that the
        # installed server recognizes the required turn/start surface.
        send({"id": 4, "method": "turn/start", "params": {"threadId": thread_id}})
        turn_probe = receive_until(lambda item: item.get("id") == 4)
        error = turn_probe.get("error")
        if type(error) is not dict or error.get("code") == -32601:
            raise ValueError("turn/start is unavailable or accepted an invalid canary")
    except Exception as error:
        fail("installed Codex App Server compatibility", error)
    finally:
        if process is not None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except OSError:
                pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        if reader is not None:
            reader.join(timeout=1)
    diagnostic("installed Codex App Server compatibility: passed")


def resolve_hermes_paths() -> tuple[Path, Path, Path, Path]:
    old_path = list(sys.path)
    hermes_checkout = Path("/Users/hula/Projects/hermesAgent")
    sys.path.insert(0, str(hermes_checkout))
    try:
        from hermes_constants import get_default_hermes_root, get_hermes_home
        from hermes_cli.profiles import get_profile_dir

        root = get_default_hermes_root()
        if root != get_hermes_home():
            raise ValueError("installer must run against the default Hermes profile")
        ingress_home = get_profile_dir("zulip-ingress")
        bridge_home = get_profile_dir("codex-bridge")
        general_home = get_profile_dir("hermes-general")
        if len(
            {
                root.resolve(),
                ingress_home.resolve(),
                bridge_home.resolve(),
                general_home.resolve(),
            }
        ) != 4:
            raise ValueError("Hermes profile homes are not distinct")
        return root, ingress_home, bridge_home, general_home
    except Exception as error:
        fail("installed Hermes compatibility", error)
    finally:
        sys.path[:] = old_path


def installed_hermes_preflight(root: Path) -> None:
    old_env = os.environ.copy()
    old_path = list(sys.path)
    hermes_checkout = Path("/Users/hula/Projects/hermesAgent")
    sys.path.insert(0, str(hermes_checkout))
    try:
        os.environ["HERMES_HOME"] = str(root)
        from hermes_cli.config import load_config
        from gateway.config import load_gateway_config, PlatformConfig
        from hermes_cli.tools_config import _get_platform_tools
        from hermes_cli.plugins import PluginManager
        from gateway.platforms.zulip import ZulipAdapter

        # Exercise the exact installed loaders only after the transaction
        # manifest exists, because upstream loader behavior may evolve.
        load_config()
        load_gateway_config()
        _get_platform_tools({"platform_toolsets": {"zulip": []}}, "zulip")
        PluginManager()
        ZulipAdapter(PlatformConfig())
    except Exception as error:
        fail("installed Hermes compatibility", error)
    finally:
        os.environ.clear()
        os.environ.update(old_env)
        sys.path[:] = old_path


def effective_env_value(path: Path, key: str) -> str | None:
    value = os.environ.get(key)
    if not path.exists():
        return value
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise InstallError("Hermes .env cannot be parsed safely") from error
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, candidate = stripped.split("=", 1)
        if name.strip() == key:
            value = candidate.strip().strip('"').strip("'")
    return value


EFFECTIVE_CONTEXT_DEPTH_PROGRAM = r'''
import json
import os
import sys
from pathlib import Path

checkout_text, hermes_home_text, project_env_text = sys.argv[1:]
sys.path.insert(0, checkout_text)

from hermes_cli.env_loader import load_hermes_dotenv

load_hermes_dotenv(
    hermes_home=Path(hermes_home_text),
    project_env=Path(project_env_text),
)
print(json.dumps(os.environ.get("ZULIP_CONTEXT_DEPTH")))
'''


def effective_context_depth(root_env: Path) -> str | None:
    workspace = Path(tempfile.mkdtemp(prefix="hco-effective-depth-"))
    try:
        hermes_home = workspace / "hermes-home"
        hermes_home.mkdir(mode=0o700)
        if root_env.exists():
            atomic_write(hermes_home / ".env", root_env.read_bytes())
        project_env = workspace / "project.env"
        if HERMES_PROJECT_ENV.exists():
            atomic_write(project_env, HERMES_PROJECT_ENV.read_bytes())

        environment = {
            "HOME": os.environ["HOME"],
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HERMES_HOME": str(hermes_home),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        for name in (
            "LANG",
            "LC_ALL",
            "HERMES_MANAGED_DIR",
            "ZULIP_CONTEXT_DEPTH",
        ):
            if name in os.environ:
                environment[name] = os.environ[name]
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                EFFECTIVE_CONTEXT_DEPTH_PROGRAM,
                str(HERMES_CHECKOUT),
                str(hermes_home),
                str(project_env),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            env=environment,
        )
        if result.returncode != 0:
            raise CompatibilityError("effective Hermes dotenv resolution failed")
        value = json.loads(result.stdout)
        if value is not None and type(value) is not str:
            raise CompatibilityError("effective Hermes context depth is invalid")
        return value
    except (OSError, UnicodeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        raise CompatibilityError("effective Hermes dotenv resolution failed") from error
    finally:
        remove_path(workspace)


def encode_dotenv_value(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./,:@%+-]*", value):
        return value
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def update_env(data: bytes | None, values: dict[str, str]) -> bytes:
    try:
        text = (data or b"").decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallError("Hermes .env cannot be parsed safely") from error
    managed = set(values)
    kept: list[str] = []
    for binding in parse_stream(io.StringIO(text)):
        if binding.error:
            raise InstallError("Hermes .env cannot be parsed safely")
        if binding.key not in managed:
            kept.append(binding.original.string)
    prefix = "".join(kept)
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    if prefix and not prefix.endswith("\n\n"):
        prefix += "\n"
    assignments = "".join(
        f"{name}={encode_dotenv_value(value)}\n"
        for name, value in values.items()
    )
    return (prefix + assignments).encode("utf-8")


def dotenv_values(data: bytes | None) -> dict[str, str]:
    try:
        text = (data or b"").decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallError("Hermes .env cannot be parsed safely") from error
    result: dict[str, str] = {}
    for binding in parse_stream(io.StringIO(text)):
        if binding.error:
            raise InstallError("Hermes .env cannot be parsed safely")
        if binding.key is not None and binding.value is not None:
            result[binding.key] = binding.value
    return result


def remove_env_prefix(data: bytes | None, prefix: str) -> bytes:
    try:
        text = (data or b"").decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallError("Hermes .env cannot be parsed safely") from error
    kept: list[str] = []
    for binding in parse_stream(io.StringIO(text)):
        if binding.error:
            raise InstallError("Hermes .env cannot be parsed safely")
        if binding.key is None or not binding.key.startswith(prefix):
            kept.append(binding.original.string)
    return "".join(kept).encode("utf-8")


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    if path.is_symlink() or not path.is_file():
        raise InstallError(f"refusing protected config path: {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as error:
        raise InstallError(f"invalid YAML config: {path}") from error
    if type(data) is not dict:
        raise InstallError(f"YAML config must contain a mapping: {path}")
    return data


INSTALLED_PLUGIN_TOOLSETS_PROGRAM = r'''
import json
import os
import sys

checkout_text, hermes_home_text = sys.argv[1:]
sys.path.insert(0, checkout_text)
os.environ["HERMES_HOME"] = hermes_home_text

import hermes_cli.plugins as plugin_module
from hermes_cli.tools_config import _get_plugin_toolset_keys

manager = plugin_module.PluginManager()
plugin_module._plugin_manager = manager
manager.discover_and_load()
print(json.dumps(sorted(_get_plugin_toolset_keys())))
'''


def installed_plugin_toolsets(root: Path) -> set[str]:
    environment = os.environ.copy()
    environment["HERMES_HOME"] = str(root)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment.pop("HERMES_SAFE_MODE", None)
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                INSTALLED_PLUGIN_TOOLSETS_PROGRAM,
                str(HERMES_CHECKOUT),
                str(root),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            env=environment,
        )
        if result.returncode != 0:
            raise CompatibilityError("installed plugin toolset discovery failed")
        values = json.loads(result.stdout)
        if not isinstance(values, list) or not all(
            isinstance(item, str) and item for item in values
        ):
            raise CompatibilityError("installed plugin toolset discovery was invalid")
        return set(values)
    except (OSError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        raise CompatibilityError("installed plugin toolset discovery failed") from error


def managed_known_plugin_toolsets(
    existing: dict[str, Any], installed_plugin_toolsets: set[str]
) -> list[str]:
    known = existing.setdefault("known_plugin_toolsets", {})
    if not isinstance(known, dict):
        raise InstallError("known_plugin_toolsets config must be a mapping")
    configured = known.get("zulip", [])
    if not isinstance(configured, list):
        raise InstallError("known_plugin_toolsets.zulip must be a list")
    return sorted(
        {
            str(item)
            for item in configured
            if str(item) != "hco_bridge"
        }
        | (installed_plugin_toolsets - {"hco_bridge"})
    )


def disable_mcp_servers(config: dict[str, Any]) -> None:
    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        return
    for server in servers.values():
        if isinstance(server, dict):
            server["enabled"] = False


def root_config(
    existing: dict[str, Any], installed_plugin_toolsets: set[str]
) -> dict[str, Any]:
    result = copy.deepcopy(existing)
    plugins = result.setdefault("plugins", {})
    if type(plugins) is not dict:
        raise InstallError("root plugins config must be a mapping")
    enabled = plugins.setdefault("enabled", [])
    if type(enabled) is not list:
        raise InstallError("root plugins.enabled must be a list")
    if PLUGIN_NAME not in enabled:
        enabled.append(PLUGIN_NAME)
    gateway = result.setdefault("gateway", {})
    if type(gateway) is not dict:
        raise InstallError("root gateway config must be a mapping")
    gateway["multiplex_profiles"] = True
    # The installed gateway loader currently resolves the top-level form while
    # the operator-facing config contract also records the nested gateway form.
    result["multiplex_profiles"] = True
    platforms = result.setdefault("platforms", {})
    if type(platforms) is not dict:
        raise InstallError("root platforms config must be a mapping")
    zulip = platforms.setdefault("zulip", {})
    if type(zulip) is not dict:
        raise InstallError("root platforms.zulip config must be a mapping")
    zulip["enabled"] = False
    return result


def merge_mapping(
    existing: dict[str, Any], override: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(existing)
    for key, value in override.items():
        current = result.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            result[key] = merge_mapping(current, value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def zulip_adapter_config(config: dict[str, Any], source: str) -> dict[str, Any]:
    platforms = config.get("platforms", {})
    if not isinstance(platforms, dict):
        raise InstallError(f"{source} platforms config must be a mapping")
    zulip = platforms.get("zulip", {})
    if not isinstance(zulip, dict):
        raise InstallError(f"{source} platforms.zulip config must be a mapping")
    return zulip


def discover_external_profiles(profiles_dir: Path) -> list[ExternalProfile]:
    if not profiles_dir.exists():
        return []
    result: list[ExternalProfile] = []
    for home in sorted(profiles_dir.iterdir(), key=lambda path: path.name):
        if home.name in OWNED_PROFILE_NAMES:
            continue
        info = home.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise InstallError(f"external profile directory must not be a symlink: {home.name}")
        if not stat.S_ISDIR(info.st_mode):
            continue
        if info.st_uid != uid:
            raise InstallError(f"external profile directory must be owned by the invoking user: {home.name}")
        config_path = home / "config.yaml"
        if not config_path.exists():
            continue
        validate_mutable_path(
            config_path,
            f"external profile config ({home.name})",
            directory=False,
        )
        env_path = home / ".env"
        validate_mutable_path(
            env_path,
            f"external profile dotenv ({home.name})",
            directory=False,
        )
        result.append(ExternalProfile(home.name, home, config_path, env_path))
    return result


def configured_profile_zulip_key(
    zulip: dict[str, Any], env_data: bytes | None, profile_name: str
) -> str | None:
    for field in ("token", "api_key"):
        value = zulip.get(field)
        if value is None or value == "":
            continue
        if type(value) is not str:
            raise InstallError(
                f"external profile platforms.zulip.{field} must be a string: {profile_name}"
            )
        return value
    return dotenv_values(env_data).get("ZULIP_API_KEY")


def external_profile_layout(
    profiles: list[ExternalProfile], ingress_api_key: str
) -> tuple[dict[str, tuple[bytes, bytes | None]], dict[Path, bytes]]:
    staged: dict[str, tuple[bytes, bytes | None]] = {}
    updates: dict[Path, bytes] = {}
    for profile in profiles:
        original_config = profile.config_path.read_bytes()
        env_data = profile.env_path.read_bytes() if profile.env_path.exists() else None
        config = load_yaml(profile.config_path)
        zulip = zulip_adapter_config(config, f"external profile ({profile.name})")
        config_data = original_config
        if (
            zulip.get("enabled") is True
            and ingress_api_key
            and configured_profile_zulip_key(zulip, env_data, profile.name)
            == ingress_api_key
        ):
            updated = copy.deepcopy(config)
            updated["platforms"]["zulip"]["enabled"] = False
            config_data = yaml.safe_dump(updated, sort_keys=False).encode()
            updates[profile.config_path] = config_data
        staged[profile.name] = (config_data, env_data)
    return staged, updates


def ingress_config(
    root: dict[str, Any],
    existing: dict[str, Any],
    installed_plugin_toolsets: set[str],
) -> dict[str, Any]:
    zulip = merge_mapping(
        zulip_adapter_config(root, "root"),
        zulip_adapter_config(existing, "zulip-ingress"),
    )
    zulip["enabled"] = True
    extra = zulip.setdefault("extra", {})
    if not isinstance(extra, dict):
        raise InstallError("zulip-ingress platforms.zulip.extra config must be a mapping")
    extra["context_depth"] = 0
    result: dict[str, Any] = {
        "platforms": {"zulip": zulip},
        "platform_toolsets": {"zulip": list(RESTRICTED_TOOLSETS)},
        "known_plugin_toolsets": {"zulip": []},
        "agent": {"disabled_toolsets": list(RESTRICTED_DISABLED_TOOLSETS)},
        "mcp_servers": {},
    }
    result["known_plugin_toolsets"]["zulip"] = managed_known_plugin_toolsets(
        result, installed_plugin_toolsets
    )
    return result


def restricted_config(
    existing: dict[str, Any], installed_plugin_toolsets: set[str]
) -> dict[str, Any]:
    result = copy.deepcopy(existing)
    result.setdefault("platforms", {}).setdefault("zulip", {})["enabled"] = False
    result.setdefault("platform_toolsets", {})["zulip"] = list(RESTRICTED_TOOLSETS)
    result.setdefault("known_plugin_toolsets", {})["zulip"] = managed_known_plugin_toolsets(
        result, installed_plugin_toolsets
    )
    disabled = result.setdefault("agent", {}).setdefault("disabled_toolsets", [])
    if not isinstance(disabled, list):
        raise InstallError("restricted agent.disabled_toolsets must be a list")
    disabled.extend(item for item in RESTRICTED_DISABLED_TOOLSETS if item not in disabled)
    disable_mcp_servers(result)
    return result


def general_config(existing: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(existing)
    result.setdefault("platforms", {}).setdefault("zulip", {})["enabled"] = False
    platform = result.setdefault("platform_toolsets", {})
    if not isinstance(platform.get("zulip"), list) or not platform["zulip"]:
        platform["zulip"] = list(GENERAL_TOOLSETS)
    else:
        platform["zulip"] = [
            item for item in platform["zulip"] if item not in {"hco_bridge", "no_mcp"}
        ]
        if not platform["zulip"]:
            platform["zulip"] = list(GENERAL_TOOLSETS)
    known = result.setdefault("known_plugin_toolsets", {})
    if not isinstance(known, dict):
        raise InstallError("general known_plugin_toolsets config must be a mapping")
    configured = known.get("zulip", [])
    if not isinstance(configured, list):
        raise InstallError("general known_plugin_toolsets.zulip must be a list")
    known["zulip"] = [item for item in configured if item != "hco_bridge"]
    disable_mcp_servers(result)
    return result


def snapshot(path: Path) -> Snapshot:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return Snapshot(path, "absent", None, None, None, None, None)
    mode = stat.S_IMODE(info.st_mode)
    if stat.S_ISLNK(info.st_mode):
        return Snapshot(path, "symlink", None, os.readlink(path), mode, info.st_uid, info.st_gid)
    if stat.S_ISREG(info.st_mode):
        return Snapshot(path, "file", path.read_bytes(), None, mode, info.st_uid, info.st_gid)
    if stat.S_ISDIR(info.st_mode):
        return Snapshot(path, "directory", None, None, mode, info.st_uid, info.st_gid)
    if stat.S_ISSOCK(info.st_mode):
        return Snapshot(path, "socket", None, None, mode, info.st_uid, info.st_gid)
    raise InstallError(f"unsupported transaction path type: {path}")


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_text = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_text)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def remove_path(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def restore(item: Snapshot) -> None:
    path = item.path
    if item.kind == "absent":
        remove_path(path)
        return
    if item.kind == "directory":
        if not path.exists():
            path.mkdir(mode=item.mode or 0o700, parents=True)
        os.chmod(path, item.mode or 0o700, follow_symlinks=False)
        if item.uid is not None and item.gid is not None:
            os.chown(path, item.uid, item.gid, follow_symlinks=False)
        return
    if item.kind == "socket":
        # The restored running LaunchAgent recreates its socket after its
        # prior plist is back in place.
        remove_path(path)
        return
    remove_path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if item.kind == "symlink":
        os.symlink(item.target or "", path)
    elif item.kind == "file":
        atomic_write(path, item.data or b"", item.mode or 0o600)
    if item.kind != "symlink" and item.mode is not None:
        os.chmod(path, item.mode, follow_symlinks=False)
    if item.uid is not None and item.gid is not None:
        os.chown(path, item.uid, item.gid, follow_symlinks=False)


def verify_snapshot(item: Snapshot) -> None:
    try:
        info = item.path.lstat()
    except FileNotFoundError:
        if item.kind == "absent":
            return
        raise InstallError(f"rollback path is missing: {item.path}")
    if item.kind == "absent":
        raise InstallError(f"rollback left a transaction-created path: {item.path}")
    actual_kind = (
        "symlink" if stat.S_ISLNK(info.st_mode)
        else "file" if stat.S_ISREG(info.st_mode)
        else "directory" if stat.S_ISDIR(info.st_mode)
        else "socket" if stat.S_ISSOCK(info.st_mode)
        else "unsupported"
    )
    if actual_kind != item.kind:
        raise InstallError(f"rollback path type mismatch: {item.path}")
    if stat.S_IMODE(info.st_mode) != item.mode or info.st_uid != item.uid or info.st_gid != item.gid:
        raise InstallError(f"rollback path metadata mismatch: {item.path}")
    if item.kind == "file" and item.path.read_bytes() != item.data:
        raise InstallError(f"rollback file content mismatch: {item.path}")
    if item.kind == "symlink" and os.readlink(item.path) != item.target:
        raise InstallError(f"rollback symlink target mismatch: {item.path}")


def validate_mutable_path(path: Path, label: str, *, directory: bool | None = None) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if info.st_uid != uid:
        raise InstallError(f"{label} must be owned by the invoking user")
    if stat.S_ISLNK(info.st_mode):
        raise InstallError(f"{label} must not be a symlink")
    if directory is True and not stat.S_ISDIR(info.st_mode):
        raise InstallError(f"{label} must be a directory")
    if directory is False and not stat.S_ISREG(info.st_mode):
        raise InstallError(f"{label} must be a regular file")


def launchctl(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(launchctl_bin), *arguments],
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def service_state(domain: str, label: str) -> ServiceState:
    result = launchctl("print", f"{domain}/{label}", check=False)
    if result.returncode != 0:
        return ServiceState(domain, False, False, None)
    running = any(
        line.strip() == "state = running"
        for line in result.stdout.splitlines()
    )
    pid_matches = re.findall(r"^\s*pid\s*=\s*([1-9][0-9]*)\s*$", result.stdout, re.MULTILINE)
    pid = int(pid_matches[-1]) if pid_matches else None
    return ServiceState(domain, True, running, pid)


def wait_service_state(
    domain: str,
    label: str,
    expected: ServiceState,
    timeout: float = 8.0,
) -> ServiceState:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        actual = service_state(domain, label)
        if (
            actual.domain == expected.domain
            and actual.loaded == expected.loaded
            and actual.running == expected.running
        ):
            return actual
        time.sleep(0.1)
    raise InstallError(f"service state did not settle for {label}")


def bootout(label: str) -> None:
    launchctl("bootout", f"{bridge_launch_domain}/{label}", check=False)


def bootstrap(path: Path) -> None:
    argument = f"{launch_agents_text.rstrip('/')}/{path.name}"
    launchctl("bootstrap", bridge_launch_domain, argument)


def discover_gateway() -> ServiceState:
    loaded = [
        state
        for state in (
            service_state(domain, GATEWAY_LABEL)
            for domain in gateway_launch_domains
        )
        if state.loaded
    ]
    if len(loaded) > 1:
        raise InstallError("Hermes Gateway is loaded in multiple launch domains")
    if not loaded:
        raise InstallError("exactly one loaded Hermes Gateway is required")
    gateway = loaded[0]
    if not gateway.running:
        raise InstallError("Hermes Gateway is loaded but not running")
    if gateway.pid is None:
        raise InstallError("running Hermes Gateway did not expose a valid launchd PID")
    return gateway


def read_gateway_state(path: Path) -> dict[str, Any]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != uid
            or info.st_size < 1
            or info.st_size > MAX_CONFIG_BYTES
        ):
            raise InstallError("Gateway runtime state must be an invoking-user regular file")
        raw = os.read(descriptor, MAX_CONFIG_BYTES + 1)
    except OSError as error:
        raise InstallError("Gateway runtime state cannot be read safely") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InstallError("Gateway runtime state is not valid JSON") from error
    if type(value) is not dict:
        raise InstallError("Gateway runtime state must be a JSON object")
    return value


def validate_gateway_runtime_evidence(
    gateway: ServiceState,
    gateway_state_path: Path,
    required_profiles: set[str],
    required_platforms: set[str],
) -> dict[str, Any]:
    if not gateway.loaded or not gateway.running or gateway.pid is None:
        raise InstallError("Hermes Gateway did not remain loaded and running")
    state = read_gateway_state(gateway_state_path)
    if state.get("pid") != gateway.pid or state.get("gateway_state") != "running":
        raise InstallError("Gateway runtime state does not match the new launchd PID")
    served_profiles = state.get("served_profiles")
    if (
        type(served_profiles) is not list
        or any(type(item) is not str for item in served_profiles)
        or not required_profiles.issubset(set(served_profiles))
    ):
        raise InstallError("Gateway runtime state is missing required served profiles")
    platforms = state.get("platforms")
    if type(platforms) is not dict or any(
        type(platforms.get(name)) is not dict
        or platforms[name].get("state") != "connected"
        for name in required_platforms
    ):
        raise InstallError("Gateway runtime state is missing required connected platforms")
    return state


def capture_gateway_runtime_requirements(
    gateway: ServiceState,
    gateway_state_path: Path,
) -> tuple[set[str], set[str]]:
    state = read_gateway_state(gateway_state_path)
    served_profiles = state.get("served_profiles")
    platforms = state.get("platforms")
    if (
        state.get("pid") != gateway.pid
        or state.get("gateway_state") != "running"
        or type(served_profiles) is not list
        or any(type(item) is not str for item in served_profiles)
        or type(platforms) is not dict
        or any(type(name) is not str or type(value) is not dict for name, value in platforms.items())
    ):
        raise InstallError(
            "Gateway runtime state cannot establish a trustworthy preservation baseline"
        )
    connected_platforms = {
        name
        for name, value in platforms.items()
        if value.get("state") == "connected"
    }
    return set(served_profiles), connected_platforms


def validate_gateway_evidence(
    gateway: ServiceState,
    gateway_state_path: Path,
    attestation_path: Path,
    expected_release: Path,
    expected_plugin_version: str | None,
    required_profiles: set[str],
    required_platforms: set[str],
) -> str:
    validate_gateway_runtime_evidence(
        gateway,
        gateway_state_path,
        required_profiles,
        required_platforms,
    )

    return validate_gateway_attestation(
        gateway,
        attestation_path,
        expected_release,
        expected_plugin_version,
    )


def validate_gateway_attestation(
    gateway: ServiceState,
    attestation_path: Path,
    expected_release: Path,
    expected_plugin_version: str | None,
) -> str:
    if not gateway.loaded or not gateway.running or gateway.pid is None:
        raise InstallError("Hermes Gateway did not remain loaded and running")

    raw_attestation = read_owner_file(
        attestation_path,
        MAX_CONFIG_BYTES,
        "Hermes Codex bridge attestation",
    )
    try:
        attestation = json.loads(raw_attestation.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InstallError("Hermes Codex bridge attestation is not valid JSON") from error
    if type(attestation) is not dict:
        raise InstallError("Hermes Codex bridge attestation must be a JSON object")
    plugin_path = attestation.get("pluginPath")
    plugin_version = attestation.get("pluginVersion")
    try:
        resolved_plugin = Path(plugin_path).resolve(strict=True) if type(plugin_path) is str else None
    except OSError as error:
        raise InstallError("Hermes Codex bridge attestation pluginPath is invalid") from error
    if (
        attestation.get("schemaVersion") != 1
        or attestation.get("pid") != gateway.pid
        or type(plugin_version) is not str
        or not plugin_version
        or len(plugin_version.encode("utf-8")) > 128
        or (
            expected_plugin_version is not None
            and plugin_version != expected_plugin_version
        )
        or resolved_plugin != expected_release.resolve(strict=True)
        or attestation.get("hook") != "pre_gateway_dispatch"
        or attestation.get("ingressProfile") != "zulip-ingress"
    ):
        raise InstallError("Hermes Codex bridge attestation does not match the activated release")
    return plugin_version


def wait_gateway_evidence(
    domain: str,
    old_pid: int,
    gateway_state_path: Path,
    attestation_path: Path,
    expected_release: Path,
    expected_plugin_version: str,
    required_profiles: set[str],
    required_platforms: set[str],
    timeout: float = 20.0,
) -> ServiceState:
    deadline = time.monotonic() + timeout
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        gateway = service_state(domain, GATEWAY_LABEL)
        if gateway.loaded and gateway.running and gateway.pid is not None and gateway.pid != old_pid:
            try:
                validate_gateway_evidence(
                    gateway,
                    gateway_state_path,
                    attestation_path,
                    expected_release,
                    expected_plugin_version,
                    required_profiles,
                    required_platforms,
                )
                return gateway
            except InstallError as error:
                last_error = error
        time.sleep(0.1)
    detail = f": {last_error}" if last_error is not None else ""
    raise InstallError(f"Hermes Gateway activation evidence did not settle{detail}")


def wait_gateway_runtime_evidence(
    domain: str,
    old_pid: int,
    gateway_state_path: Path,
    required_profiles: set[str],
    required_platforms: set[str],
    timeout: float = 20.0,
) -> ServiceState:
    deadline = time.monotonic() + timeout
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        gateway = service_state(domain, GATEWAY_LABEL)
        if gateway.loaded and gateway.running and gateway.pid is not None and gateway.pid != old_pid:
            try:
                validate_gateway_runtime_evidence(
                    gateway,
                    gateway_state_path,
                    required_profiles,
                    required_platforms,
                )
                return gateway
            except InstallError as error:
                last_error = error
        time.sleep(0.1)
    detail = f": {last_error}" if last_error is not None else ""
    raise InstallError(f"Hermes Gateway rollback evidence did not settle{detail}")


def initial_bridge_gate(
    document: dict[str, Any],
    bearer: bytes,
    prior_hco: ServiceState,
    runtime_snapshots: list[Snapshot],
) -> None:
    socket_path = Path(document["bridge"]["socketPath"])
    if prior_hco.running:
        wait_bridge_gate(document, bearer)
        return
    if socket_path.exists() or socket_path.is_symlink():
        raise CompatibilityError(
            "bridge protocol compatibility: failed (socket exists without the intended running HCO service)"
        )

    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            [str(node_bin), str(repository / "hco" / "index.js")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HCO_CONFIG_PATH": hco_config_text, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        wait_bridge_gate(document, bearer, process=process)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        deadline = time.monotonic() + 4.0
        while socket_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if socket_path.exists():
            raise InstallError("temporary HCO did not release its socket")
        for item in reversed(runtime_snapshots):
            restore(item)
        for item in runtime_snapshots:
            verify_snapshot(item)


def make_plists(
    plugin_release: Path, document: dict[str, Any]
) -> tuple[bytes, bytes]:
    logs = install_root / "logs"
    hco = {
        "Label": HCO_LABEL,
        "ProgramArguments": [str(node_bin), str(repository / "hco" / "index.js")],
        "EnvironmentVariables": {"HCO_CONFIG_PATH": hco_config_text},
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(logs / "hco.stdout.log"),
        "StandardErrorPath": str(logs / "hco.stderr.log"),
    }
    delivery = {
        "Label": DELIVERY_LABEL,
        "ProgramArguments": [
            str(python_bin),
            "-B",
            str(plugin_release / "delivery_sidecar.py"),
            "--socket-path", document["bridge"]["socketPath"],
            "--hco-bearer-file", document["bridge"]["tokenPath"],
            "--zulip-config-file", str(zulip_config_path),
            "--worker-id", f"hco-delivery-{uid}",
            "--claim-limit", "10",
            "--lease-ms", "30000",
            "--poll-seconds", "1",
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(logs / "delivery.stdout.log"),
        "StandardErrorPath": str(logs / "delivery.stderr.log"),
    }
    return (
        plistlib.dumps(hco, fmt=plistlib.FMT_XML, sort_keys=False),
        plistlib.dumps(delivery, fmt=plistlib.FMT_XML, sort_keys=False),
    )


def release_manifest(source: Path) -> tuple[dict[str, str], set[str]]:
    files: dict[str, str] = {}
    directories: set[str] = set()
    for path in sorted(source.rglob("*")):
        relative = str(path.relative_to(source))
        if "__pycache__" in path.parts or path.name.endswith(".pyc"):
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise InstallError("plugin release source contains a symlink")
        if stat.S_ISDIR(info.st_mode):
            directories.add(relative)
        elif stat.S_ISREG(info.st_mode):
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            raise InstallError("plugin release source contains an unsupported path")
    return files, directories


def release_digest(source: Path) -> str:
    digest = hashlib.sha256()
    files, _directories = release_manifest(source)
    for relative, content_digest in sorted(files.items()):
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(content_digest.encode())
    return digest.hexdigest()[:12]


def validate_release_manifest(
    expected_files: dict[str, str],
    expected_directories: set[str],
    destination: Path,
) -> None:
    try:
        root_info = destination.lstat()
    except FileNotFoundError as error:
        raise InstallError("plugin release integrity check found a missing release") from error
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or stat.S_IMODE(root_info.st_mode) != 0o700
        or root_info.st_uid != uid
    ):
        raise InstallError("plugin release integrity check failed for release directory")
    actual_files: dict[str, str] = {}
    actual_directories: set[str] = set()
    for path in sorted(destination.rglob("*")):
        relative = str(path.relative_to(destination))
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != uid:
            raise InstallError("plugin release integrity check rejected ownership or symlink")
        if stat.S_ISDIR(info.st_mode):
            if stat.S_IMODE(info.st_mode) != 0o700:
                raise InstallError("plugin release integrity check rejected directory mode")
            actual_directories.add(relative)
        elif stat.S_ISREG(info.st_mode):
            if stat.S_IMODE(info.st_mode) != 0o600:
                raise InstallError("plugin release integrity check rejected file mode")
            actual_files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            raise InstallError("plugin release integrity check rejected unsupported path")
    if actual_files != expected_files or actual_directories != expected_directories:
        raise InstallError("plugin release integrity check rejected content or path set")


def validate_release_integrity(source: Path, destination: Path) -> None:
    expected_files, expected_directories = release_manifest(source)
    validate_release_manifest(expected_files, expected_directories, destination)


def create_release(
    source: Path,
    destination: Path,
    *,
    inject_failures: bool = False,
) -> None:
    if destination.exists():
        validate_release_integrity(source, destination)
        return
    temporary = destination.with_name(f".{destination.name}.staging-{os.getpid()}")
    try:
        temporary.lstat()
    except FileNotFoundError:
        pass
    else:
        raise InstallError("refusing pre-existing plugin release staging path")
    created_temporary = False
    try:
        temporary.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary.mkdir(mode=0o700)
        created_temporary = True
        shutil.copytree(
            source,
            temporary,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        if inject_failures and os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "release_copy":
            raise InstallError("injected failure during live release copy")
        chmod_injected = False
        for path in temporary.rglob("*"):
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
            if (
                inject_failures
                and not chmod_injected
                and os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "release_chmod"
            ):
                chmod_injected = True
                raise InstallError("injected failure during live release chmod")
        os.chmod(temporary, 0o700)
        if inject_failures and os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "release_replace":
            raise InstallError("injected failure during live release replace")
        os.replace(temporary, destination)
    finally:
        if created_temporary:
            remove_path(temporary)
    validate_release_integrity(source, destination)


def activate_symlink(
    stable: Path,
    release: Path,
    *,
    inject_failures: bool = True,
) -> None:
    if stable.exists() and not stable.is_symlink():
        raise InstallError(
            f"unmanaged plugin directory at {stable}; move it aside explicitly before installing"
        )
    temporary = stable.with_name(f".{stable.name}.next-{os.getpid()}")
    try:
        temporary.lstat()
    except FileNotFoundError:
        pass
    else:
        raise InstallError("refusing pre-existing stable symlink staging path")
    created_temporary = False
    try:
        os.symlink(release.name, temporary)
        created_temporary = True
        if inject_failures and os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "stable_symlink":
            raise InstallError("injected failure during stable symlink creation")
        if inject_failures and os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "stable_replace":
            raise InstallError("injected failure during stable symlink replace")
        os.replace(temporary, stable)
    finally:
        if created_temporary:
            remove_path(temporary)


def promote_release(staged: Path, destination: Path) -> None:
    expected_files, expected_directories = release_manifest(staged)
    if destination.exists():
        validate_release_manifest(expected_files, expected_directories, destination)
        return
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    failpoint = os.environ.get("HCO_INSTALLER_TEST_FAILPOINT")
    if failpoint == "release_copy":
        raise InstallError("injected failure during live release promotion")
    if failpoint == "release_chmod":
        raise InstallError("injected failure before promoted release validation")
    if failpoint == "release_replace":
        raise InstallError("injected failure during live release replace")
    os.replace(staged, destination)
    validate_release_manifest(expected_files, expected_directories, destination)


def promote_stable_symlink(staged: Path, stable: Path, release: Path) -> None:
    if stable.exists() and not stable.is_symlink():
        raise InstallError(
            f"unmanaged plugin directory at {stable}; move it aside explicitly before installing"
        )
    if not staged.is_symlink() or os.readlink(staged) != release.name:
        raise InstallError("staged stable plugin symlink is invalid")
    failpoint = os.environ.get("HCO_INSTALLER_TEST_FAILPOINT")
    if failpoint == "stable_symlink":
        raise InstallError("injected failure during stable symlink creation")
    if failpoint == "stable_replace":
        raise InstallError("injected failure during stable symlink replace")
    os.replace(staged, stable)


EFFECTIVE_HERMES_PROBE_PROGRAM = r'''
import hashlib
import inspect
import json
import os
import sys
import time
from pathlib import Path

mode, root_text, ingress_text, bridge_text, general_text, hco_config_text, project_env_text = sys.argv[1:]
root = Path(root_text)
ingress_home = Path(ingress_text)
bridge_home = Path(bridge_text)
general_home = Path(general_text)
project_env = Path(project_env_text)
route_path = Path(json.loads(Path(hco_config_text).read_text())["bridge"]["routeSnapshotPath"])
sys.path.insert(0, "/Users/hula/Projects/hermesAgent")
os.environ["HERMES_HOME"] = str(root)
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

from hermes_constants import get_default_hermes_root, get_hermes_home
from hermes_cli.config import load_config
from hermes_cli.env_loader import load_hermes_dotenv
from hermes_cli.profiles import get_profile_dir
from hermes_cli.tools_config import _get_platform_tools
import hermes_cli.plugins as plugin_module

loaded_env = load_hermes_dotenv(
    hermes_home=root,
    project_env=project_env,
)
if root / ".env" not in loaded_env:
    raise ValueError("effective Hermes dotenv was not loaded")
if os.environ.get("HCO_CONFIG_PATH") != hco_config_text:
    raise ValueError("effective HCO config path does not match the staged configuration")
if get_default_hermes_root() != root or get_hermes_home() != root:
    raise ValueError("effective default Hermes home resolution changed")
if (
    get_profile_dir("zulip-ingress") != ingress_home
    or get_profile_dir("codex-bridge") != bridge_home
    or get_profile_dir("hermes-general") != general_home
):
    raise ValueError("effective named Hermes home resolution changed")

if mode == "general-disabled":
    os.environ["HERMES_SAFE_MODE"] = "1"
    manager = plugin_module.PluginManager()
    plugin_module._plugin_manager = manager
    manager.discover_and_load()
    if manager._hooks.get("pre_gateway_dispatch") or manager._plugin_tool_names:
        raise ValueError("safe-mode plugin manager is not empty")
    os.environ["HERMES_HOME"] = str(general_home)
    tools = _get_platform_tools(load_config(), "zulip")
    if not tools or "hco_bridge" in tools:
        raise ValueError("bridge-disabled hermes-general is unavailable or bridge-enabled")
    raise SystemExit(0)

from gateway.config import Platform, PlatformConfig, load_gateway_config
from gateway.run import (
    _profile_runtime_scope,
    _without_secondary_profile_platform_env,
)
import gateway.platforms.zulip as zulip_module

gateway = load_gateway_config()
if gateway.multiplex_profiles is not True:
    raise ValueError("gateway multiplexing did not resolve true")
manager = plugin_module.PluginManager()
plugin_module._plugin_manager = manager
root_config = load_config()
manager.discover_and_load()
loaded = manager._plugins.get("hermes-codex-bridge")
if loaded is None or not loaded.enabled or loaded.error:
    raise ValueError("bridge plugin was not discovered and enabled")
if loaded.tools_registered or "hco_bridge" in manager._plugin_tool_names:
    raise ValueError("bridge plugin exposed a model-callable tool")
required_commands = {
    "codex",
    "hermes-codex-bridge-internal",
    "hermes-codex-bridge-natural",
    "hermes-codex-bridge-route-unavailable",
}
if not required_commands.issubset(manager._plugin_commands):
    raise ValueError("bridge private commands are missing")
natural_handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
plugin_llm = inspect.getclosurevars(natural_handler).nonlocals.get("llm")
if plugin_llm is None or not callable(plugin_llm.acomplete_structured):
    raise ValueError("bridge plugin LLM facade is unavailable")
callbacks = manager._hooks.get("pre_gateway_dispatch", [])
bridge_index = next(
    (
        index
        for index, callback in enumerate(callbacks)
        if callback.__module__.startswith("hermes_plugins.hermes_codex_bridge")
    ),
    None,
)
if bridge_index is None:
    raise ValueError("bridge pre-dispatch hook is missing")

def event_for(text):
    event = type("Event", (), {})()
    event.text = text
    event.message_id = "1"
    event.raw_message = {
        "message": {
            "sender_id": 1,
            "id": 1,
            "stream_id": 1,
            "subject": "canary",
        }
    }
    event.source = type(
        "Source",
        (),
        {
            "platform": Platform.ZULIP,
            "profile": "zulip-ingress",
            "chat_type": "stream",
            "chat_id": "1:canary",
            "chat_topic": "canary",
            "message_id": "1",
        },
    )()
    return event

def require_restricted_ingress():
    os.environ["HERMES_HOME"] = str(ingress_home)
    tools = _get_platform_tools(load_config(), "zulip")
    if tools:
        raise ValueError("zulip-ingress profile is not restricted")

bridge_callback = callbacks[bridge_index]
def invoke_bridge_fixture(event):
    def marked_bridge_callback(**kwargs):
        result = bridge_callback(**kwargs)
        if isinstance(result, dict):
            result = dict(result)
            result["_hco_probe_bridge"] = True
        return result
    marked_bridge_callback.__module__ = bridge_callback.__module__
    callbacks[bridge_index] = marked_bridge_callback
    try:
        results = manager.invoke_hook("pre_gateway_dispatch", event=event)
    finally:
        callbacks[bridge_index] = bridge_callback
    actionable = [
        result
        for result in results
        if isinstance(result, dict)
        and result.get("action") in {"skip", "rewrite", "allow"}
    ]
    if not actionable or actionable[0].get("_hco_probe_bridge") is not True:
        raise ValueError("a pre-bridge hook can intercept bridge events")
    return results

route_path.unlink(missing_ok=True)
missing_event = event_for("natural request")
missing_results = invoke_bridge_fixture(missing_event)
if missing_event.source.profile != "zulip-ingress" or not any(
    isinstance(result, dict)
    and result.get("action") == "rewrite"
    and result.get("text") == "/hermes-codex-bridge-route-unavailable"
    and result.get("_hco_probe_bridge") is True
    for result in missing_results
):
    raise ValueError("missing route snapshot did not fail closed")
require_restricted_ingress()

route_path.write_bytes(b"{malformed")
os.chmod(route_path, 0o600)
malformed_event = event_for("natural request")
malformed_results = invoke_bridge_fixture(malformed_event)
if malformed_event.source.profile != "zulip-ingress" or not any(
    isinstance(result, dict)
    and result.get("action") == "rewrite"
    and result.get("text") == "/hermes-codex-bridge-route-unavailable"
    and result.get("_hco_probe_bridge") is True
    for result in malformed_results
):
    raise ValueError("malformed route snapshot did not fail closed")
require_restricted_ingress()

generated_at_ms = int(time.time() * 1000)
route_payload = {
    "schemaVersion": 1,
    "generation": 1,
    "generatedAtMs": generated_at_ms,
    "validUntilMs": generated_at_ms + 60_000,
    "defaultOwner": "HERMES",
    "routes": [
        {
            "streamId": 1,
            "owner": "PROJECT",
            "projectId": "alpha",
            "source": "static",
            "topics": [],
        }
    ],
}
canonical_payload = json.dumps(
    route_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
).encode("utf-8")
route_snapshot = {
    **route_payload,
    "integrity": {
        "algorithm": "sha256",
        "canonicalPayloadSha256": hashlib.sha256(canonical_payload).hexdigest(),
    },
}
route_path.write_text(
    json.dumps(route_snapshot, ensure_ascii=False, separators=(",", ":")),
    encoding="utf-8",
)
os.chmod(route_path, 0o600)
routed_event = event_for("natural request")
routed_results = invoke_bridge_fixture(routed_event)
routed_actionable = [
    result
    for result in routed_results
    if isinstance(result, dict)
    and result.get("action") in {"skip", "rewrite", "allow"}
]
if (
    not routed_actionable
    or routed_actionable[0].get("_hco_probe_bridge") is not True
    or routed_actionable[0].get("action") != "rewrite"
    or not routed_actionable[0].get("text", "").startswith(
        "/hermes-codex-bridge-natural "
    )
    or "natural request" in routed_actionable[0].get("text", "")
    or routed_event.source.profile != "codex-bridge"
):
    raise ValueError("valid PROJECT route did not produce the bridge rewrite")
require_restricted_ingress()

def raising_bridge_callback(**_kwargs):
    raise RuntimeError("bridge hook failure fixture")
raising_bridge_callback.__module__ = bridge_callback.__module__
callbacks[bridge_index] = raising_bridge_callback
try:
    failed_event = event_for("natural request")
    manager.invoke_hook("pre_gateway_dispatch", event=failed_event)
    if failed_event.source.profile != "zulip-ingress":
        raise ValueError("bridge hook exception escaped the ingress profile")
    require_restricted_ingress()
finally:
    callbacks[bridge_index] = bridge_callback

os.environ["HERMES_HOME"] = str(bridge_home)
if _get_platform_tools(load_config(), "zulip"):
    raise ValueError("codex-bridge profile is not restricted")
os.environ["HERMES_HOME"] = str(root)
root_platform = gateway.platforms.get(Platform.ZULIP, PlatformConfig())
if root_platform.enabled:
    raise ValueError("default profile still owns Zulip polling")
conflicting_zulip_env = {
    "ZULIP_API_KEY": "hco-probe-wrong-global-key",
    "ZULIP_BOT_EMAIL": "hco-probe-wrong-global@example.invalid",
    "ZULIP_SITE_URL": "https://hco-probe-wrong-global.example.invalid",
    "ZULIP_REQUIRE_MENTION": "false",
    "ZULIP_FREE_RESPONSE_STREAMS": "hco-probe-wrong-global-stream",
    "ZULIP_CONTEXT_DEPTH": "999",
}
os.environ.update(conflicting_zulip_env)
with _without_secondary_profile_platform_env(), _profile_runtime_scope(ingress_home):
    if any(name in os.environ for name in conflicting_zulip_env):
        raise ValueError("secondary-profile Zulip environment was not isolated")
    ingress_gateway = load_gateway_config()
    platform_config = ingress_gateway.platforms.get(Platform.ZULIP, PlatformConfig())
    if not platform_config.enabled:
        raise ValueError("zulip-ingress does not own Zulip polling")
    if not zulip_module.check_zulip_requirements(platform_config):
        raise ValueError("zulip-ingress scoped requirements are unavailable")
    adapter = zulip_module.ZulipAdapter(platform_config)
    if not adapter._api_key or adapter._api_key == conflicting_zulip_env["ZULIP_API_KEY"]:
        raise ValueError("Zulip adapter did not use the ingress API key")
    if adapter._context_depth != 0:
        raise ValueError("Zulip adapter context depth is not zero")
    if "hco-probe-wrong-global-stream" in adapter._free_response_streams:
        raise ValueError("Zulip adapter used process-global stream settings")
if {
    name: os.environ.get(name)
    for name in conflicting_zulip_env
} != conflicting_zulip_env:
    raise ValueError("Zulip profile scope leaked process environment changes")
'''


def effective_hermes_probe(
    root: Path,
    ingress_home: Path,
    bridge_home: Path,
    general_home: Path,
    document: dict[str, Any],
    workspace: Path,
    phase: str,
) -> None:
    try:
        workspace.lstat()
    except FileNotFoundError:
        pass
    else:
        raise InstallError(f"refusing pre-existing {phase} Hermes probe workspace")
    workspace.mkdir(mode=0o700)
    try:
        probe_document = copy.deepcopy(document)
        route_path = workspace / "route-snapshot.json"
        probe_document["bridge"]["routeSnapshotPath"] = str(route_path)
        probe_config = workspace / "hco.json"
        atomic_write(
            probe_config,
            json.dumps(probe_document, separators=(",", ":")).encode("utf-8"),
        )
        probe_root = workspace / "hermes-home"
        probe_ingress_home = probe_root / "profiles" / "zulip-ingress"
        probe_bridge_home = probe_root / "profiles" / "codex-bridge"
        probe_general_home = probe_root / "profiles" / "hermes-general"
        probe_project_env = workspace / "project.env"
        if HERMES_PROJECT_ENV.exists():
            atomic_write(probe_project_env, HERMES_PROJECT_ENV.read_bytes())
        atomic_write(probe_root / "config.yaml", (root / "config.yaml").read_bytes())
        atomic_write(
            probe_root / ".env",
            update_env(
                (root / ".env").read_bytes(),
                {"HCO_CONFIG_PATH": str(probe_config)},
            ),
        )
        atomic_write(
            probe_ingress_home / "config.yaml",
            (ingress_home / "config.yaml").read_bytes(),
        )
        atomic_write(
            probe_ingress_home / ".env",
            (ingress_home / ".env").read_bytes(),
        )
        atomic_write(
            probe_ingress_home / "SOUL.md",
            (ingress_home / "SOUL.md").read_bytes(),
        )
        atomic_write(
            probe_bridge_home / "config.yaml",
            (bridge_home / "config.yaml").read_bytes(),
        )
        atomic_write(
            probe_general_home / "config.yaml",
            (general_home / "config.yaml").read_bytes(),
        )
        probe_plugins = probe_root / "plugins"
        probe_plugins.mkdir(mode=0o700)
        link_installed_plugin_siblings(root / "plugins", probe_plugins)
        os.symlink(root / "plugins" / PLUGIN_NAME, probe_plugins / PLUGIN_NAME)
        environment = {
            "HOME": os.environ["HOME"],
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HERMES_HOME": str(probe_root),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        for name in ("LANG", "LC_ALL", "HERMES_MANAGED_DIR"):
            if name in os.environ:
                environment[name] = os.environ[name]
        for mode in ("enabled", "general-disabled"):
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    EFFECTIVE_HERMES_PROBE_PROGRAM,
                    mode,
                    str(probe_root),
                    str(probe_ingress_home),
                    str(probe_bridge_home),
                    str(probe_general_home),
                    str(probe_config),
                    str(probe_project_env),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                env=environment,
            )
            if result.returncode != 0:
                raise CompatibilityError(
                    f"{phase} effective Hermes {mode} fixture failed: {result.stderr.strip()}"
                )
        diagnostic(f"{phase} valid PROJECT route rewrite fixture: passed")
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"{phase} effective Hermes probe", error)
    finally:
        remove_path(workspace)
    diagnostic(f"{phase} effective Hermes probe: passed")
    if phase == "activated":
        diagnostic("installed Hermes compatibility: passed")


def link_installed_plugin_siblings(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    for child in source.iterdir():
        if child.name == PLUGIN_NAME or child.name.startswith(f"{PLUGIN_NAME}-"):
            continue
        if child.is_dir():
            os.symlink(child, destination / child.name, target_is_directory=True)


def stage_effective_hermes_layout(
    stage_root: Path,
    source_plugin: Path,
    installed_plugins: Path,
    root_config_data: bytes,
    ingress_config_data: bytes,
    ingress_env_data: bytes,
    ingress_reminder_data: bytes,
    bridge_config_data: bytes,
    general_config_data: bytes,
    env_data: bytes,
    external_profiles: dict[str, tuple[bytes, bytes | None]],
) -> tuple[Path, Path, Path, Path, Path]:
    try:
        stage_root.lstat()
    except FileNotFoundError:
        pass
    else:
        raise InstallError("refusing pre-existing effective Hermes stage")
    stage_root.mkdir(mode=0o700)
    ingress_home = stage_root / "profiles" / "zulip-ingress"
    bridge_home = stage_root / "profiles" / "codex-bridge"
    general_home = stage_root / "profiles" / "hermes-general"
    atomic_write(stage_root / "config.yaml", root_config_data)
    atomic_write(stage_root / ".env", env_data)
    atomic_write(ingress_home / "config.yaml", ingress_config_data)
    atomic_write(ingress_home / ".env", ingress_env_data)
    atomic_write(ingress_home / "SOUL.md", ingress_reminder_data)
    atomic_write(bridge_home / "config.yaml", bridge_config_data)
    atomic_write(general_home / "config.yaml", general_config_data)
    for profile_name, (config_data, profile_env_data) in external_profiles.items():
        profile_home = stage_root / "profiles" / profile_name
        atomic_write(profile_home / "config.yaml", config_data)
        if profile_env_data is not None:
            atomic_write(profile_home / ".env", profile_env_data)
    plugins_dir = stage_root / "plugins"
    plugins_dir.mkdir(mode=0o700)
    link_installed_plugin_siblings(installed_plugins, plugins_dir)
    staged_candidate = plugins_dir / f".{PLUGIN_NAME}.candidate-{os.getpid()}"
    create_release(source_plugin, staged_candidate)
    staged_release = plugins_dir / (
        f"{PLUGIN_NAME}-{PLUGIN_VERSION}-{release_digest(staged_candidate)}"
    )
    os.replace(staged_candidate, staged_release)
    staged_stable = plugins_dir / PLUGIN_NAME
    activate_symlink(staged_stable, staged_release, inject_failures=False)
    return ingress_home, bridge_home, general_home, staged_release, staged_stable


def main() -> None:
    try:
        passwd_home = Path(pwd.getpwuid(uid).pw_dir)
        passwd_home_info = passwd_home.lstat()
    except (KeyError, OSError) as error:
        raise InstallError("invoking user's passwd home cannot be resolved") from error
    if (
        not passwd_home.is_absolute()
        or stat.S_ISLNK(passwd_home_info.st_mode)
        or not stat.S_ISDIR(passwd_home_info.st_mode)
        or passwd_home_info.st_uid != uid
    ):
        raise InstallError("invoking user's passwd home must be a real user-owned directory")
    environment_home = os.environ.get("HOME")
    if not environment_home or Path(environment_home) != passwd_home:
        raise InstallError("HOME must match the invoking user's passwd home")

    lock_path = passwd_home / ".hermes-codex-bridge-installer.lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        lock_descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise InstallError("installer lock cannot be opened safely") from error
    try:
        lock_info = os.fstat(lock_descriptor)
        if (
            not stat.S_ISREG(lock_info.st_mode)
            or lock_info.st_uid != uid
            or stat.S_IMODE(lock_info.st_mode) != 0o600
        ):
            raise InstallError("installer lock must be an invoking-user 0600 regular file")
        lock = os.fdopen(lock_descriptor, "a+b")
    except BaseException:
        os.close(lock_descriptor)
        raise
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock.close()
        raise InstallError("another installer transaction is active") from error

    transaction_committed = False
    created_install_directories: list[Path] = []

    def cleanup_failed_install_root() -> None:
        if transaction_committed:
            return
        if not lock.closed:
            lock.close()
        for directory in created_install_directories:
            try:
                directory.rmdir()
            except OSError:
                pass

    atexit.register(cleanup_failed_install_root)

    for path, label in (
        (node_bin, "Node executable"),
        (codex_bin, "Codex executable"),
        (launchctl_bin, "launchctl executable"),
    ):
        validate_executable(path, label)
    if not (repository / "hco" / "index.js").is_file():
        raise InstallError("HCO entry point is missing")
    source_plugin = repository / "plugin" / PLUGIN_NAME
    required_plugin_files = {"__init__.py", "plugin.py", "plugin.yaml", "bridge_client.py", "route_snapshot.py", "delivery_sidecar.py", "zulip_sender.py"}
    if not required_plugin_files.issubset({path.name for path in source_plugin.iterdir()}):
        raise InstallError("plugin source release is incomplete")

    cursor = install_root
    while not cursor.exists():
        created_install_directories.append(cursor)
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    if install_root.exists():
        validate_mutable_path(install_root, "install root", directory=True)
        if stat.S_IMODE(install_root.lstat().st_mode) != 0o700:
            raise InstallError("existing install root must have mode 0700")
    install_root.mkdir(mode=0o700, parents=True, exist_ok=True)

    document, bearer = parse_hco_config()
    configured_zulip_credentials = zulip_config_credentials()
    root, ingress_home, bridge_home, general_home = resolve_hermes_paths()
    if root != Path(os.environ.get("HERMES_HOME", str(root))):
        raise InstallError("HERMES_HOME did not resolve to the default Hermes root")

    root_env = root / ".env"
    ingress_env = ingress_home / ".env"
    plugins_dir = root / "plugins"
    profiles_dir = bridge_home.parent
    logs_dir = install_root / "logs"
    stable_link = plugins_dir / PLUGIN_NAME
    if stable_link.exists() and not stable_link.is_symlink():
        raise InstallError(
            f"unmanaged plugin directory at {stable_link}; move it aside explicitly before installing"
        )
    release = plugins_dir / f"{PLUGIN_NAME}-{PLUGIN_VERSION}-{release_digest(source_plugin)}"
    root_config_path = root / "config.yaml"
    ingress_config_path = ingress_home / "config.yaml"
    ingress_reminder_path = ingress_home / "SOUL.md"
    gateway_state_path = root / GATEWAY_STATE_FILE
    attestation_path = root / ATTESTATION_FILE
    bridge_config_path = bridge_home / "config.yaml"
    general_config_path = general_home / "config.yaml"
    hco_plist_path = launch_agents_dir / f"{HCO_LABEL}.plist"
    delivery_plist_path = launch_agents_dir / f"{DELIVERY_LABEL}.plist"
    database_path = Path(document["databasePath"])
    socket_path = Path(document["bridge"]["socketPath"])
    route_snapshot_path = Path(document["bridge"]["routeSnapshotPath"])
    stage_root = root.parent / f".{root.name}.hco-stage-{os.getpid()}"
    staged_probe_workspace = root.parent / f".{root.name}.hco-staged-probe-{os.getpid()}"
    activated_probe_workspace = root.parent / f".{root.name}.hco-activated-probe-{os.getpid()}"
    release_temporary = release.with_name(f".{release.name}.staging-{os.getpid()}")
    stable_temporary = stable_link.with_name(f".{stable_link.name}.next-{os.getpid()}")
    hermes_preflight_directories = [
        root / relative
        for relative in (
            "cron",
            "sessions",
            "logs",
            "logs/curator",
            "memories",
            "pairing",
            "hooks",
            "image_cache",
            "audio_cache",
            "skills",
        )
    ]
    hermes_preflight_files = [root / "SOUL.md", root / "auth.lock"]
    if root.exists() and root.parent.stat().st_dev != root.stat().st_dev:
        raise InstallError("effective Hermes stage cannot share the live root filesystem")
    for path, label in (
        (stage_root, "effective Hermes stage"),
        (staged_probe_workspace, "staged Hermes probe workspace"),
        (activated_probe_workspace, "activated Hermes probe workspace"),
    ):
        try:
            path.lstat()
        except FileNotFoundError:
            pass
        else:
            raise InstallError(f"refusing pre-existing {label}")
    runtime_paths = [
        database_path,
        Path(f"{database_path}-wal"),
        Path(f"{database_path}-shm"),
        socket_path,
        route_snapshot_path,
    ]
    for path, label, is_directory in (
        (root, "default Hermes root", True),
        (plugins_dir, "Hermes plugin directory", True),
        (profiles_dir, "Hermes profiles directory", True),
        (ingress_home, "zulip-ingress profile directory", True),
        (bridge_home, "codex-bridge profile directory", True),
        (general_home, "hermes-general profile directory", True),
        (launch_agents_dir, "LaunchAgents directory", True),
        (logs_dir, "installer log directory", True),
        (root_config_path, "default Hermes config", False),
        (ingress_config_path, "zulip-ingress config", False),
        (ingress_env, "zulip-ingress dotenv", False),
        (ingress_reminder_path, "zulip-ingress reminder", False),
        (gateway_state_path, "Hermes Gateway runtime state", False),
        (attestation_path, "Hermes Codex bridge attestation", False),
        (bridge_config_path, "codex-bridge config", False),
        (general_config_path, "hermes-general config", False),
        (root_env, "default Hermes dotenv", False),
        (hco_plist_path, "HCO LaunchAgent plist", False),
        (delivery_plist_path, "delivery LaunchAgent plist", False),
    ):
        validate_mutable_path(path, label, directory=is_directory)
    if stable_link.is_symlink() and stable_link.lstat().st_uid != uid:
        raise InstallError("stable plugin symlink must be owned by the invoking user")
    for path in runtime_paths:
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if info.st_uid != uid or stat.S_ISLNK(info.st_mode):
            raise InstallError(f"HCO runtime path is not owned safely: {path}")
        if path == socket_path:
            if not stat.S_ISSOCK(info.st_mode):
                raise InstallError("configured HCO socket path is not a socket")
        elif not stat.S_ISREG(info.st_mode):
            raise InstallError(f"HCO runtime path must be a regular file: {path}")
    runtime_parents = list(dict.fromkeys(path.parent for path in runtime_paths))
    for path in runtime_parents:
        validate_mutable_path(path, "HCO runtime parent directory", directory=True)
    for path in hermes_preflight_directories:
        validate_mutable_path(path, "Hermes preflight directory", directory=True)
    for path in hermes_preflight_files:
        validate_mutable_path(path, "Hermes preflight file", directory=False)
    external_profiles = discover_external_profiles(profiles_dir)
    touched_paths = list(dict.fromkeys([
        root,
        plugins_dir,
        profiles_dir,
        ingress_home,
        bridge_home,
        general_home,
        launch_agents_dir,
        logs_dir,
        root_config_path,
        ingress_config_path,
        ingress_env,
        ingress_reminder_path,
        attestation_path,
        bridge_config_path,
        general_config_path,
        root_env,
        hco_plist_path,
        delivery_plist_path,
        release,
        stable_link,
        release_temporary,
        stable_temporary,
        stage_root,
        staged_probe_workspace,
        activated_probe_workspace,
        hco_config_path,
        zulip_config_path,
        Path(document["bridge"]["tokenPath"]),
        Path(document["bridge"]["contextKeyPath"]),
        *hermes_preflight_directories,
        *hermes_preflight_files,
        *runtime_parents,
        *runtime_paths,
        *(profile.config_path for profile in external_profiles),
    ]))
    snapshots = [snapshot(path) for path in touched_paths]
    runtime_path_set = set(runtime_parents + runtime_paths)
    runtime_snapshots = [item for item in snapshots if item.path in runtime_path_set]
    prior_services = {
        HCO_LABEL: service_state(bridge_launch_domain, HCO_LABEL),
        DELIVERY_LABEL: service_state(bridge_launch_domain, DELIVERY_LABEL),
    }
    prior_gateway = discover_gateway()
    prior_plugin_release = stable_link.resolve(strict=True) if stable_link.is_symlink() else None
    prior_runtime_profiles, prior_runtime_platforms = capture_gateway_runtime_requirements(
        prior_gateway,
        gateway_state_path,
    )
    activated_runtime_profiles = prior_runtime_profiles | {"default", "zulip-ingress"}
    activated_runtime_platforms = prior_runtime_platforms | {"zulip"}
    prior_plugin_version: str | None = None
    if prior_plugin_release is not None:
        try:
            prior_plugin_version = validate_gateway_evidence(
                prior_gateway,
                gateway_state_path,
                attestation_path,
                prior_plugin_release,
                None,
                prior_runtime_profiles,
                prior_runtime_platforms,
            )
        except InstallError:
            pass
    stopped_keepalive_labels = [
        label
        for label, state in prior_services.items()
        if state.loaded and not state.running
    ]
    if stopped_keepalive_labels:
        raise InstallError(
            "loaded but stopped KeepAlive services cannot be restored safely: "
            + ", ".join(stopped_keepalive_labels)
        )
    mutation_started = False
    services_mutated = False
    gateway_mutated = False

    def rollback() -> None:
        rollback_produced_valid_attestation = False
        stopped_gateway_pid = prior_gateway.pid
        if gateway_mutated:
            current_gateway = service_state(prior_gateway.domain, GATEWAY_LABEL)
            if current_gateway.pid is not None:
                stopped_gateway_pid = current_gateway.pid
        if services_mutated:
            for label in (DELIVERY_LABEL, HCO_LABEL):
                bootout(label)
            for label in (DELIVERY_LABEL, HCO_LABEL):
                wait_service_state(
                    bridge_launch_domain,
                    label,
                    ServiceState(bridge_launch_domain, False, False, None),
                )
        for item in reversed(snapshots):
            if item.kind == "socket" and not services_mutated:
                continue
            restore(item)
        # Prove restoration before either service can legitimately mutate its
        # runtime state. Sockets are recreated by the restored HCO process and
        # are covered by the bridge readiness gate below.
        for item in snapshots:
            if item.kind != "socket":
                verify_snapshot(item)
        if services_mutated:
            if prior_services[HCO_LABEL].loaded and hco_plist_path.exists():
                bootstrap(hco_plist_path)
                wait_service_state(
                    bridge_launch_domain,
                    HCO_LABEL,
                    prior_services[HCO_LABEL],
                )
                if prior_services[HCO_LABEL].running:
                    wait_bridge_gate(document, bearer)
        if gateway_mutated:
            launchctl(
                "kickstart",
                "-k",
                f"{prior_gateway.domain}/{GATEWAY_LABEL}",
            )
            if prior_plugin_version is not None:
                restored_gateway = wait_gateway_evidence(
                    prior_gateway.domain,
                    stopped_gateway_pid or 0,
                    gateway_state_path,
                    attestation_path,
                    prior_plugin_release,
                    prior_plugin_version,
                    prior_runtime_profiles,
                    prior_runtime_platforms,
                )
            else:
                restored_gateway = wait_gateway_runtime_evidence(
                    prior_gateway.domain,
                    stopped_gateway_pid or 0,
                    gateway_state_path,
                    prior_runtime_profiles,
                    prior_runtime_platforms,
                )
            time.sleep(0.2)
            stable_gateway = service_state(prior_gateway.domain, GATEWAY_LABEL)
            if prior_plugin_version is not None:
                validate_gateway_evidence(
                    stable_gateway,
                    gateway_state_path,
                    attestation_path,
                    prior_plugin_release,
                    prior_plugin_version,
                    prior_runtime_profiles,
                    prior_runtime_platforms,
                )
            else:
                validate_gateway_runtime_evidence(
                    stable_gateway,
                    gateway_state_path,
                    prior_runtime_profiles,
                    prior_runtime_platforms,
                )
                if prior_plugin_release is not None:
                    try:
                        validate_gateway_attestation(
                            stable_gateway,
                            attestation_path,
                            prior_plugin_release,
                            None,
                        )
                    except InstallError:
                        pass
                    else:
                        rollback_produced_valid_attestation = True
            if restored_gateway.pid == prior_gateway.pid:
                raise InstallError("rollback did not restart the prior Hermes Gateway configuration")
        if services_mutated and prior_services[DELIVERY_LABEL].loaded and delivery_plist_path.exists():
            bootstrap(delivery_plist_path)
        for item in snapshots:
            if item.path in runtime_path_set:
                continue
            if (
                gateway_mutated
                and item.path == attestation_path
                and (
                    prior_plugin_version is not None
                    or rollback_produced_valid_attestation
                )
            ):
                continue
            verify_snapshot(item)
        if services_mutated:
            for label in (HCO_LABEL, DELIVERY_LABEL):
                wait_service_state(bridge_launch_domain, label, prior_services[label])

    old_handlers: dict[int, Any] = {}

    def interrupted(signum, _frame) -> None:
        raise KeyboardInterrupt(f"signal {signum}")

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        old_handlers[signum] = signal.signal(signum, interrupted)
    try:
        mutation_started = True
        initial_bridge_gate(document, bearer, prior_services[HCO_LABEL], runtime_snapshots)
        app_server_gate(document)
        installed_hermes_preflight(root)
        if os.environ.get("HCO_INSTALLER_TEST_PREFLIGHT_TOUCH") == "1":
            root_config_path.write_bytes(b"preflight side effect fixture\n")
        if os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "after_hermes_preflight":
            raise InstallError("injected failure after Hermes preflight")

        context_depth = effective_context_depth(root_env)
        effective_hco_path = effective_env_value(root_env, "HCO_CONFIG_PATH")
        process_hco_path = os.environ.get("HCO_CONFIG_PATH")
        if process_hco_path is not None and process_hco_path != hco_config_text:
            raise InstallError(
                "process HCO_CONFIG_PATH conflicts with --hco-config; unset it or use the same absolute path"
            )
        env_values = {"HCO_CONFIG_PATH": hco_config_text}
        if context_depth not in (None, "0"):
            if not authorize_context_depth_zero:
                raise InstallError(
                    "effective ZULIP_CONTEXT_DEPTH is nonzero or invalid; rerun with --authorize-context-depth-zero"
                )
        if effective_hco_path is not None and process_hco_path is not None and effective_hco_path != hco_config_text:
            raise InstallError("effective HCO_CONFIG_PATH does not match --hco-config")

        plugin_toolsets = installed_plugin_toolsets(root)
        existing_root_config = load_yaml(root_config_path)
        existing_ingress_config = load_yaml(ingress_config_path)
        root_config_data = yaml.safe_dump(
            root_config(existing_root_config, plugin_toolsets), sort_keys=False
        ).encode()
        ingress_config_data = yaml.safe_dump(
            ingress_config(
                existing_root_config, existing_ingress_config, plugin_toolsets
            ),
            sort_keys=False,
        ).encode()
        bridge_config_data = yaml.safe_dump(
            restricted_config(load_yaml(bridge_config_path), plugin_toolsets), sort_keys=False
        ).encode()
        general_config_data = yaml.safe_dump(
            general_config(load_yaml(general_config_path)), sort_keys=False
        ).encode()
        previous_env = root_env.read_bytes() if root_env.exists() else None
        previous_ingress_env = ingress_env.read_bytes() if ingress_env.exists() else None
        previous_env_values = dotenv_values(previous_env)
        existing_ingress_values = {
            name: value
            for name, value in dotenv_values(previous_ingress_env).items()
            if name.startswith("ZULIP_")
        }
        migrated_root_values = {
            name: value
            for name, value in previous_env_values.items()
            if name.startswith("ZULIP_")
        }
        legacy_aliases = {
            "ZULIP_BOT_EMAIL": "ZULIP_EMAIL",
            "ZULIP_SITE_URL": "ZULIP_SITE",
        }
        for values in (existing_ingress_values, migrated_root_values):
            for name, legacy_name in legacy_aliases.items():
                if name not in values and legacy_name in values:
                    values[name] = values[legacy_name]
                values.pop(legacy_name, None)
        ingress_values = dict(migrated_root_values)
        ingress_values.update(existing_ingress_values)
        for name, fallback in configured_zulip_credentials.items():
            ingress_values.setdefault(name, fallback)
        ingress_values["ZULIP_CONTEXT_DEPTH"] = "0"
        staged_external_profiles, external_profile_updates = external_profile_layout(
            external_profiles,
            ingress_values.get("ZULIP_API_KEY", ""),
        )
        ingress_env_data = update_env(
            remove_env_prefix(previous_ingress_env, "ZULIP_"),
            ingress_values,
        )
        env_data = update_env(remove_env_prefix(previous_env, "ZULIP_"), env_values)

        try:
            (
                staged_ingress_home,
                staged_bridge_home,
                staged_general_home,
                staged_release,
                staged_stable,
                ) = stage_effective_hermes_layout(
                    stage_root,
                    source_plugin,
                    plugins_dir,
                    root_config_data,
                    ingress_config_data,
                    ingress_env_data,
                    INGRESS_REMINDER,
                    bridge_config_data,
                    general_config_data,
                    env_data,
                    staged_external_profiles,
                )
            if stage_root.stat().st_dev != root.parent.stat().st_dev:
                raise InstallError("effective Hermes stage is not on the live root filesystem")
            if staged_release.name != release.name:
                raise InstallError("plugin source changed while the release was staged")
            effective_hermes_probe(
                stage_root,
                staged_ingress_home,
                staged_bridge_home,
                staged_general_home,
                document,
                staged_probe_workspace,
                "staged",
            )
            if os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "staged_hermes_probe":
                raise InstallError("injected failure after staged Hermes probe")

            plugins_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            ingress_home.mkdir(mode=0o700, parents=True, exist_ok=True)
            bridge_home.mkdir(mode=0o700, parents=True, exist_ok=True)
            general_home.mkdir(mode=0o700, parents=True, exist_ok=True)
            launch_agents_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            logs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            for directory in (plugins_dir, profiles_dir, ingress_home, bridge_home, general_home, launch_agents_dir, logs_dir):
                os.chmod(directory, 0o700)
            promote_release(staged_release, release)
            promote_stable_symlink(staged_stable, stable_link, release)
        finally:
            remove_path(stage_root)

        atomic_write(root_config_path, root_config_data)
        atomic_write(ingress_config_path, ingress_config_data)
        atomic_write(ingress_env, ingress_env_data)
        atomic_write(ingress_reminder_path, INGRESS_REMINDER)
        atomic_write(bridge_config_path, bridge_config_data)
        atomic_write(general_config_path, general_config_data)
        for path, config_data in external_profile_updates.items():
            atomic_write(path, config_data)
        atomic_write(root_env, env_data)
        hco_plist, delivery_plist = make_plists(release, document)
        atomic_write(hco_plist_path, hco_plist)
        atomic_write(delivery_plist_path, delivery_plist)
        effective_hermes_probe(
            root,
            ingress_home,
            bridge_home,
            general_home,
            document,
            activated_probe_workspace,
            "activated",
        )
        services_mutated = True
        for label in (DELIVERY_LABEL, HCO_LABEL):
            if prior_services[label].loaded:
                bootout(label)
        for label in (DELIVERY_LABEL, HCO_LABEL):
            if prior_services[label].loaded:
                wait_service_state(
                    bridge_launch_domain,
                    label,
                    ServiceState(bridge_launch_domain, False, False, None),
                )
        bootstrap(hco_plist_path)
        # HCO starts first. Both launchd ownership and protocol readiness must
        # settle before the send-only delivery worker can consume an outbox row.
        wait_service_state(
            bridge_launch_domain,
            HCO_LABEL,
            ServiceState(bridge_launch_domain, True, True, None),
        )
        wait_bridge_gate(document, bearer)
        gateway_mutated = True
        remove_path(attestation_path)
        launchctl(
            "kickstart",
            "-k",
            f"{prior_gateway.domain}/{GATEWAY_LABEL}",
        )
        activated_gateway = wait_gateway_evidence(
            prior_gateway.domain,
            prior_gateway.pid or 0,
            gateway_state_path,
            attestation_path,
            release,
            PLUGIN_VERSION,
            activated_runtime_profiles,
            activated_runtime_platforms,
        )
        time.sleep(0.2)
        stable_gateway = service_state(prior_gateway.domain, GATEWAY_LABEL)
        if stable_gateway.pid != activated_gateway.pid:
            raise InstallError("Hermes Gateway PID changed during the stability window")
        validate_gateway_evidence(
            stable_gateway,
            gateway_state_path,
            attestation_path,
            release,
            PLUGIN_VERSION,
            activated_runtime_profiles,
            activated_runtime_platforms,
        )
        if os.environ.get("HCO_INSTALLER_TEST_FAILPOINT") == "after_hco_bootstrap":
            raise InstallError("injected failure after HCO bootstrap")
        bootstrap(delivery_plist_path)
        wait_service_state(
            bridge_launch_domain,
            DELIVERY_LABEL,
            ServiceState(bridge_launch_domain, True, True, None),
        )
    except BaseException:
        if mutation_started:
            try:
                rollback()
            except BaseException as rollback_error:
                raise InstallError(
                    "rollback verification failed; bridge services were stopped but manual restoration is required"
                    f" ({rollback_error})"
                ) from rollback_error
        raise
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        lock.close()
    transaction_committed = True
    atexit.unregister(cleanup_failed_install_root)
    diagnostic(f"installation committed: plugin {PLUGIN_VERSION}")


try:
    main()
except CompatibilityError as error:
    print(f"installer compatibility error: {error}", file=sys.stderr)
    raise SystemExit(1)
except (InstallError, KeyboardInterrupt) as error:
    print(f"installer error: {error}", file=sys.stderr)
    raise SystemExit(1)
except BaseException as error:
    print(f"installer error: unexpected {type(error).__name__}", file=sys.stderr)
    raise SystemExit(1)
PY
