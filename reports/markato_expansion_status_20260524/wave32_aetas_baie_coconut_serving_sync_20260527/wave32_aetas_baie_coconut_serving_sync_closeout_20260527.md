# Wave32 Aetas + Baie Botanique + Coconut Matter Serving Sync Closeout

Generated: 2026-05-27

## Scope

Processed 3 reviewed US external seeds:

- `ext_684249c7a94a1a6f43fdbd77` - Aetas - The Serum
- `ext_f11383c339335d64f05a964e` - Baie Botanique - Regenerating Eye Cream
- `ext_fda8be630c6dc79ef599df3c` - Coconut Matter - NOURISHING HAND BALM

## Pre-Apply Gate

- Pre-readiness: 3 scanned, 3 action required, 0 terminal holds.
- Blocker before sync: `index_doc_shadow_only: 3`.
- KB gate: 3/3 direct displayable and 3/3 direct high-quality ready.
- Identity gate: 3/3 identity ready.
- Source build failures: 0.
- Warnings: 0.

## Runtime Category Quality Fix

The first dry-run exposed a PDP quality issue for Baie Botanique Regenerating Eye Cream: stale source category metadata would have written `Bronzer / beauty/makeup/face/bronzer`.

Before production apply, the sync classifier was patched to let high-confidence title terms such as `eye cream`, `eye serum`, and `eye treatment` override stale makeup metadata before makeup rules run. The regression test file `tests/scripts/sync_external_seeds_to_catalog.test.js` now covers both stale metadata and stale product-type paths.

Targeted test result:

- `npx jest tests/scripts/sync_external_seeds_to_catalog.test.js --runInBand`
- 25 passed.

Final dry-run and apply both wrote Baie Botanique Regenerating Eye Cream as:

- Product type: `Eye Treatment`
- Category: `Eye Treatment`
- Category path: `beauty/skincare/eye-care`

## Final Sync Dry-Run

- Requested ids: 3.
- Fetched rows: 3.
- Mirror rows: 3.
- Planned product/index-state rows: 3.
- Planned SKU rows: 6.
- Planned offer rows: 6.
- Missing ids: 0.
- Skipped rows: 0.
- `servingEligible=false`: 0.
- Stale SKU deletes previewed: 2.
- Stale offer deletes previewed: 2.

The stale deletes were replacement of legacy `::canonical` SKU/offer rows with source variant keyed SKU/offer rows for Aetas The Serum and Coconut Matter NOURISHING HAND BALM.

## Production Apply

Production DB apply completed with reviewed identity live-read bootstrap enabled.

- Product upserts: 3.
- SKU upserts: 6.
- Offer upserts: 6.
- Product group member upserts: 3.
- Index state upserts: 3.
- Catalog row trust upserts: 3.
- Stale SKU deletes: 2.
- Stale offer deletes: 2.
- Missing/skipped rows: 0.

No `railway up` was used.

## Post-Apply Quality

Readiness after sync:

- Scanned: 3.
- DB serving ready: 3/3.
- Public dry-run docs: 3/3.
- Public docs with insight summary: 3/3.
- KB direct high-quality ready: 3/3.
- Identity ready: 3/3.
- Source build failures: 0.
- Warnings: 0.

Live PDP audit after sync:

- Scanned: 3.
- Ready: 3.
- Thin: 0.
- Not conversion ready: 0.
- Blocker counts: 0.
- Weak insights ids: 0.
- Seller-only insights ids: 0.
- Force-filled ids: 0.
- Content-gap ids: 0.

## Rollup Impact

Latest Markato production rollup after Wave32:

- Production active US rows scanned: 597.
- Catalog attached: 597/597 (100%).
- DB serving eligible: 75/597 (12.6%), up from 72 after Wave31.
- Ready or covered lane: 67 rows.
- Recommended next-batch rows: 36.
- Source-gap hold rows: 136.
- Risk-hold rows: 358.

Domain coverage after Wave32:

- `aetasofficial.com`: 1 row, 1 DB serving eligible, 1 ready or covered.
- `baiebotanique.com`: 12 rows, 1 DB serving eligible, 1 ready or covered.
- `coconutmatter.com`: 7 rows, 1 DB serving eligible, 1 ready or covered.

## Next Batch Signal

The next recommended rows are dominated by Joocyee clean `serving_index_sync` rows, but Joocyee should still be treated as a focused identity/dedupe review wave because the prior gate block found duplicate canonical identity risk.

Non-Joocyee clean candidates now visible near the top:

- `joujoubotanicals.com` - `ext_83ec9657a96effaf0923f850` - APHRODITE Body Oil
- `joujoubotanicals.com` - `ext_de5c3d5849b1256eca4a7566` - FLORAL FILTER Face Mask
- `lovemasami.com` - `ext_53cf4f0ee46873d280f632db` - Mekabu Hydrating Shine Serum

## Artifacts

- Candidate ids: `wave32_aetas_baie_coconut_serving_sync_candidate_ids.txt`
- Pre-readiness: `readiness_before_serving_sync/summary.json`
- Dry-run: `wave32_aetas_baie_coconut_serving_sync_dry_run.json`
- Apply: `wave32_aetas_baie_coconut_serving_sync_apply.json`
- Post-readiness: `readiness_after_serving_sync/summary.json`
- Live PDP audit: `live_pdp_modules_audit_after_serving_sync.json`
- Latest rollup: `latest_rollup_after_wave32/wave24_candidate_rollup.md`
