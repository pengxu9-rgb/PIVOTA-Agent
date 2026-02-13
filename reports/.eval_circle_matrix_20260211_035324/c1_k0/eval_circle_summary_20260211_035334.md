# Circle Accuracy Evaluation

- run_id: 20260211_035334
- generated_at: 2026-02-11T03:53:39.309Z
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
- module_mIoU_mean: 0.099
- leakage_mean: 0.847
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.099 < threshold 0.65
- leakage_mean 0.847 > threshold 0.1

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
| fasseg | chin | 116 | 0.033 | 0.031 | 0.047 | 0.597 | 0.964 | 0 |
| fasseg | forehead | 116 | 0.076 | 0.075 | 0.125 | 0.312 | 0.897 | 0 |
| fasseg | left_cheek | 116 | 0.059 | 0.05 | 0.11 | 0.34 | 0.921 | 0 |
| fasseg | nose | 116 | 0.474 | 0.54 | 0.596 | 0.753 | 0.279 | 0 |
| fasseg | right_cheek | 116 | 0.051 | 0.049 | 0.092 | 0.33 | 0.933 | 0 |
| fasseg | under_eye_left | 116 | 0 | 0 | 0 | 0 | 0.963 | 0 |
| fasseg | under_eye_right | 115 | 0 | 0 | 0 | 0 | 0.975 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_035324/c1_k0/eval_circle_20260211_035334.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_035324/c1_k0/eval_circle_summary_20260211_035334.csv`

