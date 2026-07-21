from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest


ATTESTATION_FILE = "hermes-codex-bridge-attestation.json"
_original_home = Path(os.environ.get("HOME", str(Path.home()))).resolve()
_original_hermes_home = Path(
    os.environ.get("HERMES_HOME", str(_original_home / ".hermes"))
).resolve()
_guarded_attestations = tuple(
    dict.fromkeys(
        (
            _original_home / ".hermes" / ATTESTATION_FILE,
            _original_hermes_home / ATTESTATION_FILE,
        )
    )
)


def _snapshot_attestation(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


_attestation_snapshots = {
    path: _snapshot_attestation(path) for path in _guarded_attestations
}
_test_root = Path(tempfile.mkdtemp(prefix="hco-pytest-"))
_test_home = _test_root / "home"
_test_hermes_home = _test_home / ".hermes"
_test_hermes_home.mkdir(parents=True)
_test_home.chmod(0o700)
_test_hermes_home.chmod(0o700)
os.environ["HOME"] = str(_test_home)
os.environ["HERMES_HOME"] = str(_test_hermes_home)
os.environ["HCO_PYTEST_ISOLATED_HOME"] = str(_test_hermes_home)


@pytest.fixture(scope="session", autouse=True)
def _isolate_hermes_process_state():
    yield

    try:
        changed = [
            str(path)
            for path, before in _attestation_snapshots.items()
            if _snapshot_attestation(path) != before
        ]
        assert changed == [], f"pytest modified live Hermes attestation: {changed}"
    finally:
        shutil.rmtree(_test_root, ignore_errors=True)
