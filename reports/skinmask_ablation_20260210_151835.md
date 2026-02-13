# Skinmask Ablation Report

- run_id: 20260210_151835
- generated_at: 2026-02-10T15:18:35.586Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.419 | -0.168 |
| coverage_mean | 0.946 | 0.65 | -0.296 |
| leakage_mean | 0.38 | 0.358 | -0.022 |
| skin_roi_too_small_rate | 0.001 | 0.137 | 0.136 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_151805.md`
- on.md: `reports/eval_circle_summary_20260210_151812.md`
- off.csv: `reports/eval_circle_summary_20260210_151805.csv`
- on.csv: `reports/eval_circle_summary_20260210_151812.csv`
- off.jsonl: `reports/eval_circle_20260210_151805.jsonl`
- on.jsonl: `reports/eval_circle_20260210_151812.jsonl`

- report: `reports/skinmask_ablation_20260210_151835.md`

