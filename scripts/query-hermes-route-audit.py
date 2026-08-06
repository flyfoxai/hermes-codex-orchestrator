#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import stat
from pathlib import Path


MAX_AUDIT_BYTES = 16 * 1024 * 1024
EXPECTED_FIELDS = {
    "schemaVersion",
    "event",
    "timestampMs",
    "senderId",
    "streamId",
    "sourceMessageId",
    "commandType",
    "resultCode",
    "topicBytes",
    "topicSha256",
}


def read_records(path: Path) -> tuple[list[dict], int]:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
            or info.st_size > MAX_AUDIT_BYTES
        ):
            raise ValueError("audit file is not a trusted owner-only regular file")
        raw = b""
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            raw += chunk
    finally:
        os.close(descriptor)
    records = []
    malformed = 0
    for line in raw.splitlines():
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            malformed += 1
            continue
        if type(value) is not dict or set(value) != EXPECTED_FIELDS:
            malformed += 1
            continue
        records.append(value)
    return records, malformed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-message-id", type=int, required=True)
    parser.add_argument("--stream-id", type=int)
    parser.add_argument("--result-code")
    default_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    parser.add_argument(
        "--audit-file",
        default=str(default_home / "hermes-codex-bridge-route-audit.jsonl"),
        help="route audit JSONL path (defaults to $HERMES_HOME or ~/.hermes)",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        records, malformed = read_records(Path(args.audit_file))
    except (OSError, ValueError) as error:
        report = {"schemaVersion": 1, "status": "UNTRUSTED", "matches": [], "malformedLines": 0, "error": str(error)}
        print(json.dumps(report, ensure_ascii=False) if args.json else f"UNTRUSTED: {error}")
        return 3
    matches = [
        record for record in records
        if record.get("sourceMessageId") == args.source_message_id
        and (args.stream_id is None or record.get("streamId") == args.stream_id)
        and (args.result_code is None or record.get("resultCode") == args.result_code)
    ]
    status = "UNIQUE" if len(matches) == 1 else "NOT_FOUND" if not matches else "AMBIGUOUS"
    report = {"schemaVersion": 1, "status": status, "matches": matches, "malformedLines": malformed}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    else:
        print(f"{status}: matches={len(matches)} malformed={malformed}")
        for record in matches:
            print(json.dumps(record, ensure_ascii=False, sort_keys=True))
    return {"UNIQUE": 0, "NOT_FOUND": 1, "AMBIGUOUS": 2}[status]


if __name__ == "__main__":
    raise SystemExit(main())
