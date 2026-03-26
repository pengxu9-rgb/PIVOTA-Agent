#!/usr/bin/env python3
"""Split SKU ingredient/signal review packet rows into action-specific packets."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build SKU ingredient/signal action packet workbooks. Install it in the local Python environment first."
    ) from exc


SKU_FIELDS = [
    "review_priority_score",
    "recommended_review_action",
    "recommended_review_reason",
    "brand_name",
    "product_name",
    "official_product_url",
    "market",
    "category",
    "sku_row_key",
    "token_count",
    "covered_count",
    "coverage_pct",
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
    "review_decision",
    "reviewer_notes",
]

BRAND_FIELDS = [
    "brand_name",
    "sku_count",
    "token_count",
    "covered_count",
    "coverage_pct",
    "ingredient_match_count",
    "signal_match_count",
    "parser_cleanup_count",
    "curated_signal_tail_count",
    "parser_fragment_exclusion_count",
]

ACTION_SHEET_NAMES = {
    "review_parser_fragment_series": "Parser_Fragment",
    "review_signal_led_sku": "Signal_Led",
    "review_hybrid_ingredient_signal_sku": "Hybrid",
    "ready_reference_only_sku": "Reference_Only",
}


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def read_csv_rows(path: Path) -> list[dict[str, str]]:
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


def build_brand_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    counters: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        brand_name = normalize_text(row.get("brand_name")) or "(unknown)"
        counter = counters[brand_name]
        counter["sku_count"] += 1
        counter["token_count"] += int(normalize_text(row.get("token_count")) or "0")
        counter["covered_count"] += int(normalize_text(row.get("covered_count")) or "0")
        counter["ingredient_match_count"] += int(normalize_text(row.get("ingredient_match_count")) or "0")
        counter["signal_match_count"] += int(normalize_text(row.get("signal_match_count")) or "0")
        counter["parser_cleanup_count"] += int(normalize_text(row.get("parser_cleanup_count")) or "0")
        counter["curated_signal_tail_count"] += int(normalize_text(row.get("curated_signal_tail_count")) or "0")
        counter["parser_fragment_exclusion_count"] += int(normalize_text(row.get("parser_fragment_exclusion_count")) or "0")

    out: list[dict[str, str]] = []
    for brand_name, counter in counters.items():
        token_count = counter["token_count"]
        covered_count = counter["covered_count"]
        out.append(
            {
                "brand_name": brand_name,
                "sku_count": str(counter["sku_count"]),
                "token_count": str(token_count),
                "covered_count": str(covered_count),
                "coverage_pct": f"{round((covered_count / token_count) * 100, 2) if token_count else 0.0:.2f}",
                "ingredient_match_count": str(counter["ingredient_match_count"]),
                "signal_match_count": str(counter["signal_match_count"]),
                "parser_cleanup_count": str(counter["parser_cleanup_count"]),
                "curated_signal_tail_count": str(counter["curated_signal_tail_count"]),
                "parser_fragment_exclusion_count": str(counter["parser_fragment_exclusion_count"]),
            }
        )
    out.sort(key=lambda row: row["brand_name"].casefold())
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Split SKU ingredient/signal review packet rows into action-specific packets.")
    parser.add_argument("--review-packet-csv", required=True, help="SKU review packet CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX workbook with one sheet per action")
    parser.add_argument("--out-dir", required=True, help="Directory for per-action CSV outputs")
    args = parser.parse_args()

    rows = read_csv_rows(Path(args.review_packet_csv).expanduser().resolve())
    grouped: dict[str, list[dict[str, str]]] = {action: [] for action in ACTION_SHEET_NAMES}
    for row in rows:
        action = normalize_text(row.get("recommended_review_action"))
        grouped.setdefault(action, []).append(row)

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "source_review_packet_csv": str(Path(args.review_packet_csv).expanduser().resolve()),
        "total_sku_count": len(rows),
        "action_counts": {},
        "packet_outputs": {},
    }

    workbook = Workbook() if args.out_xlsx else None
    if workbook is not None:
        default_sheet = workbook.active
        workbook.remove(default_sheet)

    for action, sheet_name in ACTION_SHEET_NAMES.items():
        action_rows = grouped.get(action, [])
        brand_rows = build_brand_rows(action_rows)
        packet_csv = out_dir / f"{action}.csv"
        brand_csv = out_dir / f"{action}_brands.csv"
        write_csv(packet_csv, SKU_FIELDS, action_rows)
        write_csv(brand_csv, BRAND_FIELDS, brand_rows)
        summary["action_counts"][action] = len(action_rows)
        summary["packet_outputs"][action] = {
            "sku_csv": str(packet_csv),
            "brand_csv": str(brand_csv),
        }
        if workbook is not None:
            append_sheet(workbook, sheet_name, SKU_FIELDS, action_rows)
            append_sheet(workbook, f"{sheet_name}_Brands", BRAND_FIELDS, brand_rows)

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    if workbook is not None:
        out_xlsx = Path(args.out_xlsx).expanduser().resolve()
        out_xlsx.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(out_xlsx)
        summary["out_xlsx"] = str(out_xlsx)
    out_summary_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
