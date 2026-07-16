from __future__ import annotations

import json
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import traceback
from collections import deque
from pathlib import Path
from urllib.parse import unquote

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SOURCE = REPO_ROOT / "plugin" / "hermes-codex-bridge"
sys.path.insert(0, str(PLUGIN_SOURCE))

import delivery_sidecar  # noqa: E402
from delivery_sidecar import (  # noqa: E402
    CAPABILITIES,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
    DeliverySidecar,
    HcoClient,
    HcoError,
)
import zulip_sender  # noqa: E402
from zulip_sender import ZulipSender  # noqa: E402


class UnixHttpFixture:
    def __init__(self, tmp_path: Path, responses: list[tuple[int, dict]]) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="hco-sidecar-", dir="/tmp"))
        self.path = self.directory / "hco.sock"
        self.responses = deque(responses)
        self.requests: list[dict] = []
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self):
        self._thread.start()
        assert self._ready.wait(2)
        return self

    def __exit__(self, *_exc):
        self._thread.join(2)
        assert not self._thread.is_alive()
        self.path.unlink(missing_ok=True)
        self.directory.rmdir()

    def _serve(self) -> None:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(self.path))
        server.listen()
        self._ready.set()
        try:
            while self.responses:
                connection, _ = server.accept()
                with connection:
                    raw = bytearray()
                    while b"\r\n\r\n" not in raw:
                        raw.extend(connection.recv(65_536))
                    header, body = bytes(raw).split(b"\r\n\r\n", 1)
                    lines = header.decode("ascii").split("\r\n")
                    method, route, _version = lines[0].split(" ")
                    headers = {}
                    for line in lines[1:]:
                        name, value = line.split(":", 1)
                        headers[name.lower()] = value.strip()
                    length = int(headers.get("content-length", "0"))
                    while len(body) < length:
                        body += connection.recv(65_536)
                    self.requests.append(
                        {
                            "method": method,
                            "route": route,
                            "headers": headers,
                            "body": json.loads(body) if body else None,
                        }
                    )
                    status, payload = self.responses.popleft()
                    encoded = json.dumps(payload, separators=(",", ":")).encode()
                    reason = "OK" if status == 200 else "Unauthorized"
                    connection.sendall(
                        f"HTTP/1.1 {status} {reason}\r\n"
                        f"Content-Type: application/json\r\n"
                        f"Content-Length: {len(encoded)}\r\n"
                        "Connection: close\r\n\r\n".encode()
                        + encoded
                    )
        finally:
            server.close()


def _compatibility() -> dict:
    return {
        "compatibility": {
            "protocolVersion": PROTOCOL_VERSION,
            "peerPluginVersion": PLUGIN_VERSION,
            "capabilities": CAPABILITIES,
        },
        "hco": {"version": "0.1.0-test"},
    }


def _meta() -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "capabilities": CAPABILITIES,
    }


def test_compatibility_uses_authenticated_unix_socket_and_exact_headers(tmp_path: Path) -> None:
    with UnixHttpFixture(tmp_path, [(200, _compatibility())]) as server:
        client = HcoClient(str(server.path), b"bridge-secret", "worker-a", 2, 30_000)
        client.check_compatibility()

    assert server.requests == [
        {
            "method": "GET",
            "route": "/v1/compatibility",
            "headers": {
                "host": "bridge.local",
                "accept-encoding": "identity",
                "authorization": "Bearer bridge-secret",
                "x-hco-protocol-version": "1",
                "x-hco-plugin-version": PLUGIN_VERSION,
                "x-hco-capabilities": json.dumps(CAPABILITIES, separators=(",", ":")),
            },
            "body": None,
        }
    ]


