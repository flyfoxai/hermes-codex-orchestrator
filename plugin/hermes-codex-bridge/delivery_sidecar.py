from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import socket
import stat
import sys
import threading
from dataclasses import dataclass
from urllib.parse import quote

from zulip_sender import ZulipSender


PROTOCOL_VERSION = 1
PLUGIN_VERSION = "1.0.0"
CAPABILITIES: list[str] = []
MAX_RESPONSE_BYTES = 1_048_576
IO_TIMEOUT_SECONDS = 10.0
MAX_IDENTIFIER_BYTES = 512
MAX_CONTENT_BYTES = 65_536
MAX_TOPIC_BYTES = 256
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_SECRET_BYTES = 4_096
MAX_PATH_BYTES = 4_096
MAX_WORKER_ID_BYTES = 4_096
MAX_CLAIM_LIMIT = 100
MAX_LEASE_MS = 24 * 60 * 60 * 1_000
MAX_POLL_SECONDS = 60.0


@dataclass(frozen=True)
class RuntimeConfig:
    socket_path: str
    bearer_path: str
    zulip_config_path: str
    worker_id: str
    claim_limit: int
    lease_ms: int
    poll_seconds: float


def _invalid_credentials(error: BaseException | None = None) -> ValueError:
    failure = ValueError("invalid credentials")
    if error is not None:
        failure.__cause__ = error
    return failure


def load_bearer_file(path: str) -> bytes:
    if type(path) is not str or not os.path.isabs(path):
        raise _invalid_credentials()
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        info = os.fstat(descriptor)
        current_uid = os.getuid() if hasattr(os, "getuid") else info.st_uid
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != current_uid
            or info.st_mode & 0o077
            or info.st_size < 1
            or info.st_size > MAX_SECRET_BYTES
        ):
            raise _invalid_credentials()
        chunks = []
        remaining = MAX_SECRET_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        token = b"".join(chunks)
        if len(token) < 1 or len(token) > MAX_SECRET_BYTES:
            raise _invalid_credentials()
        return token
    except ValueError:
        raise
    except (OSError, TypeError) as error:
        raise _invalid_credentials(error)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _absolute_path(value: str) -> str:
    if (
        type(value) is not str
        or not os.path.isabs(value)
        or not value.encode("utf-8")
        or len(value.encode("utf-8")) > MAX_PATH_BYTES
    ):
        raise argparse.ArgumentTypeError("expected an absolute path")
    return value


def _worker_id(value: str) -> str:
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise argparse.ArgumentTypeError("invalid worker ID") from error
    if not value.strip() or len(encoded) > MAX_WORKER_ID_BYTES:
        raise argparse.ArgumentTypeError("invalid worker ID")
    return value


def _bounded_integer(minimum: int, maximum: int):
    def parse(value: str) -> int:
        try:
            parsed = int(value, 10)
        except ValueError as error:
            raise argparse.ArgumentTypeError("expected an integer") from error
        if parsed < minimum or parsed > maximum:
            raise argparse.ArgumentTypeError("integer is outside the allowed range")
        return parsed

    return parse


def _poll_seconds(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected seconds") from error
    if not 0 < parsed <= MAX_POLL_SECONDS:
        raise argparse.ArgumentTypeError("seconds are outside the allowed range")
    return parsed


def runtime_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the HCO Zulip delivery sidecar.")
    parser.add_argument("--socket-path", required=True, type=_absolute_path)
    parser.add_argument("--hco-bearer-file", required=True, type=_absolute_path)
    parser.add_argument("--zulip-config-file", required=True, type=_absolute_path)
    parser.add_argument("--worker-id", required=True, type=_worker_id)
    parser.add_argument("--claim-limit", type=_bounded_integer(1, MAX_CLAIM_LIMIT), default=10)
    parser.add_argument("--lease-ms", type=_bounded_integer(1, MAX_LEASE_MS), default=30_000)
    parser.add_argument("--poll-seconds", type=_poll_seconds, default=1.0)
    return parser


def parse_runtime_args(arguments: list[str] | None = None) -> RuntimeConfig:
    parsed = runtime_argument_parser().parse_args(arguments)
    return RuntimeConfig(
        socket_path=parsed.socket_path,
        bearer_path=parsed.hco_bearer_file,
        zulip_config_path=parsed.zulip_config_file,
        worker_id=parsed.worker_id,
        claim_limit=parsed.claim_limit,
        lease_ms=parsed.lease_ms,
        poll_seconds=parsed.poll_seconds,
    )


class HcoError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class _UnixHttpConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str) -> None:
        super().__init__("bridge.local", timeout=IO_TIMEOUT_SECONDS)
        self.socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        connection.connect(self.socket_path)
        self.sock = connection


