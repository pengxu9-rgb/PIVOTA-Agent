# Skinmask Ablation Report

- run_id: 20260210_143557
- generated_at: 2026-02-10T14:35:57.270Z
- datasets: fasseg
- onnx: tmp/fake.onnx
- limit: 2

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.378 | 0.378 | 0 |
| coverage_mean | 1 | 1 | 0 |
| leakage_mean | 0.622 | 0.622 | 0 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_143556.md`
- on.md: `reports/eval_circle_summary_20260210_143557.md`
- off.csv: `reports/eval_circle_summary_20260210_143556.csv`
- on.csv: `reports/eval_circle_summary_20260210_143557.csv`
- off.jsonl: `reports/eval_circle_20260210_143556.jsonl`
- on.jsonl: `reports/eval_circle_20260210_143557.jsonl`

- report: `reports/skinmask_ablation_20260210_143557.md`

