# Wave86 KHUS KHUS Serving Sync Reviewer Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed five KHUS KHUS rows from the current `serving_index_sync` lane.

Exact target IDs:

- `ext_4dace0e8a2fe70b378b91c2c` - BLEU body serum
- `ext_290f05b3b8bfbfdb4e079d09` - D DROP humectant factor
- `ext_f27f918bac908cf6ba236b83` - KAI repair balm
- `ext_f86a3606bf6dc20fc810f99d` - SANS AGE face serum
- `ext_6ae70ce8a0cf2d0f8615d4dc` - SURYA body elixir

These rows looked eligible in the scoped rollup: identity-ready, product-intel-ready, in stock, priced in USD, full INCI present, how-to present, and no rollup quality flags.

## Serving Sync Attempt

Artifacts:

- `khuskus_serving_sync_dry_run.json`
- `khuskus_serving_sync_apply.json`

Dry run:

- requested IDs: 5
- fetched rows: 5
- mirror rows: 5
- planned SKU rows: 5
- planned offer rows: 5
- planned index-state rows: 5
- missing IDs: 0
- skipped rows: 0
- stale SKU deletes planned: 0
- stale offer deletes planned: 0
- serving sample blocker codes: `none`

Initial apply:

- product upserts: 5
- SKU upserts: 5
- offer upserts: 5
- group-member upserts: 5
- index-state upserts: 5
- catalog-row-trust upserts: 5
- stale SKU deletes: 0
- stale offer deletes: 0

## Post-Sync Quality Audit

Artifacts:

- `run_khuskus_pdp_quality_batch.cjs`
- `live_pdp_quality_after_serving_sync/summary.json`
- `live_pdp_quality_after_serving_sync/*.json`

Post-sync result:

- target count: 5
- passed: 0
- failed: 5
- broken images: 0

Important nuance: all five live PDP gates passed. The reviewer stop came from upstream/current-source quality gates:

- extractor gate failed for all 5 rows with `product_schema_missing`
- similar gate failed for 3 rows with `similar_underfill`
  - `ext_4dace0e8a2fe70b378b91c2c` - similar count 2
  - `ext_f27f918bac908cf6ba236b83` - similar count 0
  - `ext_6ae70ce8a0cf2d0f8615d4dc` - similar count 2

Gate summary:

| external_product_id | seed | extractor | identity | product_intel | live_pdp | similar | variant | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ext_4dace0e8a2fe70b378b91c2c` | passed | failed | passed | passed | passed | failed | passed | failed |
| `ext_290f05b3b8bfbfdb4e079d09` | passed | failed | passed | passed | passed | passed | passed | failed |
| `ext_f27f918bac908cf6ba236b83` | passed | failed | passed | passed | passed | failed | passed | failed |
| `ext_f86a3606bf6dc20fc810f99d` | passed | failed | passed | passed | passed | passed | passed | failed |
| `ext_6ae70ce8a0cf2d0f8615d4dc` | passed | failed | passed | passed | passed | failed | passed | failed |

## Reviewer Action

Because the post-sync audit failed, the rows were not left public. A content-evidence hold was applied, then the same exact IDs were resynced so `index_pipeline_state` and `catalog_row_trust` reflected the hold.

Artifacts:

- `khuskus_content_evidence_hold_dry_run.json`
- `khuskus_content_evidence_hold_apply.json`
- `khuskus_resync_after_hold_dry_run.json`
- `khuskus_resync_after_hold_apply.json`
- `verify_khuskus_post_hold_state.cjs`
- `khuskus_post_hold_serving_state.json`

Hold reason:

- `post_sync_audit_failed_extractor_or_similar_gate`

Hold evidence:

- extractor `product_schema_missing` on all five KHUS KHUS rows
- `similar_underfill` on BLEU, KAI, and SURYA
- live PDP gates and image health passed, so the issue is source re-extraction/similar coverage, not rendered PDP assembly

Final production verification:

- target count: 5
- row count: 5
- held count: 5
- `index_pipeline_state.serving_eligible=false`: 5/5
- `index_pipeline_state.blocker_code=content_evidence_hold`: 5/5
- `catalog_row_trust.serving_decision=blocked`: 5/5
- `catalog_row_trust.serving_reason_codes=["INDEX_NOT_SERVING_ELIGIBLE"]`: 5/5

## Rollup Impact

Artifacts:

- `current_rollup_after_7journeys/*`
- `current_rollup_after_khuskus_hold/*`

Current scoped Markato rollup after the hold:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 232/613
- identity ready: 392/613
- product intel high quality: 547/613
- lane counts:
  - ready_or_covered: 108
  - serving_index_sync: 33
  - hold_source_gap: 87
  - hold_risk_review: 385
- recommended next batch rows: 33

## Outcome

Wave86 is intentionally not a successful promotion. It is a reviewer catch:

1. The initial sync was clean at DB/readiness level.
2. Fresh live PDP validation failed the broader post-sync quality contract.
3. The five rows were withdrawn behind `content_evidence_hold`.
4. Final production verification confirms they are blocked, not public.

Next practical lane: avoid KHUS KHUS until extractor support or source evidence is repaired. Use the refreshed rollup and continue with a smaller candidate such as Delicate Daisys, LIME COSMETIC, or JouJou where the post-sync audit can be validated independently.
