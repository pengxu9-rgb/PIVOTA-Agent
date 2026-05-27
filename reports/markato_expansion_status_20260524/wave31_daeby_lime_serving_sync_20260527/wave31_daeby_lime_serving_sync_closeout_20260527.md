# Wave31 DAEBY + LIME Serving Sync Closeout

Generated: 2026-05-27

## Scope

Processed 4 reviewed US external seeds:

- `ext_e1c4eb330321ebc6e9672d73` - DAEBY Daily Cleanser
- `ext_81f5ddbf0c3ba5da04eabf9b` - DAEBY Exfoliating Facial Scrub
- `ext_ef9930ea4e8bf403866dc73d` - LIME GIGA WHITE TONE-UP CREAM
- `ext_ba4570b613069031f940d9b2` - LIME OIL GEL EYE PATCH

## Pre-Apply Gate

- Pre-readiness: 4 scanned, 4 action required, 0 terminal holds.
- Blocker before sync: `index_doc_shadow_only: 4`.
- KB gate: 4/4 direct displayable and 4/4 direct high-quality ready.
- Identity gate: 4/4 identity ready.
- Source build failures: 0.
- Warnings: 0.

## Sync Dry-Run

- Requested ids: 4.
- Fetched rows: 4.
- Mirror rows: 4.
- Planned product/index-state rows: 4.
- Planned SKU rows: 6.
- Planned offer rows: 6.
- Missing ids: 0.
- Skipped rows: 0.
- `servingEligible=false`: 0.
- Stale SKU deletes previewed: 4.
- Stale offer deletes previewed: 4.

The stale deletes were replacement of legacy `::canonical` SKU/offer rows with source variant keyed SKU/offer rows. LIME OIL GEL EYE PATCH expanded into 3 formula variant SKUs.

## Production Apply

Production DB apply completed with reviewed identity live-read bootstrap enabled.

- Product upserts: 4.
- SKU upserts: 6.
- Offer upserts: 6.
- Product group member upserts: 4.
- Index state upserts: 4.
- Catalog row trust upserts: 4.
- Stale SKU deletes: 4.
- Stale offer deletes: 4.
- Missing/skipped rows: 0.

No `railway up` was used.

## Post-Apply Quality

Readiness after sync:

- Scanned: 4.
- DB serving ready: 4/4.
- Public dry-run docs: 4/4.
- Public docs with insight summary: 4/4.
- KB direct high-quality ready: 4/4.
- Identity ready: 4/4.
- Source build failures: 0.
- Warnings: 0.

Live PDP audit after sync:

- Scanned: 4.
- Ready: 4.
- Thin: 0.
- Not conversion ready: 0.
- Blocker counts: 0.
- Weak insights ids: 0.
- Seller-only insights ids: 0.
- Force-filled ids: 0.
- Content-gap ids: 0.

## Rollup Impact

Latest Markato production rollup after Lucamar plus DAEBY/LIME:

- Production active US rows scanned: 597.
- Catalog attached: 597/597 (100%).
- DB serving eligible: 72/597 (12.1%), up from 65 after wave29.
- Ready or covered lane: 64 rows.
- Recommended next-batch rows: 39.
- Source-gap hold rows: 136.
- Risk-hold rows: 358.

Domain coverage:

- `daebyskin.com`: 2 rows, 2 catalog attached, 2 DB serving eligible, 2 ready or covered.
- `en.limecosmetic.com`: 2 rows, 2 catalog attached, 2 DB serving eligible, 2 ready or covered.
- Both domains are 100% identity ready and 100% high-quality product-intel ready.

## Next Batch Signal

The latest recommended next batch starts with:

- `aetasofficial.com` - `ext_684249c7a94a1a6f43fdbd77` - The Serum
- `baiebotanique.com` - `ext_f11383c339335d64f05a964e` - Regenerating Eye Cream
- `coconutmatter.com` - `ext_fda8be630c6dc79ef599df3c` - NOURISHING HAND BALM
- `joocyee.com` - remaining clean `serving_index_sync` rows, but Joocyee still needs duplicate canonical identity review before write.

## Artifacts

- Candidate ids: `wave31_daeby_lime_serving_sync_candidate_ids.txt`
- Pre-readiness: `readiness_before_serving_sync/summary.json`
- Dry-run: `wave31_daeby_lime_serving_sync_dry_run.json`
- Apply: `wave31_daeby_lime_serving_sync_apply.json`
- Post-readiness: `readiness_after_serving_sync/summary.json`
- Live PDP audit: `live_pdp_modules_audit_after_serving_sync.json`
- Latest rollup: `latest_rollup_after_lucamar_daeby_lime/wave24_candidate_rollup.md`
