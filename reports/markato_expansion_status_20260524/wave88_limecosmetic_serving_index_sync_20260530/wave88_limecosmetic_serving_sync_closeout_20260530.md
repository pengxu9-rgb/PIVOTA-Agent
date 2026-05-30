# Wave88 LIME COSMETIC Serving Sync Closeout

Generated: 2026-05-30

## Scope

Promoted one preflight-clean `serving_index_sync` candidate:

- `ext_ba4570b613069031f940d9b2` - LIME OIL GEL EYE PATCH

## Dry Run

Artifact:

- `limecosmetic_serving_sync_dry_run.json`

Result:

- requested IDs: 1
- fetched rows: 1
- planned SKU rows: 3
- planned offer rows: 3
- planned index-state rows: 1
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0
- serving sample blocker: `none`

## Preflight Audit

Artifact:

- `limecosmetic_pdp_quality_preflight.json`

Result:

- overall status: passed
- similar count: 6
- broken images: 0

Gate status:

| seed | extractor | identity | product_intel | live_pdp | similar | variant |
| --- | --- | --- | --- | --- | --- | --- |
| passed | passed | passed | passed | passed | passed | passed |

## Apply

Artifact:

- `limecosmetic_serving_sync_apply.json`

Production apply result:

- product upserts: 1
- SKU upserts: 3
- offer upserts: 3
- index-state upserts: 1
- catalog-row-trust upserts: 1
- stale SKU deletes: 0
- stale offer deletes: 0

## Post-Sync Audit

Artifact:

- `limecosmetic_pdp_quality_after_serving_sync.json`

Result:

- overall status: passed
- similar count: 6
- broken images: 0

Gate status:

| seed | extractor | identity | product_intel | live_pdp | similar | variant |
| --- | --- | --- | --- | --- | --- | --- |
| passed | passed | passed | passed | passed | passed | passed |

## Outcome

Wave88 successfully promoted LIME OIL GEL EYE PATCH through serving/index sync with clean preflight and post-sync PDP validation.
