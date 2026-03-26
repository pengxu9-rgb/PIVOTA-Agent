#!/usr/bin/env python3
"""Compare two ingredient reference review queue runs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def get_reason_count(data: dict[str, Any], reason: str) -> int:
    return int(data.get("top_reason_counts", {}).get(reason, 0))


def get_priority_count(data: dict[str, Any], priority: str) -> int:
    return int(data.get("priority_counts", {}).get(priority, 0))


def get_column_fill(data: dict[str, Any], column: str) -> dict[str, Any]:
    return dict(data.get("column_fill", {}).get(column, {}))


def build_delta(before: int, after: int) -> dict[str, int]:
    return {
        "before": before,
        "after": after,
        "delta": after - before,
        "reduced_by": before - after,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-json", required=True)
    parser.add_argument("--after-json", required=True)
    parser.add_argument("--out-json", required=True)
    args = parser.parse_args()

    before = load_json(Path(args.before_json))
    after = load_json(Path(args.after_json))

    tracked_columns = [
        "aliases_common",
        "alias_quality",
        "notes_for_parser",
        "cross_market_notes",
        "review_status",
        "confidence",
    ]
    tracked_reasons = [
        "missing_aliases_common",
        "missing_alias_quality",
        "missing_notes_for_parser",
        "ingredient_family_other_review",
        "review_status_still_draft",
        "confidence_medium",
    ]
    tracked_priorities = ["p1", "p2", "p3"]

    column_fill_deltas: dict[str, Any] = {}
    for column in tracked_columns:
        before_fill = get_column_fill(before, column)
        after_fill = get_column_fill(after, column)
        column_fill_deltas[column] = {
            "filled_count": build_delta(
                int(before_fill.get("filled_count", 0)),
                int(after_fill.get("filled_count", 0)),
            ),
            "missing_count": build_delta(
                int(before_fill.get("missing_count", 0)),
                int(after_fill.get("missing_count", 0)),
            ),
            "fill_rate": {
                "before": float(before_fill.get("fill_rate", 0.0)),
                "after": float(after_fill.get("fill_rate", 0.0)),
                "delta": float(after_fill.get("fill_rate", 0.0))
                - float(before_fill.get("fill_rate", 0.0)),
            },
        }

    reason_deltas = {
        reason: build_delta(get_reason_count(before, reason), get_reason_count(after, reason))
        for reason in tracked_reasons
    }
    priority_deltas = {
        priority: build_delta(
            get_priority_count(before, priority), get_priority_count(after, priority)
        )
        for priority in tracked_priorities
    }

    summary = {
        "before_json": str(Path(args.before_json).resolve()),
        "after_json": str(Path(args.after_json).resolve()),
        "row_count_before": int(before.get("row_count", 0)),
        "row_count_after": int(after.get("row_count", 0)),
        "column_fill_deltas": column_fill_deltas,
        "reason_deltas": reason_deltas,
        "priority_deltas": priority_deltas,
        "next_focus_after": {
            "top_reason_counts": after.get("top_reason_counts", {}),
            "priority_counts": after.get("priority_counts", {}),
        },
    }

    out_path = Path(args.out_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps(summary, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
