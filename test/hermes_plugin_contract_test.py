from __future__ import annotations

import asyncio
import base64
import json
import hashlib
import inspect
import os
import shutil
import stat
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from hermes_cli.plugins import PluginContext, PluginManager
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.session import SessionSource, build_session_key


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SOURCE = REPO_ROOT / "plugin" / "hermes-codex-bridge"
ROUTE_UNAVAILABLE_COMMAND = "/hermes-codex-bridge-route-unavailable"
ROUTE_UNAVAILABLE_TEXT = "项目路由暂不可用，请稍后重试。"
ATTESTATION_FILE = "hermes-codex-bridge-attestation.json"


def _write_private(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def _install_fixture(tmp_path: Path, monkeypatch) -> tuple[PluginManager, Path, Path]:
    home = tmp_path / "hermes-home"
    installed = home / "plugins" / "hermes-codex-bridge"
    installed.parent.mkdir(parents=True)
    shutil.copytree(PLUGIN_SOURCE, installed)
    (home / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["hermes-codex-bridge"]}}),
        encoding="utf-8",
    )

    key_path = tmp_path / "context.key"
    token_path = tmp_path / "bridge.token"
    snapshot_path = tmp_path / "routes.json"
    socket_path = tmp_path / "hco.sock"
    _write_private(key_path, b"k" * 32)
    _write_private(token_path, b"bridge-token")
    hco_config = tmp_path / "hco.json"
    _write_private(
        hco_config,
        json.dumps(
            {
                "version": 1,
                "databasePath": str(tmp_path / "hco.sqlite"),
                "bridge": {
                    "tokenPath": str(token_path),
                    "contextKeyPath": str(key_path),
                    "socketPath": str(socket_path),
                    "routeSnapshotPath": str(snapshot_path),
                },
                "admins": [],
                "projects": [],
            }
        ).encode(),
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HCO_CONFIG_PATH", str(hco_config))
    return PluginManager(), installed, snapshot_path


def _snapshot(routes: list[dict], *, now_ms: int | None = None) -> bytes:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    payload = {
        "schemaVersion": 1,
        "generation": 7,
        "generatedAtMs": now_ms,
        "validUntilMs": now_ms + 60_000,
        "defaultOwner": "HERMES",
        "routes": routes,
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    document = {
        **payload,
        "integrity": {
            "algorithm": "sha256",
            "canonicalPayloadSha256": hashlib.sha256(canonical).hexdigest(),
        },
    }
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def _route(
    stream_id: int,
    owner: str,
    *,
    project_id: str | None = None,
    source: str = "runtime",
    topics: list[dict] | None = None,
) -> dict:
    return {
        "streamId": stream_id,
        "owner": owner,
        "projectId": project_id,
        "source": source,
        "topics": topics or [],
    }


def _event(
    text: str = "natural work request",
    *,
    stream_id=42,
    sender_id=17,
    message_id=99,
    topic="Build",
    chat_type="stream",
    raw_message=None,
):
    message = {
        "sender_id": sender_id,
        "id": message_id,
        "stream_id": stream_id,
        "subject": topic,
    }
    return SimpleNamespace(
        text=text,
        message_id=str(message_id),
        raw_message={"message": message} if raw_message is None else raw_message,
        source=SimpleNamespace(
            profile="attacker-profile",
            platform="zulip",
            chat_type=chat_type,
            chat_id=f"{stream_id}:{topic}",
            chat_topic=topic,
            user_id="person@example.com",
            message_id=str(message_id),
        ),
    )


def _load_manager(tmp_path: Path, monkeypatch, snapshot: bytes | None = None):
    manager, _installed, snapshot_path = _install_fixture(tmp_path, monkeypatch)
    if snapshot is not None:
        snapshot_path.write_bytes(snapshot)
    manager.discover_and_load()
    return manager, snapshot_path


class _CountingLlm:
    def __init__(self, parsed, *, entered: asyncio.Event | None = None, release: asyncio.Event | None = None):
        self.parsed = parsed
        self.calls = []
        self.entered = entered
        self.release = release

    async def acomplete_structured(self, **kwargs):
        self.calls.append(kwargs)
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            await self.release.wait()
        if isinstance(self.parsed, BaseException):
            raise self.parsed
        return SimpleNamespace(parsed=self.parsed)


def _load_manager_with_llm(
    tmp_path: Path,
    monkeypatch,
    parsed,
    snapshot: bytes | None = None,
    *,
    entered: asyncio.Event | None = None,
    release: asyncio.Event | None = None,
):
    llm = _CountingLlm(parsed, entered=entered, release=release)
    monkeypatch.setattr(PluginContext, "llm", property(lambda _self: llm))
    manager, snapshot_path = _load_manager(tmp_path, monkeypatch, snapshot)
    return manager, snapshot_path, llm


def _invoke(manager: PluginManager, event) -> dict:
    results = manager.invoke_hook("pre_gateway_dispatch", event=event)
    assert len(results) == 1
    return results[0]


def _token_from_rewrite(result: dict) -> str:
    prefix = "/hermes-codex-bridge-internal "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    return result["text"][len(prefix) :]


def _nlp_token_from_rewrite(result: dict) -> str:
    prefix = "/hermes-codex-bridge-natural "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    return result["text"][len(prefix) :]


def _token_payload(token: str) -> dict:
    encoded, _signature = token.split(".")
    padding = "=" * (-len(encoded) % 4)
    return json.loads(base64.urlsafe_b64decode(encoded + padding))


def _plugin_globals(manager: PluginManager) -> dict:
    return manager._plugins["hermes-codex-bridge"].module.register.__globals__


def test_real_directory_plugin_is_discovered_and_registers_synchronously(
    tmp_path: Path, monkeypatch
) -> None:
    manager, installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)

    manager.discover_and_load()

    loaded = manager._plugins["hermes-codex-bridge"]
    assert (installed / "plugin.yaml").is_file()
    assert (installed / "__init__.py").is_file()
    assert loaded.enabled is True
    assert loaded.error is None
    assert loaded.hooks_registered == ["pre_gateway_dispatch"]
    assert set(loaded.commands_registered) == {
        "codex",
        "hermes-codex-bridge-internal",
        "hermes-codex-bridge-natural",
        "hermes-codex-bridge-route-unavailable",
    }
    assert loaded.tools_registered == []


def test_successful_registration_writes_owner_only_process_attestation(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)

    manager.discover_and_load()

    loaded = manager._plugins["hermes-codex-bridge"]
    registered_plugin = Path(loaded.module.register.__globals__["__file__"]).parent.resolve()
    attestation_path = tmp_path / "hermes-home" / ATTESTATION_FILE
    info = attestation_path.stat()
    attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
    assert stat.S_ISREG(info.st_mode)
    assert info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o600
    assert attestation == {
        "schemaVersion": 1,
        "pid": os.getpid(),
        "pluginVersion": "1.0.0",
        "pluginPath": str(registered_plugin),
        "hook": "pre_gateway_dispatch",
        "ingressProfile": "zulip-ingress",
    }


def test_process_attestation_retries_short_writes(tmp_path: Path, monkeypatch) -> None:
    manager, _installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)
    manager.discover_and_load()
    globals_ = _plugin_globals(manager)
    real_write = os.write
    writes = []

    def short_write(descriptor: int, data: bytes) -> int:
        writes.append(len(data))
        return real_write(descriptor, data[: max(1, len(data) // 2)])

    monkeypatch.setattr(globals_["os"], "write", short_write)
    globals_["_write_process_attestation"]()

    attestation_path = tmp_path / "hermes-home" / ATTESTATION_FILE
    attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
    assert attestation["pid"] == os.getpid()
    assert len(writes) > 1


def test_valid_numeric_routes_select_only_explicit_hermes_profile(
    tmp_path: Path, monkeypatch
) -> None:
    routes = [
        _route(42, "PROJECT", project_id="alpha", source="static"),
        _route(43, "HERMES", source="runtime"),
    ]
    manager, _ = _load_manager(tmp_path, monkeypatch, _snapshot(routes))

    project = _event(stream_id=42)
    hermes = _event(stream_id=43)
    unknown = _event(stream_id=44)

    assert _invoke(manager, project)["action"] == "rewrite"
    assert project.source.profile == "codex-bridge"
    assert _invoke(manager, hermes) == {"action": "allow"}
    assert hermes.source.profile == "hermes-general"
    assert _invoke(manager, unknown) == {"action": "allow"}
    assert unknown.source.profile == "hermes-general"


@pytest.mark.parametrize(
    "snapshot",
    [
        None,
        b"not-json\n",
        b"{}\n",
        b"x" * 262_145,
        _snapshot([_route(43, "HERMES")], now_ms=1),
        _snapshot([_route(43, "HERMES")]).replace(b'"generation":7', b'"generation":8'),
        _snapshot([_route(44, "HERMES"), _route(43, "HERMES")]),
        _snapshot([_route(43, "HERMES"), _route(43, "HERMES")]),
    ],
    ids=[
        "missing",
        "corrupt",
        "wrong-shape",
        "oversized",
        "stale",
        "bad-integrity",
        "out-of-order-streams",
        "duplicate-streams",
    ],
)
def test_bad_route_snapshots_keep_restricted_default(
    tmp_path: Path, monkeypatch, snapshot: bytes | None
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch, snapshot)
    event = _event(stream_id=43)

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    assert event.source.profile == "zulip-ingress"


def test_bad_route_snapshot_rejects_direct_codex_commands_before_hco(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    event = _event("/codex status")

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    assert event.source.profile == "zulip-ingress"


@pytest.mark.parametrize(
    ("mutation", "value"),
    [
        ("missing_nested", None),
        ("top_level_only", 17),
        ("sender_id", "person@example.com"),
        ("sender_id", True),
        ("sender_id", 0),
        ("sender_id", -1),
        ("sender_id", 17.0),
        ("sender_id", "17"),
        ("sender_id", 9_007_199_254_740_992),
        ("message_id", 100),
        ("source_message_id", "100"),
        ("stream_id", 43),
        ("subject", "Other"),
        ("chat_id", "42:Other"),
        ("chat_topic", "Other"),
        ("chat_type", "channel"),
    ],
)
def test_nested_zulip_provenance_must_be_complete_typed_and_consistent(
    tmp_path: Path, monkeypatch, mutation: str, value
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event()
    message = event.raw_message["message"]
    if mutation == "missing_nested":
        event.raw_message = {}
    elif mutation == "top_level_only":
        event.raw_message = {"sender_id": value}
    elif mutation == "message_id":
        event.message_id = str(value)
    elif mutation == "source_message_id":
        event.source.message_id = value
    elif mutation in {"chat_id", "chat_topic", "chat_type"}:
        setattr(event.source, mutation, value)
    else:
        message[mutation] = value

    assert _invoke(manager, event) == {"action": "allow"}
    assert event.source.profile == "zulip-ingress"


def test_non_zulip_events_are_not_reprofiled(tmp_path: Path, monkeypatch) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event()
    event.source.platform = "feishu"
    event.source.profile = "jarvis-root"

    assert _invoke(manager, event) == {"action": "allow"}
    assert event.source.profile == "jarvis-root"


def test_unsafe_key_disables_all_bridge_registration(tmp_path: Path, monkeypatch) -> None:
    manager, _installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)
    (tmp_path / "context.key").chmod(0o644)

    manager.discover_and_load()

    loaded = manager._plugins["hermes-codex-bridge"]
    assert loaded.enabled is True
    assert loaded.error is None
    assert loaded.hooks_registered == []
    assert loaded.commands_registered == []
    assert loaded.tools_registered == []


def test_wrong_owner_uid_disables_all_bridge_registration(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(tmp_path / "context.key").st_uid + 1)

    manager.discover_and_load()

    loaded = manager._plugins["hermes-codex-bridge"]
    assert loaded.enabled is True
    assert loaded.error is None
    assert loaded.hooks_registered == []
    assert loaded.commands_registered == []
    assert loaded.tools_registered == []


@pytest.mark.parametrize("replacement_kind", ["symlink", "unsafe", "oversized"])
def test_key_path_swap_disables_all_bridge_registration(
    tmp_path: Path, monkeypatch, replacement_kind: str
) -> None:
    manager, _installed, _snapshot_path = _install_fixture(tmp_path, monkeypatch)
    key_path = tmp_path / "context.key"
    replacement = tmp_path / "replacement.key"
    replacement.write_bytes(
        b"a" * (4_097 if replacement_kind == "oversized" else 32)
    )
    replacement.chmod(0o644 if replacement_kind == "unsafe" else 0o600)

    real_os_open = os.open
    real_path_open = Path.open
    swapped = False

    def swap_path() -> None:
        nonlocal swapped
        if swapped:
            return
        swapped = True
        key_path.unlink()
        if replacement_kind == "symlink":
            key_path.symlink_to(replacement)
        else:
            os.replace(replacement, key_path)

    def swapping_os_open(path, flags, mode=0o777, *, dir_fd=None):
        if os.fspath(path) == str(key_path):
            swap_path()
        if dir_fd is None:
            return real_os_open(path, flags, mode)
        return real_os_open(path, flags, mode, dir_fd=dir_fd)

    def swapping_path_open(self, *args, **kwargs):
        if self == key_path:
            swap_path()
        return real_path_open(self, *args, **kwargs)

    monkeypatch.setattr(os, "open", swapping_os_open)
    monkeypatch.setattr(Path, "open", swapping_path_open)

    manager.discover_and_load()

    loaded = manager._plugins["hermes-codex-bridge"]
    assert swapped is True
    assert loaded.enabled is True
    assert loaded.error is None
    assert loaded.hooks_registered == []
    assert loaded.commands_registered == []
    assert loaded.tools_registered == []


@pytest.mark.parametrize(
    ("text", "command"),
    [
        ("/codex run ship it", {"type": "RUN", "instruction": "ship it"}),
        ("/codex status", {"type": "STATUS"}),
        ("/codex status obj-1", {"type": "STATUS", "objectiveId": "obj-1"}),
        ("/codex cancel", {"type": "CANCEL"}),
        ("/codex cancel obj-1", {"type": "CANCEL", "objectiveId": "obj-1"}),
        ("/codex topic show", {"type": "TOPIC", "action": "SHOW"}),
        ("/codex topic auto", {"type": "TOPIC", "action": "AUTO"}),
        ("/codex topic hermes", {"type": "TOPIC", "action": "HERMES"}),
        ("/codex route show", {"type": "ROUTE", "action": "SHOW"}),
        (
            "/codex route set alpha-1",
            {"type": "ROUTE", "action": "SET", "projectId": "alpha-1"},
        ),
        ("/codex route none", {"type": "ROUTE", "action": "NONE"}),
        ("/codex route unset", {"type": "ROUTE", "action": "UNSET"}),
        (
            "/codex objective new write tests",
            {"type": "OBJECTIVE_NEW", "instruction": "write tests"},
        ),
        (
            "/codex objective continue obj-1 finish it",
            {
                "type": "OBJECTIVE_CONTINUE",
                "objectiveId": "obj-1",
                "instruction": "finish it",
            },
        ),
        (
            "/codex approve reply-1 accept",
            {"type": "APPROVE", "replyToken": "reply-1", "choice": "accept"},
        ),
        (
            "/codex answer reply-1 use safe default",
            {"type": "ANSWER", "replyToken": "reply-1", "text": "use safe default"},
        ),
    ],
)
def test_exact_public_grammar_rewrites_to_command_bound_signed_envelope(
    tmp_path: Path, monkeypatch, text: str, command: dict
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event(text)

    token = _token_from_rewrite(_invoke(manager, event))
    payload = _token_payload(token)

    assert event.source.profile == "codex-bridge"
    assert len(token.encode()) <= 4_096
    assert set(payload) == {
        "version",
        "issuedAt",
        "expiresAt",
        "nonce",
        "binding",
        "command",
    }
    assert payload["version"] == 1
    assert 0 < payload["expiresAt"] - payload["issuedAt"] <= 120
    assert payload["binding"] == {
        "streamId": 42,
        "topic": "Build",
        "sourceMessageId": 99,
        "senderId": 17,
    }
    assert payload["command"] == command


@pytest.mark.parametrize(
    "text",
    [
        "/codex",
        "/codex run",
        "/codex status one two",
        "/codex topic AUTO",
        "/codex route set",
        "/codex objective continue obj-only",
        "/codex unknown thing",
        "/codex run ok\nsecond-line",
    ],
)
@pytest.mark.asyncio
async def test_malformed_public_commands_rewrite_to_no_model_error_without_hco(
    tmp_path: Path, monkeypatch, text: str
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    event = _event(text)
    result = _invoke(manager, event)
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]

    assert event.source.profile == "codex-bridge"
    assert result == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-internal invalid",
    }
    assert await handler("invalid") == "Invalid /codex command."
    assert calls == []


@pytest.mark.asyncio
async def test_private_handler_verifies_then_awaits_exact_hco_event(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        await asyncio.sleep(0)
        calls.append(event)
        return {"accepted": True, "objectiveId": "obj-1"}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _token_from_rewrite(_invoke(manager, _event("/codex run ship it")))
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]

    pending = handler(token)
    assert inspect.isawaitable(pending)
    assert await pending == '{"accepted":true,"objectiveId":"obj-1"}'
    assert calls == [
        {
            "schemaVersion": 1,
            "kind": "COMMAND",
            "contextToken": token,
            "binding": {
                "streamId": 42,
                "topic": "Build",
                "sourceMessageId": 99,
                "senderId": 17,
            },
            "command": {"type": "RUN", "instruction": "ship it"},
        }
    ]


@pytest.mark.asyncio
async def test_private_handler_rejects_tamper_expiry_replay_and_direct_invocation(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    token = _token_from_rewrite(_invoke(manager, _event("/codex status")))
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    payload = _token_payload(token)
    payload["nonce"] = "expired-nonce"
    payload["issuedAt"] = 1
    payload["expiresAt"] = 2
    expired = globals_["_sign_context"](payload, b"k" * 32)

    assert await handler("user supplied text") == "Codex bridge request rejected."
    assert await handler(tampered) == "Codex bridge request rejected."
    assert await handler(expired) == "Codex bridge request rejected."
    assert await handler(token) == '{"accepted":true}'
    assert await handler(token) == "Codex bridge request rejected."
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_private_handler_rejects_replay_when_active_nonce_cache_is_full(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    monkeypatch.setitem(globals_, "MAX_REPLAY_ENTRIES", 3)
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    tokens = [
        _token_from_rewrite(
            _invoke(manager, _event("/codex status", message_id=100 + offset))
        )
        for offset in range(4)
    ]

    for token in tokens[:3]:
        assert await handler(token) == '{"accepted":true}'
    calls_at_capacity = len(calls)

    saturated_result = await handler(tokens[3])
    replay_result = await handler(tokens[0])

    assert saturated_result == "Codex bridge request rejected."
    assert replay_result == "Codex bridge request rejected."
    assert calls_at_capacity == 3
    assert len(calls) == calls_at_capacity


@pytest.mark.asyncio
async def test_private_handler_maps_transport_and_protocol_errors_stably(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]

    async def unavailable(_self, _event):
        raise globals_["BridgeUnavailableError"]("secret path")

    monkeypatch.setattr(globals_["BridgeClient"], "submit", unavailable)
    first = _token_from_rewrite(_invoke(manager, _event("/codex status", message_id=100)))
    assert await handler(first) == "Codex bridge unavailable."

    async def bad_protocol(_self, _event):
        raise globals_["BridgeProtocolError"]("secret response")

    monkeypatch.setattr(globals_["BridgeClient"], "submit", bad_protocol)
    second = _token_from_rewrite(_invoke(manager, _event("/codex status", message_id=101)))
    assert await handler(second) == "Codex bridge protocol error."


@pytest.mark.asyncio
async def test_async_unix_client_posts_exact_authenticated_json(tmp_path: Path, monkeypatch) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    client_class = globals_["BridgeClient"]
    # macOS limits AF_UNIX paths to 103 bytes; pytest's nested tmp_path can exceed it.
    socket_path = Path("/tmp") / f"hco-plugin-{time.time_ns()}.sock"
    received = {}

    async def serve(reader, writer):
        header = await reader.readuntil(b"\r\n\r\n")
        content_length = next(
            int(line.split(b":", 1)[1].strip())
            for line in header.split(b"\r\n")
            if line.lower().startswith(b"content-length:")
        )
        body = await reader.readexactly(content_length)
        received["header"] = header
        received["body"] = json.loads(body)
        response = b'{"result":{"accepted":true}}'
        wire_response = (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(response)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + response
        )
        split = len(wire_response) // 2
        writer.write(wire_response[:split])
        await writer.drain()
        await asyncio.sleep(0.01)
        writer.write(wire_response[split:])
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(serve, path=socket_path)
    try:
        client = client_class(str(socket_path), b"bridge-token")
        result = await client.submit({"schemaVersion": 1})
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == {"accepted": True}
    assert received["header"].startswith(b"POST /v1/events HTTP/1.1\r\n")
    assert b"Authorization: Bearer bridge-token\r\n" in received["header"]
    assert received["body"] == {
        "protocolVersion": 1,
        "pluginVersion": "1.0.0",
        "capabilities": ["signed_context", "message_binding", "nonce_replay"],
        "event": {"schemaVersion": 1},
    }


@pytest.mark.asyncio
async def test_natural_handler_submits_exact_event_and_rejects_authority_fields(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {
        "type": "DISPATCH",
        "instruction": "ship it",
        "constraints": ["keep compatibility"],
        "acceptanceCriteria": ["tests pass"],
        "reminders": [],
        "objective": {"mode": "CONTINUE", "objectiveId": "obj-1"},
        "topicModeAction": None,
    }
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True, "objectiveId": "obj-1"}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    result = await handler(token)

    assert result == '{"accepted":true,"objectiveId":"obj-1"}'
    assert len(llm.calls) == 1
    assert len(calls) == 1
    submitted = calls[0]
    assert submitted["schemaVersion"] == 1
    assert submitted["kind"] == "SEMANTIC"
    assert submitted["binding"] == {
        "streamId": 42,
        "topic": "Build",
        "sourceMessageId": 99,
        "senderId": 17,
    }
    assert submitted["semantic"] == semantic
    payload = _token_payload(submitted["contextToken"])
    assert payload["binding"] == submitted["binding"]
    assert payload["projectId"] == "alpha"
    assert payload["topicMode"] == "AUTO"

    for message_id, forbidden in enumerate(
        (
            "senderId",
            "streamId",
            "topic",
            "message",
            "project",
            "cwd",
            "profile",
            "permission",
            "role",
            "token",
            "socket",
            "filesystem",
        ),
        start=100,
    ):
        llm.parsed = {**semantic, forbidden: "attacker"}
        forbidden_token = _nlp_token_from_rewrite(
            _invoke(manager, _event(message_id=message_id))
        )
        assert await handler(forbidden_token) == "Hermes model protocol error."
    assert len(calls) == 1
    assert len(llm.calls) == 13


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "semantic",
    [
        None,
        [],
        {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "CODEX_BOUND"},
        {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": []},
        {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO", "extra": True},
        {
            "type": "DISPATCH",
            "instruction": "",
            "constraints": [],
            "acceptanceCriteria": [],
            "reminders": [],
            "objective": None,
            "topicModeAction": None,
        },
        {
            "type": "DISPATCH",
            "instruction": "work",
            "constraints": "not-a-list",
            "acceptanceCriteria": [],
            "reminders": [],
            "objective": {"mode": "CONTINUE"},
            "topicModeAction": None,
        },
    ],
)
async def test_natural_handler_rejects_invalid_semantic_union_without_hco(
    tmp_path: Path, monkeypatch, semantic
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    assert await handler(token) == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert calls == []


@pytest.mark.asyncio
async def test_natural_handler_returns_hco_denial_without_replay(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {
        "type": "DISPATCH",
        "instruction": "attempt protected work",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
        "topicModeAction": "AUTO",
    }
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot(
            [
                _route(
                    42,
                    "PROJECT",
                    project_id="alpha",
                    topics=[{"topic": "Build", "mode": "HERMES_ONLY"}],
                )
            ]
        ),
    )
    calls = []
    globals_ = _plugin_globals(manager)

    async def deny(_self, event):
        calls.append(event)
        raise globals_["BridgeProtocolError"]("bridge rejected request")

    monkeypatch.setattr(globals_["BridgeClient"], "submit", deny)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    assert await handler(token) == "Codex bridge protocol error."
    assert await handler(token) == "Codex bridge request rejected."
    assert len(llm.calls) == 1
    assert len(calls) == 1
    assert calls[0]["semantic"] == semantic


@pytest.mark.asyncio
async def test_natural_vault_isolates_concurrent_project_topics(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO"}
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot(
            [
                _route(
                    42,
                    "PROJECT",
                    project_id="alpha",
                    topics=[
                        {"topic": "Alpha", "mode": "CODEX_BOUND"},
                        {"topic": "Beta", "mode": "HERMES_ONLY"},
                    ],
                )
            ]
        ),
    )
    calls = []

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    async def run(topic: str, message_id: int):
        token = _nlp_token_from_rewrite(
            _invoke(manager, _event(topic=topic, message_id=message_id))
        )
        await asyncio.sleep(0)
        return await handler(token)

    results = await asyncio.gather(
        run("Alpha", 100),
        run("Beta", 101),
    )

    assert results == ['{"accepted":true}', '{"accepted":true}']
    assert len(llm.calls) == 2
    assert {(call["binding"]["topic"], call["binding"]["sourceMessageId"]) for call in calls} == {
        ("Alpha", 100),
        ("Beta", 101),
    }


def test_commands_and_non_project_events_make_zero_natural_model_calls(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot(
            [
                _route(42, "PROJECT", project_id="alpha"),
                _route(43, "HERMES"),
            ]
        ),
    )
    assert _invoke(manager, _event("/codex status"))["text"].startswith(
        "/hermes-codex-bridge-internal "
    )
    assert _invoke(manager, _event("/new")) == {"action": "allow"}
    hermes = _event(stream_id=43)
    assert _invoke(manager, hermes) == {"action": "allow"}
    assert hermes.source.profile == "hermes-general"
    unknown = _event(stream_id=44)
    assert _invoke(manager, unknown) == {"action": "allow"}
    assert unknown.source.profile == "hermes-general"
    invalid = _event(raw_message={})
    assert _invoke(manager, invalid) == {"action": "allow"}
    assert invalid.source.profile == "zulip-ingress"
    assert llm.calls == []


def test_plugin_hook_result_precedes_later_hooks_for_supported_install_order(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    manager._hooks["pre_gateway_dispatch"].append(
        lambda **_kwargs: {"action": "rewrite", "text": "later-plugin"}
    )

    results = manager.invoke_hook("pre_gateway_dispatch", event=_event())

    assert results[0]["text"].startswith("/hermes-codex-bridge-natural ")
    assert results[1] == {"action": "rewrite", "text": "later-plugin"}


class _BusyQueueAdapter(BasePlatformAdapter):
    async def connect(self, *, is_reconnect: bool = False):
        return None

    async def disconnect(self):
        return None

    async def send(self, chat_id, text, **kwargs):
        return SendResult(success=True, message_id="sent-1")

    async def get_chat_info(self, chat_id):
        return {}


def _adapter_event(text: str, message_id: int) -> MessageEvent:
    source = SessionSource(
        platform=Platform.ZULIP,
        chat_id="42:Build",
        chat_type="stream",
        chat_topic="Build",
        user_id="person@example.com",
        message_id=str(message_id),
    )
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=source,
        message_id=str(message_id),
        raw_message={
            "message": {
                "sender_id": 17,
                "id": message_id,
                "stream_id": 42,
                "subject": "Build",
            }
        },
    )


async def _dispatch_through_real_gateway(manager, monkeypatch, event):
    import hermes_cli.plugins as plugin_module
    from gateway.run import GatewayRunner

    monkeypatch.setattr(plugin_module, "_plugin_manager", manager)
    runner = object.__new__(GatewayRunner)
    runner.config = {}
    runner.session_store = SimpleNamespace()
    runner.adapters = {}
    runner.hooks = SimpleNamespace(emit_collect=_empty_hook_results)
    runner._running_agents = {}
    runner._running_agents_ts = {}
    runner._pending_messages = {}
    runner._session_model_overrides = {}
    runner._update_prompt_pending = {}
    runner._external_drain_active = False
    runner._draining = False
    runner._busy_input_mode = "interrupt"
    runner._scale_to_zero_note_real_inbound = lambda: None
    runner._is_user_authorized = lambda _source: True
    runner._session_key_for_source = lambda _source: "zulip:42:Build"
    runner._check_slash_access = lambda _source, _command: None
    runner._is_telegram_topic_root_lobby = lambda _source: False
    runner._claim_active_session_slot = lambda _key, _source: (None, None)
    runner._persist_active_agents = lambda: None
    runner._begin_session_run_generation = lambda _key: 1
    runner._restore_moa_one_shot = lambda _event, _key: None
    runner._release_running_agent_state = lambda _key: None
    agent_entries = []

    async def fail_if_agent_entered(*_args, **_kwargs):
        agent_entries.append("ordinary-agent")
        raise AssertionError("ordinary Hermes agent path was entered")

    runner._handle_message_with_agent = fail_if_agent_entered
    result = await GatewayRunner._handle_message(runner, event)
    return result, agent_entries


async def _empty_hook_results(*_args, **_kwargs):
    return []


@pytest.mark.asyncio
async def test_gateway_dispatch_contains_malformed_reject_reason_code_without_agent_fallthrough(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        {"type": "REJECT", "reasonCode": [], "text": "x"},
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("natural request", 500)
    )

    assert result == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert submissions == []
    assert agent_entries == []


@pytest.mark.asyncio
async def test_gateway_dispatch_rejects_invalid_route_authority_without_model_hco_or_agent(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, _dispatch())
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    event = _adapter_event("natural request", 501)
    event.source.profile = "zulip-ingress"

    result, agent_entries = await _dispatch_through_real_gateway(manager, monkeypatch, event)

    assert result == ROUTE_UNAVAILABLE_TEXT
    assert event.source.profile == "zulip-ingress"
    assert llm.calls == []
    assert submissions == []
    assert agent_entries == []


@pytest.mark.asyncio
async def test_idle_and_busy_exact_commands_use_zero_model_calls_and_busy_is_delayed(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    calls = []
    model_calls = []
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    command_done = asyncio.Event()

    async def submit(_self, event):
        calls.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    adapter = _BusyQueueAdapter(
        PlatformConfig(enabled=True, token="t", typing_indicator=False),
        Platform.ZULIP,
    )

    async def gateway_handler(event):
        if event.text == "active turn":
            active_started.set()
            await release_active.wait()
            return None
        results = manager.invoke_hook("pre_gateway_dispatch", event=event)
        for result in results:
            if result.get("action") == "rewrite":
                rewritten = replace(event, text=result["text"])
                command, raw_args = rewritten.text[1:].split(" ", 1)
                response = await manager._plugin_commands[command]["handler"](raw_args)
                command_done.set()
                return response
        model_calls.append(event.text)
        return "model response"

    adapter._message_handler = gateway_handler

    await adapter.handle_message(_adapter_event("/codex status", 100))
    await asyncio.wait_for(command_done.wait(), timeout=2)
    assert model_calls == []
    assert len(calls) == 1

    command_done.clear()
    await adapter.handle_message(_adapter_event("active turn", 101))
    await asyncio.wait_for(active_started.wait(), timeout=2)
    session_key = build_session_key(_adapter_event("active turn", 101).source)
    await adapter.handle_message(_adapter_event("/codex status", 102))

    assert session_key in adapter._pending_messages
    assert len(calls) == 1
    assert not command_done.is_set()

    release_active.set()
    await asyncio.wait_for(command_done.wait(), timeout=2)
    assert model_calls == []
    assert len(calls) == 2
    await adapter.cancel_background_tasks()


def _dispatch(*, objective=None, topic_mode_action=None) -> dict:
    return {
        "type": "DISPATCH",
        "instruction": "ship it",
        "constraints": ["keep compatibility"],
        "acceptanceCriteria": ["tests pass"],
        "reminders": [],
        "objective": objective,
        "topicModeAction": topic_mode_action,
    }


def test_project_natural_language_uses_short_one_shot_capability_without_user_text(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    request = "private request: do not embed me"
    event = _event(request)

    token = _nlp_token_from_rewrite(_invoke(manager, event))
    payload = _token_payload(token)

    assert event.source.profile == "codex-bridge"
    assert request not in token
    assert base64.urlsafe_b64encode(request.encode()).decode().rstrip("=") not in token
    assert set(payload) == {
        "version",
        "purpose",
        "issuedAt",
        "expiresAt",
        "nonce",
        "binding",
        "projectId",
        "topicMode",
        "messageSha256",
        "messageBytes",
    }
    assert payload["purpose"] == "codex-nlp-dispatch"
    assert payload["messageBytes"] == len(request.encode())
    assert payload["messageSha256"] == hashlib.sha256(request.encode()).hexdigest()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("semantic", "bridge_failure", "visible", "hco_calls"),
    [
        (_dispatch(objective=None), None, '{"accepted":true}', 1),
        (
            {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO"},
            None,
            '{"accepted":true}',
            1,
        ),
        (
            {"type": "CLARIFY", "question": "Which target?", "choices": ["A", "B"]},
            None,
            "Which target?\n- A\n- B",
            0,
        ),
        (
            {"type": "BUSINESS_REPLY", "text": "Already handled."},
            None,
            "Already handled.",
            0,
        ),
        (
            {"type": "REJECT", "reasonCode": "NOT_ACTIONABLE", "text": "No action."},
            None,
            "No action.",
            0,
        ),
        (
            {"type": "BUSINESS_REPLY", "text": "invalid", "authority": "admin"},
            None,
            "Hermes model protocol error.",
            0,
        ),
        (RuntimeError("provider secret"), None, "Hermes model unavailable.", 0),
        (
            _dispatch(objective=None),
            "unavailable",
            "Codex bridge unavailable.",
            1,
        ),
        (
            _dispatch(objective=None),
            "protocol",
            "Codex bridge protocol error.",
            1,
        ),
    ],
    ids=[
        "dispatch",
        "control",
        "clarify",
        "business-reply",
        "reject",
        "invalid-model-output",
        "llm-failure",
        "hco-unavailable",
        "hco-protocol-failure",
    ],
)
async def test_real_gateway_contains_every_natural_result_without_agent_fallthrough(
    tmp_path: Path,
    monkeypatch,
    semantic,
    bridge_failure: str | None,
    visible: str,
    hco_calls: int,
) -> None:
    request = "please decide what to do"
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        if bridge_failure == "unavailable":
            raise globals_["BridgeUnavailableError"]("offline")
        if bridge_failure == "protocol":
            raise globals_["BridgeProtocolError"]("bad response")
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event(request, 600)
    )

    assert result == visible
    assert len(llm.calls) == 1
    assert llm.calls[0]["input"] == [{"type": "text", "text": request}]
    assert request not in llm.calls[0]["instructions"]
    assert len(submissions) == hco_calls
    assert agent_entries == []
    if submissions:
        assert submissions[0]["kind"] == "SEMANTIC"
        assert submissions[0]["binding"]["senderId"] == 17
        assert submissions[0]["semantic"] == semantic
        assert semantic.get("objective", "absent") is submissions[0][
            "semantic"
        ].get("objective", "absent")


@pytest.mark.asyncio
async def test_natural_capability_is_consumed_before_first_await_and_never_restored(
    tmp_path: Path, monkeypatch
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("provider token secret"),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
        entered=entered,
        release=release,
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
    pending = asyncio.create_task(handler(token))
    await asyncio.wait_for(entered.wait(), timeout=2)

    assert await handler(token) == "Codex bridge request rejected."
    assert len(llm.calls) == 1
    release.set()
    assert await pending == "Hermes model unavailable."
    assert await handler(token) == "Codex bridge request rejected."
    assert submissions == []


@pytest.mark.asyncio
async def test_natural_capability_rejects_tamper_binding_digest_length_and_direct_input(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]
    globals_ = _plugin_globals(manager)

    direct = _invoke(manager, _event("/hermes-codex-bridge-natural attacker"))
    assert direct == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-natural invalid",
    }
    assert await handler("invalid") == "Codex bridge request rejected."

    for field, value in (
        ("projectId", "other"),
        ("topicMode", "HERMES_ONLY"),
        ("messageSha256", "0" * 64),
        ("messageBytes", 999),
    ):
        token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=100 + len(llm.calls))))
        payload = _token_payload(token)
        payload[field] = value
        altered = globals_["_sign_context"](payload, b"k" * 32)
        assert await handler(altered) == "Codex bridge request rejected."

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=200)))
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert await handler(tampered) == "Codex bridge request rejected."
    assert llm.calls == []


@pytest.mark.asyncio
async def test_invalid_model_output_is_local_and_makes_no_repair_or_hco_call(
    tmp_path: Path, monkeypatch
) -> None:
    invalid = {"type": "BUSINESS_REPLY", "text": "ok", "sender": "attacker"}
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        invalid,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    assert await handler(token) == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert submissions == []


@pytest.mark.asyncio
async def test_hermes_only_natural_dispatch_requires_auto_but_control_reaches_hco(
    tmp_path: Path, monkeypatch
) -> None:
    snapshot = _snapshot(
        [
            _route(
                42,
                "PROJECT",
                project_id="alpha",
                topics=[{"topic": "Build", "mode": "HERMES_ONLY"}],
            )
        ]
    )
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, _dispatch(), snapshot)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    plain = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=301)))
    assert await handler(plain) == "Codex bridge request rejected."
    assert submissions == []

    llm.parsed = _dispatch(topic_mode_action="AUTO")
    auto = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=302)))
    assert await handler(auto) == '{"accepted":true}'
    assert len(submissions) == 1

    llm.parsed = {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO"}
    control = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=303)))
    assert await handler(control) == '{"accepted":true}'
    assert len(submissions) == 2
    assert len(llm.calls) == 3


