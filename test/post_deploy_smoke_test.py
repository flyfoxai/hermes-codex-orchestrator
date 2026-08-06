from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest


REPO = Path(__file__).resolve().parents[1]
SMOKE = REPO / "scripts/hco-post-deploy-smoke.py"
API_ACCEPTANCE = REPO / "scripts/hco-fix2-api-acceptance.py"


def canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def write_owner_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(value) + b"\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def route_document(routes: list[dict[str, Any]], *, now_ms: int | None = None) -> dict[str, Any]:
    generated = int(time.time() * 1000) if now_ms is None else now_ms
    payload = {
        "schemaVersion": 1,
        "generation": 7,
        "generatedAtMs": generated,
        "validUntilMs": generated + 60_000,
        "defaultOwner": "HERMES",
        "routes": routes,
    }
    return {
        **payload,
        "integrity": {
            "algorithm": "sha256",
            "canonicalPayloadSha256": hashlib.sha256(canonical(payload)).hexdigest(),
        },
    }


def route_summary(document: dict[str, Any]) -> dict[str, Any]:
    semantic = {
        "defaultOwner": document["defaultOwner"],
        "routes": [
            {
                "streamId": route["streamId"],
                "owner": route["owner"],
                "projectId": route["projectId"],
                "source": route["source"],
                "topics": route["topics"],
            }
            for route in document["routes"]
        ],
    }
    return {
        "generation": document["generation"],
        "semanticSha256": hashlib.sha256(canonical(semantic)).hexdigest(),
    }


def create_fixture(tmp_path: Path) -> dict[str, Path]:
    install_root = tmp_path / "install"
    release = install_root / "releases/release-1"
    release.mkdir(parents=True)
    (release / "plugin.py").write_text("VALUE = 1\n", encoding="utf-8")
    release_files = {
        "plugin.py": hashlib.sha256((release / "plugin.py").read_bytes()).hexdigest()
    }
    release_hash = hashlib.sha256(canonical(release_files)).hexdigest()

    stable = tmp_path / "hermes/plugins/hermes-codex-bridge"
    stable.parent.mkdir(parents=True)
    stable.symlink_to(release)

    routes = route_document(
        [
            {
                "streamId": 10,
                "owner": "PROJECT",
                "projectId": "stockprofits",
                "source": "static",
                "topics": [],
            }
        ]
    )
    route_path = tmp_path / "routes.json"
    write_owner_json(route_path, routes)

    config_path = tmp_path / "hco.json"
    write_owner_json(
        config_path,
        {
            "databasePath": str(tmp_path / "authority.sqlite3"),
            "bridge": {"routeSnapshotPath": str(route_path)},
        },
    )

    attestation = {
        "schemaVersion": 1,
        "pid": os.getpid(),
        "pluginPath": str(release),
        "pluginVersion": "1.0.0",
        "hook": "message",
        "ingressProfile": "codex-bridge",
    }
    attestation_path = tmp_path / "attestation.json"
    write_owner_json(attestation_path, attestation)

    manifest = {
        "schemaVersion": 1,
        "status": "COMMITTED",
        "releasePath": str(release),
        "stableSymlinkTarget": str(release),
        "sourceManifestSha256": release_hash,
        "releaseManifestSha256": release_hash,
        "gatewayPidAfter": os.getpid(),
        "gatewayAttestation": attestation,
        "services": {
            "gateway": {"loaded": True, "running": True},
            "hco": {"loaded": True, "running": True},
            "delivery": {"loaded": True, "running": True},
        },
        "routeSnapshot": {"after": route_summary(routes)},
    }
    manifest_path = install_root / "deployment-manifest.json"
    write_owner_json(manifest_path, manifest)
    return {
        "install_root": install_root,
        "manifest": manifest_path,
        "stable": stable,
        "attestation": attestation_path,
        "config": config_path,
        "route": route_path,
        "release": release,
    }


