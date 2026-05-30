# Wave81 Coconut Matter Similar Underfill Closeout - 2026-05-30

## Scope

Targeted the Wave79 similar-underfill lane for Coconut Matter lip PDPs:

- `ext_c840771410198f627d75673a` - `TINTED COCONUT LIP BALM`
- `ext_8982e4384c3bd70a5718c899` - `CLEAR LIP CARE`

This was a runtime confidence issue, not a seed taxonomy or identity issue. Both rows already had approved identity and specific `beauty/skincare/lip` taxonomy.

## Production Data Diagnosis

Read-only production taxonomy state:

- artifact: `coconutmatter_taxonomy_state_before.json`
- both rows: `identity_status=approved`, `review_required=false`
- both rows: `seed_category=Lip Treatment`, `catalog_category_path=beauty/skincare/lip`

Read-only production candidate replay before code patch:

- artifact: `coconutmatter_candidate_confidence_probe.json`
- `TINTED COCONUT LIP BALM`: 2 accepted in local replay
- `CLEAR LIP CARE`: 1 accepted in local replay
- rejected in-stock lip candidates included `Lip Glowy Balm`, `Rose Love Balm`, `Peptide Glowy Balm`, and `Lip Moisturising Stick`

Root cause:

- Lip-category candidates whose titles used balm/stick/glowy language were not consistently classified as `lip_treatment`.
- A lip-family candidate could still be downgraded when its stored vertical remained `skincare` while the base lip product was runtime-overridden to `makeup`.

## Runtime Patch

Changed `src/services/RecommendationEngine.js`:

- Added direct lip-treatment detection for titles such as `Lip Glowy Balm` and `Lip Moisturising Stick`.
- Added a lip-category fallback that treats balm/stick/glowy lip-category products as `lip_treatment` without relying on exact title adjacency.
- Kept accessory titles excluded from the lip fallback.
- Allowed external/external leaf-category matches to remain medium confidence across the skincare/makeup boundary when both sides share a lip-related intent family.

Guardrails preserved:

- lipstick-specific strictness remains covered by existing tests.
- lip trio / bundle candidates remain filtered by the existing bundle logic.
- eye products remain excluded.

## Verification

Syntax:

- `node --check src/services/RecommendationEngine.js`
- `node --check reports/.../probe_coconutmatter_candidate_confidence.cjs`

Jest:

- `tests/recommendations/pdp_recommendations_external_fetch.test.js` - 66 passed
- focused adjacent guardrail set:
  - `tests/recommendations/pdp_recommendations_external_fetch.test.js`
  - `tests/services/recommendation_engine_lipstick_intent.test.js`
  - `tests/services/recommendation_engine_semantic_path.test.js`
  - 8 passed, 64 skipped by pattern

Production-data replay with local patched code:

- artifact: `coconutmatter_candidate_confidence_probe_after_lip_patch.json`
- `TINTED COCONUT LIP BALM`: 6 accepted, status `ready`, low confidence `false`
- `CLEAR LIP CARE`: 5 accepted; this satisfies the PDP wrapper visible-ready threshold of 5 for a requested limit of 6
- accepted set across the two targets:
  - `CLEAR LIP CARE`
  - `Lip Glowy Balm`
  - `Rose Love Balm`
  - `Peptide Glowy Balm`
  - `+Rose Lip Nourisher`
  - `Lip Moisturising Stick`

## Deployment Status

Not deployed yet at this closeout point. Next step is to commit, push to the working branch and `main` through Git only, wait for the Git deployment, then run live production PDP quality checks for both Coconut Matter rows.
