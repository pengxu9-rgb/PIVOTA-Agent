# Skinmask Ablation Report

- run_id: 20260210_152356
- generated_at: 2026-02-10T15:23:56.672Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.576 | -0.011 |
| coverage_mean | 0.946 | 0.926 | -0.021 |
| leakage_mean | 0.38 | 0.376 | -0.004 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_152326.md`
- on.md: `reports/eval_circle_summary_20260210_152333.md`
- off.csv: `reports/eval_circle_summary_20260210_152326.csv`
- on.csv: `reports/eval_circle_summary_20260210_152333.csv`
- off.jsonl: `reports/eval_circle_20260210_152326.jsonl`
- on.jsonl: `reports/eval_circle_20260210_152333.jsonl`

- report: `reports/skinmask_ablation_20260210_152356.md`

