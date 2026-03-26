#!/usr/bin/env python3
"""Build a grouped ingredient signal dictionary candidate layer from approved signal rows."""

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
        "openpyxl is required to build ingredient signal dictionary workbooks. Install it in the local Python environment first."
    ) from exc


REQUIRED_FIELDS = [
    "raw_token",
    "normalized_token",
    "signal_bucket",
    "signal_key",
    "source_decision",
    "suggestion_confidence",
    "priority_score",
    "unmatched_count",
    "sku_row_count",
    "full_inci_count",
    "key_count",
    "top_categories",
    "example_brands",
    "example_products",
    "example_urls",
    "resolution_rationale",
    "source_packet",
]

OUTPUT_FIELDS = [
    "signal_bucket",
    "signal_key",
    "display_signal_name",
    "raw_token_variants",
    "normalized_token_variants",
    "source_packets",
    "source_decisions",
    "confidence_levels",
    "row_count",
    "total_unmatched_count",
    "total_sku_row_count",
    "total_full_inci_count",
    "total_key_count",
    "top_categories",
    "example_brands",
    "example_products",
    "example_urls",
    "resolution_rationales",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_int(value: Any) -> int:
    raw = normalize_text(value)
    if not raw:
        return 0
    try:
        return int(float(raw))
    except ValueError:
        return 0


def split_semicolon(value: Any) -> list[str]:
    raw = normalize_text(value)
    if not raw:
        return []
    return [part.strip() for part in raw.split(";") if part.strip()]


def dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = normalize_text(item)
        if not key:
            continue
        marker = key.lower()
        if marker in seen:
            continue
        seen.add(marker)
        out.append(key)
    return out


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        missing = [field for field in REQUIRED_FIELDS if field not in fieldnames]
        if missing:
            raise SystemExit(f"Signal candidate CSV missing required columns: {', '.join(missing)}")
        return list(reader)


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def write_xlsx(path: Path, sheet_name: str, rows: list[dict[str, str]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.append(OUTPUT_FIELDS)
    for row in rows:
        sheet.append([row.get(field, "") for field in OUTPUT_FIELDS])
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)


def choose_display_name(raw_tokens: list[str], signal_key: str) -> str:
    if raw_tokens:
        token_counts = Counter(raw_tokens)
        return sorted(token_counts.items(), key=lambda item: (-item[1], item[0].lower()))[0][0]
    return signal_key


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a grouped ingredient signal dictionary candidate layer from approved signal rows.")
    parser.add_argument(
        "--candidate-csv",
        action="append",
        required=True,
        help="Approved signal candidate CSV. May be passed multiple times.",
    )
    parser.add_argument("--out-csv", required=True, help="Where to write grouped dictionary CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    parser.add_argument("--out-xlsx", help="Optional grouped dictionary XLSX")
    parser.add_argument("--sheet-name", default="Signal_Dictionary", help="Optional XLSX sheet name")
    args = parser.parse_args()

    source_paths = [Path(value).expanduser().resolve() for value in args.candidate_csv]
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    source_row_count = 0

    for source_path in source_paths:
        rows = load_rows(source_path)
        source_row_count += len(rows)
        for row in rows:
            bucket = normalize_text(row.get("signal_bucket"))
            key = normalize_text(row.get("signal_key"))
            group_key = (bucket, key)
            current = grouped.setdefault(
                group_key,
                {
                    "signal_bucket": bucket,
                    "signal_key": key,
                    "raw_tokens": [],
                    "normalized_tokens": [],
                    "source_packets": [],
                    "source_decisions": [],
                    "confidence_levels": [],
                    "unmatched_count": 0,
                    "sku_row_count": 0,
                    "full_inci_count": 0,
                    "key_count": 0,
                    "top_categories": [],
                    "example_brands": [],
                    "example_products": [],
                    "example_urls": [],
                    "resolution_rationales": [],
                    "row_count": 0,
                },
            )
            current["raw_tokens"].append(normalize_text(row.get("raw_token")))
            current["normalized_tokens"].append(normalize_text(row.get("normalized_token")))
            current["source_packets"].append(normalize_text(row.get("source_packet")))
            current["source_decisions"].append(normalize_text(row.get("source_decision")))
            current["confidence_levels"].append(normalize_text(row.get("suggestion_confidence")))
            current["unmatched_count"] += normalize_int(row.get("unmatched_count"))
            current["sku_row_count"] += normalize_int(row.get("sku_row_count"))
            current["full_inci_count"] += normalize_int(row.get("full_inci_count"))
            current["key_count"] += normalize_int(row.get("key_count"))
            current["top_categories"].extend(split_semicolon(row.get("top_categories")))
            current["example_brands"].extend(split_semicolon(row.get("example_brands")))
            current["example_products"].extend(split_semicolon(row.get("example_products")))
            current["example_urls"].extend(split_semicolon(row.get("example_urls")))
            current["resolution_rationales"].append(normalize_text(row.get("resolution_rationale")))
            current["row_count"] += 1

    output_rows: list[dict[str, str]] = []
    for (_, _), group in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
        raw_tokens = dedupe_keep_order(group["raw_tokens"])
        normalized_tokens = dedupe_keep_order(group["normalized_tokens"])
        row = {
            "signal_bucket": group["signal_bucket"],
            "signal_key": group["signal_key"],
            "display_signal_name": choose_display_name(raw_tokens, group["signal_key"]),
            "raw_token_variants": "; ".join(raw_tokens),
            "normalized_token_variants": "; ".join(normalized_tokens),
            "source_packets": "; ".join(dedupe_keep_order(group["source_packets"])),
            "source_decisions": "; ".join(dedupe_keep_order(group["source_decisions"])),
            "confidence_levels": "; ".join(dedupe_keep_order(group["confidence_levels"])),
            "row_count": str(group["row_count"]),
            "total_unmatched_count": str(group["unmatched_count"]),
            "total_sku_row_count": str(group["sku_row_count"]),
            "total_full_inci_count": str(group["full_inci_count"]),
            "total_key_count": str(group["key_count"]),
            "top_categories": "; ".join(dedupe_keep_order(group["top_categories"])),
            "example_brands": "; ".join(dedupe_keep_order(group["example_brands"])),
            "example_products": "; ".join(dedupe_keep_order(group["example_products"])),
            "example_urls": "; ".join(dedupe_keep_order(group["example_urls"])),
            "resolution_rationales": "; ".join(dedupe_keep_order(group["resolution_rationales"])),
        }
        output_rows.append(row)

    out_csv = Path(args.out_csv).expanduser().resolve()
    write_csv(out_csv, output_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Signal_Dictionary", output_rows)

    summary = {
        "source_csvs": [str(path) for path in source_paths],
        "source_row_count": source_row_count,
        "dictionary_row_count": len(output_rows),
        "signal_bucket_counts": dict(Counter(row["signal_bucket"] for row in output_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }

    out_summary_json = Path(args.out_summary_json).expanduser().resolve()
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
