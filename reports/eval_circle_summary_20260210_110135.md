# Circle Accuracy Evaluation

- run_id: 20260210_110135
- generated_at: 2026-02-10T11:01:38.815Z
- mode: local
- datasets: lapa, celebamaskhq, fasseg
- samples_total: 120
- samples_ok: 71
- samples_failed: 49
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0
- leakage_mean: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- module_mIoU 0 < threshold 0.65

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|

## Artifacts

- jsonl: `reports/eval_circle_20260210_110135.jsonl`
- csv: `reports/eval_circle_summary_20260210_110135.csv`

