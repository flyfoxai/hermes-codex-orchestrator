from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
QUERY = ROOT / "scripts/query-hermes-route-audit.py"
TRACE = ROOT / "scripts/trace-zulip-message.py"


def run_json(script: Path, *args: str) -> tuple[int, dict]:
    process = subprocess.run(
        [sys.executable, str(script), *args, "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    return process.returncode, json.loads(process.stdout)


def test_route_audit_query_ignores_malformed_lines_and_finds_unique_record(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    record = {
        "schemaVersion": 1,
        "event": "hermes_codex_bridge.local_route_decision",
        "timestampMs": 100,
        "senderId": 17,
        "sourceMessageId": 542,
        "streamId": 99,
        "commandType": "RUN",
        "resultCode": "ROUTE_UNMAPPED_REGISTRATION",
        "topicBytes": 5,
        "topicSha256": "a" * 64,
    }
    audit.write_text(json.dumps(record) + "\n\x00bad\nnot-json\n", encoding="utf-8")
    audit.chmod(0o600)

    code, report = run_json(
        QUERY,
        "--audit-file",
        str(audit),
        "--source-message-id",
        "542",
    )

    assert code == 0
    assert report["status"] == "UNIQUE"
    assert report["malformedLines"] == 2
    assert report["matches"] == [record]


def test_route_audit_query_rejects_broad_permissions(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    audit.write_text("{}\n", encoding="utf-8")
    audit.chmod(0o644)

    code, report = run_json(
        QUERY,
        "--audit-file",
        str(audit),
        "--source-message-id",
        "1",
    )

    assert code == 3
    assert report["status"] == "UNTRUSTED"


def test_trace_is_read_only_and_does_not_expose_message_body(tmp_path: Path) -> None:
    database = tmp_path / "hco.sqlite"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE inbound_intents (
            source_type TEXT, source_id TEXT, objective_id TEXT,
            submission_id TEXT, created_at_ms INTEGER
        );
        CREATE TABLE objectives (
            objective_id TEXT, state TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
        );
        CREATE TABLE turn_submissions (
            submission_id TEXT, objective_id TEXT, turn_id TEXT,
            submission_state TEXT, terminal_status TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER
        );
        CREATE TABLE zulip_outbox (
            delivery_id TEXT, objective_id TEXT, state TEXT,
            attempt_count INTEGER, acknowledged_zulip_message_id INTEGER,
            created_at_ms INTEGER, updated_at_ms INTEGER, objective_sequence INTEGER
        );
        """
    )
    connection.execute(
        "INSERT INTO inbound_intents VALUES (?, ?, ?, ?, ?)",
        ("zulip-message", "542", "obj-1", "sub-1", 100),
    )
    connection.execute("INSERT INTO objectives VALUES (?, ?, ?, ?)", ("obj-1", "RUNNING", 100, 200))
    connection.execute(
        "INSERT INTO turn_submissions VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sub-1", "obj-1", "turn-1", "SUCCEEDED", "DONE", 100, 200),
    )
    connection.execute(
        "INSERT INTO zulip_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("del-1", "obj-1", "ACKED", 1, 543, 100, 200, 1),
    )
    connection.commit()
    before = database.read_bytes()
    connection.close()
    database.chmod(stat.S_IRUSR | stat.S_IWUSR)

    code, report = run_json(
        TRACE,
        "--database",
        str(database),
        "--source-message-id",
        "542",
    )

    assert code == 0
    assert report["sourceMessageId"] == 542
    assert report["layers"]["hcoInbound"]["status"] == "FOUND"
    assert report["layers"]["objectives"]["records"][0]["objective_id"] == "obj-1"
    serialized = json.dumps(report)
    assert "secret message body" not in serialized
    assert "payload_json" not in serialized
    assert "input_text" not in serialized
    assert database.read_bytes() == before


def test_trace_rejects_non_owner_only_database(tmp_path: Path) -> None:
    database = tmp_path / "hco.sqlite"
    database.write_bytes(b"not a database")
    database.chmod(0o644)

    code, report = run_json(
        TRACE,
        "--database",
        str(database),
        "--source-message-id",
        "1",
    )

    assert code != 0
    assert report["status"] == "UNTRUSTED"


def test_trace_reports_ambiguous_inbound_identity(tmp_path: Path) -> None:
    database = tmp_path / "hco.sqlite"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE inbound_intents (
            source_type TEXT, source_id TEXT, objective_id TEXT,
            submission_id TEXT, created_at_ms INTEGER
        );
        CREATE TABLE objectives (
            objective_id TEXT, state TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
        );
        CREATE TABLE turn_submissions (
            submission_id TEXT, objective_id TEXT, turn_id TEXT,
            submission_state TEXT, terminal_status TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER
        );
        CREATE TABLE zulip_outbox (
            delivery_id TEXT, objective_id TEXT, state TEXT,
            attempt_count INTEGER, acknowledged_zulip_message_id INTEGER,
            created_at_ms INTEGER, updated_at_ms INTEGER, objective_sequence INTEGER
        );
        INSERT INTO inbound_intents VALUES ('zulip-message', '542', 'obj-1', 'sub-1', 100);
        INSERT INTO inbound_intents VALUES ('zulip-message', '542', 'obj-2', 'sub-2', 101);
        """
    )
    connection.commit()
    connection.close()
    database.chmod(0o600)

    code, report = run_json(
        TRACE,
        "--database",
        str(database),
        "--source-message-id",
        "542",
    )

    assert code == 0
    assert report["layers"]["hcoInbound"]["status"] == "AMBIGUOUS"
    assert len(report["layers"]["hcoInbound"]["records"]) == 2
    assert report["layers"]["objectives"]["status"] == "AMBIGUOUS_SOURCE"
    assert report["layers"]["turnSubmissions"]["status"] == "AMBIGUOUS_SOURCE"
    assert report["layers"]["zulipOutbox"]["status"] == "AMBIGUOUS_SOURCE"
