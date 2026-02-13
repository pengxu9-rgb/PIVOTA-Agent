# Circle Accuracy Evaluation

- run_id: 20260211_024134
- generated_at: 2026-02-11T02:41:38.913Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 116
- samples_ok: 116
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.031
- leakage_mean: 0.9
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.031 < threshold 0.65
- leakage_mean 0.9 > threshold 0.1

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
| fasseg | chin | 116 | 0.01 | 0.005 | 0.014 | 0.968 | 0.907 | 0 |
| fasseg | forehead | 116 | 0.036 | 0.033 | 0.066 | 0.762 | 0.912 | 0 |
| fasseg | left_cheek | 116 | 0.027 | 0.025 | 0.039 | 0.917 | 0.906 | 0 |
| fasseg | nose | 116 | 0.096 | 0.06 | 0.091 | 0.942 | 0.844 | 0 |
| fasseg | right_cheek | 116 | 0.026 | 0.023 | 0.036 | 0.922 | 0.905 | 0 |
| fasseg | under_eye_left | 116 | 0.012 | 0.015 | 0.019 | 0.802 | 0.914 | 0 |
| fasseg | under_eye_right | 115 | 0.012 | 0.015 | 0.018 | 0.8 | 0.914 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_024126/c1_k0/eval_circle_20260211_024134.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_024126/c1_k0/eval_circle_summary_20260211_024134.csv`

