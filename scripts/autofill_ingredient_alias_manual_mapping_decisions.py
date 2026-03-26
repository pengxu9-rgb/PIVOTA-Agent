#!/usr/bin/env python3
"""Autofill alias manual-mapping workbench decisions for selected safe suggestions."""

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
    parser = argparse.ArgumentParser(description="Autofill alias manual-mapping workbench decisions for selected safe suggestions.")
    parser.add_argument("--decision-csv", required=True, help="Input alias manual-mapping workbench CSV")
    parser.add_argument("--out-csv", required=True, help="Output CSV with autofilled decisions")
    parser.add_argument(
        "--approve-suggested-decision",
        action="append",
        default=[],
        help="Suggested decision value to auto-approve when confidence is high. May be passed multiple times.",
    )
    parser.add_argument(
        "--only-high-confidence",
        action="store_true",
        help="Only autofill rows whose suggestion_confidence is high",
    )
    parser.add_argument(
        "--only-empty-decision",
        action="store_true",
        help="Only autofill rows whose decision cell is currently empty",
    )
    args = parser.parse_args()

    in_path = Path(args.decision_csv).expanduser().resolve()
    out_path = Path(args.out_csv).expanduser().resolve()
    approved_decisions = {normalize_text(value) for value in args.approve_suggested_decision if normalize_text(value)}

    fieldnames, rows = load_rows(in_path)
    updated_count = 0
    touched_decisions: dict[str, int] = {}

    for row in rows:
        suggested_decision = normalize_text(row.get("suggested_decision"))
        suggestion_confidence = normalize_text(row.get("suggestion_confidence"))
        current_decision = normalize_text(row.get("decision"))

        if suggested_decision not in approved_decisions:
            continue
        if args.only_high_confidence and suggestion_confidence != "high":
            continue
        if args.only_empty_decision and current_decision:
            continue

        row["decision"] = suggested_decision
        if suggested_decision == "map_to_existing_canonical":
            row["approved_existing_target_record_id"] = normalize_text(row.get("suggested_existing_target_record_id"))
            row["approved_existing_target_canonical_inci_name"] = normalize_text(row.get("suggested_existing_target_canonical_inci_name"))
            row["approved_alias_quality"] = normalize_text(row.get("suggested_alias_quality")) or "exact_label_alias"
        updated_count += 1
        touched_decisions[suggested_decision] = touched_decisions.get(suggested_decision, 0) + 1

    write_rows(out_path, fieldnames, rows)

    print(
        json.dumps(
            {
                "source_decision_csv": str(in_path),
                "out_csv": str(out_path),
                "approved_suggested_decisions": sorted(approved_decisions),
                "updated_count": updated_count,
                "touched_decisions": touched_decisions,
                "only_high_confidence": bool(args.only_high_confidence),
                "only_empty_decision": bool(args.only_empty_decision),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
