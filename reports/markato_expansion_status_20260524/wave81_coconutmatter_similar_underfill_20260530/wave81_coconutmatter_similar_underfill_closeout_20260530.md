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

Deployed by Git push only.

- runtime code commit: `bbf19aa8d6ba677b2cace25f3de78ce60a52d194`
- trigger commit on `main`: `ab97e1ccb16bafac285aa45f88e6c5597ed1b623`
- production `/version`: `ab97e1ccb16b`
- deployment id: `ebcfbe97-910c-4058-be90-2c8baef28e04`

## Post-Deploy Live Checks

Clear Lip Care:

- artifact: `wave81_coconut_clear_lip_care_pdp_quality_after_deploy_agent_gateway.json`
- overall status: `passed`
- live PDP gate: `passed`
- product intel gate: `passed`
- identity gate: `passed`
- similar gate: `passed`
- similar count: 5

Tinted Coconut Lip Balm:

- artifacts:
  - `wave81_tinted_coconut_lip_balm_pdp_quality_after_deploy_agent_gateway.json`
  - `wave81_tinted_readiness_after_deploy.json`
- production DB readiness: passed for the row; product intel displayable/high-quality, variants ready, identity variant axes present
- public `find_similar_products`: passed
- similar count: 6
- public `get_pdp_v2`: still returns `Product not found` for both external id and signature id modes

Conclusion:

- Wave81 similar-underfill runtime fix is deployed and validated.
- The remaining Tinted issue is no longer similar underfill. It is a separate public PDP resolver/variant-line lookup issue for `ext_c840771410198f627d75673a` / `sig_ab0548c0101059f42676a642`.
