# Circle Accuracy Evaluation

- run_id: 20260210_121258
- generated_at: 2026-02-10T12:14:34.795Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_tune_latest.json
- circle_model_calibration: false
- samples_total: 2150
- samples_ok: 1634
- samples_failed: 516
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.109
- leakage_mean: 0.44
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- module_mIoU 0.109 < threshold 0.65
- leakage_mean 0.44 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 879 | 0.098 | 0.089 | 0.144 | 0.987 | 0.346 |
| celebamaskhq | forehead | 879 | 0.191 | 0.177 | 0.249 | 0.904 | 0.36 |
| celebamaskhq | left_cheek | 879 | 0.153 | 0.138 | 0.203 | 0.899 | 0.344 |
| celebamaskhq | nose | 879 | 0.1 | 0.089 | 0.145 | 0.997 | 0.344 |
| celebamaskhq | right_cheek | 879 | 0.158 | 0.146 | 0.209 | 0.908 | 0.345 |
| celebamaskhq | under_eye_left | 879 | 0.081 | 0.025 | 0.044 | 0.991 | 0.325 |
| celebamaskhq | under_eye_right | 879 | 0.065 | 0.024 | 0.042 | 0.985 | 0.33 |
| fasseg | chin | 127 | 0.005 | 0.004 | 0.007 | 1 | 0.894 |
| fasseg | forehead | 127 | 0.041 | 0.033 | 0.081 | 0.917 | 0.898 |
| fasseg | left_cheek | 127 | 0.026 | 0.026 | 0.036 | 1 | 0.894 |
| fasseg | nose | 127 | 0.059 | 0.06 | 0.077 | 1 | 0.894 |
| fasseg | right_cheek | 127 | 0.026 | 0.026 | 0.037 | 1 | 0.894 |
| fasseg | under_eye_left | 127 | 0.046 | 0.017 | 0.023 | 1 | 0.869 |
| fasseg | under_eye_right | 126 | 0.046 | 0.017 | 0.022 | 1 | 0.868 |
| lapa | chin | 628 | 0.076 | 0.066 | 0.126 | 0.893 | 0.487 |
| lapa | forehead | 628 | 0.175 | 0.144 | 0.336 | 0.878 | 0.519 |
| lapa | left_cheek | 628 | 0.124 | 0.109 | 0.189 | 0.855 | 0.485 |
| lapa | nose | 628 | 0.089 | 0.069 | 0.151 | 0.992 | 0.483 |
| lapa | right_cheek | 628 | 0.131 | 0.114 | 0.199 | 0.859 | 0.485 |
| lapa | under_eye_left | 618 | 0.069 | 0.02 | 0.056 | 0.982 | 0.475 |
| lapa | under_eye_right | 621 | 0.077 | 0.019 | 0.061 | 0.979 | 0.471 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_121258.jsonl`
- csv: `reports/eval_circle_summary_20260210_121258.csv`

