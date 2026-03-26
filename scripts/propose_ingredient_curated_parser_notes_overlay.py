#!/usr/bin/env python3
"""Propose a small curated parser-notes overlay for the remaining note gaps."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


CURATED_NOTES_MAP: dict[str, dict[str, str]] = {
    "Alpha-Arbutin": {
        "patch_notes_for_parser": "Contains common alpha-/arbutin shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Alpha-Isomethyl Ionone": {
        "patch_notes_for_parser": "Fragrance allergen naming may vary in prefix and hyphen formatting; preserve full canonical token matching.",
        "proposal_template": "curated_prefix_sensitive",
        "proposal_reasons": "curated_prefix_and_hyphen_variation",
    },
    "Ascorbic Acid": {
        "patch_notes_for_parser": "Contains common vitamin-C shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Beta-Glucan": {
        "patch_notes_for_parser": "PDP naming may vary hyphenation or spacing for beta-glucan; preserve canonical token matching.",
        "proposal_template": "curated_separator_sensitive",
        "proposal_reasons": "curated_hyphenation_variation",
    },
    "Caprylic/Capric Triglyceride": {
        "patch_notes_for_parser": "Preserve slash-separated lipid tokens during parsing; PDPs may shorten one side or drop separators.",
        "proposal_template": "curated_separator_sensitive",
        "proposal_reasons": "curated_slash_variation",
    },
    "Cocamidopropyl Betaine": {
        "patch_notes_for_parser": "Contains well-known surfactant shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Coco-Caprylate/Caprate": {
        "patch_notes_for_parser": "Preserve slash-separated ester naming during parsing; PDPs may vary separator formatting.",
        "proposal_template": "curated_separator_sensitive",
        "proposal_reasons": "curated_slash_variation",
    },
    "Glycerin": {
        "patch_notes_for_parser": "Contains common humectant shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Hyaluronic Acid": {
        "patch_notes_for_parser": "Contains common HA shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Maris Aqua": {
        "patch_notes_for_parser": "Marine water naming may vary between Latin and common-language forms on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_market_label_variation",
        "proposal_reasons": "curated_common_label_variation",
    },
    "N-Acetyl Glucosamine": {
        "patch_notes_for_parser": "Preserve N- prefixes and acetylated naming; PDPs may use NAG shorthand.",
        "proposal_template": "curated_prefix_sensitive",
        "proposal_reasons": "curated_prefix_and_shorthand_variation",
    },
    "Niacinamide": {
        "patch_notes_for_parser": "Contains common vitamin-B3 shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Panthenol": {
        "patch_notes_for_parser": "Contains common provitamin-B5 shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "p-Anisic Acid": {
        "patch_notes_for_parser": "Preserve positional prefixes like p- during parsing; PDPs may expand to para-Anisic Acid.",
        "proposal_template": "curated_prefix_sensitive",
        "proposal_reasons": "curated_prefix_variation",
    },
    "Sodium Hyaluronate": {
        "patch_notes_for_parser": "Contains common sodium-hyaluronate or hyaluronate shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Sodium Lauryl Sulfate": {
        "patch_notes_for_parser": "Contains common SLS shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Tocopherol": {
        "patch_notes_for_parser": "Contains common vitamin-E shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
    },
    "Tris-Biphenyl Triazine": {
        "patch_notes_for_parser": "Sunscreen filter naming may vary between INCI and trade shorthand on PDPs; prefer canonical INCI match when available.",
        "proposal_template": "curated_marketing_shorthand",
        "proposal_reasons": "curated_common_shorthand",
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
    parser = argparse.ArgumentParser(description="Propose a curated parser-notes overlay for remaining note gaps.")
    parser.add_argument("--parser-gap-csv", required=True, help="CSV of remaining parser-note gap rows")
    parser.add_argument("--out-apply-csv", required=True, help="Where to write the apply-ready patch CSV")
    parser.add_argument("--out-remainder-csv", help="Optional path for unmatched remainder rows")
    parser.add_argument("--out-json", help="Optional path for a JSON summary")
    args = parser.parse_args()

    gap_path = Path(args.parser_gap_csv).expanduser().resolve()
    rows = load_rows(gap_path)

    apply_rows: list[dict[str, str]] = []
    remainder_rows: list[dict[str, str]] = []

    for row in rows:
        canonical = normalize_text(row.get("canonical_inci_name"))
        curated = CURATED_NOTES_MAP.get(canonical)
        if not curated:
            remainder_rows.append(row)
            continue
        apply_rows.append(
            {
                "record_id": normalize_text(row.get("record_id")),
                "canonical_inci_name": canonical,
                "existing_notes_for_parser": "",
                "patch_notes_for_parser": curated["patch_notes_for_parser"],
                "proposal_template": curated["proposal_template"],
                "proposal_reasons": curated["proposal_reasons"],
            }
        )

    apply_fieldnames = [
        "record_id",
        "canonical_inci_name",
        "existing_notes_for_parser",
        "patch_notes_for_parser",
        "proposal_template",
        "proposal_reasons",
    ]
    remainder_fieldnames = list(rows[0].keys()) if rows else []

    out_apply_csv = Path(args.out_apply_csv).expanduser().resolve()
    write_csv(out_apply_csv, apply_rows, apply_fieldnames)

    remainder_path = None
    if args.out_remainder_csv:
        remainder_path = Path(args.out_remainder_csv).expanduser().resolve()
        write_csv(remainder_path, remainder_rows, remainder_fieldnames)

    payload = {
        "source_parser_gap_csv": str(gap_path),
        "curated_map_size": len(CURATED_NOTES_MAP),
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
