#!/usr/bin/env python3
"""Build a grouped manual-review packet from signal-review remainder rows."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build ingredient signal manual-review packets. Install it in the local Python environment first."
    ) from exc


PACKET_FIELDS = [
    "grouped_signal_key",
    "grouped_signal_bucket",
    "grouped_raw_tokens",
    "source_row_count",
    "suggestion_confidence",
    "resolution_rationale",
    "example_raw_token",
    "decision",
    "approved_signal_bucket",
    "approved_signal_key",
    "reviewer_notes",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        text = normalize_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def build_packet_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        key = (
            normalize_text(row.get("suggested_signal_bucket")),
            normalize_text(row.get("suggested_signal_key")),
        )
        grouped[key].append(row)

    packet_rows: list[dict[str, str]] = []
    for (bucket, signal_key), group_rows in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
        raw_tokens = ordered_unique([row.get("raw_token", "") for row in group_rows])
        confidences = Counter(normalize_text(row.get("suggestion_confidence")) for row in group_rows)
        rationale = normalize_text(group_rows[0].get("resolution_rationale"))
        packet_rows.append(
            {
                "grouped_signal_key": signal_key,
                "grouped_signal_bucket": bucket,
                "grouped_raw_tokens": "; ".join(raw_tokens),
                "source_row_count": str(len(group_rows)),
                "suggestion_confidence": confidences.most_common(1)[0][0] if confidences else "",
                "resolution_rationale": rationale,
                "example_raw_token": raw_tokens[0] if raw_tokens else "",
                "decision": "",
                "approved_signal_bucket": bucket,
                "approved_signal_key": signal_key,
                "reviewer_notes": "",
            }
        )

    return packet_rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=PACKET_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def write_xlsx(path: Path, sheet_name: str, rows: list[dict[str, str]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.append(PACKET_FIELDS)
    for row in rows:
        sheet.append([row.get(field, "") for field in PACKET_FIELDS])
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a grouped manual-review packet from signal-review remainder rows.")
    parser.add_argument("--remainder-csv", required=True, help="Signal-review remainder CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write the grouped manual-review packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX output")
    parser.add_argument("--sheet-name", default="Signal_Manual_Review", help="Optional XLSX sheet name")
    args = parser.parse_args()

    in_path = Path(args.remainder_csv).expanduser().resolve()
    rows = load_rows(in_path)
    packet_rows = build_packet_rows(rows)

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()
    write_csv(out_csv, packet_rows)

    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Signal_Manual_Review", packet_rows)

    summary = {
        "remainder_csv": str(in_path),
        "input_row_count": len(rows),
        "grouped_row_count": len(packet_rows),
        "grouped_signal_bucket_counts": dict(Counter(row["grouped_signal_bucket"] for row in packet_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
