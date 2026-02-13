# Circle Accuracy Evaluation

- run_id: 20260210_152150
- generated_at: 2026-02-10T15:22:13.087Z
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
- module_mIoU_mean: 0.584
- leakage_mean: 0.379
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.584 < threshold 0.65
- leakage_mean 0.379 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.651 | 0.608 | 0.852 | 0.982 | 0.338 | 0 |
| celebamaskhq | forehead | 56 | 0.558 | 0.565 | 0.763 | 0.859 | 0.339 | 0 |
| celebamaskhq | left_cheek | 56 | 0.802 | 0.838 | 0.92 | 0.885 | 0.084 | 0 |
| celebamaskhq | nose | 56 | 0.992 | 1 | 1 | 0.992 | 0 | 0 |
| celebamaskhq | right_cheek | 56 | 0.819 | 0.834 | 0.884 | 0.913 | 0.094 | 0 |
| celebamaskhq | under_eye_left | 56 | 0.899 | 1 | 1 | 0.899 | 0 | 0 |
| celebamaskhq | under_eye_right | 56 | 0.96 | 1 | 1 | 0.96 | 0 | 0 |
| fasseg | chin | 45 | 0.028 | 0.028 | 0.041 | 1 | 0.972 | 0 |
| fasseg | forehead | 45 | 0.104 | 0.12 | 0.16 | 0.834 | 0.892 | 0 |
| fasseg | left_cheek | 45 | 0.124 | 0.134 | 0.192 | 0.992 | 0.876 | 0 |
| fasseg | nose | 45 | 0.554 | 0.645 | 0.769 | 0.989 | 0.444 | 0 |
| fasseg | right_cheek | 45 | 0.105 | 0.111 | 0.174 | 0.991 | 0.895 | 0 |
| fasseg | under_eye_left | 45 | 0.552 | 0.641 | 0.782 | 0.955 | 0.447 | 0 |
| fasseg | under_eye_right | 44 | 0.558 | 0.66 | 0.744 | 0.955 | 0.442 | 0 |
| lapa | chin | 38 | 0.479 | 0.471 | 0.607 | 0.963 | 0.502 | 0 |
| lapa | forehead | 38 | 0.423 | 0.417 | 0.61 | 0.861 | 0.524 | 0 |
| lapa | left_cheek | 38 | 0.633 | 0.635 | 0.761 | 0.921 | 0.321 | 0 |
| lapa | nose | 38 | 0.75 | 0.753 | 0.939 | 1 | 0.249 | 0 |
| lapa | right_cheek | 38 | 0.604 | 0.615 | 0.779 | 0.911 | 0.354 | 0 |
| lapa | under_eye_left | 38 | 0.66 | 0.622 | 0.949 | 0.945 | 0.301 | 0 |
| lapa | under_eye_right | 38 | 0.644 | 0.703 | 0.906 | 0.919 | 0.314 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_152150.jsonl`
- csv: `reports/eval_circle_summary_20260210_152150.csv`

