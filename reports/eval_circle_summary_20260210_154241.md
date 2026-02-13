# Circle Accuracy Evaluation

- run_id: 20260210_154241
- generated_at: 2026-02-10T15:43:27.183Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 360
- samples_ok: 287
- samples_failed: 73
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.578
- leakage_mean: 0.387
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.578 < threshold 0.65
- leakage_mean 0.387 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 111 | 0.64 | 0.6 | 0.813 | 0.985 | 0.35 | 0 |
| celebamaskhq | forehead | 111 | 0.533 | 0.538 | 0.738 | 0.881 | 0.376 | 0 |
| celebamaskhq | left_cheek | 111 | 0.798 | 0.826 | 0.912 | 0.908 | 0.111 | 0 |
| celebamaskhq | nose | 111 | 0.993 | 1 | 1 | 0.993 | 0 | 0 |
| celebamaskhq | right_cheek | 111 | 0.806 | 0.83 | 0.884 | 0.912 | 0.106 | 0 |
| celebamaskhq | under_eye_left | 111 | 0.931 | 1 | 1 | 0.932 | 0.001 | 0 |
| celebamaskhq | under_eye_right | 111 | 0.963 | 1 | 1 | 0.963 | 0 | 0 |
| fasseg | chin | 101 | 0.031 | 0.031 | 0.043 | 1 | 0.969 | 0 |
| fasseg | forehead | 101 | 0.118 | 0.122 | 0.173 | 0.818 | 0.877 | 0 |
| fasseg | left_cheek | 101 | 0.134 | 0.137 | 0.187 | 0.996 | 0.866 | 0 |
| fasseg | nose | 101 | 0.621 | 0.673 | 0.77 | 0.994 | 0.377 | 0 |
| fasseg | right_cheek | 101 | 0.12 | 0.122 | 0.178 | 0.995 | 0.88 | 0 |
| fasseg | under_eye_left | 101 | 0.606 | 0.683 | 0.802 | 0.938 | 0.39 | 0 |
| fasseg | under_eye_right | 100 | 0.598 | 0.659 | 0.781 | 0.939 | 0.4 | 0 |
| lapa | chin | 75 | 0.45 | 0.471 | 0.607 | 0.875 | 0.468 | 0 |
| lapa | forehead | 75 | 0.419 | 0.414 | 0.61 | 0.836 | 0.512 | 0 |
| lapa | left_cheek | 75 | 0.622 | 0.639 | 0.781 | 0.894 | 0.315 | 0 |
| lapa | nose | 75 | 0.726 | 0.734 | 0.938 | 0.998 | 0.273 | 0 |
| lapa | right_cheek | 75 | 0.577 | 0.596 | 0.717 | 0.88 | 0.365 | 0 |
| lapa | under_eye_left | 75 | 0.658 | 0.623 | 0.926 | 0.96 | 0.319 | 0 |
| lapa | under_eye_right | 75 | 0.655 | 0.706 | 0.906 | 0.93 | 0.311 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_154241.jsonl`
- csv: `reports/eval_circle_summary_20260210_154241.csv`

