# Skinmask Ablation Report

- run_id: 20260210_152213
- generated_at: 2026-02-10T15:22:13.110Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.584 | -0.003 |
| coverage_mean | 0.946 | 0.939 | -0.007 |
| leakage_mean | 0.38 | 0.379 | -0.001 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_152143.md`
- on.md: `reports/eval_circle_summary_20260210_152150.md`
- off.csv: `reports/eval_circle_summary_20260210_152143.csv`
- on.csv: `reports/eval_circle_summary_20260210_152150.csv`
- off.jsonl: `reports/eval_circle_20260210_152143.jsonl`
- on.jsonl: `reports/eval_circle_20260210_152150.jsonl`

- report: `reports/skinmask_ablation_20260210_152213.md`

