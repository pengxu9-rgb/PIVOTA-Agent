#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def normalize_token(value: Any) -> str:
    return str("" if value is None else value).strip().lower()


def normalize_bucket(value: Any, fallback: str = "unknown") -> str:
    token = normalize_token(value)
    return token if token else fallback


def clamp(value: Any, min_value: float, max_value: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return min_value
    return max(min_value, min(max_value, numeric))


def clamp01(value: Any) -> float:
    return clamp(value, 0.0, 1.0)


def as_bool(value: Any, fallback: bool = False) -> bool:
    token = normalize_token(value)
    if not token:
        return fallback
    if token in {"1", "true", "yes", "on", "y"}:
        return True
    if token in {"0", "false", "no", "off", "n"}:
        return False
    return fallback


def round3(value: float) -> float:
    return float(f"{value:.3f}")


def normalize_concern_type(raw_type: Any) -> str:
    token = normalize_token(raw_type)
    aliases = {
        "redness": "redness",
        "irritation": "redness",
        "erythema": "redness",
        "acne": "acne",
        "breakout": "acne",
        "breakouts": "acne",
        "pimple": "acne",
        "shine": "shine",
        "oiliness": "shine",
        "sebum": "shine",
        "texture": "texture",
        "pores": "texture",
        "roughness": "texture",
        "tone": "tone",
        "dark_spots": "tone",
        "hyperpigmentation": "tone",
        "dryness": "dryness",
        "dehydration": "dryness",
        "barrier": "barrier",
        "barrier_stress": "barrier",
        "sensitivity": "barrier",
    }
    return aliases.get(token, "other")


def normalize_bbox(raw: Any) -> Optional[Dict[str, float]]:
    if not isinstance(raw, dict):
        return None
    x0 = clamp01(raw.get("x0"))
    y0 = clamp01(raw.get("y0"))
    x1 = clamp01(raw.get("x1"))
    y1 = clamp01(raw.get("y1"))
    min_x = min(x0, x1)
    min_y = min(y0, y1)
    max_x = max(x0, x1)
    max_y = max(y0, y1)
    if max_x - min_x <= 0.001 or max_y - min_y <= 0.001:
        return None
    return {
        "x0": round3(min_x),
        "y0": round3(min_y),
        "x1": round3(max_x),
        "y1": round3(max_y),
    }


def bbox_from_polygon(points: Any) -> Optional[Dict[str, float]]:
    if not isinstance(points, list) or len(points) < 3:
        return None
    min_x, min_y, max_x, max_y = 1.0, 1.0, 0.0, 0.0
    valid = False
    for point in points:
        if not isinstance(point, dict):
            continue
        x = clamp01(point.get("x"))
        y = clamp01(point.get("y"))
        min_x = min(min_x, x)
        min_y = min(min_y, y)
        max_x = max(max_x, x)
        max_y = max(max_y, y)
        valid = True
    if not valid:
        return None
    return normalize_bbox({"x0": min_x, "y0": min_y, "x1": max_x, "y1": max_y})


def bbox_from_heatmap(region: Dict[str, Any]) -> Optional[Dict[str, float]]:
    rows = max(1, min(64, int(float(region.get("rows", 0) or 0))))
    cols = max(1, min(64, int(float(region.get("cols", 0) or 0))))
    values = region.get("values")
    if not isinstance(values, list) or len(values) != rows * cols:
        return None
    normalized = [clamp01(v) for v in values]
    peak = max(normalized) if normalized else 0.0
    if peak <= 1e-4:
        return None
    threshold = peak * 0.35
    min_row, min_col, max_row, max_col = rows, cols, -1, -1
    for row in range(rows):
        for col in range(cols):
            if normalized[row * cols + col] < threshold:
                continue
            min_row = min(min_row, row)
            min_col = min(min_col, col)
            max_row = max(max_row, row)
            max_col = max(max_col, col)
    if max_row < 0 or max_col < 0:
        return None
    return normalize_bbox({
        "x0": min_col / cols,
        "y0": min_row / rows,
        "x1": (max_col + 1) / cols,
        "y1": (max_row + 1) / rows,
    })


def extract_primary_bbox(concern: Dict[str, Any]) -> Optional[Dict[str, float]]:
    regions = concern.get("regions")
    if not isinstance(regions, list):
        return None
    for region in regions:
        if not isinstance(region, dict):
            continue
        kind = normalize_token(region.get("kind"))
        if kind == "bbox":
            bbox = normalize_bbox(region.get("bbox_norm"))
            if bbox:
                return bbox
        elif kind == "polygon":
            bbox = bbox_from_polygon(region.get("points"))
            if bbox:
                return bbox
        elif kind == "heatmap":
            bbox = bbox_from_heatmap(region)
            if bbox:
                return bbox
    return None


def iou(a: Optional[Dict[str, float]], b: Optional[Dict[str, float]]) -> float:
    if not a or not b:
        return 0.0
    x0 = max(a["x0"], b["x0"])
    y0 = max(a["y0"], b["y0"])
    x1 = min(a["x1"], b["x1"])
    y1 = min(a["y1"], b["y1"])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a["x1"] - a["x0"]) * max(0.0, a["y1"] - a["y0"])
    area_b = max(0.0, b["x1"] - b["x0"]) * max(0.0, b["y1"] - b["y0"])
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