def test_natural_vault_fails_closed_at_sender_and_global_capacity_then_cleans_expiry(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "MAX_PENDING_PER_SENDER", 1)
    monkeypatch.setitem(globals_, "MAX_PENDING_ENTRIES", 2)
    now = int(time.time())
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)

    assert _invoke(manager, _event(sender_id=17, message_id=401))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    assert _invoke(manager, _event(sender_id=17, message_id=402)) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-natural invalid",
    }
    assert _invoke(manager, _event(sender_id=18, message_id=403))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    assert _invoke(manager, _event(sender_id=19, message_id=404)) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-natural invalid",
    }

    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 91)
    assert _invoke(manager, _event(sender_id=19, message_id=405))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "accepted"),
    [
        ("binding-stream", False),
        ("binding-topic", False),
        ("binding-message", False),
        ("binding-sender", False),
        ("future-exact", True),
        ("future-plus-one", False),
        ("expiry-exact", True),
        ("expiry-plus-one", False),
        ("ttl-exact", True),
        ("ttl-invalid", False),
        ("digest-mismatch", False),
        ("utf8-byte-length-mismatch", False),
    ],
)
async def test_nlp_capability_boundary_matrix_has_stable_counts(
    tmp_path: Path, monkeypatch, case: str, accepted: bool
) -> None:
    request = "界a"
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    now = 1_900_000_000
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(request, message_id=700)))
    payload = _token_payload(token)

    if case == "binding-stream":
        payload["binding"]["streamId"] = 43
    elif case == "binding-topic":
        payload["binding"]["topic"] = "Other"
    elif case == "binding-message":
        payload["binding"]["sourceMessageId"] = 701
    elif case == "binding-sender":
        payload["binding"]["senderId"] = 18
    elif case == "future-exact":
        payload["issuedAt"] = now + globals_["MAX_CLOCK_SKEW_SECONDS"]
        payload["expiresAt"] = payload["issuedAt"] + globals_["CONTEXT_LIFETIME_SECONDS"]
    elif case == "future-plus-one":
        payload["issuedAt"] = now + globals_["MAX_CLOCK_SKEW_SECONDS"] + 1
        payload["expiresAt"] = payload["issuedAt"] + globals_["CONTEXT_LIFETIME_SECONDS"]
    elif case == "expiry-exact":
        payload["expiresAt"] = now - globals_["MAX_CLOCK_SKEW_SECONDS"]
        payload["issuedAt"] = payload["expiresAt"] - globals_["CONTEXT_LIFETIME_SECONDS"]
    elif case == "expiry-plus-one":
        payload["expiresAt"] = now - globals_["MAX_CLOCK_SKEW_SECONDS"] - 1
        payload["issuedAt"] = payload["expiresAt"] - globals_["CONTEXT_LIFETIME_SECONDS"]
    elif case == "ttl-invalid":
        payload["expiresAt"] = payload["issuedAt"] + globals_["CONTEXT_LIFETIME_SECONDS"] - 1
    elif case == "digest-mismatch":
        payload["messageSha256"] = "0" * 64
    elif case == "utf8-byte-length-mismatch":
        assert len(request.encode("utf-8")) == 4
        payload["messageBytes"] = len(request)

    altered = globals_["_sign_context"](payload, b"k" * 32)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    handler = manager._plugin_commands["hermes-codex-bridge-natural"]["handler"]

    expected = '{"accepted":true}' if accepted else "Codex bridge request rejected."
    assert await handler(altered) == expected
    assert len(llm.calls) == (1 if accepted else 0)
    assert len(submissions) == (1 if accepted else 0)

    assert await handler(altered) == "Codex bridge request rejected."
    assert len(llm.calls) == (1 if accepted else 0)
    assert len(submissions) == (1 if accepted else 0)


