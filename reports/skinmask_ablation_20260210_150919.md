# Skinmask Ablation Report

- run_id: 20260210_150919
- generated_at: 2026-02-10T15:09:19.009Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.3 | -0.287 |
| coverage_mean | 0.946 | 0.482 | -0.464 |
| leakage_mean | 0.38 | 0.48 | 0.1 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_150847.md`
- on.md: `reports/eval_circle_summary_20260210_150854.md`
- off.csv: `reports/eval_circle_summary_20260210_150847.csv`
- on.csv: `reports/eval_circle_summary_20260210_150854.csv`
- off.jsonl: `reports/eval_circle_20260210_150847.jsonl`
- on.jsonl: `reports/eval_circle_20260210_150854.jsonl`

- report: `reports/skinmask_ablation_20260210_150919.md`

