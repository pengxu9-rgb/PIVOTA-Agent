# Circle Accuracy Evaluation

- run_id: 20260211_013122
- generated_at: 2026-02-11T01:31:24.932Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 80
- samples_ok: 62
- samples_failed: 18
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.298
- leakage_mean: 0.702
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.298 < threshold 0.65
- leakage_mean 0.702 > threshold 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| PRED_MODULES_MISSING | 18 | 0.225 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 62 | 0.029 | 0.028 | 0.038 | 1 | 0.971 | 0 |
| fasseg | forehead | 62 | 0.105 | 0.118 | 0.16 | 0.842 | 0.892 | 0 |
| fasseg | left_cheek | 62 | 0.125 | 0.131 | 0.177 | 1 | 0.875 | 0 |
| fasseg | nose | 62 | 0.587 | 0.648 | 0.769 | 1 | 0.413 | 0 |
| fasseg | right_cheek | 62 | 0.109 | 0.116 | 0.169 | 1 | 0.891 | 0 |
| fasseg | under_eye_left | 62 | 0.569 | 0.641 | 0.782 | 0.952 | 0.429 | 0 |
| fasseg | under_eye_right | 61 | 0.564 | 0.65 | 0.75 | 0.951 | 0.436 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_ab_20260211_013121/off/eval_circle_20260211_013122.jsonl`
- csv: `reports/.eval_circle_ab_20260211_013121/off/eval_circle_summary_20260211_013122.csv`