class HcoClient:
    def __init__(
        self,
        socket_path: str,
        bearer_token: bytes,
        worker_id: str,
        claim_limit: int,
        lease_ms: int,
    ) -> None:
        try:
            encoded_authorization = bytes(bearer_token)
        except (TypeError, ValueError):
            encoded_authorization = b""
        if not encoded_authorization or any(
            byte < 0x21 or byte > 0x7E for byte in encoded_authorization
        ):
            raise ValueError("invalid credentials")
        authorization = encoded_authorization.decode("ascii")
        self.socket_path = socket_path
        self._authorization = authorization
        self.redaction_secrets = (authorization,)
        self.worker_id = worker_id
        self.claim_limit = claim_limit
        self.lease_ms = lease_ms

    @staticmethod
    def _metadata() -> dict:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "pluginVersion": PLUGIN_VERSION,
            "capabilities": CAPABILITIES,
        }

    def _request(self, method: str, route: str, body: dict | None = None) -> dict:
        headers = {
            "Host": "bridge.local",
            "Authorization": f"Bearer {self._authorization}",
        }
        encoded = None
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection = _UnixHttpConnection(self.socket_path)
        try:
            connection.request(method, route, body=encoded, headers=headers)
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
        except (OSError, TimeoutError, http.client.HTTPException) as exc:
            raise HcoError(0, "HCO_UNAVAILABLE", "HCO unavailable.") from exc
        finally:
            connection.close()
        if len(payload) > MAX_RESPONSE_BYTES:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.")
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.") from exc
        if type(document) is not dict:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.")
        if status != 200:
            error = document.get("error")
            if type(error) is not dict or type(error.get("code")) is not str:
                raise HcoError(status, "HCO_RESPONSE_INVALID", "HCO response is invalid.")
            raise HcoError(status, error["code"], "HCO rejected request.")
        return document

    def check_compatibility(self) -> None:
        headers = {
            "Host": "bridge.local",
            "Authorization": f"Bearer {self._authorization}",
            "x-hco-protocol-version": str(PROTOCOL_VERSION),
            "x-hco-plugin-version": PLUGIN_VERSION,
            "x-hco-capabilities": json.dumps(CAPABILITIES, separators=(",", ":")),
        }
        connection = _UnixHttpConnection(self.socket_path)
        try:
            connection.request("GET", "/v1/compatibility", headers=headers)
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
        except (OSError, TimeoutError, http.client.HTTPException) as exc:
            raise HcoError(0, "HCO_UNAVAILABLE", "HCO unavailable.") from exc
        finally:
            connection.close()
        if len(payload) > MAX_RESPONSE_BYTES:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.")
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.") from exc
        if status != 200:
            error = document.get("error") if type(document) is dict else None
            code = error.get("code") if type(error) is dict and type(error.get("code")) is str else "HCO_RESPONSE_INVALID"
            raise HcoError(status, code, "HCO compatibility failed.")
        expected = {
            "protocolVersion": PROTOCOL_VERSION,
            "peerPluginVersion": PLUGIN_VERSION,
            "capabilities": CAPABILITIES,
        }
        if type(document) is not dict or document.get("compatibility") != expected:
            raise HcoError(status, "HCO_INCOMPATIBLE", "HCO compatibility failed.")

    def check_health(self) -> None:
        document = self._request("GET", "/v1/health")
        if document != {"status": "ok", "appServer": {"available": True}}:
            raise HcoError(0, "HCO_APP_SERVER_UNAVAILABLE", "HCO App Server unavailable.")

    def claim(self) -> list:
        response = self._request(
            "POST",
            "/v1/outbox/claim",
            {
                **self._metadata(),
                "workerId": self.worker_id,
                "limit": self.claim_limit,
                "leaseMs": self.lease_ms,
            },
        )
        deliveries = response.get("deliveries")
        if type(deliveries) is not list:
            raise HcoError(0, "HCO_RESPONSE_INVALID", "HCO response is invalid.")
        return deliveries

    def ack(self, delivery_id: str, lease_token: str, zulip_message_id: int) -> None:
        self._request(
            "POST",
            f"/v1/outbox/{quote(delivery_id, safe='')}/ack",
            {
                **self._metadata(),
                "leaseToken": lease_token,
                "zulipMessageId": zulip_message_id,
            },
        )

    def nack(self, delivery_id: str, lease_token: str, error: str, retryable: bool) -> None:
        self._request(
            "POST",
            f"/v1/outbox/{quote(delivery_id, safe='')}/nack",
            {
                **self._metadata(),
                "leaseToken": lease_token,
                "error": error,
                "retryable": retryable,
            },
        )


