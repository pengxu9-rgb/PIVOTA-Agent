#!/usr/bin/env python3
"""Build a refined decision packet for rows still marked as needs_signal_review."""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openpyxl is required to build ingredient needs-signal decision packets. Install it in the local Python environment first."
    ) from exc


REQUIRED_FIELDS = [
    "priority_score",
    "raw_token",
    "normalized_token",
    "unmatched_count",
    "sku_row_count",
    "full_inci_count",
    "key_count",
    "top_categories",
    "example_brands",
    "example_products",
    "example_urls",
    "suggested_resolution",
    "suggested_signal_bucket",
    "suggested_signal_key",
    "suggestion_confidence",
    "resolution_rationale",
    "decision",
    "approved_signal_bucket",
    "approved_signal_key",
    "reviewer_notes",
]

OUTPUT_FIELDS = REQUIRED_FIELDS + [
    "hardcase_subtype",
]

PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%|%\s*\w", re.IGNORECASE)
CLAIM_PHRASE_RE = re.compile(
    r"\b(with|including|technology|actives?|enzyme(?:s)?|powder|system)\b|[+/]",
    re.IGNORECASE,
)
ABBREV_RE = re.compile(r"^[A-Z0-9]{1,4}$")
BOTANICAL_HINT_RE = re.compile(
    r"\b(aloe|arugula|barbados|berry|camellia|calendula|chamomile|charcoal|cherry|fruit|green tea|juice|kalahari|leaf|leaves|melon|pomegranate|rice|tea)\b",
    re.IGNORECASE,
)


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def slug_key(value: Any) -> str:
    raw = unicodedata.normalize("NFKC", normalize_text(value)).lower()
    raw = re.sub(r"[^a-z0-9]+", "_", raw)
    return raw.strip("_")


def load_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    missing = [field for field in REQUIRED_FIELDS if field not in fieldnames]
    if missing:
        raise SystemExit(f"Signal-review CSV missing required columns: {', '.join(missing)}")
    return fieldnames, rows


def classify_hardcase(row: dict[str, str]) -> tuple[str, str, str, str]:
    token = normalize_text(row.get("raw_token"))
    if PERCENT_RE.search(token):
        return (
            "percent_strength_claim",
            "strength_claim_signal",
            slug_key(token),
            "Contains explicit percentage/strength wording; treat as a claim-style signal rather than a canonical ingredient row.",
        )
    if CLAIM_PHRASE_RE.search(token):
        return (
            "claim_phrase_or_system",
            "claim_phrase_signal",
            slug_key(token),
            "Looks like a claim phrase, system name, or multi-part label string; keep in signal review rather than canonical ingredient rows.",
        )
    if ABBREV_RE.match(token):
        return (
            "abbreviation_or_code",
            "abbreviation_or_code_review",
            slug_key(token),
            "Short abbreviation/code token needs explicit review before routing to signal or canonical layers.",
        )
    if BOTANICAL_HINT_RE.search(token):
        return (
            "botanical_or_material_name",
            "botanical_or_material_signal_review",
            slug_key(token),
            "Looks like a botanical/common-material name used in hero-ingredient copy; review before treating as a stable signal.",
        )
    return (
        "named_active_or_specific_term",
        "named_active_review",
        slug_key(token),
        "Specific named active or branded ingredient-like term still needs explicit review before routing into a signal dictionary.",
    )


def confidence_for_bucket(bucket: str) -> str:
    if bucket == "strength_claim_signal":
        return "high"
    if bucket in {"claim_phrase_signal", "botanical_or_material_signal_review"}:
        return "medium"
    return "low"


def build_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in rows:
        if normalize_text(row.get("suggested_signal_bucket")) != "needs_signal_review":
            continue
        subtype, bucket, signal_key, rationale = classify_hardcase(row)
        next_row = dict(row)
        next_row["hardcase_subtype"] = subtype
        next_row["suggested_signal_bucket"] = bucket
        next_row["suggested_signal_key"] = signal_key
        next_row["suggestion_confidence"] = confidence_for_bucket(bucket)
        next_row["resolution_rationale"] = rationale
        out.append({field: normalize_text(next_row.get(field)) for field in OUTPUT_FIELDS})
    return out


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a refined decision packet for rows still marked as needs_signal_review.")
    parser.add_argument("--signal-review-csv", required=True, help="Signal-review packet CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write the refined decision packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write packet summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX packet output")
    parser.add_argument("--sheet-name", default="Needs_Signal_Decisions", help="Optional XLSX sheet name")
    args = parser.parse_args()

    input_path = Path(args.signal_review_csv).expanduser().resolve()
    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()

    _, rows = load_rows(input_path)
    packet_rows = build_rows(rows)

    write_csv(out_csv, packet_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Needs_Signal_Decisions", packet_rows)

    summary = {
        "signal_review_csv": str(input_path),
        "row_count": len(packet_rows),
        "hardcase_subtype_counts": dict(Counter(row["hardcase_subtype"] for row in packet_rows)),
        "suggested_signal_bucket_counts": dict(Counter(row["suggested_signal_bucket"] for row in packet_rows)),
        "confidence_counts": dict(Counter(row["suggestion_confidence"] for row in packet_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
