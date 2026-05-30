# Wave82 Coconut Matter Tinted PDP Resolver Closeout - 2026-05-30

## Scope

Recovered the remaining Coconut Matter Tinted Coconut Lip Balm public PDP failure after Wave81 fixed similar recall.

- external product id: `ext_c840771410198f627d75673a`
- public signature id: `sig_ab0548c0101059f42676a642`
- product line id: `pl_b280c2d5a19e59fcfc525550`

## Diagnosis

The row was not missing source content and did not need a resolver code patch.

Read-only production comparison against working Clear Lip Care showed:

- Tinted external seed: active
- Tinted catalog mirror row: present with expected `pivota_signature_id`
- Tinted identity row: approved, `live_read_enabled=true`, `review_required=false`
- Tinted catalog payload: had title, canonical URL, INCI/how-to content, 7 variants, and 11 image URLs
- blocker: stale `index_pipeline_state` marked the row `serving_eligible=false` with `blocker_code=no_image` and `blocker_detail=agent_pdp_view.image_url is null or empty`

Clear Lip Care had the same healthy source/identity shape but `index_pipeline_state.serving_eligible=true`, which is why Clear PDP rendered while Tinted returned `Product not found`.

Artifacts:

- `probe_coconutmatter_tinted_resolver_state.cjs`
- `coconutmatter_tinted_resolver_state_prod.json`

## Production Repair

Ran the existing single-row external seed catalog mirror sync with serving-state recomputation.

Dry-run:

- artifact: `tinted_serving_sync_dry_run.json`
- requested rows: 1
- skipped rows: 0
- planned SKU rows: 7
- planned offer rows: 7
- planned index-state rows: 1
- recomputed readiness: `servingEligible=true`
- blocker: `none`
- `hasImage=true`
- `hasPrice=true`
- content quality score: 90

Apply:

- artifact: `tinted_serving_sync_apply.json`
- product upserts: 1
- SKU upserts: 7
- offer upserts: 7
- group member upserts: 1
- index-state upserts: 1
- catalog-row-trust upserts: 1
- stale SKU/offer deletes: 0

Post-apply production state:

- Tinted `index_pipeline_state.serving_eligible=true`
- Clear remained `index_pipeline_state.serving_eligible=true`
- identity status remained approved/live with `review_required=false`

## Live Validation

Fresh public gateway PDP-quality audits used `no_cache=true`.

External ID probe:

- artifact: `tinted_pdp_quality_after_serving_sync_external_id.json`
- probed id: `ext_c840771410198f627d75673a`
- overall status: passed
- live PDP gate: passed
- product intel gate: passed
- identity gate: passed
- similar gate: passed
- similar count: 6
- variant gate: passed
- visible variants: 7
- image health: 9 scanned, 0 broken

Signature ID probe:

- artifact: `tinted_pdp_quality_after_serving_sync_sig.json`
- probed id: `sig_ab0548c0101059f42676a642`
- overall status: passed
- live PDP gate: passed
- product intel gate: passed
- identity gate: passed
- similar gate: passed
- similar count: 6
- variant gate: passed
- visible variants: 7
- image health: 9 scanned, 0 broken

## Outcome

The Tinted Coconut Lip Balm public PDP is recovered for both external-id and signature-id entry points. The issue was stale serving/index state, not PDP resolver logic or missing source-backed content.
