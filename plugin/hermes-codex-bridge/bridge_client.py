from __future__ import annotations

import asyncio
import json


PLUGIN_VERSION = "1.0.0"
CAPABILITIES = ["signed_context", "message_binding", "nonce_replay"]
MAX_REQUEST_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 1_048_576
IO_TIMEOUT_SECONDS = 10


class BridgeUnavailableError(Exception):
    pass


class BridgeProtocolError(Exception):
    pass


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
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=IO_TIMEOUT_SECONDS,
            )
            writer.write(request)
            await asyncio.wait_for(writer.drain(), timeout=IO_TIMEOUT_SECONDS)
            response = await asyncio.wait_for(
                _read_bounded_response(reader), timeout=IO_TIMEOUT_SECONDS
            )
        except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
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


def _parse_response(response: bytes) -> dict:
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
        raise BridgeProtocolError("bridge rejected request")
    if set(body) != {"result"} or type(body["result"]) is not dict:
        raise BridgeProtocolError("invalid response")
    return body["result"]
