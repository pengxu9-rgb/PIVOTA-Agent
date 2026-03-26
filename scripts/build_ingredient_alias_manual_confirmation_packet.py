#!/usr/bin/env python3
"""Build a decision-ready packet for alias manual-confirmation rows."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def build_packet_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    packet_rows: list[dict[str, str]] = []
    for row in rows:
        packet_rows.append(
            {
                "record_id": normalize_text(row.get("record_id")),
                "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                "canonical_display_name": normalize_text(row.get("canonical_display_name")),
                "ingredient_family": normalize_text(row.get("ingredient_family")),
                "existing_aliases_common": "",
                "existing_alias_quality": "",
                "suggested_aliases_common": normalize_text(row.get("suggested_aliases_common")),
                "suggested_alias_quality": normalize_text(row.get("suggested_alias_quality")),
                "resolution_rationale": normalize_text(row.get("resolution_rationale")),
                "suggested_resolution": normalize_text(row.get("suggested_resolution")),
                "decision": "",
                "approved_aliases_common": normalize_text(row.get("suggested_aliases_common")),
                "approved_alias_quality": normalize_text(row.get("suggested_alias_quality")),
                "reviewer_notes": "",
            }
        )
    return packet_rows


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a decision-ready packet for ingredient alias manual-confirmation rows.")
    parser.add_argument("--manual-csv", required=True, help="Manual-confirmation CSV from export_ingredient_alias_manual_workbench_patch.py")
    parser.add_argument("--out-csv", required=True, help="Where to write the decision-ready packet CSV")
    parser.add_argument("--out-json", help="Optional path for a JSON copy of the packet")
    args = parser.parse_args()

    manual_path = Path(args.manual_csv).expanduser().resolve()
    rows = load_rows(manual_path)
    packet_rows = build_packet_rows(rows)

    fieldnames = [
        "record_id",
        "canonical_inci_name",
        "canonical_display_name",
        "ingredient_family",
        "existing_aliases_common",
        "existing_alias_quality",
        "suggested_aliases_common",
        "suggested_alias_quality",
        "resolution_rationale",
        "suggested_resolution",
        "decision",
        "approved_aliases_common",
        "approved_alias_quality",
        "reviewer_notes",
    ]

    out_csv = Path(args.out_csv).expanduser().resolve()
    write_csv(out_csv, packet_rows, fieldnames)

    out_json = None
    if args.out_json:
        out_json = Path(args.out_json).expanduser().resolve()
        out_json.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "source_manual_csv": str(manual_path),
            "decision_values": [
                "approve_suggestion",
                "approve_override",
                "reject_no_alias",
                "needs_research",
            ],
            "row_count": len(packet_rows),
            "rows": packet_rows,
        }
        out_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "source_manual_csv": str(manual_path),
                "row_count": len(packet_rows),
                "out_csv": str(out_csv),
                "out_json": str(out_json) if out_json else None,
                "decision_values": [
                    "approve_suggestion",
                    "approve_override",
                    "reject_no_alias",
                    "needs_research",
                ],
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
