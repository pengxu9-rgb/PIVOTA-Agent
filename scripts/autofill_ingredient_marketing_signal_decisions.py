#!/usr/bin/env python3
"""Autofill marketing-signal decision packet for selected marketing subtypes."""

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
    parser = argparse.ArgumentParser(description="Autofill marketing-signal decision packet for selected marketing subtypes.")
    parser.add_argument("--decision-csv", required=True, help="Input marketing-signal decision packet CSV")
    parser.add_argument("--out-csv", required=True, help="Output CSV with autofilled decisions")
    parser.add_argument(
        "--approve-subtype",
        action="append",
        default=[],
        help="Marketing subtype to auto-mark as approve_suggestion. May be passed multiple times.",
    )
    parser.add_argument(
        "--only-empty-decision",
        action="store_true",
        help="Only autofill rows whose decision cell is currently empty",
    )
    args = parser.parse_args()

    in_path = Path(args.decision_csv).expanduser().resolve()
    out_path = Path(args.out_csv).expanduser().resolve()
    approve_subtypes = {normalize_text(value) for value in args.approve_subtype if normalize_text(value)}

    fieldnames, rows = load_rows(in_path)
    updated_count = 0
    touched_subtypes: dict[str, int] = {}

    for row in rows:
        subtype = normalize_text(row.get("suggested_marketing_subtype"))
        current_decision = normalize_text(row.get("decision"))
        if subtype not in approve_subtypes:
            continue
        if args.only_empty_decision and current_decision:
            continue
        row["decision"] = "approve_suggestion"
        if "approved_signal_bucket" in row and not normalize_text(row.get("approved_signal_bucket")):
            row["approved_signal_bucket"] = normalize_text(row.get("suggested_signal_bucket"))
        if "approved_signal_key" in row and not normalize_text(row.get("approved_signal_key")):
            row["approved_signal_key"] = normalize_text(row.get("suggested_signal_key"))
        if "approved_marketing_subtype" in row and not normalize_text(row.get("approved_marketing_subtype")):
            row["approved_marketing_subtype"] = subtype
        updated_count += 1
        touched_subtypes[subtype] = touched_subtypes.get(subtype, 0) + 1

    write_rows(out_path, fieldnames, rows)

    print(
        json.dumps(
            {
                "source_decision_csv": str(in_path),
                "out_csv": str(out_path),
                "approve_subtypes": sorted(approve_subtypes),
                "updated_count": updated_count,
                "touched_subtypes": touched_subtypes,
                "only_empty_decision": bool(args.only_empty_decision),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
