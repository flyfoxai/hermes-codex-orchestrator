from __future__ import annotations

import asyncio
import base64
import json
import hashlib
import inspect
import os
import re
import shutil
import stat
import subprocess
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
from gateway.session_context import clear_session_vars, set_session_vars


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SOURCE = REPO_ROOT / "plugin" / "hermes-codex-bridge"
ROUTE_UNAVAILABLE_COMMAND = "/hermes-codex-bridge-route-unavailable"
ROUTE_UNAVAILABLE_TEXT = "项目路由暂不可用，请稍后重试。"
ATTESTATION_FILE = "hermes-codex-bridge-attestation.json"


def test_contract_process_isolates_hermes_state_before_plugin_discovery() -> None:
    process_home = Path(os.environ["HOME"]).resolve()
    hermes_home = Path(os.environ["HERMES_HOME"]).resolve()

    assert Path(os.environ["HCO_PYTEST_ISOLATED_HOME"]).resolve() == hermes_home
    assert hermes_home.parent == process_home


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
    manager._hco_test_session_keys = {}
    manager._hco_test_requests = {}
    manager._hco_test_turn = 0
    manager._hco_test_session_store = SimpleNamespace(
        lookup_by_session_id=lambda session_id: (
            SimpleNamespace(session_key=manager._hco_test_session_keys[session_id])
            if session_id in manager._hco_test_session_keys
            else None
        )
    )
    manager._hco_test_gateway = SimpleNamespace(
        _session_key_for_source=lambda source: (
            f"{source.profile}:zulip:{source.chat_id}:{source.user_id}"
        ),
        _is_user_authorized=lambda _source: True,
    )
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


def _natural_tool_handler(manager: PluginManager, semantic_source: _CountingLlm):
    async def invoke(capability: str):
        if isinstance(semantic_source.parsed, BaseException):
            semantic_source.calls.append({"semantic": semantic_source.parsed})
            return "Hermes model unavailable."
        result = await _call_hco_tool(manager, capability, semantic_source.parsed)
        if result != "Codex bridge request rejected.":
            semantic_source.calls.append({"semantic": semantic_source.parsed})
        return result

    return invoke


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
    manager._hco_test_semantic_source = llm
    return manager, snapshot_path, llm


def _invoke(manager: PluginManager, event) -> dict:
    results = manager.invoke_hook(
        "pre_gateway_dispatch",
        event=event,
        gateway=manager._hco_test_gateway,
        session_store=manager._hco_test_session_store,
    )
    assert len(results) == 1
    result = results[0]
    if (
        result == {"action": "allow"}
        and getattr(event, "channel_prompt", "").startswith(
            "Hermes Codex bridge context."
        )
    ):
        _assert_semantic_channel_prompt(event)
        capability = _pending_capability(manager, event)
        payload = _token_payload(capability)
        manager._hco_test_requests[payload["messageSha256"]] = event.text
        result = _HookResult(result, capability)
    return result


def _invoke_with_runtime(manager: PluginManager, event, gateway, session_store) -> dict:
    results = manager.invoke_hook(
        "pre_gateway_dispatch",
        event=event,
        gateway=gateway,
        session_store=session_store,
    )
    assert len(results) == 1
    result = results[0]
    if (
        result == {"action": "allow"}
        and getattr(event, "channel_prompt", "").startswith(
            "Hermes Codex bridge context."
        )
    ):
        _assert_semantic_channel_prompt(event)
        result = _HookResult(result, _pending_capability(manager, event))
    return result


def _pre_tool_block(
    manager: PluginManager,
    capability: str,
    session_id: str,
    turn_id: str,
    semantic: dict | None = None,
):
    semantic = _dispatch() if semantic is None else semantic
    args = {"semantic": semantic}
    now = _plugin_globals(manager)["_now_seconds"]()
    bound = _pending_vault(manager).bound_entry(session_id, turn_id, now)
    if bound is not None and bound[1].context_token != capability:
        args["capability"] = capability
    results = manager.invoke_hook(
        "pre_tool_call",
        tool_name="hco_dispatch",
        args=args,
        session_id=session_id,
        turn_id=turn_id,
        tool_call_id=f"tool-{turn_id}",
        task_id=f"task-{turn_id}",
        api_request_id=f"api-{turn_id}",
    )
    for result in results:
        if isinstance(result, dict) and result.get("action") == "block":
            return result.get("message")
    return None


def _bind_turn(
    manager: PluginManager,
    *,
    session_id: str,
    turn_id: str,
    user_message: str,
    message_id: int | str | None,
) -> None:
    tokens = set_session_vars(message_id="" if message_id is None else str(message_id))
    try:
        manager.invoke_hook(
            "pre_llm_call",
            session_id=session_id,
            turn_id=turn_id,
            user_message=user_message,
        )
    finally:
        clear_session_vars(tokens)


async def _call_hco_tool(manager: PluginManager, capability: str, semantic: dict):
    try:
        payload = _token_payload(capability)
    except (TypeError, ValueError):
        manager._hco_test_turn += 1
        turn_id = f"test-turn-{manager._hco_test_turn}"
        session_id = "invalid-capability-session"
        block = _pre_tool_block(manager, capability, session_id, turn_id)
        if block is not None:
            return block
        return await _dispatch_tool_entry().handler(
            {"semantic": semantic},
            session_id=session_id,
        )
    binding = payload["binding"]
    session_key = (
        f"codex-bridge:zulip:{binding['streamId']}:{binding['topic']}:"
        "person@example.com"
    )
    session_id = f"session-{binding['streamId']}-{binding['topic']}"
    manager._hco_test_session_keys[session_id] = session_key
    manager._hco_test_turn += 1
    turn_id = f"test-turn-{manager._hco_test_turn}"
    request = manager._hco_test_requests.get(payload.get("messageSha256"), "")
    _bind_turn(
        manager,
        session_id=session_id,
        turn_id=turn_id,
        user_message=request,
        message_id=binding["sourceMessageId"],
    )
    vault = _pending_vault(manager)
    bound = vault.bound_entry(
        session_id, turn_id, _plugin_globals(manager)["_now_seconds"]()
    )
    if bound is not None and bound[1].context_token != capability:
        vault._entries[bound[0]] = replace(bound[1], context_token=capability)
    block = _pre_tool_block(manager, capability, session_id, turn_id, semantic)
    if block is not None:
        manager.invoke_hook(
            "post_llm_call", session_id=session_id, turn_id=turn_id
        )
        return block
    try:
        return await _dispatch_tool_entry().handler(
            {"semantic": semantic},
            session_id=session_id,
        )
    finally:
        manager.invoke_hook(
            "post_llm_call", session_id=session_id, turn_id=turn_id
        )


class _HookResult(dict):
    def __init__(self, value: dict, capability: str):
        super().__init__(value)
        self.capability = capability


def _token_from_rewrite(result: dict) -> str:
    prefix = "/hermes-codex-bridge-internal "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    return result["text"][len(prefix) :]


def _nlp_token_from_rewrite(result: dict) -> str:
    if isinstance(result, _HookResult):
        assert result == {"action": "allow"}
        return result.capability
    prefix = "/hermes-codex-bridge-natural "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    return result["text"][len(prefix) :]


