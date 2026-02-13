# LaPa Local Fail Triage

- run_id: 20260211_105639451
- generated_at: 2026-02-12T00:05:32.211Z
- fail_rows: 4

## Reason Distribution

| reason_detail | count |
|---|---:|
| LOCAL_DIAGNOSIS_FAIL | 4 |

## Fail Rows

| sample_hash | image_path_rel | fail_reason | reason_detail | error_code | stack_snippet |
|---|---|---|---|---|---|
| 32d8cd3c6c6ffe744890 | source_root/train/images/821414027_0.jpg | LOCAL_DIAGNOSIS_FAIL | - | - | skin_roi_not_found |
| ae68a00e1f3d262db1e7 | source_root/train/images/HELEN_2589809231_1_0.jpg | LOCAL_DIAGNOSIS_FAIL | - | - | skin_roi_not_found |
| d48ed36d3042fb9b763f | source_root/train/images/LFPW_image_test_0183_3.jpg | LOCAL_DIAGNOSIS_FAIL | - | - | skin_roi_not_found |
| 5ff836d1a25d3d271a1f | source_root/train/images/11108421124_8.jpg | LOCAL_DIAGNOSIS_FAIL | - | - | skin_roi_too_small |

## Reproduce One Sample

```bash
node scripts/triage_one_sample.mjs --source lapa --sample_hash <hash> --review_jsonl reports/review_pack_mixed_20260211_105639451.jsonl
```

