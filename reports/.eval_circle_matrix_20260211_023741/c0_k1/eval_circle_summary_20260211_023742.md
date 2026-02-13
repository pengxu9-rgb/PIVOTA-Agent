# Circle Accuracy Evaluation

- run_id: 20260211_023742
- generated_at: 2026-02-11T02:37:43.154Z
- mode: local
- datasets: fasseg
- circle_model_enabled: false
- circle_model_path: n/a
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 19
- samples_ok: 19
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.024
- leakage_mean: 0.902
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.024 < threshold 0.65
- leakage_mean 0.902 > threshold 0.1

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
| fasseg | chin | 19 | 0.006 | 0.003 | 0.008 | 1 | 0.904 | 0 |
| fasseg | forehead | 19 | 0.022 | 0.011 | 0.053 | 0.937 | 0.913 | 0 |
| fasseg | left_cheek | 19 | 0.014 | 0.014 | 0.025 | 0.999 | 0.906 | 0 |
| fasseg | nose | 19 | 0.088 | 0.055 | 0.081 | 0.991 | 0.867 | 0 |
| fasseg | right_cheek | 19 | 0.015 | 0.01 | 0.021 | 0.999 | 0.901 | 0 |
| fasseg | under_eye_left | 16 | 0.009 | 0.004 | 0.016 | 1 | 0.91 | 0 |
| fasseg | under_eye_right | 14 | 0.003 | 0.001 | 0.007 | 1 | 0.918 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_023741/c0_k1/eval_circle_20260211_023742.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_023741/c0_k1/eval_circle_summary_20260211_023742.csv`