def _assert_semantic_channel_prompt(event) -> None:
    prompt = getattr(event, "channel_prompt", None)
    # BUG-2 L2: channel_prompt now includes project context; check key phrases
    assert isinstance(prompt, str)
    assert prompt.startswith("Hermes Codex bridge context.")
    assert "call hco_dispatch exactly once" in prompt
    assert "For ordinary conversation, answer normally without" in prompt


def _pending_vault(manager: PluginManager):
    hook = manager._hooks["pre_gateway_dispatch"][0]
    return inspect.getclosurevars(hook).nonlocals["pending_vault"]


def _pending_capability(manager: PluginManager, event) -> str:
    message_id = int(event.message_id)
    matches = [
        entry.context_token
        for entry in _pending_vault(manager)._entries.values()
        if entry.context.provenance.message_id == message_id
    ]
    assert len(matches) == 1
    return matches[0]


def _dispatch_tool_entry():
    from tools.registry import registry

    entry = registry.get_entry("hco_dispatch")
    assert entry is not None
    return entry


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
    assert loaded.hooks_registered == [
        "pre_gateway_dispatch",
        "pre_llm_call",
        "pre_tool_call",
        "post_llm_call",
    ]
    assert set(loaded.commands_registered) == {
        "codex",
        "hermes-codex-bridge-internal",
        "hermes-codex-bridge-registration",
        "hermes-codex-bridge-route-unavailable",
    }
    assert loaded.tools_registered == ["hco_dispatch"]
    entry = _dispatch_tool_entry()
    assert entry.is_async is True
    assert entry.return_direct is True
    assert entry.schema["name"] == "hco_dispatch"
    assert entry.schema["parameters"] == {
        "type": "object",
        "additionalProperties": False,
        "required": ["semantic"],
        "properties": {
            "semantic": _plugin_globals(manager)["SEMANTIC_SCHEMA"],
        },
    }


