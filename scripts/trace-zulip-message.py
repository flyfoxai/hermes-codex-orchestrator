#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import stat
import sys
from pathlib import Path


def rows(connection: sqlite3.Connection, query: str, parameters: tuple) -> list[dict]:
    return [dict(row) for row in connection.execute(query, parameters).fetchall()]


def trusted_database(path: Path) -> Path:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("database must be an owner-only regular file")
    if info.st_mode & 0o077:
        raise ValueError("database permissions are too broad")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--source-message-id", type=int, required=True)
    parser.add_argument("--audit-file")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        database = trusted_database(Path(args.database).resolve(strict=True))
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    except (OSError, ValueError, sqlite3.Error) as error:
        report = {
            "schemaVersion": 1,
            "status": "UNTRUSTED",
            "sourceMessageId": args.source_message_id,
            "error": str(error),
        }
        print(json.dumps(report, ensure_ascii=False, sort_keys=True) if args.json else f"UNTRUSTED: {error}")
        return 3
    connection.row_factory = sqlite3.Row
    source_id = str(args.source_message_id)
    inbound = rows(connection, "SELECT source_type, source_id, objective_id, submission_id, created_at_ms FROM inbound_intents WHERE source_type = 'zulip-message' AND source_id = ?", (source_id,))
    objective_ids = sorted({row["objective_id"] for row in inbound})
    objectives = []
    submissions = []
    outbox = []
    for objective_id in objective_ids:
        objectives += rows(connection, "SELECT objective_id, state, created_at_ms, updated_at_ms FROM objectives WHERE objective_id = ?", (objective_id,))
        submissions += rows(connection, "SELECT submission_id, objective_id, turn_id, submission_state, terminal_status, created_at_ms, updated_at_ms FROM turn_submissions WHERE objective_id = ?", (objective_id,))
        outbox += rows(connection, "SELECT delivery_id, objective_id, state, attempt_count, acknowledged_zulip_message_id, created_at_ms, updated_at_ms FROM zulip_outbox WHERE objective_id = ? ORDER BY objective_sequence", (objective_id,))
    connection.close()
    report = {
        "schemaVersion": 1,
        "sourceMessageId": args.source_message_id,
        "layers": {
            "hcoInbound": {"status": "FOUND" if len(inbound) == 1 else "NOT_FOUND" if not inbound else "AMBIGUOUS", "records": inbound},
            "objectives": {"status": "AMBIGUOUS_SOURCE" if len(inbound) > 1 else "FOUND" if objectives else "NOT_APPLICABLE" if not inbound else "NOT_FOUND", "records": objectives},
            "turnSubmissions": {"status": "AMBIGUOUS_SOURCE" if len(inbound) > 1 else "FOUND" if submissions else "NOT_APPLICABLE" if not inbound else "NOT_FOUND", "records": submissions},
            "zulipOutbox": {"status": "AMBIGUOUS_SOURCE" if len(inbound) > 1 else "FOUND" if outbox else "NOT_APPLICABLE" if not inbound else "NOT_FOUND", "records": outbox},
        },
    }
    if args.audit_file:
        from subprocess import run
        process = run(
            [
                sys.executable,
                str(Path(__file__).with_name("query-hermes-route-audit.py")),
                "--audit-file",
                args.audit_file,
                "--source-message-id",
                source_id,
                "--json",
            ],
            capture_output=True,
            text=True,
        )
        try:
            report["layers"]["gatewayAudit"] = json.loads(process.stdout)
        except json.JSONDecodeError:
            report["layers"]["gatewayAudit"] = {"status": "ERROR"}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    else:
        for name, layer in report["layers"].items():
            print(f"{name}: {layer.get('status')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
