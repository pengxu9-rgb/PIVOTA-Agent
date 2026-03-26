#!/usr/bin/env python3
"""Build a decision-ready packet for marketing/blend signal rows."""

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
        "openpyxl is required to build ingredient marketing signal decision packets. Install it in the local Python environment first."
    ) from exc


TRADEMARK_RE = re.compile(r"[™®]")
COMPLEX_BLEND_RE = re.compile(r"\b(complex|blend)\b", re.IGNORECASE)
UMBRELLA_RE = re.compile(r"\bantioxidants?\b", re.IGNORECASE)

PACKET_FIELDS = [
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
    "suggested_marketing_subtype",
    "suggestion_confidence",
    "resolution_rationale",
    "decision",
    "approved_signal_bucket",
    "approved_signal_key",
    "approved_marketing_subtype",
    "reviewer_notes",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def classify_marketing_subtype(token: str) -> tuple[str, str, str]:
    text = normalize_text(token)
    if TRADEMARK_RE.search(text):
        return (
            "trademarked_trade_name_signal",
            "high",
            "Contains trademark notation; treat as branded trade-name signal rather than canonical ingredient.",
        )
    if COMPLEX_BLEND_RE.search(text):
        return (
            "complex_or_blend_claim_signal",
            "high",
            "Contains complex/blend phrasing; treat as marketing blend signal rather than canonical ingredient.",
        )
    if UMBRELLA_RE.search(text):
        return (
            "umbrella_benefit_signal",
            "medium",
            "Generic benefit umbrella term; likely a signal, but still worth reviewer confirmation before approval.",
        )
    return (
        "other_marketing_signal",
        "low",
        "Marketing-like phrase that still needs reviewer confirmation before approval.",
    )


def build_packet_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    packet_rows: list[dict[str, str]] = []
    for row in rows:
        subtype, confidence, rationale = classify_marketing_subtype(row.get("raw_token", ""))
        packet_rows.append(
            {
                "priority_score": normalize_text(row.get("priority_score")),
                "raw_token": normalize_text(row.get("raw_token")),
                "normalized_token": normalize_text(row.get("normalized_token")),
                "unmatched_count": normalize_text(row.get("unmatched_count")),
                "sku_row_count": normalize_text(row.get("sku_row_count")),
                "full_inci_count": normalize_text(row.get("full_inci_count")),
                "key_count": normalize_text(row.get("key_count")),
                "top_categories": normalize_text(row.get("top_categories")),
                "example_brands": normalize_text(row.get("example_brands")),
                "example_products": normalize_text(row.get("example_products")),
                "example_urls": normalize_text(row.get("example_urls")),
                "suggested_resolution": normalize_text(row.get("suggested_resolution")) or "route_to_signal_dict",
                "suggested_signal_bucket": normalize_text(row.get("suggested_signal_bucket")) or "marketing_or_blend_signal",
                "suggested_signal_key": normalize_text(row.get("suggested_signal_key")),
                "suggested_marketing_subtype": subtype,
                "suggestion_confidence": confidence,
                "resolution_rationale": rationale,
                "decision": normalize_text(row.get("decision")),
                "approved_signal_bucket": normalize_text(row.get("approved_signal_bucket")),
                "approved_signal_key": normalize_text(row.get("approved_signal_key")),
                "approved_marketing_subtype": "",
                "reviewer_notes": normalize_text(row.get("reviewer_notes")),
            }
        )
    return packet_rows


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
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
    parser = argparse.ArgumentParser(description="Build a decision-ready packet for marketing/blend signal rows.")
    parser.add_argument("--packet-csv", required=True, help="Marketing/blend signal packet CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write the decision-ready packet CSV")
    parser.add_argument("--out-json", required=True, help="Where to write packet summary JSON")
    parser.add_argument("--out-xlsx", help="Optional XLSX decision packet output")
    parser.add_argument("--sheet-name", default="Marketing_Signal_Decisions", help="Optional XLSX sheet name")
    args = parser.parse_args()

    in_path = Path(args.packet_csv).expanduser().resolve()
    rows = load_rows(in_path)
    packet_rows = build_packet_rows(rows)

    out_csv = Path(args.out_csv).expanduser().resolve()
    out_json = Path(args.out_json).expanduser().resolve()

    write_csv(out_csv, PACKET_FIELDS, packet_rows)
    if args.out_xlsx:
        write_xlsx(Path(args.out_xlsx).expanduser().resolve(), normalize_text(args.sheet_name) or "Marketing_Signal_Decisions", packet_rows)

    summary = {
        "packet_csv": str(in_path),
        "row_count": len(packet_rows),
        "suggested_marketing_subtype_counts": dict(
            Counter(row["suggested_marketing_subtype"] for row in packet_rows)
        ),
        "confidence_counts": dict(Counter(row["suggestion_confidence"] for row in packet_rows)),
        "out_csv": str(out_csv),
        "out_xlsx": str(Path(args.out_xlsx).expanduser().resolve()) if args.out_xlsx else "",
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