def test_project_prompt_never_exposes_internal_capability(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event("ship the requested change")

    assert _invoke(manager, event) == {"action": "allow"}
    assert event.source.profile == "codex-bridge"
    assert "hco_capability" not in event.channel_prompt
    assert "capability" not in event.channel_prompt.lower()
    assert "ship the requested change" not in event.channel_prompt


def test_model_supplied_capability_is_rejected_as_an_extra_tool_field(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event("ship it")
    assert _invoke(manager, event) == {"action": "allow"}
    manager._hco_test_session_keys["session-a"] = (
        "codex-bridge:zulip:42:Build:person@example.com"
    )
    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="ship it",
        message_id=99,
    )

    results = manager.invoke_hook(
        "pre_tool_call",
        tool_name="hco_dispatch",
        args={"capability": "model-controlled", "semantic": _dispatch()},
        session_id="session-a",
        turn_id="turn-a",
        tool_call_id="tool-a",
        task_id="task-a",
        api_request_id="api-a",
    )

    assert any(
        result == {
            "action": "block",
            "message": "Codex bridge request rejected.",
        }
        for result in results
    )


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

    original_text = project.text
    assert _invoke(manager, project) == {"action": "allow"}
    assert project.text == original_text
    _assert_semantic_channel_prompt(project)
    assert project.source.profile == "codex-bridge"
    assert _invoke(manager, hermes) == {"action": "allow"}
    assert hermes.source.profile == "hermes-general"
    assert _invoke(manager, unknown) == {"action": "allow"}
    assert unknown.source.profile == "hermes-general"
    assert "不要根据话题名称或消息内容猜测 projectId" in unknown.channel_prompt
    assert "canonical 绝对工作目录" in unknown.channel_prompt
    assert "当前数字 stream" in unknown.channel_prompt
    assert "objectiveId" in unknown.channel_prompt
    assert "alpha" not in unknown.channel_prompt


@pytest.mark.asyncio
async def test_unmapped_stream_explicit_project_command_returns_registration_template_without_hco(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event("/codex run inspect this project", stream_id=44)

    result = _invoke(manager, event)

    assert result == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-registration",
    }
    assert event.source.profile == "hermes-general"
    handler = manager._plugin_commands["hermes-codex-bridge-registration"]["handler"]
    visible = await handler("")
    assert "当前频道尚未登记 Codex 项目" in visible
    assert "projectId" in visible
    assert "canonical 绝对工作目录" in visible
    assert "当前数字 stream" in visible
    assert "objectiveId" in visible


def test_project_natural_language_does_not_access_plugin_llm(
    tmp_path: Path, monkeypatch
) -> None:
    def reject_llm_access(_self):
        raise AssertionError("project natural-language registration accessed ctx.llm")

    monkeypatch.setattr(PluginContext, "llm", property(reject_llm_access))
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event("introduce yourself")

    assert _invoke(manager, event) == {"action": "allow"}
    assert event.text == "introduce yourself"
    assert event.source.profile == "codex-bridge"
    assert "introduce yourself" not in event.channel_prompt
    _assert_semantic_channel_prompt(event)


@pytest.mark.asyncio
async def test_dispatch_tool_submits_exact_trusted_event(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    semantic = {
        "type": "DISPATCH",
        "instruction": "ship it",
        "constraints": ["keep compatibility"],
        "acceptanceCriteria": ["tests pass"],
        "reminders": [],
        "objective": {"mode": "CONTINUE", "objectiveId": "obj-1"},
    }
    event = _event("please ship it")
    invoked = _invoke(manager, event)
    assert invoked == {"action": "allow"}
    capability = _nlp_token_from_rewrite(invoked)
    submissions = []

    async def submit(_self, submitted):
        submissions.append(submitted)
        return {"accepted": True, "objectiveId": "obj-1"}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    result = await _call_hco_tool(manager, capability, semantic)

    assert result == "Codex 请求已提交。任务：obj-1。"
    assert len(submissions) == 1
    submitted = submissions[0]
    assert submitted == {
        "schemaVersion": 1,
        "kind": "SEMANTIC",
        "contextToken": capability,
        "binding": {
            "streamId": 42,
            "topic": "Build",
            "sourceMessageId": 99,
            "senderId": 17,
        },
        "semantic": {**semantic, "topicModeAction": None},
    }
    payload = _token_payload(submitted["contextToken"])
    assert payload["projectId"] == "alpha"
    assert payload["topicMode"] == "AUTO"


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
            "/codex thread bind objective-1 thread-1",
            {
                "type": "THREAD_BIND",
                "objectiveId": "objective-1",
                "threadId": "thread-1",
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
        "/codex thread bind",
        "/codex thread bind objective-only",
        "/codex thread bind objective-1 thread-1 extra",
        "/codex thread  bind objective-1 thread-1",
        "/codex thread bind objective-1\tthread-1",
        "/codex thread bind  objective-1 thread-1",
        "/codex thread bind objective-1 thread-1 ",
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
    assert await pending == "Codex 请求已提交。任务：obj-1。"
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
async def test_backend_unavailable_is_rendered_as_actionable_text_not_json(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    async def submit(_self, _event):
        return {
            "schemaVersion": 1,
            "status": "backend_unavailable",
            "action": "dispatch",
            "projectId": "stockprofits",
            "objectiveId": "objective-24cf35e8",
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _token_from_rewrite(
        _invoke(manager, _event("/codex run install latest SpecCompass"))
    )
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    visible = await handler(token)

    assert "stockprofits" in visible
    assert "Codex 后端暂时不可用" in visible
    assert "本次任务未执行" in visible
    assert "objective-24cf35e8" in visible
    assert "{" not in visible


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (
            {
                "schemaVersion": 1,
                "status": "ok",
                "action": "topic.show",
                "projectId": "stockprofits",
                "mode": "CODEX_BOUND",
                "objectiveId": "objective-1",
            },
            "当前话题模式：CODEX_BOUND。项目：stockprofits。任务：objective-1。",
        ),
        (
            {
                "schemaVersion": 1,
                "status": "ok",
                "action": "topic.set",
                "mode": "HERMES_ONLY",
            },
            "话题模式已更新：HERMES_ONLY。",
        ),
        (
            {
                "schemaVersion": 1,
                "status": "ok",
                "action": "objective.status",
                "projectId": "stockprofits",
                "objectiveId": "objective-1",
                "executionStatus": "running",
                "backend": "app-server",
                "threadId": "thread-1",
            },
            (
                "任务：objective-1。项目：stockprofits。状态：running。"
                "后端：app-server。会话：thread-1。"
            ),
        ),
        (
            {
                "schemaVersion": 1,
                "status": "started",
                "action": "objective.thread.bind",
                "projectId": "stockprofits",
                "objectiveId": "objective-1",
                "threadId": "thread-recovered",
                "turnId": "turn-recovered",
                "duplicate": False,
            },
            (
                "Codex 会话绑定完成。项目：stockprofits。任务：objective-1。"
                "会话：thread-recovered。状态：started。轮次：turn-recovered。"
            ),
        ),
        (
            {
                "schemaVersion": 1,
                "status": "cancelled",
                "action": "objective.cancel",
                "projectId": "stockprofits",
                "objectiveId": "objective-1",
                "turnId": "turn-1",
            },
            "任务取消状态：cancelled。项目：stockprofits。任务：objective-1。轮次：turn-1。",
        ),
        (
            {
                "schemaVersion": 1,
                "status": "answered",
                "action": "interaction.answer",
                "projectId": "stockprofits",
                "objectiveId": "objective-1",
                "interactionId": "interaction-1",
            },
            (
                "交互回复状态：answered。项目：stockprofits。任务：objective-1。"
                "交互：interaction-1。"
            ),
        ),
    ],
)
def test_bridge_result_renderer_preserves_management_command_details(
    tmp_path: Path, monkeypatch, result: dict, expected: str
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    assert _plugin_globals(manager)["_render_bridge_result"](result) == expected


def test_bridge_result_renderer_rejects_unknown_future_action_without_reflection(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )
    result = {
        "schemaVersion": 1,
        "status": "ok",
        "action": "future.inspect",
        "importantField": "must-survive",
        "token": "must-not-leak",
    }

    visible = _plugin_globals(manager)["_render_bridge_result"](result)

    assert visible == (
        "Codex 返回了当前插件不支持的操作结果；"
        "详细内容未显示，请检查插件与 HCO 版本。"
    )
    assert "future.inspect" not in visible
    assert "must-survive" not in visible
    assert "must-not-leak" not in visible


@pytest.mark.parametrize(
    "result",
    [
        {
            "schemaVersion": 1,
            "status": "private-dispatch-status",
            "action": "dispatch",
            "projectId": "stockprofits",
            "objectiveId": "objective-1",
        },
        {
            "schemaVersion": 1,
            "status": "private-cancel-status",
            "action": "objective.cancel",
            "projectId": "stockprofits",
            "objectiveId": "objective-1",
        },
        {
            "schemaVersion": 1,
            "status": "private-answer-status",
            "action": "interaction.answer",
            "projectId": "stockprofits",
            "objectiveId": "objective-1",
            "interactionId": "interaction-1",
        },
        {
            "schemaVersion": 1,
            "status": "ok",
            "action": "objective.status",
            "projectId": "stockprofits",
            "objectiveId": "objective-1",
            "executionStatus": "private-execution-status",
            "backend": "app-server",
            "threadId": "thread-1",
        },
    ],
)
def test_bridge_result_renderer_rejects_unknown_status_without_reflection(
    tmp_path: Path, monkeypatch, result: dict
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    visible = _plugin_globals(manager)["_render_bridge_result"](result)

    assert visible == (
        "Codex 返回了当前插件不支持的操作结果；"
        "详细内容未显示，请检查插件与 HCO 版本。"
    )
    reflected_status = result.get("executionStatus", result["status"])
    assert reflected_status not in visible


@pytest.mark.asyncio
async def test_natural_route_query_uses_signed_route_show_without_llm(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )
    submitted = []

    async def submit(_self, event):
        submitted.append(event)
        return {
            "schemaVersion": 1,
            "status": "ok",
            "action": "route.show",
            "route": {
                "streamId": 42,
                "owner": "PROJECT",
                "projectId": "stockprofits",
                "source": "static",
                "cwd": "/Users/hula/Projects/stockprofits",
            },
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _token_from_rewrite(
        _invoke(manager, _event("请汇报当前工作文件夹。当前projectid。"))
    )
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    visible = await handler(token)

    assert llm.calls == []
    assert submitted[0]["command"] == {"type": "ROUTE", "action": "SHOW"}
    assert "stockprofits" in visible
    assert "/Users/hula/Projects/stockprofits" in visible
    assert "本次仅核验项目路由，未执行项目工作区进度扫描" in visible


@pytest.mark.asyncio
async def test_project_context_progress_query_uses_trusted_route_without_llm(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )
    submitted = []

    async def submit(_self, event):
        submitted.append(event)
        return {
            "schemaVersion": 1,
            "status": "ok",
            "action": "route.show",
            "route": {
                "streamId": 42,
                "owner": "PROJECT",
                "projectId": "stockprofits",
                "source": "static",
                "cwd": "/Users/hula/Projects/stockprofits",
            },
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    result = _invoke(
        manager,
        _event("请回复当前 projectId、工作目录，并用一句话汇报项目进度。"),
    )
    token = _token_from_rewrite(result)
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    visible = await handler(token)

    assert llm.calls == []
    assert submitted[0]["command"] == {"type": "ROUTE", "action": "SHOW"}
    assert "stockprofits" in visible
    assert "/Users/hula/Projects/stockprofits" in visible
    assert "本次仅核验项目路由，未执行项目工作区进度扫描" in visible


@pytest.mark.parametrize(
    "query",
    [
        "请告诉我当前项目的 projectid。",
        "projectid",
        "current project id?",
    ],
)
def test_project_id_metadata_query_stays_with_hermes_without_llm(
    tmp_path: Path, monkeypatch, query: str
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    result = _invoke(manager, _event(query))

    assert _token_from_rewrite(result)
    assert llm.calls == []


@pytest.mark.asyncio
async def test_live_route_query_echoes_bounded_marker_without_llm(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    async def submit(_self, _event):
        return {
            "schemaVersion": 1,
            "status": "ok",
            "action": "route.show",
            "route": {
                "streamId": 42,
                "owner": "PROJECT",
                "projectId": "stockprofits",
                "source": "static",
                "cwd": "/Users/hula/Projects/stockprofits",
            },
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _token_from_rewrite(
        _invoke(
            manager,
            _event(
                "请回复当前 projectId、工作目录，并用一句话汇报项目进度。"
                "回显 LIVE-POSTFIX.S-001。"
            ),
        )
    )
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]

    visible = await handler(token)

    assert llm.calls == []
    assert visible == (
        "当前项目：stockprofits。工作目录：/Users/hula/Projects/stockprofits。"
        "项目进度：本次仅核验项目路由，未执行项目工作区进度扫描。"
        "回显：LIVE-POSTFIX.S-001。"
    )


@pytest.mark.asyncio
async def test_route_query_without_marker_preserves_existing_reply(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="ASK")]),
    )

    async def submit(_self, _event):
        return {
            "schemaVersion": 1,
            "status": "ok",
            "action": "route.show",
            "route": {
                "streamId": 42,
                "owner": "PROJECT",
                "projectId": "ASK",
                "source": "static",
                "cwd": "/Users/hula/workspace/ASK",
            },
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _token_from_rewrite(
        _invoke(
            manager,
            _event("请回复当前 projectId、工作目录，并用一句话汇报项目进度。"),
        )
    )
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]

    visible = await handler(token)

    assert visible == (
        "当前项目：ASK。工作目录：/Users/hula/workspace/ASK。"
        "项目进度：本次仅核验项目路由，未执行项目工作区进度扫描。"
    )


@pytest.mark.parametrize(
    "query",
    [
        "回显 LIVE-ONLY-001。",
        "请回复当前 projectId、工作目录，并执行交易。回显 LIVE-WORK-001。",
        "请回复当前 projectId、工作目录。回显 LIVE-001。回显 LIVE-002。",
    ],
)
def test_marker_cannot_expand_trusted_route_query_whitelist(
    tmp_path: Path, monkeypatch, query: str
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    result = _invoke(manager, _event(query))

    assert result == {"action": "allow"}
    assert hasattr(result, "capability")


def test_project_progress_only_query_does_not_require_model_capability(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    result = _invoke(
        manager,
        _event("请用一句话汇报当前项目进度，并回显测试编号 BURST-003。"),
    )

    token = _token_from_rewrite(result)
    assert token
    assert llm.calls == []


@pytest.mark.parametrize(
    "query",
    [
        "请回复当前 projectId、工作目录，并用一句话汇报项目进度。回显 POSTFIX-S-001。",
        "请回复当前 projectId、工作目录，并回显 POSTFIX-SAME-003。",
        "请用一句话汇报当前项目进度，并回显 POSTFIX-A-BURST-002。",
    ],
)
def test_live_route_query_variants_do_not_require_model_capability(
    tmp_path: Path, monkeypatch, query: str
) -> None:
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        RuntimeError("model must not run"),
        _snapshot([_route(42, "PROJECT", project_id="stockprofits")]),
    )

    result = _invoke(manager, _event(query))

    token = _token_from_rewrite(result)
    assert token
    assert llm.calls == []


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
    assert await handler(token) == "Codex 请求已提交。"
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
        assert await handler(token) == "Codex 请求已提交。"
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

    async def user_error(_self, _event):
        raise globals_["BridgeUserError"](
            "INTERACTION_DECISION_INVALID",
            "Invalid decision 'acceppt'. Valid choices: accept, decline.",
        )

    monkeypatch.setattr(globals_["BridgeClient"], "submit", user_error)
    third = _token_from_rewrite(
        _invoke(manager, _event("/codex approve reply-1 acceppt", message_id=102))
    )
    result = await handler(third)
    assert "Valid choices: accept, decline." in result
    assert "protocol error" not in result


def test_bridge_client_preserves_known_user_error_response(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    bridge_client_module = inspect.getmodule(globals_["BridgeClient"])
    body = json.dumps(
        {
            "error": {
                "code": "INTERACTION_DECISION_INVALID",
                "message": "Invalid decision 'acceppt'. Valid choices: accept, decline.",
            }
        }
    ).encode()
    response = (
        b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )

    with pytest.raises(Exception) as raised:
        bridge_client_module._parse_response(response)

    assert type(raised.value).__name__ == "BridgeUserError"
    assert str(raised.value) == "Invalid decision 'acceppt'. Valid choices: accept, decline."


def test_bridge_client_rejects_known_user_error_code_from_server_error(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    bridge_client_module = inspect.getmodule(globals_["BridgeClient"])
    body = json.dumps(
        {
            "error": {
                "code": "INTERACTION_DECISION_INVALID",
                "message": "internal decision failure",
            }
        }
    ).encode()
    response = (
        b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )

    with pytest.raises(Exception) as raised:
        bridge_client_module._parse_response(response)

    assert type(raised.value).__name__ == "BridgeProtocolError"
    assert str(raised.value) == "bridge rejected request"


@pytest.mark.asyncio
async def test_private_handler_surfaces_user_errors_through_real_bridge(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    handler = manager._plugin_commands["hermes-codex-bridge-internal"]["handler"]
    client = inspect.getclosurevars(handler).nonlocals["client"]
    socket_path = Path("/tmp") / f"hco-fifth-pass-{time.time_ns()}.sock"
    client.socket_path = str(socket_path)
    token_path = Path(os.environ["HCO_CONFIG_PATH"])
    token_path = Path(json.loads(token_path.read_text())["bridge"]["tokenPath"])
    script = """
import { createBridge } from './hco/bridge/server.js';
import { stateError } from './hco/state/reducer.js';
const [socketPath, tokenPath] = process.argv.slice(1);
const store = { claimOutbox() {}, ackOutbox() {}, nackOutbox() {} };
const bridge = createBridge({
  store,
  tokenPath,
  async eventHandler(event) {
    if (event.command.type === 'APPROVE') {
      throw stateError('INTERACTION_DECISION_INVALID', "Invalid decision 'acceppt'. Valid choices: accept, decline.");
    }
    throw stateError('INTERACTION_COMMAND_MISMATCH', "Cannot use /codex answer on an approval interaction.");
  }
});
const running = await bridge.start({ socketPath });
console.log('READY');
const close = async () => { await running.close(); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);
await new Promise(() => {});
"""
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", script, str(socket_path), str(token_path)],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "READY"
        approve = _token_from_rewrite(
            _invoke(manager, _event("/codex approve reply-1 acceppt", message_id=103))
        )
        answer = _token_from_rewrite(
            _invoke(manager, _event("/codex answer reply-1 no", message_id=104))
        )

        approve_result = await handler(approve)
        answer_result = await handler(answer)

        assert "Valid choices: accept, decline." in approve_result
        assert "protocol error" not in approve_result
        assert answer_result == "Cannot use /codex answer on an approval interaction."
    finally:
        process.terminate()
        process.wait(timeout=5)
        socket_path.unlink(missing_ok=True)


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
    handler = _natural_tool_handler(manager, llm)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    result = await handler(token)

    assert result == "Codex 请求已提交。任务：obj-1。"
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
    assert submitted["semantic"] == {**semantic, "topicModeAction": None}
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
    handler = _natural_tool_handler(manager, llm)

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
    }
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot(
            [
                _route(42, "PROJECT", project_id="alpha")
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
    handler = _natural_tool_handler(manager, llm)

    assert await handler(token) == "Codex bridge protocol error."
    assert await handler(token) == "Codex bridge request rejected."
    assert len(llm.calls) == 1
    assert len(calls) == 1
    assert calls[0]["semantic"] == {**semantic, "topicModeAction": None}


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
    handler = _natural_tool_handler(manager, llm)

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

    assert results == ["Codex 请求已提交。", "Codex 请求已提交。"]
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

    event = _event()
    results = manager.invoke_hook(
        "pre_gateway_dispatch",
        event=event,
        gateway=manager._hco_test_gateway,
        session_store=manager._hco_test_session_store,
    )

    assert results[0] == {"action": "allow"}
    _assert_semantic_channel_prompt(event)
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


def test_project_hook_promotes_verified_event_message_id_to_empty_source(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _adapter_event("natural work request", 600)

    assert event.source.message_id is None
    assert _invoke(manager, event) == {"action": "allow"}
    assert event.source.message_id == "600"


def test_general_hook_leaves_empty_source_message_id_unchanged(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "HERMES")]),
    )
    event = _adapter_event("ordinary conversation", 600)

    assert event.source.message_id is None
    assert manager.invoke_hook(
        "pre_gateway_dispatch",
        event=event,
        gateway=manager._hco_test_gateway,
        session_store=manager._hco_test_session_store,
    ) == [{"action": "allow"}]
    assert event.source.profile == "hermes-general"
    assert event.source.message_id is None


def test_project_hook_fails_closed_when_empty_source_message_id_is_read_only(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _adapter_event("natural work request", 601)

    class ReadOnlySource:
        platform = Platform.ZULIP
        chat_id = "42:Build"
        chat_type = "stream"
        chat_topic = "Build"
        user_id = "person@example.com"

        @property
        def message_id(self):
            return None

        @message_id.setter
        def message_id(self, _value):
            raise AttributeError("message_id is read-only")

    event.source = ReadOnlySource()

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-route-unavailable",
    }


async def _dispatch_through_real_gateway(manager, monkeypatch, event):
    import hermes_cli.plugins as plugin_module
    from gateway.run import GatewayRunner

    monkeypatch.setattr(plugin_module, "_plugin_manager", manager)
    runner = object.__new__(GatewayRunner)
    runner.config = {}
    runner.session_store = manager._hco_test_session_store
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
    runner._session_key_for_source = manager._hco_test_gateway._session_key_for_source
    runner._check_slash_access = lambda _source, _command: None
    runner._is_telegram_topic_root_lobby = lambda _source: False
    runner._claim_active_session_slot = lambda _key, _source: (None, None)
    runner._persist_active_agents = lambda: None
    runner._begin_session_run_generation = lambda _key: 1
    runner._restore_moa_one_shot = lambda _event, _key: None
    runner._release_running_agent_state = lambda _key: None
    agent_entries = []

    async def run_through_agent(agent_event, *_args, **_kwargs):
        agent_entries.append("ordinary-agent")
        semantic_source = manager._hco_test_semantic_source
        _assert_semantic_channel_prompt(agent_event)
        capability = _pending_capability(manager, agent_event)
        payload = _token_payload(capability)
        manager._hco_test_requests[payload["messageSha256"]] = agent_event.text
        return await _natural_tool_handler(manager, semantic_source)(capability)

    runner._handle_message_with_agent = run_through_agent
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
    assert agent_entries == ["ordinary-agent"]


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
        results = manager.invoke_hook(
            "pre_gateway_dispatch",
            event=event,
            gateway=manager._hco_test_gateway,
            session_store=manager._hco_test_session_store,
        )
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


def _dispatch(*, objective=None) -> dict:
    return {
        "type": "DISPATCH",
        "instruction": "ship it",
        "constraints": ["keep compatibility"],
        "acceptanceCriteria": ["tests pass"],
        "reminders": [],
        "objective": objective,
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
        (_dispatch(objective=None), None, "Codex 请求已提交。", 1),
        (
            {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO"},
            None,
            "Codex 请求已提交。",
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
            # BUG-3: improved message for BridgeUnavailableError in hco_dispatch_handler
            "Codex bridge 响应异常，任务可能已提交但响应丢失。请稍后用 `/codex status` 查询状态，如任务未出现请重新发起。",
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
async def test_real_gateway_enters_agent_then_contains_every_natural_result(
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

    gateway_event = _adapter_event(request, 600)
    result, agent_entries = await _dispatch_through_real_gateway(
        manager, monkeypatch, gateway_event
    )

    assert result == visible
    assert len(llm.calls) == 1
    assert llm.calls[0]["semantic"] is semantic
    assert gateway_event.text == request
    assert request not in gateway_event.channel_prompt
    assert len(submissions) == hco_calls
    assert agent_entries == ["ordinary-agent"]
    if submissions:
        assert submissions[0]["kind"] == "SEMANTIC"
        assert submissions[0]["binding"]["senderId"] == 17
        expected_semantic = (
            {**semantic, "topicModeAction": None}
            if semantic["type"] == "DISPATCH"
            else semantic
        )
        assert submissions[0]["semantic"] == expected_semantic
        assert "topicModeAction" not in semantic


@pytest.mark.asyncio
async def test_natural_capability_is_consumed_before_first_await_and_never_restored(
    tmp_path: Path, monkeypatch
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    manager, _, llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        entered.set()
        await release.wait()
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event()))
    handler = _natural_tool_handler(manager, llm)
    pending = asyncio.create_task(handler(token))
    await asyncio.wait_for(entered.wait(), timeout=2)

    assert await handler(token) == "Codex bridge request rejected."
    assert llm.calls == []
    release.set()
    assert await pending == "Codex 请求已提交。"
    assert await handler(token) == "Codex bridge request rejected."
    assert len(llm.calls) == 1
    assert len(submissions) == 1


def _lifecycle_runtime(session_keys: dict[str, str]):
    entries = {
        session_id: SimpleNamespace(session_key=session_key)
        for session_id, session_key in session_keys.items()
    }
    session_store = SimpleNamespace(
        lookup_by_session_id=lambda session_id: entries.get(session_id)
    )
    gateway = SimpleNamespace(
        _session_key_for_source=lambda source: (
            f"{source.profile}:zulip:{source.chat_id}:{source.user_id}"
        )
    )
    return gateway, session_store


def test_natural_capability_rejects_runtime_session_store_replacement(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    session_key = "codex-bridge:zulip:42:Build:person@example.com"
    gateway_a, session_store_a = _lifecycle_runtime({"session-a": session_key})
    gateway_b, session_store_b = _lifecycle_runtime({"session-b": session_key})

    first = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager,
            _event(message_id=991),
            gateway_a,
            session_store_a,
        )
    )
    assert _invoke_with_runtime(
        manager,
        _event(message_id=992),
        gateway_b,
        session_store_b,
    ) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-route-unavailable",
    }

    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="natural work request",
        message_id=991,
    )
    assert _pre_tool_block(manager, first, "session-a", "turn-a") is None


@pytest.mark.asyncio
async def test_natural_capability_succeeds_only_in_its_bound_turn(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    session_key = "codex-bridge:zulip:42:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime({"session-a": session_key})
    token = _nlp_token_from_rewrite(
        _invoke_with_runtime(manager, _event(), gateway, session_store)
    )

    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="natural work request",
        message_id=99,
    )

    assert _pre_tool_block(manager, token, "session-a", "turn-b") == (
        "Codex bridge request rejected."
    )
    assert _pre_tool_block(manager, token, "session-a", "turn-a") is None
    result = await _dispatch_tool_entry().handler(
        {"semantic": _dispatch()}, session_id="session-a"
    )
    assert "任务可能已提交但响应丢失" in result  # BUG-3: improved unavailable message


@pytest.mark.asyncio
async def test_post_llm_revokes_only_the_exact_unused_turn_capability(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot(
            [
                _route(42, "PROJECT", project_id="alpha"),
                _route(43, "PROJECT", project_id="beta"),
            ]
        ),
    )
    key_a = "codex-bridge:zulip:42:Build:person@example.com"
    key_b = "codex-bridge:zulip:43:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime(
        {"session-a": key_a, "session-b": key_b}
    )
    token_a = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(stream_id=42, message_id=501), gateway, session_store
        )
    )
    token_b = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(stream_id=43, message_id=502), gateway, session_store
        )
    )
    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="natural work request",
        message_id=501,
    )
    _bind_turn(
        manager,
        session_id="session-b",
        turn_id="turn-b",
        user_message="natural work request",
        message_id=502,
    )

    manager.invoke_hook(
        "post_llm_call", session_id="session-a", turn_id="turn-a"
    )

    assert _pre_tool_block(manager, token_a, "session-a", "turn-a") == (
        "Codex bridge request rejected."
    )
    assert _pre_tool_block(manager, token_b, "session-b", "turn-b") is None
    assert _pre_tool_block(manager, token_b, "session-a", "turn-a") == (
        "Codex bridge request rejected."
    )


def test_concurrent_session_capabilities_remain_isolated(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot(
            [
                _route(42, "PROJECT", project_id="alpha"),
                _route(43, "PROJECT", project_id="beta"),
            ]
        ),
    )
    key_a = "codex-bridge:zulip:42:Build:person@example.com"
    key_b = "codex-bridge:zulip:43:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime(
        {"session-a": key_a, "session-b": key_b}
    )
    token_a = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(stream_id=42, message_id=601), gateway, session_store
        )
    )
    token_b = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(stream_id=43, message_id=602), gateway, session_store
        )
    )
    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="natural work request",
        message_id=601,
    )
    _bind_turn(
        manager,
        session_id="session-b",
        turn_id="turn-b",
        user_message="natural work request",
        message_id=602,
    )

    assert _pre_tool_block(manager, token_a, "session-a", "turn-a") is None
    assert _pre_tool_block(manager, token_b, "session-b", "turn-b") is None
    assert _pre_tool_block(manager, token_a, "session-b", "turn-b") == (
        "Codex bridge request rejected."
    )
    assert _pre_tool_block(manager, token_b, "session-a", "turn-a") == (
        "Codex bridge request rejected."
    )


