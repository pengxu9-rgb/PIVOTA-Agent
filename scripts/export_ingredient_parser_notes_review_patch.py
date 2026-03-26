#!/usr/bin/env python3
"""Export apply-ready parser-note patches from a reviewed parser-note decision packet."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


APPROVE_SUGGESTION = "approve_suggestion"
APPROVE_OVERRIDE = "approve_override"
REJECT_NO_NOTE = "reject_no_note"
NEEDS_RESEARCH = "needs_research"


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export apply-ready parser-note patches from a reviewed decision packet.")
    parser.add_argument("--decision-csv", required=True, help="Reviewed parser-note decision CSV")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready parser-note patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for non-applied remainder CSV")
    args = parser.parse_args()

    decision_path = Path(args.decision_csv).expanduser().resolve()
    rows = load_rows(decision_path)

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        decision = normalize_text(row.get("decision")).lower()
        payload = {
            "record_id": normalize_text(row.get("record_id")),
            "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
            "canonical_display_name": normalize_text(row.get("canonical_display_name")),
            "ingredient_family": normalize_text(row.get("ingredient_family")),
            "existing_notes_for_parser": normalize_text(row.get("existing_notes_for_parser")),
            "suggested_notes_for_parser": normalize_text(row.get("suggested_notes_for_parser")),
            "proposal_template": normalize_text(row.get("proposal_template")),
            "proposal_confidence": normalize_text(row.get("proposal_confidence")),
            "proposal_reasons": normalize_text(row.get("proposal_reasons")),
            "approved_notes_for_parser": normalize_text(row.get("approved_notes_for_parser")),
            "reviewer_notes": normalize_text(row.get("reviewer_notes")),
            "decision": decision,
        }

        patch_notes = ""
        if decision == APPROVE_SUGGESTION:
            patch_notes = payload["suggested_notes_for_parser"]
        elif decision == APPROVE_OVERRIDE:
            patch_notes = payload["approved_notes_for_parser"]

        if patch_notes:
            apply_rows.append(
                {
                    "record_id": payload["record_id"],
                    "canonical_inci_name": payload["canonical_inci_name"],
                    "existing_notes_for_parser": payload["existing_notes_for_parser"],
                    "patch_notes_for_parser": patch_notes,
                    "proposal_template": payload["proposal_template"],
                    "proposal_reasons": payload["reviewer_notes"] or payload["proposal_reasons"],
                }
            )
            continue

        if decision in {REJECT_NO_NOTE, NEEDS_RESEARCH, ""} or not decision:
            remainder_rows.append(payload)
            continue

        remainder_rows.append(payload)

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_notes_for_parser",
        "patch_notes_for_parser",
        "proposal_template",
        "proposal_reasons",
    ]
    remainder_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "canonical_display_name",
        "ingredient_family",
        "existing_notes_for_parser",
        "suggested_notes_for_parser",
        "proposal_template",
        "proposal_confidence",
        "proposal_reasons",
        "decision",
        "approved_notes_for_parser",
        "reviewer_notes",
    ]

    out_apply = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(out_apply, apply_rows, apply_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    print(
        json.dumps(
            {
                "decision_csv": str(decision_path),
                "apply_ready_count": len(apply_rows),
                "remainder_count": len(remainder_rows),
                "out_apply_csv": str(out_apply),
                "out_remainder_csv": str(remainder_path) if remainder_path else None,
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
