#!/usr/bin/env python3
"""Combine ingredient matches and signal audit rows into one reviewable candidate layer."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


INGREDIENT_REQUIRED_COLUMNS = [
    "candidate_match_key",
    "sku_row_key",
    "source_file",
    "source_sheet",
    "source_row_number",
    "brand_name",
    "product_name",
    "official_product_url",
    "market",
    "category",
    "ingredient_granularity",
    "extraction_status",
    "raw_ingredient_text",
    "raw_token",
    "token_index",
    "token_normalized",
    "match_status",
]

SIGNAL_REQUIRED_COLUMNS = [
    "candidate_match_key",
    "signal_match_status",
    "signal_match_score",
    "signal_match_method",
    "signal_bucket",
    "signal_key",
    "display_signal_name",
]

OUTPUT_FIELDS = [
    "candidate_match_key",
    "sku_row_key",
    "source_file",
    "source_sheet",
    "source_row_number",
    "brand_name",
    "product_name",
    "official_product_url",
    "market",
    "category",
    "ingredient_granularity",
    "extraction_status",
    "raw_ingredient_text",
    "raw_token",
    "token_index",
    "token_normalized",
    "ingredient_match_status",
    "ingredient_match_method",
    "ingredient_match_confidence",
    "ingredient_record_id",
    "canonical_inci_name",
    "canonical_display_name",
    "ingredient_normalized_key",
    "ingredient_family",
    "primary_bucket",
    "matched_reference_term",
    "signal_match_status",
    "signal_match_score",
    "signal_match_method",
    "signal_bucket",
    "signal_key",
    "display_signal_name",
    "signal_confidence_levels",
    "signal_source_packets",
    "signal_source_decisions",
    "audit_resolution_status",
    "audit_resolution_type",
    "audit_resolution_rank",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def assert_required_columns(rows: list[dict[str, str]], required: list[str], label: str) -> None:
    available = list(rows[0].keys()) if rows else []
    missing = [field for field in required if field not in available]
    if missing:
        raise SystemExit(f"{label} missing required columns: {', '.join(missing)}")


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def resolve_audit_state(ingredient_row: dict[str, str], signal_row: dict[str, str] | None) -> tuple[str, str, int]:
    ingredient_status = normalize_text(ingredient_row.get("match_status"))
    if ingredient_status == "matched":
        return "covered", "ingredient_reference_match", 100
    if ingredient_status == "ambiguous":
        return "needs_review", "ingredient_reference_ambiguous", 25

    signal_status = normalize_text(signal_row.get("signal_match_status")) if signal_row else ""
    if signal_status == "matched":
        return "covered", "signal_dictionary_match", 80
    if signal_status == "ambiguous":
        return "needs_review", "signal_dictionary_ambiguous", 15
    return "unresolved", "no_deterministic_match", 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Combine ingredient matches and signal audit rows into one reviewable candidate layer.")
    parser.add_argument("--ingredient-match-csv", required=True, help="SKU x ingredient match CSV")
    parser.add_argument("--signal-audit-csv", required=True, help="SKU x signal audit CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write combined candidate CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-unresolved-csv", help="Optional unresolved-only CSV")
    args = parser.parse_args()

    ingredient_rows = load_csv_rows(Path(args.ingredient_match_csv).expanduser().resolve())
    signal_rows = load_csv_rows(Path(args.signal_audit_csv).expanduser().resolve())
    assert_required_columns(ingredient_rows, INGREDIENT_REQUIRED_COLUMNS, "Ingredient match CSV")
    assert_required_columns(signal_rows, SIGNAL_REQUIRED_COLUMNS, "Signal audit CSV")

    signal_lookup = {
        normalize_text(row.get("candidate_match_key")): row
        for row in signal_rows
        if normalize_text(row.get("candidate_match_key"))
    }

    combined_rows: list[dict[str, str]] = []
    unresolved_rows: list[dict[str, str]] = []
    resolution_counts: Counter[str] = Counter()
    resolution_status_counts: Counter[str] = Counter()
    granularity_resolution_counts: Counter[str] = Counter()
    canonical_counts: Counter[str] = Counter()
    signal_key_counts: Counter[str] = Counter()

    for ingredient_row in ingredient_rows:
        candidate_match_key = normalize_text(ingredient_row.get("candidate_match_key"))
        signal_row = signal_lookup.get(candidate_match_key)
        resolution_status, resolution_type, resolution_rank = resolve_audit_state(ingredient_row, signal_row)

        canonical_name = normalize_text(ingredient_row.get("canonical_inci_name"))
        signal_key = normalize_text(signal_row.get("signal_key")) if signal_row else ""
        if resolution_type == "ingredient_reference_match" and canonical_name:
            canonical_counts[canonical_name] += 1
        if resolution_type == "signal_dictionary_match" and signal_key:
            signal_key_counts[signal_key] += 1

        resolution_counts[resolution_type] += 1
        resolution_status_counts[resolution_status] += 1
        granularity_resolution_counts[
            f"{normalize_text(ingredient_row.get('ingredient_granularity'))}::{resolution_type}"
        ] += 1

        output_row = {
            "candidate_match_key": candidate_match_key,
            "sku_row_key": normalize_text(ingredient_row.get("sku_row_key")),
            "source_file": normalize_text(ingredient_row.get("source_file")),
            "source_sheet": normalize_text(ingredient_row.get("source_sheet")),
            "source_row_number": normalize_text(ingredient_row.get("source_row_number")),
            "brand_name": normalize_text(ingredient_row.get("brand_name")),
            "product_name": normalize_text(ingredient_row.get("product_name")),
            "official_product_url": normalize_text(ingredient_row.get("official_product_url")),
            "market": normalize_text(ingredient_row.get("market")),
            "category": normalize_text(ingredient_row.get("category")),
            "ingredient_granularity": normalize_text(ingredient_row.get("ingredient_granularity")),
            "extraction_status": normalize_text(ingredient_row.get("extraction_status")),
            "raw_ingredient_text": normalize_text(ingredient_row.get("raw_ingredient_text")),
            "raw_token": normalize_text(ingredient_row.get("raw_token")),
            "token_index": normalize_text(ingredient_row.get("token_index")),
            "token_normalized": normalize_text(ingredient_row.get("token_normalized")),
            "ingredient_match_status": normalize_text(ingredient_row.get("match_status")),
            "ingredient_match_method": normalize_text(ingredient_row.get("match_method")),
            "ingredient_match_confidence": normalize_text(ingredient_row.get("match_confidence")),
            "ingredient_record_id": normalize_text(ingredient_row.get("ingredient_record_id")),
            "canonical_inci_name": canonical_name,
            "canonical_display_name": normalize_text(ingredient_row.get("canonical_display_name")),
            "ingredient_normalized_key": normalize_text(ingredient_row.get("ingredient_normalized_key")),
            "ingredient_family": normalize_text(ingredient_row.get("ingredient_family")),
            "primary_bucket": normalize_text(ingredient_row.get("primary_bucket")),
            "matched_reference_term": normalize_text(ingredient_row.get("matched_reference_term")),
            "signal_match_status": normalize_text(signal_row.get("signal_match_status")) if signal_row else "",
            "signal_match_score": normalize_text(signal_row.get("signal_match_score")) if signal_row else "",
            "signal_match_method": normalize_text(signal_row.get("signal_match_method")) if signal_row else "",
            "signal_bucket": normalize_text(signal_row.get("signal_bucket")) if signal_row else "",
            "signal_key": signal_key,
            "display_signal_name": normalize_text(signal_row.get("display_signal_name")) if signal_row else "",
            "signal_confidence_levels": normalize_text(signal_row.get("signal_confidence_levels")) if signal_row else "",
            "signal_source_packets": normalize_text(signal_row.get("signal_source_packets")) if signal_row else "",
            "signal_source_decisions": normalize_text(signal_row.get("signal_source_decisions")) if signal_row else "",
            "audit_resolution_status": resolution_status,
            "audit_resolution_type": resolution_type,
            "audit_resolution_rank": str(resolution_rank),
        }
        combined_rows.append(output_row)
        if resolution_status != "covered":
            unresolved_rows.append(output_row)

    out_csv = Path(args.out_csv).expanduser().resolve()
    write_csv(out_csv, combined_rows)

    if args.out_unresolved_csv:
        write_csv(Path(args.out_unresolved_csv).expanduser().resolve(), unresolved_rows)

    token_count = len(combined_rows)
    covered_count = resolution_status_counts.get("covered", 0)
    summary = {
        "ingredient_match_csv": str(Path(args.ingredient_match_csv).expanduser().resolve()),
        "signal_audit_csv": str(Path(args.signal_audit_csv).expanduser().resolve()),
        "token_count": token_count,
        "covered_token_count": covered_count,
        "coverage_pct": round((covered_count / token_count) * 100, 2) if token_count else 0.0,
        "resolution_status_counts": dict(resolution_status_counts),
        "resolution_type_counts": dict(resolution_counts),
        "granularity_resolution_counts": dict(granularity_resolution_counts),
        "top_canonical_matches": dict(canonical_counts.most_common(25)),
        "top_signal_keys": dict(signal_key_counts.most_common(25)),
        "recommended_target": {
            "table": "seed_preview.sku_ingredient_signal_audit_candidates",
            "role": "reviewable row-level candidate layer combining deterministic ingredient reference matches and reviewed signal dictionary hits",
            "ready_for_direct_runtime_use": False,
        },
        "promotion_path": [
            "keep SKU workbook rows in seed_ingest.sku_seed_inventory_seed",
            "keep ingredient workbook rows in seed_ingest.ingredient_reference_seed",
            "keep signal dictionary rows in seed_preview.ingredient_signal_dictionary_candidate_v1 or equivalent reviewed preview layer",
            "combine deterministic ingredient matches and reviewed signal hits into one reviewable candidate layer",
            "send only unresolved or parser-polluted rows to manual cleanup or harvester planning",
            "promote harvested/reviewed SKU ingredient evidence to pci_kb.sku_ingredients after review",
        ],
        "out_csv": str(out_csv),
        "out_unresolved_csv": str(Path(args.out_unresolved_csv).expanduser().resolve()) if args.out_unresolved_csv else "",
    }

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