def test_orphan_capability_cannot_bind_a_later_identical_message(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    session_key = "codex-bridge:zulip:42:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime({"session-a": session_key})
    orphan = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(message_id=701), gateway, session_store
        )
    )
    current = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(message_id=702), gateway, session_store
        )
    )

    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-current",
        user_message="natural work request",
        message_id=702,
    )

    assert _pre_tool_block(manager, orphan, "session-a", "turn-current") == (
        "Codex bridge request rejected."
    )
    assert _pre_tool_block(manager, current, "session-a", "turn-current") is None


@pytest.mark.asyncio
async def test_identical_fifo_messages_bind_by_their_own_message_ids(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    session_key = "codex-bridge:zulip:42:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime({"session-a": session_key})
    first = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(message_id=801), gateway, session_store
        )
    )
    second = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(message_id=802), gateway, session_store
        )
    )

    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-first",
        user_message="natural work request",
        message_id=801,
    )
    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-second",
        user_message="natural work request",
        message_id=802,
    )

    semantic = _dispatch()
    assert _pre_tool_block(
        manager, first, "session-a", "turn-first", semantic
    ) is None
    result = await _dispatch_tool_entry().handler(
        {"semantic": semantic}, session_id="session-a"
    )
    assert "任务可能已提交但响应丢失" in result  # BUG-3: improved unavailable message
    assert _pre_tool_block(manager, second, "session-a", "turn-second") is None


