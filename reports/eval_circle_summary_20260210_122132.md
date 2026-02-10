# Circle Accuracy Evaluation

- run_id: 20260210_122132
- generated_at: 2026-02-10T12:23:14.859Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- samples_total: 2150
- samples_ok: 1634
- samples_failed: 516
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.689
- leakage_mean: 0.272
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- leakage_mean 0.272 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 879 | 0.634 | 0.596 | 0.819 | 0.987 | 0.358 |
| celebamaskhq | forehead | 879 | 0.528 | 0.53 | 0.716 | 0.903 | 0.411 |
| celebamaskhq | left_cheek | 879 | 0.794 | 0.82 | 0.911 | 0.899 | 0.105 |
| celebamaskhq | nose | 879 | 0.997 | 1 | 1 | 0.997 | 0 |
| celebamaskhq | right_cheek | 879 | 0.798 | 0.825 | 0.908 | 0.906 | 0.109 |
| celebamaskhq | under_eye_left | 879 | 0.99 | 1 | 1 | 0.992 | 0.001 |
| celebamaskhq | under_eye_right | 879 | 0.984 | 1 | 1 | 0.985 | 0.003 |
| fasseg | chin | 127 | 0.031 | 0.031 | 0.043 | 1 | 0.969 |
| fasseg | forehead | 127 | 0.121 | 0.124 | 0.169 | 0.914 | 0.876 |
| fasseg | left_cheek | 127 | 0.135 | 0.137 | 0.187 | 1 | 0.865 |
| fasseg | nose | 127 | 0.635 | 0.677 | 0.766 | 1 | 0.365 |
| fasseg | right_cheek | 127 | 0.122 | 0.125 | 0.169 | 1 | 0.878 |
| fasseg | under_eye_left | 127 | 0.65 | 0.689 | 0.795 | 1 | 0.35 |
| fasseg | under_eye_right | 126 | 0.635 | 0.659 | 0.781 | 1 | 0.365 |
| lapa | chin | 628 | 0.469 | 0.482 | 0.667 | 0.892 | 0.461 |
| lapa | forehead | 628 | 0.422 | 0.413 | 0.593 | 0.876 | 0.519 |
| lapa | left_cheek | 628 | 0.569 | 0.585 | 0.752 | 0.855 | 0.354 |
| lapa | nose | 628 | 0.691 | 0.671 | 0.946 | 0.992 | 0.306 |
| lapa | right_cheek | 628 | 0.577 | 0.601 | 0.756 | 0.857 | 0.35 |
| lapa | under_eye_left | 618 | 0.674 | 0.644 | 0.962 | 0.983 | 0.319 |
| lapa | under_eye_right | 621 | 0.669 | 0.659 | 0.944 | 0.979 | 0.324 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_122132.jsonl`
- csv: `reports/eval_circle_summary_20260210_122132.csv`

