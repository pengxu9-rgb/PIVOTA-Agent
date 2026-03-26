#!/usr/bin/env python3
"""Export reviewed SKU runtime evidence rows into kb_pgvector_ingest-compatible CSV."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


OUTPUT_FIELDS = [
    "candidate_id",
    "sku_key",
    "market",
    "category",
    "brand",
    "product_name",
    "source_ref",
    "source_type",
    "harvest_status",
    "harvest_confidence",
    "parse_status",
    "parse_confidence",
    "review_status",
    "audit_status",
    "ingest_allowed",
    "raw_ingredient_text",
    "inci_list",
    "inci_list_json",
    "evidence_lane",
    "signal_handling_lane",
    "approved_decision",
    "trust_tier",
    "downstream_handoff_path",
    "source_packet",
    "decision_rationale",
]


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def split_semicolon(value: Any) -> list[str]:
    raw = normalize_text(value)
    if not raw:
        return []
    return [item.strip() for item in raw.split(";") if item.strip()]


def trust_tier_to_confidence(value: str) -> str:
    mapping = {
        "high": "1.0",
        "medium": "0.85",
        "low": "0.65",
    }
    return mapping.get(normalize_text(value).lower(), "0.75")


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [{key: normalize_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export reviewed SKU runtime evidence rows into kb_pgvector_ingest-compatible CSV.")
    parser.add_argument("--runtime-evidence-csv", required=True, help="Reviewed runtime evidence CSV")
    parser.add_argument("--out-csv", required=True, help="Where to write kb_pgvector_ingest-compatible CSV")
    parser.add_argument("--out-summary-json", required=True, help="Where to write summary JSON")
    args = parser.parse_args()

    in_path = Path(args.runtime_evidence_csv).expanduser().resolve()
    out_csv = Path(args.out_csv).expanduser().resolve()
    out_summary_json = Path(args.out_summary_json).expanduser().resolve()

    rows = load_rows(in_path)
    exported_rows: list[dict[str, str]] = []
    lane_counts: Counter[str] = Counter()
    signal_lane_counts: Counter[str] = Counter()
    trust_tier_counts: Counter[str] = Counter()
    skipped_missing_inci = 0
    skipped_not_eligible = 0

    for row in rows:
        runtime_eligible = normalize_text(row.get("runtime_evidence_eligible")).lower() == "yes"
        if not runtime_eligible:
            skipped_not_eligible += 1
            continue
        canonical_ingredients = split_semicolon(row.get("canonical_ingredients"))
        if not canonical_ingredients:
            skipped_missing_inci += 1
            continue

        trust_tier = normalize_text(row.get("trust_tier")).lower()
        review_status = normalize_text(row.get("review_status")).upper() or "APPROVED"
        evidence_lane = normalize_text(row.get("evidence_lane"))
        signal_handling_lane = normalize_text(row.get("signal_handling_lane"))
        sku_key = normalize_text(row.get("sku_row_key"))

        exported_rows.append(
            {
                "candidate_id": sku_key,
                "sku_key": sku_key,
                "market": normalize_text(row.get("market")),
                "category": normalize_text(row.get("category")),
                "brand": normalize_text(row.get("brand_name")),
                "product_name": normalize_text(row.get("product_name")),
                "source_ref": normalize_text(row.get("official_product_url")),
                "source_type": f"reviewed_runtime_evidence:{evidence_lane or 'unknown'}",
                "harvest_status": "REVIEWED_RUNTIME_EVIDENCE",
                "harvest_confidence": trust_tier_to_confidence(trust_tier),
                "parse_status": "OK",
                "parse_confidence": trust_tier_to_confidence(trust_tier),
                "review_status": review_status,
                "audit_status": "PASS",
                "ingest_allowed": "true",
                "raw_ingredient_text": "; ".join(canonical_ingredients),
                "inci_list": "; ".join(canonical_ingredients),
                "inci_list_json": json.dumps(canonical_ingredients, ensure_ascii=False),
                "evidence_lane": evidence_lane,
                "signal_handling_lane": signal_handling_lane,
                "approved_decision": normalize_text(row.get("approved_decision")),
                "trust_tier": trust_tier,
                "downstream_handoff_path": normalize_text(row.get("downstream_handoff_path")),
                "source_packet": normalize_text(row.get("source_packet")),
                "decision_rationale": normalize_text(row.get("decision_rationale")),
            }
        )

        lane_counts[evidence_lane] += 1
        signal_lane_counts[signal_handling_lane] += 1
        trust_tier_counts[trust_tier] += 1

    write_rows(out_csv, exported_rows)

    payload = {
        "runtime_evidence_csv": str(in_path),
        "row_count": len(rows),
        "exported_row_count": len(exported_rows),
        "skipped_missing_inci_count": skipped_missing_inci,
        "skipped_not_eligible_count": skipped_not_eligible,
        "evidence_lane_counts": dict(lane_counts),
        "signal_handling_lane_counts": dict(signal_lane_counts),
        "trust_tier_counts": dict(trust_tier_counts),
        "out_csv": str(out_csv),
    }
    out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    out_summary_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