def test_natural_capability_fails_closed_without_gateway_message_id(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    session_key = "codex-bridge:zulip:42:Build:person@example.com"
    gateway, session_store = _lifecycle_runtime({"session-a": session_key})
    token = _nlp_token_from_rewrite(
        _invoke_with_runtime(
            manager, _event(message_id=901), gateway, session_store
        )
    )

    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-missing-message-id",
        user_message="natural work request",
        message_id=None,
    )

    assert _pre_tool_block(
        manager, token, "session-a", "turn-missing-message-id"
    ) == "Codex bridge request rejected."


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
    handler = _natural_tool_handler(manager, llm)
    globals_ = _plugin_globals(manager)

    direct_event = _event("/hermes-codex-bridge-natural attacker")
    assert _invoke(manager, direct_event) == {"action": "allow"}
    assert not hasattr(direct_event, "channel_prompt")
    assert "hermes-codex-bridge-natural" not in manager._plugin_commands
    assert await handler("invalid") == "Codex bridge request rejected."

    for offset, (field, value) in enumerate(
        (
            ("projectId", "other"),
            ("topicMode", "HERMES_ONLY"),
            ("messageSha256", "0" * 64),
            ("messageBytes", 999),
        )
    ):
        token = _nlp_token_from_rewrite(
            _invoke(manager, _event(message_id=100 + offset))
        )
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
    handler = _natural_tool_handler(manager, llm)

    assert await handler(token) == "Hermes model protocol error."
    assert len(llm.calls) == 1
    assert submissions == []


