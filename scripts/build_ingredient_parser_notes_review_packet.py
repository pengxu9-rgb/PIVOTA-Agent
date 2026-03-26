#!/usr/bin/env python3
"""Build a decision-ready packet for parser-note proposals requiring review."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def load_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def should_include(row: dict[str, Any], include_confidences: set[str]) -> bool:
    confidence = normalize_text(row.get("proposal_confidence")).lower()
    return confidence in include_confidences


def build_rows(rows: list[dict[str, Any]], include_confidences: set[str]) -> list[dict[str, str]]:
    packet_rows: list[dict[str, str]] = []
    for row in rows:
        if not should_include(row, include_confidences):
            continue
        packet_rows.append(
            {
                "record_id": normalize_text(row.get("record_id")),
                "canonical_inci_name": normalize_text(row.get("canonical_inci_name")),
                "canonical_display_name": normalize_text(row.get("canonical_display_name")),
                "ingredient_family": normalize_text(row.get("ingredient_family")),
                "existing_notes_for_parser": normalize_text(row.get("existing_notes_for_parser")),
                "suggested_notes_for_parser": normalize_text(row.get("suggested_notes_for_parser")),
                "proposal_template": normalize_text(row.get("proposal_template")),
                "proposal_confidence": normalize_text(row.get("proposal_confidence")),
                "proposal_reasons": normalize_text(row.get("proposal_reasons")),
                "decision": "",
                "approved_notes_for_parser": normalize_text(row.get("suggested_notes_for_parser")),
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
    parser = argparse.ArgumentParser(description="Build a decision-ready packet for parser-note proposals requiring review.")
    parser.add_argument("--proposal-json", required=True, help="Parser-note proposal JSON")
    parser.add_argument("--out-csv", required=True, help="Where to write the review packet CSV")
    parser.add_argument("--out-json", help="Optional path for JSON packet output")
    parser.add_argument(
        "--include-confidence",
        action="append",
        default=["medium"],
        help="Proposal confidence levels to include. May be passed multiple times. Defaults to medium.",
    )
    args = parser.parse_args()

    proposal_path = Path(args.proposal_json).expanduser().resolve()
    payload = load_payload(proposal_path)
    proposals = payload.get("proposals") or []
    include_confidences = {normalize_text(value).lower() for value in args.include_confidence if normalize_text(value)}
    rows = build_rows(proposals, include_confidences)

    fieldnames = [
        "record_id",
        "canonical_inci_name",
        "canonical_display_name",
        "ingredient_family",
        "existing_notes_for_parser",
        "suggested_notes_for_parser",
        "proposal_template",
        "proposal_confidence",
        "proposal_reasons",
        "decision",
        "approved_notes_for_parser",
        "reviewer_notes",
    ]

    out_csv = Path(args.out_csv).expanduser().resolve()
    write_csv(out_csv, rows, fieldnames)

    out_json = None
    if args.out_json:
        out_json = Path(args.out_json).expanduser().resolve()
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(
            json.dumps(
                {
                    "source_proposal_json": str(proposal_path),
                    "include_confidences": sorted(include_confidences),
                    "decision_values": [
                        "approve_suggestion",
                        "approve_override",
                        "reject_no_note",
                        "needs_research",
                    ],
                    "row_count": len(rows),
                    "rows": rows,
                },
                ensure_ascii=True,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        json.dumps(
            {
                "source_proposal_json": str(proposal_path),
                "include_confidences": sorted(include_confidences),
                "row_count": len(rows),
                "out_csv": str(out_csv),
                "out_json": str(out_json) if out_json else None,
                "decision_values": [
                    "approve_suggestion",
                    "approve_override",
                    "reject_no_note",
                    "needs_research",
                ],
            },
            ensure_ascii=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
