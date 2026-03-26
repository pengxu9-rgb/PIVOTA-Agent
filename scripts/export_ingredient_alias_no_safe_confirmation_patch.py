#!/usr/bin/env python3
"""Export review-notes patch rows from a no-safe-common-alias decision packet."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


CONFIRM = "confirm_no_safe_common_alias"
KEEP_OPEN = "keep_open"
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


def merge_review_note(existing: str, marker: str) -> str:
    existing = normalize_text(existing)
    marker = normalize_text(marker)
    if not marker:
        return existing
    if marker in existing:
        return existing
    if not existing:
        return marker
    return f"{existing} | {marker}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Export review-notes patch rows from a no-safe-common-alias decision packet.")
    parser.add_argument("--decision-csv", required=True, help="Reviewed no-safe-common-alias decision packet CSV")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready review-notes patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not promoted into the patch")
    args = parser.parse_args()

    decision_path = Path(args.decision_csv).expanduser().resolve()
    rows = load_rows(decision_path)

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        decision = normalize_text(row.get("decision")).lower()
        existing_review_notes = normalize_text(row.get("existing_review_notes"))
        approved_marker = normalize_text(row.get("approved_marker"))
        suggested_rationale = normalize_text(row.get("suggested_rationale"))
        reviewer_notes = normalize_text(row.get("reviewer_notes"))

        if decision == CONFIRM and approved_marker:
            apply_rows.append(
                {
                    "record_id": normalize_text(row.get("record_id")),
                    "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                    "existing_review_notes": existing_review_notes,
                    "patch_review_notes": merge_review_note(existing_review_notes, approved_marker),
                    "proposal_sources": "no_safe_common_alias_confirmation",
                    "quality_reason": reviewer_notes or suggested_rationale,
                }
            )
            continue

        if decision in {KEEP_OPEN, NEEDS_RESEARCH, ""} or not decision:
            remainder_rows.append(row)
            continue

        remainder_rows.append(row)

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_review_notes",
        "patch_review_notes",
        "proposal_sources",
        "quality_reason",
    ]
    remainder_fieldnames = list(rows[0].keys()) if rows else []

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