@pytest.mark.asyncio
async def test_hermes_only_dispatch_stays_blocked_but_explicit_control_reaches_hco(
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
    handler = _natural_tool_handler(manager, llm)

    plain = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=301)))
    assert await handler(plain) == "Codex bridge request rejected."
    assert submissions == []

    llm.parsed = {"type": "CONTROL", "action": "SET_TOPIC_MODE", "mode": "AUTO"}
    control = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=302)))
    assert await handler(control) == "Codex 请求已提交。"
    assert len(submissions) == 1
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_dispatch_instruction_referencing_foreign_project_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    """BUG-2 L1: DISPATCH semantic whose instruction text names a different project
    must be rejected before reaching HCO, with a clear conflict warning."""
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    contaminated_dispatch = {
        "type": "DISPATCH",
        "instruction": "请在当前 beta 仓库中执行任务。",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
    }
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, contaminated_dispatch, snapshot)

    # Inject project_cwd_map into the live closure via dict mutation (captured by reference)
    hook = manager._hooks["pre_gateway_dispatch"][0]
    cwd_map = inspect.getclosurevars(hook).nonlocals["project_cwd_map"]
    cwd_map.update({"alpha": ("/workspace/alpha", None), "beta": ("/workspace/beta", None)})

    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=501)))
    result = await _call_hco_tool(manager, token, contaminated_dispatch)

    # Must reject without calling HCO
    assert submissions == [], "contaminated instruction must not reach HCO"
    assert "指令上下文冲突" in result, f"expected conflict warning, got: {result!r}"
    assert "alpha" in result
    assert "beta" in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "foreign_reference"),
    [
        ("instruction", "Fix beta's failing tests."),
        ("instruction", "Work on beta and update its CI."),
        ("instruction", "修复 beta 的测试。"),
        ("instruction", "debug beta"),
        ("instruction", "请在 beta 仓库中执行"),
        ("instruction", "请切换到 beta 执行"),
        ("instruction", "请在 beta 中执行"),
        ("instruction", "检查 beta 的仓库"),
        ("instruction", "use beta for this task"),
        ("instruction", "switch to beta"),
        ("constraints", "必须在 beta 仓库中操作"),
        ("acceptanceCriteria", "结果必须来自 beta project"),
        ("reminders", "不要离开 beta repo"),
        ("instruction", "使用 /workspace/beta"),
        ("constraints", "禁止修改 /workspace/beta"),
        ("acceptanceCriteria", "检查 /workspace/beta 的输出"),
        ("reminders", "工作目录是 /workspace/beta"),
    ],
)
async def test_dispatch_foreign_project_reference_in_any_text_field_is_rejected(
    tmp_path: Path, monkeypatch, field: str, foreign_reference: str
) -> None:
    semantic = {
        "type": "DISPATCH",
        "instruction": "执行当前项目任务",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
    }
    if field == "instruction":
        semantic[field] = foreign_reference
    else:
        semantic[field] = [foreign_reference]
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    cwd_map = inspect.getclosurevars(hook).nonlocals["project_cwd_map"]
    cwd_map.update({"alpha": ("/workspace/alpha", None), "beta": ("/workspace/beta", None)})
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=503)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result
    assert field in result
    assert "beta" in result


