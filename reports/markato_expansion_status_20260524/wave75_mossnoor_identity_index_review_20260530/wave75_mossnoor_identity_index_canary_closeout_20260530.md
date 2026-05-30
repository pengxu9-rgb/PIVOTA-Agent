# Wave75 Moss & Noor Identity/Index Canary Closeout

Generated: 2026-05-30

## Scope

- Brand/domain: Moss & Noor / `mossnoor.com`
- Market: US
- Lane: identity/index review after source-gap expansion lanes stopped yielding safe source-backed candidates
- Exact canary: `ext_a7ab937f43db2868c6f9e383` - After Workout Shower Gel - Clean Eucalyptus

## Reviewer Decision

Do not bulk-promote Moss & Noor identity/index rows.

The reviewed identity bootstrap path is mechanically able to make these rows DB/public serving-ready, but the first production canary did not satisfy the live PDP quality gates. The canary was rolled back to a blocked identity/index state, and no remaining Moss & Noor rows were promoted.

## Evidence

### Preflight Identity Resolution Audit

Artifact: `pdp_entity_resolution_audit_before.json`

- Identity fragmented clusters: 21
- Canonical clusters scanned: 500
- Identity auto-merge candidates: 1
- Canonical auto-merge candidates: 47
- Product-group repairs: 93

### Moss & Noor Bootstrap Dry Run

Artifact: `mossnoor_serving_sync_bootstrap_dry_run.json`

- Requested rows: 8
- Fetched rows: 8
- Mirror rows: 8
- Planned SKU rows: 8
- Planned offer rows: 8
- Planned index-state rows: 8
- Skipped rows: 0
- Existing before: 8 catalog products, 8 catalog SKUs, 8 catalog offers, 8 product-group members
- Stale delete preview: 8 canonical SKU rows and 8 canonical offer rows would be deleted
- Audit reason: `no_strong_identifier` on all 8 rows

The dry run showed every requested row as `servingEligible=true`, `contentQualityScore=90`, `blockerCode=none`, `identityResolved=true`, and `identityBootstrapEligible=true`, but this is not enough for bulk promotion without a live PDP canary.

### Canary Apply

Artifact: `mossnoor_clean_eucalyptus_canary_serving_sync_apply.json`

- Applied rows: 1
- Product upserts: 1
- SKU upserts: 1
- Offer upserts: 1
- Group-member upserts: 1
- Index-state upserts: 1
- Identity live-read updates: 1
- Catalog row trust upserts: 1
- Stale canonical offer deletes: 1
- Stale canonical SKU deletes: 1

Post-apply readiness artifact: `readiness_canary_after_apply/summary.json`

- Scanned rows: 1
- DB serving ready: 1
- Public index ready dry run: 1
- Action required rows: 0
- Identity ready rows: 1
- Direct high-quality KB rows: 1

### Live PDP Quality Failure

Live PDP module audit artifact: `mossnoor_clean_eucalyptus_live_pdp_modules_after_apply.json`

- Scanned: 1
- Ready: 0
- Thin: 1
- Not conversion-ready: 0
- Blocker: `missing_how_to`
- Content gap ids: `ext_a7ab937f43db2868c6f9e383`

Strict PDP quality artifact: `mossnoor_clean_eucalyptus_pdp_quality_after_apply.json`

- Scanned: 1
- Failed: 1
- Failure reason: `similar_underfill`
- Root cause classification: `similar_issue`
- Seed, extractor, identity, product-intel, live-PDP, and variant gates passed
- Similar count: 2

Reviewer interpretation: the canary is not a safe user-facing expansion. The module audit found a content gap, and the strict quality audit found an underfilled similar rail. The row should not remain public while these user-facing quality issues are unresolved.

### Rollback

Rollback artifact: `mossnoor_clean_eucalyptus_canary_serving_rollback.json`

- External product id: `ext_a7ab937f43db2868c6f9e383`
- Identity rows updated: 1
- Index-state rows updated: 1
- Catalog row trust recomputed: true
- Before rollback: `pipeline_stage=shadow_indexed`, `blocker_code=none`, `serving_eligible=true`, `live_read_enabled=true`, `serving_decision=public`
- After rollback: `pipeline_stage=extracted`, `blocker_code=identity_not_live_approved`, `serving_eligible=false`, `live_read_enabled=false`, `serving_decision=blocked`
- Rollback reason: `wave75 canary rollback after live PDP module audit: missing_how_to and similar_underfill`

Post-rollback readiness artifact: `readiness_canary_after_rollback/summary.json`

- Scanned rows: 1
- DB serving ready: 0
- Public index ready dry run: 0
- Action required rows: 1
- Blocker breakdown: `identity_blocked=1`
- Lane breakdown: `lane_1_identity_index=1`
- Identity ready rows: 0
- Direct high-quality KB rows: 1

## After-Rollback Markato Rollup

Artifact directory: `current_rollup_after_mossnoor_canary_rollback/`

- Production rows: 613
- Catalog attached: 613/613
- DB serving eligible: 387/613
- Identity ready: 392/613
- High-quality reviewed product intel: 547/613
- Ready or covered: 160
- Hold source gap: 84
- Hold risk review: 369
- Recommended next-batch rows: 0

Moss & Noor domain state after rollback:

- Rows: 16
- Catalog attached: 16
- DB serving eligible: 0
- Identity ready: 0
- High-quality reviewed product intel: 16
- Ready or covered: 0
- Hold source gap: 8
- Hold risk review: 8
- Quality flags: `missing_how_to:12 | regulated_claim_review:4 | wellness_or_supplement:4 | missing_full_inci:2`

## Closeout

Wave75 produced no net public expansion. This is the correct outcome: the canary proved the row could be technically published, then the live PDP review proved it should not be.

Moss & Noor should remain blocked until one of these is true:

- Official source-backed how-to/use instructions can be recovered and applied where missing.
- The similar rail underfill is fixed or explicitly exempted by a product-quality policy.
- A new exact-row canary passes readiness, live PDP module audit, and strict PDP quality before any bulk promotion.
