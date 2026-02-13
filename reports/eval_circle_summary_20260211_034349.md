# Circle Accuracy Evaluation

- run_id: 20260211_034349
- generated_at: 2026-02-11T03:43:55.223Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.125
- leakage_mean: 0.838
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.125 < threshold 0.65
- leakage_mean 0.838 > threshold 0.1

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
| fasseg | chin | 150 | 0.045 | 0.042 | 0.064 | 0.59 | 0.953 | 0 |
| fasseg | forehead | 150 | 0.08 | 0.078 | 0.134 | 0.308 | 0.889 | 0 |
| fasseg | left_cheek | 150 | 0.078 | 0.068 | 0.148 | 0.333 | 0.904 | 0 |
| fasseg | nose | 150 | 0.598 | 0.675 | 0.751 | 0.759 | 0.271 | 0 |
| fasseg | right_cheek | 150 | 0.069 | 0.066 | 0.129 | 0.326 | 0.916 | 0 |
| fasseg | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.96 | 0 |
| fasseg | under_eye_right | 149 | 0 | 0 | 0 | 0 | 0.973 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_034349.jsonl`
- csv: `reports/eval_circle_summary_20260211_034349.csv`