def test_natural_vault_exact_capacity_byte_and_cleanup_boundaries(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    now = 1_900_000_000
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)

    monkeypatch.setitem(globals_, "MAX_PENDING_PER_SENDER", 2)
    assert _invoke(manager, _event("a", sender_id=17, message_id=800))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    assert _invoke(manager, _event("b", sender_id=17, message_id=801))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    assert _invoke(manager, _event("c", sender_id=17, message_id=802)) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-natural invalid",
    }

    manager, _, llm = _load_manager_with_llm(
        tmp_path / "global",
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)
    monkeypatch.setitem(globals_, "MAX_PENDING_ENTRIES", 2)
    for sender_id, message_id in ((17, 810), (18, 811)):
        assert _invoke(manager, _event("a", sender_id=sender_id, message_id=message_id))[
            "text"
        ].startswith("/hermes-codex-bridge-natural ")
    assert _invoke(manager, _event("a", sender_id=19, message_id=812))["text"].endswith(
        " invalid"
    )

    manager, _, llm = _load_manager_with_llm(
        tmp_path / "bytes",
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)
    monkeypatch.setitem(globals_, "MAX_PENDING_BYTES", 6)
    for sender_id, message_id in ((17, 820), (18, 821)):
        assert _invoke(manager, _event("界", sender_id=sender_id, message_id=message_id))[
            "text"
        ].startswith("/hermes-codex-bridge-natural ")
    assert _invoke(manager, _event("a", sender_id=19, message_id=822))["text"].endswith(
        " invalid"
    )

    manager, _, llm = _load_manager_with_llm(
        tmp_path / "cleanup",
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "MAX_PENDING_ENTRIES", 1)
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)
    assert _invoke(manager, _event("a", message_id=830))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 90)
    assert _invoke(manager, _event("b", message_id=831))["text"].endswith(" invalid")
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 91)
    assert _invoke(manager, _event("c", message_id=832))["text"].startswith(
        "/hermes-codex-bridge-natural "
    )
    assert llm.calls == []


