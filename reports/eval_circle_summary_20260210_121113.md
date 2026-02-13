# Circle Accuracy Evaluation

- run_id: 20260210_121113
- generated_at: 2026-02-10T12:12:50.389Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_tune_latest.json
- circle_model_calibration: true
- samples_total: 2150
- samples_ok: 1634
- samples_failed: 516
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.692
- leakage_mean: 0.27
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- leakage_mean 0.27 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 879 | 0.636 | 0.598 | 0.823 | 0.987 | 0.355 |
| celebamaskhq | forehead | 879 | 0.538 | 0.543 | 0.72 | 0.904 | 0.4 |
| celebamaskhq | left_cheek | 879 | 0.794 | 0.82 | 0.911 | 0.899 | 0.105 |
| celebamaskhq | nose | 879 | 0.997 | 1 | 1 | 0.997 | 0 |
| celebamaskhq | right_cheek | 879 | 0.802 | 0.828 | 0.91 | 0.908 | 0.107 |
| celebamaskhq | under_eye_left | 879 | 0.99 | 1 | 1 | 0.991 | 0.002 |
| celebamaskhq | under_eye_right | 879 | 0.984 | 1 | 1 | 0.985 | 0.003 |
| fasseg | chin | 127 | 0.031 | 0.031 | 0.044 | 1 | 0.969 |
| fasseg | forehead | 127 | 0.124 | 0.126 | 0.173 | 0.917 | 0.874 |
| fasseg | left_cheek | 127 | 0.135 | 0.137 | 0.187 | 1 | 0.865 |
| fasseg | nose | 127 | 0.654 | 0.697 | 0.788 | 1 | 0.346 |
| fasseg | right_cheek | 127 | 0.129 | 0.133 | 0.176 | 1 | 0.871 |
| fasseg | under_eye_left | 127 | 0.634 | 0.668 | 0.771 | 1 | 0.366 |
| fasseg | under_eye_right | 126 | 0.635 | 0.659 | 0.781 | 1 | 0.365 |
| lapa | chin | 628 | 0.472 | 0.488 | 0.667 | 0.893 | 0.459 |
| lapa | forehead | 628 | 0.43 | 0.422 | 0.604 | 0.878 | 0.511 |
| lapa | left_cheek | 628 | 0.569 | 0.585 | 0.752 | 0.855 | 0.354 |
| lapa | nose | 628 | 0.691 | 0.671 | 0.947 | 0.992 | 0.306 |
| lapa | right_cheek | 628 | 0.579 | 0.602 | 0.757 | 0.859 | 0.35 |
| lapa | under_eye_left | 618 | 0.676 | 0.652 | 0.942 | 0.982 | 0.316 |
| lapa | under_eye_right | 621 | 0.669 | 0.659 | 0.944 | 0.979 | 0.324 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_121113.jsonl`
- csv: `reports/eval_circle_summary_20260210_121113.csv`

