# Circle Accuracy Evaluation

- run_id: 20260210_151722
- generated_at: 2026-02-10T15:17:49.032Z
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
- module_mIoU_mean: 0.306
- leakage_mean: 0.347
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.306 < threshold 0.65
- leakage_mean 0.347 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.371 | 0.381 | 0.676 | 0.486 | 0.225 | 0 |
| celebamaskhq | forehead | 56 | 0.275 | 0.231 | 0.567 | 0.314 | 0.073 | 0 |
| celebamaskhq | left_cheek | 56 | 0.355 | 0.255 | 0.805 | 0.367 | 0.033 | 0 |
| celebamaskhq | nose | 56 | 0.514 | 0.523 | 1 | 0.514 | 0.012 | 0 |
| celebamaskhq | right_cheek | 56 | 0.375 | 0.282 | 0.849 | 0.387 | 0.044 | 0 |
| celebamaskhq | under_eye_left | 56 | 0.331 | 0.103 | 1 | 0.335 | 0.04 | 0 |
| celebamaskhq | under_eye_right | 56 | 0.362 | 0.188 | 1 | 0.366 | 0.045 | 0 |
| fasseg | chin | 45 | 0.029 | 0.029 | 0.05 | 0.743 | 0.968 | 0 |
| fasseg | forehead | 45 | 0.12 | 0.09 | 0.267 | 0.341 | 0.814 | 0 |
| fasseg | left_cheek | 45 | 0.098 | 0.061 | 0.219 | 0.514 | 0.893 | 0 |
| fasseg | nose | 45 | 0.291 | 0.327 | 0.605 | 0.487 | 0.567 | 0 |
| fasseg | right_cheek | 45 | 0.076 | 0.074 | 0.148 | 0.456 | 0.915 | 0 |
| fasseg | under_eye_left | 45 | 0.272 | 0.172 | 0.714 | 0.375 | 0.497 | 0 |
| fasseg | under_eye_right | 44 | 0.28 | 0.209 | 0.696 | 0.398 | 0.489 | 0 |
| lapa | chin | 38 | 0.31 | 0.346 | 0.541 | 0.579 | 0.379 | 0 |
| lapa | forehead | 38 | 0.254 | 0.284 | 0.47 | 0.485 | 0.381 | 0 |
| lapa | left_cheek | 38 | 0.405 | 0.437 | 0.733 | 0.57 | 0.286 | 0 |
| lapa | nose | 38 | 0.497 | 0.511 | 0.912 | 0.651 | 0.214 | 0 |
| lapa | right_cheek | 38 | 0.347 | 0.409 | 0.643 | 0.524 | 0.309 | 0 |
| lapa | under_eye_left | 38 | 0.404 | 0.511 | 0.798 | 0.593 | 0.289 | 0 |
| lapa | under_eye_right | 38 | 0.424 | 0.494 | 0.903 | 0.577 | 0.254 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_151722.jsonl`
- csv: `reports/eval_circle_summary_20260210_151722.csv`

