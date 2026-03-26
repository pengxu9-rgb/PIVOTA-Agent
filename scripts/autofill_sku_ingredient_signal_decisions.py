#!/usr/bin/env python3
"""Autofill SKU ingredient/signal decision packet rows with suggested decisions."""

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
    parser = argparse.ArgumentParser(description="Autofill SKU ingredient/signal decision packet rows with suggested decisions.")
    parser.add_argument("--decision-csv", required=True, help="Input SKU decision packet CSV")
    parser.add_argument("--out-csv", required=True, help="Output CSV with autofilled decisions")
    parser.add_argument(
        "--approve-action",
        action="append",
        default=[],
        help="recommended_review_action value to auto-mark as approve_suggestion. May be passed multiple times.",
    )
    parser.add_argument(
        "--approve-confidence",
        action="append",
        default=[],
        help="suggestion_confidence value to auto-mark as approve_suggestion. May be passed multiple times.",
    )
    parser.add_argument(
        "--only-empty-decision",
        action="store_true",
        help="Only autofill rows whose decision cell is currently empty",
    )
    args = parser.parse_args()

    in_path = Path(args.decision_csv).expanduser().resolve()
    out_path = Path(args.out_csv).expanduser().resolve()
    approve_actions = {normalize_text(value) for value in args.approve_action if normalize_text(value)}
    approve_confidences = {normalize_text(value) for value in args.approve_confidence if normalize_text(value)}

    fieldnames, rows = load_rows(in_path)
    updated_count = 0
    touched_actions: dict[str, int] = {}

    for row in rows:
        action = normalize_text(row.get("recommended_review_action"))
        confidence = normalize_text(row.get("suggestion_confidence"))
        current_decision = normalize_text(row.get("decision"))
        should_approve = False
        if approve_actions and action in approve_actions:
            should_approve = True
        if approve_confidences and confidence in approve_confidences:
            should_approve = True
        if not should_approve:
            continue
        if args.only_empty_decision and current_decision:
            continue
        row["decision"] = "approve_suggestion"
        if "approved_follow_up" in row and not normalize_text(row.get("approved_follow_up")):
            row["approved_follow_up"] = normalize_text(row.get("suggested_follow_up"))
        updated_count += 1
        touched_actions[action] = touched_actions.get(action, 0) + 1

    write_rows(out_path, fieldnames, rows)

    print(
        json.dumps(
            {
                "source_decision_csv": str(in_path),
                "out_csv": str(out_path),
                "approve_actions": sorted(approve_actions),
                "approve_confidences": sorted(approve_confidences),
                "updated_count": updated_count,
                "touched_actions": touched_actions,
                "only_empty_decision": bool(args.only_empty_decision),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
