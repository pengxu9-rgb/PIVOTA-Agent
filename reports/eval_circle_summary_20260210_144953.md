# Circle Accuracy Evaluation

- run_id: 20260210_144953
- generated_at: 2026-02-10T14:49:57.076Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 90
- samples_ok: 63
- samples_failed: 27
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.583
- leakage_mean: 0.382
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.583 < threshold 0.65
- leakage_mean 0.382 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 26 | 0.68 | 0.645 | 0.852 | 0.981 | 0.306 | 0 |
| celebamaskhq | forehead | 26 | 0.568 | 0.569 | 0.763 | 0.886 | 0.357 | 0 |
| celebamaskhq | left_cheek | 26 | 0.792 | 0.817 | 0.906 | 0.872 | 0.083 | 0 |
| celebamaskhq | nose | 26 | 0.995 | 1 | 1 | 0.995 | 0 | 0 |
| celebamaskhq | right_cheek | 26 | 0.829 | 0.835 | 0.884 | 0.937 | 0.109 | 0 |
| celebamaskhq | under_eye_left | 26 | 0.885 | 1 | 1 | 0.885 | 0.004 | 0 |
| celebamaskhq | under_eye_right | 26 | 0.983 | 1 | 1 | 0.983 | 0 | 0 |
| fasseg | chin | 17 | 0.023 | 0.022 | 0.034 | 1 | 0.977 | 0 |
| fasseg | forehead | 17 | 0.064 | 0.065 | 0.131 | 0.846 | 0.935 | 0 |
| fasseg | left_cheek | 17 | 0.072 | 0.086 | 0.155 | 1 | 0.928 | 0 |
| fasseg | nose | 17 | 0.359 | 0.524 | 0.718 | 1 | 0.641 | 0 |
| fasseg | right_cheek | 17 | 0.072 | 0.073 | 0.174 | 1 | 0.928 | 0 |
| fasseg | under_eye_left | 17 | 0.394 | 0.619 | 0.782 | 1 | 0.606 | 0 |
| fasseg | under_eye_right | 16 | 0.392 | 0.578 | 0.722 | 1 | 0.608 | 0 |
| lapa | chin | 20 | 0.484 | 0.488 | 0.568 | 0.93 | 0.481 | 0 |
| lapa | forehead | 20 | 0.432 | 0.428 | 0.61 | 0.887 | 0.519 | 0 |
| lapa | left_cheek | 20 | 0.64 | 0.619 | 0.814 | 0.928 | 0.309 | 0 |
| lapa | nose | 20 | 0.731 | 0.729 | 0.943 | 1 | 0.269 | 0 |
| lapa | right_cheek | 20 | 0.621 | 0.615 | 0.739 | 0.914 | 0.329 | 0 |
| lapa | under_eye_left | 20 | 0.677 | 0.635 | 0.926 | 0.995 | 0.317 | 0 |
| lapa | under_eye_right | 20 | 0.648 | 0.641 | 0.906 | 0.947 | 0.311 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_144953.jsonl`
- csv: `reports/eval_circle_summary_20260210_144953.csv`

