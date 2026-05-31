# Wave97 Identity Refresh Partial Closeout

Generated: 2026-05-31

## Scope

Wave97 continued Markato US brand expansion from the post-Wave96 production state. The fresh production-backed rollup was generated under:

- `current_rollup_after_wave96/`

Rollup summary:

- Production rows scanned: 5,770
- Catalog attached: 5,770 / 5,770
- Index serving eligible: 4,476 / 5,770
- Identity ready: 5,118 / 5,770
- Product intel high quality: 4,100 / 5,770
- Actionable next batch rows: 281
- Source gap rows: 1,098
- Risk hold rows: 2,953

## Reviewed Candidate Selection

Initial exact-ID candidate file:

- `wave97_identity_refresh_candidate_ids.txt`

This contained 11 approved/non-review-required identity-refresh candidates from the fresh rollup.

Dry run result:

- Requested: 11
- Fetched: 11
- Mirror rows: 10
- Skipped: 1
- Planned SKU rows: 10
- Planned offer rows: 10
- Planned index state rows: 10

Gate decisions:

- `ext_b8af61a562f4ab972197f413` RMS Beauty Revitalize Hydra Concealer was skipped due `duplicate_pivota_signature_conflict` with an existing RMS official brand URL product.
- Four Soko Glam channel rows remained blocked by `identity_not_live_approved` and were not applied.

## Production Apply

Applied only the six clean exact IDs in:

- `wave97_identity_refresh_apply_ids.txt`

Applied IDs:

- `ext_81d3882e68c275747ef88b3f` Anua Golden Honmoon Barrier Collagen Mask 4ea
- `ext_a406636157366f31879c4cbe` Anua Rumi Ultra-thin Spot Cover Patch (55ea)
- `ext_04f175344e976ae32c16abad` Native Atlas RESTORING Cleansing Oil
- `ext_b0e98400b870b8783629e14a` Reap & Glow Coffee Fruit Antioxidant Cleanser
- `ext_b20d88539f9351b8db39595d` Reap & Glow Ayurvedic Deep Hydrating Rejuvenation Creme
- `ext_c2aca294e6409ceced3da49b` Reap & Glow Turmeric Peptide Firming & Smoothing Serum

Apply artifact:

- `wave97_identity_refresh_apply.json`

Apply result:

- Requested: 6
- Fetched: 6
- Mirror rows: 6
- Skipped: 0
- Product upserts: 6
- SKU upserts: 6
- Offer upserts: 6
- Index state upserts: 6
- Identity live-read updates: 6
- Catalog row trust upserts: 6
- Stale SKU deletes: 8
- Stale offer deletes: 6

## Post-Apply DB Readiness

Readiness artifact:

- `readiness_after_identity_refresh/summary.json`

Result:

- Scanned rows: 6
- Terminal holds: 0
- Identity ready rows: 6
- KB direct displayable: 6
- KB direct high quality ready: 6
- Public dry-run docs built: 6
- DB serving ready: 5
- Public index ready: 5
- Action required: 1

The one remaining action-required row is:

- `ext_a406636157366f31879c4cbe` Anua Rumi Ultra-thin Spot Cover Patch (55ea)
- Blocker: `seed_content_blocked`
- Detail: `missing:category`

## Category Repair Prepared

Reviewed category patch manifest:

- `anua_rumi_reviewed_category_patch_manifest.json`

Category decision:

- Category: `Blemish Patch`
- Product type: `Blemish Patch`
- Category path: `beauty/skincare/acne-treatment`
- Evidence: official Anua PDP title/description identifies the product as an ultra-thin hydrocolloid spot patch for blemish areas and post-extraction spots.

Dry-run artifact:

- `anua_rumi_category_patch_dry_run.json`

Dry-run result:

- Scanned: 1
- Planned: 1
- Blocked: 0
- Missing: 0
- Patch keys: `category`, `product_type`, `category_path`, `catalog_category_path`

Apply artifact:

- `anua_rumi_category_patch_apply.json`

Apply result:

- Scanned: 1
- Planned: 1
- Updated: 1
- Catalog product updates: 1
- Identity updates: 1
- Blocking reasons: 0

## Post-Category Readiness

Readiness artifact:

- `readiness_after_category_patch/summary.json`

Result:

- Scanned rows: 6
- Terminal holds: 0
- Identity ready rows: 6
- KB direct displayable: 6
- KB direct high quality ready: 6
- Public dry-run docs built: 0
- DB serving ready: 0
- Public index ready: 0
- Action required: 6
- Blocker: `index_doc_shadow_only`

This was not a source/identity/KB quality regression: identity and KB still passed for all six rows. The missing public docs required an exact-ID catalog/serving/index resync after the category payload update.

## Serving Resync

Dry-run artifact:

- `wave97_serving_resync_after_category_patch_dry_run.json`

Dry-run result:

- Requested: 6
- Fetched: 6
- Mirror rows: 6
- Skipped: 0
- Planned SKU rows: 6
- Planned offer rows: 6
- Planned index state rows: 6
- Planned stale SKU deletes: 0
- Planned stale offer deletes: 0
- Serving blocker: `none` for all sampled rows

Apply artifact:

- `wave97_serving_resync_after_category_patch_apply.json`

Apply result:

- Requested: 6
- Fetched: 6
- Mirror rows: 6
- Skipped: 0
- Product upserts: 6
- SKU upserts: 6
- Offer upserts: 6
- Index state upserts: 6
- Catalog row trust upserts: 6
- Stale SKU deletes: 0
- Stale offer deletes: 0

## Final Exact-ID Readiness

Readiness artifact:

- `readiness_after_serving_resync/summary.json`

Result:

- Scanned rows: 6
- Terminal holds: 0
- Action required: 0
- Identity ready rows: 6
- KB direct displayable: 6
- KB direct high quality ready: 6
- Public dry-run docs built: 6
- DB serving ready: 6
- Public index ready: 6
- Blocker breakdown: `db_serving_ready` = 6
- Lane breakdown: `ready_no_action` = 6

## Git Status

The Wave97 report/artifact commit was created locally and pushed to the work branch after retrying Git with HTTP/1.1:

- Commit: `842a04d2 Document Markato wave97 identity refresh`
- Branch: `origin/work/markato-wave25-786-serving-20260527`

The one-row category patch was later applied successfully through `railway run` after retrying transient Railway failures. The subsequent exact readiness audit showed all six rows as `index_doc_shadow_only`, and the follow-up exact six-ID serving/index resync cleared that blocker.

Public gateway signature PDP/similar probes also remain pending. The sandbox escalation reviewer blocked the read-only probe because it would send signature IDs and product metadata to `agent.pivota.cc`; explicit user approval is required before retrying that probe from the escalated sandbox.

## Guardrails Preserved

- No `railway up` was run.
- Production write was limited to exact IDs after dry-run review.
- Review-required and duplicate-signature candidates were not forced.
- DB serving/index readiness is clean for the exact six-ID Wave97 apply set.
- Live public gateway PDP/similar success is not claimed yet because the direct public probe still requires explicit approval to send signature IDs/product metadata to `agent.pivota.cc`.

## Remaining Validation

Run direct public gateway signature PDP/similar probes only after explicit approval to send the six signature IDs and product metadata to `agent.pivota.cc`.
