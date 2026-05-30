# Wave90 Lhamour Mixed Serving/Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed three Lhamour `serving_index_sync` candidates:

- `ext_d15df7e8e28d8f5a9aa9a170` - Natural Face Moisturizer for Dry Skin | Organic Face Cream | Lhamour
- `ext_5a82b869bc04dc2a7dac84af` - Sea Buckthorn Body Butter for Dry Skin | Natural Moisturizer | Lhamour
- `ext_44acbd72aedbea7735234e44` - Sea buckthorn Foot Cream for Cracked Heels | Natural Foot Salve | Lhamour

One candidate passed preflight and was promoted. Two candidates failed only the similar gate and were held.

## Batch Dry Run

Artifact:

- `lhamour_serving_sync_dry_run.json`

Result:

- requested IDs: 3
- fetched rows: 3
- planned SKU rows: 3
- planned offer rows: 3
- planned index-state rows: 3
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0

## Preflight Audits

Artifacts:

- `lhamour_face_moisturizer_pdp_quality_preflight.json`
- `lhamour_body_butter_pdp_quality_preflight.json`
- `lhamour_foot_cream_pdp_quality_preflight.json`

Results:

| external product ID | product | status | failure reasons | similar count | broken images |
| --- | --- | --- | --- | --- | --- |
| `ext_d15df7e8e28d8f5a9aa9a170` | Natural Face Moisturizer for Dry Skin | passed | none | 6 | 0 |
| `ext_5a82b869bc04dc2a7dac84af` | Sea Buckthorn Body Butter for Dry Skin | failed | `similar_underfill` | 0 | 0 |
| `ext_44acbd72aedbea7735234e44` | Sea buckthorn Foot Cream for Cracked Heels | failed | `similar_underfill` | 0 | 0 |

Gate status:

| product | seed | extractor | identity | product_intel | live_pdp | similar | variant |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Face Moisturizer | passed | passed | passed | passed | passed | passed | passed |
| Body Butter | passed | passed | passed | passed | passed | failed | passed |
| Foot Salve | passed | passed | passed | passed | passed | failed | passed |

## Serving Promotion

Promoted:

- `ext_d15df7e8e28d8f5a9aa9a170` - Natural Face Moisturizer for Dry Skin | Organic Face Cream | Lhamour

Artifacts:

- `lhamour_face_moisturizer_serving_sync_dry_run.json`
- `lhamour_face_moisturizer_serving_sync_apply.json`
- `lhamour_face_moisturizer_pdp_quality_after_serving_sync.json`

Production apply result:

- product upserts: 1
- SKU upserts: 1
- offer upserts: 1
- index-state upserts: 1
- catalog-row-trust upserts: 1
- stale SKU deletes: 0
- stale offer deletes: 0
- final blocker: `none`
- final serving eligible: true

Post-sync audit:

- overall status: passed
- similar count: 6
- broken images: 0
- seed/extractor/identity/product_intel/live_pdp/similar/variant gates: passed

## Reviewer Holds

Held instead of promoted:

- `ext_5a82b869bc04dc2a7dac84af` - Sea Buckthorn Body Butter for Dry Skin | Natural Moisturizer | Lhamour
- `ext_44acbd72aedbea7735234e44` - Sea buckthorn Foot Cream for Cracked Heels | Natural Foot Salve | Lhamour

Artifacts:

- `lhamour_similar_underfill_hold_dry_run.json`
- `lhamour_similar_underfill_hold_apply.json`
- `lhamour_failed_rows_resync_after_hold_apply.json`

Hold result:

- external_product_seeds updated: 2
- catalog_products updated: 2
- catalog_skus updated: 2
- index_pipeline_state updated: 2
- resync product/SKU/offer/index/trust upserts: 2 each
- final blocker: `content_evidence_hold`
- blocker detail: `preflight_audit_failed_similar_gate`
- final serving eligible: false for both held rows

## Rollup After Wave90

Artifact directory:

- `current_rollup_after_wave90/`

Current rollup:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 234/613
- identity ready: 392/613
- product-intel high quality: 547/613
- ready_or_covered: 110
- hold_source_gap: 91
- hold_risk_review: 385
- serving_index_sync: 27

Recommended next batch starts with:

- MASAMI `ext_53cf4f0ee46873d280f632db` - Mekabu Hydrating Shine Serum
- Lucamar Skin Care `ext_0836525e72365da8ecbcc3b5` - Baa Ram Ewe Lanolin Skin Balm 120g
- Lucamar Skin Care `ext_c26547ca63d530592ed62d63` - Baa Ram Ewe Lanolin Skin Balm 120g UNSCENTED
- Lucamar Skin Care `ext_edcf7e510314384ac432b385` - Baa Ram Ewe Lanolin Skin Balm 50g

## Outcome

Wave90 promoted one clean Lhamour row and held two rows that failed only recommendation coverage. The held rows have clean seed, extractor, identity, product-intel, live PDP, image, and variant gates, but they remain blocked with `content_evidence_hold` until similar coverage is repaired.
