# Circle Accuracy Evaluation

- run_id: 20260210_152333
- generated_at: 2026-02-10T15:23:56.655Z
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
- module_mIoU_mean: 0.576
- leakage_mean: 0.376
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.576 < threshold 0.65
- leakage_mean 0.376 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.637 | 0.602 | 0.852 | 0.955 | 0.327 | 0 |
| celebamaskhq | forehead | 56 | 0.535 | 0.538 | 0.763 | 0.824 | 0.322 | 0 |
| celebamaskhq | left_cheek | 56 | 0.784 | 0.826 | 0.92 | 0.867 | 0.084 | 0 |
| celebamaskhq | nose | 56 | 0.978 | 1 | 1 | 0.978 | 0 | 0 |
| celebamaskhq | right_cheek | 56 | 0.797 | 0.832 | 0.884 | 0.888 | 0.091 | 0 |
| celebamaskhq | under_eye_left | 56 | 0.878 | 1 | 1 | 0.878 | 0 | 0 |
| celebamaskhq | under_eye_right | 56 | 0.928 | 1 | 1 | 0.928 | 0 | 0 |
| fasseg | chin | 45 | 0.028 | 0.028 | 0.041 | 0.998 | 0.972 | 0 |
| fasseg | forehead | 45 | 0.109 | 0.12 | 0.174 | 0.821 | 0.885 | 0 |
| fasseg | left_cheek | 45 | 0.125 | 0.135 | 0.192 | 0.989 | 0.875 | 0 |
| fasseg | nose | 45 | 0.552 | 0.644 | 0.769 | 0.983 | 0.443 | 0 |
| fasseg | right_cheek | 45 | 0.105 | 0.111 | 0.174 | 0.98 | 0.894 | 0 |
| fasseg | under_eye_left | 45 | 0.554 | 0.641 | 0.811 | 0.943 | 0.433 | 0 |
| fasseg | under_eye_right | 44 | 0.562 | 0.669 | 0.765 | 0.944 | 0.428 | 0 |
| lapa | chin | 38 | 0.473 | 0.464 | 0.607 | 0.956 | 0.505 | 0 |
| lapa | forehead | 38 | 0.423 | 0.417 | 0.61 | 0.861 | 0.524 | 0 |
| lapa | left_cheek | 38 | 0.631 | 0.635 | 0.761 | 0.914 | 0.318 | 0 |
| lapa | nose | 38 | 0.751 | 0.753 | 0.939 | 1 | 0.249 | 0 |
| lapa | right_cheek | 38 | 0.603 | 0.615 | 0.779 | 0.91 | 0.354 | 0 |
| lapa | under_eye_left | 38 | 0.66 | 0.622 | 0.949 | 0.945 | 0.301 | 0 |
| lapa | under_eye_right | 38 | 0.644 | 0.703 | 0.906 | 0.919 | 0.314 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_152333.jsonl`
- csv: `reports/eval_circle_summary_20260210_152333.csv`