def _utf8_exact_bytes(maximum: int) -> str:
    return "界" * (maximum // 3) + "a" * (maximum % 3)


def _semantic_boundary_pair(case: str, globals_: dict) -> tuple[dict, dict]:
    if case == "instruction":
        exact = _dispatch()
        exact["instruction"] = _utf8_exact_bytes(globals_["MAX_INSTRUCTION_BYTES"])
    elif case == "objective-id":
        exact = _dispatch(objective={"mode": "CONTINUE", "objectiveId": _utf8_exact_bytes(512)})
    elif case == "clarify-question":
        exact = {"type": "CLARIFY", "question": _utf8_exact_bytes(4 * 1024), "choices": []}
    elif case == "business-text":
        exact = {"type": "BUSINESS_REPLY", "text": _utf8_exact_bytes(globals_["MAX_VISIBLE_TEXT_BYTES"])}
    elif case == "reject-text":
        exact = {
            "type": "REJECT",
            "reasonCode": "NOT_ACTIONABLE",
            "text": _utf8_exact_bytes(4 * 1024),
        }
    elif case == "dispatch-list-entry":
        exact = _dispatch()
        exact["constraints"] = [_utf8_exact_bytes(globals_["MAX_LIST_ENTRY_BYTES"])]
    elif case == "clarify-choice":
        exact = {"type": "CLARIFY", "question": "Choose", "choices": [_utf8_exact_bytes(1024)]}
    elif case == "constraints-count":
        exact = _dispatch()
        exact["constraints"] = ["x"] * 16
    elif case == "acceptance-count":
        exact = _dispatch()
        exact["acceptanceCriteria"] = ["x"] * 16
    elif case == "reminders-count":
        exact = _dispatch()
        exact["reminders"] = ["x"] * 8
    elif case == "choices-count":
        exact = {"type": "CLARIFY", "question": "Choose", "choices": ["x"] * 5}
    elif case == "total-json":
        exact = _dispatch()
        exact["instruction"] = "i" * globals_["MAX_INSTRUCTION_BYTES"]
        exact["constraints"] = ["x" * globals_["MAX_LIST_ENTRY_BYTES"]] * 7
        remaining = globals_["MAX_SEMANTIC_BYTES"] - len(globals_["_canonical_json"](exact))
        exact["constraints"].append("x" * (remaining - 3))
        assert len(globals_["_canonical_json"](exact)) == globals_["MAX_SEMANTIC_BYTES"]
    else:
        raise AssertionError(f"unknown boundary case: {case}")

    plus = json.loads(json.dumps(exact, ensure_ascii=False))
    if case == "instruction":
        plus["instruction"] += "a"
    elif case == "objective-id":
        plus["objective"]["objectiveId"] += "a"
    elif case in {"clarify-question", "business-text", "reject-text"}:
        field = "question" if case == "clarify-question" else "text"
        plus[field] += "a"
    elif case == "dispatch-list-entry":
        plus["constraints"][0] += "a"
    elif case == "clarify-choice":
        plus["choices"][0] += "a"
    elif case == "constraints-count":
        plus["constraints"].append("x")
    elif case == "acceptance-count":
        plus["acceptanceCriteria"].append("x")
    elif case == "reminders-count":
        plus["reminders"].append("x")
    elif case == "choices-count":
        plus["choices"].append("x")
    elif case == "total-json":
        plus["constraints"][-1] += "a"
        assert len(globals_["_canonical_json"](plus)) == globals_["MAX_SEMANTIC_BYTES"] + 1
    return exact, plus


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "instruction",
        "objective-id",
        "clarify-question",
        "business-text",
        "reject-text",
        "dispatch-list-entry",
        "clarify-choice",
        "constraints-count",
        "acceptance-count",
        "reminders-count",
        "choices-count",
        "total-json",
    ],
)
async def test_semantic_utf8_count_and_total_json_exact_plus_one_boundaries(
    tmp_path: Path, monkeypatch, case: str
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        None,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    exact, plus = _semantic_boundary_pair(case, globals_)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    llm.parsed = exact
    exact_result, exact_agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("exact boundary", 900)
    )
    assert globals_["_valid_semantic"](exact) is True

    llm.parsed = plus
    plus_result, plus_agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("plus one boundary", 901)
    )

    exact_submits = 1 if exact["type"] in {"DISPATCH", "CONTROL"} else 0
    assert len(llm.calls) == 2
    assert len(submissions) == exact_submits
    assert plus_result == "Hermes model protocol error."
    assert globals_["_valid_semantic"](plus) is False
    assert exact_agent_entries == []
    assert plus_agent_entries == []
    if exact_submits:
        assert exact_result == '{"accepted":true}'
    elif exact["type"] == "CLARIFY":
        assert exact_result.startswith(exact["question"])
    else:
        assert exact_result == exact["text"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "malformed",
    [None, False, 1, 1.5, "", [], {}],
    ids=["none", "bool", "int", "float", "string", "list", "dict"],
)
@pytest.mark.parametrize(
    "case",
    [
        "type",
        "control-action",
        "control-mode",
        "dispatch-instruction",
        "objective-mode",
        "objective-id",
        "clarify-question",
        "business-text",
        "reject-reason",
        "reject-text",
    ],
)
async def test_semantic_scalar_type_matrix_is_total_and_gateway_local(
    tmp_path: Path, monkeypatch, case: str, malformed
) -> None:
    if case == "type":
        semantic = {"type": malformed, "text": "x"}
    elif case == "control-action":
        semantic = {"type": "CONTROL", "action": malformed, "mode": "AUTO"}
    elif case == "control-mode":
        semantic = {
            "type": "CONTROL",
            "action": "SET_TOPIC_MODE",
            "mode": malformed,
        }
    elif case == "dispatch-instruction":
        semantic = {**_dispatch(), "instruction": malformed}
    elif case == "objective-mode":
        semantic = {**_dispatch(), "objective": {"mode": malformed}}
    elif case == "objective-id":
        semantic = {
            **_dispatch(),
            "objective": {"mode": "CONTINUE", "objectiveId": malformed},
        }
    elif case == "clarify-question":
        semantic = {"type": "CLARIFY", "question": malformed, "choices": []}
    elif case == "business-text":
        semantic = {"type": "BUSINESS_REPLY", "text": malformed}
    elif case == "reject-reason":
        semantic = {"type": "REJECT", "reasonCode": malformed, "text": "x"}
    elif case == "reject-text":
        semantic = {
            "type": "REJECT",
            "reasonCode": "NOT_ACTIONABLE",
            "text": malformed,
        }
    else:
        raise AssertionError(f"unknown scalar case: {case}")

    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    assert globals_["_valid_semantic"](semantic) is False
    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("malformed scalar", 950)
    )
    assert result == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert submissions == []
    assert agent_entries == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "semantic",
    [
        {**_dispatch(), "constraints": {}},
        {**_dispatch(), "acceptanceCriteria": [1]},
        {**_dispatch(), "reminders": "x"},
        {**_dispatch(), "objective": []},
        {**_dispatch(), "topicModeAction": []},
        {"type": "CLARIFY", "question": "x", "choices": {}},
        {"type": "CLARIFY", "question": "x", "choices": [1]},
    ],
)
async def test_semantic_container_type_matrix_is_total_and_gateway_local(
    tmp_path: Path, monkeypatch, semantic
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    assert globals_["_valid_semantic"](semantic) is False
    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("malformed container", 951)
    )
    assert result == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert submissions == []
    assert agent_entries == []


def test_semantic_validation_never_raises_for_recursive_and_malformed_objects(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    validate = _plugin_globals(manager)["_valid_semantic"]
    recursive_dict = {"type": "BUSINESS_REPLY"}
    recursive_dict["text"] = recursive_dict
    recursive_list = []
    recursive_list.append(recursive_list)
    malformed = [
        None,
        True,
        1,
        float("nan"),
        "x",
        b"x",
        (),
        set(),
        recursive_dict,
        {"type": "CLARIFY", "question": "x", "choices": recursive_list},
        {"type": "BUSINESS_REPLY", "text": "\ud800"},
        {"type": "REJECT", "reasonCode": {}, "text": "x"},
    ]

    assert [validate(value) for value in malformed] == [False] * len(malformed)


@pytest.mark.asyncio
async def test_gateway_contains_unexpected_validator_failure(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        {"type": "BUSINESS_REPLY", "text": "x"},
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)

    def fail_validation(_semantic):
        raise RuntimeError("validator defect")

    monkeypatch.setitem(globals_, "_valid_semantic", fail_validation)
    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, _adapter_event("natural request", 990)
    )

    assert result == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert agent_entries == []
