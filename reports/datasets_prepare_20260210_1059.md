# External Datasets Prepare Report

- prepared_at: 2026-02-10T10:59:12.269Z
- raw_dir: datasets_raw
- cache_root: datasets_cache
- datasets: lapa, celebamaskhq, fasseg, acne04

| dataset | status | source | sha256(12) | records | images/masks/annos | class_count | split_summary | unzip_mode |
|---|---:|---|---|---:|---|---:|---|---|
| lapa | PASS | LaPa DB | 8e008baa2173 | 22168 | 22168/22168/0 | 11 | unknown:19373, test:643, train:2152 | source_directory |
| celebamaskhq | WARN | CelebAMask-HQ(1) | 1287f1882d8d | 0 | 0/0/0 | 18 | - | source_directory |
| fasseg | WARN | FASSEG-DB-v2019 | 6d971393341d | 0 | 0/0/0 | 6 | - | source_directory |
| acne04 | PASS | ACNE DB | cdacfe2e8cd0 | 1457 | 1457/0/1457 | 2 | unknown:1457 | source_directory |

## Notes

- Report excludes absolute filesystem paths.
- Raw images remain in cache only; no dataset files are committed.
- Generated files: `datasets_cache/manifests/*.manifest.json`, per-dataset `dataset_index.jsonl`.