@pytest.mark.asyncio
async def test_dispatch_ask_common_english_does_not_false_positive(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "Ask the user before changing the API."}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {"alpha": ("/workspace/alpha", None), "ASK": ("/workspace/ASK", None)}
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=504)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "instruction",
    [
        "repositoryASK is a local identifier.",
        "Do not ask for approval.",
        "Use /workspace/alpha for this task.",
        "Fix alpha's tests.",
        "Inspect /workspace/beta-staging only.",
        "Inspect /workspace/beta_prod only.",
        "Inspect /workspace/beta.backup only.",
    ],
)
async def test_dispatch_project_and_cwd_boundaries_do_not_false_positive(
    tmp_path: Path, monkeypatch, instruction: str
) -> None:
    semantic = {**_dispatch(), "instruction": instruction}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {
            "a": ("/workspace/a", None),
            "alpha": ("/workspace/alpha", None),
            "beta": ("/workspace/beta", None),
            "ASK": ("/workspace/ASK", None),
        }
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=506)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_dispatch_exact_foreign_cwd_boundary_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "在 /workspace/beta 中执行"}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {"alpha": ("/workspace/alpha", None), "beta": ("/workspace/beta", None)}
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=507)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result


@pytest.mark.asyncio
async def test_dispatch_foreign_cwd_subpath_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {
        **_dispatch(),
        "instruction": "Edit /workspace/beta/src/main.py to fix the bug.",
    }
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {"alpha": ("/workspace/alpha", None), "beta": ("/workspace/beta", None)}
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=801)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result


@pytest.mark.asyncio
async def test_dispatch_normalizes_configured_cwd_and_ignores_root(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {
        **_dispatch(),
        "instruction": "Edit /workspace/beta/src/main.py to fix the bug.",
    }
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    config_path = tmp_path / "cwd-map.json"
    _write_private(
        config_path,
        json.dumps(
            {
                "projects": [
                    {"projectId": "alpha", "cwd": "/workspace/alpha"},
                    {"projectId": "beta", "cwd": "/workspace/beta/"},
                    {"projectId": "root", "cwd": "/"},
                ]
            }
        ).encode(),
    )
    loaded = globals_["_load_project_cwd_map"](str(config_path))
    assert loaded == {
        "alpha": ("/workspace/alpha", None),
        "beta": ("/workspace/beta", None),
        "root": (None, None),
    }
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(loaded)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=802)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result


@pytest.mark.asyncio
async def test_dispatch_resolves_symlinked_project_cwd_before_conflict_check(
    tmp_path: Path, monkeypatch
) -> None:
    canonical_beta = tmp_path / "canonical" / "beta"
    canonical_beta.mkdir(parents=True)
    symlink_beta = tmp_path / "symlink_beta"
    symlink_beta.symlink_to(canonical_beta, target_is_directory=True)
    semantic = {
        **_dispatch(),
        "instruction": f"Edit {canonical_beta / 'src' / 'main.py'} to fix the bug.",
    }
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    config_path = tmp_path / "cwd-map-symlink.json"
    _write_private(
        config_path,
        json.dumps(
            {
                "projects": [
                    {"projectId": "alpha", "cwd": str(tmp_path / "alpha")},
                    {"projectId": "beta", "cwd": str(symlink_beta)},
                ]
            }
        ).encode(),
    )
    loaded = globals_["_load_project_cwd_map"](str(config_path))
    assert loaded["beta"] == (str(symlink_beta), str(canonical_beta))
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(loaded)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=803)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result


@pytest.mark.asyncio
async def test_dispatch_rejects_configured_symlink_alias_subpath(
    tmp_path: Path, monkeypatch
) -> None:
    canonical_beta = tmp_path / "canonical-alias" / "beta"
    canonical_beta.mkdir(parents=True)
    symlink_beta = tmp_path / "beta-alias"
    symlink_beta.symlink_to(canonical_beta, target_is_directory=True)
    semantic = {
        **_dispatch(),
        "instruction": f"Edit {symlink_beta / 'src' / 'main.py'} to fix the bug.",
    }
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    config_path = tmp_path / "cwd-map-alias.json"
    _write_private(
        config_path,
        json.dumps(
            {
                "projects": [
                    {"projectId": "alpha", "cwd": str(tmp_path / "alpha")},
                    {"projectId": "beta", "cwd": str(symlink_beta)},
                ]
            }
        ).encode(),
    )
    loaded = globals_["_load_project_cwd_map"](str(config_path))
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(loaded)
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=804)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("instruction", "blocked"),
    [
        ("Fix root's failing tests.", True),
        ("Inspect /anywhere/path without naming another project.", False),
    ],
)
async def test_root_project_keeps_identity_without_matching_all_paths(
    tmp_path: Path, monkeypatch, instruction: str, blocked: bool
) -> None:
    semantic = {**_dispatch(), "instruction": instruction}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {"alpha": ("/workspace/alpha", None), "root": (None, None)}
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=805 if blocked else 806)))
    result = await _call_hco_tool(manager, token, semantic)

    assert (submissions == []) is blocked
    assert ("指令上下文冲突" in result) is blocked


@pytest.mark.asyncio
async def test_dispatch_explicit_ask_project_reference_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "请在 ASK 仓库中执行"}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    hook = manager._hooks["pre_gateway_dispatch"][0]
    inspect.getclosurevars(hook).nonlocals["project_cwd_map"].update(
        {"alpha": ("/workspace/alpha", None), "ASK": ("/workspace/ASK", None)}
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=505)))
    result = await _call_hco_tool(manager, token, semantic)

    assert submissions == []
    assert "指令上下文冲突" in result
    assert "ASK" in result


