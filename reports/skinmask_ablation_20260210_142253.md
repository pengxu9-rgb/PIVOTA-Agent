# Skinmask Ablation Report

- run_id: 20260210_142253
- generated_at: 2026-02-10T14:22:53.206Z
- datasets: fasseg
- onnx: tmp/fake.onnx
- limit: 1

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.404 | 0.404 | 0 |
| coverage_mean | 1 | 1 | 0 |
| leakage_mean | 0.596 | 0.596 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_142252.md`
- on.md: `reports/eval_circle_summary_20260210_142253.md`
- off.csv: `reports/eval_circle_summary_20260210_142252.csv`
- on.csv: `reports/eval_circle_summary_20260210_142253.csv`
- off.jsonl: `reports/eval_circle_20260210_142252.jsonl`
- on.jsonl: `reports/eval_circle_20260210_142253.jsonl`

- report: `reports/skinmask_ablation_20260210_142253.md`

