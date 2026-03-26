#!/usr/bin/env python3
"""Generate a conservative staging-table DDL from an ingredient seed bundle manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


SPECIAL_COLUMN_TYPES = {
    "source_row_number": "INTEGER",
    "ingested_at": "TIMESTAMPTZ",
}

NOT_NULL_COLUMNS = {
    "source_file",
    "source_sheet",
    "source_row_number",
    "ingested_at",
    "record_id",
}


def parse_target_table(value: str) -> tuple[str, str]:
    parts = str(value or "").strip().split(".")
    if len(parts) != 2:
        raise SystemExit(f"Invalid target table: {value!r}. Expected schema.table")
    return parts[0], parts[1]


def quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def column_sql(name: str, primary_key_columns: list[str]) -> str:
    sql_type = SPECIAL_COLUMN_TYPES.get(name, "TEXT")
    nullable = "" if name in NOT_NULL_COLUMNS else " NULL"
    if len(primary_key_columns) == 1 and name == primary_key_columns[0]:
        return f"{quote_ident(name)} {sql_type} PRIMARY KEY"
    not_null = " NOT NULL" if name in NOT_NULL_COLUMNS else nullable
    return f"{quote_ident(name)} {sql_type}{not_null}"


def build_ddl(schema_name: str, table_name: str, columns: list[str], primary_key_columns: list[str], unique_columns: list[str]) -> str:
    table_ref = f"{quote_ident(schema_name)}.{quote_ident(table_name)}"
    column_lines = [f"  {column_sql(column, primary_key_columns)}" for column in columns]
    if len(primary_key_columns) > 1:
        pk_sql = ", ".join(quote_ident(column) for column in primary_key_columns)
        column_lines.append(f"  PRIMARY KEY ({pk_sql})")

    statements = [
        f"CREATE SCHEMA IF NOT EXISTS {quote_ident(schema_name)};",
        "",
        f"CREATE TABLE IF NOT EXISTS {table_ref} (",
        ",\n".join(column_lines),
        ");",
        "",
    ]

    for column in unique_columns:
        if column in primary_key_columns:
            continue
        index_name = f"{table_name}_{column}_key"
        statements.append(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {quote_ident(index_name)} ON {table_ref} ({quote_ident(column)});"
        )

    return "\n".join(statements).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a conservative staging-table DDL from an ingredient seed bundle manifest.")
    parser.add_argument("--bundle-manifest-json", required=True, help="Bundle manifest JSON")
    parser.add_argument("--out-sql", required=True, help="Where to write the DDL SQL")
    args = parser.parse_args()

    manifest_path = Path(args.bundle_manifest_json).expanduser().resolve()
    out_sql_path = Path(args.out_sql).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    schema_name, table_name = parse_target_table(manifest["target_table"])
    columns = [str(column).strip() for column in manifest.get("exported_columns", []) if str(column).strip()]
    primary_key_columns = [str(column).strip() for column in manifest.get("recommended_primary_key", []) if str(column).strip()]
    unique_columns = [str(column).strip() for column in manifest.get("recommended_secondary_unique_keys", []) if str(column).strip()]

    ddl = build_ddl(schema_name, table_name, columns, primary_key_columns, unique_columns)
    out_sql_path.parent.mkdir(parents=True, exist_ok=True)
    out_sql_path.write_text(ddl, encoding="utf-8")
    print(
        json.dumps(
            {
                "bundle_manifest_json": str(manifest_path),
                "target_table": manifest["target_table"],
                "column_count": len(columns),
                "primary_key": primary_key_columns,
                "unique_indexes": unique_columns,
                "out_sql": str(out_sql_path),
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
