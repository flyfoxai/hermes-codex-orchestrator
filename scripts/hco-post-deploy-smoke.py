#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROUTE_KEYS = {
    "schemaVersion",
    "generation",
    "generatedAtMs",
    "validUntilMs",
    "defaultOwner",
    "routes",
    "integrity",
}
ROUTE_ITEM_KEYS = {"streamId", "owner", "projectId", "source", "topics"}
TOPIC_ITEM_KEYS = {"topic", "mode"}
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_ROUTES = 4_096
MAX_TOPICS = 2_048
PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def check(condition: bool, code: str, detail: str) -> dict[str, str]:
    return {"code": code, "status": "PASS" if condition else "FAIL", "detail": detail}


def trusted_file(path: Path, *, maximum: int | None = None) -> os.stat_result:
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or (maximum is not None and info.st_size > maximum)
    ):
        raise ValueError(f"untrusted owner-only file: {path}")
    return info


def read_json(path: Path, *, maximum: int = 1_048_576) -> dict[str, Any]:
    trusted_file(path, maximum=maximum)
    value = json.loads(path.read_text(encoding="utf-8"))
    if type(value) is not dict:
        raise ValueError(f"expected JSON object: {path}")
    return value


def release_files(path: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    root = path.resolve(strict=True)
    root_info = root.lstat()
    if root != path or not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.getuid():
        raise ValueError("release path must be a real directory")
    for candidate in sorted(root.rglob("*")):
        relative = candidate.relative_to(root)
        info = candidate.lstat()
        if "__pycache__" in relative.parts or relative.name.endswith(".pyc"):
            continue
        if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("release contains an untrusted path")
        if stat.S_ISREG(info.st_mode):
            files[str(relative)] = hashlib.sha256(candidate.read_bytes()).hexdigest()
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError("release contains an unsupported path")
    return files


def route_summary(path: Path, now_ms: int) -> tuple[dict[str, Any], dict[str, Any]]:
    document = read_json(path, maximum=262_144)
    if set(document) != ROUTE_KEYS or type(document.get("integrity")) is not dict:
        raise ValueError("route snapshot shape is invalid")
    integrity = document["integrity"]
    payload = {key: value for key, value in document.items() if key != "integrity"}
    digest = hashlib.sha256(canonical(payload)).hexdigest()
    if (
        set(integrity) != {"algorithm", "canonicalPayloadSha256"}
        or integrity.get("algorithm") != "sha256"
        or integrity.get("canonicalPayloadSha256") != digest
    ):
        raise ValueError("route snapshot integrity is invalid")
    generated = document.get("generatedAtMs")
    valid_until = document.get("validUntilMs")
    generation = document.get("generation")
    routes = document.get("routes")
    if (
        document.get("schemaVersion") != 1
        or document.get("defaultOwner") != "HERMES"
        or type(generation) is not int
        or not 0 <= generation <= MAX_SAFE_INTEGER
        or type(generated) is not int
        or not 0 <= generated <= MAX_SAFE_INTEGER
        or type(valid_until) is not int
        or not 0 <= valid_until <= MAX_SAFE_INTEGER
        or valid_until <= generated
        or valid_until - generated < 5_000
        or valid_until - generated > 300_000
        or generated > now_ms + 30_000
        or now_ms > valid_until
        or type(routes) is not list
        or len(routes) > MAX_ROUTES
    ):
        raise ValueError("route snapshot is stale or invalid")
    prior_stream = 0
    total_topics = 0
    for route in routes:
        if type(route) is not dict or set(route) != ROUTE_ITEM_KEYS:
            raise ValueError("route entry shape is invalid")
        stream_id = route["streamId"]
        owner = route["owner"]
        project_id = route["projectId"]
        topics = route["topics"]
        if (
            type(stream_id) is not int
            or not 0 < stream_id <= MAX_SAFE_INTEGER
            or stream_id <= prior_stream
            or owner not in {"PROJECT", "HERMES"}
            or route["source"] not in {"runtime", "static", "default"}
            or type(topics) is not list
            or (
                owner == "PROJECT"
                and (type(project_id) is not str or PROJECT_ID.fullmatch(project_id) is None)
            )
            or (owner == "HERMES" and project_id is not None)
        ):
            raise ValueError("route entry is invalid")
        prior_stream = stream_id
        prior_topic: bytes | None = None
        for topic_item in topics:
            if type(topic_item) is not dict or set(topic_item) != TOPIC_ITEM_KEYS:
                raise ValueError("route topic shape is invalid")
            topic = topic_item["topic"]
            if type(topic) is not str:
                raise ValueError("route topic is invalid")
            encoded = topic.encode("utf-8")
            if (
                not encoded
                or len(encoded) > 256
                or topic_item["mode"] not in {"HERMES_ONLY", "CODEX_BOUND"}
                or (prior_topic is not None and encoded <= prior_topic)
            ):
                raise ValueError("route topic is invalid")
            prior_topic = encoded
            total_topics += 1
    if total_topics > MAX_TOPICS:
        raise ValueError("route snapshot has too many topics")
    semantic = {
        "defaultOwner": document["defaultOwner"],
        "routes": sorted(
            (
                {
                    "streamId": route.get("streamId"),
                    "owner": route.get("owner"),
                    "projectId": route.get("projectId"),
                    "source": route.get("source"),
                    "topics": route.get("topics"),
                }
                for route in routes
            ),
            key=lambda route: (route.get("streamId") is None, route.get("streamId")),
        ),
    }
    summary = {
        "generation": generation,
        "semanticSha256": hashlib.sha256(canonical(semantic)).hexdigest(),
    }
    inventory = {
        str(route.get("streamId")): {
            "owner": route.get("owner"),
            "projectId": route.get("projectId"),
        }
        for route in routes
    }
    return summary, inventory


def process_alive(pid: object) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def run_trace(database: Path, message_id: int, audit_file: Path | None) -> dict[str, Any]:
    command = [
        sys.executable,
        str(Path(__file__).with_name("trace-zulip-message.py")),
        "--database",
        str(database),
        "--source-message-id",
        str(message_id),
        "--json",
    ]
    if audit_file is not None:
        command += ["--audit-file", str(audit_file)]
    process = subprocess.run(command, capture_output=True, text=True, check=False)
    try:
        report = json.loads(process.stdout)
    except json.JSONDecodeError:
        return {"status": "ERROR", "exitCode": process.returncode}
    report["exitCode"] = process.returncode
    return report


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# HCO Post-deploy Smoke Report",
        "",
        f"- Status: {report['status']}",
        f"- Mode: {report['mode']}",
        f"- Generated at: {report['generatedAtMs']}",
        "",
        "## Checks",
        "",
    ]
    lines += [f"- {item['status']} `{item['code']}`: {item['detail']}" for item in report["checks"]]
    if report.get("routePreconditions"):
        lines += ["", "## Route Preconditions", ""]
        lines += [
            f"- `{name}`: {value['status']} ({value['detail']})"
            for name, value in report["routePreconditions"].items()
        ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only HCO post-deploy preflight")
    parser.add_argument(
        "--install-root",
        default=str(Path.home() / "Library/Application Support/HermesCodexBridge"),
    )
    parser.add_argument("--hco-config", default=os.environ.get("HCO_CONFIG_PATH"))
    parser.add_argument("--manifest")
    parser.add_argument("--stable-link")
    parser.add_argument("--attestation-file")
    parser.add_argument("--source-message-id", type=int)
    parser.add_argument("--audit-file")
    parser.add_argument("--unmapped-stream-id", type=int)
    parser.add_argument("--project-stream-id", type=int)
    parser.add_argument("--hermes-stream-id", type=int)
    parser.add_argument("--output-json")
    parser.add_argument("--output-markdown")
    args = parser.parse_args()

    install_root = Path(args.install_root).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser() if args.manifest else install_root / "deployment-manifest.json"
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
    stable_link = Path(args.stable_link).expanduser() if args.stable_link else hermes_home / "plugins/hermes-codex-bridge"
    attestation_path = Path(args.attestation_file).expanduser() if args.attestation_file else hermes_home / "hermes-codex-bridge-attestation.json"
    checks: list[dict[str, str]] = []
    route_preconditions: dict[str, dict[str, str]] = {}
    trace: dict[str, Any] | None = None
    manifest: dict[str, Any] = {}
    config: dict[str, Any] = {}
    inventory: dict[str, Any] = {}

    try:
        manifest = read_json(manifest_path)
        checks.append(check(manifest.get("status") == "COMMITTED", "MANIFEST_COMMITTED", "deployment manifest is committed"))
        checks.append(check(stat.S_IMODE(manifest_path.stat().st_mode) == 0o600, "MANIFEST_MODE", "deployment manifest mode is 0600"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        checks.append(check(False, "MANIFEST_TRUST", type(error).__name__))

    try:
        release = Path(str(manifest["releasePath"]))
        stable_target = stable_link.resolve(strict=True)
        checks.append(check(stable_link.is_symlink(), "STABLE_SYMLINK", "stable plugin path is a symlink"))
        checks.append(check(stable_target == release.resolve(strict=True), "STABLE_TARGET", "stable symlink targets the committed release"))
        checks.append(check(manifest.get("stableSymlinkTarget") == str(stable_target), "STABLE_MANIFEST", "stable symlink target matches deployment manifest"))
        files = release_files(release)
        release_hash = hashlib.sha256(canonical(files)).hexdigest()
        checks.append(check(release_hash == manifest.get("releaseManifestSha256"), "RELEASE_MANIFEST", "release content matches deployment manifest"))
        checks.append(check(manifest.get("sourceManifestSha256") == manifest.get("releaseManifestSha256"), "SOURCE_RELEASE_MATCH", "source and release manifests match"))
    except (KeyError, OSError, ValueError) as error:
        checks.append(check(False, "RELEASE_TRUST", type(error).__name__))

    try:
        attestation = read_json(attestation_path)
        expected_attestation = manifest.get("gatewayAttestation")
        checks.append(check(attestation == expected_attestation, "ATTESTATION_MATCH", "live attestation matches deployment manifest"))
        pid = manifest.get("gatewayPidAfter")
        checks.append(check(attestation.get("pid") == pid and process_alive(pid), "GATEWAY_PID", "attested gateway PID is alive"))
        services = manifest.get("services", {})
        checks.append(check(all(services.get(name) == {"loaded": True, "running": True} for name in ("gateway", "hco", "delivery")), "SERVICE_COMMIT", "deployment committed all service states as running; only gateway PID is checked live"))
    except (OSError, ValueError, json.JSONDecodeError, AttributeError) as error:
        checks.append(check(False, "ATTESTATION_TRUST", type(error).__name__))

    try:
        if not args.hco_config:
            raise ValueError("--hco-config or HCO_CONFIG_PATH is required")
        config = read_json(Path(args.hco_config).expanduser())
        route_path = Path(config["bridge"]["routeSnapshotPath"])
        summary, inventory = route_summary(route_path, int(time.time() * 1000))
        checks.append(check(summary == manifest.get("routeSnapshot", {}).get("after"), "ROUTE_SEMANTIC", "live route generation and semantic hash match deployment manifest"))
        checks.append(check(True, "ROUTE_INTEGRITY", "route snapshot integrity and freshness are valid"))
    except (KeyError, OSError, ValueError, json.JSONDecodeError, TypeError) as error:
        checks.append(check(False, "ROUTE_TRUST", type(error).__name__))

    requested = {
        "unmapped": (args.unmapped_stream_id, None),
        "project": (args.project_stream_id, "PROJECT"),
        "hermes": (args.hermes_stream_id, "HERMES"),
    }
    for name, (stream_id, expected_owner) in requested.items():
        if stream_id is None:
            continue
        route = inventory.get(str(stream_id))
        valid = route is None if expected_owner is None else route is not None and route.get("owner") == expected_owner
        detail = (
            f"stream {stream_id} is unmapped"
            if expected_owner is None
            else f"stream {stream_id} has explicit owner={expected_owner}"
        )
        route_preconditions[name] = {
            "status": "READY" if valid else "BLOCKED_PRECONDITION",
            "detail": detail,
        }

    if args.source_message_id is not None:
        try:
            database = Path(config["databasePath"])
            audit = Path(args.audit_file).expanduser() if args.audit_file else None
            trace = run_trace(database, args.source_message_id, audit)
            checks.append(check(trace.get("exitCode") == 0, "MESSAGE_TRACE", "sourceMessageId trace completed"))
        except (KeyError, TypeError, ValueError) as error:
            checks.append(check(False, "MESSAGE_TRACE", type(error).__name__))

    status_value = "PASS" if checks and all(item["status"] == "PASS" for item in checks) else "FAIL"
    report = {
        "schemaVersion": 1,
        "mode": "DRY_RUN",
        "generatedAtMs": int(time.time() * 1000),
        "status": status_value,
        "checks": checks,
        "routePreconditions": route_preconditions,
        "trace": trace,
        "sideEffects": "none except explicitly requested report files",
    }
    rendered_json = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output_json:
        output_json = Path(args.output_json)
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text(rendered_json, encoding="utf-8")
    if args.output_markdown:
        output_markdown = Path(args.output_markdown)
        output_markdown.parent.mkdir(parents=True, exist_ok=True)
        output_markdown.write_text(markdown(report), encoding="utf-8")
    print(rendered_json, end="")
    return 0 if status_value == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
