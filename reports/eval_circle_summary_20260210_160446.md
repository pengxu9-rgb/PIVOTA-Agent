# Circle Accuracy Evaluation

- run_id: 20260210_160446
- generated_at: 2026-02-10T16:04:47.350Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 8
- samples_ok: 8
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.148
- leakage_mean: 0.852
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.148 < threshold 0.65
- leakage_mean 0.852 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 8 | 0.023 | 0.015 | 0.041 | 1 | 0.977 | 0 |
| fasseg | forehead | 8 | 0.054 | 0.015 | 0.122 | 0.83 | 0.946 | 0 |
| fasseg | left_cheek | 8 | 0.048 | 0.005 | 0.118 | 0.953 | 0.952 | 0 |
| fasseg | nose | 8 | 0.273 | 0.016 | 0.668 | 0.962 | 0.728 | 0 |
| fasseg | right_cheek | 8 | 0.065 | 0.008 | 0.182 | 0.969 | 0.935 | 0 |
| fasseg | under_eye_left | 8 | 0.303 | 0.006 | 0.779 | 0.875 | 0.697 | 0 |
| fasseg | under_eye_right | 7 | 0.287 | 0.009 | 0.691 | 0.857 | 0.713 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_160446.jsonl`
- csv: `reports/eval_circle_summary_20260210_160446.csv`

