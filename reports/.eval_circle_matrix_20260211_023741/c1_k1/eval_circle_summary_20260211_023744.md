# Circle Accuracy Evaluation

- run_id: 20260211_023744
- generated_at: 2026-02-11T02:37:44.813Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 19
- samples_ok: 19
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.28
- leakage_mean: 0.718
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.28 < threshold 0.65
- leakage_mean 0.718 > threshold 0.1

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
| fasseg | chin | 19 | 0.032 | 0.031 | 0.042 | 0.985 | 0.968 | 0 |
| fasseg | forehead | 19 | 0.1 | 0.1 | 0.15 | 0.781 | 0.897 | 0 |
| fasseg | left_cheek | 19 | 0.129 | 0.131 | 0.202 | 0.931 | 0.871 | 0 |
| fasseg | nose | 19 | 0.607 | 0.676 | 0.755 | 0.975 | 0.388 | 0 |
| fasseg | right_cheek | 19 | 0.109 | 0.117 | 0.161 | 0.943 | 0.89 | 0 |
| fasseg | under_eye_left | 19 | 0.485 | 0.622 | 0.75 | 0.789 | 0.509 | 0 |
| fasseg | under_eye_right | 19 | 0.497 | 0.625 | 0.75 | 0.789 | 0.502 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_023741/c1_k1/eval_circle_20260211_023744.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_023741/c1_k1/eval_circle_summary_20260211_023744.csv`

