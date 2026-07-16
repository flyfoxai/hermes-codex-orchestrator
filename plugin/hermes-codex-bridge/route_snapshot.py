from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import time
from dataclasses import dataclass


MAX_SNAPSHOT_BYTES = 262_144
MAX_ROUTES = 4_096
MAX_TOPICS = 2_048
MAX_SAFE_INTEGER = 9_007_199_254_740_991
PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class Route:
    stream_id: int
    owner: str
    project_id: str | None
    source: str
    topics: tuple[tuple[str, str], ...]

    def topic_mode(self, topic: str) -> str:
        for candidate, mode in self.topics:
            if candidate == topic:
                return mode
        return "AUTO"


def _safe_nonnegative(value: object) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def _positive(value: object) -> bool:
    return _safe_nonnegative(value) and value > 0


def _exact_dict(value: object, keys: set[str]) -> bool:
    return type(value) is dict and set(value) == keys


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def load_route_snapshot(path: str, *, now_ms: int | None = None) -> tuple[Route, ...] | None:
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            return None
        if info.st_size < 1 or info.st_size > MAX_SNAPSHOT_BYTES:
            return None
        with open(path, "rb") as handle:
            raw = handle.read(MAX_SNAPSHOT_BYTES + 1)
        if not raw or len(raw) > MAX_SNAPSHOT_BYTES:
            return None
        if raw.endswith(b"\n"):
            raw = raw[:-1]
        if not raw or raw.endswith(b"\n"):
            return None
        snapshot = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None

    top_keys = {
        "schemaVersion",
        "generation",
        "generatedAtMs",
        "validUntilMs",
        "defaultOwner",
        "routes",
        "integrity",
    }
    if not _exact_dict(snapshot, top_keys):
        return None
    integrity = snapshot["integrity"]
    if not _exact_dict(integrity, {"algorithm", "canonicalPayloadSha256"}):
        return None
    digest = integrity["canonicalPayloadSha256"]
    if (
        integrity["algorithm"] != "sha256"
        or type(digest) is not str
        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
    ):
        return None
    payload = {key: value for key, value in snapshot.items() if key != "integrity"}
    actual = hashlib.sha256(_canonical(payload)).hexdigest()
    if not hmac.compare_digest(actual, digest):
        return None

    current = int(time.time() * 1000) if now_ms is None else now_ms
    generated = snapshot["generatedAtMs"]
    valid_until = snapshot["validUntilMs"]
    routes = snapshot["routes"]
    if (
        snapshot["schemaVersion"] != 1
        or snapshot["defaultOwner"] != "HERMES"
        or not _safe_nonnegative(snapshot["generation"])
        or not _safe_nonnegative(generated)
        or not _safe_nonnegative(valid_until)
        or valid_until <= generated
        or valid_until - generated < 5_000
        or valid_until - generated > 300_000
        or generated > current + 30_000
        or current > valid_until
        or type(routes) is not list
        or len(routes) > MAX_ROUTES
    ):
        return None

    parsed: list[Route] = []
    prior_stream = 0
    total_topics = 0
    for item in routes:
        if not _exact_dict(item, {"streamId", "owner", "projectId", "source", "topics"}):
            return None
        stream_id = item["streamId"]
        owner = item["owner"]
        project_id = item["projectId"]
        topics = item["topics"]
        if (
            not _positive(stream_id)
            or stream_id <= prior_stream
            or owner not in {"PROJECT", "HERMES"}
            or item["source"] not in {"runtime", "static", "default"}
            or type(topics) is not list
            or (
                owner == "PROJECT"
                and (type(project_id) is not str or PROJECT_ID.fullmatch(project_id) is None)
            )
            or (owner == "HERMES" and project_id is not None)
        ):
            return None
        prior_stream = stream_id
        parsed_topics: list[tuple[str, str]] = []
        prior_topic: bytes | None = None
        for topic_item in topics:
            if not _exact_dict(topic_item, {"topic", "mode"}):
                return None
            topic = topic_item["topic"]
            if type(topic) is not str:
                return None
            encoded = topic.encode("utf-8")
            if (
                not encoded
                or len(encoded) > 256
                or topic_item["mode"] not in {"HERMES_ONLY", "CODEX_BOUND"}
                or (prior_topic is not None and encoded <= prior_topic)
            ):
                return None
            prior_topic = encoded
            parsed_topics.append((topic, topic_item["mode"]))
            total_topics += 1
        parsed.append(
            Route(stream_id, owner, project_id, item["source"], tuple(parsed_topics))
        )
    if total_topics > MAX_TOPICS:
        return None
    return tuple(parsed)


def find_route(routes: tuple[Route, ...] | None, stream_id: int) -> Route | None:
    if routes is None:
        return None
    for route in routes:
        if route.stream_id == stream_id:
            return route
        if route.stream_id > stream_id:
            break
    return None
