#!/usr/bin/env python3
"""Export apply-ready review_status patch rows from a review queue JSON."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


ALLOWED_STATUS_ONLY_REASONS = {
    "review_status_still_draft",
    "confidence_medium",
    "confidence_low",
}


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_queue(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export apply-ready review_status patch rows from a review queue JSON.")
    parser.add_argument("--queue-json", required=True, help="Review queue JSON")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready review_status patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not promoted into the patch")
    parser.add_argument("--target-status", default="reviewed", help="Target review_status value (default: reviewed)")
    args = parser.parse_args()

    queue_path = Path(args.queue_json).expanduser().resolve()
    payload = load_queue(queue_path)
    rows = payload.get("all_review_rows", [])

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []
    target_status = normalize_text(args.target_status)

    for row in rows:
        review_status = normalize_text(row.get("review_status")).lower()
        reasons = {normalize_text(reason) for reason in row.get("reasons", []) if normalize_text(reason)}

        if review_status == "draft" and reasons and reasons.issubset(ALLOWED_STATUS_ONLY_REASONS):
            apply_rows.append(
                {
                    "record_id": normalize_text(row.get("record_id")),
                    "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                    "existing_review_status": normalize_text(row.get("review_status")),
                    "patch_review_status": target_status,
                    "proposal_sources": "review_status_promotion",
                    "quality_reason": "no remaining queue reasons beyond review_status/confidence",
                }
            )
            continue

        remainder_rows.append(
            {
                "record_id": normalize_text(row.get("record_id")),
                "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                "review_status": normalize_text(row.get("review_status")),
                "confidence": normalize_text(row.get("confidence")),
                "reasons": "; ".join(row.get("reasons", [])),
            }
        )

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_review_status",
        "patch_review_status",
        "proposal_sources",
        "quality_reason",
    ]
    remainder_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "review_status",
        "confidence",
        "reasons",
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
                "queue_json": str(queue_path),
                "target_status": target_status,
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
