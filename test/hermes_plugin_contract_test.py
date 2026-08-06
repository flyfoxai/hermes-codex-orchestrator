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
import threading
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
SAFE_CALL_ID = re.compile(r"call-[A-Za-z0-9_-]{24}")


def test_contract_process_isolates_hermes_state_before_plugin_discovery() -> None:
    process_home = Path(os.environ["HOME"]).resolve()
    hermes_home = Path(os.environ["HERMES_HOME"]).resolve()

    assert Path(os.environ["HCO_PYTEST_ISOLATED_HOME"]).resolve() == hermes_home
    assert hermes_home.parent == process_home


def test_zulip_default_addressee_normalization_is_exact_and_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    normalize = globals_["_normalize_zulip_addressee"]
    targets_bot = globals_["_zulip_default_targets_bot"]

    assert normalize(" @**Jarvis PM** ") == "Jarvis PM"
    assert normalize("@jarvis@example.invalid") == "jarvis@example.invalid"
    assert targets_bot(
        "Jarvis PM",
        bot_full_name="Jarvis PM",
        bot_email="jarvis@example.invalid",
        bot_user_id=9,
    ) is True
    assert targets_bot(
        "9",
        bot_full_name="Jarvis PM",
        bot_email="jarvis@example.invalid",
        bot_user_id=9,
    ) is True
    assert targets_bot(
        "none",
        bot_full_name="Jarvis PM",
        bot_email="jarvis@example.invalid",
        bot_user_id=9,
    ) is False
    with pytest.raises(ValueError, match="default_addressee"):
        normalize("\n")
    with pytest.raises(ValueError, match="default_addressee"):
        normalize("x" * 321)


@pytest.mark.asyncio
async def test_zulip_stream_default_addressee_does_not_append_jarvis_to_mentions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _load_manager(tmp_path, monkeypatch)
    import gateway.platforms.zulip as zulip_module
    import gateway.platforms.base as base_module

    adapter_type = zulip_module.ZulipAdapter
    upstream_adapter = adapter_type.__mro__[1]
    forwarded = []

    async def capture(_self, message, raw_event):
        forwarded.append((message, raw_event))

    monkeypatch.setattr(upstream_adapter, "_dispatch_inbound", capture)

    def adapter(default_addressee: str = "self", *, policy: bool = True):
        value = adapter_type(
            PlatformConfig(
                enabled=True,
                api_key="fixture-key",
                extra={
                    "site_url": "https://zulip.example.invalid",
                    "bot_email": "jarvis@example.invalid",
                    "require_mention": False,
                    "free_response_streams": ["every-stream"],
                    "default_addressee": default_addressee,
                    "default_addressee_policy": policy,
                },
            )
        )
        value._bot_full_name = "Jarvis PM"
        value._bot_user_id = 9
        return value

    async def dispatch(value, content: str, **message_overrides):
        message = {
            "type": "stream",
            "stream_id": 5,
            "subject": "框架安装",
            "content": content,
            **message_overrides,
        }
        raw_event = {"message": dict(message)}
        before = dict(message)
        await value._dispatch_inbound(message, raw_event)
        assert message == before

    current = adapter()
    await dispatch(current, "无 mention 的普通要求")
    assert forwarded[-1][0]["content"] == "@**Jarvis PM** 无 mention 的普通要求"

    forwarded.clear()
    await dispatch(current, "@**Alice** 请检查")
    await dispatch(current, "@*maintainers* 请检查")
    assert forwarded == []

    await dispatch(current, "@**Alice** @**Jarvis PM** 请共同检查")
    assert forwarded[-1][0]["content"] == "@**Alice** @**Jarvis PM** 请共同检查"

    forwarded.clear()
    await dispatch(current, "@**all** 请检查")
    assert forwarded[-1][0]["content"] == "@**all** 请检查"

    forwarded.clear()
    await dispatch(current, "由 Zulip flag 标记", flags=["mentioned"])
    assert forwarded[-1][0]["content"] == "由 Zulip flag 标记"

    forwarded.clear()
    await dispatch(adapter("Alice"), "无 mention 的普通要求")
    assert forwarded == []

    direct = {
        "type": "private",
        "content": "@**Alice** 供参考",
    }
    raw_direct = {"message": dict(direct)}
    await current._dispatch_inbound(direct, raw_direct)
    assert forwarded[-1] == (direct, raw_direct)

    forwarded.clear()
    await dispatch(adapter(policy=False), "@**Alice** 外部 bot 保持 Hermes 原规则")
    assert forwarded[-1][0]["content"] == "@**Alice** 外部 bot 保持 Hermes 原规则"


