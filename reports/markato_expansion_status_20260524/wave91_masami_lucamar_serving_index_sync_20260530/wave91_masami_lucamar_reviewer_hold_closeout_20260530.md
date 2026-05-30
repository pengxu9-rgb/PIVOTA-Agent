# Wave91 MASAMI/Lucamar Reviewer Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed four `serving_index_sync` candidates from the wave90 rollup:

- `ext_53cf4f0ee46873d280f632db` - Mekabu Hydrating Shine Serum
- `ext_0836525e72365da8ecbcc3b5` - Baa Ram Ewe Lanolin Skin Balm 120g
- `ext_c26547ca63d530592ed62d63` - Baa Ram Ewe Lanolin Skin Balm 120g UNSCENTED
- `ext_edcf7e510314384ac432b385` - Baa Ram Ewe Lanolin Skin Balm 50g

## Dry Run

Artifact:

- `masami_lucamar_serving_sync_dry_run.json`

Result:

- requested IDs: 4
- fetched rows: 4
- mirror rows: 4
- planned SKU rows: 4
- planned offer rows: 4
- planned index-state rows: 4
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0

## Initial Preflight

Artifacts:

- `masami_mekabu_serum_pdp_quality_preflight.json`
- `lucamar_balm_120g_pdp_quality_preflight.json`
- `lucamar_balm_120g_unscented_pdp_quality_preflight.json`
- `lucamar_balm_50g_pdp_quality_preflight.json`
- `control_lhamour_face_moisturizer_pdp_quality_probe.json`

Result:

- The Lhamour control row passed the same audit path.
- All four wave91 rows failed initial live PDP preflight with `live_pdp_probe_failed` / `Product not found`.
- Production DB inspection showed the four rows already had `serving_eligible=true`, `pipeline_stage=shadow_indexed`, and `blocker_code=none`, so this was treated as a stale or partial serving/index state rather than a missing seed.

## Serving Repair Apply

Artifact:

- `masami_lucamar_serving_sync_apply.json`

Production apply result:

- product upserts: 4
- SKU upserts: 4
- offer upserts: 4
- index-state upserts: 4
- catalog-row-trust upserts: 4
- stale SKU deletes: 0
- stale offer deletes: 0

## Post-Repair PDP Audit

Artifacts:

- `masami_mekabu_serum_pdp_quality_after_serving_sync.json`
- `lucamar_balm_120g_pdp_quality_after_serving_sync.json`
- `lucamar_balm_120g_unscented_pdp_quality_after_serving_sync.json`
- `lucamar_balm_50g_pdp_quality_after_serving_sync.json`

Results:

| external product ID | product | live PDP | similar | similar count | failure reasons | broken images |
| --- | --- | --- | --- | --- | --- | --- |
| `ext_53cf4f0ee46873d280f632db` | Mekabu Hydrating Shine Serum | passed | failed | 0 | `similar_underfill` | 0 |
| `ext_0836525e72365da8ecbcc3b5` | Baa Ram Ewe Lanolin Skin Balm 120g | failed | failed | 1 | `polluted_product_description`, `polluted_product_details`, `similar_underfill` | 0 |
| `ext_c26547ca63d530592ed62d63` | Baa Ram Ewe Lanolin Skin Balm 120g UNSCENTED | failed | failed | 1 | `polluted_product_description`, `polluted_product_details`, `similar_underfill` | 0 |
| `ext_edcf7e510314384ac432b385` | Baa Ram Ewe Lanolin Skin Balm 50g | failed | failed | 1 | `polluted_product_description`, `polluted_product_details`, `similar_underfill` | 0 |

Gate status:

| product | seed | extractor | identity | product_intel | live_pdp | similar | variant |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mekabu Hydrating Shine Serum | passed | passed | passed | passed | passed | failed | passed |
| Lucamar 120g | passed | passed | passed | passed | failed | failed | passed |
| Lucamar 120g UNSCENTED | passed | passed | passed | passed | failed | failed | passed |
| Lucamar 50g | passed | passed | passed | passed | failed | failed | passed |

## Reviewer Hold

Because the post-repair audit still failed, all four rows were held instead of left serving-eligible.

Artifacts:

- `masami_lucamar_content_evidence_hold_dry_run.json`
- `masami_lucamar_content_evidence_hold_apply.json`
- `masami_lucamar_resync_after_hold_dry_run.json`
- `masami_lucamar_resync_after_hold_apply.json`

Hold result:

- external_product_seeds updated: 4
- catalog_products updated: 4
- catalog_skus updated: 4
- index_pipeline_state updated: 4
- resync product/SKU/offer/index/trust upserts: 4 each
- final blocker: `content_evidence_hold`
- blocker detail: `post_sync_audit_failed_quality_gate`
- final serving eligible: false for all four rows

## Rollup After Wave91

Artifact directory:

- `current_rollup_after_wave91_hold/`

Current rollup:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 262/613
- identity ready: 392/613
- product-intel high quality: 547/613
- ready_or_covered: 120
- hold_source_gap: 95
- hold_risk_review: 385
- serving_index_sync: 13

Recommended next batch starts with:

- Nala Care `ext_e08d2e62205f1691dfe30753` - Coastal Waters, Extra Strength Natural Deodorant
- Nala Care `ext_e5f66cf29d6c516775bb0fce` - Essence of Rosewood, Extra Strength Natural Deodorant
- Nala Care `ext_b36935c92dc89857bf62f25e` - Grapefruit & Neroli, Extra Strength Natural Deodorant
- Nala Care `ext_5975f96c1d90b02d02329960` - Unscented, Sensitive Skin Natural Deodorant
- Rohr Remedy `ext_1b95875bc9bdeee751d0cee1` - Lilly Pilly Face Moisturiser with Omega-3

## Outcome

Wave91 did not add live serving coverage. It repaired stale serving/index state long enough to audit the rows, then blocked all four after live PDP validation exposed recommendation underfill and Lucamar PDP-description pollution. The next real expansion lane is the reduced 13-row `serving_index_sync` queue, starting with Nala Care.
