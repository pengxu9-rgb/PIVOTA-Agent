# Circle Accuracy Evaluation

- run_id: 20260211_034409
- generated_at: 2026-02-11T03:44:31.103Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.121
- leakage_mean: 0.837
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.121 < threshold 0.65
- leakage_mean 0.837 > threshold 0.1

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
| fasseg | chin | 150 | 0.045 | 0.041 | 0.065 | 0.575 | 0.953 | 0 |
| fasseg | forehead | 150 | 0.08 | 0.078 | 0.136 | 0.306 | 0.888 | 0 |
| fasseg | left_cheek | 150 | 0.079 | 0.07 | 0.149 | 0.326 | 0.902 | 0 |
| fasseg | nose | 150 | 0.572 | 0.649 | 0.739 | 0.724 | 0.269 | 0 |
| fasseg | right_cheek | 150 | 0.069 | 0.066 | 0.128 | 0.326 | 0.916 | 0 |
| fasseg | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.958 | 0 |
| fasseg | under_eye_right | 149 | 0 | 0 | 0 | 0 | 0.972 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_034409.jsonl`
- csv: `reports/eval_circle_summary_20260211_034409.csv`

