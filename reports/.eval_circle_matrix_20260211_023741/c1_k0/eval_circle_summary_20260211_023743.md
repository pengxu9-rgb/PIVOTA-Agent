# Circle Accuracy Evaluation

- run_id: 20260211_023743
- generated_at: 2026-02-11T02:37:43.970Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 19
- samples_ok: 19
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.028
- leakage_mean: 0.903
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.028 < threshold 0.65
- leakage_mean 0.903 > threshold 0.1

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
| fasseg | chin | 19 | 0.007 | 0.004 | 0.01 | 0.985 | 0.904 | 0 |
| fasseg | forehead | 19 | 0.036 | 0.033 | 0.048 | 0.781 | 0.913 | 0 |
| fasseg | left_cheek | 19 | 0.024 | 0.023 | 0.036 | 0.931 | 0.906 | 0 |
| fasseg | nose | 19 | 0.082 | 0.058 | 0.089 | 0.975 | 0.867 | 0 |
| fasseg | right_cheek | 19 | 0.025 | 0.022 | 0.035 | 0.943 | 0.901 | 0 |
| fasseg | under_eye_left | 19 | 0.011 | 0.014 | 0.017 | 0.789 | 0.913 | 0 |
| fasseg | under_eye_right | 19 | 0.012 | 0.014 | 0.018 | 0.789 | 0.917 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_023741/c1_k0/eval_circle_20260211_023743.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_023741/c1_k0/eval_circle_summary_20260211_023743.csv`

