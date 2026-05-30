# Wave85 7 Journeys Serving Index Sync Closeout

Generated: 2026-05-30

## Scope

Promoted two 7 Journeys rows that were already source-backed, identity-ready, and product-intel-ready, but still sat in the `serving_index_sync` lane.

Exact target IDs:

- `ext_2da51d2f8d19211c89fb2a30` - 7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets)
- `ext_d55c93a9feb384ac9e0bde40` - 7 Journeys Antarctic Timeless Serum 45ml (Hydration & Anti-aging)

This was a serving/index sync only. No source content, identity override, or force promotion was applied.

## Dry Run

Artifact:

- `7journeys_serving_sync_dry_run.json`

Result:

- requested IDs: 2
- fetched rows: 2
- mirror rows: 2
- planned SKU rows: 2
- planned offer rows: 2
- planned index-state rows: 2
- missing IDs: 0
- skipped rows: 0
- serving-eligible samples: 2/2
- blocker codes: `none`
- stale SKU deletes planned: 0
- stale offer deletes planned: 0
- audit reasons: `no_strong_identifier=2`

## Apply

Artifact:

- `7journeys_serving_sync_apply.json`

Production apply result:

- product upserts: 2
- SKU upserts: 2
- offer upserts: 2
- group-member upserts: 2
- index-state upserts: 2
- catalog-row-trust upserts: 2
- stale SKU deletes: 0
- stale offer deletes: 0
- missing IDs: 0
- skipped rows: 0

## Live PDP Audit

Artifacts:

- `miracle_glow_mask_pdp_quality_after_serving_sync.json`
- `antarctic_timeless_serum_pdp_quality_after_serving_sync.json`

Fresh post-sync live PDP result:

- scanned: 2
- passed: 2
- failed: 0
- broken images: 0

Gate status:

| external_product_id | seed | extractor | identity | product_intel | live_pdp | similar | variant | image_count |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| `ext_2da51d2f8d19211c89fb2a30` | passed | passed | passed | passed | passed | passed | passed | 12 |
| `ext_d55c93a9feb384ac9e0bde40` | passed | passed | passed | passed | passed | passed | passed | 9 |

## Outcome

Wave85 moved both 7 Journeys rows through serving/index sync with clean dry-run, clean production apply, and clean live PDP validation.

No residual Wave85 holds remain.