class DeliverySidecar:
    def __init__(
        self,
        hco: HcoClient,
        sender: object,
        *,
        poll_seconds: float = 1.0,
        diagnostic_sink=None,
        after_send=None,
    ) -> None:
        if (
            type(poll_seconds) not in {int, float}
            or type(poll_seconds) is bool
            or not 0 < poll_seconds <= MAX_POLL_SECONDS
        ):
            raise ValueError("invalid poll interval")
        self.hco = hco
        self.sender = sender
        self.poll_seconds = poll_seconds
        self._diagnostic_sink = diagnostic_sink or (
            lambda message: print(message, file=sys.stderr, flush=True)
        )
        self._after_send = after_send or (lambda _claim, _result: None)
        self._secrets = tuple(getattr(hco, "redaction_secrets", ())) + tuple(
            getattr(sender, "secrets", ())
        )
        self._stop = threading.Event()

    def request_stop(self) -> None:
        self._stop.set()

    @staticmethod
    def _bounded_text(value: object, maximum: int, *, allow_empty: bool = False) -> bool:
        if type(value) is not str:
            return False
        try:
            length = len(value.encode("utf-8"))
        except UnicodeEncodeError:
            return False
        return length <= maximum and (allow_empty or length > 0)

    @classmethod
    def _identity(cls, claim: object) -> tuple[str, str] | None:
        if type(claim) is not dict:
            return None
        delivery_id = claim.get("deliveryId")
        lease_token = claim.get("leaseToken")
        if not cls._bounded_text(delivery_id, MAX_IDENTIFIER_BYTES):
            return None
        if not cls._bounded_text(lease_token, MAX_IDENTIFIER_BYTES):
            return None
        return delivery_id, lease_token

    @classmethod
    def _validated_claim(cls, claim: object) -> tuple[str, str, int, str, str] | None:
        identity = cls._identity(claim)
        if identity is None or type(claim) is not dict:
            return None
        payload = claim.get("payload")
        target = claim.get("targetSnapshot")
        if type(payload) is not dict or type(target) is not dict:
            return None
        content = payload.get("content")
        stream_id = target.get("streamId")
        topic = target.get("topic")
        if (
            not cls._bounded_text(content, MAX_CONTENT_BYTES, allow_empty=True)
            or target.get("platform") != "zulip"
            or type(stream_id) is not int
            or stream_id <= 0
            or stream_id > MAX_SAFE_INTEGER
            or not cls._bounded_text(topic, MAX_TOPIC_BYTES)
        ):
            return None
        return (*identity, stream_id, topic, content)

    def _bounded_diagnostic(self, value: object) -> str:
        text = str(value)
        for secret in sorted(
            (secret for secret in self._secrets if type(secret) is str and secret),
            key=len,
            reverse=True,
        ):
            text = text.replace(secret, "***MASKED***")
        encoded = text.encode("utf-8", errors="replace")
        if len(encoded) > 256:
            text = encoded[:256].decode("utf-8", errors="ignore")
        return text

    def _settle(self, operation, *arguments) -> None:
        try:
            operation(*arguments)
        except HcoError as error:
            if error.status == 409 and error.code in {
                "OUTBOX_LEASE_STALE",
                "OUTBOX_LEASE_EXPIRED",
            }:
                self._diagnostic_sink(f"HCO_LEASE_CONFLICT:{error.code}")
            else:
                self._diagnostic_sink("HCO_SETTLEMENT_FAILED")
        except Exception:
            self._diagnostic_sink("HCO_SETTLEMENT_FAILED")

    def process_claim(self, claim: object) -> None:
        validated = self._validated_claim(claim)
        if validated is None:
            identity = self._identity(claim)
            if identity is not None:
                self._settle(self.hco.nack, *identity, "CLAIM_INVALID", False)
            return
        delivery_id, lease_token, stream_id, topic, content = validated
        result = self.sender.send(stream_id, topic, content)
        self._after_send(claim, result)
        if result.message_id is not None:
            self._settle(self.hco.ack, delivery_id, lease_token, result.message_id)
        else:
            self._settle(
                self.hco.nack,
                delivery_id,
                lease_token,
                self._bounded_diagnostic(result.diagnostic),
                result.retryable,
            )

    def process_deliveries(self, deliveries: list) -> None:
        for claim in deliveries:
            if self._stop.is_set():
                break
            self.process_claim(claim)

    def run(self) -> None:
        self.hco.check_compatibility()
        while not self._stop.is_set():
            try:
                deliveries = self.hco.claim()
            except Exception:
                self._diagnostic_sink("HCO_CLAIM_FAILED")
                self._stop.wait(self.poll_seconds)
                continue
            self.process_deliveries(deliveries)
            if not deliveries:
                self._stop.wait(self.poll_seconds)


def build_sidecar(config: RuntimeConfig) -> DeliverySidecar:
    bearer_token = load_bearer_file(config.bearer_path)
    hco = HcoClient(
        config.socket_path,
        bearer_token,
        config.worker_id,
        config.claim_limit,
        config.lease_ms,
    )
    sender = ZulipSender(config.zulip_config_path)
    return DeliverySidecar(hco, sender, poll_seconds=config.poll_seconds)


def install_signal_handlers(sidecar: DeliverySidecar) -> None:
    def request_stop(_signal_number, _frame) -> None:
        sidecar.request_stop()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)


def main(arguments: list[str] | None = None) -> int:
    try:
        config = parse_runtime_args(arguments)
        sidecar = build_sidecar(config)
        install_signal_handlers(sidecar)
        sidecar.run()
    except Exception:
        print("DELIVERY_SIDECAR_FAILED", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
