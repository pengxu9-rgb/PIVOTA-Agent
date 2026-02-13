# Preference Release Gate

- run_id: 20260212_200001001
- generated_at: 2026-02-12T07:09:39.473Z
- eval_jsonl: `reports/eval_preference_20260212_200001001.jsonl`
- eval_md: `reports/eval_preference_20260212_200001001.md`
- eval_json: `reports/eval_preference_20260212_200001001.json`
- manifest: `artifacts/preference_round1_20260212_200001001/manifest.json`

## Verdict

- verdict: **SHIP_VARIANT1**

## Metrics

| metric | value |
|---|---:|
| overall_baseline_win_rate | 0.3 |
| overall_variant1_win_rate | 0.7 |
| overall_variant1_minus_baseline | 0.4 |
| forehead_baseline_win_rate | 0.385 |
| forehead_variant1_win_rate | 0.615 |
| forehead_variant1_minus_baseline | 0.23 |
| cannot_tell_rate | 0.115 |
| overlap_iaa_kappa | 0.455 |
| overlap_iaa_simple_agreement | 0.667 |
| overlap_samples_total | 6 |
| overlap_samples_labeled_by_2plus | 6 |

## Criteria

1. variant improvement: PASS
2. cannot_tell guard: PASS
3. overlap IAA guard: PASS

## Reasons

- no blocking reasons

## Top 20 Contentious Samples

| rank | sample_id | source | task_batch | contentious_score | cannot_tell_rate | disagreement_overlap_rate | low_confidence_rate |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | lapa_idx_4 | lapa | OVERLAP | 0.483 | 0.5 | 0.5 | 0.5 |
| 2 | celebamaskhq_idx_5 | celebamaskhq | A | 0.383 | 1 | 0 | 0 |
| 3 | lapa_idx_2 | lapa | A | 0.383 | 1 | 0 | 0 |
| 4 | 678c2af642e3d58f271a | internal | OVERLAP | 0.308 | 0 | 0.5 | 0.5 |
| 5 | 7b226ea45d70d7aa0e77 | internal | B | 0.233 | 0 | 0 | 1 |
| 6 | c5ab4e42a32fdf0c2ed7 | internal | B | 0.233 | 0 | 0 | 1 |
| 7 | celebamaskhq_idx_2 | celebamaskhq | B | 0.233 | 0 | 0 | 1 |
| 8 | celebamaskhq_idx_3 | celebamaskhq | B | 0.233 | 0 | 0 | 1 |
| 9 | celebamaskhq_idx_4 | celebamaskhq | B | 0.233 | 0 | 0 | 1 |
| 10 | lapa_idx_3 | lapa | B | 0.233 | 0 | 0 | 1 |
| 11 | lapa_idx_6 | lapa | B | 0.233 | 0 | 0 | 1 |
| 12 | 41d7d6a4bfe8949413b9 | internal | OVERLAP | 0.133 | 0 | 0 | 0.5 |
| 13 | 85ca93eecf3b21be0662 | internal | OVERLAP | 0.133 | 0 | 0 | 0.5 |
| 14 | lapa_idx_1 | lapa | OVERLAP | 0.133 | 0 | 0 | 0.5 |
| 15 | lapa_idx_7 | lapa | OVERLAP | 0.133 | 0 | 0 | 0.5 |
| 16 | a213e09b7b8a33adc6e9 | internal | A | 0.033 | 0 | 0 | 0 |
| 17 | ab317a1473400cffad2b | internal | A | 0.033 | 0 | 0 | 0 |
| 18 | celebamaskhq_idx_1 | celebamaskhq | A | 0.033 | 0 | 0 | 0 |
| 19 | celebamaskhq_idx_6 | celebamaskhq | A | 0.033 | 0 | 0 | 0 |
| 20 | lapa_idx_5 | lapa | A | 0.033 | 0 | 0 | 0 |

## Artifact

- release_gate_report: `reports/RELEASE_GATE_PREFERENCE_20260212_200001001.md`

