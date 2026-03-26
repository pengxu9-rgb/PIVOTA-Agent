#!/usr/bin/env python3
"""Propose a small curated alias overlay for remaining ingredient alias gaps."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


CURATED_ALIAS_MAP: dict[str, dict[str, str]] = {
    "Benzisothiazolinone": {
        "patch_aliases_common": "BIT",
        "patch_alias_quality": "common_alias",
        "quality_reason": "curated_common_shorthand",
    },
    "Cinnamal": {
        "patch_aliases_common": "Cinnamaldehyde",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_exact_chemical_synonym",
    },
    "Dioxybenzone": {
        "patch_aliases_common": "Benzophenone-8",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_legacy_label_synonym",
    },
    "Ethylhexylglycerin": {
        "patch_aliases_common": "Octoxyglycerin",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_legacy_trade_synonym",
    },
    "Gluconolactone": {
        "patch_aliases_common": "Glucono-Delta-Lactone",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_exact_chemical_synonym",
    },
    "Homosalate": {
        "patch_aliases_common": "Homomenthyl Salicylate",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_legacy_label_synonym",
    },
    "Methylchloroisothiazolinone": {
        "patch_aliases_common": "MCI",
        "patch_alias_quality": "common_alias",
        "quality_reason": "curated_common_shorthand",
    },
    "Methylisothiazolinone": {
        "patch_aliases_common": "MI",
        "patch_alias_quality": "common_alias",
        "quality_reason": "curated_common_shorthand",
    },
    "Retinol": {
        "patch_aliases_common": "Vitamin A",
        "patch_alias_quality": "common_alias",
        "quality_reason": "curated_consumer_common_name",
    },
    "Urea": {
        "patch_aliases_common": "Carbamide",
        "patch_alias_quality": "legacy_alias",
        "quality_reason": "curated_exact_chemical_synonym",
    },
}


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
    parser = argparse.ArgumentParser(description="Propose a curated alias overlay for remaining ingredient alias gaps.")
    parser.add_argument("--alias-gap-csv", required=True, help="CSV of remaining alias-gap rows")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the curated apply-ready patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for rows not matched by the curated map")
    parser.add_argument("--out-json", help="Optional path for a JSON summary")
    args = parser.parse_args()

    gap_path = Path(args.alias_gap_csv).expanduser().resolve()
    rows = load_rows(gap_path)

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        canonical = normalize_text(row.get("canonical_inci_name"))
        curated = CURATED_ALIAS_MAP.get(canonical)
        if not curated:
            remainder_rows.append(row)
            continue
        apply_rows.append(
            {
                "record_id": normalize_text(row.get("record_id")),
                "canonical_inci_name": canonical,
                "existing_aliases_common": "",
                "existing_alias_quality": "",
                "patch_aliases_common": curated["patch_aliases_common"],
                "patch_alias_quality": curated["patch_alias_quality"],
                "proposal_sources": "curated_alias_overlay",
                "quality_reason": curated["quality_reason"],
            }
        )

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
    remainder_fieldnames = list(rows[0].keys()) if rows else []

    out_apply_csv = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(out_apply_csv, apply_rows, apply_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    payload = {
        "source_alias_gap_csv": str(gap_path),
        "curated_map_size": len(CURATED_ALIAS_MAP),
        "apply_ready_count": len(apply_rows),
        "remainder_count": len(remainder_rows),
        "matched_canonical_names": [row["canonical_inci_name"] for row in apply_rows],
        "out_apply_csv": str(out_apply_csv),
        "out_remainder_csv": str(remainder_path) if remainder_path else None,
    }

    if args.out_json:
        out_json = Path(args.out_json).expanduser().resolve()
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(payload, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
