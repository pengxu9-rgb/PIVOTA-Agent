# Skinmask Ablation Report

- run_id: 20260210_151749
- generated_at: 2026-02-10T15:17:49.052Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.306 | -0.281 |
| coverage_mean | 0.946 | 0.468 | -0.478 |
| leakage_mean | 0.38 | 0.347 | -0.033 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_151714.md`
- on.md: `reports/eval_circle_summary_20260210_151722.md`
- off.csv: `reports/eval_circle_summary_20260210_151714.csv`
- on.csv: `reports/eval_circle_summary_20260210_151722.csv`
- off.jsonl: `reports/eval_circle_20260210_151714.jsonl`
- on.jsonl: `reports/eval_circle_20260210_151722.jsonl`

- report: `reports/skinmask_ablation_20260210_151749.md`

