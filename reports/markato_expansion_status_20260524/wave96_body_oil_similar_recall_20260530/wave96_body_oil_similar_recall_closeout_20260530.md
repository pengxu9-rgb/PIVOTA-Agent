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

## Holds Not Removed In This Wave

The following rows remain held until this runtime change is deployed through Git and fresh live PDP quality audits pass:

- `ext_1493a61baf165a6c00e4977b`
- `ext_07cfaab25950196c3ec1b5f3`
- `ext_664b859ce2599a57c3f1f7ce`

Do not clear `content_evidence_hold_v1` for these rows before production `/version` reflects the Wave96 commit and live PDP audits confirm `similar_gate.status=passed`.

## Next Move

1. Commit and push Wave96 through Git only.
2. Wait for production `/version` to catch the Wave96 commit.
3. Rerun live PDP quality audits for the three body-oil rows.
4. If live audits pass, clear the exact-ID content evidence holds and resync serving state.