def test_claim_ack_and_nack_use_exact_bodies_and_escaped_delivery_routes(tmp_path: Path) -> None:
    delivery_id = "delivery/space 火"
    lease_token = "lease-exact"
    with UnixHttpFixture(
        tmp_path,
        [
            (200, {"deliveries": []}),
            (200, {"result": {"duplicate": False}}),
            (200, {"result": {"retryable": True}}),
        ],
    ) as server:
        client = HcoClient(str(server.path), b"bridge-secret", "worker-a", 2, 30_000)
        assert client.claim() == []
        client.ack(delivery_id, lease_token, 731)
        client.nack(delivery_id, lease_token, "temporary", True)

    assert [request["body"] for request in server.requests] == [
        {**_meta(), "workerId": "worker-a", "limit": 2, "leaseMs": 30_000},
        {**_meta(), "leaseToken": lease_token, "zulipMessageId": 731},
        {**_meta(), "leaseToken": lease_token, "error": "temporary", "retryable": True},
    ]
    assert [request["route"] for request in server.requests] == [
        "/v1/outbox/claim",
        "/v1/outbox/delivery%2Fspace%20%E7%81%AB/ack",
        "/v1/outbox/delivery%2Fspace%20%E7%81%AB/nack",
    ]
    assert unquote(server.requests[1]["route"].split("/")[3]) == delivery_id


@pytest.mark.parametrize(
    "failure",
    [
        HcoError(401, "BRIDGE_AUTH_FAILED", "Authentication failed."),
        HcoError(400, "BRIDGE_VERSION_UNSUPPORTED", "Unsupported."),
    ],
    ids=["authentication", "compatibility"],
)
def test_startup_failure_prevents_claims(failure: HcoError) -> None:
    class FailingHco:
        def __init__(self) -> None:
            self.claim_count = 0

        def check_compatibility(self) -> None:
            raise failure

        def claim(self):
            self.claim_count += 1
            return []

    hco = FailingHco()
    sidecar = DeliverySidecar(hco, object(), poll_seconds=0.001)

    with pytest.raises(HcoError) as raised:
        sidecar.run()

    assert raised.value is failure
    assert hco.claim_count == 0


@pytest.mark.parametrize(
    "response",
    [
        (401, {"error": {"code": "BRIDGE_AUTH_FAILED"}}),
        (
            200,
            {
                "compatibility": {
                    "protocolVersion": 2,
                    "peerPluginVersion": PLUGIN_VERSION,
                    "capabilities": CAPABILITIES,
                }
            },
        ),
    ],
    ids=["authentication", "incompatible-version"],
)
def test_real_unix_startup_failure_never_reaches_claim(
    tmp_path: Path, response: tuple[int, dict]
) -> None:
    with UnixHttpFixture(tmp_path, [response]) as server:
        client = HcoClient(str(server.path), b"bridge-secret", "worker-a", 2, 30_000)
        sidecar = DeliverySidecar(client, object(), poll_seconds=0.01)

        with pytest.raises(HcoError):
            sidecar.run()

    assert [request["route"] for request in server.requests] == ["/v1/compatibility"]


def test_owner_only_bearer_is_loaded_once_during_runtime_construction(
    tmp_path: Path, monkeypatch
) -> None:
    bearer_path = tmp_path / "hco-token"
    zulip_path = tmp_path / "zuliprc"
    socket_path = tmp_path / "hco.sock"
    bearer_path.write_bytes(b"startup-bearer")
    bearer_path.chmod(0o600)
    zulip_path.write_text("[api]\nkey=path-only\n", encoding="utf-8")
    zulip_path.chmod(0o600)
    constructed = []

    class FakeSender:
        secrets = ()

        def __init__(self, config_path: str) -> None:
            constructed.append(config_path)

    monkeypatch.setattr(delivery_sidecar, "ZulipSender", FakeSender)
    config = delivery_sidecar.RuntimeConfig(
        socket_path=str(socket_path),
        bearer_path=str(bearer_path),
        zulip_config_path=str(zulip_path),
        worker_id="worker-a",
        claim_limit=2,
        lease_ms=30_000,
        poll_seconds=0.5,
    )

    sidecar = delivery_sidecar.build_sidecar(config)
    bearer_path.write_bytes(b"changed-after-startup")

    assert sidecar.hco.redaction_secrets == ("startup-bearer",)
    assert constructed == [str(zulip_path)]


@pytest.mark.parametrize(
    "token",
    [b"", b"contains space", b"line\nfeed", b"control\x1f", b"delete\x7f", b"non-ascii\x80"],
    ids=["empty", "space", "newline", "control", "delete", "non-ascii"],
)
def test_bearer_requires_printable_non_space_ascii(token: bytes) -> None:
    with pytest.raises(ValueError, match="invalid credentials"):
        HcoClient("/tmp/hco.sock", token, "worker-a", 2, 30_000)


