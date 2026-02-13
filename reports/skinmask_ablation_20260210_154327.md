# Skinmask Ablation Report

- run_id: 20260210_154327
- generated_at: 2026-02-10T15:43:27.209Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 120

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.581 | 0.578 | -0.003 |
| coverage_mean | 0.945 | 0.937 | -0.008 |
| leakage_mean | 0.39 | 0.387 | -0.003 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_154228.md`
- on.md: `reports/eval_circle_summary_20260210_154241.md`
- off.csv: `reports/eval_circle_summary_20260210_154228.csv`
- on.csv: `reports/eval_circle_summary_20260210_154241.csv`
- off.jsonl: `reports/eval_circle_20260210_154228.jsonl`
- on.jsonl: `reports/eval_circle_20260210_154241.jsonl`

- report: `reports/skinmask_ablation_20260210_154327.md`

