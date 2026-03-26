#!/usr/bin/env python3
"""Export apply-ready alias patch rows from a reviewed manual-confirmation packet."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


APPROVE_SUGGESTION = "approve_suggestion"
APPROVE_OVERRIDE = "approve_override"
REJECT_NO_ALIAS = "reject_no_alias"
NEEDS_RESEARCH = "needs_research"


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export apply-ready alias patch rows from a reviewed manual-confirmation packet.")
    parser.add_argument("--decision-csv", required=True, help="Decision-ready CSV after reviewer decisions are filled")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready alias patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not exported into the apply patch")
    args = parser.parse_args()

    decision_path = Path(args.decision_csv).expanduser().resolve()
    rows = load_rows(decision_path)

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        decision = normalize_text(row.get("decision")).lower()
        payload = {
            "record_id": normalize_text(row.get("record_id")),
            "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
            "canonical_display_name": normalize_text(row.get("canonical_display_name")),
            "ingredient_family": normalize_text(row.get("ingredient_family")),
            "existing_aliases_common": normalize_text(row.get("existing_aliases_common")),
            "existing_alias_quality": normalize_text(row.get("existing_alias_quality")),
            "suggested_aliases_common": normalize_text(row.get("suggested_aliases_common")),
            "suggested_alias_quality": normalize_text(row.get("suggested_alias_quality")),
            "resolution_rationale": normalize_text(row.get("resolution_rationale")),
            "suggested_resolution": normalize_text(row.get("suggested_resolution")),
            "decision": decision,
            "approved_aliases_common": normalize_text(row.get("approved_aliases_common")),
            "approved_alias_quality": normalize_text(row.get("approved_alias_quality")),
            "reviewer_notes": normalize_text(row.get("reviewer_notes")),
        }

        patch_aliases_common = ""
        patch_alias_quality = ""

        if decision == APPROVE_SUGGESTION:
            patch_aliases_common = payload["suggested_aliases_common"]
            patch_alias_quality = payload["suggested_alias_quality"]
        elif decision == APPROVE_OVERRIDE:
            patch_aliases_common = payload["approved_aliases_common"]
            patch_alias_quality = payload["approved_alias_quality"]

        if patch_aliases_common and patch_alias_quality:
            apply_rows.append(
                {
                    "record_id": payload["record_id"],
                    "canonical_inci_name": payload["canonical_inci_name"],
                    "existing_aliases_common": payload["existing_aliases_common"],
                    "existing_alias_quality": payload["existing_alias_quality"],
                    "patch_aliases_common": patch_aliases_common,
                    "patch_alias_quality": patch_alias_quality,
                    "proposal_sources": "manual_confirmation_packet",
                    "quality_reason": payload["reviewer_notes"] or payload["resolution_rationale"],
                }
            )
            continue

        if decision in {REJECT_NO_ALIAS, NEEDS_RESEARCH, ""} or not decision:
            remainder_rows.append(payload)
            continue

        remainder_rows.append(payload)

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_aliases_common",
        "existing_alias_quality",
        "patch_aliases_common",
        "patch_alias_quality",
        "proposal_sources",
        "quality_reason",
    ]
    remainder_fieldnames = [
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

    out_apply_csv = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(out_apply_csv, apply_rows, apply_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    print(
        json.dumps(
            {
                "decision_csv": str(decision_path),
                "apply_ready_count": len(apply_rows),
                "remainder_count": len(remainder_rows),
                "out_apply_csv": str(out_apply_csv),
                "out_remainder_csv": str(remainder_path) if remainder_path else None,
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
