#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import zulip


ENTITIES = {
    "&": "&#38;",
    "\\": "&#92;",
    "*": "&#42;",
    "_": "&#95;",
    "`": "&#96;",
    "[": "&#91;",
    "]": "&#93;",
    "(": "&#40;",
    ")": "&#41;",
    "#": "&#35;",
    "!": "&#33;",
    "@": "&#64;",
    "<": "&#60;",
    ">": "&#62;",
    "|": "&#124;",
}
SEPARATORS = ("\r\n", "\r", "\n", "\x0b", "\x0c", "\x85", "\u2028", "\u2029")
DANGEROUS_TAGS = re.compile(r"<(?:em|strong|a|code|table|blockquote|ul|ol|li)\b", re.I)
MENTION_MARKERS = re.compile(r"(?:data-user-id|user-group-mention|mention|@all|@everyone)", re.I)
USER_MENTION_CLASS = re.compile(
    r'class=(?:"[^"]*\buser-mention\b[^"]*"|\'[^\']*\buser-mention\b[^\']*\')',
    re.I,
)


def escape_inline(value: str) -> str:
    value = re.sub(r"\r\n|[\n\r\v\f\x85\u2028\u2029]", " ", value)
    return "".join(ENTITIES.get(char, char) for char in value)


def response_message(client: zulip.Client, message_id: int) -> dict:
    result = client.get_messages(
        {
            "anchor": message_id,
            "num_before": 0,
            "num_after": 0,
            "narrow": [{"operator": "id", "operand": str(message_id)}],
            "apply_markdown": True,
        }
    )
    messages = result.get("messages", []) if isinstance(result, dict) else []
    if len(messages) != 1:
        raise RuntimeError(f"message readback returned {len(messages)} messages")
    return messages[0]


def send_and_check(client: zulip.Client, stream_id: int, topic: str, case_id: str, content: str, checks: dict) -> dict:
    response = client.send_message({"type": "stream", "to": str(stream_id), "topic": topic, "content": content})
    if response.get("result") != "success" or not isinstance(response.get("id"), int):
        raise RuntimeError(f"send failed: {response.get('code', 'unknown')}")
    message_id = response["id"]
    message = response_message(client, message_id)
    raw = content
    rendered = str(message.get("content", ""))
    failures = []
    for name, predicate in checks.items():
        if not predicate(raw, rendered):
            failures.append(name)
    return {
        "case_id": case_id,
        "message_id": message_id,
        "raw_sha256": __import__("hashlib").sha256(raw.encode()).hexdigest(),
        "rendered_sha256": __import__("hashlib").sha256(rendered.encode()).hexdigest(),
        "raw_bytes": len(raw.encode()),
        "rendered_bytes": len(rendered.encode()),
        "status": "PASS" if not failures else "FAIL",
        "failures": failures,
    }


def no_unsafe_html(_raw: str, rendered: str) -> bool:
    return not DANGEROUS_TAGS.search(rendered) and not MENTION_MARKERS.search(rendered)


def has_user_mention(_raw: str, rendered: str) -> bool:
    return USER_MENTION_CLASS.search(rendered) is not None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--config", default=str(Path.home() / ".zuliprc"))
    parser.add_argument("--stream-id", type=int, default=2)
    parser.add_argument("--topic")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not args.send:
        parser.error("real Zulip messages require explicit --send")
    run_id = "hco-api-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    topic = args.topic or run_id
    client = zulip.Client(config_file=args.config, retry_on_errors=False)
    records = []
    prefix = f"{run_id} "
    try:
        normal = prefix + escape_inline("B01 obj-1 LIVE-POSTFIX.S-001 release-2.4.1 alpha_beta")
        records.append(send_and_check(client, args.stream_id, topic, "B-01", normal, {
            "identifiers": lambda raw, _rendered: all(x in raw for x in ("obj-1", "LIVE-POSTFIX.S-001", "release-2.4.1")),
            "markdown_safe": no_unsafe_html,
        }))
        for index, separator in enumerate(SEPARATORS, 1):
            content = prefix + escape_inline(f"B02-{index} before{separator}after")
            records.append(send_and_check(client, args.stream_id, topic, f"B-02-{index}", content, {
                "flattened": lambda raw, _rendered: "before after" in html.unescape(raw) and all(s not in raw for s in SEPARATORS),
                "markdown_safe": no_unsafe_html,
            }))
        controls = prefix + escape_inline("B03 <tag>|@**all**_[x](https://example.invalid)#bang!`code`\\")
        records.append(send_and_check(client, args.stream_id, topic, "B-03", controls, {
            "raw_encoded": lambda raw, _rendered: all(entity in raw for entity in ("&#60;", "&#124;", "&#64;", "&#42;", "&#95;")),
            "markdown_safe": no_unsafe_html,
        }))
        entities = prefix + escape_inline("B04 &#42; &#64;all &#60;tag&#62;")
        records.append(send_and_check(client, args.stream_id, topic, "B-04", entities, {
            "ampersand_first": lambda raw, _rendered: "&#38;&#35;42;" in raw and "&#38;&#35;64;all" in raw,
            "markdown_safe": no_unsafe_html,
        }))
        long_value = "A" * 7400 + " END-obj-1-@**all**-<tag>-|"
        boundary = prefix + escape_inline("B05 " + long_value)
        records.append(send_and_check(client, args.stream_id, topic, "B-05", boundary, {
            "tail_present": lambda raw, _rendered: "END-obj-1-" in html.unescape(raw),
            "utf8_valid": lambda raw, _rendered: raw.encode("utf-8").decode("utf-8") == raw,
            "markdown_safe": no_unsafe_html,
        }))
        profile = client.get_profile()
        mention_name = profile.get("full_name") if isinstance(profile, dict) else None
        if not isinstance(mention_name, str) or not mention_name.strip():
            raise RuntimeError("profile did not provide a mentionable full_name")
        mention = prefix + f"B06 @**{mention_name}** mention-render-check"
        records.append(send_and_check(client, args.stream_id, topic, "B-06", mention, {
            "user_mention_html": has_user_mention,
        }))
    except Exception as error:
        records.append({"case_id": "API-RUNNER", "status": "FAIL", "failures": [type(error).__name__]})
    report = {
        "run_id": run_id,
        "stream_id": args.stream_id,
        "topic": topic,
        "credentials": "read from local config; not recorded",
        "records": records,
        "status": "PASS" if records and all(r.get("status") == "PASS" for r in records) else "FAIL",
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"run_id": run_id, "topic": topic, "status": report["status"], "messages": sum(1 for r in records if "message_id" in r)}, ensure_ascii=False))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
