#!/usr/bin/env python3
"""Export workbook writeback patches from ingredient parser note proposals."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def classify_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    apply_rows: list[dict[str, Any]] = []
    manual_rows: list[dict[str, Any]] = []

    for row in rows:
        suggested_note = normalize_text(row.get("suggested_notes_for_parser"))
        proposal_confidence = normalize_text(row.get("proposal_confidence"))
        needs_manual_review = normalize_text(row.get("needs_manual_review")).lower() == "yes"

        if suggested_note and proposal_confidence == "high" and not needs_manual_review:
            apply_rows.append(
                {
                    "record_id": normalize_text(row.get("record_id")),
                    "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                    "existing_notes_for_parser": normalize_text(row.get("existing_notes_for_parser")),
                    "patch_notes_for_parser": suggested_note,
                    "proposal_template": normalize_text(row.get("proposal_template")),
                    "proposal_reasons": normalize_text(row.get("proposal_reasons")),
                }
            )
        else:
            manual_rows.append(
                {
                    "record_id": normalize_text(row.get("record_id")),
                    "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                    "existing_notes_for_parser": normalize_text(row.get("existing_notes_for_parser")),
                    "suggested_notes_for_parser": suggested_note,
                    "proposal_template": normalize_text(row.get("proposal_template")),
                    "proposal_confidence": proposal_confidence,
                    "proposal_reasons": normalize_text(row.get("proposal_reasons")),
                    "needs_manual_review": normalize_text(row.get("needs_manual_review")),
                }
            )

    return apply_rows, manual_rows


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export apply-ready parser note writeback patches from proposal JSON.")
    parser.add_argument("--proposal-json", required=True, help="Path to ingredient parser note proposal JSON")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready patch CSV")
    parser.add_argument("--out-manual-csv", help="Optional path for manual-review remainder CSV")
    args = parser.parse_args()

    payload = load_payload(Path(args.proposal_json).expanduser().resolve())
    proposal_rows = payload.get("proposals") or []
    apply_rows, manual_rows = classify_rows(proposal_rows)

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_notes_for_parser",
        "patch_notes_for_parser",
        "proposal_template",
        "proposal_reasons",
    ]
    manual_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_notes_for_parser",
        "suggested_notes_for_parser",
        "proposal_template",
        "proposal_confidence",
        "proposal_reasons",
        "needs_manual_review",
    ]

    apply_path = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(apply_path, apply_rows, apply_fieldnames)

    manual_path = None
    if args.out_manual_csv:
        manual_path = Path(args.out_manual_csv).expanduser().resolve()
        write_csv(manual_path, manual_rows, manual_fieldnames)

    print(
        json.dumps(
            {
                "proposal_json": str(Path(args.proposal_json).expanduser().resolve()),
                "apply_ready_count": len(apply_rows),
                "manual_review_count": len(manual_rows),
                "out_apply_csv": str(apply_path),
                "out_manual_csv": str(manual_path) if manual_path else None,
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
