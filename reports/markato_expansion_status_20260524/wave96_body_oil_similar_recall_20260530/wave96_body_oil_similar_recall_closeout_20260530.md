# Markato Wave96 Body-Oil Similar Recall Closeout - 2026-05-30

## Scope

Wave96 addressed a runtime similar-products underfill that was blocking source-recovered body-oil PDPs from passing the live PDP quality gate.

This wave did not change production seed data and did not remove any existing holds. The change is a narrow runtime recall repair in `src/services/RecommendationEngine.js`.

## Root Cause

Catalog-only PDP similar recall was constrained to the exact `catalog_products.category_path` whenever the base PDP had a canonical catalog path.

Sparse body-oil categories therefore returned only exact body-oil siblings. OILUJ recovered blend rows had enough source-backed PDP content, but their similar rail underfilled because `body_oil` was not allowed to expand into adjacent body lotion, body cream, body balm, body moisturizer, or massage oil siblings.

Existing intent-family expansion was only enabled for:

- `eye_cream`
- `lash_mascara`

The existing expansion SQL also included an eye-category-path fallback. Wave96 made that fallback intent-aware so adding `body_oil` does not admit unrelated eye-care rows.

## Runtime Change

Updated `shouldExpandCatalogPathByIntentFamily()` to include `body_oil`.

Added `buildCatalogIntentExpansionPredicates()` so:

- all expanded intent families use strict title-backed SQL LIKE patterns;
- only `eye_cream` keeps the category-path fallback `LIKE '%eye%'`;
- `body_oil` expansion remains title-backed and vertical-scoped.

## Production Dry Verification

Command shape:

```bash
railway run --service Postgres-xMr6 --environment production -- bash -lc 'cd /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527 && export DATABASE_URL="$DATABASE_PUBLIC_URL" && export NODE_PATH=/private/tmp/markato-wave-node-deps/node_modules:/Users/pengchydan/dev/PIVOTA-Agent/node_modules && node ...'
```

The probe used production data with the patched local runtime code and no writes.

| External product ID | Product lane | Similar count after patch | Status |
| --- | --- | ---: | --- |
| `ext_1493a61baf165a6c00e4977b` | OILUJ Life Oil Organic Moringa / French Lavender Blend | 15 | Ready by similar count |
| `ext_07cfaab25950196c3ec1b5f3` | OILUJ Life Oil Organic Moringa / Sandalwood Blend | 15 | Ready by similar count |
| `ext_664b859ce2599a57c3f1f7ce` | UpCircle Body Oil | 6 | Ready by similar count |

Representative returned OILUJ cards included exact body-oil and adjacent body cream/lotion/moisturizer products, all from `catalog_products` and `external_seed` catalog-only recall.

Representative UpCircle cards included body lotion and body-oil siblings from UpCircle, KHUS KHUS, Apiceuticals, Lhamour, and First Aid Beauty.

## Local Verification

```bash
node --check src/services/RecommendationEngine.js
npx jest tests/recommendations/pdp_recommendations_external_fetch.test.js --runInBand
```

Result:

- `RecommendationEngine.js` syntax check passed.
- `pdp_recommendations_external_fetch.test.js`: 67 passed.

## Deployment And Hold Cleanup

Wave96 runtime commit deployed to production:

- commit: `55705f4adb32e35f5b0e0ad8d099f3c0ebeab8af`
- production `/version` build: `55705f4adb32`
- deployment id: `32a4f636-b282-44c0-b74d-d97972ef3db7`

Pre-unhold audit by external product ID returned live PDP `404`, which was expected while the rows were still blocked by `content_evidence_hold`.

After production was on Wave96, the exact-ID hold clear ran dry-run first:

- requested: 3
- scanned: 3
- rows with hold marker: 3
- missing IDs: 0
- expected reasons:
  - `post_sync_audit_failed_similar_gate`
  - `post_repair_audit_failed_similar_gate`

Apply then removed `content_evidence_hold_v1` from exactly three `external_product_seeds` rows. Follow-up verification confirmed both top-level and snapshot hold markers were removed.

Exact-ID serving sync then ran dry-run first and computed:

- mirror rows: 3
- planned SKU rows: 4
- planned offer rows: 4
- planned index rows: 3
- skipped: 0
- all three rows: `servingEligible=true`, `blockerCode=none`, `contentQualityScore=90`

Apply result:

- product upserts: 3
- SKU upserts: 4
- offer upserts: 4
- group member upserts: 3
- index state upserts: 3
- catalog row trust upserts: 3
- stale deletes: 0

## Post-Sync Verification

The public audit script continued to return `404` when probing through the public gateway by external product ID. The authoritative invoke endpoint required an API key not present in the Postgres helper env.

A direct public gateway probe by Pivota signature ID was therefore used for final live validation:

- gateway: `https://agent.pivota.cc/api/gateway`
- PDP operation: `get_pdp_v2`
- similar operation: `find_similar_products`
- options: `debug=true`, `no_cache=true`, `cache_bypass=true`, `similar_cache_bypass=true`

Result:

| External product ID | Signature ID | PDP status | Similar status | Visible similar count |
| --- | --- | --- | --- | ---: |
| `ext_1493a61baf165a6c00e4977b` | `sig_7425ea0bd58897136a79c57d82861652` | `success` | `ready` | 6 |
| `ext_07cfaab25950196c3ec1b5f3` | `sig_9cbfd2cd3c09bb3b811b81c806b60f57` | `success` | `ready` | 6 |
| `ext_664b859ce2599a57c3f1f7ce` | `sig_e434b90902740f110390a11d` | `success` | `ready` | 6 |

Summary:

- probed: 3
- PDP success: 3
- similar ready: 3
- minimum visible similar count: 6
- failures: 0

Artifacts:

- `clear_content_evidence_hold_dry_run.json`
- `clear_content_evidence_hold_apply.json`
- `sync_after_clear_dry_run.json`
- `sync_after_clear_apply.json`
- `direct_public_gateway_sig_probes_after_sync.json`

## Holds Removed In This Wave

The following rows were unheld and resynced to serving after Wave96 deployment and verification:

- `ext_1493a61baf165a6c00e4977b`
- `ext_07cfaab25950196c3ec1b5f3`
- `ext_664b859ce2599a57c3f1f7ce`

## Next Move

Continue expansion with the next source-gap or similar-underfill lane. Body-oil similar recall is no longer the blocker for these three rows.
