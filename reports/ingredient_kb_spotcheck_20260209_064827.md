# Ingredient KB Spotcheck

- Run time (UTC): 2026-02-09T06:49:16.614902Z
- Endpoint base: `https://aurora-beauty-decision-system.vercel.app`
- Sample source: `/Users/pengchydan/Desktop/product_candidates_master_v0_i18n__人工检测完毕.csv` (first 20 candidate_id rows)

## Summary
- Total sampled: **20**
- API ok=true: **20/20**
- has `raw_ingredient.original_text`: **20/20**
- cleaned shorter than original: **18/20**
- clean == original: **1/20**
- request errors: **0**

## Details

| candidate_id | ok | product_id | matched_by | count | clean_len | orig_len | same | has_original | error |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| ac1d67be62 | True | 62881b3b-6cfa-4572-b911-282165cc4e88 | crosswalk | 10 | 184 | 353 | False | True |  |
| b0e9e5ca68 | True | 2d80b5d2-1115-4aa4-9794-86cdb1854851 | crosswalk | 17 | 344 | 360 | False | True |  |
| b3425f6ae3 | True | 5d739bb7-13f2-451d-9eed-f17eef0178bc | crosswalk | 14 | 226 | 239 | False | True |  |
| 8abf82f2d2 | True | 3d2bd798-e21e-4e18-bff3-3a063f2dd1a1 | crosswalk | 20 | 450 | 450 | True | True |  |
| 82cbd61e33 | True | f67486f2-001e-49fd-960b-ab27f6745aac | crosswalk | 7 | 132 | 277 | False | True |  |
| 7dc1596732 | True | 1e204881-98c0-4d0a-b5a3-872bc8bd824a | crosswalk | 39 | 975 | 1019 | False | True |  |
| 3a5219915b | True | 8f416662-bedf-4d4a-a992-844b33479e7e | crosswalk | 12 | 146 | 154 | False | True |  |
| 342206777b | True | e5d3e968-682e-4a90-b26f-fe3bdbaf2bfd | crosswalk | 5 | 66 | 173 | False | True |  |
| ffd2621e04 | True | 0304ebfd-800f-4fe2-8dc8-71770dba3bf7 | crosswalk | 11 | 176 | 177 | False | True |  |
| b80968aaad | True | d82da71a-af3d-4cde-a184-d16c24bca490 | crosswalk | 62 | 1239 | 1300 | False | True |  |
| 51225cd269 | True | 0b22c462-d890-4271-bd20-a1fa0684262d | crosswalk | 4 | 351 | 351 | False | True |  |
| 0533a585d6 | True | 7267c101-6275-4d10-a793-0f2e74527856 | crosswalk | 18 | 338 | 355 | False | True |  |
| 437c86369d | True | bff8ba9a-70b3-4c12-8eee-cd1b9bfa9c11 | crosswalk | 17 | 343 | 359 | False | True |  |
| 0b22673f69 | True | 31a2633a-d551-4f0c-a69d-6b50243d08f0 | crosswalk | 8 | 160 | 258 | False | True |  |
| 4f47db4332 | True | 29f9fca0-136c-41a0-8be0-84e9fcb72815 | crosswalk | 24 | 513 | 536 | False | True |  |
| 3960f76c8c | True | cc132a9d-e4b8-44eb-8042-8124f4a68d71 | crosswalk | 16 | 324 | 352 | False | True |  |
| cabbdbcf88 | True | f519478f-565d-4d66-b0f6-96be4145526b | crosswalk | 18 | 406 | 423 | False | True |  |
| 477ee38aef | True | 3a8492ce-f403-47ac-991c-0554b00a0309 | crosswalk | 12 | 372 | 381 | False | True |  |
| 481addb035 | True | 0831b853-b62b-4a6b-a9ce-6bd31ba6a9ab | crosswalk | 11 | 218 | 229 | False | True |  |
| 641d84f752 | True | 284b0064-2aa0-44d7-95a8-d9a6a53cf3e4 | crosswalk | 33 | 633 | 665 | False | True |  |
