# Circle Accuracy Evaluation

- run_id: 20260210_152020
- generated_at: 2026-02-10T15:20:25.942Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 180
- samples_ok: 0
- samples_failed: 180
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0
- leakage_mean: 0
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: n/a

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0 < threshold 0.65

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|

## Artifacts

- jsonl: `reports/eval_circle_20260210_152020.jsonl`
- csv: `reports/eval_circle_summary_20260210_152020.csv`

