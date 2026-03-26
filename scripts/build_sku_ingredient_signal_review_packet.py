#!/usr/bin/env python3
"""Build a decision-ready SKU review packet from SKU ingredient/signal audit candidates."""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import psycopg2

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build SKU ingredient/signal review packets. Install it in the local Python environment first."
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
    "top_recommended_action",
]

SIGNAL_ROW_FIELDS = [
    "brand_name",
    "product_name",
    "official_product_url",
    "category",
    "ingredient_granularity",
    "raw_token",
    "signal_bucket",
    "signal_key",
    "display_signal_name",
    "audit_resolution_type",
]

PARSER_EXCLUDED_FIELDS = [
    "brand_name",
    "product_name",
    "official_product_url",
    "category",
    "ingredient_granularity",
    "raw_ingredient_text",
    "raw_token",
    "audit_resolution_type",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def rows_to_dicts(cursor) -> list[dict[str, str]]:
    columns = [desc[0] for desc in cursor.description]
    return [
        {columns[index]: normalize_text(row[index]) for index in range(len(columns))}
        for row in cursor.fetchall()
    ]


def read_candidate_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [{key: normalize_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def read_candidate_rows_from_db(table: str) -> list[dict[str, str]]:
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        raise SystemExit("DATABASE_URL not configured")
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                  candidate_match_key,
                  sku_row_key,
                  brand_name,
                  product_name,
                  official_product_url,
                  market,
                  category,
                  ingredient_granularity,
                  raw_ingredient_text,
                  raw_token,
                  canonical_inci_name,
                  signal_key,
                  display_signal_name,
                  audit_resolution_status,
                  audit_resolution_type
                FROM {table}
                ORDER BY brand_name ASC, product_name ASC, candidate_match_key ASC
                """
            )
            return rows_to_dicts(cur)
    finally:
        conn.close()


def semicolon_join(values: set[str]) -> str:
    return "; ".join(sorted(value for value in values if value))


def recommend_action(counters: Counter[str]) -> tuple[str, str, int]:
    parser_excluded = counters.get("parser_fragment_excluded", 0)
    signal_count = counters.get("signal_dictionary_match", 0) + counters.get("curated_signal_tail_overlay", 0)
    ingredient_count = counters.get("ingredient_reference_match", 0) + counters.get("parser_cleanup_ingredient_match", 0)

    if parser_excluded:
        return (
            "review_parser_fragment_series",
            "SKU is fully covered, but parser-fragment exclusions were applied and should be eyeballed once before downstream recording.",
            90,
        )
    if signal_count and ingredient_count:
        return (
            "review_hybrid_ingredient_signal_sku",
            "SKU carries both canonical ingredient hits and reviewed signal hits; use this row for hybrid audit or downstream packaging.",
            70,
        )
    if signal_count:
        return (
            "review_signal_led_sku",
            "SKU is covered through signal-only terms; verify this is intended before treating it as ingredient evidence.",
            60,
        )
    return (
        "ready_reference_only_sku",
        "SKU is covered by deterministic ingredient reference matches only.",
        40,
    )


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def append_sheet(workbook: Workbook, sheet_name: str, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    sheet = workbook.create_sheet(sheet_name)
    sheet.append(fieldnames)
    for row in rows:
        sheet.append([row.get(field, "") for field in fieldnames])


def build_packet(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    sku_groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        sku_key = normalize_text(row.get("sku_row_key")) or normalize_text(row.get("candidate_match_key"))
        sku_groups[sku_key].append(row)

    sku_packet_rows: list[dict[str, str]] = []
    brand_counters: dict[str, Counter[str]] = defaultdict(Counter)
    brand_meta: dict[str, dict[str, str]] = {}
    action_counts: Counter[str] = Counter()
    signal_rows: list[dict[str, str]] = []
    parser_excluded_rows: list[dict[str, str]] = []

    for sku_key, group in sku_groups.items():
        first = group[0]
        resolution_counter = Counter(normalize_text(row.get("audit_resolution_type")) for row in group)
        covered_count = sum(1 for row in group if normalize_text(row.get("audit_resolution_status")) == "covered")
        token_count = len(group)
        coverage_pct = round((covered_count / token_count) * 100, 2) if token_count else 0.0
        action, reason, priority = recommend_action(resolution_counter)

        ingredient_granularities = {normalize_text(row.get("ingredient_granularity")) for row in group}
        canonical_ingredients = {normalize_text(row.get("canonical_inci_name")) for row in group if normalize_text(row.get("canonical_inci_name"))}
        signal_display_names = {normalize_text(row.get("display_signal_name")) for row in group if normalize_text(row.get("display_signal_name"))}
        signal_keys = {normalize_text(row.get("signal_key")) for row in group if normalize_text(row.get("signal_key"))}
        parser_cleanup_fragments = {
            normalize_text(row.get("raw_token"))
            for row in group
            if normalize_text(row.get("audit_resolution_type")) == "parser_cleanup_ingredient_match"
        }
        parser_excluded_fragments = {
            normalize_text(row.get("raw_token"))
            for row in group
            if normalize_text(row.get("audit_resolution_type")) == "parser_fragment_excluded"
        }

        sku_packet_rows.append(
            {
                "review_priority_score": str(priority),
                "recommended_review_action": action,
                "recommended_review_reason": reason,
                "brand_name": normalize_text(first.get("brand_name")),
                "product_name": normalize_text(first.get("product_name")),
                "official_product_url": normalize_text(first.get("official_product_url")),
                "market": normalize_text(first.get("market")),
                "category": normalize_text(first.get("category")),
                "sku_row_key": sku_key,
                "token_count": str(token_count),
                "covered_count": str(covered_count),
                "coverage_pct": f"{coverage_pct:.2f}",
                "ingredient_match_count": str(
                    resolution_counter.get("ingredient_reference_match", 0) + resolution_counter.get("parser_cleanup_ingredient_match", 0)
                ),
                "signal_match_count": str(
                    resolution_counter.get("signal_dictionary_match", 0) + resolution_counter.get("curated_signal_tail_overlay", 0)
                ),
                "parser_cleanup_count": str(resolution_counter.get("parser_cleanup_ingredient_match", 0)),
                "curated_signal_tail_count": str(resolution_counter.get("curated_signal_tail_overlay", 0)),
                "parser_fragment_exclusion_count": str(resolution_counter.get("parser_fragment_excluded", 0)),
                "ingredient_granularities": semicolon_join(ingredient_granularities),
                "canonical_ingredients": semicolon_join(canonical_ingredients),
                "signal_display_names": semicolon_join(signal_display_names),
                "signal_keys": semicolon_join(signal_keys),
                "parser_cleanup_fragments": semicolon_join(parser_cleanup_fragments),
                "parser_excluded_fragments": semicolon_join(parser_excluded_fragments),
                "review_decision": "",
                "reviewer_notes": "",
            }
        )

        brand_name = normalize_text(first.get("brand_name")) or "(unknown)"
        brand_meta.setdefault(brand_name, {"brand_name": brand_name})
        brand_counter = brand_counters[brand_name]
        brand_counter["sku_count"] += 1
        brand_counter["token_count"] += token_count
        brand_counter["covered_count"] += covered_count
        brand_counter["ingredient_match_count"] += resolution_counter.get("ingredient_reference_match", 0) + resolution_counter.get("parser_cleanup_ingredient_match", 0)
        brand_counter["signal_match_count"] += resolution_counter.get("signal_dictionary_match", 0) + resolution_counter.get("curated_signal_tail_overlay", 0)
        brand_counter["parser_cleanup_count"] += resolution_counter.get("parser_cleanup_ingredient_match", 0)
        brand_counter["curated_signal_tail_count"] += resolution_counter.get("curated_signal_tail_overlay", 0)
        brand_counter["parser_fragment_exclusion_count"] += resolution_counter.get("parser_fragment_excluded", 0)
        brand_counter[f"action::{action}"] += 1
        action_counts[action] += 1

        for row in group:
            resolution_type = normalize_text(row.get("audit_resolution_type"))
            if resolution_type in {"signal_dictionary_match", "curated_signal_tail_overlay"}:
                signal_rows.append(
                    {
                        "brand_name": normalize_text(row.get("brand_name")),
                        "product_name": normalize_text(row.get("product_name")),
                        "official_product_url": normalize_text(row.get("official_product_url")),
                        "category": normalize_text(row.get("category")),
                        "ingredient_granularity": normalize_text(row.get("ingredient_granularity")),
                        "raw_token": normalize_text(row.get("raw_token")),
                        "signal_bucket": "",
                        "signal_key": normalize_text(row.get("signal_key")),
                        "display_signal_name": normalize_text(row.get("display_signal_name")),
                        "audit_resolution_type": resolution_type,
                    }
                )
            if resolution_type == "parser_fragment_excluded":
                parser_excluded_rows.append(
                    {
                        "brand_name": normalize_text(row.get("brand_name")),
                        "product_name": normalize_text(row.get("product_name")),
                        "official_product_url": normalize_text(row.get("official_product_url")),
                        "category": normalize_text(row.get("category")),
                        "ingredient_granularity": normalize_text(row.get("ingredient_granularity")),
                        "raw_ingredient_text": normalize_text(row.get("raw_ingredient_text")),
                        "raw_token": normalize_text(row.get("raw_token")),
                        "audit_resolution_type": resolution_type,
                    }
                )

    sku_packet_rows.sort(
        key=lambda row: (
            -int(normalize_text(row.get("review_priority_score")) or "0"),
            normalize_text(row.get("brand_name")).casefold(),
            normalize_text(row.get("product_name")).casefold(),
        )
    )

    brand_rows: list[dict[str, str]] = []
    for brand_name, counter in brand_counters.items():
        token_count = counter["token_count"]
        covered_count = counter["covered_count"]
        top_action = ""
        top_action_count = -1
        for key, value in counter.items():
            if key.startswith("action::") and value > top_action_count:
                top_action = key.split("::", 1)[1]
                top_action_count = value
        brand_rows.append(
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
                "top_recommended_action": top_action,
            }
        )
    brand_rows.sort(key=lambda row: (row["brand_name"].casefold(),))

    summary = {
        "sku_count": len(sku_packet_rows),
        "brand_count": len(brand_rows),
        "token_row_count": len(rows),
        "action_counts": dict(action_counts),
        "signal_row_count": len(signal_rows),
        "parser_excluded_row_count": len(parser_excluded_rows),
        "reference_only_sku_count": sum(1 for row in sku_packet_rows if row["recommended_review_action"] == "ready_reference_only_sku"),
        "hybrid_sku_count": sum(1 for row in sku_packet_rows if row["recommended_review_action"] == "review_hybrid_ingredient_signal_sku"),
        "signal_led_sku_count": sum(1 for row in sku_packet_rows if row["recommended_review_action"] == "review_signal_led_sku"),
        "parser_fragment_review_sku_count": sum(1 for row in sku_packet_rows if row["recommended_review_action"] == "review_parser_fragment_series"),
    }
    return sku_packet_rows, brand_rows, signal_rows, parser_excluded_rows, summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a decision-ready SKU review packet from SKU ingredient/signal audit candidates.")
    parser.add_argument("--candidate-csv", help="Optional candidate CSV instead of reading from a DB table")
    parser.add_argument("--table", default="seed_preview.sku_ingredient_signal_audit_candidates", help="Preview table to inspect when candidate CSV is not provided")
    parser.add_argument("--out-csv", required=True, help="Where to write the SKU review packet CSV")
    parser.add_argument("--out-brand-csv", required=True, help="Where to write the brand summary CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write the packet summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX output with multiple review sheets")
    args = parser.parse_args()

    if args.candidate_csv:
        source_rows = read_candidate_csv(Path(args.candidate_csv).expanduser().resolve())
        source_descriptor = str(Path(args.candidate_csv).expanduser().resolve())
    else:
        source_rows = read_candidate_rows_from_db(args.table)
        source_descriptor = args.table

    sku_rows, brand_rows, signal_rows, parser_excluded_rows, summary = build_packet(source_rows)

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_brand_csv = Path(args.out_brand_csv).expanduser().resolve()
    out_summary_json = Path(args.out_summary_json).expanduser().resolve()

    write_csv(out_csv, SKU_FIELDS, sku_rows)
    write_csv(out_brand_csv, BRAND_FIELDS, brand_rows)

    payload = {
        "source": source_descriptor,
        **summary,
        "out_csv": str(out_csv),
        "out_brand_csv": str(out_brand_csv),
    }
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    if args.out_xlsx:
        workbook = Workbook()
        default_sheet = workbook.active
        workbook.remove(default_sheet)
        append_sheet(workbook, "SKU_Review", SKU_FIELDS, sku_rows)
        append_sheet(workbook, "Brand_Summary", BRAND_FIELDS, brand_rows)
        append_sheet(workbook, "Signal_Rows", SIGNAL_ROW_FIELDS, signal_rows)
        append_sheet(workbook, "Parser_Excluded", PARSER_EXCLUDED_FIELDS, parser_excluded_rows)
        out_xlsx = Path(args.out_xlsx).expanduser().resolve()
        out_xlsx.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(out_xlsx)
        payload["out_xlsx"] = str(out_xlsx)
        out_summary_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(payload, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