def test_non_ascii_bearer_leaves_no_secret_bearing_decode_exception_chain() -> None:
    bearer = b"prefix-private-bearer-\x80-suffix"

    with pytest.raises(ValueError, match="invalid credentials") as raised:
        HcoClient("/tmp/hco.sock", bearer, "worker-a", 2, 30_000)

    error = raised.value
    formatted = "".join(traceback.format_exception(error))
    assert error.__cause__ is None
    assert error.__context__ is None
    assert "UnicodeDecodeError" not in formatted
    assert repr(bearer) not in formatted


def test_runtime_cli_accepts_credential_paths_without_secret_value_arguments(
    tmp_path: Path,
) -> None:
    bearer_path = tmp_path / "hco-token"
    zulip_path = tmp_path / "zuliprc"
    socket_path = tmp_path / "hco.sock"
    argv = [
        "--socket-path",
        str(socket_path),
        "--hco-bearer-file",
        str(bearer_path),
        "--zulip-config-file",
        str(zulip_path),
        "--worker-id",
        "worker-a",
    ]

    config = delivery_sidecar.parse_runtime_args(argv)
    help_text = delivery_sidecar.runtime_argument_parser().format_help().lower()

    assert config.socket_path == str(socket_path)
    assert config.bearer_path == str(bearer_path)
    assert config.zulip_config_path == str(zulip_path)
    assert "bearer-token" not in help_text
    assert "api-key" not in help_text
    assert "startup-bearer" not in argv
    assert "zulip-api-secret" not in argv


def test_bearer_file_rejects_non_owner_only_and_non_regular_sources(tmp_path: Path) -> None:
    valid = tmp_path / "token"
    valid.write_bytes(b"bridge-token")
    valid.chmod(0o600)
    link = tmp_path / "token-link"
    link.symlink_to(valid)
    public = tmp_path / "public-token"
    public.write_bytes(b"bridge-token")
    public.chmod(0o640)

    assert delivery_sidecar.load_bearer_file(str(valid)) == b"bridge-token"
    for path in (link, public, tmp_path):
        with pytest.raises(ValueError, match="invalid credentials"):
            delivery_sidecar.load_bearer_file(str(path))


@pytest.mark.parametrize("claim_failure", [False, True], ids=["empty", "error"])
def test_empty_and_error_poll_waits_are_interruptible_without_busy_loop(
    claim_failure: bool,
) -> None:
    claim_started = threading.Event()
    diagnostics = []
    errors = []

    class PollingHco:
        redaction_secrets = ()

        def __init__(self) -> None:
            self.claim_count = 0

        def check_compatibility(self) -> None:
            return None

        def claim(self):
            self.claim_count += 1
            claim_started.set()
            if claim_failure:
                raise HcoError(0, "HCO_UNAVAILABLE", "secret transport detail")
            return []

    hco = PollingHco()
    sidecar = DeliverySidecar(
        hco, object(), poll_seconds=30, diagnostic_sink=diagnostics.append
    )

    def run_sidecar() -> None:
        try:
            sidecar.run()
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=run_sidecar)
    thread.start()
    assert claim_started.wait(0.5)
    sidecar.request_stop()
    thread.join(0.5)

    assert not thread.is_alive()
    assert errors == []
    assert hco.claim_count == 1
    assert diagnostics == (["HCO_CLAIM_FAILED"] if claim_failure else [])


def test_signal_handlers_request_interruptible_stop(monkeypatch) -> None:
    handlers = {}
    stop_calls = []

    class Sidecar:
        def request_stop(self) -> None:
            stop_calls.append("stop")

    monkeypatch.setattr(
        delivery_sidecar.signal,
        "signal",
        lambda number, handler: handlers.setdefault(number, handler),
    )

    delivery_sidecar.install_signal_handlers(Sidecar())

    assert set(handlers) == {signal.SIGTERM, signal.SIGINT}
    handlers[signal.SIGTERM](signal.SIGTERM, None)
    handlers[signal.SIGINT](signal.SIGINT, None)
    assert stop_calls == ["stop", "stop"]


