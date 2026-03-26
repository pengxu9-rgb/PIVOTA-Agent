#!/usr/bin/env python3
"""Export a filtered signal-review packet for selected signal buckets."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to export ingredient signal bucket packets. Install it in the local Python environment first."
    ) from exc


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_xlsx(path: Path, sheet_name: str, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.append(fieldnames)
    for row in rows:
        sheet.append([row.get(field, "") for field in fieldnames])
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a filtered signal-review packet for selected signal buckets.")
    parser.add_argument("--packet-csv", required=True, help="Signal review packet CSV")
    parser.add_argument(
        "--signal-bucket",
        action="append",
        required=True,
        help="Suggested signal bucket to include. May be passed multiple times.",
    )
    parser.add_argument("--out-csv", required=True, help="Where to write the filtered packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write packet summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX output for the filtered packet")
    parser.add_argument("--sheet-name", default="Signal_Bucket_Packet", help="Optional XLSX sheet name")
    args = parser.parse_args()

    in_path = Path(args.packet_csv).expanduser().resolve()
    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()
    requested_buckets = [normalize_text(value) for value in args.signal_bucket if normalize_text(value)]
    requested_bucket_set = set(requested_buckets)

    fieldnames, rows = load_rows(in_path)
    filtered_rows = [
        row
        for row in rows
        if normalize_text(row.get("suggested_signal_bucket")) in requested_bucket_set
    ]

    write_csv(out_csv, fieldnames, filtered_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Signal_Bucket_Packet", fieldnames, filtered_rows)

    summary = {
        "packet_csv": str(in_path),
        "requested_signal_buckets": requested_buckets,
        "row_count": len(filtered_rows),
        "suggested_signal_bucket_counts": dict(
            Counter(normalize_text(row.get("suggested_signal_bucket")) for row in filtered_rows)
        ),
        "decision_counts": dict(Counter(normalize_text(row.get("decision")) for row in filtered_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
