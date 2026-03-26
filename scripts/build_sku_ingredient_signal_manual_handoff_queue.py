#!/usr/bin/env python3
"""Build a combined manual handoff queue from multiple SKU decision packets."""

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
        "openpyxl is required to build SKU manual handoff queues. Install it in the local Python environment first."
    ) from exc


ROW_FIELDS = [
    "source_packet",
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
    "canonical_ingredients",
    "signal_display_names",
    "signal_keys",
    "suggested_decision",
    "suggested_follow_up",
    "suggestion_confidence",
    "decision_rationale",
    "decision",
    "approved_follow_up",
    "reviewer_notes",
]

SUMMARY_FIELDS = [
    "source_packet",
    "row_count",
    "high_confidence_count",
    "medium_confidence_count",
    "low_confidence_count",
    "blank_decision_count",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [{key: normalize_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def append_sheet(workbook: Workbook, title: str, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    sheet = workbook.create_sheet(title)
    sheet.append(fieldnames)
    for row in rows:
        sheet.append([row.get(field, "") for field in fieldnames])


def safe_sheet_name(value: str) -> str:
    value = value.replace("/", "_").replace("\\", "_").replace(":", "_")
    return value[:31] or "Sheet"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a combined manual handoff queue from multiple SKU decision packets.")
    parser.add_argument("--decision-csv", action="append", required=True, help="Input SKU decision packet CSV; may be passed multiple times")
    parser.add_argument("--out-csv", required=True, help="Where to write combined manual queue CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX workbook output")
    args = parser.parse_args()

    combined_rows: list[dict[str, str]] = []
    summary_rows: list[dict[str, str]] = []

    for decision_csv in args.decision_csv:
        path = Path(decision_csv).expanduser().resolve()
        source_packet = path.stem
        rows = read_rows(path)
        confidence_counter = Counter(normalize_text(row.get("suggestion_confidence")) for row in rows)
        blank_decision_count = sum(1 for row in rows if not normalize_text(row.get("decision")))
        summary_rows.append(
            {
                "source_packet": source_packet,
                "row_count": str(len(rows)),
                "high_confidence_count": str(confidence_counter.get("high", 0)),
                "medium_confidence_count": str(confidence_counter.get("medium", 0)),
                "low_confidence_count": str(confidence_counter.get("low", 0)),
                "blank_decision_count": str(blank_decision_count),
            }
        )
        for row in rows:
            combined_rows.append(
                {
                    "source_packet": source_packet,
                    **{field: normalize_text(row.get(field)) for field in ROW_FIELDS if field != "source_packet"},
                }
            )

    combined_rows.sort(
        key=lambda row: (
            -int(normalize_text(row.get("review_priority_score")) or "0"),
            normalize_text(row.get("source_packet")).casefold(),
            normalize_text(row.get("brand_name")).casefold(),
            normalize_text(row.get("product_name")).casefold(),
        )
    )
    summary_rows.sort(key=lambda row: row["source_packet"].casefold())

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    write_csv(out_csv, ROW_FIELDS, combined_rows)

    payload = {
        "decision_csvs": [str(Path(value).expanduser().resolve()) for value in args.decision_csv],
        "row_count": len(combined_rows),
        "source_packet_counts": {row["source_packet"]: int(row["row_count"]) for row in summary_rows},
        "out_csv": str(out_csv),
    }

    if args.out_xlsx:
        workbook = Workbook()
        default_sheet = workbook.active
        workbook.remove(default_sheet)
        append_sheet(workbook, "Summary", SUMMARY_FIELDS, summary_rows)
        append_sheet(workbook, "Manual_Queue", ROW_FIELDS, combined_rows)
        for source_packet in sorted({row["source_packet"] for row in combined_rows}):
            packet_rows = [row for row in combined_rows if row["source_packet"] == source_packet]
            append_sheet(workbook, safe_sheet_name(source_packet), ROW_FIELDS, packet_rows)
        out_xlsx = Path(args.out_xlsx).expanduser().resolve()
        out_xlsx.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(out_xlsx)
        payload["out_xlsx"] = str(out_xlsx)

    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
