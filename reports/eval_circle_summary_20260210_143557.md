# Circle Accuracy Evaluation

- run_id: 20260210_143557
- generated_at: 2026-02-10T14:35:57.264Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: tmp/fake.onnx
- samples_total: 2
- samples_ok: 2
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.378
- leakage_mean: 0.622
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.378 < threshold 0.65
- leakage_mean 0.622 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 2 | 0.033 | 0.024 | 0.024 | 1 | 0.967 | 0 |
| fasseg | forehead | 2 | 0.114 | 0.107 | 0.107 | 1 | 0.886 | 0 |
| fasseg | left_cheek | 2 | 0.124 | 0.103 | 0.103 | 1 | 0.876 | 0 |
| fasseg | nose | 2 | 0.728 | 0.668 | 0.668 | 1 | 0.273 | 0 |
| fasseg | right_cheek | 2 | 0.184 | 0.182 | 0.182 | 1 | 0.816 | 0 |
| fasseg | under_eye_left | 2 | 0.826 | 0.779 | 0.779 | 1 | 0.175 | 0 |
| fasseg | under_eye_right | 2 | 0.635 | 0.578 | 0.578 | 1 | 0.366 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_143557.jsonl`
- csv: `reports/eval_circle_summary_20260210_143557.csv`

