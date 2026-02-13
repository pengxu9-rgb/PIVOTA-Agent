# Circle Accuracy Evaluation

- run_id: 20260211_024139
- generated_at: 2026-02-11T02:41:43.807Z
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
- module_mIoU_mean: 0.281
- leakage_mean: 0.715
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.281 < threshold 0.65
- leakage_mean 0.715 > threshold 0.1

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
| fasseg | chin | 116 | 0.035 | 0.032 | 0.043 | 0.968 | 0.965 | 0 |
| fasseg | forehead | 116 | 0.099 | 0.107 | 0.159 | 0.762 | 0.897 | 0 |
| fasseg | left_cheek | 116 | 0.121 | 0.131 | 0.187 | 0.917 | 0.877 | 0 |
| fasseg | nose | 116 | 0.592 | 0.677 | 0.757 | 0.942 | 0.396 | 0 |
| fasseg | right_cheek | 116 | 0.11 | 0.119 | 0.166 | 0.922 | 0.888 | 0 |
| fasseg | under_eye_left | 116 | 0.512 | 0.641 | 0.779 | 0.802 | 0.485 | 0 |
| fasseg | under_eye_right | 115 | 0.499 | 0.625 | 0.753 | 0.8 | 0.497 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_024126/c1_k1/eval_circle_20260211_024139.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_024126/c1_k1/eval_circle_summary_20260211_024139.csv`

