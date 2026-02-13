# Circle Accuracy Evaluation

- run_id: 20260210_110754
- generated_at: 2026-02-10T11:08:05.089Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- samples_total: 360
- samples_ok: 181
- samples_failed: 179
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.084
- leakage_mean: 0.4
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- module_mIoU 0.084 < threshold 0.65
- leakage_mean 0.4 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 110 | 0.116 | 0.1 | 0.164 | 0.997 | 0.342 |
| celebamaskhq | forehead | 110 | 0.096 | 0.087 | 0.13 | 0.922 | 0.348 |
| celebamaskhq | left_cheek | 110 | 0.114 | 0.1 | 0.141 | 0.887 | 0.342 |
| celebamaskhq | nose | 110 | 0.077 | 0.066 | 0.111 | 0.999 | 0.342 |
| celebamaskhq | right_cheek | 110 | 0.108 | 0.1 | 0.144 | 0.891 | 0.342 |
| celebamaskhq | under_eye_left | 110 | 0.083 | 0.038 | 0.061 | 0.951 | 0.327 |
| celebamaskhq | under_eye_right | 110 | 0.048 | 0.035 | 0.06 | 0.953 | 0.338 |
| lapa | chin | 71 | 0.083 | 0.074 | 0.126 | 0.919 | 0.493 |
| lapa | forehead | 71 | 0.086 | 0.066 | 0.124 | 0.873 | 0.506 |
| lapa | left_cheek | 71 | 0.089 | 0.082 | 0.129 | 0.861 | 0.493 |
| lapa | nose | 71 | 0.064 | 0.056 | 0.098 | 0.999 | 0.493 |
| lapa | right_cheek | 71 | 0.085 | 0.084 | 0.114 | 0.861 | 0.493 |
| lapa | under_eye_left | 71 | 0.051 | 0.031 | 0.049 | 0.937 | 0.478 |
| lapa | under_eye_right | 70 | 0.05 | 0.032 | 0.048 | 0.928 | 0.492 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_110754.jsonl`
- csv: `reports/eval_circle_summary_20260210_110754.csv`