class RecordingHco:
    def __init__(self) -> None:
        self.acks: list[tuple] = []
        self.nacks: list[tuple] = []

    def ack(self, *arguments) -> None:
        self.acks.append(arguments)

    def nack(self, *arguments) -> None:
        self.nacks.append(arguments)


def _claim(
    delivery_id: str = "delivery-1",
    lease_token: str = "lease-1",
    *,
    content: str = "[objective alpha-🚀- result 1/1]\nfinished",
    stream_id: int = 42,
    topic: str = "Build",
) -> dict:
    return {
        "deliveryId": delivery_id,
        "leaseToken": lease_token,
        "objectiveId": "alpha-🚀-long",
        "semanticKey": "renderer:v1:stable",
        "payload": {"content": content, "kind": "final"},
        "targetSnapshot": {
            "platform": "zulip",
            "streamId": stream_id,
            "topic": topic,
        },
    }


def test_real_zulip_import_builds_one_no_retry_client_and_reuses_it(monkeypatch) -> None:
    constructed = []

    class FakeClient:
        api_key = "zulip-api-secret"

        def __init__(self) -> None:
            self.messages = []

        def send_message(self, message):
            self.messages.append(message)
            return {"result": "success", "id": len(self.messages)}

    fake_client = FakeClient()

    def build_client(**options):
        constructed.append(options)
        return fake_client

    monkeypatch.setattr(zulip_sender.zulip, "Client", build_client)
    sender = ZulipSender("/private/config/zuliprc")

    first = sender.send(42, "Build", "first")
    second = sender.send(43, "Review", "second")

    assert constructed == [
        {"config_file": "/private/config/zuliprc", "retry_on_errors": False}
    ]
    assert fake_client.messages == [
        {"type": "stream", "to": "42", "topic": "Build", "content": "first"},
        {"type": "stream", "to": "43", "topic": "Review", "content": "second"},
    ]
    assert (first.message_id, second.message_id) == (1, 2)


def test_zulip_client_startup_exception_does_not_expose_config_secret(
    monkeypatch,
) -> None:
    api_key = "zulip-startup-api-secret"

    def fail_client(**_options):
        raise ValueError(f"invalid config containing {api_key}")

    monkeypatch.setattr(zulip_sender.zulip, "Client", fail_client)

    with pytest.raises(RuntimeError) as raised:
        ZulipSender("/private/config/zuliprc")

    assert api_key not in str(raised.value)
    assert str(raised.value) == "Zulip sender initialization failed."


def test_claims_are_sent_and_acked_sequentially_with_exact_lease() -> None:
    events = []
    hco = RecordingHco()

    class Sender:
        def send(self, stream_id, topic, content):
            events.append(("send", stream_id, topic, content))
            return zulip_sender.SendResult.success(700 + len(events))

    class OrderedHco(RecordingHco):
        def ack(self, *arguments) -> None:
            events.append(("ack", *arguments))
            super().ack(*arguments)

    hco = OrderedHco()
    sidecar = DeliverySidecar(hco, Sender())
    first = _claim("delivery-1", "lease-1", content="first")
    second = _claim("delivery-2", "lease-2", content="second", topic="Review")

    sidecar.process_deliveries([first, second])

    assert events == [
        ("send", 42, "Build", "first"),
        ("ack", "delivery-1", "lease-1", 701),
        ("send", 42, "Review", "second"),
        ("ack", "delivery-2", "lease-2", 703),
    ]
    assert hco.nacks == []


def test_stop_during_in_flight_send_settles_only_current_delivery() -> None:
    sent = []

    class Hco(RecordingHco):
        redaction_secrets = ()

        def __init__(self) -> None:
            super().__init__()
            self.claim_count = 0

        def check_compatibility(self) -> None:
            return None

        def claim(self):
            self.claim_count += 1
            return [
                _claim("delivery-1", "lease-1", content="first"),
                _claim("delivery-2", "lease-2", content="second"),
            ]

    class Sender:
        secrets = ()
        sidecar = None

        def send(self, stream_id, topic, content):
            sent.append((stream_id, topic, content))
            self.sidecar.request_stop()
            return zulip_sender.SendResult.success(901)

    hco = Hco()
    sender = Sender()
    sidecar = DeliverySidecar(hco, sender, poll_seconds=0.01)
    sender.sidecar = sidecar

    sidecar.run()

    assert hco.claim_count == 1
    assert sent == [(42, "Build", "first")]
    assert hco.acks == [("delivery-1", "lease-1", 901)]
    assert hco.nacks == []