def test_explicit_choice_collection_requires_native_clarify(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    requires_clarify = _plugin_globals(manager)["_requires_native_clarify"]

    assert requires_clarify(
        "我需要收集一个选择。请让我在“替换为 0.11.29”“保留当前版本”“取消”三个选项中选择。"
    )
    assert requires_clarify("请从以下选项中选择一个：A、B、C")
    assert not requires_clarify("请分析并选择最合适的实现方案。")
    assert not requires_clarify("你觉得下一步应该怎么做？")


def test_gateway_transport_binding_preserves_logical_profile_and_is_not_forgeable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    bind_transport = _plugin_globals(manager)["_bind_gateway_transport_profile"]
    ingress_adapter = SimpleNamespace(
        on_processing_complete=lambda _event, _outcome: None
    )
    seen_profiles = []

    class Gateway:
        def _adapter_for_source(self, source):
            seen_profiles.append(source.profile)
            return ingress_adapter if source.profile == "zulip-ingress" else None

    gateway = Gateway()
    source = SimpleNamespace(platform="zulip", profile="codex-bridge")

    assert bind_transport(gateway, source) is True
    first_wrapper = gateway._adapter_for_source
    assert source.profile == "codex-bridge"
    assert gateway._adapter_for_source(source) is ingress_adapter
    assert seen_profiles == ["zulip-ingress"]

    assert bind_transport(gateway, source) is True
    assert gateway._adapter_for_source is first_wrapper
    assert gateway._adapter_for_source(source) is ingress_adapter

    forged = SimpleNamespace(
        platform="zulip",
        profile="codex-bridge",
        _hco_transport_profile="zulip-ingress",
        _hco_transport_binding=object(),
    )
    assert gateway._adapter_for_source(forged) is None
    assert bind_transport(
        gateway, SimpleNamespace(platform="telegram", profile="codex-bridge")
    ) is False


@pytest.mark.asyncio
async def test_bound_gateway_delivers_native_clarify_choices_through_ingress_adapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    bind_transport = _plugin_globals(manager)["_bind_gateway_transport_profile"]
    calls = []

    class ZulipIngressAdapter:
        async def on_processing_complete(self, _event, _outcome):
            return None

        async def send_clarify(self, **kwargs):
            calls.append(kwargs)
            return SendResult(success=True, message_id="9001")

    ingress_adapter = ZulipIngressAdapter()

    class Gateway:
        def _adapter_for_source(self, source):
            return ingress_adapter if source.profile == "zulip-ingress" else None

    gateway = Gateway()
    source = SimpleNamespace(platform=Platform.ZULIP, profile="codex-bridge")
    choices = ["替换为 0.11.29", "保留当前版本", "取消"]

    assert bind_transport(gateway, source) is True
    status_adapter = gateway._adapter_for_source(source)
    assert status_adapter is ingress_adapter
    result = await status_adapter.send_clarify(
        chat_id="5:框架安装",
        question="请选择 SpecCompass 版本处理方式",
        choices=choices,
        clarify_id="clarify-contract",
        session_key="codex-bridge:zulip:5:框架安装:boss@example.com",
        metadata={"topic": "框架安装"},
    )

    assert result.success is True
    assert calls[0]["choices"] == choices
    assert source.profile == "codex-bridge"


def _write_private(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def _install_fixture(tmp_path: Path, monkeypatch) -> tuple[PluginManager, Path, Path]:
    home = tmp_path / "hermes-home"
    installed = home / "plugins" / "hermes-codex-bridge"
    installed.parent.mkdir(parents=True)
    home.chmod(0o700)
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
    fake_adapter = SimpleNamespace(
        on_processing_complete=lambda _event, _outcome: None
    )
    manager._hco_test_gateway = SimpleNamespace(
        _session_key_for_source=lambda source: (
            f"{source.profile}:zulip:{source.chat_id}:{source.user_id}"
        ),
        _is_user_authorized=lambda _source: True,
        _adapter_for_source=lambda source: (
            fake_adapter if source.profile == "zulip-ingress" else None
        ),
    )
    return manager, snapshot_path


def _zulip_adapter_config() -> PlatformConfig:
    return PlatformConfig(
        enabled=True,
        api_key="fixture-key",
        extra={
            "site_url": "https://zulip.example.invalid",
            "bot_email": "jarvis@example.invalid",
            "require_mention": False,
            "free_response_streams": [],
            "default_addressee": "self",
            "default_addressee_policy": False,
        },
    )


def test_zulip_source_profile_is_routed_before_active_session_key_is_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, snapshot_path = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([
            _route(42, "PROJECT", project_id="alpha"),
            _route(43, "HERMES"),
        ]),
    )
    import gateway.platforms.base as base_module
    import gateway.platforms.zulip as zulip_module

    adapter = zulip_module.ZulipAdapter(_zulip_adapter_config())
    adapter.gateway_runner = SimpleNamespace(
        _profile_name_for_source=lambda _source: "zulip-ingress"
    )

    project = adapter.build_source(
        chat_id="42:Build", chat_type="stream", chat_topic="Build", user_id="boss"
    )
    general = adapter.build_source(
        chat_id="43:Chat", chat_type="stream", chat_topic="Chat", user_id="boss"
    )
    unmapped = adapter.build_source(
        chat_id="44:Other", chat_type="stream", chat_topic="Other", user_id="boss"
    )

    assert base_module.build_session_key(project) == "agent:codex-bridge:zulip:stream:42:Build:boss"
    assert base_module.build_session_key(general) == "agent:hermes-general:zulip:stream:43:Chat:boss"
    assert base_module.build_session_key(unmapped) == "agent:hermes-general:zulip:stream:44:Other:boss"

    snapshot_path.write_text("invalid", encoding="utf-8")
    unavailable = adapter.build_source(
        chat_id="42:Build", chat_type="stream", chat_topic="Build", user_id="boss"
    )
    assert unavailable.profile == "zulip-ingress"
    assert base_module.build_session_key(unavailable) == "agent:main:zulip:stream:42:Build:boss"


@pytest.mark.asyncio
async def test_zulip_clarify_zform_uses_choice_text_without_changing_other_widgets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _load_manager(tmp_path, monkeypatch)
    import gateway.platforms.zulip as zulip_module

    adapter_type = zulip_module.ZulipAdapter
    upstream_adapter = adapter_type.__mro__[1]
    sent = []

    async def capture(_self, **kwargs):
        sent.append(kwargs)
        return SendResult(success=True, message_id="9002")

    monkeypatch.setattr(upstream_adapter, "_send_zform_choices", capture)
    adapter = adapter_type(_zulip_adapter_config())
    clarify = [
        {"short_name": "1", "long_name": "选项 A", "reply": "选项 A"},
        {"short_name": "2", "long_name": "选项 B", "reply": "选项 B"},
        {"short_name": "3", "long_name": "取消", "reply": "取消"},
    ]
    approval = [
        {"short_name": "Approve", "long_name": "Approve once", "reply": "/approve"}
    ]

    await adapter._send_zform_choices("42:Build", "body", "heading", clarify)
    await adapter._send_zform_choices("42:Build", "body", "heading", approval)

    assert [choice["short_name"] for choice in sent[0]["choices"]] == [
        "选项 A", "选项 B", "取消"
    ]
    assert sent[1]["choices"] == approval


@pytest.mark.asyncio
async def test_zulip_clarify_reply_uses_same_logical_session_and_deletes_prompt_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    import gateway.platforms.base as base_module
    import gateway.platforms.zulip as zulip_module
    from tools import clarify_gateway

    adapter_type = zulip_module.ZulipAdapter
    upstream_adapter = adapter_type.__mro__[1]
    prompts = []

    async def send_prompt(_self, **kwargs):
        prompts.append(kwargs)
        return SendResult(success=True, message_id="9003")

    monkeypatch.setattr(upstream_adapter, "_send_zform_choices", send_prompt)
    adapter = adapter_type(_zulip_adapter_config())
    adapter.gateway_runner = SimpleNamespace(
        _profile_name_for_source=lambda _source: "zulip-ingress"
    )
    deleted = []

    async def delete_prompt(*, chat_id, message_id):
        deleted.append((chat_id, message_id))
        return True

    monkeypatch.setattr(adapter, "delete_message", delete_prompt)
    original = adapter.build_source(
        chat_id="42:Build", chat_type="stream", chat_topic="Build", user_id="boss"
    )
    reply = adapter.build_source(
        chat_id="42:Build", chat_type="stream", chat_topic="Build", user_id="boss"
    )
    original_key = base_module.build_session_key(original)
    reply_key = base_module.build_session_key(reply)
    assert original_key == reply_key
    assert ":codex-bridge:zulip:" in original_key

    clarify_id = "clarify-full-chain"
    clarify_gateway.register(
        clarify_id=clarify_id,
        session_key=original_key,
        question="请选择一个测试选项。",
        choices=["选项 A", "选项 B", "取消"],
    )
    try:
        sent = await adapter.send_clarify(
            chat_id="42:Build",
            question="请选择一个测试选项。",
            choices=["选项 A", "选项 B", "取消"],
            clarify_id=clarify_id,
            session_key=original_key,
        )
        assert sent.success is True
        replies = [choice["reply"] for choice in prompts[0]["choices"]]
        assert replies == [
            "选项 A\n\n[hermes-clarify:clarify-full-chain:1]",
            "选项 B\n\n[hermes-clarify:clarify-full-chain:2]",
            "取消\n\n[hermes-clarify:clarify-full-chain:3]",
        ]
        first = clarify_gateway.resolve_choice_reply_for_session(reply_key, replies[0])
        second = clarify_gateway.resolve_choice_reply_for_session(reply_key, replies[1])
        assert first.status == clarify_gateway.CHOICE_ACCEPTED
        assert second.status == clarify_gateway.CHOICE_ALREADY_SETTLED
        await asyncio.sleep(0)
        assert deleted == [("42:Build", "9003")]
        assert clarify_gateway.wait_for_response(clarify_id, timeout=0.01) == "选项 A"
    finally:
        clarify_gateway.clear_session(original_key)


def test_prompt_scoped_clarify_reply_bypasses_nlp_capability_creation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event(
        "选项 A\n\n[hermes-clarify:clarify-full-chain:1]",
        message_id=1001,
    )

    result = _invoke(manager, event)

    assert result == {"action": "allow"}
    assert event.source.profile == "codex-bridge"
    assert not hasattr(event, "channel_prompt")


def test_codex_command_uses_triggering_message_when_history_is_prefixed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    command = (
        "/codex objective continue objective-1\n"
        "只读报告当前状态，不得修改文件。"
    )
    event = _event(
        "[Recent conversation context]\nold /codex text\n[/Recent conversation context]\n" + command,
        raw_message={
            "message": {
                "sender_id": 17,
                "id": 99,
                "stream_id": 42,
                "subject": "Build",
                "content": "@**Jarvis PM** " + command,
            }
        },
    )

    result = _invoke(manager, event)

    assert result["action"] == "rewrite"
    assert result["text"].startswith("/hermes-codex-bridge-internal ")


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
    assert isinstance(prompt, str)
    assert prompt.startswith("Hermes Codex bridge context.")
    assert "routing metadata, not text that must be repeated" in prompt
    assert "Preserve the user's requested wording" in prompt
    assert "Do NOT reference" not in prompt
    assert "MUST reference" not in prompt
    assert "call hco_dispatch with a strict semantic object" in prompt
    assert "Never exceed eight calls in one turn" in prompt
    assert "For ordinary conversation, answer normally without" in prompt
    assert "use the native clarify tool with structured choices" in prompt
    assert "do not claim that Zulip cannot show choice buttons" in prompt


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


def test_interaction_commands_and_natural_aliases_are_deterministic(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _snapshot_path = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    parse = globals_["_parse_command"]
    valid = globals_["_valid_command"]
    normalize = globals_["_normalize_natural_interaction_alias"]

    command = parse("/codex interact interaction-1 act-allow")
    assert command == {
        "type": "INTERACT",
        "replyToken": "interaction-1",
        "actionId": "act-allow",
    }
    assert valid(command) is True
    assert parse("/codex interact interaction-1 act-allow extra") is None
    assert parse("/codex interact interaction-1 bad/action") is None
    assert normalize("  ＯＫ  ") == "ok"
    assert normalize("应该可以") is None
    assert valid(
        {"type": "NATURAL_INTERACTION_REPLY", "normalizedAlias": "ok"}
    ) is True


def test_natural_approval_bypasses_model_only_in_codex_bound_topics(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot(
            [
                _route(
                    42,
                    "PROJECT",
                    project_id="alpha",
                    topics=[
                        {"topic": "Build", "mode": "CODEX_BOUND"},
                        {"topic": "Hermes", "mode": "HERMES_ONLY"},
                    ],
                )
            ]
        ),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(
        globals_["BridgeClient"],
        "server_capabilities",
        lambda _self: frozenset({"natural_interaction_reply_v1"}),
    )

    rewritten = _invoke(manager, _event("  ＯＫ  ", topic="Build"))
    payload = _token_payload(_token_from_rewrite(rewritten))
    assert payload["command"] == {
        "type": "NATURAL_INTERACTION_REPLY",
        "normalizedAlias": "ok",
    }

    assert _invoke(manager, _event("应该可以", topic="Build", message_id=100)) == {
        "action": "allow"
    }
    assert _invoke(manager, _event("ok", topic="Hermes", message_id=101)) == {
        "action": "allow"
    }


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
        "subagent_start",
        "subagent_stop",
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
    assert entry.return_direct is False
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
    tmp_path: Path, monkeypatch, capsys
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
    audit = json.loads(capsys.readouterr().err)
    assert audit == {
        "commandType": "RUN",
        "event": "hermes_codex_bridge.local_route_decision",
        "resultCode": "ROUTE_UNMAPPED_REGISTRATION",
        "schemaVersion": 1,
        "senderId": 17,
        "sourceMessageId": 99,
        "streamId": 44,
        "timestampMs": audit["timestampMs"],
        "topicBytes": len("Build".encode()),
        "topicSha256": hashlib.sha256(b"Build").hexdigest(),
    }
    assert type(audit["timestampMs"]) is int
    serialized = json.dumps(audit, ensure_ascii=False)
    assert "inspect this project" not in serialized
    assert "canonical" not in serialized


def test_unmapped_registration_fails_closed_when_local_audit_cannot_be_written(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    monkeypatch.setitem(
        _plugin_globals(manager),
        "_write_local_route_audit",
        lambda *_args: False,
    )
    event = _event("/codex run inspect this project", stream_id=44)

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    assert event.source.profile == "codex-bridge"


def test_local_route_audit_retries_short_writes(tmp_path: Path, monkeypatch) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    real_write = os.write
    writes = []

    def short_write(descriptor: int, data: bytes) -> int:
        writes.append(len(data))
        return real_write(descriptor, data[: max(1, len(data) // 2)])

    monkeypatch.setattr(globals_["os"], "write", short_write)
    event = _event("/codex run inspect this project", stream_id=44)

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": "/hermes-codex-bridge-registration",
    }
    audit_path = tmp_path / "hermes-home" / "hermes-codex-bridge-route-audit.jsonl"
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    assert audit["sourceMessageId"] == 99
    assert audit["resultCode"] == "ROUTE_UNMAPPED_REGISTRATION"
    assert len(writes) > 1


def test_local_route_audit_size_limit_fails_closed(tmp_path: Path, monkeypatch) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "MAX_ROUTE_AUDIT_BYTES", 1)
    event = _event("/codex run inspect this project", stream_id=44)

    assert _invoke(manager, event) == {
        "action": "rewrite",
        "text": ROUTE_UNAVAILABLE_COMMAND,
    }
    assert event.source.profile == "codex-bridge"


@pytest.mark.parametrize(
    ("text", "expected_command"),
    [
        ("/codex route show", {"type": "ROUTE", "action": "SHOW"}),
        (
            "/codex route set alpha",
            {"type": "ROUTE", "action": "SET", "projectId": "alpha"},
        ),
        ("/codex route none", {"type": "ROUTE", "action": "NONE"}),
        ("/codex route unset", {"type": "ROUTE", "action": "UNSET"}),
    ],
)
def test_unmapped_route_management_commands_are_signed_for_hco_acl(
    tmp_path: Path, monkeypatch, capsys, text: str, expected_command: dict
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event(text, stream_id=44)

    result = _invoke(manager, event)
    prefix = "/hermes-codex-bridge-internal "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    token = result["text"][len(prefix) :]

    assert _token_payload(token)["command"] == expected_command
    assert event.source.profile == "codex-bridge"
    assert capsys.readouterr().err == ""


def test_explicit_hermes_route_codex_command_is_signed_for_hco(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(43, "HERMES")]),
    )
    event = _event("/codex status", stream_id=43)

    result = _invoke(manager, event)
    prefix = "/hermes-codex-bridge-internal "
    assert result["action"] == "rewrite"
    assert result["text"].startswith(prefix)
    token = result["text"][len(prefix) :]

    assert _token_payload(token)["command"] == {"type": "STATUS"}
    assert event.source.profile == "codex-bridge"


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

    assert result == "Codex 请求已提交。任务：obj-1。执行可能需要数分钟；可用 `/codex status <任务ID>` 查询，未确认失败前请勿重复提交。"
    assert len(submissions) == 1
    submitted = submissions[0]
    assert submitted["caller"] == {
        "invocationOrigin": "JARVIS",
        "callerPrincipalId": "jarvis:session-42-Build",
        "callerHermesSessionId": "session-42-Build",
        "codexCallId": submitted["caller"]["codexCallId"],
        "originalRequest": "please ship it",
    }
    assert SAFE_CALL_ID.fullmatch(submitted["caller"]["codexCallId"])
    assert {key: value for key, value in submitted.items() if key != "caller"} == {
        "schemaVersion": 1,
        "kind": "SEMANTIC",
        "contextToken": submitted["contextToken"],
        "binding": {
            "streamId": 42,
            "topic": "Build",
            "sourceMessageId": 99,
            "senderId": 17,
        },
        "semantic": {**semantic, "topicModeAction": None},
    }
    payload = _token_payload(submitted["contextToken"])
    assert submitted["contextToken"] != capability
    assert payload["purpose"] == "codex-coordination-dispatch"
    assert payload["codexCallId"] == submitted["caller"]["codexCallId"]
    assert payload["binding"] == submitted["binding"]


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
        (
            "/codex run ship it\n并在完成后汇报测试结果",
            {"type": "RUN", "instruction": "ship it\n并在完成后汇报测试结果"},
        ),
        ("/codex status", {"type": "STATUS"}),
        ("/codex status obj-1", {"type": "STATUS", "objectiveId": "obj-1"}),
        (
            "/codex status obj-1 查询当前进度",
            {
                "type": "STATUS",
                "objectiveId": "obj-1",
                "supplementalText": "查询当前进度",
            },
        ),
        (
            "/codex status obj-1\n请告诉我是否正在等待输入",
            {
                "type": "STATUS",
                "objectiveId": "obj-1",
                "supplementalText": "请告诉我是否正在等待输入",
            },
        ),
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
    assert await pending == "Codex 请求已提交。任务：obj-1。执行可能需要数分钟；可用 `/codex status <任务ID>` 查询，未确认失败前请勿重复提交。"
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
                "statusVerified": True,
                "verificationStatus": "running",
            },
            (
                "任务：objective-1。项目：stockprofits。状态：running。"
                "后端：app-server。会话：thread-1。已向执行后端核验当前状态。"
            ),
        ),
        (
            {
                "schemaVersion": 1,
                "status": "ok",
                "action": "objective.status",
                "projectId": "stockprofits",
                "objectiveId": "objective-2",
                "executionStatus": "running",
                "backend": "app-server",
                "threadId": "thread-2",
                "statusVerified": False,
                "verificationStatus": "unavailable",
            },
            (
                "任务：objective-2。项目：stockprofits。状态：running。"
                "后端：app-server。会话：thread-2。当前无法向执行后端确认真实状态；"
                "以上仅为本地缓存，不能据此判断任务仍在执行。"
                "请检查 App Server 连接或稍后重试。"
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
        (
            {
                "schemaVersion": 1,
                "status": "already_answered",
                "action": "interaction.answer",
                "projectId": "stockprofits",
                "objectiveId": "objective-1",
                "interactionId": "interaction-1",
            },
            (
                "该交互已经处理，不会重复执行。项目：stockprofits。"
                "任务：objective-1。交互：interaction-1。"
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
            "statusVerified": True,
            "verificationStatus": "private-verification-status",
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
        _snapshot([_route(42, "PROJECT", project_id="omega")]),
    )

    async def submit(_self, _event):
        return {
            "schemaVersion": 1,
            "status": "ok",
            "action": "route.show",
            "route": {
                "streamId": 42,
                "owner": "PROJECT",
                "projectId": "omega",
                "source": "static",
                "cwd": "/workspace/omega",
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
        "当前项目：omega。工作目录：/workspace/omega。"
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
    unavailable_result = await handler(first)
    assert "请求未提交" in unavailable_result
    assert "稍后重试" in unavailable_result
    assert "可能" not in unavailable_result

    async def uncertain(_self, _event):
        raise globals_["BridgeUncertainError"]("secret response")

    monkeypatch.setattr(globals_["BridgeClient"], "submit", uncertain)
    second = _token_from_rewrite(
        _invoke(manager, _event("/codex status objective-123", message_id=101))
    )
    uncertain_result = await handler(second)
    assert "可能已经写入" in uncertain_result
    assert "查询状态" in uncertain_result
    assert "再重试" in uncertain_result
    assert "请求未提交" not in uncertain_result
    assert "objective-123" in uncertain_result

    async def bad_protocol(_self, _event):
        raise globals_["BridgeProtocolError"]("secret response")

    monkeypatch.setattr(globals_["BridgeClient"], "submit", bad_protocol)
    third = _token_from_rewrite(_invoke(manager, _event("/codex status", message_id=102)))
    assert await handler(third) == "Codex bridge protocol error."

    async def user_error(_self, _event):
        raise globals_["BridgeUserError"](
            "INTERACTION_DECISION_INVALID",
            "Invalid decision 'acceppt'. Valid choices: accept, decline."
            "\x0b*bold*\x0c<tag>\x85bad|value\u2028next\u2029last",
        )

    monkeypatch.setattr(globals_["BridgeClient"], "submit", user_error)
    fourth = _token_from_rewrite(
        _invoke(manager, _event("/codex approve reply-1 acceppt", message_id=103))
    )
    result = await handler(fourth)
    assert "Valid choices: accept, decline." in result
    for separator in ("\x0b", "\x0c", "\x85", "\u2028", "\u2029"):
        assert separator not in result
    assert "&#42;bold&#42;" in result
    assert "&#60;tag&#62;" in result
    assert "bad&#124;value" in result
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
const store = {
  claimOutbox() {},
  ackOutbox() {},
  nackOutbox() {},
  claimCoordinationMailbox() {},
  ackCoordinationMailbox() {},
  reportHermesAgentStop() {}
};
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
        "capabilities": [
            "signed_context",
            "message_binding",
            "nonce_replay",
            "artifact_manifest",
            "project_local_exchange_v1",
            "coordination_mailbox_v1",
            "coordination_recovery_v1",
            "agent_restart_recovery_v1",
            "agent_reports_v1",
        ],
        "event": {"schemaVersion": 1},
    }


@pytest.mark.asyncio
async def test_sync_mailbox_client_claims_exact_call_and_acknowledges_item(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    client_class = _plugin_globals(manager)["BridgeClient"]
    socket_path = Path("/tmp") / f"hco-mailbox-client-{time.time_ns()}.sock"
    requests = []
    item = {
        "mailboxItemId": "mail/1",
        "targetKind": "JARVIS",
        "targetId": "topic-1",
        "workRequestId": "work-1",
        "codexCallId": "call-1",
        "itemType": "CODEX_RECEIPT",
        "semanticKey": "receipt-1",
        "payload": {"text": "verified"},
        "state": "LEASED",
        "attemptCount": 1,
        "leaseOwner": "worker-1",
        "leaseToken": "lease-1",
        "leaseExpiresAt": 1_700_000_060_000,
        "createdAt": 1_700_000_000_000,
        "updatedAt": 1_700_000_000_000,
        "acknowledgedAt": None,
        "lastError": None,
    }

    async def serve(reader, writer):
        header = await reader.readuntil(b"\r\n\r\n")
        content_length = next(
            int(line.split(b":", 1)[1].strip())
            for line in header.split(b"\r\n")
            if line.lower().startswith(b"content-length:")
        )
        body = json.loads(await reader.readexactly(content_length))
        requests.append((header.split(b"\r\n", 1)[0], body))
        response_body = (
            {"result": {"items": [item]}}
            if len(requests) == 1
            else {
                "result": {
                    "duplicate": False,
                    "mailboxItem": item,
                    "workRequest": {"workRequestId": "work-1"},
                }
            }
        )
        response = json.dumps(response_body, separators=(",", ":")).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(response)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + response
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(serve, path=socket_path)
    try:
        client = client_class(str(socket_path), b"bridge-token")
        claimed = await asyncio.to_thread(
            client.claim_mailbox,
            target_kind="JARVIS",
            target_id="topic-1",
            codex_call_id="call-1",
            worker_id="worker-1",
        )
        acknowledged = await asyncio.to_thread(
            client.ack_mailbox,
            mailbox_item_id="mail/1",
            lease_token="lease-1",
            final_delivery=True,
        )
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert claimed == [item]
    assert acknowledged["duplicate"] is False
    assert requests[0][0] == b"POST /v1/mailbox/claim HTTP/1.1"
    assert requests[0][1]["codexCallId"] == "call-1"
    assert requests[0][1]["mailboxItemId"] is None
    assert requests[0][1]["targetId"] == "topic-1"
    assert requests[1][0] == b"POST /v1/mailbox/mail%2F1/ack HTTP/1.1"
    assert requests[1][1]["leaseToken"] == "lease-1"
    assert requests[1][1]["finalDelivery"] is True


@pytest.mark.asyncio
async def test_sync_bridge_client_submits_and_validates_hermes_agent_stop_report(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    client_class = _plugin_globals(manager)["BridgeClient"]
    socket_path = Path("/tmp") / f"hco-agent-report-client-{time.time_ns()}.sock"
    received = {}

    async def serve(reader, writer):
        header = await reader.readuntil(b"\r\n\r\n")
        content_length = next(
            int(line.split(b":", 1)[1].strip())
            for line in header.split(b"\r\n")
            if line.lower().startswith(b"content-length:")
        )
        received["line"] = header.split(b"\r\n", 1)[0]
        received["body"] = json.loads(await reader.readexactly(content_length))
        response = json.dumps(
            {
                "result": {
                    "duplicate": False,
                    "disposition": "REPORTED",
                    "reportId": "report-1",
                    "agentSessionId": "agent-1",
                    "agentActivationId": "activation-1",
                    "activeCodexCalls": 0,
                    "mailboxItemId": "mail-1",
                    "mailboxTarget": {"kind": "JARVIS", "id": "topic-1"},
                }
            },
            separators=(",", ":"),
        ).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(response)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + response
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(serve, path=socket_path)
    try:
        client = client_class(str(socket_path), b"bridge-token")
        result = await asyncio.to_thread(
            client.report_agent_stop,
            source_id="hermes-stop-1",
            child_hermes_session_id="child-1",
            parent_hermes_session_id="parent-1",
            child_status="completed",
            summary="verified",
            duration_ms=1200,
        )
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result["disposition"] == "REPORTED"
    assert received["line"] == b"POST /v1/agents/report HTTP/1.1"
    assert received["body"]["sourceId"] == "hermes-stop-1"
    assert received["body"]["childHermesSessionId"] == "child-1"
    assert received["body"]["parentHermesSessionId"] == "parent-1"
    assert received["body"]["childStatus"] == "completed"
    assert received["body"]["summary"] == "verified"
    assert received["body"]["durationMs"] == 1200


def _agent_report_spool_record() -> dict:
    return {
        "source_id": "hermes-stop-" + "a" * 64,
        "child_hermes_session_id": "child-session",
        "parent_hermes_session_id": "parent-session",
        "child_status": "completed",
        "summary": "Verified durable report",
        "duration_ms": 1200,
    }


def test_agent_report_spool_is_owner_only_atomic_and_restart_readable(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    spool_class = globals_["AgentReportSpool"]
    home = tmp_path / "hermes-home"
    record = _agent_report_spool_record()

    spool = spool_class(str(home))
    assert spool.put(record) is True
    assert spool.put(record) is True
    spool_path = home / globals_["AGENT_REPORT_SPOOL_DIR"]
    files = list(spool_path.glob("*.json"))
    assert len(files) == 1
    assert stat.S_IMODE(spool_path.stat().st_mode) == 0o700
    assert stat.S_IMODE(files[0].stat().st_mode) == 0o600

    reopened = spool_class(str(home))
    assert reopened.pending() == [record]
    assert reopened.remove(record["source_id"]) is True
    assert reopened.pending() == []


def test_agent_report_spool_emits_redacted_alert_on_idempotency_conflict(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    home = tmp_path / "hermes-home"
    spool = globals_["AgentReportSpool"](str(home))
    record = _agent_report_spool_record()
    assert spool.put(record) is True

    conflicting = {**record, "summary": "different private report content"}
    assert spool.put(conflicting) is False
    diagnostic = capsys.readouterr().err
    assert diagnostic == f"HCO_AGENT_REPORT_SPOOL_CONFLICT:{record['source_id']}\n"
    assert "different private report content" not in diagnostic
    assert record["child_hermes_session_id"] not in diagnostic
    assert spool.pending() == [record]


def test_agent_report_spool_rejects_a_symlink_directory(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    home = tmp_path / "separate-home"
    target = tmp_path / "spool-target"
    home.mkdir(mode=0o700)
    target.mkdir(mode=0o700)
    (home / globals_["AGENT_REPORT_SPOOL_DIR"]).symlink_to(
        target, target_is_directory=True
    )

    with pytest.raises(ValueError, match="invalid Agent report spool"):
        globals_["AgentReportSpool"](str(home))


def test_agent_report_spool_replays_after_coordinator_restart(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    spool = globals_["AgentReportSpool"](str(tmp_path / "hermes-home"))
    record = _agent_report_spool_record()
    assert spool.put(record) is True
    submitted = []
    completed = threading.Event()

    class Client:
        def report_agent_stop(self, **kwargs):
            submitted.append(kwargs)
            completed.set()
            return {
                "duplicate": True,
                "disposition": "UNTRACKED",
                "reportId": None,
                "agentSessionId": None,
                "agentActivationId": None,
                "activeCodexCalls": 0,
                "mailboxItemId": None,
                "mailboxTarget": None,
            }

    stopped = []
    coordinator = globals_["AgentReportCoordinator"](
        Client(),
        SimpleNamespace(
            scope=lambda _session_id: None,
            stop=lambda session_id: stopped.append(session_id),
        ),
        SimpleNamespace(),
        lambda: (None, None),
        globals_["AgentReportSpool"](str(tmp_path / "hermes-home")),
    )

    assert coordinator._recover_once() == 1
    assert completed.wait(2)
    for _ in range(100):
        if not spool.pending():
            break
        time.sleep(0.01)
    assert submitted == [record]
    assert spool.pending() == []
    assert stopped == ["child-session"]


def test_agent_stop_report_remains_spooled_while_hco_is_unavailable(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    monkeypatch.setitem(globals_, "AGENT_REPORT_RETRY_SECONDS", 0)
    attempts = threading.Event()

    class Client:
        count = 0

        def report_agent_stop(self, **_kwargs):
            self.count += 1
            if self.count == globals_["AGENT_REPORT_MAX_ATTEMPTS"]:
                attempts.set()
            raise globals_["BridgeUnavailableError"]("offline")

    client = Client()
    spool = globals_["AgentReportSpool"](str(tmp_path / "hermes-home"))
    coordinator = globals_["AgentReportCoordinator"](
        client,
        SimpleNamespace(scope=lambda _session_id: None),
        SimpleNamespace(),
        lambda: (None, None),
        spool,
    )

    assert coordinator.schedule(
        parent_session_id="parent-session",
        parent_turn_id="parent-turn",
        child_session_id="child-session",
        child_status="completed",
        child_summary="Verified durable report",
        duration_ms=1200,
    ) is True
    assert attempts.wait(2)
    pending = spool.pending()
    assert len(pending) == 1
    assert pending[0]["child_hermes_session_id"] == "child-session"
    assert client.count == globals_["AGENT_REPORT_MAX_ATTEMPTS"]


def test_subagent_stop_reports_exact_hermes_identity_with_deterministic_fallbacks(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    reported = []
    completed = threading.Event()

    def report_agent_stop(_self, **kwargs):
        reported.append(kwargs)
        completed.set()
        return {
            "duplicate": False,
            "disposition": "UNTRACKED",
            "reportId": None,
            "agentSessionId": None,
            "agentActivationId": None,
            "activeCodexCalls": 0,
            "mailboxItemId": None,
            "mailboxTarget": None,
        }

    monkeypatch.setattr(globals_["BridgeClient"], "report_agent_stop", report_agent_stop)
    manager.invoke_hook(
        "subagent_stop",
        parent_session_id="parent-session",
        parent_turn_id="parent-turn",
        child_session_id="child-session",
        child_role="worker",
        child_summary=None,
        child_status="FUTURE_STATUS",
        duration_ms=-1,
    )

    assert completed.wait(2)
    assert len(reported) == 1
    report = reported[0]
    assert report["source_id"].startswith("hermes-stop-")
    assert report["child_hermes_session_id"] == "child-session"
    assert report["parent_hermes_session_id"] == "parent-session"
    assert report["child_status"] == "future_status"
    assert report["summary"] == ""
    assert report["duration_ms"] == 0


def test_mailbox_wakeup_acknowledges_only_after_hermes_public_delivery(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    order = []
    acked = threading.Event()
    item = {
        "mailboxItemId": "mail-1",
        "targetKind": "JARVIS",
        "targetId": "topic-1",
        "workRequestId": "work-1",
        "codexCallId": "call-1",
        "itemType": "CODEX_RECEIPT",
        "semanticKey": "receipt-1",
        "payload": {"text": "verified"},
        "leaseToken": "lease-1",
    }

    class Client:
        def claim_mailbox(self, **kwargs):
            order.append(("claim", kwargs))
            return [item]

        def ack_mailbox(self, **kwargs):
            order.append(("ack", kwargs))
            acked.set()
            return {
                "duplicate": False,
                "mailboxItem": item,
                "workRequest": {"workRequestId": "work-1"},
            }

    dispatched = {}

    def dispatch_async_delegation(**kwargs):
        dispatched.update(kwargs)
        result = kwargs["runner"]()
        order.append(("runner-return", result))
        coordinator.observe_processing_complete(
            SimpleNamespace(internal=True, text=result["summary"]), "success"
        )
        return {"status": "dispatched", "delegation_id": "delegation-1"}

    import tools.async_delegation as async_delegation

    monkeypatch.setattr(async_delegation, "dispatch_async_delegation", dispatch_async_delegation)
    agent_scopes = SimpleNamespace(scope=lambda _session_id: None, stop=lambda _session_id: None)
    coordinator = globals_["MailboxWakeCoordinator"](Client(), agent_scopes)
    scheduled = coordinator.schedule(
        result={
            "codexCallId": "call-1",
            "workRequestId": "work-1",
            "mailboxTarget": {"kind": "JARVIS_MAILBOX", "id": "topic-1"},
        },
        entry=SimpleNamespace(session_key="codex-bridge:zulip:42:Build:user"),
        hermes_session_id="jarvis-session-1",
    )

    assert scheduled is True
    assert acked.wait(2)
    assert dispatched["session_key"] == "codex-bridge:zulip:42:Build:user"
    assert dispatched["parent_session_id"] == "jarvis-session-1"
    labels = [entry[0] for entry in order]
    assert labels.index("runner-return") < labels.index("ack")
    assert order[-1][1]["final_delivery"] is True


def _mailbox_recovery_candidate(
    *,
    target_kind: str = "JARVIS",
    state: str = "PENDING",
    attempt_count: int = 0,
    project_id: str = "alpha",
    caller_session_id: str | None = "jarvis-session-1",
    parent_session_id: str | None = None,
    agent_role: str | None = None,
    topic_revision: int = 1,
    work_revision: int = 1,
) -> dict:
    return {
        "mailboxItem": {
            "mailboxItemId": "mail-recovery-1",
            "targetKind": target_kind,
            "targetId": "topic-1" if target_kind == "JARVIS" else "agent-1",
            "workRequestId": "work-1",
            "codexCallId": "call-1",
            "itemType": "CODEX_RECEIPT",
            "semanticKey": "receipt-1",
            "payload": {"text": "verified output"},
            "state": state,
            "attemptCount": attempt_count,
            "leaseOwner": "crashed-worker" if state == "LEASED" else None,
            "leaseToken": "expired-lease" if state == "LEASED" else None,
            "leaseExpiresAt": 1 if state == "LEASED" else None,
            "createdAt": 1_700_000_000_000,
            "updatedAt": 1_700_000_000_000,
            "acknowledgedAt": None,
            "lastError": None,
        },
        "projectId": project_id,
        "topicContextId": "topic-1",
        "streamId": 42,
        "topic": "Build",
        "topicState": "ACTIVE",
        "topicContextRevision": topic_revision,
        "workContextRevision": work_revision,
        "requesterUserId": 17,
        "originalZulipMessageId": 99,
        "workBrief": {"originalText": "Finish the requested implementation"},
        "callerHermesSessionId": caller_session_id,
        "parentHermesSessionId": parent_session_id,
        "agentRole": agent_role,
    }


@pytest.mark.parametrize(
    "mutation",
    ("caller-type", "agent-parent-missing", "jarvis-agent-fields"),
)
def test_mailbox_recovery_response_rejects_inconsistent_target_scope(
    tmp_path: Path, monkeypatch, mutation: str
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    client = globals_["BridgeClient"]("/tmp/not-used.sock", b"bridge-token")
    candidate = _mailbox_recovery_candidate()
    if mutation == "caller-type":
        candidate["callerHermesSessionId"] = 42
    elif mutation == "agent-parent-missing":
        candidate = _mailbox_recovery_candidate(
            target_kind="AGENT",
            caller_session_id="agent-session-1",
            parent_session_id=None,
            agent_role="reviewer",
        )
    else:
        candidate["parentHermesSessionId"] = "unexpected-parent"
        candidate["agentRole"] = "unexpected-role"

    monkeypatch.setattr(
        client,
        "_sync_post",
        lambda _path, _payload: {"items": [candidate]},
    )
    with pytest.raises(globals_["BridgeProtocolError"], match="invalid response"):
        client.list_mailbox_recovery(worker_id="recovery-worker", limit=1)


def test_restart_recovery_schedules_exact_jarvis_session(
    tmp_path: Path, monkeypatch
) -> None:
    manager, snapshot_path = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    candidate = _mailbox_recovery_candidate()
    abandoned = []
    scheduled = []

    class Client:
        def list_mailbox_recovery(self, **_kwargs):
            return [candidate]

        def abandon_mailbox_recovery(self, **kwargs):
            abandoned.append(kwargs)

    class Gateway:
        session_store = SimpleNamespace(
            lookup_by_session_id=lambda session_id: (
                SimpleNamespace(session_key="codex-bridge:zulip:42:Build:boss")
                if session_id == "jarvis-session-1"
                else None
            )
        )

        def _adapter_for_source(self, source):
            return (
                SimpleNamespace(on_processing_complete=lambda _event, _outcome: None)
                if source.profile == "zulip-ingress"
                else None
            )

    coordinator = globals_["MailboxWakeCoordinator"](
        Client(), SimpleNamespace(restore=lambda **_kwargs: False)
    )
    monkeypatch.setattr(
        coordinator,
        "_schedule_target",
        lambda **kwargs: scheduled.append(kwargs) or True,
    )

    recovered = coordinator._recover_once(
        gateway=Gateway(),
        event_loop=SimpleNamespace(),
        snapshot_path=str(snapshot_path),
        worker_id="recovery-worker",
    )

    assert recovered == 1
    assert abandoned == []
    assert len(scheduled) == 1
    wake = scheduled[0]
    assert wake["target_kind"] == "JARVIS"
    assert wake["target_id"] == "topic-1"
    assert wake["mailbox_item_id"] == "mail-recovery-1"
    assert wake["hermes_session_id"] == "jarvis-session-1"
    assert wake["entry"].context.project_id == "alpha"
    assert wake["entry"].context.provenance.topic == "Build"
    assert wake["entry"].session_key == "codex-bridge:zulip:42:Build:boss"


def _agent_restart_recovery_candidate() -> dict:
    return {
        "agentSessionId": "agent-1",
        "hermesSessionId": "agent-session-before-restart",
        "agentState": "RUNNING",
        "agentActivationId": "activation-1",
        "activationState": "RUNNING",
        "activationStartedAt": 1_700_000_000_000,
        "workRequestId": "work-1",
        "topicContextId": "topic-1",
        "projectId": "alpha",
        "parentHermesSessionId": None,
        "jarvisSessionId": "jarvis-session-1",
    }


def test_restart_recovery_orphans_pre_start_agent_with_exact_cas_fields(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    candidate = _agent_restart_recovery_candidate()
    calls = []

    class Client:
        def list_agent_restart_recovery(self, **kwargs):
            calls.append(("list", kwargs))
            return [candidate]

        def orphan_agent_restart(self, **kwargs):
            calls.append(("orphan", kwargs))
            return {
                "duplicate": False,
                "agentSession": {"state": "FAILED_ORPHANED"},
                "workRequest": {"state": "RUNNING"},
                "mailboxItem": {
                    "itemType": "ORPHAN_RECOVERY_NOTICE",
                    "state": "PENDING",
                },
            }

    coordinator = globals_["MailboxWakeCoordinator"](
        Client(), SimpleNamespace()
    )

    assert coordinator._recover_restarted_agents_once(
        started_before=1_700_000_001_000
    ) == 1
    assert calls == [
        (
            "list",
            {"started_before": 1_700_000_001_000, "limit": 100},
        ),
        (
            "orphan",
            {
                "agent_session_id": "agent-1",
                "agent_activation_id": "activation-1",
                "expected_state": "RUNNING",
                "started_before": 1_700_000_001_000,
            },
        ),
    ]


def test_bridge_client_validates_agent_restart_recovery_contract(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    client = globals_["BridgeClient"]("/tmp/not-used.sock", b"bridge-token")
    candidate = _agent_restart_recovery_candidate()
    requests = []

    def sync_post(path, payload):
        requests.append((path, payload))
        if path == "/v1/agents/recovery":
            return {"items": [candidate]}
        return {
            "duplicate": False,
            "agentSession": {"state": "FAILED_ORPHANED"},
            "workRequest": {"state": "RUNNING"},
            "mailboxItem": {
                "itemType": "ORPHAN_RECOVERY_NOTICE",
                "state": "PENDING",
            },
        }

    monkeypatch.setattr(client, "_sync_post", sync_post)
    assert client.list_agent_restart_recovery(
        started_before=1_700_000_001_000, limit=10
    ) == [candidate]
    assert client.orphan_agent_restart(
        agent_session_id="agent/1",
        agent_activation_id="activation-1",
        expected_state="RUNNING",
        started_before=1_700_000_001_000,
    )["agentSession"]["state"] == "FAILED_ORPHANED"
    assert requests[1][0] == "/v1/agents/agent%2F1/orphan"
    assert requests[1][1]["reason"] == "hermes_restart_outcome_unverified"


def test_restart_recovery_restores_exact_agent_and_parent_scope(
    tmp_path: Path, monkeypatch
) -> None:
    manager, snapshot_path = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    candidate = _mailbox_recovery_candidate(
        target_kind="AGENT",
        caller_session_id="agent-session-1",
        parent_session_id="jarvis-session-1",
        agent_role="reviewer",
    )
    restored = []
    scheduled = []

    class Client:
        def list_mailbox_recovery(self, **_kwargs):
            return [candidate]

        def abandon_mailbox_recovery(self, **_kwargs):
            raise AssertionError("valid Agent recovery was abandoned")

    class AgentScopes:
        def restore(self, **kwargs):
            restored.append(kwargs)
            return True

    class Gateway:
        session_store = SimpleNamespace(
            lookup_by_session_id=lambda session_id: (
                SimpleNamespace(session_key="codex-bridge:zulip:42:Build:worker")
                if session_id == "agent-session-1"
                else None
            )
        )

        def _adapter_for_source(self, source):
            return (
                SimpleNamespace(on_processing_complete=lambda _event, _outcome: None)
                if source.profile == "zulip-ingress"
                else None
            )

    coordinator = globals_["MailboxWakeCoordinator"](Client(), AgentScopes())
    monkeypatch.setattr(
        coordinator,
        "_schedule_target",
        lambda **kwargs: scheduled.append(kwargs) or True,
    )

    assert coordinator._recover_once(
        gateway=Gateway(),
        event_loop=SimpleNamespace(),
        snapshot_path=str(snapshot_path),
        worker_id="recovery-worker",
    ) == 1
    assert len(restored) == 1
    assert restored[0]["child_session_id"] == "agent-session-1"
    assert restored[0]["parent_session_id"] == "jarvis-session-1"
    assert restored[0]["child_role"] == "reviewer"
    assert scheduled[0]["target_kind"] == "AGENT"
    assert scheduled[0]["agent_parent_session_id"] == "jarvis-session-1"


@pytest.mark.parametrize(
    ("candidate", "reason"),
    [
        (
            _mailbox_recovery_candidate(state="LEASED", attempt_count=1),
            "recovery_outcome_unverified",
        ),
        (
            _mailbox_recovery_candidate(caller_session_id=None),
            "caller_session_unavailable",
        ),
        (
            _mailbox_recovery_candidate(project_id="wrong-project"),
            "recovery_scope_mismatch",
        ),
        (
            _mailbox_recovery_candidate(topic_revision=2, work_revision=1),
            "recovery_scope_mismatch",
        ),
    ],
    ids=("expired-lease", "missing-session", "project", "revision"),
)
def test_restart_recovery_abandons_every_uncertain_or_mismatched_candidate(
    tmp_path: Path, monkeypatch, candidate: dict, reason: str
) -> None:
    manager, snapshot_path = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)
    abandoned = []

    class Client:
        def list_mailbox_recovery(self, **_kwargs):
            return [candidate]

        def abandon_mailbox_recovery(self, **kwargs):
            abandoned.append(kwargs)

    gateway = SimpleNamespace(
        session_store=SimpleNamespace(
            lookup_by_session_id=lambda _session_id: SimpleNamespace(
                session_key="codex-bridge:zulip:42:Build:boss"
            )
        ),
        _adapter_for_source=lambda source: (
            SimpleNamespace(on_processing_complete=lambda _event, _outcome: None)
            if source.profile == "zulip-ingress"
            else None
        ),
    )
    coordinator = globals_["MailboxWakeCoordinator"](
        Client(), SimpleNamespace(restore=lambda **_kwargs: True)
    )
    monkeypatch.setattr(
        coordinator,
        "_schedule_target",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("unsafe recovery was scheduled")
        ),
    )

    assert coordinator._recover_once(
        gateway=gateway,
        event_loop=SimpleNamespace(),
        snapshot_path=str(snapshot_path),
        worker_id="recovery-worker",
    ) == 0
    assert len(abandoned) == 1
    assert abandoned[0]["mailbox_item_id"] == "mail-recovery-1"
    assert abandoned[0]["expected_state"] == candidate["mailboxItem"]["state"]
    assert abandoned[0]["expected_attempt_count"] == candidate["mailboxItem"]["attemptCount"]
    assert abandoned[0]["reason"] == reason


@pytest.mark.asyncio
async def test_agent_mailbox_resume_is_internal_and_bypasses_public_adapter_delivery(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    handled = []
    public_deliveries = []

    class IngressAdapter:
        async def on_processing_complete(self, _event, _outcome):
            return None

        async def send(self, *_args, **_kwargs):
            public_deliveries.append((_args, _kwargs))
            return SendResult(success=True, message_id="unexpected")

    ingress = IngressAdapter()

    class Gateway:
        session_store = SimpleNamespace(
            lookup_by_session_id=lambda _session_id: SimpleNamespace(
                session_key="codex-bridge:zulip:42:Build:person@example.com"
            )
        )

        def _build_process_event_source(self, payload):
            assert payload == {
                "session_key": "codex-bridge:zulip:42:Build:person@example.com"
            }
            return SessionSource(
                platform=Platform.ZULIP,
                profile="codex-bridge",
                chat_id="42:Build",
                chat_type="stream",
                chat_topic="Build",
                user_id="person@example.com",
            )

        def _adapter_for_source(self, source):
            return ingress if source.profile == "zulip-ingress" else None

        async def _handle_message(self, event):
            handled.append(event)
            return "Agent verified and summarized the Codex result."

    coordinator = globals_["MailboxWakeCoordinator"](
        SimpleNamespace(),
        SimpleNamespace(scope=lambda _session_id: None, stop=lambda _session_id: None),
    )
    item = {
        "mailboxItemId": "mail-agent-1",
        "workRequestId": "work-1",
        "codexCallId": "call-1",
        "itemType": "CODEX_RECEIPT",
        "payload": {"text": "raw Codex output"},
    }

    response = await coordinator._resume_agent(
        item=item,
        gateway=Gateway(),
        hermes_session_id="agent-session-1",
    )

    assert response == "Agent verified and summarized the Codex result."
    assert len(handled) == 1
    assert handled[0].internal is True
    assert handled[0].metadata == {"gateway_session_id": "agent-session-1"}
    assert handled[0].message_id == "hco-mailbox:mail-agent-1"
    assert "HCO_PRIVATE_AGENT_MAILBOX_ITEM" in handled[0].text
    assert public_deliveries == []


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

    assert result == "Codex 请求已提交。任务：obj-1。执行可能需要数分钟；可用 `/codex status <任务ID>` 查询，未确认失败前请勿重复提交。"
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
    assert payload["purpose"] == "codex-coordination-dispatch"
    assert payload["codexCallId"] == submitted["caller"]["codexCallId"]

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
    runner = getattr(manager, "_hco_test_real_runner", None)
    if runner is None:
        runner = object.__new__(GatewayRunner)
        runner.config = {}
        runner.session_store = manager._hco_test_session_store
        runner.adapters = {}
        runner._profile_adapters = {
            "zulip-ingress": {
                Platform.ZULIP: SimpleNamespace(
                    on_processing_complete=lambda _event, _outcome: None
                )
            }
        }
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
        manager._hco_test_real_runner = runner
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
    runner._running_agents.clear()
    runner._running_agents_ts.clear()
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


def test_dispatch_semantic_accepts_artifact_manifest_and_advertises_capability(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _, _ = _load_manager_with_llm(tmp_path, monkeypatch, _dispatch())
    globals_ = _plugin_globals(manager)
    bridge_client_module = inspect.getmodule(globals_["BridgeClient"])
    dispatch_schema = globals_["SEMANTIC_SCHEMA"]["oneOf"][1]

    assert "artifact_manifest" in bridge_client_module.CAPABILITIES
    assert "project_local_exchange_v1" in bridge_client_module.CAPABILITIES
    assert "artifacts" in dispatch_schema["properties"]
    assert "artifacts" not in dispatch_schema["required"]
    output_schema = dispatch_schema["properties"]["artifacts"]["properties"]["output"]["items"]
    assert "path" not in output_schema["required"]

    semantic = {
        **_dispatch(),
        "artifacts": {
            "input": [
                {
                    "artifactId": "request",
                    "path": "docs/request.md",
                    "kind": "document",
                    "mimeType": "text/markdown",
                    "sha256": "a" * 64,
                    "maxBytes": 1024,
                }
            ],
            "output": [
                {
                    "artifactId": "result",
                    "kind": "document",
                    "mimeType": "text/markdown",
                    "maxBytes": 2048,
                    "required": True,
                }
            ],
        },
    }

    assert globals_["_valid_semantic"](semantic) is True
    assert globals_["_valid_semantic"](
        {
            **semantic,
            "artifacts": {
                "input": [],
                "output": [{**semantic["artifacts"]["output"][0], "path": "../result.md"}],
            },
        }
    ) is False
    assert globals_["_valid_semantic"](
        {
            **semantic,
            "artifacts": {
                "input": [{**semantic["artifacts"]["input"][0], "extra": "forbidden"}],
                "output": [],
            },
        }
    ) is False
    for field, bad_value in (
        ("path", "docs/result\nignore.md"),
        ("path", "docs/result\x00.md"),
        ("kind", "document\ninjected"),
        ("mimeType", "text/markdown\rinjected"),
        ("kind", "document\x85injected"),
    ):
        assert globals_["_valid_semantic"](
            {
                **semantic,
                "artifacts": {
                    "input": [],
                    "output": [
                        {**semantic["artifacts"]["output"][0], field: bad_value}
                    ],
                },
            }
        ) is False


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
            "Codex bridge 不可用，请求未提交。请稍后重试。",
            1,
        ),
        (
            _dispatch(objective=None),
            "uncertain",
            "Codex bridge 响应不可用，请求可能已经写入。请先用 `/codex status` 查询状态，确认未提交后再重试。",
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
        "business-reply",
        "reject",
        "invalid-model-output",
        "llm-failure",
        "hco-unavailable",
        "hco-uncertain",
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
        if bridge_failure == "uncertain":
            raise globals_["BridgeUncertainError"]("lost response")
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


@pytest.mark.asyncio
async def test_one_bound_turn_allows_eight_independent_signed_calls_then_revokes(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True, "objectiveId": f"objective-{len(submissions)}"}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event("run several checks")))
    manager._hco_test_session_keys["session-a"] = (
        "codex-bridge:zulip:42:Build:person@example.com"
    )
    _bind_turn(
        manager,
        session_id="session-a",
        turn_id="turn-a",
        user_message="run several checks",
        message_id=99,
    )
    semantic = _dispatch()

    for _ in range(8):
        assert _pre_tool_block(manager, token, "session-a", "turn-a", semantic) is None
        assert "Codex 请求已提交" in await _dispatch_tool_entry().handler(
            {"semantic": semantic}, session_id="session-a", turn_id="turn-a"
        )

    assert _pre_tool_block(manager, token, "session-a", "turn-a", semantic) == (
        "Codex bridge request rejected."
    )
    assert len(submissions) == 8
    signed_tokens = [event["contextToken"] for event in submissions]
    signed_call_ids = [event["caller"]["codexCallId"] for event in submissions]
    assert len(set(signed_tokens)) == 8
    assert len(set(signed_call_ids)) == 8
    for event in submissions:
        payload = _token_payload(event["contextToken"])
        assert payload["purpose"] == "codex-coordination-dispatch"
        assert payload["codexCallId"] == event["caller"]["codexCallId"]

    manager.invoke_hook("post_llm_call", session_id="session-a", turn_id="turn-a")
    assert _pre_tool_block(manager, token, "session-a", "turn-a", semantic) == (
        "Codex bridge request rejected."
    )


def _lifecycle_runtime(session_keys: dict[str, str]):
    entries = {
        session_id: SimpleNamespace(session_key=session_key)
        for session_id, session_key in session_keys.items()
    }
    session_store = SimpleNamespace(
        lookup_by_session_id=lambda session_id: entries.get(session_id)
    )
    fake_adapter = SimpleNamespace(
        on_processing_complete=lambda _event, _outcome: None
    )
    gateway = SimpleNamespace(
        _session_key_for_source=lambda source: (
            f"{source.profile}:zulip:{source.chat_id}:{source.user_id}"
        ),
        _adapter_for_source=lambda source: (
            fake_adapter if source.profile == "zulip-ingress" else None
        ),
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
    assert "请求未提交" in result


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
    assert "请求未提交" in result
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
async def test_dispatch_instruction_referencing_another_project_is_forwarded(
    tmp_path: Path, monkeypatch
) -> None:
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

    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=501)))
    result = await _call_hco_tool(manager, token, contaminated_dispatch)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == contaminated_dispatch["instruction"]
    assert submissions[0]["semantic"]["topicModeAction"] is None
    assert "指令上下文冲突" not in result


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
async def test_dispatch_project_references_in_any_text_field_are_forwarded(
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
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=503)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    submitted = submissions[0]["semantic"]
    assert submitted[field] == semantic[field]
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_dispatch_common_english_is_forwarded_without_project_name_scanning(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "Ask the user before changing the API."}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
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
async def test_dispatch_arbitrary_project_and_path_text_is_forwarded(
    tmp_path: Path, monkeypatch, instruction: str
) -> None:
    semantic = {**_dispatch(), "instruction": instruction}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
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
async def test_dispatch_exact_foreign_cwd_text_is_forwarded(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "在 /workspace/beta 中执行"}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=507)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == semantic["instruction"]
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_dispatch_foreign_cwd_subpath_text_is_forwarded(
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
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=801)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == semantic["instruction"]
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_plugin_does_not_load_project_registry_for_text_scanning(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)
    hook = manager._hooks["pre_gateway_dispatch"][0]
    assert "project_cwd_map" not in inspect.getclosurevars(hook).nonlocals
    assert "_semantic_references_foreign_project" not in globals_
    assert "_mentions_project_id" not in globals_
    assert "_cwd_referenced" not in globals_


@pytest.mark.asyncio
async def test_dispatch_text_with_canonical_project_path_is_forwarded(
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
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=803)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == semantic["instruction"]
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_dispatch_text_with_symlink_alias_path_is_forwarded(
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
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=804)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == semantic["instruction"]
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "instruction",
    [
        "Fix root's failing tests.",
        "Inspect /anywhere/path without naming another project.",
    ],
)
async def test_project_named_root_is_plain_instruction_text(
    tmp_path: Path, monkeypatch, instruction: str
) -> None:
    semantic = {**_dispatch(), "instruction": instruction}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=805)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == instruction
    assert "指令上下文冲突" not in result


@pytest.mark.asyncio
async def test_dispatch_explicit_uppercase_project_reference_is_forwarded(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = {**_dispatch(), "instruction": "请在 OMEGA 仓库中执行"}
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=505)))
    result = await _call_hco_tool(manager, token, semantic)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == semantic["instruction"]
    assert "指令上下文冲突" not in result


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


@pytest.mark.parametrize(
    "separator",
    ["\r\n", "\r", "\n", "\x0b", "\x0c", "\x85", "\u2028", "\u2029"],
)
def test_markdown_escape_preserves_identifiers_and_flattens_structure(
    tmp_path: Path, monkeypatch, separator: str
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    escape = _plugin_globals(manager)["_escape_markdown_inline"]

    visible = escape(f"LIVE-POSTFIX.S-001 @**all**{separator}next|<tag>")

    assert "LIVE-POSTFIX.S-001" in visible
    assert "&#64;&#42;&#42;all&#42;&#42;" in visible
    assert separator not in visible
    assert " next" in visible
    assert "&#124;" in visible
    assert "&#60;tag&#62;" in visible


def test_markdown_escape_encodes_ampersand_before_entities(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    escape = _plugin_globals(manager)["_escape_markdown_inline"]

    assert escape("LIVE-POSTFIX.S-001") == "LIVE-POSTFIX.S-001"
    assert escape("&#42; *") == "&#38;&#35;42; &#42;"


def test_bridge_uncertain_message_only_includes_safe_objective_id(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    message = _plugin_globals(manager)["_bridge_uncertain_message"]

    safe = message("objective-123")
    unsafe = message("bad\nid")

    assert "objective-123" in safe
    assert "bad" not in unsafe
    assert "可能已经写入" in unsafe
    assert "查询状态" in unsafe


@pytest.mark.asyncio
async def test_semantic_bridge_user_error_is_single_line_and_markdown_escaped(
    tmp_path: Path, monkeypatch
) -> None:
    semantic = _dispatch()
    manager, _, _llm = _load_manager_with_llm(
        tmp_path,
        monkeypatch,
        semantic,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    globals_ = _plugin_globals(manager)

    async def user_error(_self, _event):
        raise globals_["BridgeUserError"](
            "INTERACTION_DECISION_INVALID",
            "error\x0b*bold*\x0c<tag>\x85bad|value\u2028next\u2029last",
        )

    monkeypatch.setattr(globals_["BridgeClient"], "submit", user_error)
    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=903)))
    result = await _call_hco_tool(manager, token, semantic)

    for separator in ("\x0b", "\x0c", "\x85", "\u2028", "\u2029"):
        assert separator not in result
    assert "&#42;bold&#42;" in result
    assert "&#60;tag&#62;" in result
    assert "bad&#124;value" in result


def test_channel_prompt_does_not_prohibit_other_project_names_or_paths(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(
        tmp_path,
        monkeypatch,
        _snapshot([_route(42, "PROJECT", project_id="alpha")]),
    )
    event = _event("compare alpha with beta")

    assert _invoke(manager, event) == {"action": "allow"}
    assert "Do NOT reference" not in event.channel_prompt
    assert "must be repeated" in event.channel_prompt
    assert "canonical working directory" in event.channel_prompt


def test_partial_answer_rejects_unsafe_interaction_id(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    render = _plugin_globals(manager)["_render_bridge_result"]

    result = render({
        "schemaVersion": 1,
        "status": "partial",
        "action": "interaction.answer",
        "projectId": "alpha",
        "interactionId": "bad id",
        "missingQuestionIds": ["q2"],
    })

    assert result == "Codex bridge protocol error."


def test_project_reference_scanner_helpers_are_not_registered(
    tmp_path: Path, monkeypatch
) -> None:
    manager, _ = _load_manager(tmp_path, monkeypatch)
    globals_ = _plugin_globals(manager)

    for name in (
        "_load_project_cwd_map",
        "_check_mentions_project_id",
        "_mentions_project_id",
        "_cwd_referenced",
        "_semantic_references_foreign_project",
    ):
        assert name not in globals_


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
async def test_dispatch_continue_bridge_unavailable_omits_objective_id(
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

    assert "请求未提交" in result
    assert "objective-123" not in result


@pytest.mark.asyncio
async def test_dispatch_continue_bridge_uncertain_includes_safe_objective_id(
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
        raise _plugin_globals(manager)["BridgeUncertainError"]("lost response")

    monkeypatch.setattr(_plugin_globals(manager)["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=507)))
    result = await _call_hco_tool(manager, token, semantic)

    assert "可能已经写入" in result
    assert "查询状态" in result
    assert "请求未提交" not in result
    assert "objective-123" in result


@pytest.mark.asyncio
async def test_dispatch_instruction_with_routed_project_name_is_forwarded(
    tmp_path: Path, monkeypatch
) -> None:
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

    submissions = []

    async def submit(_self, event):
        submissions.append(event)
        return {"accepted": True}

    globals_ = _plugin_globals(manager)
    monkeypatch.setattr(globals_["BridgeClient"], "submit", submit)

    token = _nlp_token_from_rewrite(_invoke(manager, _event(message_id=502)))
    result = await _call_hco_tool(manager, token, clean_dispatch)

    assert len(submissions) == 1
    assert submissions[0]["semantic"]["instruction"] == clean_dispatch["instruction"]
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
    elif case == "constraints-count":
        exact = _dispatch()
        exact["constraints"] = ["x"] * 16
    elif case == "acceptance-count":
        exact = _dispatch()
        exact["acceptanceCriteria"] = ["x"] * 16
    elif case == "reminders-count":
        exact = _dispatch()
        exact["reminders"] = ["x"] * 8
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
    elif case in {"business-text", "reject-text"}:
        plus["text"] += "a"
    elif case == "dispatch-list-entry":
        plus["constraints"][0] += "a"
    elif case == "constraints-count":
        plus["constraints"].append("x")
    elif case == "acceptance-count":
        plus["acceptanceCriteria"].append("x")
    elif case == "reminders-count":
        plus["reminders"].append("x")
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
        "business-text",
        "reject-text",
        "dispatch-list-entry",
        "constraints-count",
        "acceptance-count",
        "reminders-count",
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
