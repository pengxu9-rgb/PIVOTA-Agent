# External Datasets Prepare Report

- prepared_at: 2026-02-11T00:28:51.658Z
- raw_dir: datasets_raw
- cache_root: datasets_cache
- datasets: lapa, celebamaskhq, fasseg, acne04

| dataset | chosen_zip | sha256(12) | mtime | index_records_total | verdict | hint |
|---|---|---|---|---:|---|---|
| lapa | LaPa DB | 8e008baa2173 | 2020-10-23T10:38:16.000Z | 22168 | LIKELY_DATASET_ZIP | - |
| celebamaskhq | CelebAMask-HQ(1) | 7bf1654ac92c | 2019-05-13T03:22:38.000Z | 30000 | LIKELY_DATASET_ZIP | - |
| fasseg | FASSEG-DB | 6d971393341d | 2020-03-12T14:12:18.000Z | 151 | LIKELY_DATASET_ZIP | - |
| acne04 | ACNE DB | cdacfe2e8cd0 | 2019-12-03T14:37:59.000Z | 1457 | LIKELY_DATASET_ZIP | - |

## Notes

- Report excludes absolute filesystem paths.
- Raw images remain in cache only; no dataset files are committed.
- Generated files: `datasets_cache/manifests/*.manifest.json`, per-dataset `dataset_index.jsonl`.

