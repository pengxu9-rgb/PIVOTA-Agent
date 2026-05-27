# Wave24 Markato Serving Sync Closeout

Generated: 2026-05-27

## Scope

Expanded production live PDP coverage for 25 Markato merchant SKUs across 5 brands:

- 7Journeys: 5 SKUs
- Abyssian: 5 SKUs
- Apiceuticals: 5 SKUs
- KHUS KHUS: 5 SKUs
- Lhamour: 5 SKUs

Selection gate:

- active US external seed
- catalog attached
- approved/live identity
- high-quality direct product-intel KB
- source-backed formula/content fields present
- no source gap flags after reading canonical `pdp_*` fields

No `railway up` was used. Production actions were executed through `railway run` only.

## Production Apply

Command class:

- `scripts/sync-external-seeds-to-catalog.cjs`
- exact `external_product_id` list from `wave24_serving_sync_candidate_ids.txt`
- `--upsert-serving-state`
- `--bootstrap-reviewed-identity-live-read`

Apply result:

- requested IDs: 25
- fetched rows: 25
- mirror rows: 25
- missing/skipped: 0/0
- product upserts: 25
- SKU upserts: 29
- offer upserts: 29
- group member upserts: 25
- index state upserts: 25
- catalog row trust upserts: 25
- stale canonical SKU deletes: 11
- stale canonical offer deletes: 11

The stale deletes replaced old canonical placeholder rows with current source variant rows.

## Verification

Post-apply commerce/index readiness:

- scanned rows: 25
- DB serving ready: 25/25
- public index ready: 25/25
- action required: 0
- terminal holds: 0
- direct high-quality KB: 25/25
- identity ready: 25/25
- public commerce dry-run docs: 25
- docs with Pivota insight summary: 25
- source build failures: 0
- warnings: 0

Live PDP modules audit:

- scanned: 25
- ready: 25
- thin: 0
- not_conversion_ready: 0
- weak insights: 0
- seller-only insights: 0
- force-filled insights: 0
- content gaps: 0

## Updated Wave24 Rollup

Latest production rollup after apply:

- scanned active US rows in Markato candidate scope: 597
- domains with rows: 31
- catalog attached: 597/597
- index serving eligible: 42/597
- identity ready: 304/597
- high-quality product-intel: 356/597
- ready_or_covered lane: 34
- remaining serving_index_sync candidates: 56
- remaining source-gap holds: 136
- remaining risk holds: 358

Recommended next exact-SKU lanes remain available for:

- 786 Cosmetics: 9 serving sync candidates plus source gaps
- Joocyee: 17 serving sync candidates, but product-intel coverage should be checked before broad apply
- Nala Care / Delicate Daisys: partial serving sync plus quality/risk holds
- Active Drip / Coconut Matter / DAEBY / LIME / Aetas: smaller exact serving sync batches

## Artifacts

- `wave24_candidate_rollup.json`
- `wave24_domain_rollup.csv`
- `wave24_product_gaps.csv`
- `wave24_serving_sync_candidate_ids.txt`
- `wave24_serving_sync_dry_run.json`
- `wave24_serving_sync_apply.json`
- `readiness_before_serving_sync/`
- `readiness_after_serving_sync/`
- `live_pdp_modules_audit_after_serving_sync.json`
