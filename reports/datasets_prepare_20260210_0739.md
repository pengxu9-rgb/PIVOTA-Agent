# External Datasets Prepare Report

- prepared_at: 2026-02-10T07:39:36.414Z
- raw_dir: datasets_raw
- cache_root: datasets_cache
- datasets: lapa, celebamaskhq, fasseg, acne04

| dataset | status | zip | sha256(12) | records | images/masks/annos | class_count | split_summary | unzip_mode |
|---|---:|---|---|---:|---|---:|---|---|
| lapa | PASS | LAPA.zip | f5d01f5180dd | 205 | 205/9/0 | 11 | unknown:198, val:7 | node_unzipper |
| celebamaskhq | WARN | CelebAMask-HQ.zip | 735dad422a89 | 0 | 0/0/0 | 18 | - | node_unzipper |
| fasseg | WARN | FASSEG.zip | 8a17faefc099 | 0 | 0/0/0 | 6 | - | node_unzipper |
| acne04 | WARN | acne04.zip | 9100e4558a56 | 0 | 0/0/0 | 2 | - | node_unzipper |

## Notes

- Report excludes absolute filesystem paths.
- Raw images remain in cache only; no dataset files are committed.
- Generated files: `datasets_cache/manifests/*.manifest.json`, per-dataset `dataset_index.jsonl`.