@dataclass
class NormalizedConcern:
    type: str
    confidence: float
    bbox: Optional[Dict[str, float]]


def normalize_concerns(raw: Any) -> List[NormalizedConcern]:
    concerns = raw if isinstance(raw, list) else []
    out: List[NormalizedConcern] = []
    for concern in concerns:
        if not isinstance(concern, dict):
            continue
        out.append(
            NormalizedConcern(
                type=normalize_concern_type(concern.get("type")),
                confidence=round3(clamp01(concern.get("confidence"))),
                bbox=extract_primary_bbox(concern),
            )
        )
    return out


def greedy_match(preds: List[NormalizedConcern], golds: List[NormalizedConcern], iou_threshold: float) -> Dict[int, int]:
    matched_gold: set[int] = set()
    mapping: Dict[int, int] = {}
    for p_idx, pred in enumerate(preds):
        best = -1
        best_iou = 0.0
        for g_idx, gold in enumerate(golds):
            if g_idx in matched_gold:
                continue
            if pred.type != gold.type:
                continue
            overlap = iou(pred.bbox, gold.bbox)
            if overlap >= iou_threshold and overlap > best_iou:
                best = g_idx
                best_iou = overlap
        if best >= 0:
            matched_gold.add(best)
            mapping[p_idx] = best
    return mapping


def read_ndjson(file_path: Path) -> List[Dict[str, Any]]:
    if not file_path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rows.append(parsed)
    return rows


