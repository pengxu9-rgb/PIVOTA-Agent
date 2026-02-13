# Skinmask Ablation Report

- run_id: 20260210_152049
- generated_at: 2026-02-10T15:20:49.694Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0 | 0.584 | 0.584 |
| coverage_mean | 0 | 0.939 | 0.939 |
| leakage_mean | 0 | 0.379 | 0.379 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_152020.md`
- on.md: `reports/eval_circle_summary_20260210_152026.md`
- off.csv: `reports/eval_circle_summary_20260210_152020.csv`
- on.csv: `reports/eval_circle_summary_20260210_152026.csv`
- off.jsonl: `reports/eval_circle_20260210_152020.jsonl`
- on.jsonl: `reports/eval_circle_20260210_152026.jsonl`

- report: `reports/skinmask_ablation_20260210_152049.md`

