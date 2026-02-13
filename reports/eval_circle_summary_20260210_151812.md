# Circle Accuracy Evaluation

- run_id: 20260210_151812
- generated_at: 2026-02-10T15:18:35.557Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 180
- samples_ok: 139
- samples_failed: 41
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.419
- leakage_mean: 0.358
- skin_roi_too_small_rate: 0.137
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 256)

## Soft Warnings

- module_mIoU 0.419 < threshold 0.65
- leakage_mean 0.358 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.465 | 0.528 | 0.696 | 0.65 | 0.275 | 0.054 |
| celebamaskhq | forehead | 56 | 0.352 | 0.339 | 0.641 | 0.465 | 0.134 | 0.143 |
| celebamaskhq | left_cheek | 56 | 0.503 | 0.501 | 0.911 | 0.534 | 0.04 | 0.125 |
| celebamaskhq | nose | 56 | 0.683 | 0.738 | 1 | 0.683 | 0 | 0.125 |
| celebamaskhq | right_cheek | 56 | 0.526 | 0.584 | 0.875 | 0.561 | 0.055 | 0.089 |
| celebamaskhq | under_eye_left | 56 | 0.489 | 0.391 | 1 | 0.492 | 0.029 | 0.304 |
| celebamaskhq | under_eye_right | 56 | 0.519 | 0.475 | 1 | 0.523 | 0.032 | 0.286 |
| fasseg | chin | 45 | 0.03 | 0.03 | 0.048 | 0.856 | 0.969 | 0.022 |
| fasseg | forehead | 45 | 0.127 | 0.11 | 0.267 | 0.426 | 0.821 | 0.044 |
| fasseg | left_cheek | 45 | 0.112 | 0.106 | 0.219 | 0.647 | 0.88 | 0.044 |
| fasseg | nose | 45 | 0.357 | 0.42 | 0.681 | 0.62 | 0.507 | 0.111 |
| fasseg | right_cheek | 45 | 0.088 | 0.095 | 0.167 | 0.589 | 0.903 | 0 |
| fasseg | under_eye_left | 45 | 0.336 | 0.316 | 0.782 | 0.508 | 0.438 | 0.556 |
| fasseg | under_eye_right | 44 | 0.34 | 0.336 | 0.696 | 0.534 | 0.434 | 0.545 |
| lapa | chin | 38 | 0.435 | 0.453 | 0.557 | 0.847 | 0.469 | 0.053 |
| lapa | forehead | 38 | 0.377 | 0.4 | 0.554 | 0.771 | 0.504 | 0.026 |
| lapa | left_cheek | 38 | 0.576 | 0.619 | 0.761 | 0.829 | 0.312 | 0.026 |
| lapa | nose | 38 | 0.706 | 0.717 | 0.939 | 0.933 | 0.235 | 0.026 |
| lapa | right_cheek | 38 | 0.542 | 0.601 | 0.708 | 0.816 | 0.354 | 0.026 |
| lapa | under_eye_left | 38 | 0.617 | 0.615 | 0.897 | 0.883 | 0.297 | 0.079 |
| lapa | under_eye_right | 38 | 0.608 | 0.659 | 0.906 | 0.857 | 0.3 | 0.053 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_151812.jsonl`
- csv: `reports/eval_circle_summary_20260210_151812.csv`

