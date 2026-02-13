# Circle Accuracy Evaluation

- run_id: 20260211_024126
- generated_at: 2026-02-11T02:41:30.454Z
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
- module_mIoU_mean: 0.029
- leakage_mean: 0.899
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.029 < threshold 0.65
- leakage_mean 0.899 > threshold 0.1

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
| fasseg | chin | 116 | 0.01 | 0.004 | 0.018 | 1 | 0.907 | 0 |
| fasseg | forehead | 116 | 0.023 | 0.012 | 0.073 | 0.901 | 0.912 | 0 |
| fasseg | left_cheek | 116 | 0.019 | 0.013 | 0.027 | 0.999 | 0.906 | 0 |
| fasseg | nose | 115 | 0.114 | 0.059 | 0.081 | 0.997 | 0.842 | 0 |
| fasseg | right_cheek | 116 | 0.018 | 0.011 | 0.024 | 1 | 0.905 | 0 |
| fasseg | under_eye_left | 101 | 0.006 | 0.002 | 0.009 | 0.994 | 0.91 | 0 |
| fasseg | under_eye_right | 94 | 0.005 | 0.001 | 0.012 | 0.989 | 0.914 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_024126/c0_k0/eval_circle_20260211_024126.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_024126/c0_k0/eval_circle_summary_20260211_024126.csv`

