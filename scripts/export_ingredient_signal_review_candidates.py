#!/usr/bin/env python3
"""Export approved signal-review rows into a reviewable signal candidate layer."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


APPROVE_SUGGESTION = "approve_suggestion"
APPROVE_OVERRIDE = "approve_override"
REJECT_NO_SIGNAL = "reject_no_signal"
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
    parser = argparse.ArgumentParser(description="Export approved signal-review rows into a reviewable signal candidate layer.")
    parser.add_argument("--decision-csv", required=True, help="Reviewed signal-review packet CSV")
    parser.add_argument("--out-approved-csv", required=True, help="Where to write approved signal candidate rows")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not exported into approved candidates")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    args = parser.parse_args()

    decision_path = Path(args.decision_csv).expanduser().resolve()
    rows = load_rows(decision_path)

    approved_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        decision = normalize_text(row.get("decision")).lower()
        signal_bucket = ""
        signal_key = ""

        if decision == APPROVE_SUGGESTION:
            signal_bucket = normalize_text(row.get("suggested_signal_bucket"))
            signal_key = normalize_text(row.get("suggested_signal_key"))
        elif decision == APPROVE_OVERRIDE:
            signal_bucket = normalize_text(row.get("approved_signal_bucket"))
            signal_key = normalize_text(row.get("approved_signal_key"))

        if signal_bucket and signal_key:
            approved_rows.append(
                {
                    "raw_token": normalize_text(row.get("raw_token")),
                    "normalized_token": normalize_text(row.get("normalized_token")),
                    "signal_bucket": signal_bucket,
                    "signal_key": signal_key,
                    "source_decision": decision,
                    "suggestion_confidence": normalize_text(row.get("suggestion_confidence")),
                    "priority_score": normalize_text(row.get("priority_score")),
                    "unmatched_count": normalize_text(row.get("unmatched_count")),
                    "sku_row_count": normalize_text(row.get("sku_row_count")),
                    "full_inci_count": normalize_text(row.get("full_inci_count")),
                    "key_count": normalize_text(row.get("key_count")),
                    "top_categories": normalize_text(row.get("top_categories")),
                    "example_brands": normalize_text(row.get("example_brands")),
                    "example_products": normalize_text(row.get("example_products")),
                    "example_urls": normalize_text(row.get("example_urls")),
                    "resolution_rationale": normalize_text(row.get("reviewer_notes")) or normalize_text(row.get("resolution_rationale")),
                    "source_packet": "ingredient_signal_review_packet",
                }
            )
            continue

        remainder_rows.append(
            {
                "raw_token": normalize_text(row.get("raw_token")),
                "normalized_token": normalize_text(row.get("normalized_token")),
                "suggested_signal_bucket": normalize_text(row.get("suggested_signal_bucket")),
                "suggested_signal_key": normalize_text(row.get("suggested_signal_key")),
                "suggestion_confidence": normalize_text(row.get("suggestion_confidence")),
                "decision": decision,
                "approved_signal_bucket": normalize_text(row.get("approved_signal_bucket")),
                "approved_signal_key": normalize_text(row.get("approved_signal_key")),
                "resolution_rationale": normalize_text(row.get("resolution_rationale")),
                "reviewer_notes": normalize_text(row.get("reviewer_notes")),
            }
        )

    approved_fieldnames = [
        "raw_token",
        "normalized_token",
        "signal_bucket",
        "signal_key",
        "source_decision",
        "suggestion_confidence",
        "priority_score",
        "unmatched_count",
        "sku_row_count",
        "full_inci_count",
        "key_count",
        "top_categories",
        "example_brands",
        "example_products",
        "example_urls",
        "resolution_rationale",
        "source_packet",
    ]
    remainder_fieldnames = [
        "raw_token",
        "normalized_token",
        "suggested_signal_bucket",
        "suggested_signal_key",
        "suggestion_confidence",
        "decision",
        "approved_signal_bucket",
        "approved_signal_key",
        "resolution_rationale",
        "reviewer_notes",
    ]

    out_approved_csv = Path(args.out_approved_csv).expanduser().resolve()
    write_csv(out_approved_csv, approved_rows, approved_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    summary = {
        "decision_csv": str(decision_path),
        "approved_count": len(approved_rows),
        "remainder_count": len(remainder_rows),
        "out_approved_csv": str(out_approved_csv),
        "out_remainder_csv": str(remainder_path) if remainder_path else None,
        "decision_values": [
            APPROVE_SUGGESTION,
            APPROVE_OVERRIDE,
            REJECT_NO_SIGNAL,
            NEEDS_RESEARCH,
        ],
    }

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
