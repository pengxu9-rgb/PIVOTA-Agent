# Circle Accuracy Evaluation

- run_id: 20260211_035324
- generated_at: 2026-02-11T03:53:29.809Z
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
- module_mIoU_mean: 0.151
- leakage_mean: 0.84
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.151 < threshold 0.65
- leakage_mean 0.84 > threshold 0.1

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
| fasseg | chin | 116 | 0.035 | 0.033 | 0.048 | 0.753 | 0.964 | 0 |
| fasseg | forehead | 116 | 0.098 | 0.091 | 0.175 | 0.83 | 0.897 | 0 |
| fasseg | left_cheek | 116 | 0.075 | 0.065 | 0.144 | 0.695 | 0.921 | 0 |
| fasseg | nose | 115 | 0.678 | 0.771 | 0.841 | 0.997 | 0.272 | 0 |
| fasseg | right_cheek | 116 | 0.065 | 0.059 | 0.126 | 0.682 | 0.933 | 0 |
| fasseg | under_eye_left | 101 | 0.042 | 0.03 | 0.104 | 0.994 | 0.958 | 0 |
| fasseg | under_eye_right | 94 | 0.031 | 0.017 | 0.066 | 0.989 | 0.969 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_035324/c0_k0/eval_circle_20260211_035324.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_035324/c0_k0/eval_circle_summary_20260211_035324.csv`

