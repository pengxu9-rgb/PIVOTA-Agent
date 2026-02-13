# Circle Accuracy Evaluation

- run_id: 20260210_154228
- generated_at: 2026-02-10T15:42:41.577Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 360
- samples_ok: 287
- samples_failed: 73
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.581
- leakage_mean: 0.39
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.581 < threshold 0.65
- leakage_mean 0.39 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 111 | 0.639 | 0.593 | 0.813 | 0.992 | 0.356 | 0 |
| celebamaskhq | forehead | 111 | 0.545 | 0.545 | 0.747 | 0.9 | 0.386 | 0 |
| celebamaskhq | left_cheek | 111 | 0.804 | 0.827 | 0.911 | 0.915 | 0.111 | 0 |
| celebamaskhq | nose | 111 | 0.999 | 1 | 1 | 0.999 | 0 | 0 |
| celebamaskhq | right_cheek | 111 | 0.811 | 0.832 | 0.897 | 0.918 | 0.107 | 0 |
| celebamaskhq | under_eye_left | 111 | 0.945 | 1 | 1 | 0.946 | 0.001 | 0 |
| celebamaskhq | under_eye_right | 111 | 0.976 | 1 | 1 | 0.976 | 0 | 0 |
| fasseg | chin | 101 | 0.031 | 0.031 | 0.041 | 1 | 0.969 | 0 |
| fasseg | forehead | 101 | 0.113 | 0.121 | 0.166 | 0.826 | 0.883 | 0 |
| fasseg | left_cheek | 101 | 0.133 | 0.137 | 0.185 | 1 | 0.867 | 0 |
| fasseg | nose | 101 | 0.623 | 0.674 | 0.77 | 1 | 0.377 | 0 |
| fasseg | right_cheek | 101 | 0.119 | 0.122 | 0.174 | 1 | 0.881 | 0 |
| fasseg | under_eye_left | 101 | 0.604 | 0.676 | 0.785 | 0.95 | 0.394 | 0 |
| fasseg | under_eye_right | 100 | 0.596 | 0.653 | 0.781 | 0.95 | 0.404 | 0 |
| lapa | chin | 75 | 0.449 | 0.473 | 0.607 | 0.877 | 0.472 | 0 |
| lapa | forehead | 75 | 0.422 | 0.418 | 0.61 | 0.855 | 0.525 | 0 |
| lapa | left_cheek | 75 | 0.623 | 0.639 | 0.761 | 0.899 | 0.317 | 0 |
| lapa | nose | 75 | 0.726 | 0.734 | 0.938 | 0.999 | 0.274 | 0 |
| lapa | right_cheek | 75 | 0.582 | 0.608 | 0.717 | 0.89 | 0.366 | 0 |
| lapa | under_eye_left | 75 | 0.658 | 0.625 | 0.926 | 0.963 | 0.321 | 0 |
| lapa | under_eye_right | 75 | 0.656 | 0.706 | 0.906 | 0.932 | 0.311 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_154228.jsonl`
- csv: `reports/eval_circle_summary_20260210_154228.csv`

