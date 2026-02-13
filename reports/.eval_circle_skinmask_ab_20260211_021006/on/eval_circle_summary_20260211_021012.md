# Circle Accuracy Evaluation

- run_id: 20260211_021012
- generated_at: 2026-02-11T02:10:27.287Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 114
- samples_ok: 114
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.275
- leakage_mean: 0.719
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.275 < threshold 0.65
- leakage_mean 0.719 > threshold 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| - | 0 | 0 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 114 | 0.036 | 0.032 | 0.046 | 0.959 | 0.964 | 0 |
| fasseg | forehead | 114 | 0.103 | 0.107 | 0.173 | 0.734 | 0.891 | 0 |
| fasseg | left_cheek | 114 | 0.117 | 0.126 | 0.185 | 0.894 | 0.881 | 0 |
| fasseg | nose | 114 | 0.57 | 0.668 | 0.757 | 0.931 | 0.415 | 0 |
| fasseg | right_cheek | 114 | 0.109 | 0.12 | 0.166 | 0.902 | 0.889 | 0 |
| fasseg | under_eye_left | 114 | 0.501 | 0.638 | 0.795 | 0.776 | 0.491 | 0 |
| fasseg | under_eye_right | 113 | 0.492 | 0.628 | 0.781 | 0.776 | 0.502 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_skinmask_ab_20260211_021006/on/eval_circle_20260211_021012.jsonl`
- csv: `reports/.eval_circle_skinmask_ab_20260211_021006/on/eval_circle_summary_20260211_021012.csv`

