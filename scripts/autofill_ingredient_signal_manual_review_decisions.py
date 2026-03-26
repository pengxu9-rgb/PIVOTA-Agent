#!/usr/bin/env python3
"""Autofill grouped signal manual-review packet decisions for selected signal buckets."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Autofill grouped signal manual-review packet decisions for selected signal buckets.")
    parser.add_argument("--decision-csv", required=True, help="Input grouped signal manual-review packet CSV")
    parser.add_argument("--out-csv", required=True, help="Output CSV with autofilled decisions")
    parser.add_argument(
        "--approve-bucket",
        action="append",
        default=[],
        help="Grouped signal bucket to auto-mark as approve_grouped_signal. May be passed multiple times.",
    )
    parser.add_argument(
        "--only-empty-decision",
        action="store_true",
        help="Only autofill rows whose decision cell is currently empty",
    )
    args = parser.parse_args()

    in_path = Path(args.decision_csv).expanduser().resolve()
    out_path = Path(args.out_csv).expanduser().resolve()
    approve_buckets = {normalize_text(value) for value in args.approve_bucket if normalize_text(value)}

    fieldnames, rows = load_rows(in_path)
    updated_count = 0
    touched_buckets: dict[str, int] = {}

    for row in rows:
        bucket = normalize_text(row.get("grouped_signal_bucket"))
        current_decision = normalize_text(row.get("decision"))
        if bucket not in approve_buckets:
            continue
        if args.only_empty_decision and current_decision:
            continue
        row["decision"] = "approve_grouped_signal"
        if "approved_signal_bucket" in row and not normalize_text(row.get("approved_signal_bucket")):
            row["approved_signal_bucket"] = bucket
        if "approved_signal_key" in row and not normalize_text(row.get("approved_signal_key")):
            row["approved_signal_key"] = normalize_text(row.get("grouped_signal_key"))
        updated_count += 1
        touched_buckets[bucket] = touched_buckets.get(bucket, 0) + 1

    write_rows(out_path, fieldnames, rows)

    print(
        json.dumps(
            {
                "source_decision_csv": str(in_path),
                "out_csv": str(out_path),
                "approve_buckets": sorted(approve_buckets),
                "updated_count": updated_count,
                "touched_buckets": touched_buckets,
                "only_empty_decision": bool(args.only_empty_decision),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
