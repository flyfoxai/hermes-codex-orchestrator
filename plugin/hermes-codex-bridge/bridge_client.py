from __future__ import annotations

import asyncio
import json
import socket
from urllib.parse import quote


PLUGIN_VERSION = "1.0.0"
CAPABILITIES = [
    "signed_context",
    "message_binding",
    "nonce_replay",
    "artifact_manifest",
    "project_local_exchange_v1",
    "coordination_mailbox_v1",
    "coordination_recovery_v1",
    "agent_restart_recovery_v1",
    "agent_reports_v1",
]
MAX_REQUEST_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 1_048_576
IO_TIMEOUT_SECONDS = 10
COMPATIBILITY_TIMEOUT_SECONDS = 1.0
MAILBOX_LEASE_MS = 60_000
MAILBOX_ITEM_TYPES = frozenset(
    {
        "CODEX_RECEIPT",
        "INTERACTION_REQUEST",
        "AGENT_REPORT",
        "ORPHAN_RECOVERY_NOTICE",
        "STATUS_NOTICE",
        "AUTHORIZATION_NOTICE",
    }
)


class BridgeUnavailableError(Exception):
    pass


class BridgeUncertainError(Exception):
    """Request may have been written, but response was lost or timed out."""
    pass


class BridgeProtocolError(Exception):
    pass


USER_FACING_ERROR_CODES = frozenset(
    {
        "INTERACTION_DECISION_INVALID",
        "INTERACTION_COMMAND_MISMATCH",
        "INTERACTION_QUESTION_ID_INVALID",
        "INTERACTION_SECRET_ANSWER_FORBIDDEN",
        "INTERACTION_NOT_FOUND",
        "INTERACTION_TARGET_MISMATCH",
        "OBJECTIVE_REQUIRED",
        "OBJECTIVE_NOT_FOUND",
        "OBJECTIVE_PROJECT_MISMATCH",
        "OBJECTIVE_TOPIC_MISMATCH",
        "OBJECTIVE_TOPIC_MIGRATION_REQUIRED",
        "WORK_REQUEST_TOPIC_MISMATCH",
        "ACL_FORBIDDEN",
        "INTERACTION_ORPHANED",
        "INTERACTION_EXPIRED",
        "INTERACTION_UNAUTHORIZED",
        "INTERACTION_ANSWER_CONFLICT",
        "INTERACTION_ANSWER_INVALID",
        "INTERACTION_APPROVAL_RESTRICTED",
        "INTERACTION_ACTION_INVALID",
        "INTERACTION_ACTION_EXPLICIT_REQUIRED",
        "INTERACTION_DETAIL_NOT_DELIVERED",
        "INTERACTION_NATURAL_REPLY_INVALID",
        "INTERACTION_REPLY_SOURCE_CONFLICT",
        "ROUTE_HERMES_OWNED",
        "PROJECT_NOT_FOUND",
        "TOPIC_HERMES_ONLY",
        "ARTIFACT_MANIFEST_INVALID",
        "ARTIFACT_INPUT_MISSING",
        "ARTIFACT_INPUT_INVALID",
        "ARTIFACT_INPUT_HASH_MISMATCH",
        "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE",
        "PROJECT_LOCAL_INPUT_CHANGED",
        "PROJECT_LOCAL_INPUT_INVALID",
        "PROJECT_LOCAL_OUTPUT_MISSING",
        "PROJECT_LOCAL_OUTPUT_INVALID",
        "PROJECT_LOCAL_OUTPUT_CHANGED",
        "DOCUMENT_CONFLICT",
    }
)


