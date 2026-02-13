# Skinmask Ablation Report

- run_id: 20260210_145000
- generated_at: 2026-02-10T14:50:00.658Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 30

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.583 | 0.583 | 0 |
| coverage_mean | 0.949 | 0.949 | 0 |
| leakage_mean | 0.382 | 0.382 | 0 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_144953.md`
- on.md: `reports/eval_circle_summary_20260210_144957.md`
- off.csv: `reports/eval_circle_summary_20260210_144953.csv`
- on.csv: `reports/eval_circle_summary_20260210_144957.csv`
- off.jsonl: `reports/eval_circle_20260210_144953.jsonl`
- on.jsonl: `reports/eval_circle_20260210_144957.jsonl`

- report: `reports/skinmask_ablation_20260210_145000.md`

