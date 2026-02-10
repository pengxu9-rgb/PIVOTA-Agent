# Photo Modules Backend Acceptance

- started_at_utc: 2026-02-09T17:00:24Z
- command: `node --test tests/aurora_bff_photo_modules_acceptance.node.test.cjs`
- result: **PASS**

## Assertions

- `/v1/analysis/skin` returns `photo_modules_v1` when `used_photos=true`
- all region `coord_space` values are `face_crop_norm_v1`
- every heatmap is `64x64` with `values.length=4096` and values in `[0,1]`
- `regions[].region_id` values are unique
- all `modules[].issues[].evidence_region_ids` map to existing region ids
- payload does not include `overlay_url` or server overlay fields

## Test Output

```text
✔ /v1/analysis/skin acceptance: emits valid photo_modules_v1 payload without server overlay fields (228.24425ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 590.452333
```