class BridgeUserError(Exception):
    """An error with a user-readable message, returned as 4xx from the bridge."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.user_message = message


async def _read_bounded_response(reader: asyncio.StreamReader) -> bytes:
    response = bytearray()
    while True:
        chunk = await reader.read(min(65_536, MAX_RESPONSE_BYTES + 1 - len(response)))
        if not chunk:
            return bytes(response)
        response.extend(chunk)
        if len(response) > MAX_RESPONSE_BYTES:
            raise BridgeProtocolError("invalid response")


class BridgeClient:
    def __init__(self, socket_path: str, bearer_token: bytes) -> None:
        self.socket_path = socket_path
        self.bearer_token = bytes(bearer_token)

    def server_capabilities(self) -> frozenset[str]:
        try:
            authorization = self.bearer_token.decode("ascii")
        except UnicodeDecodeError as exc:
            raise BridgeProtocolError("invalid credentials") from exc
        if not authorization or any(char in authorization for char in "\r\n"):
            raise BridgeProtocolError("invalid credentials")
        capabilities = json.dumps(CAPABILITIES, separators=(",", ":"))
        request = (
            "GET /v1/compatibility HTTP/1.1\r\n"
            "Host: bridge.local\r\n"
            f"Authorization: Bearer {authorization}\r\n"
            "x-hco-protocol-version: 1\r\n"
            f"x-hco-plugin-version: {PLUGIN_VERSION}\r\n"
            f"x-hco-capabilities: {capabilities}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(COMPATIBILITY_TIMEOUT_SECONDS)
        response = bytearray()
        try:
            connection.connect(self.socket_path)
            connection.sendall(request)
            while True:
                chunk = connection.recv(min(65_536, MAX_RESPONSE_BYTES + 1 - len(response)))
                if not chunk:
                    break
                response.extend(chunk)
                if len(response) > MAX_RESPONSE_BYTES:
                    raise BridgeProtocolError("invalid response")
        except (OSError, TimeoutError) as exc:
            raise BridgeUnavailableError("bridge unavailable") from exc
        finally:
            connection.close()
        document = _parse_http_document(bytes(response))
        if set(document) != {"compatibility", "serverCapabilities", "hco"}:
            raise BridgeProtocolError("invalid response")
        values = document.get("serverCapabilities")
        if type(values) is not list or any(type(value) is not str or not value for value in values):
            return frozenset()
        return frozenset(values)

    def _sync_post(self, route: str, payload: dict) -> dict:
        envelope = {
            "protocolVersion": 1,
            "pluginVersion": PLUGIN_VERSION,
            "capabilities": CAPABILITIES,
            **payload,
        }
        try:
            body = json.dumps(
                envelope, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            authorization = self.bearer_token.decode("ascii")
        except (TypeError, ValueError, UnicodeDecodeError) as exc:
            raise BridgeProtocolError("invalid request") from exc
        if (
            not body
            or len(body) > MAX_REQUEST_BYTES
            or not authorization
            or any(char in authorization for char in "\r\n")
            or not route.startswith("/v1/")
            or any(char in route for char in "\r\n")
        ):
            raise BridgeProtocolError("invalid request")
        request = (
            f"POST {route} HTTP/1.1\r\n"
            "Host: bridge.local\r\n"
            f"Authorization: Bearer {authorization}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii") + body
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(IO_TIMEOUT_SECONDS)
        response = bytearray()
        write_succeeded = False
        try:
            connection.connect(self.socket_path)
            connection.sendall(request)
            write_succeeded = True
            while True:
                chunk = connection.recv(
                    min(65_536, MAX_RESPONSE_BYTES + 1 - len(response))
                )
                if not chunk:
                    break
                response.extend(chunk)
                if len(response) > MAX_RESPONSE_BYTES:
                    raise BridgeProtocolError("invalid response")
        except (OSError, TimeoutError) as exc:
            if write_succeeded:
                raise BridgeUncertainError("response unavailable after write") from exc
            raise BridgeUnavailableError("bridge unavailable") from exc
        finally:
            connection.close()
        return _parse_response(bytes(response))

    def claim_mailbox(
        self,
        *,
        target_kind: str,
        target_id: str,
        codex_call_id: str | None,
        mailbox_item_id: str | None = None,
        worker_id: str,
        lease_ms: int = MAILBOX_LEASE_MS,
    ) -> list[dict]:
        if (
            target_kind not in {"JARVIS", "AGENT"}
            or type(target_id) is not str
            or not target_id
            or (codex_call_id is not None and (type(codex_call_id) is not str or not codex_call_id))
            or (mailbox_item_id is not None and (type(mailbox_item_id) is not str or not mailbox_item_id))
            or type(worker_id) is not str
            or not worker_id
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            "/v1/mailbox/claim",
            {
                "targetKind": target_kind,
                "targetId": target_id,
                "codexCallId": codex_call_id,
                "mailboxItemId": mailbox_item_id,
                "workerId": worker_id,
                "limit": 1,
                "leaseMs": lease_ms,
            },
        )
        if set(result) != {"items"} or type(result["items"]) is not list:
            raise BridgeProtocolError("invalid response")
        items = result["items"]
        if len(items) > 1:
            raise BridgeProtocolError("invalid response")
        for item in items:
            if not _valid_mailbox_item(
                item,
                target_kind=target_kind,
                target_id=target_id,
                codex_call_id=codex_call_id,
                mailbox_item_id=mailbox_item_id,
            ):
                raise BridgeProtocolError("invalid response")
        return items

    def ack_mailbox(
        self,
        *,
        mailbox_item_id: str,
        lease_token: str,
        final_delivery: bool,
    ) -> dict:
        if (
            type(mailbox_item_id) is not str
            or not mailbox_item_id
            or type(lease_token) is not str
            or not lease_token
            or type(final_delivery) is not bool
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            f"/v1/mailbox/{quote(mailbox_item_id, safe='')}/ack",
            {"leaseToken": lease_token, "finalDelivery": final_delivery},
        )
        if (
            set(result) != {"duplicate", "mailboxItem", "workRequest"}
            or type(result["duplicate"]) is not bool
            or type(result["mailboxItem"]) is not dict
            or type(result["workRequest"]) is not dict
        ):
            raise BridgeProtocolError("invalid response")
        return result

    def renew_mailbox(
        self,
        *,
        mailbox_item_id: str,
        lease_token: str,
        lease_ms: int = MAILBOX_LEASE_MS,
    ) -> dict:
        if (
            type(mailbox_item_id) is not str
            or not mailbox_item_id
            or type(lease_token) is not str
            or not lease_token
            or type(lease_ms) is not int
            or lease_ms <= 0
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            f"/v1/mailbox/{quote(mailbox_item_id, safe='')}/renew",
            {"leaseToken": lease_token, "leaseMs": lease_ms},
        )
        if set(result) != {"mailboxItem"} or type(result["mailboxItem"]) is not dict:
            raise BridgeProtocolError("invalid response")
        return result

    def nack_mailbox(
        self,
        *,
        mailbox_item_id: str,
        lease_token: str,
        error: str,
        retryable: bool,
    ) -> dict:
        if (
            type(mailbox_item_id) is not str
            or not mailbox_item_id
            or type(lease_token) is not str
            or not lease_token
            or type(error) is not str
            or not error
            or len(error.encode("utf-8")) > 4096
            or type(retryable) is not bool
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            f"/v1/mailbox/{quote(mailbox_item_id, safe='')}/nack",
            {"leaseToken": lease_token, "error": error, "retryable": retryable},
        )
        if (
            set(result) != {"mailboxItem", "workRequest", "retryable"}
            or type(result["mailboxItem"]) is not dict
            or type(result["workRequest"]) is not dict
            or type(result["retryable"]) is not bool
            or result["mailboxItem"].get("state") not in {"PENDING", "DEAD"}
        ):
            raise BridgeProtocolError("invalid response")
        return result

    def list_mailbox_recovery(self, *, worker_id: str, limit: int = 100) -> list[dict]:
        if (
            type(worker_id) is not str
            or not worker_id
            or type(limit) is not int
            or not 0 < limit <= 100
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            "/v1/mailbox/recovery", {"workerId": worker_id, "limit": limit}
        )
        if set(result) != {"items"} or type(result["items"]) is not list:
            raise BridgeProtocolError("invalid response")
        if len(result["items"]) > limit or any(
            not _valid_recovery_item(item) for item in result["items"]
        ):
            raise BridgeProtocolError("invalid response")
        return result["items"]

    def abandon_mailbox_recovery(
        self,
        *,
        mailbox_item_id: str,
        expected_state: str,
        expected_attempt_count: int,
        reason: str,
    ) -> dict:
        if (
            type(mailbox_item_id) is not str
            or not mailbox_item_id
            or expected_state not in {"PENDING", "LEASED"}
            or type(expected_attempt_count) is not int
            or expected_attempt_count < 0
            or reason not in {
                "recovery_outcome_unverified",
                "caller_session_unavailable",
                "recovery_scope_mismatch",
            }
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            f"/v1/mailbox/{quote(mailbox_item_id, safe='')}/abandon",
            {
                "expectedState": expected_state,
                "expectedAttemptCount": expected_attempt_count,
                "reason": reason,
            },
        )
        if (
            set(result) != {"duplicate", "mailboxItem", "workRequest"}
            or type(result["duplicate"]) is not bool
            or type(result["mailboxItem"]) is not dict
            or type(result["workRequest"]) is not dict
            or result["mailboxItem"].get("state") != "DEAD"
        ):
            raise BridgeProtocolError("invalid response")
        orphan_transferred = (
            result["mailboxItem"].get("targetKind") == "AGENT"
            and type(result["mailboxItem"].get("lastError")) is str
            and result["mailboxItem"]["lastError"].startswith("orphaned:")
        )
        work_state = result["workRequest"].get("state")
        if (
            orphan_transferred
            and work_state
            not in {
                "RUNNING",
                "WAITING_AGENT",
                "WAITING_CODEX",
                "WAITING_HUMAN",
                "STATUS_UNVERIFIED",
                "DEGRADED_PENDING_OPERATOR",
                "COMPLETED",
                "PARTIAL",
                "FAILED",
                "CANCELLED",
            }
        ) or (
            not orphan_transferred
            and work_state != "DEGRADED_PENDING_OPERATOR"
        ):
            raise BridgeProtocolError("invalid response")
        return result

    def list_agent_restart_recovery(
        self, *, started_before: int, limit: int = 100
    ) -> list[dict]:
        if (
            type(started_before) is not int
            or started_before <= 0
            or type(limit) is not int
            or not 0 < limit <= 100
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            "/v1/agents/recovery",
            {"startedBefore": started_before, "limit": limit},
        )
        if set(result) != {"items"} or type(result["items"]) is not list:
            raise BridgeProtocolError("invalid response")
        if len(result["items"]) > limit or any(
            not _valid_agent_restart_recovery_item(item)
            for item in result["items"]
        ):
            raise BridgeProtocolError("invalid response")
        return result["items"]

    def orphan_agent_restart(
        self,
        *,
        agent_session_id: str,
        agent_activation_id: str,
        expected_state: str,
        started_before: int,
        reason: str = "hermes_restart_outcome_unverified",
    ) -> dict:
        if (
            type(agent_session_id) is not str
            or not agent_session_id
            or type(agent_activation_id) is not str
            or not agent_activation_id
            or expected_state not in {"RUNNING", "WAITING_CHILDREN"}
            or type(started_before) is not int
            or started_before <= 0
            or reason != "hermes_restart_outcome_unverified"
        ):
            raise BridgeProtocolError("invalid request")
        result = self._sync_post(
            f"/v1/agents/{quote(agent_session_id, safe='')}/orphan",
            {
                "agentActivationId": agent_activation_id,
                "expectedState": expected_state,
                "startedBefore": started_before,
                "reason": reason,
            },
        )
        if (
            set(result) != {
                "duplicate",
                "agentSession",
                "workRequest",
                "mailboxItem",
            }
            or type(result["duplicate"]) is not bool
            or type(result["agentSession"]) is not dict
            or result["agentSession"].get("state") != "FAILED_ORPHANED"
            or type(result["workRequest"]) is not dict
            or (
                result["mailboxItem"] is not None
                and (
                    type(result["mailboxItem"]) is not dict
                    or result["mailboxItem"].get("itemType")
                    != "ORPHAN_RECOVERY_NOTICE"
                    or result["mailboxItem"].get("state")
                    not in {"PENDING", "LEASED", "ACKED", "DEAD"}
                )
            )
            or (
                result["mailboxItem"] is None
                and result["workRequest"].get("state")
                != "DEGRADED_PENDING_OPERATOR"
            )
        ):
            raise BridgeProtocolError("invalid response")
        return result

    def report_agent_stop(
        self,
        *,
        source_id: str,
        child_hermes_session_id: str,
        parent_hermes_session_id: str,
        child_status: str,
        summary: str,
        duration_ms: int,
    ) -> dict:
        result = self._sync_post(
            "/v1/agents/report",
            {
                "sourceId": source_id,
                "childHermesSessionId": child_hermes_session_id,
                "parentHermesSessionId": parent_hermes_session_id,
                "childStatus": child_status,
                "summary": summary,
                "durationMs": duration_ms,
            },
        )
        expected = {
            "duplicate",
            "disposition",
            "reportId",
            "agentSessionId",
            "agentActivationId",
            "activeCodexCalls",
            "mailboxItemId",
            "mailboxTarget",
        }
        if type(result) is not dict or set(result) != expected:
            raise BridgeProtocolError("invalid response")
        if (
            type(result["duplicate"]) is not bool
            or result["disposition"] not in {"UNTRACKED", "WAITING_CODEX", "REPORTED"}
            or type(result["activeCodexCalls"]) is not int
            or result["activeCodexCalls"] < 0
        ):
            raise BridgeProtocolError("invalid response")
        nullable_ids = (
            "reportId",
            "agentSessionId",
            "agentActivationId",
            "mailboxItemId",
        )
        if any(
            result[key] is not None
            and (type(result[key]) is not str or not result[key])
            for key in nullable_ids
        ):
            raise BridgeProtocolError("invalid response")
        mailbox_target = result["mailboxTarget"]
        if mailbox_target is not None and (
            type(mailbox_target) is not dict
            or set(mailbox_target) != {"kind", "id"}
            or mailbox_target.get("kind") not in {"JARVIS", "AGENT"}
            or type(mailbox_target.get("id")) is not str
            or not mailbox_target["id"]
        ):
            raise BridgeProtocolError("invalid response")
        if result["disposition"] == "UNTRACKED" and any(
            result[key] is not None for key in nullable_ids
        ):
            raise BridgeProtocolError("invalid response")
        if result["disposition"] == "WAITING_CODEX" and (
            result["agentSessionId"] is None
            or result["agentActivationId"] is None
            or result["activeCodexCalls"] == 0
            or result["reportId"] is not None
            or result["mailboxItemId"] is not None
            or mailbox_target is not None
        ):
            raise BridgeProtocolError("invalid response")
        if result["disposition"] == "REPORTED" and (
            result["reportId"] is None
            or result["agentSessionId"] is None
            or result["agentActivationId"] is None
            or result["activeCodexCalls"] != 0
            or result["mailboxItemId"] is None
            or mailbox_target is None
        ):
            raise BridgeProtocolError("invalid response")
        return result

    async def submit(self, event: dict) -> dict:
        envelope = {
            "protocolVersion": 1,
            "pluginVersion": PLUGIN_VERSION,
            "capabilities": CAPABILITIES,
            "event": event,
        }
        try:
            body = json.dumps(
                envelope, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise BridgeProtocolError("invalid request") from exc
        if not body or len(body) > MAX_REQUEST_BYTES:
            raise BridgeProtocolError("invalid request")

        try:
            authorization = self.bearer_token.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BridgeProtocolError("invalid credentials") from exc
        if not authorization or any(char in authorization for char in "\r\n"):
            raise BridgeProtocolError("invalid credentials")

        request = (
            "POST /v1/events HTTP/1.1\r\n"
            "Host: bridge.local\r\n"
            f"Authorization: Bearer {authorization}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii") + body

        writer = None
        write_succeeded = False
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=IO_TIMEOUT_SECONDS,
            )
            writer.write(request)
            write_succeeded = True
            await asyncio.wait_for(writer.drain(), timeout=IO_TIMEOUT_SECONDS)
            response = await asyncio.wait_for(
                _read_bounded_response(reader), timeout=IO_TIMEOUT_SECONDS
            )
        except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
            if write_succeeded:
                # Request may have been written; response lost or timed out
                raise BridgeUncertainError("response unavailable after write") from exc
            # Prewrite failure: connection or write failed
            raise BridgeUnavailableError("bridge unavailable") from exc
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

        if not response or len(response) > MAX_RESPONSE_BYTES:
            raise BridgeProtocolError("invalid response")
        return _parse_response(response)


def _parse_http_document(response: bytes) -> dict:
    try:
        header, body_bytes = response.split(b"\r\n\r\n", 1)
        lines = header.split(b"\r\n")
        status_parts = lines[0].split(b" ", 2)
        if len(status_parts) != 3 or status_parts[0] != b"HTTP/1.1":
            raise ValueError
        status = int(status_parts[1])
        headers: dict[bytes, bytes] = {}
        for line in lines[1:]:
            name, value = line.split(b":", 1)
            name = name.strip().lower()
            if not name or name in headers:
                raise ValueError
            headers[name] = value.strip()
        length_value = headers.get(b"content-length")
        if length_value is None or not length_value.isdigit():
            raise ValueError
        length = int(length_value)
        if length != len(body_bytes) or length > MAX_RESPONSE_BYTES:
            raise ValueError
        body = json.loads(body_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise BridgeProtocolError("invalid response") from exc

    if type(body) is not dict:
        raise BridgeProtocolError("invalid response")
    if status != 200:
        error = body.get("error")
        if (
            set(body) != {"error"}
            or type(error) is not dict
            or set(error) != {"code", "message"}
            or type(error.get("code")) is not str
            or type(error.get("message")) is not str
        ):
            raise BridgeProtocolError("invalid error response")
        if 400 <= status < 500 and error["code"] in USER_FACING_ERROR_CODES:
            raise BridgeUserError(error["code"], error["message"])
        raise BridgeProtocolError("bridge rejected request")
    return body


def _parse_response(response: bytes) -> dict:
    body = _parse_http_document(response)
    if set(body) != {"result"} or type(body["result"]) is not dict:
        raise BridgeProtocolError("invalid response")
    return body["result"]


def _valid_mailbox_item(
    item: object,
    *,
    target_kind: str,
    target_id: str,
    codex_call_id: str | None,
    mailbox_item_id: str | None = None,
) -> bool:
    expected = {
        "mailboxItemId",
        "targetKind",
        "targetId",
        "workRequestId",
        "codexCallId",
        "itemType",
        "semanticKey",
        "payload",
        "state",
        "attemptCount",
        "leaseOwner",
        "leaseToken",
        "leaseExpiresAt",
        "createdAt",
        "updatedAt",
        "acknowledgedAt",
        "lastError",
    }
    if type(item) is not dict or set(item) != expected:
        return False
    required_text = (
        "mailboxItemId",
        "targetId",
        "workRequestId",
        "semanticKey",
        "leaseOwner",
        "leaseToken",
    )
    return (
        item["targetKind"] == target_kind
        and item["targetId"] == target_id
        and (mailbox_item_id is None or item["mailboxItemId"] == mailbox_item_id)
        and item["codexCallId"] == codex_call_id
        and item["itemType"] in MAILBOX_ITEM_TYPES
        and item["state"] == "LEASED"
        and all(type(item[key]) is str and item[key] for key in required_text)
        and type(item["payload"]) is dict
        and (item["codexCallId"] is None or (type(item["codexCallId"]) is str and item["codexCallId"]))
        and all(
            type(item[key]) is int and item[key] >= 0
            for key in (
                "attemptCount",
                "leaseExpiresAt",
                "createdAt",
                "updatedAt",
            )
        )
        and item["acknowledgedAt"] is None
        and item["lastError"] is None
    )


def _valid_recovery_item(item: object) -> bool:
    expected = {
        "mailboxItem",
        "projectId",
        "topicContextId",
        "streamId",
        "topic",
        "topicState",
        "topicContextRevision",
        "workContextRevision",
        "requesterUserId",
        "originalZulipMessageId",
        "workBrief",
        "callerHermesSessionId",
        "parentHermesSessionId",
        "agentRole",
    }
    if type(item) is not dict or set(item) != expected:
        return False
    mailbox = item["mailboxItem"]
    mailbox_keys = {
        "mailboxItemId",
        "targetKind",
        "targetId",
        "workRequestId",
        "codexCallId",
        "itemType",
        "semanticKey",
        "payload",
        "state",
        "attemptCount",
        "leaseOwner",
        "leaseToken",
        "leaseExpiresAt",
        "createdAt",
        "updatedAt",
        "acknowledgedAt",
        "lastError",
    }
    if type(mailbox) is not dict or set(mailbox) != mailbox_keys:
        return False
    required_text = (
        "mailboxItemId",
        "targetId",
        "workRequestId",
        "semanticKey",
    )
    nullable_text = (
        "codexCallId",
        "leaseOwner",
        "leaseToken",
        "lastError",
    )
    top_text = ("projectId", "topicContextId", "topic", "topicState")
    caller = item["callerHermesSessionId"]
    parent = item["parentHermesSessionId"]
    role = item["agentRole"]
    return (
        mailbox["targetKind"] in {"JARVIS", "AGENT"}
        and mailbox["itemType"] in MAILBOX_ITEM_TYPES
        and mailbox["state"] in {"PENDING", "LEASED"}
        and all(type(mailbox[key]) is str and mailbox[key] for key in required_text)
        and all(
            mailbox[key] is None or (type(mailbox[key]) is str and mailbox[key])
            for key in nullable_text
        )
        and type(mailbox["payload"]) is dict
        and all(
            type(mailbox[key]) is int and mailbox[key] >= 0
            for key in ("attemptCount", "createdAt", "updatedAt")
        )
        and (
            mailbox["leaseExpiresAt"] is None
            or (type(mailbox["leaseExpiresAt"]) is int and mailbox["leaseExpiresAt"] >= 0)
        )
        and mailbox["acknowledgedAt"] is None
        and all(type(item[key]) is str and item[key] for key in top_text)
        and item["topicState"] in {"ACTIVE", "TOPIC_ADDRESS_UNVERIFIED", "ARCHIVED"}
        and all(
            type(item[key]) is int and item[key] > 0
            for key in (
                "streamId",
                "topicContextRevision",
                "workContextRevision",
                "requesterUserId",
                "originalZulipMessageId",
            )
        )
        and type(item["workBrief"]) is dict
        and (caller is None or (type(caller) is str and caller))
        and (parent is None or (type(parent) is str and parent))
        and (role is None or (type(role) is str and role))
        and (
            (mailbox["targetKind"] == "JARVIS" and parent is None and role is None)
            or (mailbox["targetKind"] == "AGENT" and parent is not None and role is not None)
        )
    )


def _valid_agent_restart_recovery_item(item: object) -> bool:
    expected = {
        "agentSessionId",
        "hermesSessionId",
        "agentState",
        "agentActivationId",
        "activationState",
        "activationStartedAt",
        "workRequestId",
        "topicContextId",
        "projectId",
        "parentHermesSessionId",
        "jarvisSessionId",
    }
    if type(item) is not dict or set(item) != expected:
        return False
    required_text = (
        "agentSessionId",
        "hermesSessionId",
        "agentActivationId",
        "workRequestId",
        "topicContextId",
        "projectId",
    )
    return (
        item["agentState"] in {"RUNNING", "WAITING_CHILDREN"}
        and item["activationState"] == item["agentState"]
        and all(type(item[key]) is str and item[key] for key in required_text)
        and type(item["activationStartedAt"]) is int
        and item["activationStartedAt"] >= 0
        and (
            item["parentHermesSessionId"] is None
            or (
                type(item["parentHermesSessionId"]) is str
                and item["parentHermesSessionId"]
            )
        )
        and (
            item["jarvisSessionId"] is None
            or (type(item["jarvisSessionId"]) is str and item["jarvisSessionId"])
        )
    )
