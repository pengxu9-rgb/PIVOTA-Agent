#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Iterable, List, Tuple


def read_ndjson(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
    return out


def as_float(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    return v


def avg(values: Iterable[float]) -> float:
    vals = [v for v in values]
    if not vals:
        return 0.0
    return round(float(mean(vals)), 3)


def summarize(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_group: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)
    by_type_group: Dict[Tuple[str, str, str, str], List[Dict[str, Any]]] = defaultdict(list)

    for sample in samples:
        quality = str(sample.get("quality_grade") or "unknown")
        skin_tone = str(sample.get("skin_tone_bucket") or "unknown")
        lighting = str(sample.get("lighting_bucket") or "unknown")
        group_key = (quality, skin_tone, lighting)
        by_group[group_key].append(sample)

        by_type = sample.get("metrics", {}).get("by_type", [])
        if not isinstance(by_type, list):
            continue
        for item in by_type:
            if not isinstance(item, dict):
                continue
            concern_type = str(item.get("type") or "other")
            by_type_group[(concern_type, quality, skin_tone, lighting)].append(item)

    grouped_rows = []
    for (quality, skin_tone, lighting), rows in sorted(by_group.items()):
        overall = [as_float(r.get("metrics", {}).get("overall")) for r in rows]
        iou_vals = [as_float(r.get("metrics", {}).get("region_level", {}).get("mean_iou")) for r in rows]
        jaccard_vals = [as_float(r.get("metrics", {}).get("type_level", {}).get("jaccard")) for r in rows]
        f1_vals = [as_float(r.get("metrics", {}).get("type_level", {}).get("weighted_f1")) for r in rows]
        sev_mae_vals = [as_float(r.get("metrics", {}).get("severity_level", {}).get("mae")) for r in rows]
        overlap_vals = [as_float(r.get("metrics", {}).get("severity_level", {}).get("interval_overlap")) for r in rows]

        grouped_rows.append(
            {
                "quality_grade": quality,
                "skin_tone_bucket": skin_tone,
                "lighting_bucket": lighting,
                "samples": len(rows),
                "overall_agreement_avg": avg([v for v in overall if v is not None]),
                "type_jaccard_avg": avg([v for v in jaccard_vals if v is not None]),
                "type_weighted_f1_avg": avg([v for v in f1_vals if v is not None]),
                "region_iou_avg": avg([v for v in iou_vals if v is not None]),
                "severity_mae_avg": avg([v for v in sev_mae_vals if v is not None]),
                "severity_interval_overlap_avg": avg([v for v in overlap_vals if v is not None]),
                "pseudo_label_eligible_rate": avg(
                    [1.0 if r.get("pseudo_label_eligible") else 0.0 for r in rows]
                ),
                "pseudo_label_emitted_rate": avg(
                    [1.0 if r.get("pseudo_label_emitted") else 0.0 for r in rows]
                ),
            }
        )

    by_type_rows = []
    for (concern_type, quality, skin_tone, lighting), rows in sorted(by_type_group.items()):
        iou_vals = [as_float(r.get("iou")) for r in rows]
        corr_vals = [as_float(r.get("heatmap_correlation")) for r in rows]
        kl_vals = [as_float(r.get("heatmap_kl")) for r in rows]
        sev_mae_vals = [as_float(r.get("severity_mae")) for r in rows]
        overlap_vals = [as_float(r.get("interval_overlap")) for r in rows]
        by_type_rows.append(
            {
                "type": concern_type,
                "quality_grade": quality,
                "skin_tone_bucket": skin_tone,
                "lighting_bucket": lighting,
                "samples": len(rows),
                "iou_avg": avg([v for v in iou_vals if v is not None]),
                "heatmap_correlation_avg": avg([v for v in corr_vals if v is not None]),
                "heatmap_kl_avg": avg([v for v in kl_vals if v is not None]),
                "severity_mae_avg": avg([v for v in sev_mae_vals if v is not None]),
                "interval_overlap_avg": avg([v for v in overlap_vals if v is not None]),
            }
        )

    overall = {
        "samples": len(samples),
        "overall_agreement_avg": avg(
            [as_float(s.get("metrics", {}).get("overall")) for s in samples if as_float(s.get("metrics", {}).get("overall")) is not None]
        ),
        "pseudo_label_eligible_rate": avg([1.0 if s.get("pseudo_label_eligible") else 0.0 for s in samples]),
        "pseudo_label_emitted_rate": avg([1.0 if s.get("pseudo_label_emitted") else 0.0 for s in samples]),
    }

    return {
        "overall": overall,
        "grouped": grouped_rows,
        "by_type_grouped": by_type_rows,
    }


def render_markdown(summary: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Diagnosis Agreement Report")
    lines.append("")
    lines.append("## Overall")
    lines.append("")
    overall = summary.get("overall", {})
    lines.append(f"- Samples: {overall.get('samples', 0)}")
    lines.append(f"- Avg agreement: {overall.get('overall_agreement_avg', 0)}")
    lines.append(f"- Pseudo-label eligible rate: {overall.get('pseudo_label_eligible_rate', 0)}")
    lines.append(f"- Pseudo-label emitted rate: {overall.get('pseudo_label_emitted_rate', 0)}")
    lines.append("")
    lines.append("## By Quality / Skin Tone / Lighting")
    lines.append("")
    lines.append(
        "| quality | skin_tone | lighting | samples | agreement | type_f1 | region_iou | severity_mae | overlap | emit_rate |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in summary.get("grouped", []):
        lines.append(
            "| {quality_grade} | {skin_tone_bucket} | {lighting_bucket} | {samples} | {overall_agreement_avg} | {type_weighted_f1_avg} | {region_iou_avg} | {severity_mae_avg} | {severity_interval_overlap_avg} | {pseudo_label_emitted_rate} |".format(
                **row
            )
        )
    lines.append("")
    lines.append("## By Type")
    lines.append("")
    lines.append("| type | quality | skin_tone | lighting | samples | iou | heat_corr | heat_kl | sev_mae | overlap |")
    lines.append("|---|---|---|---|---:|---:|---:|---:|---:|---:|")
    for row in summary.get("by_type_grouped", []):
        lines.append(
            "| {type} | {quality_grade} | {skin_tone_bucket} | {lighting_bucket} | {samples} | {iou_avg} | {heatmap_correlation_avg} | {heatmap_kl_avg} | {severity_mae_avg} | {interval_overlap_avg} |".format(
                **row
            )
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate pseudo-label agreement report.")
    parser.add_argument("--store-dir", default="", help="Directory containing model_outputs/pseudo_labels/agreement_samples ndjson files.")
    parser.add_argument("--out-md", default="", help="Output markdown path.")
    parser.add_argument("--out-json", default="", help="Output JSON path.")
    args = parser.parse_args()

    base_dir = Path(args.store_dir.strip() or Path.cwd() / "tmp" / "diag_pseudo_label_factory")
    agreement_path = base_dir / "agreement_samples.ndjson"
    model_output_path = base_dir / "model_outputs.ndjson"
    pseudo_label_path = base_dir / "pseudo_labels.ndjson"

    agreement_samples = read_ndjson(agreement_path)
    model_outputs = read_ndjson(model_output_path)
    pseudo_labels = read_ndjson(pseudo_label_path)

    summary = summarize(agreement_samples)
    payload = {
        "store_dir": str(base_dir),
        "files": {
            "agreement_samples": str(agreement_path),
            "model_outputs": str(model_output_path),
            "pseudo_labels": str(pseudo_label_path),
        },
        "counts": {
            "agreement_samples": len(agreement_samples),
            "model_outputs": len(model_outputs),
            "pseudo_labels": len(pseudo_labels),
        },
        "summary": summary,
    }

    out_md = Path(args.out_md.strip()) if args.out_md.strip() else base_dir / "agreement_report.md"
    out_json = Path(args.out_json.strip()) if args.out_json.strip() else base_dir / "agreement_report.json"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.parent.mkdir(parents=True, exist_ok=True)

    out_md.write_text(render_markdown(summary), encoding="utf-8")
    out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote markdown: {out_md}")
    print(f"wrote json: {out_json}")
    print(json.dumps(payload["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
