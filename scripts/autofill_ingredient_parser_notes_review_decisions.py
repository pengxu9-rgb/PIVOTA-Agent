#!/usr/bin/env python3
"""Autofill parser-note review decisions for selected proposal templates."""

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
    parser = argparse.ArgumentParser(description="Autofill parser-note review decisions for selected proposal templates.")
    parser.add_argument("--decision-csv", required=True, help="Input parser-note decision packet CSV")
    parser.add_argument("--out-csv", required=True, help="Output CSV with autofilled decisions")
    parser.add_argument(
        "--approve-template",
        action="append",
        default=[],
        help="Proposal template to auto-mark as approve_suggestion. May be passed multiple times.",
    )
    parser.add_argument(
        "--only-empty-decision",
        action="store_true",
        help="Only autofill rows whose decision cell is currently empty",
    )
    args = parser.parse_args()

    in_path = Path(args.decision_csv).expanduser().resolve()
    out_path = Path(args.out_csv).expanduser().resolve()
    approve_templates = {normalize_text(value) for value in args.approve_template if normalize_text(value)}

    fieldnames, rows = load_rows(in_path)
    updated_count = 0
    touched_templates: dict[str, int] = {}

    for row in rows:
        template = normalize_text(row.get("proposal_template"))
        current_decision = normalize_text(row.get("decision"))
        if template not in approve_templates:
            continue
        if args.only_empty_decision and current_decision:
            continue
        row["decision"] = "approve_suggestion"
        updated_count += 1
        touched_templates[template] = touched_templates.get(template, 0) + 1

    write_rows(out_path, fieldnames, rows)

    print(
        json.dumps(
            {
                "source_decision_csv": str(in_path),
                "out_csv": str(out_path),
                "approve_templates": sorted(approve_templates),
                "updated_count": updated_count,
                "touched_templates": touched_templates,
                "only_empty_decision": bool(args.only_empty_decision),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
