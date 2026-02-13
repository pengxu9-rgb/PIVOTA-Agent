# Circle Accuracy Evaluation

- run_id: 20260211_025011
- generated_at: 2026-02-11T02:50:15.706Z
- mode: local
- datasets: fasseg
- circle_model_enabled: false
- circle_model_path: n/a
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 116
- samples_ok: 116
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.158
- leakage_mean: 0.831
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.158 < threshold 0.65
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
| fasseg | chin | 116 | 0.035 | 0.032 | 0.048 | 0.742 | 0.965 | 0 |
| fasseg | forehead | 116 | 0.106 | 0.102 | 0.183 | 0.729 | 0.887 | 0 |
| fasseg | left_cheek | 116 | 0.095 | 0.08 | 0.189 | 0.695 | 0.899 | 0 |
| fasseg | nose | 115 | 0.678 | 0.771 | 0.841 | 0.997 | 0.272 | 0 |
| fasseg | right_cheek | 116 | 0.082 | 0.074 | 0.151 | 0.682 | 0.914 | 0 |
| fasseg | under_eye_left | 101 | 0.046 | 0.029 | 0.118 | 0.953 | 0.954 | 0 |
| fasseg | under_eye_right | 94 | 0.034 | 0.019 | 0.075 | 0.95 | 0.966 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_025011/c0_k0/eval_circle_20260211_025011.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_025011/c0_k0/eval_circle_summary_20260211_025011.csv`

