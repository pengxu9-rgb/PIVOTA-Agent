# FASSEG Skinmask Evaluation

- run_id: 20260211_023300
- generated_at: 2026-02-11T02:33:20.094Z
- dataset: fasseg
- onnx: artifacts/skinmask_v1.onnx
- limit: 150
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 150
- samples_ok: 150
- samples_failed: 0

## Metrics

| metric | mean | p50 | p90 |
|---|---:|---:|---:|
| skin_iou | 0.146 | 0.151 | 0.22 |
| hair_as_skin_rate | 0.009 | 0.009 | 0.013 |
| bg_as_skin_rate | 0.802 | 0.791 | 0.985 |
| skin_miss_rate | 0.576 | 0.587 | 0.759 |

## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260211_023300.md`
- csv: `reports/eval_skinmask_fasseg_20260211_023300.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260211_023300.jsonl`