def _malformed_claims() -> list[pytest.param]:
    base = _claim()

    def changed(**values):
        claim = json.loads(json.dumps(base))
        claim.update(values)
        return claim

    return [
        pytest.param(None, False, id="not-mapping"),
        pytest.param(changed(deliveryId=""), False, id="empty-delivery-id"),
        pytest.param(changed(deliveryId="x" * 513), False, id="oversized-delivery-id"),
        pytest.param(changed(deliveryId=7), False, id="non-string-delivery-id"),
        pytest.param(changed(leaseToken=""), False, id="empty-lease-token"),
        pytest.param(changed(leaseToken="x" * 513), False, id="oversized-lease-token"),
        pytest.param(changed(leaseToken=False), False, id="non-string-lease-token"),
        pytest.param(changed(payload=[]), True, id="payload-not-mapping"),
        pytest.param(changed(payload={}), True, id="content-missing"),
        pytest.param(changed(payload={"content": 4}), True, id="content-not-string"),
        pytest.param(changed(payload={"content": "x" * 65_537}), True, id="content-oversized"),
        pytest.param(changed(targetSnapshot=[]), True, id="target-not-mapping"),
        pytest.param(
            changed(targetSnapshot={"platform": "slack", "streamId": 42, "topic": "Build"}),
            True,
            id="wrong-platform",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": True, "topic": "Build"}),
            True,
            id="boolean-stream",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": 0, "topic": "Build"}),
            True,
            id="non-positive-stream",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": "42", "topic": "Build"}),
            True,
            id="non-integer-stream",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": 42, "topic": ""}),
            True,
            id="empty-topic",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": 42, "topic": "x" * 257}),
            True,
            id="oversized-topic",
        ),
        pytest.param(
            changed(targetSnapshot={"platform": "zulip", "streamId": 42, "topic": 9}),
            True,
            id="non-string-topic",
        ),
    ]


@pytest.mark.parametrize(("claim", "settlable"), _malformed_claims())
def test_malformed_claim_matrix_never_sends_and_permanently_nacks_when_settlable(
    claim, settlable: bool
) -> None:
    hco = RecordingHco()

    class NoSend:
        def __init__(self) -> None:
            self.calls = 0

        def send(self, *_arguments):
            self.calls += 1
            raise AssertionError("invalid claim reached Zulip")

    sender = NoSend()
    sidecar = DeliverySidecar(hco, sender)

    sidecar.process_claim(claim)

    assert sender.calls == 0
    assert hco.acks == []
    if settlable:
        assert hco.nacks == [
            ("delivery-1", "lease-1", "CLAIM_INVALID", False)
        ]
    else:
        assert hco.nacks == []


@pytest.mark.parametrize("message_id", [True, False, None, 0, -1, 1.0, "1"])
def test_success_without_positive_non_boolean_message_id_is_retryable(message_id) -> None:
    class Client:
        api_key = "key"

        def send_message(self, _message):
            response = {"result": "success"}
            if message_id is not None:
                response["id"] = message_id
            return response

    sender = ZulipSender.__new__(ZulipSender)
    sender.client = Client()
    sender.secrets = ()

    result = sender.send(42, "Build", "content")

    assert result.message_id is None
    assert result.retryable is True
    assert result.diagnostic == "ZULIP_RESPONSE_UNCERTAIN"


