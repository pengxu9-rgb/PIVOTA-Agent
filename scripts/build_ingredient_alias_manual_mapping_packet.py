#!/usr/bin/env python3
"""Build a decision-ready packet for alias-normalization manual-mapping rows."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build ingredient alias manual-mapping packets. Install it in the local Python environment first."
    ) from exc


HCL_RE = re.compile(r"\bHCL\b", re.IGNORECASE)
CI_RE = re.compile(r"^CI\s*\d+", re.IGNORECASE)
SLASH_RE = re.compile(r"/")

PACKET_FIELDS = [
    "priority_score",
    "raw_token",
    "normalized_token",
    "manual_mapping_subtype",
    "suggested_new_canonical_inci_name",
    "suggested_parser_variants_addition",
    "example_brands",
    "example_products",
    "example_urls",
    "resolution_rationale",
    "decision",
    "approved_existing_target_record_id",
    "approved_existing_target_canonical_inci_name",
    "approved_new_canonical_inci_name",
    "approved_parser_variants_addition",
    "reviewer_notes",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def classify_subtype(token: str) -> str:
    text = normalize_text(token)
    if CI_RE.search(text):
        return "ci_color_index_token"
    if HCL_RE.search(text):
        return "salt_hcl_abbreviation"
    if SLASH_RE.search(text):
        return "bilingual_or_slash_label_variant"
    if text.casefold() == "edta":
        return "generic_abbreviation"
    return "other_manual_mapping"


def build_packet_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    packet_rows: list[dict[str, str]] = []
    for row in rows:
        if normalize_text(row.get("suggested_resolution")) != "needs_manual_mapping":
            continue
        packet_rows.append(
            {
                "priority_score": normalize_text(row.get("priority_score")),
                "raw_token": normalize_text(row.get("raw_token")),
                "normalized_token": normalize_text(row.get("normalized_token")),
                "manual_mapping_subtype": classify_subtype(row.get("raw_token", "")),
                "suggested_new_canonical_inci_name": normalize_text(row.get("suggested_new_canonical_inci_name")),
                "suggested_parser_variants_addition": normalize_text(row.get("suggested_parser_variants_addition")),
                "example_brands": normalize_text(row.get("example_brands")),
                "example_products": normalize_text(row.get("example_products")),
                "example_urls": normalize_text(row.get("example_urls")),
                "resolution_rationale": normalize_text(row.get("resolution_rationale")),
                "decision": "",
                "approved_existing_target_record_id": "",
                "approved_existing_target_canonical_inci_name": "",
                "approved_new_canonical_inci_name": normalize_text(row.get("approved_new_canonical_inci_name") or row.get("suggested_new_canonical_inci_name")),
                "approved_parser_variants_addition": normalize_text(row.get("approved_parser_variants_addition") or row.get("suggested_parser_variants_addition")),
                "reviewer_notes": "",
            }
        )
    return packet_rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=PACKET_FIELDS)
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
    parser = argparse.ArgumentParser(description="Build a decision-ready packet for alias-normalization manual-mapping rows.")
    parser.add_argument("--packet-csv", required=True, help="Alias-normalization packet CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write the manual-mapping packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX output")
    parser.add_argument("--sheet-name", default="Alias_Manual_Mapping", help="Optional XLSX sheet name")
    args = parser.parse_args()

    in_path = Path(args.packet_csv).expanduser().resolve()
    rows = load_rows(in_path)
    packet_rows = build_packet_rows(rows)

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()
    write_csv(out_csv, packet_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Alias_Manual_Mapping", packet_rows)

    summary = {
        "packet_csv": str(in_path),
        "row_count": len(packet_rows),
        "manual_mapping_subtype_counts": dict(Counter(row["manual_mapping_subtype"] for row in packet_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
        "decision_values": [
            "map_to_existing_canonical",
            "create_new_canonical",
            "keep_as_signal_or_alias_only",
            "needs_research",
        ],
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
