# Circle Accuracy Evaluation

- run_id: 20260211_044457
- generated_at: 2026-02-11T04:44:59.229Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 30
- samples_ok: 30
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.061
- leakage_non_skin_mean: 0.917
- leakage_bg_mean: 0.236
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_bg_mean <= 0.1
- leakage_non_skin_mean (observation only)
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.061 < threshold 0.65
- leakage_bg_mean 0.236 > threshold 0.1
- leakage_non_skin_mean 0.917 > observation 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| - | 0 | 0 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage_non_skin mean | leakage_bg mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 30 | 0.044 | 0.025 | 0.053 | 0.666 | 0.955 | 0.645 | 0 |
| fasseg | forehead | 30 | 0.042 | 0.021 | 0.086 | 0.406 | 0.95 | 0.208 | 0 |
| fasseg | left_cheek | 30 | 0.042 | 0.007 | 0.109 | 0.483 | 0.95 | 0.076 | 0 |
| fasseg | nose | 30 | 0.254 | 0.017 | 0.636 | 0.555 | 0.653 | 0.539 | 0 |
| fasseg | right_cheek | 30 | 0.044 | 0.01 | 0.129 | 0.522 | 0.948 | 0.095 | 0 |
| fasseg | under_eye_left | 30 | 0 | 0 | 0 | 0 | 0.982 | 0.036 | 0 |
| fasseg | under_eye_right | 29 | 0 | 0 | 0 | 0 | 0.982 | 0.048 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_044457.jsonl`
- csv: `reports/eval_circle_summary_20260211_044457.csv`