def run_smoke(paths: dict[str, Path], *extra: str) -> tuple[int, dict[str, Any]]:
    process = subprocess.run(
        [
            sys.executable,
            str(SMOKE),
            "--install-root",
            str(paths["install_root"]),
            "--hco-config",
            str(paths["config"]),
            "--stable-link",
            str(paths["stable"]),
            "--attestation-file",
            str(paths["attestation"]),
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return process.returncode, json.loads(process.stdout)


def check_status(report: dict[str, Any], code: str) -> str:
    return next(item["status"] for item in report["checks"] if item["code"] == code)


def test_smoke_accepts_consistent_deployment_and_creates_reports(tmp_path: Path) -> None:
    paths = create_fixture(tmp_path)
    json_report = tmp_path / "reports/smoke.json"
    markdown_report = tmp_path / "reports/smoke.md"

    code, report = run_smoke(
        paths,
        "--project-stream-id",
        "10",
        "--unmapped-stream-id",
        "20",
        "--hermes-stream-id",
        "30",
        "--output-json",
        str(json_report),
        "--output-markdown",
        str(markdown_report),
    )

    assert code == 0
    assert report["status"] == "PASS"
    assert report["mode"] == "DRY_RUN"
    assert report["routePreconditions"]["project"]["status"] == "READY"
    assert report["routePreconditions"]["unmapped"]["status"] == "READY"
    assert report["routePreconditions"]["hermes"]["status"] == "BLOCKED_PRECONDITION"
    assert json.loads(json_report.read_text(encoding="utf-8"))["status"] == "PASS"
    assert "HCO Post-deploy Smoke Report" in markdown_report.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("mutation", "expected_check"),
    [
        ("manifest", "MANIFEST_COMMITTED"),
        ("stable", "STABLE_TARGET"),
        ("stable-manifest", "STABLE_MANIFEST"),
        ("semantic", "ROUTE_SEMANTIC"),
        ("stale", "ROUTE_TRUST"),
        ("route-schema", "ROUTE_TRUST"),
    ],
)
def test_smoke_rejects_inconsistent_evidence(
    tmp_path: Path, mutation: str, expected_check: str
) -> None:
    paths = create_fixture(tmp_path)
    if mutation == "manifest":
        manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
        manifest["status"] = "PREPARED"
        write_owner_json(paths["manifest"], manifest)
    elif mutation == "stable":
        other_release = paths["release"].parent / "release-2"
        other_release.mkdir()
        paths["stable"].unlink()
        paths["stable"].symlink_to(other_release)
    elif mutation == "stable-manifest":
        manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
        manifest["stableSymlinkTarget"] = str(paths["release"].parent / "release-2")
        write_owner_json(paths["manifest"], manifest)
    elif mutation == "semantic":
        manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
        manifest["routeSnapshot"]["after"]["semanticSha256"] = "0" * 64
        write_owner_json(paths["manifest"], manifest)
    elif mutation == "stale":
        write_owner_json(paths["route"], route_document([], now_ms=1_000))
    else:
        invalid = route_document(
            [
                {
                    "streamId": 10,
                    "owner": "PROJECT",
                    "projectId": None,
                    "source": "static",
                    "topics": [],
                }
            ]
        )
        write_owner_json(paths["route"], invalid)

    code, report = run_smoke(paths)

    assert code == 1
    assert report["status"] == "FAIL"
    assert check_status(report, expected_check) == "FAIL"


def test_api_acceptance_requires_explicit_send(tmp_path: Path) -> None:
    process = subprocess.run(
        [sys.executable, str(API_ACCEPTANCE), "--output", str(tmp_path / "result.json")],
        capture_output=True,
        text=True,
        check=False,
    )

    assert process.returncode == 2
    assert "real Zulip messages require explicit --send" in process.stderr
    assert not (tmp_path / "result.json").exists()


def test_automated_acceptance_defaults_to_no_send() -> None:
    script = (REPO / "scripts/hco-fix2-automated-acceptance.sh").read_text(
        encoding="utf-8"
    )

    assert "send=false" in script
    assert "if $send; then" in script
    assert "SKIPPED_NO_SEND" in script
    assert "SKIPPED_NO_RUNTIME_CONFIG" in script
    assert "BLOCKED_PREFLIGHT_REQUIRED" in script
    assert "if $preflight_ready; then" in script
    assert "hco-post-deploy-smoke.py" in script
    assert "hco-fix2-api-acceptance.py\" --send" in script
