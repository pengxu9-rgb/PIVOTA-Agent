# Wave87 Delicate Daisys Preflight Hold Closeout

Generated: 2026-05-30

## Scope

Reviewed one `serving_index_sync` candidate:

- `ext_b5dafedce57973dfcca9fb5b` - Rejuvenating Night Face Cream Bulgarian Rose

No serving promotion was applied.

## Dry Run

Artifact:

- `delicatedaisys_serving_sync_dry_run.json`

Result:

- requested IDs: 1
- fetched rows: 1
- planned SKU rows: 1
- planned offer rows: 1
- planned index-state rows: 1
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0

## Preflight Audit

Artifact:

- `delicatedaisys_pdp_quality_preflight.json`

Result:

- overall status: failed
- root cause: `similar_issue`
- failure reasons: `similar_underfill`
- similar count: 0
- broken images: 0

Gate status:

| seed | extractor | identity | product_intel | live_pdp | similar | variant |
| --- | --- | --- | --- | --- | --- | --- |
| passed | passed | passed | passed | passed | failed | passed |

## Reviewer Action

Because the row failed preflight, it was held instead of promoted.

Artifacts:

- `delicatedaisys_content_evidence_hold_dry_run.json`
- `delicatedaisys_content_evidence_hold_apply.json`
- `delicatedaisys_resync_after_hold_dry_run.json`
- `delicatedaisys_resync_after_hold_apply.json`

Hold result:

- external_product_seeds updated: 1
- catalog_products updated: 1
- catalog_skus updated: 1
- index_pipeline_state updated: 1
- resync product/SKU/offer/index/trust upserts: 1 each
- final blocker: `content_evidence_hold`
- blocker detail: `preflight_audit_failed_similar_gate`
- final serving eligible: false

## Outcome

Wave87 is a reviewer hold. The product content and live PDP are good, but recommendation coverage is insufficient, so the row remains blocked until similar coverage is repaired.
