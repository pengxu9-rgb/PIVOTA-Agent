#!/usr/bin/env python3
"""Export a read-only ops review pack from the SKU ingredient/signal audit preview table."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

import psycopg2


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def rows_to_dicts(cursor) -> list[dict[str, object]]:
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a read-only ops review pack from the SKU ingredient/signal audit preview table.")
    parser.add_argument("--table", default="seed_preview.sku_ingredient_signal_audit_candidates", help="Preview table to inspect")
    parser.add_argument("--out-summary-json", required=True, help="Where to write ops summary JSON")
    parser.add_argument("--out-brand-csv", required=True, help="Where to write brand-level review CSV")
    parser.add_argument("--out-sku-csv", required=True, help="Where to write SKU-level review CSV")
    parser.add_argument("--out-unresolved-csv", required=True, help="Where to write unresolved row CSV")
    parser.add_argument("--out-signal-only-csv", required=True, help="Where to write signal-only row CSV")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        raise SystemExit("DATABASE_URL not configured")

    conn = psycopg2.connect(db_url)
    table = args.table

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT
              COUNT(*) AS row_count,
              COUNT(*) FILTER (WHERE audit_resolution_status = 'covered') AS covered_count,
              COUNT(*) FILTER (WHERE audit_resolution_status <> 'covered') AS unresolved_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'ingredient_reference_match') AS ingredient_match_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'signal_dictionary_match') AS signal_match_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_cleanup_ingredient_match') AS parser_cleanup_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'curated_signal_tail_overlay') AS curated_signal_tail_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_fragment_excluded') AS parser_fragment_exclusion_count
            FROM {table}
            """
        )
        summary_row = rows_to_dicts(cur)[0]

        cur.execute(
            f"""
            SELECT
              COALESCE(NULLIF(brand_name, ''), '(unknown)') AS brand_name,
              COUNT(*) AS token_count,
              COUNT(*) FILTER (WHERE audit_resolution_status = 'covered') AS covered_count,
              COUNT(*) FILTER (WHERE audit_resolution_status <> 'covered') AS unresolved_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'ingredient_reference_match') AS ingredient_match_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'signal_dictionary_match') AS signal_match_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_cleanup_ingredient_match') AS parser_cleanup_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'curated_signal_tail_overlay') AS curated_signal_tail_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_fragment_excluded') AS parser_fragment_exclusion_count
            FROM {table}
            GROUP BY 1
            ORDER BY unresolved_count DESC, token_count DESC, brand_name ASC
            """
        )
        brand_rows = rows_to_dicts(cur)

        cur.execute(
            f"""
            SELECT
              COALESCE(NULLIF(brand_name, ''), '(unknown)') AS brand_name,
              COALESCE(NULLIF(product_name, ''), '(unknown)') AS product_name,
              COALESCE(NULLIF(official_product_url, ''), '(missing)') AS official_product_url,
              COUNT(*) AS token_count,
              COUNT(*) FILTER (WHERE audit_resolution_status = 'covered') AS covered_count,
              COUNT(*) FILTER (WHERE audit_resolution_status <> 'covered') AS unresolved_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'signal_dictionary_match') AS signal_match_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_cleanup_ingredient_match') AS parser_cleanup_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'curated_signal_tail_overlay') AS curated_signal_tail_count,
              COUNT(*) FILTER (WHERE audit_resolution_type = 'parser_fragment_excluded') AS parser_fragment_exclusion_count
            FROM {table}
            GROUP BY 1, 2, 3
            ORDER BY unresolved_count DESC, signal_match_count DESC, brand_name ASC, product_name ASC
            """
        )
        sku_rows = rows_to_dicts(cur)

        cur.execute(
            f"""
            SELECT
              candidate_match_key,
              brand_name,
              product_name,
              official_product_url,
              category,
              ingredient_granularity,
              raw_token,
              token_normalized,
              audit_resolution_status,
              audit_resolution_type
            FROM {table}
            WHERE audit_resolution_status <> 'covered'
            ORDER BY brand_name ASC, product_name ASC, raw_token ASC
            """
        )
        unresolved_rows = rows_to_dicts(cur)

        cur.execute(
            f"""
            SELECT
              candidate_match_key,
              brand_name,
              product_name,
              official_product_url,
              category,
              ingredient_granularity,
              raw_token,
              signal_bucket,
              signal_key,
              display_signal_name,
              audit_resolution_type
            FROM {table}
            WHERE audit_resolution_type IN ('signal_dictionary_match', 'curated_signal_tail_overlay')
            ORDER BY brand_name ASC, product_name ASC, raw_token ASC
            """
        )
        signal_only_rows = rows_to_dicts(cur)

    conn.close()

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_brand_csv = Path(args.out_brand_csv).expanduser().resolve()
    out_sku_csv = Path(args.out_sku_csv).expanduser().resolve()
    out_unresolved_csv = Path(args.out_unresolved_csv).expanduser().resolve()
    out_signal_only_csv = Path(args.out_signal_only_csv).expanduser().resolve()

    write_csv(out_brand_csv, brand_rows)
    write_csv(out_sku_csv, sku_rows)
    write_csv(out_unresolved_csv, unresolved_rows)
    write_csv(out_signal_only_csv, signal_only_rows)

    payload = {
        "table": table,
        **summary_row,
        "out_brand_csv": str(out_brand_csv),
        "out_sku_csv": str(out_sku_csv),
        "out_unresolved_csv": str(out_unresolved_csv),
        "out_signal_only_csv": str(out_signal_only_csv),
    }
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