@pytest.mark.parametrize(
    ("response", "retryable"),
    [
        ({"result": "error", "status_code": 408, "msg": "timeout"}, True),
        ({"result": "error", "status_code": 425, "msg": "too early"}, True),
        ({"result": "error", "status_code": 429, "msg": "rate limited"}, True),
        ({"result": "error", "status_code": 503, "msg": "down"}, True),
        ({"result": "error", "code": "RATE_LIMIT_HIT", "msg": "slow"}, True),
        ({"result": "error", "code": "INTERNAL_SERVER_ERROR", "msg": "failed"}, True),
        ({"result": "error", "msg": "unclassified upstream failure"}, True),
        ({"result": "error", "status_code": 400, "msg": "bad content"}, False),
        ({"result": "error", "status_code": 401, "msg": "bad auth"}, False),
        ({"result": "error", "status_code": 404, "msg": "no stream"}, False),
        ({"result": "error", "code": "BAD_REQUEST", "msg": "bad topic"}, False),
        ({"result": "unexpected"}, True),
        ("not-a-mapping", True),
    ],
)
def test_zulip_response_classifies_retryable_and_permanent_failures(
    response, retryable: bool
) -> None:
    class Client:
        api_key = "key"

        def send_message(self, _message):
            return response

    sender = ZulipSender.__new__(ZulipSender)
    sender.client = Client()
    sender.secrets = ()

    result = sender.send(42, "Build", "content")

    assert result.message_id is None
    assert result.retryable is retryable
    assert len(result.diagnostic.encode("utf-8")) <= 256


@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("timed out"),
        ConnectionError("connection reset"),
        ssl.SSLError("tls failed"),
        zulip_sender.zulip.UnrecoverableNetworkError("network failed"),
    ],
)
def test_transport_failures_are_retryable_and_send_is_never_directly_retried(
    failure: Exception,
) -> None:
    class Client:
        api_key = "key"

        def __init__(self) -> None:
            self.calls = 0

        def send_message(self, _message):
            self.calls += 1
            raise failure

    client = Client()
    sender = ZulipSender.__new__(ZulipSender)
    sender.client = client
    sender.secrets = ()

    result = sender.send(42, "Build", "content")

    assert client.calls == 1
    assert result.message_id is None
    assert result.retryable is True


def test_transport_exception_masks_actual_api_key_value() -> None:
    api_key = "zulip-api-secret"

    class Client:
        def send_message(self, _message):
            raise ConnectionError(f"upstream rejected {api_key}")

    sender = ZulipSender.__new__(ZulipSender)
    sender.client = Client()
    sender.secrets = (api_key,)

    result = sender.send(42, "Build", "content")

    assert api_key not in result.diagnostic
    assert "***MASKED***" in result.diagnostic


def test_nack_diagnostic_masks_api_key_and_bearer_and_is_bounded() -> None:
    api_key = "zulip-api-secret"
    bearer = "hco-bearer-secret"
    hco = RecordingHco()
    hco.redaction_secrets = (bearer,)

    class Sender:
        secrets = (api_key,)

        def send(self, *_arguments):
            return zulip_sender.SendResult.failure(
                f"upstream {api_key} bearer {bearer} " + "🚀" * 300,
                True,
            )

    DeliverySidecar(hco, Sender()).process_claim(_claim())

    diagnostic = hco.nacks[0][2]
    assert api_key not in diagnostic
    assert bearer not in diagnostic
    assert diagnostic.count("***MASKED***") == 2
    assert len(diagnostic.encode("utf-8")) <= 256


@pytest.mark.parametrize("code", ["OUTBOX_LEASE_STALE", "OUTBOX_LEASE_EXPIRED"])
@pytest.mark.parametrize("settlement", ["ack", "nack"])
def test_lease_conflict_never_resends_or_attempts_opposite_settlement(
    code: str, settlement: str
) -> None:
    diagnostics = []

    class ConflictingHco(RecordingHco):
        def ack(self, *arguments) -> None:
            self.acks.append(arguments)
            if settlement == "ack":
                raise HcoError(409, code, "secret lease detail")

        def nack(self, *arguments) -> None:
            self.nacks.append(arguments)
            if settlement == "nack":
                raise HcoError(409, code, "secret lease detail")

    class Sender:
        secrets = ()

        def __init__(self) -> None:
            self.calls = 0

        def send(self, *_arguments):
            self.calls += 1
            if settlement == "ack":
                return zulip_sender.SendResult.success(99)
            return zulip_sender.SendResult.failure("ZULIP_TIMEOUT", True)

    hco = ConflictingHco()
    sender = Sender()
    sidecar = DeliverySidecar(hco, sender, diagnostic_sink=diagnostics.append)

    sidecar.process_claim(_claim())

    assert sender.calls == 1
    assert len(hco.acks) == (1 if settlement == "ack" else 0)
    assert len(hco.nacks) == (1 if settlement == "nack" else 0)
    assert diagnostics == [f"HCO_LEASE_CONFLICT:{code}"]


