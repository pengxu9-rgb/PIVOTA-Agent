# Circle Accuracy Evaluation

- run_id: 20260210_110850
- generated_at: 2026-02-10T11:09:02.250Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- samples_total: 360
- samples_ok: 186
- samples_failed: 174
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.085
- leakage_mean: 0.402
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- module_mIoU 0.085 < threshold 0.65
- leakage_mean 0.402 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 111 | 0.117 | 0.101 | 0.17 | 0.997 | 0.34 |
| celebamaskhq | forehead | 111 | 0.095 | 0.087 | 0.13 | 0.913 | 0.347 |
| celebamaskhq | left_cheek | 111 | 0.114 | 0.1 | 0.143 | 0.887 | 0.341 |
| celebamaskhq | nose | 111 | 0.077 | 0.066 | 0.112 | 0.999 | 0.34 |
| celebamaskhq | right_cheek | 111 | 0.108 | 0.1 | 0.144 | 0.886 | 0.34 |
| celebamaskhq | under_eye_left | 111 | 0.083 | 0.038 | 0.062 | 0.952 | 0.325 |
| celebamaskhq | under_eye_right | 111 | 0.048 | 0.036 | 0.06 | 0.948 | 0.337 |
| lapa | chin | 75 | 0.083 | 0.074 | 0.122 | 0.917 | 0.497 |
| lapa | forehead | 75 | 0.091 | 0.067 | 0.126 | 0.877 | 0.509 |
| lapa | left_cheek | 75 | 0.089 | 0.08 | 0.129 | 0.859 | 0.497 |
| lapa | nose | 75 | 0.063 | 0.055 | 0.094 | 0.999 | 0.497 |
| lapa | right_cheek | 75 | 0.085 | 0.084 | 0.118 | 0.861 | 0.497 |
| lapa | under_eye_left | 75 | 0.048 | 0.031 | 0.046 | 0.933 | 0.484 |
| lapa | under_eye_right | 74 | 0.063 | 0.032 | 0.051 | 0.932 | 0.492 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_110850.jsonl`
- csv: `reports/eval_circle_summary_20260210_110850.csv`

