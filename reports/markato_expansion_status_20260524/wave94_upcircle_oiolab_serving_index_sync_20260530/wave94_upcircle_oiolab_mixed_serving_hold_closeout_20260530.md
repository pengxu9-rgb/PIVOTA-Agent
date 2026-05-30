# Wave94 UpCircle/Oio Lab Mixed Serving/Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed the remaining seven `serving_index_sync` candidates from the wave93 rollup:

- `ext_664b859ce2599a57c3f1f7ce` - Body Oil with Passion Fruit Oil
- `ext_23ae4c5d9d8f2a8be363f2cc` - Body Scrub with Coffee + Lemongrass
- `ext_6815bee1060ef71d9a99ce5b` - Cleansing Face Milk with Oat Powder + Aloe Vera
- `ext_96484ace25be03a8f8cb595d` - RETURN + REFILL Night Cream with Hyaluronic Acid + Niacinamide - ON PAUSE
- `ext_714399863bd72a30bcc6259c` - RETURN + REFILL Organic Face Oil with Coffee Extract - ON PAUSE
- `ext_c384be41af865ac0aecd06ed` - RETURN + REFILL Shampoo Creme with Pink Berry - ON PAUSE
- `ext_3a23e2090b4ac8dfcf1301fc` - Aquasphere

## Dry Run

Artifact:

- `upcircle_oiolab_serving_sync_dry_run.json`

Result:

- requested IDs: 7
- fetched rows: 7
- mirror rows: 7
- planned SKU rows: 10
- planned offer rows: 10
- planned index-state rows: 7
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0

## Initial Preflight

Artifacts:

- `upcircle_body_oil_pdp_quality_preflight.json`
- `upcircle_body_scrub_lemongrass_pdp_quality_preflight.json`
- `upcircle_cleansing_face_milk_pdp_quality_preflight.json`
- `upcircle_refill_night_cream_pdp_quality_preflight.json`
- `upcircle_refill_face_oil_pdp_quality_preflight.json`
- `upcircle_refill_shampoo_creme_pdp_quality_preflight.json`
- `oiolab_aquasphere_pdp_quality_preflight.json`

Result:

- All seven initial live PDP preflights failed with `live_pdp_probe_failed` / `Product not found`.
- The exact dry run showed all seven rows were already syncable with reviewed identity, so this was treated as stale or partial serving/index state and repaired before final reviewer judgment.

## Serving Repair Apply

Artifact:

- `upcircle_oiolab_serving_sync_repair_apply.json`

Production apply result:

- product upserts: 7
- SKU upserts: 10
- offer upserts: 10
- group-member upserts: 7
- index-state upserts: 7
- catalog-row-trust upserts: 7
- stale SKU deletes: 0
- stale offer deletes: 0

## Post-Repair PDP Audit

Artifacts:

- `upcircle_body_oil_pdp_quality_after_repair.json`
- `upcircle_body_scrub_lemongrass_pdp_quality_after_repair.json`
- `upcircle_cleansing_face_milk_pdp_quality_after_repair.json`
- `upcircle_refill_night_cream_pdp_quality_after_repair.json`
- `upcircle_refill_face_oil_pdp_quality_after_repair.json`
- `upcircle_refill_shampoo_creme_pdp_quality_after_repair.json`
- `oiolab_aquasphere_pdp_quality_after_repair.json`

Results:

| external product ID | product | status | live PDP | similar | similar count | variant | broken images | failure reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ext_6815bee1060ef71d9a99ce5b` | Cleansing Face Milk with Oat Powder + Aloe Vera | passed | passed | passed | 6 | passed | 0 | none |
| `ext_96484ace25be03a8f8cb595d` | RETURN + REFILL Night Cream with Hyaluronic Acid + Niacinamide - ON PAUSE | passed | passed | passed | 6 | passed | 0 | none |
| `ext_714399863bd72a30bcc6259c` | RETURN + REFILL Organic Face Oil with Coffee Extract - ON PAUSE | passed | passed | passed | 6 | passed | 0 | none |
| `ext_c384be41af865ac0aecd06ed` | RETURN + REFILL Shampoo Creme with Pink Berry - ON PAUSE | passed | passed | passed | 6 | passed | 0 | none |
| `ext_3a23e2090b4ac8dfcf1301fc` | Aquasphere | passed | passed | passed | 6 | passed | 0 | none |
| `ext_664b859ce2599a57c3f1f7ce` | Body Oil with Passion Fruit Oil | failed | passed | failed | 2 | passed | 0 | `similar_underfill` |
| `ext_23ae4c5d9d8f2a8be363f2cc` | Body Scrub with Coffee + Lemongrass | failed | passed | failed | 0 | passed | 0 | `similar_underfill` |

## Reviewer Holds

Held instead of promoted:

- `ext_664b859ce2599a57c3f1f7ce` - Body Oil with Passion Fruit Oil
- `ext_23ae4c5d9d8f2a8be363f2cc` - Body Scrub with Coffee + Lemongrass

Artifacts:

- `upcircle_similar_underfill_hold_dry_run.json`
- `upcircle_similar_underfill_hold_apply.json`
- `upcircle_failed_rows_resync_after_hold_dry_run.json`
- `upcircle_failed_rows_resync_after_hold_apply.json`

Hold result:

- external_product_seeds updated: 2
- catalog_products updated: 2
- catalog_skus updated: 4
- index_pipeline_state updated: 2
- resync product/index/trust upserts: 2 each
- resync SKU/offer upserts: 4 each
- final blocker: `content_evidence_hold`
- blocker detail: `post_repair_audit_failed_similar_gate`
- final serving eligible: false for both held rows

## Rollup After Wave94

Artifact directory:

- `current_rollup_after_wave94/`

Current rollup:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 267/613
- identity ready: 392/613
- product-intel high quality: 547/613
- ready_or_covered: 127
- hold_source_gap: 101
- hold_risk_review: 385
- serving_index_sync: 0
- recommended next batch rows: 0

## Outcome

Wave94 cleared the remaining `serving_index_sync` lane. Five rows were promoted after repair and post-repair live PDP validation. Two UpCircle rows were repaired enough to audit but then blocked because their recommendation rails remained underfilled.
