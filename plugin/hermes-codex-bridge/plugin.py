from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import inspect
import json
import os
import secrets
import stat
import time
from dataclasses import dataclass

from .bridge_client import BridgeClient, BridgeProtocolError, BridgeUnavailableError
from .route_snapshot import MAX_SAFE_INTEGER, find_route, load_route_snapshot


MAX_CONFIG_BYTES = 262_144
MAX_SECRET_BYTES = 4_096
MAX_CONTEXT_BYTES = 4_096
MAX_CONTEXT_LIFETIME_SECONDS = 120
MAX_CLOCK_SKEW_SECONDS = 30
MAX_REPLAY_ENTRIES = 4_096
CONTEXT_LIFETIME_SECONDS = 60
PRIVATE_COMMAND = "/hermes-codex-bridge-internal"
NLP_PRIVATE_COMMAND = "/hermes-codex-bridge-natural"
ROUTE_UNAVAILABLE_COMMAND = "/hermes-codex-bridge-route-unavailable"
ROUTE_UNAVAILABLE_TEXT = "项目路由暂不可用，请稍后重试。"
PLUGIN_VERSION = "1.0.0"
ATTESTATION_FILE = "hermes-codex-bridge-attestation.json"
NLP_CAPABILITY_PURPOSE = "codex-nlp-dispatch"
MAX_INSTRUCTION_BYTES = 16 * 1024
MAX_LIST_ENTRY_BYTES = 2 * 1024
MAX_SEMANTIC_BYTES = 32 * 1024
MAX_PENDING_ENTRIES = 256
MAX_PENDING_BYTES = 1024 * 1024
MAX_PENDING_PER_SENDER = 8
MAX_VISIBLE_TEXT_BYTES = 8 * 1024


def _now_seconds() -> int:
    return int(time.time())


@dataclass(frozen=True)
class Provenance:
    sender_id: int
    stream_id: int
    message_id: int
    topic: str


@dataclass(frozen=True)
class RouteContext:
    provenance: Provenance
    project_id: str
    topic_mode: str


@dataclass(frozen=True)
class PendingRequest:
    context: RouteContext
    request: str
    request_bytes: int
    expires_at: int


class PendingVault:
    def __init__(self) -> None:
        self._entries: dict[str, PendingRequest] = {}
        self._total_bytes = 0

    def _cleanup(self, now: int) -> None:
        for nonce, entry in list(self._entries.items()):
            if entry.expires_at < now - MAX_CLOCK_SKEW_SECONDS:
                self._entries.pop(nonce)
                self._total_bytes -= entry.request_bytes

    def add(self, nonce: str, entry: PendingRequest, now: int) -> bool:
        self._cleanup(now)
        sender_entries = sum(
            pending.context.provenance.sender_id
            == entry.context.provenance.sender_id
            for pending in self._entries.values()
        )
        if (
            nonce in self._entries
            or len(self._entries) >= MAX_PENDING_ENTRIES
            or self._total_bytes + entry.request_bytes > MAX_PENDING_BYTES
            or sender_entries >= MAX_PENDING_PER_SENDER
        ):
            return False
        self._entries[nonce] = entry
        self._total_bytes += entry.request_bytes
        return True

    def consume(self, nonce: str, now: int) -> PendingRequest | None:
        self._cleanup(now)
        entry = self._entries.pop(nonce, None)
        if entry is not None:
            self._total_bytes -= entry.request_bytes
        return entry


def _positive_integer(value: object) -> bool:
    return type(value) is int and 0 < value <= MAX_SAFE_INTEGER


def _extract_provenance(event) -> Provenance | None:
    try:
        source = event.source
        raw = event.raw_message
        message = raw["message"]
        sender_id = message["sender_id"]
        message_id = message["id"]
        stream_id = message["stream_id"]
        topic = message["subject"]
    except (AttributeError, KeyError, TypeError):
        return None
    if (
        type(raw) is not dict
        or type(message) is not dict
        or not _positive_integer(sender_id)
        or not _positive_integer(message_id)
        or not _positive_integer(stream_id)
        or type(topic) is not str
        or not topic.encode("utf-8")
        or len(topic.encode("utf-8")) > 256
        or getattr(source, "chat_type", None) != "stream"
        or getattr(source, "chat_id", None) != f"{stream_id}:{topic}"
        or getattr(source, "chat_topic", None) != topic
        or getattr(event, "message_id", None) != str(message_id)
    ):
        return None
    source_message_id = getattr(source, "message_id", None)
    if source_message_id is not None and source_message_id != str(message_id):
        return None
    return Provenance(sender_id, stream_id, message_id, topic)


