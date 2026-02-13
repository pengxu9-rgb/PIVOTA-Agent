# Preference Import QC

- run_id: 20260212_200001001
- generated_at: 2026-02-12T07:09:04.161Z
- input: `artifacts/preference_round1_20260212_200001001/label_studio_export_preference_20260212_200001001.json`
- output: `artifacts/preference_round1_20260212_200001001/preference_labels.ndjson`

## Summary

| metric | value |
|---|---:|
| imported_rows | 26 |
| rows_with_required_fields | 26 |
| rows_missing_required_fields | 0 |
| rows_with_invalid_choices | 0 |
| total_invalid_choice_count | 0 |
| missing_confidence_count | 0 |
| cannot_tell_rate | 0.115 |

## Per Annotator

| rater_id | labeled_rows | labeled_samples |
|---|---:|---:|
| rater_6c94e35ccc35 | 13 | 13 |
| rater_fe675fe7aaee | 13 | 13 |

## Top QC Issues

| rank | sample_id | source | rater_id | task_batch | has_required_fields | invalid_choice_count | confidence_int | winner | notes |
|---:|---|---|---|---|---|---:|---:|---|---|
| 1 | 41d7d6a4bfe8949413b9 | internal | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | variant1 | batch-A |
| 2 | 41d7d6a4bfe8949413b9 | internal | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | variant1 | batch-B |
| 3 | 678c2af642e3d58f271a | internal | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | tie | batch-A |
| 4 | 678c2af642e3d58f271a | internal | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | baseline | batch-B |
| 5 | 7b226ea45d70d7aa0e77 | internal | rater_6c94e35ccc35 | B | true | 0 | 2 | variant1 | batch-B |
| 6 | 85ca93eecf3b21be0662 | internal | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | baseline | batch-A |
| 7 | 85ca93eecf3b21be0662 | internal | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | baseline | batch-B |
| 8 | a213e09b7b8a33adc6e9 | internal | rater_fe675fe7aaee | A | true | 0 | 4 | variant1 | batch-A |
| 9 | ab317a1473400cffad2b | internal | rater_fe675fe7aaee | A | true | 0 | 4 | tie | batch-A |
| 10 | c5ab4e42a32fdf0c2ed7 | internal | rater_6c94e35ccc35 | B | true | 0 | 2 | baseline | batch-B |
| 11 | celebamaskhq_idx_1 | celebamaskhq | rater_fe675fe7aaee | A | true | 0 | 4 | variant1 | batch-A |
| 12 | celebamaskhq_idx_2 | celebamaskhq | rater_6c94e35ccc35 | B | true | 0 | 2 | variant1 | batch-B |
| 13 | celebamaskhq_idx_3 | celebamaskhq | rater_6c94e35ccc35 | B | true | 0 | 2 | variant1 | batch-B |
| 14 | celebamaskhq_idx_4 | celebamaskhq | rater_6c94e35ccc35 | B | true | 0 | 2 | baseline | batch-B |
| 15 | celebamaskhq_idx_5 | celebamaskhq | rater_fe675fe7aaee | A | true | 0 | 4 | cannot_tell | batch-A |
| 16 | celebamaskhq_idx_6 | celebamaskhq | rater_fe675fe7aaee | A | true | 0 | 4 | variant1 | batch-A |
| 17 | lapa_idx_1 | lapa | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | variant1 | batch-A |
| 18 | lapa_idx_1 | lapa | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | variant1 | batch-B |
| 19 | lapa_idx_2 | lapa | rater_fe675fe7aaee | A | true | 0 | 4 | cannot_tell | batch-A |
| 20 | lapa_idx_3 | lapa | rater_6c94e35ccc35 | B | true | 0 | 2 | baseline | batch-B |
| 21 | lapa_idx_4 | lapa | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | cannot_tell | batch-A |
| 22 | lapa_idx_4 | lapa | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | variant1 | batch-B |
| 23 | lapa_idx_5 | lapa | rater_fe675fe7aaee | A | true | 0 | 4 | tie | batch-A |
| 24 | lapa_idx_6 | lapa | rater_6c94e35ccc35 | B | true | 0 | 2 | variant1 | batch-B |
| 25 | lapa_idx_7 | lapa | rater_fe675fe7aaee | OVERLAP | true | 0 | 4 | variant1 | batch-A |
| 26 | lapa_idx_7 | lapa | rater_6c94e35ccc35 | OVERLAP | true | 0 | 2 | variant1 | batch-B |

