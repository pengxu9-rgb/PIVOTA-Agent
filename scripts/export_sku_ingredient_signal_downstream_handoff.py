#!/usr/bin/env python3
"""Export approved SKU ingredient/signal decision rows into a downstream handoff layer."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


APPROVE_SUGGESTION = "approve_suggestion"
APPROVE_OVERRIDE = "approve_override"
NEEDS_REVIEW = "needs_review"
NEEDS_RESEARCH = "needs_research"


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [{key: normalize_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export approved SKU ingredient/signal decision rows into a downstream handoff layer.")
    parser.add_argument("--decision-csv", action="append", required=True, help="Reviewed SKU decision packet CSV; may be passed multiple times")
    parser.add_argument("--out-approved-csv", required=True, help="Where to write approved downstream handoff rows")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not exported")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    args = parser.parse_args()

    approved_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []
    source_counts: Counter[str] = Counter()
    handoff_counts: Counter[str] = Counter()

    for decision_csv in args.decision_csv:
        decision_path = Path(decision_csv).expanduser().resolve()
        rows = load_rows(decision_path)
        source_label = decision_path.stem
        for row in rows:
            decision = normalize_text(row.get("decision")).lower()
            suggested_follow_up = normalize_text(row.get("suggested_follow_up"))
            approved_follow_up = normalize_text(row.get("approved_follow_up"))
            handoff_path = ""

            if decision == APPROVE_SUGGESTION:
                handoff_path = suggested_follow_up
            elif decision == APPROVE_OVERRIDE:
                handoff_path = approved_follow_up or suggested_follow_up

            if handoff_path:
                approved_rows.append(
                    {
                        "sku_row_key": normalize_text(row.get("sku_row_key")),
                        "brand_name": normalize_text(row.get("brand_name")),
                        "product_name": normalize_text(row.get("product_name")),
                        "official_product_url": normalize_text(row.get("official_product_url")),
                        "market": normalize_text(row.get("market")),
                        "category": normalize_text(row.get("category")),
                        "recommended_review_action": normalize_text(row.get("recommended_review_action")),
                        "source_decision": decision,
                        "downstream_handoff_path": handoff_path,
                        "canonical_ingredients": normalize_text(row.get("canonical_ingredients")),
                        "signal_display_names": normalize_text(row.get("signal_display_names")),
                        "signal_keys": normalize_text(row.get("signal_keys")),
                        "parser_excluded_fragments": normalize_text(row.get("parser_excluded_fragments")),
                        "decision_rationale": normalize_text(row.get("reviewer_notes")) or normalize_text(row.get("decision_rationale")),
                        "source_packet": source_label,
                    }
                )
                source_counts[source_label] += 1
                handoff_counts[handoff_path] += 1
                continue

            remainder_rows.append(
                {
                    "sku_row_key": normalize_text(row.get("sku_row_key")),
                    "brand_name": normalize_text(row.get("brand_name")),
                    "product_name": normalize_text(row.get("product_name")),
                    "recommended_review_action": normalize_text(row.get("recommended_review_action")),
                    "decision": decision,
                    "suggested_follow_up": suggested_follow_up,
                    "approved_follow_up": approved_follow_up,
                    "suggestion_confidence": normalize_text(row.get("suggestion_confidence")),
                    "reviewer_notes": normalize_text(row.get("reviewer_notes")),
                    "source_packet": source_label,
                }
            )

    approved_fieldnames = [
        "sku_row_key",
        "brand_name",
        "product_name",
        "official_product_url",
        "market",
        "category",
        "recommended_review_action",
        "source_decision",
        "downstream_handoff_path",
        "canonical_ingredients",
        "signal_display_names",
        "signal_keys",
        "parser_excluded_fragments",
        "decision_rationale",
        "source_packet",
    ]
    remainder_fieldnames = [
        "sku_row_key",
        "brand_name",
        "product_name",
        "recommended_review_action",
        "decision",
        "suggested_follow_up",
        "approved_follow_up",
        "suggestion_confidence",
        "reviewer_notes",
        "source_packet",
    ]

    out_approved_csv = Path(args.out_approved_csv).expanduser().resolve()
    write_csv(out_approved_csv, approved_rows, approved_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    summary = {
        "decision_csvs": [str(Path(value).expanduser().resolve()) for value in args.decision_csv],
        "approved_count": len(approved_rows),
        "remainder_count": len(remainder_rows),
        "approved_source_packet_counts": dict(source_counts),
        "approved_handoff_path_counts": dict(handoff_counts),
        "out_approved_csv": str(out_approved_csv),
        "out_remainder_csv": str(remainder_path) if remainder_path else None,
        "decision_values": [
            APPROVE_SUGGESTION,
            APPROVE_OVERRIDE,
            NEEDS_REVIEW,
            NEEDS_RESEARCH,
        ],
    }

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