def test_safe_question_id_rejects_whitespace_and_accepts_simple_ids(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    is_safe = _plugin_globals(manager)["_is_safe_question_id"]

    assert is_safe(" q1") is False
    assert is_safe("\u00a0q1") is False
    assert is_safe("\ufeffq1") is False
    assert is_safe("\u0085q1") is False
    assert is_safe("  ") is False
    assert is_safe("q1") is True


def test_safe_question_id_rejects_node_special_chars(
    tmp_path: Path, monkeypatch
) -> None:
    """_is_safe_question_id must reject the same chars as Node isSafeCliToken."""
    manager, _ = _load_manager(tmp_path, monkeypatch)
    is_safe = _plugin_globals(manager)["_is_safe_question_id"]

    # Each character Node rejects that is not whitespace/control
    for ch in '`"\'<>[]{}()|;\\/':
        assert is_safe(f"q{ch}1") is False, f"expected rejection for char {ch!r}"

    # Normal alphanumeric IDs and hyphens/underscores/dots are allowed
    assert is_safe("q1") is True
    assert is_safe("question-id_1.2") is True


def test_project_reference_detection_handles_boundaries_verbs_and_short_names(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    mentions = _plugin_globals(manager)["_mentions_project_id"]

    assert mentions("Please handle beta failures", "beta") is True
    assert mentions("Please investigate beta failures", "beta") is True
    assert mentions("请处理 beta 中的失败", "beta") is True
    assert mentions("fix api", "api") is True
    assert mentions("run test", "test") is True
    assert mentions("debug test", "test") is True
    assert mentions("work in foo.bar", "foo") is False


@pytest.mark.asyncio
async def test_partial_answer_renders_missing_question_ids(
    tmp_path: Path, monkeypatch
) -> None:
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    dispatch = _dispatch()
    manager, _, _llm = _load_manager_with_llm(
        tmp_path, monkeypatch, dispatch, snapshot
    )

    async def submit(_self, event):
        return {
            "schemaVersion": 1,
            "status": "partial",
            "action": "interaction.answer",
            "projectId": "alpha",
            "objectiveId": "objective-1",
            "interactionId": "interaction-1",
            "missingQuestionIds": ["q2", "q3"],
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=901)))
    result = await _call_hco_tool(manager, token, dispatch)

    assert "已记录部分回答" in result
    assert "q2" in result
    assert "q3" in result
    assert "/codex answer" in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing, expected",
    [
        (["q2", "bad\nvalue"], None),
        (["q2", 7], None),
        (["q1\ninjected"], None),
        ([7], None),
    ],
)
async def test_partial_answer_filters_unsafe_missing_question_ids(
    tmp_path: Path, monkeypatch, missing, expected
) -> None:
    manager, _, _llm = _load_manager_with_llm(
        tmp_path, monkeypatch, _dispatch(), _snapshot([_route(42, "PROJECT", project_id="alpha")])
    )

    async def submit(_self, event):
        return {
            "schemaVersion": 1,
            "status": "partial",
            "action": "interaction.answer",
            "projectId": "alpha",
            "objectiveId": "objective-1",
            "interactionId": "interaction-1",
            "missingQuestionIds": missing,
        }

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=902)))
    result = await _call_hco_tool(manager, token, _dispatch())

    if expected is None:
        assert result == "Codex bridge protocol error."
    else:
        assert expected in result


@pytest.mark.asyncio
async def test_dispatch_continue_bridge_unavailable_includes_objective_id(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {
        **_dispatch(objective={"mode": "CONTINUE", "objectiveId": "objective-123"}),
        "instruction": "继续任务",
    }
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )

    async def submit(_self, _event):
        raise _plugin_globals(manager)["BridgeUnavailableError"]("offline")

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=506)))
    result = await _call_hco_tool(manager, token, semantic)

    assert "任务可能已提交但响应丢失" in result
    assert "objective-123" in result


@pytest.mark.asyncio
async def test_dispatch_instruction_with_own_project_name_is_accepted(
    tmp_path: Path, monkeypatch
) -> None:
    """BUG-2 L1: DISPATCH semantic whose instruction mentions the trusted project
    must not be rejected (no false positive)."""
    snapshot = _snapshot([_route(42, "PROJECT", project_id="alpha")])
    clean_dispatch = {
        "type": "DISPATCH",
        "instruction": "请在当前 alpha 项目中执行任务。",
        "constraints": [],
        "acceptanceCriteria": [],
        "reminders": [],
        "objective": None,
    }
    manager, _, llm = _load_manager_with_llm(tmp_path, monkeypatch, clean_dispatch, snapshot)

    # Inject project_cwd_map: alpha→beta conflict only triggered for foreign names
    hook = manager._hooks["pre_gateway_dispatch"][0]
    cwd_map = inspect.getclosurevars(hook).nonlocals["project_cwd_map"]
    cwd_map.update({"alpha": ("/workspace/alpha", None), "beta": ("/workspace/beta", None)})

    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=502)))
    result = await _call_hco_tool(manager, token, clean_dispatch)

    # Must reach HCO normally — no false positive on own project name
    assert len(submissions) == 1, "clean instruction must reach HCO"
    assert "指令上下文冲突" not in result


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

    _nlp_token_from_rewrite(_invoke(manager, _event(sender_id=17, message_id=401)))
    assert _invoke(manager, _event(sender_id=17, message_id=402)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    _nlp_token_from_rewrite(_invoke(manager, _event(sender_id=18, message_id=403)))
    assert _invoke(manager, _event(sender_id=19, message_id=404)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }

    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 91)
    _nlp_token_from_rewrite(_invoke(manager, _event(sender_id=19, message_id=405)))


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
    handler = _natural_tool_handler(manager, llm)

    expected = "Codex 请求已提交。" if accepted else "Codex bridge request rejected."
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
    _nlp_token_from_rewrite(_invoke(manager, _event("a", sender_id=17, message_id=800)))
    _nlp_token_from_rewrite(_invoke(manager, _event("b", sender_id=17, message_id=801)))
    assert _invoke(manager, _event("c", sender_id=17, message_id=802)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
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
        _nlp_token_from_rewrite(
            _invoke(manager, _event("a", sender_id=sender_id, message_id=message_id))
        )
    assert _invoke(manager, _event("a", sender_id=19, message_id=812)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }

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
        _nlp_token_from_rewrite(
            _invoke(manager, _event("界", sender_id=sender_id, message_id=message_id))
        )
    assert _invoke(manager, _event("a", sender_id=19, message_id=822)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }

    manager, _, llm = _load_manager_with_llm(
        tmp_path / "cleanup",
        monkeypatch,
        _dispatch(),
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "MAX_PENDING_ENTRIES", 1)
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now)
    _nlp_token_from_rewrite(_invoke(manager, _event("a", message_id=830)))
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 90)
    assert _invoke(manager, _event("b", message_id=831)) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    monkeypatch.setitem(globals_, "_now_seconds", lambda: now + 91)
    _nlp_token_from_rewrite(_invoke(manager, _event("c", message_id=832)))
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
    assert exact_agent_entries == ["ordinary-agent"]
    assert plus_agent_entries == ["ordinary-agent"]
    if exact_submits:
        assert exact_result == "Codex 请求已提交。"
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
    assert agent_entries == ["ordinary-agent"]


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
    assert agent_entries == ["ordinary-agent"]


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
    assert agent_entries == ["ordinary-agent"]
