# Circle Accuracy Evaluation

- run_id: 20260211_025024
- generated_at: 2026-02-11T02:50:28.192Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 116
- samples_ok: 116
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.128
- leakage_mean: 0.831
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.128 < threshold 0.65
- leakage_mean 0.831 > threshold 0.1

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
| fasseg | chin | 116 | 0.046 | 0.041 | 0.064 | 0.589 | 0.952 | 0 |
| fasseg | forehead | 116 | 0.08 | 0.075 | 0.133 | 0.274 | 0.887 | 0 |
| fasseg | left_cheek | 116 | 0.093 | 0.082 | 0.173 | 0.34 | 0.879 | 0 |
| fasseg | nose | 116 | 0.593 | 0.68 | 0.751 | 0.753 | 0.277 | 0 |
| fasseg | right_cheek | 116 | 0.082 | 0.08 | 0.15 | 0.33 | 0.895 | 0 |
| fasseg | under_eye_left | 116 | 0 | 0 | 0 | 0 | 0.96 | 0 |
| fasseg | under_eye_right | 115 | 0 | 0 | 0 | 0 | 0.972 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_025011/c1_k1/eval_circle_20260211_025024.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_025011/c1_k1/eval_circle_summary_20260211_025024.csv`

