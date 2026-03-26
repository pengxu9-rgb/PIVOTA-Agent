#!/usr/bin/env python3
"""Build a decision-ready packet from SKU ingredient/signal review rows."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build SKU ingredient/signal decision packets. Install it in the local Python environment first."
    ) from exc


PACKET_FIELDS = [
    "review_priority_score",
    "brand_name",
    "product_name",
    "official_product_url",
    "market",
    "category",
    "sku_row_key",
    "recommended_review_action",
    "recommended_review_reason",
    "token_count",
    "ingredient_match_count",
    "signal_match_count",
    "parser_cleanup_count",
    "curated_signal_tail_count",
    "parser_fragment_exclusion_count",
    "ingredient_granularities",
    "canonical_ingredients",
    "signal_display_names",
    "signal_keys",
    "parser_cleanup_fragments",
    "parser_excluded_fragments",
    "suggested_decision",
    "suggested_follow_up",
    "suggestion_confidence",
    "decision_rationale",
    "decision",
    "approved_follow_up",
    "reviewer_notes",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [{key: normalize_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def recommendation_for_action(action: str) -> tuple[str, str, str, str]:
    if action == "review_parser_fragment_series":
        return (
            "confirm_parser_fragment_exclusion",
            "keep_current_coverage_and_do_not_promote_fragments_as_ingredients",
            "high",
            "These rows are already covered, and the remaining fragments look like split key-ingredient punctuation artifacts rather than real standalone ingredient or signal units.",
        )
    if action == "review_signal_led_sku":
        return (
            "confirm_signal_only_sku",
            "keep_as_signal_led_preview_and_require_reviewed_evidence_before_runtime_evidence_ingest",
            "medium",
            "Coverage for this SKU comes from reviewed signal terms only, so it should stay signal-led unless stronger ingredient evidence is curated later.",
        )
    if action == "review_hybrid_ingredient_signal_sku":
        return (
            "confirm_hybrid_sku",
            "keep_hybrid_review_path_for_combined_ingredient_and_signal_coverage",
            "medium",
            "SKU combines canonical ingredient hits and signal hits, so it is best reviewed as a hybrid row before any downstream evidence promotion.",
        )
    return (
        "confirm_reference_only_sku",
        "eligible_for_reference_led_review",
        "high",
        "SKU is covered by deterministic reference ingredients only and is suitable for straightforward reference-led review.",
    )


def build_packet_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    packet_rows: list[dict[str, str]] = []
    for row in rows:
        action = normalize_text(row.get("recommended_review_action"))
        suggested_decision, suggested_follow_up, suggestion_confidence, rationale = recommendation_for_action(action)
        packet_rows.append(
            {
                "review_priority_score": normalize_text(row.get("review_priority_score")),
                "brand_name": normalize_text(row.get("brand_name")),
                "product_name": normalize_text(row.get("product_name")),
                "official_product_url": normalize_text(row.get("official_product_url")),
                "market": normalize_text(row.get("market")),
                "category": normalize_text(row.get("category")),
                "sku_row_key": normalize_text(row.get("sku_row_key")),
                "recommended_review_action": action,
                "recommended_review_reason": normalize_text(row.get("recommended_review_reason")),
                "token_count": normalize_text(row.get("token_count")),
                "ingredient_match_count": normalize_text(row.get("ingredient_match_count")),
                "signal_match_count": normalize_text(row.get("signal_match_count")),
                "parser_cleanup_count": normalize_text(row.get("parser_cleanup_count")),
                "curated_signal_tail_count": normalize_text(row.get("curated_signal_tail_count")),
                "parser_fragment_exclusion_count": normalize_text(row.get("parser_fragment_exclusion_count")),
                "ingredient_granularities": normalize_text(row.get("ingredient_granularities")),
                "canonical_ingredients": normalize_text(row.get("canonical_ingredients")),
                "signal_display_names": normalize_text(row.get("signal_display_names")),
                "signal_keys": normalize_text(row.get("signal_keys")),
                "parser_cleanup_fragments": normalize_text(row.get("parser_cleanup_fragments")),
                "parser_excluded_fragments": normalize_text(row.get("parser_excluded_fragments")),
                "suggested_decision": suggested_decision,
                "suggested_follow_up": suggested_follow_up,
                "suggestion_confidence": suggestion_confidence,
                "decision_rationale": rationale,
                "decision": "",
                "approved_follow_up": "",
                "reviewer_notes": "",
            }
        )
    return packet_rows


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_xlsx(path: Path, sheet_name: str, rows: list[dict[str, str]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.append(PACKET_FIELDS)
    for row in rows:
        sheet.append([row.get(field, "") for field in PACKET_FIELDS])
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a decision-ready packet from SKU ingredient/signal review rows.")
    parser.add_argument("--review-packet-csv", required=True, help="SKU review packet CSV")
    parser.add_argument("--action", action="append", required=True, help="recommended_review_action to keep; repeatable")
    parser.add_argument("--out-csv", required=True, help="Where to write packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write packet summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX output")
    parser.add_argument("--sheet-name", default="SKU_Decisions", help="Optional XLSX sheet name")
    args = parser.parse_args()

    in_path = Path(args.review_packet_csv).expanduser().resolve()
    rows = read_rows(in_path)
    allowed_actions = {normalize_text(value) for value in args.action if normalize_text(value)}
    filtered_rows = [row for row in rows if normalize_text(row.get("recommended_review_action")) in allowed_actions]
    packet_rows = build_packet_rows(filtered_rows)

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()
    write_csv(out_csv, PACKET_FIELDS, packet_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "SKU_Decisions", packet_rows)

    summary = {
        "review_packet_csv": str(in_path),
        "row_count": len(packet_rows),
        "action_counts": dict(Counter(row["recommended_review_action"] for row in packet_rows)),
        "suggested_decision_counts": dict(Counter(row["suggested_decision"] for row in packet_rows)),
        "suggestion_confidence_counts": dict(Counter(row["suggestion_confidence"] for row in packet_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
