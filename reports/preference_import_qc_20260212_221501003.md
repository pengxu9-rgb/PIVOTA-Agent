# Preference Import QC

- run_id: 20260212_221501003
- generated_at: 2026-02-12T23:36:57.301Z
- inputs:
  - `artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json`
- output: `artifacts/preference_round1_20260212_221501003/preference_labels.ndjson`

## Summary

| metric | value |
|---|---:|
| input_exports | 1 |
| raw_rows | 20 |
| imported_rows | 20 |
| duplicate_rows_dropped | 0 |
| rows_with_required_fields | 20 |
| rows_missing_required_fields | 0 |
| rows_with_invalid_choices | 0 |
| total_invalid_choice_count | 0 |
| missing_confidence_count | 0 |
| cannot_tell_rate | 0.25 |

## Per Annotator

| rater_id | labeled_rows | labeled_samples |
|---|---:|---:|
| rater_16dc368a89b4 | 20 | 20 |

## Top QC Issues

| rank | sample_id | module_id | source | source_export_file | rater_id | task_batch | has_required_fields | invalid_choice_count | confidence_int | winner | notes |
|---:|---|---|---|---|---|---|---|---:|---:|---|---|
| 1 | 2dd66d3a38cb93d44231 | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 4 | baseline | smoke-note-14 |
| 2 | 5312a4f985e1d37718d0 | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 5 | cannot_tell | smoke-note-16 |
| 3 | bc6eac20bbd9646293a6 | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 3 | cannot_tell | smoke-note-8 |
| 4 | bd40dc07041cc3fc37cf | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 5 | baseline | smoke-note-10 |
| 5 | c69e3f01fb22d037b89e | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 2 | baseline | smoke-note-2 |
| 6 | c9f01cdb0edc5047d390 | overall | internal | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 3 | tie | smoke-note-3 |
| 7 | celebamaskhq_091d02e9e84ef6afa1444be1 | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 4 | cannot_tell | smoke-note-4 |
| 8 | celebamaskhq_3c61062163b7c86f48629912 | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 2 | variant1 | smoke-note-17 |
| 9 | celebamaskhq_545c2c29a045da8358d0d30b | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 4 | baseline | smoke-note-9 |
| 10 | celebamaskhq_5654ed29ec21240d9e02b9d7 | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 5 | cannot_tell | smoke-note-20 |
| 11 | celebamaskhq_5ce3df29bd183e29b7a4ac5e | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 2 | tie | smoke-note-7 |
| 12 | celebamaskhq_68d5cc9d7e8b27307d8e546a | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 4 | tie | smoke-note-19 |
| 13 | celebamaskhq_b6395251d09e9d886fe6dd5a | overall | celebamaskhq | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 5 | tie | smoke-note-11 |
| 14 | lapa_1c1b88eac93e8b27985f5616 | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 5 | tie | smoke-note-15 |
| 15 | lapa_2bd77b8c8eeb4569b6bf296f | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | A | true | 0 | 3 | baseline | smoke-note-13 |
| 16 | lapa_3dec769b833ec7051b102159 | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 2 | cannot_tell | smoke-note-12 |
| 17 | lapa_47b96f99409e5ff6e99b65ac | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 5 | variant1 | smoke-note-1 |
| 18 | lapa_a3b498b64e0d8909cb4c7887 | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 5 | variant1 | smoke-note-6 |
| 19 | lapa_aaca1ed5e0aa6f76bbebeb8b | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | OVERLAP | true | 0 | 5 | baseline | smoke-note-5 |
| 20 | lapa_e6ed8fc0d32e9b790395fd4c | overall | lapa | artifacts/preference_round1_20260212_221501003/label_studio_export_preference_20260212_221501003.json | rater_16dc368a89b4 | B | true | 0 | 3 | baseline | smoke-note-18 |

