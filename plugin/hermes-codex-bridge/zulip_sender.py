from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import zulip


MAX_DIAGNOSTIC_BYTES = 256
RETRYABLE_STATUS_CODES = frozenset({408, 425, 429})
PERMANENT_ERROR_CODES = frozenset({"BAD_REQUEST", "FORBIDDEN", "UNAUTHORIZED"})


def bounded_diagnostic(value: object, secrets: tuple[str, ...] = ()) -> str:
    text = str(value)
    for secret in sorted(
        (secret for secret in secrets if type(secret) is str and secret),
        key=len,
        reverse=True,
    ):
        text = text.replace(secret, "***MASKED***")
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_DIAGNOSTIC_BYTES:
        return text
    return encoded[:MAX_DIAGNOSTIC_BYTES].decode("utf-8", errors="ignore")


def _status_code(value: object) -> int | None:
    status = value if type(value) is int else None
    return status if status is not None and 100 <= status <= 599 else None


def _exception_status(error: Exception) -> int | None:
    for candidate in (
        getattr(error, "status_code", None),
        getattr(error, "status", None),
        getattr(getattr(error, "response", None), "status_code", None),
    ):
        status = _status_code(candidate)
        if status is not None:
            return status
    return None


def _retryable_status(status: int) -> bool:
    return status in RETRYABLE_STATUS_CODES or 500 <= status <= 599


def _response_failure(response: object, secrets: tuple[str, ...]) -> SendResult:
    if not isinstance(response, Mapping) or response.get("result") != "error":
        return SendResult.failure("ZULIP_RESPONSE_UNCERTAIN", True)
    status = _status_code(response.get("status_code"))
    code = response.get("code")
    message = response.get("msg")
    recognizable_rate_limit = (
        code in {"RATE_LIMIT_HIT", "TOO_MANY_REQUESTS"}
        or (type(message) is str and "rate limit" in message.lower())
    )
    if recognizable_rate_limit or (status is not None and _retryable_status(status)):
        detail = message if type(message) is str else code or "retryable response"
        return SendResult.failure(
            bounded_diagnostic(f"ZULIP_RETRYABLE:{detail}", secrets), True
        )
    if status is not None and 400 <= status <= 499:
        detail = message if type(message) is str else code or "permanent response"
        return SendResult.failure(
            bounded_diagnostic(f"ZULIP_PERMANENT:{detail}", secrets), False
        )
    if code in PERMANENT_ERROR_CODES:
        detail = message if type(message) is str else code
        return SendResult.failure(
            bounded_diagnostic(f"ZULIP_PERMANENT:{detail}", secrets), False
        )
    return SendResult.failure("ZULIP_RESPONSE_UNCERTAIN", True)


@dataclass(frozen=True)
class SendResult:
    message_id: int | None
    retryable: bool
    diagnostic: str

    @classmethod
    def success(cls, message_id: int) -> "SendResult":
        return cls(message_id=message_id, retryable=False, diagnostic="")

    @classmethod
    def failure(cls, diagnostic: str, retryable: bool) -> "SendResult":
        return cls(message_id=None, retryable=retryable, diagnostic=diagnostic)


class ZulipSender:
    def __init__(self, config_path: str) -> None:
        try:
            self.client = zulip.Client(config_file=config_path, retry_on_errors=False)
        except Exception:
            raise RuntimeError("Zulip sender initialization failed.") from None
        api_key = getattr(self.client, "api_key", "")
        self.secrets = (api_key,) if type(api_key) is str and api_key else ()

    def send(self, stream_id: int, topic: str, content: str) -> SendResult:
        try:
            response = self.client.send_message(
                {
                    "type": "stream",
                    "to": str(stream_id),
                    "topic": topic,
                    "content": content,
                }
            )
        except Exception as error:
            status = _exception_status(error)
            retryable = status is None or _retryable_status(status)
            if status is not None and 400 <= status <= 499 and not _retryable_status(status):
                retryable = False
            category = "ZULIP_RETRYABLE" if retryable else "ZULIP_PERMANENT"
            return SendResult.failure(
                bounded_diagnostic(
                    f"{category}:{type(error).__name__}:{error}", self.secrets
                ),
                retryable,
            )
        if isinstance(response, Mapping) and response.get("result") == "success":
            message_id = response.get("id")
            if type(message_id) is int and message_id > 0:
                return SendResult.success(message_id)
            return SendResult.failure("ZULIP_RESPONSE_UNCERTAIN", True)
        return _response_failure(response, self.secrets)
