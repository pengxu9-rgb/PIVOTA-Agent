#!/usr/bin/env python3
"""Export apply-ready alias patches from the alias manual-review workbench."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


APPLYABLE_RESOLUTIONS = {
    "candidate_alias_high_confidence",
}

MANUAL_CONFIRM_RESOLUTIONS = {
    "candidate_alias_manual_confirmation",
}


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def classify_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    apply_rows: list[dict[str, Any]] = []
    manual_rows: list[dict[str, Any]] = []
    no_safe_rows: list[dict[str, Any]] = []

    for row in rows:
        resolution = normalize_text(row.get("suggested_resolution"))
        payload = {
            "record_id": normalize_text(row.get("record_id")),
            "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
            "canonical_display_name": normalize_text(row.get("canonical_display_name")),
            "ingredient_family": normalize_text(row.get("ingredient_family")),
            "suggested_aliases_common": normalize_text(row.get("suggested_aliases_common")),
            "suggested_alias_quality": normalize_text(row.get("suggested_alias_quality")),
            "resolution_rationale": normalize_text(row.get("resolution_rationale")),
            "suggested_resolution": resolution,
        }

        if resolution in APPLYABLE_RESOLUTIONS and payload["suggested_aliases_common"] and payload["suggested_alias_quality"]:
            apply_rows.append(
                {
                    "record_id": payload["record_id"],
                    "canonical_inci_name": payload["canonical_inci_name"],
                    "existing_aliases_common": "",
                    "existing_alias_quality": "",
                    "patch_aliases_common": payload["suggested_aliases_common"],
                    "patch_alias_quality": payload["suggested_alias_quality"],
                    "proposal_sources": "manual_review_workbench",
                    "quality_reason": payload["resolution_rationale"],
                }
            )
        elif resolution in MANUAL_CONFIRM_RESOLUTIONS:
            manual_rows.append(payload)
        else:
            no_safe_rows.append(payload)

    return apply_rows, manual_rows, no_safe_rows


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export apply-ready alias patches from alias manual-review workbench JSON.")
    parser.add_argument("--workbench-json", required=True, help="Path to alias manual-review workbench JSON")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready patch CSV")
    parser.add_argument("--out-manual-csv", help="Optional path for manual-confirmation CSV")
    parser.add_argument("--out-no-safe-csv", help="Optional path for likely-no-safe-alias CSV")
    args = parser.parse_args()

    payload = load_payload(Path(args.workbench_json).expanduser().resolve())
    workbench_rows = payload.get("rows") or []
    apply_rows, manual_rows, no_safe_rows = classify_rows(workbench_rows)

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
    triage_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "canonical_display_name",
        "ingredient_family",
        "suggested_aliases_common",
        "suggested_alias_quality",
        "resolution_rationale",
        "suggested_resolution",
    ]

    apply_path = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(apply_path, apply_rows, apply_fieldnames)

    manual_path = None
    if args.out_manual_csv:
        manual_path = Path(args.out_manual_csv).expanduser().resolve()
        write_csv(manual_path, manual_rows, triage_fieldnames)

    no_safe_path = None
    if args.out_no_safe_csv:
        no_safe_path = Path(args.out_no_safe_csv).expanduser().resolve()
        write_csv(no_safe_path, no_safe_rows, triage_fieldnames)

    print(
        json.dumps(
            {
                "workbench_json": str(Path(args.workbench_json).expanduser().resolve()),
                "apply_ready_count": len(apply_rows),
                "manual_confirmation_count": len(manual_rows),
                "likely_no_safe_count": len(no_safe_rows),
                "out_apply_csv": str(apply_path),
                "out_manual_csv": str(manual_path) if manual_path else None,
                "out_no_safe_csv": str(no_safe_path) if no_safe_path else None,
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
