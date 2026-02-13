# FASSEG Skinmask Evaluation

- run_id: 20260211_023227
- generated_at: 2026-02-11T02:32:28.883Z
- dataset: fasseg
- onnx: artifacts/skinmask_v1.onnx
- limit: 10
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 10
- samples_ok: 10
- samples_failed: 0

## Metrics

| metric | mean | p50 | p90 |
|---|---:|---:|---:|
| skin_iou | 0.044 | 0.012 | 0.124 |
| hair_as_skin_rate | 0.004 | 0.001 | 0.006 |
| bg_as_skin_rate | 0.947 | 0.985 | 0.992 |
| skin_miss_rate | 0.619 | 0.682 | 0.841 |

## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260211_023227.md`
- csv: `reports/eval_skinmask_fasseg_20260211_023227.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260211_023227.jsonl`

