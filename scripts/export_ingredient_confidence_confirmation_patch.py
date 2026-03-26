#!/usr/bin/env python3
"""Export confidence and review-notes patch rows from a confidence decision packet."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


CONFIRM = "confirm_current_confidence"
SET_HIGH = "set_high"
SET_LOW = "set_low"
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
    parser = argparse.ArgumentParser(description="Export confidence and review-notes patch rows from a confidence decision packet.")
    parser.add_argument("--decision-csv", required=True, help="Reviewed confidence decision packet CSV")
    parser.add_argument("--out-confidence-apply-csv", required=True, help="Where to write the apply-ready confidence patch CSV")
    parser.add_argument("--out-review-notes-apply-csv", required=True, help="Where to write the apply-ready review-notes patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not promoted into either patch")
    args = parser.parse_args()

    decision_path = Path(args.decision_csv).expanduser().resolve()
    rows = load_rows(decision_path)

    confidence_apply_rows: list[dict[str, str]] = []
    review_notes_apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        decision = normalize_text(row.get("decision")).lower()
        record_id = normalize_text(row.get("record_id"))
        canonical = normalize_text(row.get("canonical_inci_name"))
        existing_confidence = normalize_text(row.get("existing_confidence"))
        existing_review_notes = normalize_text(row.get("existing_review_notes"))
        approved_confidence = normalize_text(row.get("approved_confidence"))
        approved_marker = normalize_text(row.get("approved_marker"))
        rationale = normalize_text(row.get("reviewer_notes")) or normalize_text(row.get("suggested_rationale"))

        if decision == CONFIRM:
            review_notes_apply_rows.append(
                {
                    "record_id": record_id,
                    "canonical_inci_name": canonical,
                    "existing_review_notes": existing_review_notes,
                    "patch_review_notes": merge_review_note(existing_review_notes, approved_marker),
                    "proposal_sources": "confidence_confirmation",
                    "quality_reason": rationale,
                }
            )
            continue

        if decision == SET_HIGH or decision == SET_LOW:
            confidence_apply_rows.append(
                {
                    "record_id": record_id,
                    "canonical_inci_name": canonical,
                    "existing_confidence": existing_confidence,
                    "patch_confidence": approved_confidence or ("high" if decision == SET_HIGH else "low"),
                    "proposal_sources": "confidence_override",
                    "quality_reason": rationale,
                }
            )
            continue

        if decision in {NEEDS_RESEARCH, ""} or not decision:
            remainder_rows.append(row)
            continue

        remainder_rows.append(row)

    confidence_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_confidence",
        "patch_confidence",
        "proposal_sources",
        "quality_reason",
    ]
    review_notes_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_review_notes",
        "patch_review_notes",
        "proposal_sources",
        "quality_reason",
    ]
    remainder_fieldnames = list(rows[0].keys()) if rows else []

    out_confidence = Path(args.out_confidence_apply_csv).expanduser().resolve()
    write_csv(out_confidence, confidence_apply_rows, confidence_fieldnames)

    out_review_notes = Path(args.out_review_notes_apply_csv).expanduser().resolve()
    write_csv(out_review_notes, review_notes_apply_rows, review_notes_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    print(
        json.dumps(
            {
                "decision_csv": str(decision_path),
                "confidence_apply_ready_count": len(confidence_apply_rows),
                "review_notes_apply_ready_count": len(review_notes_apply_rows),
                "remainder_count": len(remainder_rows),
                "out_confidence_apply_csv": str(out_confidence),
                "out_review_notes_apply_csv": str(out_review_notes),
                "out_remainder_csv": str(remainder_path) if remainder_path else None,
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
