from __future__ import annotations

import base64
import hashlib
import hmac
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


def register(ctx) -> None:
    try:
        key, token, socket_path, snapshot_path = _load_registration_config()
    except Exception:
        return

    client = BridgeClient(socket_path, token)
    llm = ctx.llm
    used_nonces: dict[str, int] = {}
    pending_vault = PendingVault()

    def hook(**kwargs):
        event = kwargs.get("event")
        source = getattr(event, "source", None)
        if source is None:
            return {"action": "allow"}
        source.profile = None
        provenance = _extract_provenance(event)
        if provenance is None:
            return {"action": "allow"}
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
            return {
                "action": "rewrite",
                "text": f"{PRIVATE_COMMAND} {context_token}",
            }
        route = find_route(load_route_snapshot(snapshot_path), provenance.stream_id)
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
        return {"action": "allow"}

    async def public_command_handler(_raw_args: str):
        return "Invalid /codex command."

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
        try:
            return json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return "Codex bridge protocol error."

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
        try:
            return json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return "Codex bridge protocol error."

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