def _read_owner_file(path: str, maximum: int) -> bytes:
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("invalid owner file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise ValueError("invalid owner file")
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if not data or len(data) > maximum:
            raise ValueError("invalid owner file")
        return data
    finally:
        os.close(descriptor)


def _write_process_attestation() -> None:
    home_text = os.environ.get("HERMES_HOME", "")
    if not os.path.isabs(home_text):
        raise ValueError("invalid Hermes home")
    home_info = os.lstat(home_text)
    if (
        not stat.S_ISDIR(home_info.st_mode)
        or stat.S_ISLNK(home_info.st_mode)
        or home_info.st_uid != os.getuid()
    ):
        raise ValueError("invalid Hermes home")
    path = os.path.join(home_text, ATTESTATION_FILE)
    temporary = f"{path}.tmp-{os.getpid()}-{secrets.token_urlsafe(8)}"
    payload = {
        "schemaVersion": 1,
        "pid": os.getpid(),
        "pluginVersion": PLUGIN_VERSION,
        "pluginPath": os.path.realpath(os.path.dirname(__file__)),
        "hook": "pre_gateway_dispatch",
        "ingressProfile": "zulip-ingress",
    }
    data = _canonical_json(payload) + b"\n"
    descriptor = os.open(
        temporary,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        written = 0
        while written < len(data):
            count = os.write(descriptor, data[written:])
            if count <= 0:
                raise OSError("attestation write made no progress")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
        os.chmod(path, 0o600, follow_symlinks=False)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_registration_config() -> tuple[bytes, bytes, str, str]:
    raw = _read_owner_file(os.environ.get("HCO_CONFIG_PATH", ""), MAX_CONFIG_BYTES)
    config = json.loads(raw.decode("utf-8"))
    bridge = config["bridge"]
    if config.get("version") != 1 or set(bridge) != {
        "tokenPath",
        "contextKeyPath",
        "socketPath",
        "routeSnapshotPath",
    }:
        raise ValueError("invalid bridge configuration")
    key = _read_owner_file(bridge["contextKeyPath"], MAX_SECRET_BYTES)
    token = _read_owner_file(bridge["tokenPath"], MAX_SECRET_BYTES)
    if len(key) < 32 or not os.path.isabs(bridge["socketPath"]) or not os.path.isabs(
        bridge["routeSnapshotPath"]
    ):
        raise ValueError("invalid bridge configuration")
    return key, token, bridge["socketPath"], bridge["routeSnapshotPath"]


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode_base64url(value: str) -> bytes:
    if not value or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        for char in value
    ):
        raise ValueError("invalid context")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _base64url(decoded) != value:
        raise ValueError("invalid context")
    return decoded


def _sign_context(payload: dict, key: bytes) -> str:
    encoded_payload = _base64url(_canonical_json(payload))
    signature = hmac.new(key, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    token = f"{encoded_payload}.{_base64url(signature)}"
    if len(token.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("invalid context")
    return token


def _binding(provenance: Provenance) -> dict:
    return {
        "streamId": provenance.stream_id,
        "topic": provenance.topic,
        "sourceMessageId": provenance.message_id,
        "senderId": provenance.sender_id,
    }


def _bounded_text(value: object, maximum: int = MAX_INSTRUCTION_BYTES) -> bool:
    if type(value) is not str or not value.strip():
        return False
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeError:
        return False


def _valid_text_list(value: object, maximum_entries: int) -> bool:
    return (
        type(value) is list
        and len(value) <= maximum_entries
        and all(_bounded_text(item, MAX_LIST_ENTRY_BYTES) for item in value)
    )


def _valid_objective(value: object) -> bool:
    if value is None:
        return True
    if type(value) is not dict or type(value.get("mode")) is not str:
        return False
    if value["mode"] == "NEW":
        return set(value) == {"mode"}
    return (
        value["mode"] == "CONTINUE"
        and set(value) == {"mode", "objectiveId"}
        and _bounded_text(value["objectiveId"], 512)
    )


def _valid_semantic_value(value: object) -> bool:
    if type(value) is not dict or type(value.get("type")) is not str:
        return False
    try:
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_SEMANTIC_BYTES:
            return False
    except (TypeError, ValueError, UnicodeError):
        return False
    if value["type"] == "CONTROL":
        return (
            set(value) == {"type", "action", "mode"}
            and value["action"] == "SET_TOPIC_MODE"
            and value["mode"] in ("AUTO", "HERMES_ONLY")
        )
    if value["type"] == "DISPATCH":
        return (
            set(value)
            == {
            "type",
            "instruction",
            "constraints",
            "acceptanceCriteria",
            "reminders",
            "objective",
            "topicModeAction",
            }
            and _bounded_text(value["instruction"])
            and _valid_text_list(value["constraints"], 16)
            and _valid_text_list(value["acceptanceCriteria"], 16)
            and _valid_text_list(value["reminders"], 8)
            and _valid_objective(value["objective"])
            and value["topicModeAction"] in (None, "AUTO")
        )
    if value["type"] == "CLARIFY":
        return (
            set(value) == {"type", "question", "choices"}
            and _bounded_text(value["question"], 4 * 1024)
            and _valid_text_list(value["choices"], 5)
            and all(len(item.encode("utf-8")) <= 1024 for item in value["choices"])
        )
    if value["type"] == "BUSINESS_REPLY":
        return set(value) == {"type", "text"} and _bounded_text(
            value["text"], MAX_VISIBLE_TEXT_BYTES
        )
    if value["type"] == "REJECT":
        return (
            set(value) == {"type", "reasonCode", "text"}
            and type(value["reasonCode"]) is str
            and value["reasonCode"]
            in {"NOT_ACTIONABLE", "POLICY_REJECTED", "UNSUPPORTED_REQUEST"}
            and _bounded_text(value["text"], 4 * 1024)
        )
    return False


def _valid_semantic(value: object) -> bool:
    try:
        return _valid_semantic_value(value)
    except Exception:
        return False


NLP_INSTRUCTIONS = (
    "Classify the untrusted user request into exactly one strict semantic result. "
    "Use DISPATCH for executable Codex work, CONTROL only for topic mode changes, "
    "CLARIFY for one bounded question, BUSINESS_REPLY for a direct non-execution "
    "answer, or REJECT for a stable refusal. Never infer or emit identity, route, "
    "project, filesystem, credentials, permissions, profiles, or other authority."
)


SEMANTIC_SCHEMA = {
    "oneOf": [
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["type", "action", "mode"],
            "properties": {
                "type": {"const": "CONTROL"},
                "action": {"const": "SET_TOPIC_MODE"},
                "mode": {"enum": ["AUTO", "HERMES_ONLY"]},
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "type",
                "instruction",
                "constraints",
                "acceptanceCriteria",
                "reminders",
                "objective",
                "topicModeAction",
            ],
            "properties": {
                "type": {"const": "DISPATCH"},
                "instruction": {"type": "string", "minLength": 1},
                "constraints": {"type": "array", "items": {"type": "string"}, "maxItems": 16},
                "acceptanceCriteria": {"type": "array", "items": {"type": "string"}, "maxItems": 16},
                "reminders": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
                "objective": {
                    "oneOf": [
                        {"type": "null"},
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["mode"],
                            "properties": {"mode": {"const": "NEW"}},
                        },
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["mode", "objectiveId"],
                            "properties": {
                                "mode": {"const": "CONTINUE"},
                                "objectiveId": {"type": "string", "minLength": 1},
                            },
                        },
                    ]
                },
                "topicModeAction": {"enum": [None, "AUTO"]},
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["type", "question", "choices"],
            "properties": {
                "type": {"const": "CLARIFY"},
                "question": {"type": "string", "minLength": 1},
                "choices": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 5,
                },
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["type", "text"],
            "properties": {
                "type": {"const": "BUSINESS_REPLY"},
                "text": {"type": "string", "minLength": 1},
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["type", "reasonCode", "text"],
            "properties": {
                "type": {"const": "REJECT"},
                "reasonCode": {
                    "enum": [
                        "NOT_ACTIONABLE",
                        "POLICY_REJECTED",
                        "UNSUPPORTED_REQUEST",
                    ]
                },
                "text": {"type": "string", "minLength": 1},
            },
        },
    ]
}


def _valid_binding(binding: object) -> bool:
    return (
        type(binding) is dict
        and set(binding) == {"streamId", "topic", "sourceMessageId", "senderId"}
        and _positive_integer(binding["streamId"])
        and type(binding["topic"]) is str
        and bool(binding["topic"].encode("utf-8"))
        and len(binding["topic"].encode("utf-8")) <= 256
        and _positive_integer(binding["sourceMessageId"])
        and _positive_integer(binding["senderId"])
    )


def _single_token(value: str) -> bool:
    return bool(value) and not any(char.isspace() for char in value)


def _parse_command(text: object) -> dict | None:
    if type(text) is not str or "\n" in text or "\r" in text:
        return None
    if not text.startswith("/codex"):
        return None
    rest = text[len("/codex") :]
    if not rest.startswith(" ") or rest.startswith("  ") or rest.endswith(" "):
        return None
    args = rest[1:]

    fixed = {
        "status": {"type": "STATUS"},
        "cancel": {"type": "CANCEL"},
        "topic show": {"type": "TOPIC", "action": "SHOW"},
        "topic auto": {"type": "TOPIC", "action": "AUTO"},
        "topic hermes": {"type": "TOPIC", "action": "HERMES"},
        "route show": {"type": "ROUTE", "action": "SHOW"},
        "route none": {"type": "ROUTE", "action": "NONE"},
        "route unset": {"type": "ROUTE", "action": "UNSET"},
    }
    if args in fixed:
        return fixed[args]

    for prefix, command_type, field in (
        ("run ", "RUN", "instruction"),
        ("status ", "STATUS", "objectiveId"),
        ("cancel ", "CANCEL", "objectiveId"),
        ("objective new ", "OBJECTIVE_NEW", "instruction"),
    ):
        if args.startswith(prefix):
            value = args[len(prefix) :]
            if not value or (field == "objectiveId" and not _single_token(value)):
                return None
            return {"type": command_type, field: value}

    if args.startswith("route set "):
        project_id = args[len("route set ") :]
        if not _single_token(project_id):
            return None
        return {"type": "ROUTE", "action": "SET", "projectId": project_id}

    for prefix, command_type, tail_field in (
        ("objective continue ", "OBJECTIVE_CONTINUE", "instruction"),
        ("approve ", "APPROVE", "choice"),
        ("answer ", "ANSWER", "text"),
    ):
        if args.startswith(prefix):
            tail = args[len(prefix) :]
            first, separator, remainder = tail.partition(" ")
            if not separator or not _single_token(first) or not remainder:
                return None
            first_field = "objectiveId" if command_type == "OBJECTIVE_CONTINUE" else "replyToken"
            return {"type": command_type, first_field: first, tail_field: remainder}
    return None


def _is_route_query(text: object) -> bool:
    if type(text) is not str or "\n" in text or "\r" in text:
        return False
    normalized = text.strip().lower()
    for character in " \t，,。.!！?？:：;；、":
        normalized = normalized.replace(character, "")
    return normalized in {
        "当前工作文件夹当前projectid",
        "当前工作目录当前projectid",
        "当前项目目录当前projectid",
        "请汇报当前工作文件夹当前projectid",
        "请汇报当前工作目录当前projectid",
        "请你汇报当前工作文件夹当前projectid",
        "请告诉我当前工作文件夹和当前projectid",
        "请告诉我当前工作目录和当前projectid",
        "当前projectid当前工作文件夹",
        "当前projectid当前工作目录",
    }


def _unsupported_bridge_result() -> str:
    return (
        "Codex 返回了当前插件不支持的操作结果；"
        "详细内容未显示，请检查插件与 HCO 版本。"
    )


def _render_bridge_result(result: object) -> str:
    if type(result) is not dict:
        return "Codex bridge protocol error."
    if result.get("accepted") is True and set(result).issubset(
        {"accepted", "objectiveId"}
    ):
        objective_id = result.get("objectiveId")
        if objective_id is None:
            return "Codex 请求已提交。"
        if type(objective_id) is str and objective_id:
            return f"Codex 请求已提交。任务：{objective_id}。"
        return "Codex bridge protocol error."
    if result.get("schemaVersion") != 1:
        return "Codex bridge protocol error."
    action = result.get("action")
    status = result.get("status")
    if type(action) is not str or type(status) is not str:
        return "Codex bridge protocol error."
    if action == "dispatch":
        if status not in {
            "accepted",
            "duplicate",
            "busy",
            "backend_unavailable",
            "reconciliation_needed",
            "submission_unknown",
            "cancelled",
            "terminal_error",
        }:
            return _unsupported_bridge_result()
        project_id = result.get("projectId")
        objective_id = result.get("objectiveId")
        if not all(type(value) is str and value for value in (project_id, objective_id)):
            return "Codex bridge protocol error."
        if status == "accepted":
            return f"Codex 请求已提交。项目：{project_id}。任务：{objective_id}。"
        if status == "backend_unavailable":
            return (
                f"已识别项目 {project_id}，但 Codex 后端暂时不可用；"
                f"本次任务未执行。任务记录：{objective_id}。"
            )
        return f"Codex 请求状态：{status}。项目：{project_id}。任务：{objective_id}。"
    if action == "route.show" and status == "ok":
        route = result.get("route")
        if type(route) is not dict or type(route.get("owner")) is not str:
            return "Codex bridge protocol error."
        if route["owner"] == "PROJECT":
            project_id = route.get("projectId")
            cwd = route.get("cwd")
            if not all(type(value) is str and value for value in (project_id, cwd)):
                return "Codex bridge protocol error."
            return f"当前项目：{project_id}。工作目录：{cwd}。"
        if route["owner"] == "HERMES":
            return "当前频道由 Hermes 管理，没有关联 Codex 项目。"
        return "Codex bridge protocol error."
    if action in {"route.set", "route.none", "route.unset"} and status == "ok":
        route = result.get("route")
        if type(route) is not dict or type(route.get("owner")) is not str:
            return "Codex bridge protocol error."
        if route["owner"] == "PROJECT":
            project_id = route.get("projectId")
            if type(project_id) is not str or not project_id:
                return "Codex bridge protocol error."
            return f"频道路由已更新。当前项目：{project_id}。"
        if route["owner"] == "HERMES":
            return "频道路由已更新。当前由 Hermes 管理。"
        return "Codex bridge protocol error."
    if action == "topic.show" and status == "ok":
        project_id = result.get("projectId")
        mode = result.get("mode")
        objective_id = result.get("objectiveId")
        if (
            type(project_id) is not str
            or not project_id
            or type(mode) is not str
            or not mode
            or (objective_id is not None and (type(objective_id) is not str or not objective_id))
        ):
            return "Codex bridge protocol error."
        objective = (
            f"任务：{objective_id}。"
            if objective_id is not None
            else "当前没有绑定任务。"
        )
        return f"当前话题模式：{mode}。项目：{project_id}。{objective}"
    if action == "topic.set" and status == "ok":
        mode = result.get("mode")
        if type(mode) is not str or not mode:
            return "Codex bridge protocol error."
        return f"话题模式已更新：{mode}。"
    if action == "objective.status" and status == "ok":
        project_id = result.get("projectId")
        objective_id = result.get("objectiveId")
        execution_status = result.get("executionStatus")
        backend = result.get("backend")
        thread_id = result.get("threadId")
        if (
            not all(
                type(value) is str and value
                for value in (project_id, objective_id, execution_status, backend)
            )
            or (thread_id is not None and (type(thread_id) is not str or not thread_id))
        ):
            return "Codex bridge protocol error."
        if execution_status not in {
            "idle",
            "starting",
            "ready",
            "submitting",
            "running",
            "submission_unknown",
            "reconciliation_needed",
            "backend_unavailable",
            "completed",
            "cancelled",
            "terminal_error",
        }:
            return _unsupported_bridge_result()
        thread = thread_id if thread_id is not None else "尚未建立"
        return (
            f"任务：{objective_id}。项目：{project_id}。状态：{execution_status}。"
            f"后端：{backend}。会话：{thread}。"
        )
    if action == "objective.cancel":
        if status not in {"cancelled", "reconciliation_needed", "backend_unavailable"}:
            return _unsupported_bridge_result()
        project_id = result.get("projectId")
        objective_id = result.get("objectiveId")
        turn_id = result.get("turnId")
        if (
            not all(type(value) is str and value for value in (project_id, objective_id))
            or (turn_id is not None and (type(turn_id) is not str or not turn_id))
        ):
            return "Codex bridge protocol error."
        turn = f"轮次：{turn_id}。" if turn_id is not None else ""
        return (
            f"任务取消状态：{status}。项目：{project_id}。"
            f"任务：{objective_id}。{turn}"
        )
    if action == "interaction.answer":
        if status not in {"answered", "response_uncertain", "response_retryable"}:
            return _unsupported_bridge_result()
        project_id = result.get("projectId")
        objective_id = result.get("objectiveId")
        interaction_id = result.get("interactionId")
        if not all(
            type(value) is str and value
            for value in (project_id, objective_id, interaction_id)
        ):
            return "Codex bridge protocol error."
        return (
            f"交互回复状态：{status}。项目：{project_id}。任务：{objective_id}。"
            f"交互：{interaction_id}。"
        )
    return _unsupported_bridge_result()


def _valid_command(command: object) -> bool:
    if type(command) is not dict or type(command.get("type")) is not str:
        return False
    command_type = command["type"]
    exact: dict[str, set[str]] = {
        "RUN": {"type", "instruction"},
        "STATUS": {"type"},
        "CANCEL": {"type"},
        "TOPIC": {"type", "action"},
        "ROUTE": {"type", "action"},
        "OBJECTIVE_NEW": {"type", "instruction"},
        "OBJECTIVE_CONTINUE": {"type", "objectiveId", "instruction"},
        "APPROVE": {"type", "replyToken", "choice"},
        "ANSWER": {"type", "replyToken", "text"},
    }
    expected = exact.get(command_type)
    if expected is None:
        return False
    if command_type in {"STATUS", "CANCEL"} and "objectiveId" in command:
        expected = {"type", "objectiveId"}
    if command_type == "ROUTE" and command.get("action") == "SET":
        expected = {"type", "action", "projectId"}
    if set(command) != expected:
        return False
    for field, value in command.items():
        if field != "type" and (type(value) is not str or not value):
            return False
    if command_type == "TOPIC" and command["action"] not in {"SHOW", "AUTO", "HERMES"}:
        return False
    if command_type == "ROUTE" and command["action"] not in {"SHOW", "SET", "NONE", "UNSET"}:
        return False
    for field in ("objectiveId", "replyToken", "projectId"):
        if field in command and not _single_token(command[field]):
            return False
    return True


def _verify_context(token: object, key: bytes, used_nonces: dict[str, int]) -> dict:
    if type(token) is not str or len(token.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("invalid context")
    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("invalid context")
    encoded_payload, encoded_signature = parts
    signature = _decode_base64url(encoded_signature)
    expected = hmac.new(
        key, encoded_payload.encode("ascii"), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("invalid context")
    raw_payload = _decode_base64url(encoded_payload)
    payload = json.loads(raw_payload.decode("utf-8"))
    if type(payload) is not dict or _canonical_json(payload) != raw_payload:
        raise ValueError("invalid context")
    if set(payload) != {"version", "issuedAt", "expiresAt", "nonce", "binding", "command"}:
        raise ValueError("invalid context")
    issued_at = payload["issuedAt"]
    expires_at = payload["expiresAt"]
    now = _now_seconds()
    if (
        payload["version"] != 1
        or type(issued_at) is not int
        or type(expires_at) is not int
        or expires_at <= issued_at
        or expires_at - issued_at > MAX_CONTEXT_LIFETIME_SECONDS
        or issued_at > now + MAX_CLOCK_SKEW_SECONDS
        or expires_at < now - MAX_CLOCK_SKEW_SECONDS
        or not _valid_binding(payload["binding"])
        or not _valid_command(payload["command"])
    ):
        raise ValueError("invalid context")
    nonce = payload["nonce"]
    if (
        type(nonce) is not str
        or not 1 <= len(nonce) <= 128
        or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in nonce)
    ):
        raise ValueError("invalid context")
    for old_nonce, old_expiry in list(used_nonces.items()):
        if old_expiry < now - MAX_CLOCK_SKEW_SECONDS:
            del used_nonces[old_nonce]
    if nonce in used_nonces:
        raise ValueError("invalid context")
    if len(used_nonces) >= MAX_REPLAY_ENTRIES:
        raise ValueError("invalid context")
    used_nonces[nonce] = expires_at
    return payload


def _verified_payload(token: object, key: bytes) -> dict:
    if type(token) is not str or len(token.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("invalid context")
    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("invalid context")
    encoded_payload, encoded_signature = parts
    signature = _decode_base64url(encoded_signature)
    expected = hmac.new(key, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("invalid context")
    raw_payload = _decode_base64url(encoded_payload)
    payload = json.loads(raw_payload.decode("utf-8"))
    if type(payload) is not dict or _canonical_json(payload) != raw_payload:
        raise ValueError("invalid context")
    return payload


def _verify_nlp_capability(
    token: object, key: bytes, vault: PendingVault
) -> tuple[dict, PendingRequest]:
    payload = _verified_payload(token, key)
    expected_fields = {
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
    if set(payload) != expected_fields:
        raise ValueError("invalid context")
    issued_at = payload["issuedAt"]
    expires_at = payload["expiresAt"]
    nonce = payload["nonce"]
    digest = payload["messageSha256"]
    now = _now_seconds()
    if (
        payload["version"] != 1
        or payload["purpose"] != NLP_CAPABILITY_PURPOSE
        or type(issued_at) is not int
        or type(expires_at) is not int
        or expires_at <= issued_at
        or expires_at - issued_at != CONTEXT_LIFETIME_SECONDS
        or issued_at > now + MAX_CLOCK_SKEW_SECONDS
        or expires_at < now - MAX_CLOCK_SKEW_SECONDS
        or type(nonce) is not str
        or not 32 <= len(nonce) <= 128
        or any(
            char
            not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
            for char in nonce
        )
        or not _valid_binding(payload["binding"])
        or type(payload["projectId"]) is not str
        or not payload["projectId"]
        or payload["topicMode"] not in {"AUTO", "HERMES_ONLY", "CODEX_BOUND"}
        or type(digest) is not str
        or len(digest) != 64
        or any(char not in "0123456789abcdef" for char in digest)
        or type(payload["messageBytes"]) is not int
        or not 0 < payload["messageBytes"] <= MAX_INSTRUCTION_BYTES
    ):
        raise ValueError("invalid context")
    entry = vault.consume(nonce, now)
    if entry is None:
        raise ValueError("invalid context")
    request_bytes = entry.request.encode("utf-8")
    if (
        payload["binding"] != _binding(entry.context.provenance)
        or payload["projectId"] != entry.context.project_id
        or payload["topicMode"] != entry.context.topic_mode
        or payload["messageBytes"] != len(request_bytes)
        or payload["messageSha256"] != hashlib.sha256(request_bytes).hexdigest()
    ):
        raise ValueError("invalid context")
    return payload, entry


def _install_zulip_secret_scope_compatibility() -> None:
    """Bridge legacy Zulip env reads to Hermes' profile secret scope."""
    from agent.secret_scope import get_secret
    import gateway.platforms.zulip as zulip_module

    original_check = zulip_module.check_zulip_requirements
    original_adapter = zulip_module.ZulipAdapter
    check_patched = getattr(original_check, "_hco_secret_scope_compatible", False)
    adapter_patched = getattr(original_adapter, "_hco_secret_scope_compatible", False)
    if check_patched or adapter_patched:
        if check_patched and adapter_patched:
            return
        raise RuntimeError("partial Zulip secret-scope compatibility patch")
    if list(inspect.signature(original_check).parameters) != ["config"]:
        raise RuntimeError("unsupported Zulip requirements signature")
    if list(inspect.signature(original_adapter.__init__).parameters) != [
        "self",
        "config",
    ]:
        raise RuntimeError("unsupported Zulip adapter signature")

    def secret(name: str, default: str = "") -> str:
        value = get_secret(name, default)
        if not isinstance(value, str):
            raise TypeError(f"{name} must be a string")
        return value

    def scoped_check(config=None) -> bool:
        effective = copy.copy(config) if config is not None else zulip_module.PlatformConfig()
        effective.extra = dict(effective.extra)
        effective.api_key = effective.token or effective.api_key or secret("ZULIP_API_KEY")
        effective.extra["bot_email"] = (
            effective.extra.get("bot_email") or secret("ZULIP_BOT_EMAIL")
        )
        effective.extra["site_url"] = (
            effective.extra.get("site_url") or secret("ZULIP_SITE_URL")
        )
        return original_check(effective)

    class ScopedZulipAdapter(original_adapter):
        def __init__(self, config):
            super().__init__(config)
            if not isinstance(config.extra, dict):
                raise TypeError("Zulip config.extra must be a mapping")

            def setting(key: str, secret_name: str, default: str = ""):
                if key in config.extra:
                    return config.extra[key]
                return secret(secret_name, default)

            def string_setting(key: str, secret_name: str, default: str = "") -> str:
                value = setting(key, secret_name, default)
                if not isinstance(value, str):
                    raise TypeError(f"Zulip {key} must be a string")
                return value

            def boolean_setting(key: str, secret_name: str, default: str) -> bool:
                value = setting(key, secret_name, default)
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    normalized = value.strip().lower()
                    if normalized in ("true", "1", "yes"):
                        return True
                    if normalized in ("false", "0", "no"):
                        return False
                raise ValueError(f"Zulip {key} must be a boolean")

            self._site_url = (
                config.extra.get("site_url", "") or secret("ZULIP_SITE_URL")
            ).rstrip("/")
            self._bot_email = (
                config.extra.get("bot_email", "") or secret("ZULIP_BOT_EMAIL")
            )
            self._api_key = config.token or config.api_key or secret("ZULIP_API_KEY")
            self._default_stream = (
                config.extra.get("default_stream", "")
                or secret("ZULIP_DEFAULT_STREAM")
            )
            self._home_topic = (
                config.extra.get("home_topic", "") or secret("ZULIP_HOME_TOPIC")
            )
            self._cert_bundle = string_setting("cert_bundle", "ZULIP_CERT_BUNDLE")
            self._allow_insecure = boolean_setting(
                "allow_insecure", "ZULIP_ALLOW_INSECURE", "false"
            )
            self._require_mention = boolean_setting(
                "require_mention", "ZULIP_REQUIRE_MENTION", "true"
            )
            free_streams_raw = setting(
                "free_response_streams", "ZULIP_FREE_RESPONSE_STREAMS"
            )
            if isinstance(free_streams_raw, str):
                free_streams = free_streams_raw.split(",")
            elif isinstance(free_streams_raw, list) and all(
                isinstance(stream, str) for stream in free_streams_raw
            ):
                free_streams = free_streams_raw
            else:
                raise TypeError("Zulip free_response_streams must be a string or string list")
            self._free_response_streams = {
                stream.strip().lower()
                for stream in free_streams
                if stream.strip()
            }
            context_depth = setting("context_depth", "ZULIP_CONTEXT_DEPTH", "0")
            if isinstance(context_depth, bool):
                raise TypeError("Zulip context_depth must be an integer")
            self._context_depth = int(context_depth)
            self._catchup_enabled = boolean_setting(
                "catchup_enabled", "ZULIP_CATCHUP", "false"
            )
            try:
                self._catchup_max_messages = max(
                    1,
                    int(
                        setting(
                            "catchup_max_messages",
                            "ZULIP_CATCHUP_MAX_MESSAGES",
                            str(zulip_module._CATCHUP_DEFAULT_MAX_MESSAGES),
                        )
                    ),
                )
            except (TypeError, ValueError):
                self._catchup_max_messages = zulip_module._CATCHUP_DEFAULT_MAX_MESSAGES

    scoped_check._hco_secret_scope_compatible = True
    ScopedZulipAdapter._hco_secret_scope_compatible = True
    ScopedZulipAdapter.__name__ = original_adapter.__name__
    ScopedZulipAdapter.__qualname__ = original_adapter.__qualname__
    ScopedZulipAdapter.__module__ = original_adapter.__module__
    zulip_module.check_zulip_requirements = scoped_check
    zulip_module.ZulipAdapter = ScopedZulipAdapter


def register(ctx) -> None:
    try:
        _install_zulip_secret_scope_compatibility()
        key, token, socket_path, snapshot_path = _load_registration_config()
    except Exception:
        return

    client = BridgeClient(socket_path, token)
    llm = ctx.llm
    used_nonces: dict[str, int] = {}
    pending_vault = PendingVault()

    def signed_command_rewrite(command: dict, provenance: Provenance) -> dict:
        now = _now_seconds()
        payload = {
            "version": 1,
            "issuedAt": now,
            "expiresAt": now + CONTEXT_LIFETIME_SECONDS,
            "nonce": secrets.token_urlsafe(24),
            "binding": _binding(provenance),
            "command": command,
        }
        try:
            context_token = _sign_context(payload, key)
        except Exception:
            return {"action": "rewrite", "text": f"{PRIVATE_COMMAND} invalid"}
        return {"action": "rewrite", "text": f"{PRIVATE_COMMAND} {context_token}"}

    def hook(**kwargs):
        event = kwargs.get("event")
        source = getattr(event, "source", None)
        if source is None:
            return {"action": "allow"}
        platform = getattr(source, "platform", None)
        if getattr(platform, "value", platform) != "zulip":
            return {"action": "allow"}
        source.profile = "zulip-ingress"
        provenance = _extract_provenance(event)
        if provenance is None:
            return {"action": "allow"}
        snapshot = load_route_snapshot(snapshot_path)
        if snapshot is None:
            return {"action": "rewrite", "text": ROUTE_UNAVAILABLE_COMMAND}
        if (
            type(getattr(event, "text", None)) is str
            and event.text.startswith(NLP_PRIVATE_COMMAND)
        ):
            source.profile = "codex-bridge"
            return {"action": "rewrite", "text": f"{NLP_PRIVATE_COMMAND} invalid"}
        if type(getattr(event, "text", None)) is str and event.text.startswith("/codex"):
            source.profile = "codex-bridge"
            command = _parse_command(event.text)
            if command is None:
                return {"action": "rewrite", "text": f"{PRIVATE_COMMAND} invalid"}
            return signed_command_rewrite(command, provenance)
        route = find_route(snapshot, provenance.stream_id)
        if (
            route is not None
            and route.owner == "PROJECT"
            and _is_route_query(getattr(event, "text", None))
        ):
            source.profile = "codex-bridge"
            return signed_command_rewrite(
                {"type": "ROUTE", "action": "SHOW"}, provenance
            )
        if route is not None and route.owner == "HERMES":
            source.profile = "hermes-general"
        elif (
            route is not None
            and route.owner == "PROJECT"
            and route.project_id is not None
            and type(event.text) is str
            and not event.text.startswith("/")
        ):
            context = RouteContext(
                provenance=provenance,
                project_id=route.project_id,
                topic_mode=route.topic_mode(provenance.topic),
            )
            source.profile = "codex-bridge"
            request_bytes = event.text.encode("utf-8")
            if not request_bytes or len(request_bytes) > MAX_INSTRUCTION_BYTES:
                return {"action": "rewrite", "text": f"{NLP_PRIVATE_COMMAND} invalid"}
            now = _now_seconds()
            nonce = secrets.token_urlsafe(24)
            payload = {
                "version": 1,
                "purpose": NLP_CAPABILITY_PURPOSE,
                "issuedAt": now,
                "expiresAt": now + CONTEXT_LIFETIME_SECONDS,
                "nonce": nonce,
                "binding": _binding(provenance),
                "projectId": context.project_id,
                "topicMode": context.topic_mode,
                "messageSha256": hashlib.sha256(request_bytes).hexdigest(),
                "messageBytes": len(request_bytes),
            }
            entry = PendingRequest(context, event.text, len(request_bytes), payload["expiresAt"])
            try:
                context_token = _sign_context(payload, key)
            except Exception:
                return {"action": "rewrite", "text": f"{NLP_PRIVATE_COMMAND} invalid"}
            if not pending_vault.add(nonce, entry, now):
                return {"action": "rewrite", "text": f"{NLP_PRIVATE_COMMAND} invalid"}
            return {
                "action": "rewrite",
                "text": f"{NLP_PRIVATE_COMMAND} {context_token}",
            }
        elif route is not None and route.owner == "PROJECT":
            source.profile = "codex-bridge"
        elif route is None and snapshot.default_owner == "HERMES":
            source.profile = "hermes-general"
        return {"action": "allow"}

    async def public_command_handler(_raw_args: str):
        return "Invalid /codex command."

    async def route_unavailable_handler(_raw_args: str):
        return ROUTE_UNAVAILABLE_TEXT

    async def private_command_handler(raw_args: str):
        if raw_args == "invalid":
            return "Invalid /codex command."
        try:
            payload = _verify_context(raw_args, key, used_nonces)
        except Exception:
            return "Codex bridge request rejected."
        event = {
            "schemaVersion": 1,
            "kind": "COMMAND",
            "contextToken": raw_args,
            "binding": payload["binding"],
            "command": payload["command"],
        }
        try:
            result = await client.submit(event)
        except BridgeUnavailableError:
            return "Codex bridge unavailable."
        except BridgeProtocolError:
            return "Codex bridge protocol error."
        return _render_bridge_result(result)

    async def natural_command_handler(raw_args: str):
        try:
            _payload, entry = _verify_nlp_capability(raw_args, key, pending_vault)
        except Exception:
            return "Codex bridge request rejected."
        try:
            completion = await llm.acomplete_structured(
                instructions=NLP_INSTRUCTIONS,
                input=[{"type": "text", "text": entry.request}],
                json_schema=SEMANTIC_SCHEMA,
                json_mode=True,
                schema_name="hco_semantic_result",
                temperature=0,
                max_tokens=2_048,
                timeout=30,
                purpose=NLP_CAPABILITY_PURPOSE,
            )
        except Exception:
            return "Hermes model unavailable."
        semantic = getattr(completion, "parsed", None)
        try:
            valid_semantic = _valid_semantic(semantic)
        except Exception:
            return "Hermes model protocol error."
        if not valid_semantic:
            return "Hermes model protocol error."
        context = entry.context
        if (
            context.topic_mode == "HERMES_ONLY"
            and semantic["type"] == "DISPATCH"
            and semantic["topicModeAction"] != "AUTO"
        ):
            return "Codex bridge request rejected."
        if semantic["type"] == "CLARIFY":
            choices = "".join(f"\n- {choice}" for choice in semantic["choices"])
            return f'{semantic["question"]}{choices}'
        if semantic["type"] in {"BUSINESS_REPLY", "REJECT"}:
            return semantic["text"]
        event = {
            "schemaVersion": 1,
            "kind": "SEMANTIC",
            "contextToken": raw_args,
            "binding": _binding(context.provenance),
            "semantic": semantic,
        }
        try:
            result = await client.submit(event)
        except BridgeUnavailableError:
            return "Codex bridge unavailable."
        except BridgeProtocolError:
            return "Codex bridge protocol error."
        return _render_bridge_result(result)

    ctx.register_hook("pre_gateway_dispatch", hook)
    ctx.register_command("codex", public_command_handler, description="Codex bridge")
    ctx.register_command(
        "hermes-codex-bridge-internal",
        private_command_handler,
        description="Internal Codex bridge dispatch",
    )
    ctx.register_command(
        "hermes-codex-bridge-natural",
        natural_command_handler,
        description="Internal natural-language Codex dispatch",
    )
    ctx.register_command(
        "hermes-codex-bridge-route-unavailable",
        route_unavailable_handler,
        description="Internal unavailable-route rejection",
    )
    _write_process_attestation()