def test_crash_window_uses_real_hco_renderer_store_expiry_and_reclaim(
    tmp_path: Path,
) -> None:
    hco_script = r"""
import { renderFinal } from "./hco/delivery/renderer.js";
import { openStore } from "./hco/state/store.js";

const objectiveId = "alpha-🚀-long";
const clock = { value: 1_700_000_000_000 };
let nextId = 0;
const store = openStore({
  databasePath: process.argv[1],
  now: () => clock.value,
  idFactory: (kind) => `${kind}-${++nextId}`
});
try {
  store.ingest({
    sourceType: "bridge",
    sourceId: "created-crash-window",
    eventName: "objective.created",
    schemaVersion: 1,
    objectiveId,
    payload: { state: "created" }
  });
  const [chunk] = renderFinal({ objectiveId, text: "finished" });
  store.ingest({
    sourceType: "renderer",
    sourceId: "delivery-crash-window",
    eventName: "zulip.delivery.requested",
    schemaVersion: 1,
    objectiveId,
    payload: {
      messages: [{
        semanticKey: chunk.semanticKey,
        payload: chunk,
        targetSnapshot: {
          platform: "zulip",
          streamId: 42,
          topic: "Build"
        }
      }]
    }
  });
  const [first] = store.claimOutbox({
    workerId: "worker-before-crash",
    limit: 1,
    leaseMs: 1_000
  });
  clock.value += 1_001;
  const [recovered] = store.claimOutbox({
    workerId: "worker-after-crash",
    limit: 1,
    leaseMs: 1_000
  });
  process.stdout.write(JSON.stringify({ first, recovered }));
} finally {
  store.close();
}
"""
    hco_regression = subprocess.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            hco_script,
            str(tmp_path / "crash-window.sqlite3"),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert hco_regression.returncode == 0, (
        hco_regression.stdout + hco_regression.stderr
    )
    claims = json.loads(hco_regression.stdout)
    original = claims["first"]
    retry_claim = claims["recovered"]

    class FatalCrash(BaseException):
        pass

    sent = []
    crash_hco = RecordingHco()

    class Sender:
        secrets = ()

        def send(self, stream_id, topic, content):
            sent.append((stream_id, topic, content))
            return zulip_sender.SendResult.success(301)

    def crash_after_send(_claim, _result) -> None:
        raise FatalCrash("process terminated")

    stable_fields = {
        key: json.loads(json.dumps(original[key]))
        for key in ("deliveryId", "semanticKey", "payload", "targetSnapshot")
    }
    crashing = DeliverySidecar(crash_hco, Sender(), after_send=crash_after_send)

    with pytest.raises(FatalCrash):
        crashing.process_claim(original)

    assert crash_hco.acks == []
    assert crash_hco.nacks == []
    assert all(original[key] == value for key, value in stable_fields.items())

    assert all(retry_claim[key] == value for key, value in stable_fields.items())
    assert retry_claim["leaseToken"] != original["leaseToken"]
    retry_hco = RecordingHco()
    DeliverySidecar(retry_hco, Sender()).process_claim(retry_claim)

    assert sent == [
        (42, "Build", original["payload"]["content"]),
        (42, "Build", original["payload"]["content"]),
    ]
    assert original["payload"]["content"].startswith(
        "[objective alpha-🚀- result 1/1]\n"
    )
    assert retry_hco.acks == [
        (retry_claim["deliveryId"], retry_claim["leaseToken"], 301)
    ]


def test_delivery_modules_expose_only_outbound_transport_paths() -> None:
    sources = "\n".join(
        (PLUGIN_SOURCE / name).read_text(encoding="utf-8")
        for name in ("delivery_sidecar.py", "zulip_sender.py")
    ).lower()
    forbidden = tuple(
        "".join(parts)
        for parts in (
            ("call", "_on_each_event"),
            ("get", "_events"),
            ("register", "_queue"),
            ("gate", "way"),
            ("hermes", "_cli"),
            ("open", "ai"),
            ("anth", "ropic"),
            ("model", ".invoke"),
        )
    )
    assert all(term not in sources for term in forbidden)
