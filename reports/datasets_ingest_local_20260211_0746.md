# Local Dataset Ingest Report

- run_id: 20260211_0746
- generated_at: 2026-02-11T07:46:06.570Z
- datasets: lapa, celebamaskhq
- cache_root: datasets_cache

| dataset | status | records | scan_mode | preflight_fail_rate | index_path | message |
|---|---|---:|---|---:|---|---|
| lapa | PASS | 22168 | preferred:lapa_train_val_test_images | 0.0% | datasets_cache/lapa/index.jsonl | OK |
| celebamaskhq | PASS | 30000 | generic_cluster:. | 0.0% | datasets_cache/celebamaskhq/index.jsonl | OK |

## Preflight Sample Errors (Top 5 per dataset)

| dataset | reason_detail | image_path | message |
|---|---|---|---|
| - | - | - | - |

## Notes

- Index rows contain local relative `image_path` and `source_root` only (no URLs).
- If reason_detail is `LOCAL_FILE_NOT_READY`, run “Download Now” in Finder for the dataset folder.

