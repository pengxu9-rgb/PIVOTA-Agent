# Skinmask Ablation Report

- run_id: 20260210_152316
- generated_at: 2026-02-10T15:23:16.369Z
- datasets: fasseg,lapa,celebamaskhq
- onnx: artifacts/skinmask_v1.onnx
- limit: 60

| metric | skinmask_off | skinmask_on | delta(on-off) |
|---|---:|---:|---:|
| module_mIoU_mean | 0.587 | 0.586 | -0.001 |
| coverage_mean | 0.946 | 0.945 | -0.002 |
| leakage_mean | 0.38 | 0.38 | 0 |
| skin_roi_too_small_rate | 0 | 0 | 0 |
| face_detect_fail_rate | 0 | 0 | 0 |

## Eval Artifacts

- off.md: `reports/eval_circle_summary_20260210_152232.md`
- on.md: `reports/eval_circle_summary_20260210_152239.md`
- off.csv: `reports/eval_circle_summary_20260210_152232.csv`
- on.csv: `reports/eval_circle_summary_20260210_152239.csv`
- off.jsonl: `reports/eval_circle_20260210_152232.jsonl`
- on.jsonl: `reports/eval_circle_20260210_152239.jsonl`

- report: `reports/skinmask_ablation_20260210_152316.md`

