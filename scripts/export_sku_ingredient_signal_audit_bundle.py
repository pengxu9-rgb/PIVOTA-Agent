#!/usr/bin/env python3
"""Export SKU ingredient/signal audit candidates into a seed_preview-ready CSV bundle."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_COLUMNS = [
    "candidate_match_key",
    "sku_row_key",
    "source_file",
    "source_sheet",
    "source_row_number",
    "brand_name",
    "product_name",
    "official_product_url",
    "ingredient_granularity",
    "raw_token",
    "token_index",
    "token_normalized",
    "ingredient_match_status",
    "signal_match_status",
    "audit_resolution_status",
    "audit_resolution_type",
]

METADATA_COLUMNS = [
    "source_bundle_csv",
    "bundle_ingested_at",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        header = [normalize_text(field) for field in (reader.fieldnames or [])]
        rows = [
            {key: normalize_text(value) for key, value in row.items()}
            for row in reader
        ]
    return header, rows


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_copy_sql(target_table: str, csv_path: Path, fieldnames: list[str]) -> str:
    columns_sql = ",\n  ".join(fieldnames)
    csv_literal = str(csv_path).replace("'", "''")
    return (
        f"COPY {target_table} (\n"
        f"  {columns_sql}\n"
        f")\n"
        f"FROM '{csv_literal}'\n"
        "WITH (\n"
        "  FORMAT csv,\n"
        "  HEADER true,\n"
        "  ENCODING 'UTF8'\n"
        ");\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export SKU ingredient/signal audit candidates into a seed_preview-ready CSV bundle.")
    parser.add_argument("--candidate-csv", required=True, help="Combined SKU ingredient/signal audit candidate CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write the export CSV")
    parser.add_argument("--out-manifest-json", required=True, help="Where to write the export manifest JSON")
    parser.add_argument("--out-copy-sql", help="Optional path to write a COPY SQL template")
    parser.add_argument(
        "--target-table",
        default="seed_preview.sku_ingredient_signal_audit_candidates",
        help="Target preview table",
    )
    args = parser.parse_args()

    candidate_csv = Path(args.candidate_csv).expanduser().resolve()
    out_csv = Path(args.out_csv).expanduser().resolve()
    out_manifest = Path(args.out_manifest_json).expanduser().resolve()
    out_copy_sql = Path(args.out_copy_sql).expanduser().resolve() if args.out_copy_sql else None

    header, rows = read_csv(candidate_csv)
    missing = [column for column in REQUIRED_COLUMNS if column not in header]
    if missing:
        raise SystemExit(f"Candidate CSV missing required columns: {', '.join(missing)}")

    exported_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    fieldnames = METADATA_COLUMNS + header

    out_rows: list[dict[str, str]] = []
    for row in rows:
        enriched = {
            "source_bundle_csv": candidate_csv.name,
            "bundle_ingested_at": exported_at,
        }
        enriched.update(row)
        out_rows.append(enriched)

    write_csv(out_csv, fieldnames, out_rows)

    if out_copy_sql:
        out_copy_sql.parent.mkdir(parents=True, exist_ok=True)
        out_copy_sql.write_text(build_copy_sql(args.target_table, out_csv, fieldnames), encoding="utf-8")

    manifest = {
        "source_candidate_csv": str(candidate_csv),
        "source_candidate_csv_sha256": sha256_file(candidate_csv),
        "target_table": args.target_table,
        "row_count": len(out_rows),
        "required_columns_validated": REQUIRED_COLUMNS,
        "exported_columns": fieldnames,
        "recommended_primary_key": ["candidate_match_key"],
        "recommended_secondary_indexes": [
            "sku_row_key",
            "canonical_inci_name",
            "signal_key",
            "audit_resolution_status",
            "audit_resolution_type",
        ],
        "out_csv": str(out_csv),
        "out_copy_sql": str(out_copy_sql) if out_copy_sql else None,
        "exported_at": exported_at,
    }

    out_manifest.parent.mkdir(parents=True, exist_ok=True)
    out_manifest.write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