def load_gold_by_inference(gold_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for row in gold_rows:
        qa_status = normalize_token(row.get("qa_status") or row.get("status") or row.get("label_status") or "approved")
        if qa_status not in {"approved", "gold", "accepted"}:
            continue
        inference_id = str(row.get("inference_id") or row.get("inferenceId") or row.get("trace_id") or "").strip()
        if not inference_id:
            continue
        out[inference_id] = row
    return out


def normalize_quality_features(record: Dict[str, Any], gold: Dict[str, Any]) -> Dict[str, Any]:
    quality = {}
    if isinstance(record.get("quality_features"), dict):
        quality.update(record["quality_features"])
    if isinstance(record.get("output_json"), dict) and isinstance(record["output_json"].get("quality_features"), dict):
        quality.update(record["output_json"]["quality_features"])
    if isinstance(record.get("metadata"), dict) and isinstance(record["metadata"].get("quality_features"), dict):
        quality.update(record["metadata"]["quality_features"])
    if isinstance(gold.get("quality_features"), dict):
        quality.update(gold["quality_features"])
    if isinstance(gold.get("metadata"), dict) and isinstance(gold["metadata"].get("quality_features"), dict):
        quality.update(gold["metadata"]["quality_features"])
    return {
        "exposure_score": round3(clamp01(quality.get("exposure_score", quality.get("exposure", quality.get("brightness_score", 0.0))))),
        "reflection_score": round3(clamp01(quality.get("reflection_score", quality.get("glare_score", quality.get("specular_score", 0.0))))),
        "filter_score": round3(clamp01(quality.get("filter_score", quality.get("filter_probability", quality.get("synthetic_filter_score", 0.0))))),
        "makeup_detected": as_bool(quality.get("makeup_detected", quality.get("has_makeup", False))),
        "filter_detected": as_bool(quality.get("filter_detected", quality.get("has_filter", False))),
    }


def build_rows(model_outputs: List[Dict[str, Any]], gold_rows: List[Dict[str, Any]], iou_threshold: float) -> List[Dict[str, Any]]:
    gold_by_inf = load_gold_by_inference(gold_rows)
    rows: List[Dict[str, Any]] = []
    for record in model_outputs:
        inference_id = str(record.get("inference_id") or record.get("inferenceId") or "").strip()
        if not inference_id:
            continue
        gold = gold_by_inf.get(inference_id)
        if not gold:
            continue
        provider = normalize_bucket(record.get("provider"), "unknown_provider")
        quality_grade = normalize_bucket(record.get("quality_grade") or gold.get("quality_grade"), "unknown")
        tone_bucket = normalize_bucket(record.get("skin_tone_bucket") or gold.get("skin_tone_bucket"), "unknown")
        lighting_bucket = normalize_bucket(record.get("lighting_bucket") or gold.get("lighting_bucket"), "unknown")
        region_bucket = normalize_bucket(
            record.get("region_bucket")
            or (gold.get("metadata", {}).get("region") if isinstance(gold.get("metadata"), dict) else None)
            or (gold.get("metadata", {}).get("country") if isinstance(gold.get("metadata"), dict) else None)
            or gold.get("region_bucket"),
            "unknown",
        )
        quality = normalize_quality_features(record, gold)

        concerns_raw = []
        if isinstance(record.get("output_json"), dict) and isinstance(record["output_json"].get("concerns"), list):
            concerns_raw = record["output_json"]["concerns"]
        elif isinstance(record.get("concerns"), list):
            concerns_raw = record["concerns"]
        preds = normalize_concerns(concerns_raw)

        gold_concerns_raw = []
        if isinstance(gold.get("concerns"), list):
            gold_concerns_raw = gold["concerns"]
        elif isinstance(gold.get("canonical"), dict) and isinstance(gold["canonical"].get("concerns"), list):
            gold_concerns_raw = gold["canonical"]["concerns"]
        elif isinstance(gold.get("output_json"), dict) and isinstance(gold["output_json"].get("concerns"), list):
            gold_concerns_raw = gold["output_json"]["concerns"]
        gold_concerns = normalize_concerns(gold_concerns_raw)

        matched = greedy_match(preds, gold_concerns, iou_threshold)
        for idx, pred in enumerate(preds):
            rows.append({
                "inference_id": inference_id,
                "provider": provider,
                "type": pred.type,
                "quality_grade": quality_grade,
                "tone_bucket": tone_bucket,
                "lighting_bucket": lighting_bucket,
                "region_bucket": region_bucket,
                "raw_confidence": pred.confidence,
                "label": 1 if idx in matched else 0,
                **quality,
            })
    return rows


def predict_isotonic(calibrator: Optional[Dict[str, Any]], raw_confidence: float) -> float:
    safe_raw = clamp01(raw_confidence)
    if not isinstance(calibrator, dict):
        return safe_raw
    xs = calibrator.get("x")
    ys = calibrator.get("y")
    if not isinstance(xs, list) or not isinstance(ys, list) or len(xs) != len(ys) or not xs:
        return safe_raw
    for x_val, y_val in zip(xs, ys):
        if safe_raw <= float(x_val):
            return clamp01(y_val)
    return clamp01(ys[-1])


def resolve_calibrator(model: Dict[str, Any], row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    provider = normalize_bucket(row.get("provider"), "unknown_provider")
    quality = normalize_bucket(row.get("quality_grade"), "unknown")
    tone = normalize_bucket(row.get("tone_bucket"), "unknown")
    lighting = normalize_bucket(row.get("lighting_bucket"), "unknown")
    makeup = "mk1" if row.get("makeup_detected") else "mk0"
    filt = "ft1" if row.get("filter_detected") else "ft0"
    by_group = model.get("calibration", {}).get("by_group", {})
    by_provider = model.get("calibration", {}).get("by_provider", {})
    candidates = [
        f"{provider}|{quality}|{tone}|{lighting}|{makeup}|{filt}",
        f"{provider}|{quality}|{tone}|{lighting}",
        f"{provider}|{quality}|{tone}",
        f"{provider}|{quality}",
    ]
    for key in candidates:
        if isinstance(by_group, dict) and key in by_group:
            return by_group[key]
    if isinstance(by_provider, dict) and provider in by_provider:
        return by_provider[provider]
    return model.get("calibration", {}).get("global")


def apply_quality_adjustment(value: float, row: Dict[str, Any]) -> float:
    exposure = clamp01(row.get("exposure_score"))
    reflection = clamp01(row.get("reflection_score"))
    filter_score = clamp01(row.get("filter_score"))
    factor = 1.0
    factor += (exposure - 0.5) * 0.1
    factor -= reflection * 0.12
    factor -= filter_score * 0.16
    if row.get("makeup_detected"):
        factor -= 0.05
    if row.get("filter_detected"):
        factor -= 0.06
    factor = clamp(factor, 0.55, 1.12)
    return clamp01(value * factor)


def calibrate(model: Dict[str, Any], row: Dict[str, Any]) -> float:
    if not isinstance(model, dict) or model.get("schema_version") != "aurora.diag.calibration_model.v1":
        return round3(clamp01(row.get("raw_confidence")))
    calibrator = resolve_calibrator(model, row)
    iso = predict_isotonic(calibrator, clamp01(row.get("raw_confidence")))
    adjusted = apply_quality_adjustment(iso, row)
    return round3(adjusted)


def compute_brier(rows: List[Dict[str, Any]], field: str) -> float:
    if not rows:
        return 0.0
    total = 0.0
    for row in rows:
        p = clamp01(row.get(field))
        y = clamp01(row.get("label"))
        total += (p - y) ** 2
    return round3(total / len(rows))


def compute_ece(rows: List[Dict[str, Any]], field: str, bins: int = 10) -> float:
    if not rows:
        return 0.0
    buckets = [{"n": 0, "conf": 0.0, "acc": 0.0} for _ in range(max(2, int(bins)))]
    for row in rows:
        p = clamp01(row.get(field))
        y = clamp01(row.get("label"))
        idx = min(len(buckets) - 1, int(p * len(buckets)))
        bucket = buckets[idx]
        bucket["n"] += 1
        bucket["conf"] += p
        bucket["acc"] += y
    ece = 0.0
    total = float(len(rows))
    for bucket in buckets:
        if not bucket["n"]:
            continue
        mean_conf = bucket["conf"] / bucket["n"]
        mean_acc = bucket["acc"] / bucket["n"]
        ece += (bucket["n"] / total) * abs(mean_conf - mean_acc)
    return round3(ece)


def grouped_ece(rows: List[Dict[str, Any]], field: str, group_key: str) -> Dict[str, Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        key = normalize_bucket(row.get(group_key), "unknown")
        groups.setdefault(key, []).append(row)
    out: Dict[str, Dict[str, Any]] = {}
    for key in sorted(groups.keys()):
        samples = groups[key]
        out[key] = {
            "samples": len(samples),
            "ece": compute_ece(samples, field, 10),
            "brier": compute_brier(samples, field),
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate diagnosis confidence calibration metrics.")
    parser.add_argument("--model", default="", help="Calibration model JSON path.")
    parser.add_argument("--model-outputs", default="", help="model_outputs.ndjson path.")
    parser.add_argument("--gold-labels", default="", help="gold_labels.ndjson path.")
    parser.add_argument("--iou-threshold", type=float, default=0.3, help="IoU threshold for matching.")
    parser.add_argument("--out-json", default="", help="Optional output JSON report path.")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    model_path = Path(args.model.strip() or (repo_root / "model_registry" / "diag_calibration_v1.json"))
    outputs_path = Path(args.model_outputs.strip() or (repo_root / "tmp" / "diag_pseudo_label_factory" / "model_outputs.ndjson"))
    gold_path = Path(args.gold_labels.strip() or (repo_root / "tmp" / "diag_pseudo_label_factory" / "gold_labels.ndjson"))

    if not model_path.exists():
        raise SystemExit(f"model not found: {model_path}")
    model = json.loads(model_path.read_text(encoding="utf-8"))
    model_outputs = read_ndjson(outputs_path)
    gold_labels = read_ndjson(gold_path)
    rows = build_rows(model_outputs, gold_labels, clamp(args.iou_threshold, 0.05, 0.95))
    for row in rows:
        row["calibrated_confidence"] = calibrate(model, row)

    payload = {
        "model_path": str(model_path),
        "model_version": model.get("model_version"),
        "schema_version": model.get("schema_version"),
        "input_counts": {
            "model_outputs": len(model_outputs),
            "gold_labels": len(gold_labels),
            "eval_rows": len(rows),
        },
        "metrics": {
            "raw": {
                "ece": compute_ece(rows, "raw_confidence", 10),
                "brier": compute_brier(rows, "raw_confidence"),
            },
            "calibrated": {
                "ece": compute_ece(rows, "calibrated_confidence", 10),
                "brier": compute_brier(rows, "calibrated_confidence"),
            },
        },
        "grouped_ece": {
            "tone_bucket": grouped_ece(rows, "calibrated_confidence", "tone_bucket"),
            "region_bucket": grouped_ece(rows, "calibrated_confidence", "region_bucket"),
            "lighting_bucket": grouped_ece(rows, "calibrated_confidence", "lighting_bucket"),
        },
    }
    payload["metrics"]["delta"] = {
        "ece": round3(payload["metrics"]["raw"]["ece"] - payload["metrics"]["calibrated"]["ece"]),
        "brier": round3(payload["metrics"]["raw"]["brier"] - payload["metrics"]["calibrated"]["brier"]),
    }

    if args.out_json.strip():
        out_path = Path(args.out_json.strip())
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
