# Wave92 Nala Care Preflight Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed four `serving_index_sync` candidates from the wave91 rollup:

- `ext_e08d2e62205f1691dfe30753` - Coastal Waters, Extra Strength Natural Deodorant
- `ext_e5f66cf29d6c516775bb0fce` - Essence of Rosewood, Extra Strength Natural Deodorant
- `ext_b36935c92dc89857bf62f25e` - Grapefruit & Neroli, Extra Strength Natural Deodorant
- `ext_5975f96c1d90b02d02329960` - Unscented, Sensitive Skin Natural Deodorant

## Serving Dry Run

Artifact:

- `nalacare_serving_sync_dry_run.json`

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

## Preflight PDP Audit

Artifacts:

- `nalacare_coastal_waters_pdp_quality_preflight.json`
- `nalacare_rosewood_pdp_quality_preflight.json`
- `nalacare_grapefruit_neroli_pdp_quality_preflight.json`
- `nalacare_unscented_pdp_quality_preflight.json`

Results:

| external product ID | product | seed | extractor | identity | product_intel | live PDP | similar | similar count | failure reasons | broken images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ext_e08d2e62205f1691dfe30753` | Coastal Waters, Extra Strength Natural Deodorant | passed | passed | passed | passed | passed | failed | 3 | `similar_underfill` | 0 |
| `ext_e5f66cf29d6c516775bb0fce` | Essence of Rosewood, Extra Strength Natural Deodorant | passed | passed | passed | passed | passed | failed | 3 | `similar_underfill` | 0 |
| `ext_b36935c92dc89857bf62f25e` | Grapefruit & Neroli, Extra Strength Natural Deodorant | passed | passed | passed | passed | passed | failed | 3 | `similar_underfill` | 0 |
| `ext_5975f96c1d90b02d02329960` | Unscented, Sensitive Skin Natural Deodorant | passed | passed | passed | passed | passed | failed | 0 | `similar_underfill` | 0 |

Classification:

- content and live PDP gates passed
- product images were healthy, with 0 broken images across the four audits
- final blocker was a `similar_issue`, specifically `similar_underfill`

## Reviewer Hold

Because all four rows failed the similar-quality gate, none were promoted into serving. The rows were held with `content_evidence_hold` and resynced so serving/index state reflects the reviewer decision.

Artifacts:

- `nalacare_content_evidence_hold_dry_run.json`
- `nalacare_content_evidence_hold_apply.json`
- `nalacare_resync_after_hold_dry_run.json`
- `nalacare_resync_after_hold_apply.json`

Hold result:

- external_product_seeds updated: 4
- catalog_products updated: 4
- catalog_skus updated: 4
- index_pipeline_state updated: 4
- resync product/SKU/offer/index/trust upserts: 4 each
- final blocker: `content_evidence_hold`
- blocker detail: `preflight_audit_failed_similar_gate`
- final serving eligible: false for all four rows

## Rollup After Wave92

Artifact directory:

- `current_rollup_after_wave92_hold/`

Current rollup:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 260/613
- identity ready: 392/613
- product-intel high quality: 547/613
- ready_or_covered: 120
- hold_source_gap: 99
- hold_risk_review: 385
- serving_index_sync: 9

Recommended next batch starts with:

- Rohr Remedy `ext_1b95875bc9bdeee751d0cee1` - Lilly Pilly Face Moisturiser with Omega-3
- Seresilk `ext_0d4ffd13b899460cabb1f392` - Gentle Silk Cleanser
- UpCircle Beauty `ext_664b859ce2599a57c3f1f7ce` - Body Oil with Passion Fruit Oil
- UpCircle Beauty `ext_23ae4c5d9d8f2a8be363f2cc` - Body Scrub with Coffee + Lemongrass
- UpCircle Beauty `ext_6815bee1060ef71d9a99ce5b` - Cleansing Face Milk with Oat Powder + Aloe Vera

## Outcome

Wave92 did not add live serving coverage. It closed the Nala Care lane conservatively: the rows are source-backed and live-PDP clean, but recommendation underfill prevents production serving promotion under the current reviewer gate. The next real expansion move is the reduced 9-row `serving_index_sync` queue, starting with Rohr Remedy and Seresilk before the remaining UpCircle/Oio Lab rows.
