# catalog_row_trust — reader contract

**Status:** Phase 3a (discoveryFeed brand candidates wired behind flag).
**Migration:** `pivota-backend-quality-gate/db/migrations/136_catalog_row_trust.sql`
**Policy:** `src/services/catalogTrustPolicy.js` (POLICY_VERSION = `c1.v0.4`)
**Python parity:** `pivota-backend/services/catalog_trust_policy.py` (same version)
**Backfill:** `scripts/backfill-catalog-row-trust.cjs`

## What this contract is

One row-shape every catalog reader can consume — `(serving_decision, serving_reason_codes)` — instead of re-implementing source / identity / IPS / quarantine predicates per reader.

Decision vocabulary:

| Decision  | Reader semantics                                                                                    |
|-----------|------------------------------------------------------------------------------------------------------|
| `public`  | Reader may surface this row to end-users / agents / LLMs without further gating.                     |
| `shadow`  | Would have served under legacy gates, but contract says caution. Internal/debug only; expose reason. |
| `blocked` | Never surface. Reason codes explain why.                                                             |

## Today's reader-gate inventory (verified 2026-05-26 against `origin/main`)

| # | Reader | Current gate predicate (verbatim shape) | Maps to trust contract |
|---|--------|-----------------------------------------|------------------------|
| 1 | `activeCatalogSourceSql` | `merchant_id='external_seed' OR merchant_stores.status='active'` + domain present | `source_lifecycle_state IN ('active','suspect')` |
| 2 | `pdpIdentityGraph.listLivePdpIdentityRowsForRefs` | `identity_status='approved' AND live_read_enabled=true` + active external seed predicate (no `review_required=false`) | `serving_decision='public'` — Phase 3d wired behind `PDP_IDENTITY_USES_CATALOG_ROW_TRUST` (default OFF) |
| 3 | `catalogServingIndex.fetchCatalogServingEligibleSourceSet` | `ips.serving_eligible=TRUE` | subset of `serving_decision='public'` |
| 4 | `catalogServingIndex` external search body | `publish_state='public'` (doc-level) + market | `serving_decision='public'` after document re-trust hydration |
| 5 | `catalogServingIndex` local serving scan | `publish_state='public'` + market + optional `servingEligibleOnly` flag | `serving_decision='public'` |
| 6 | `findProductsExternalSeedDirectRetrieval` | `external_product_seeds.status='active' AND EXISTS(catalog_products + ips.serving_eligible=TRUE)` | `serving_decision='public'` with `source_lifecycle_state='active'` — Phase 3c wired behind `FIND_PRODUCTS_USES_CATALOG_ROW_TRUST` (default OFF) |
| 7 | `findProductsExternalSeedBrandFastpath` | same as #6 | same as #6 — Phase 3c wired behind `FIND_PRODUCTS_USES_CATALOG_ROW_TRUST` |
| 8 | `discoveryFeed` identity join (`.js:2120`) | `identity_status='approved' AND live_read_enabled=true` (no `review_required=false`) | `serving_decision='public'` — same gap as reader #2 |
| 9 | `discoveryFeed` brand candidates (`.js:8589`) | `ips.serving_eligible=TRUE` | `serving_decision='public'` — Phase 3a wired behind `DISCOVERY_USES_CATALOG_ROW_TRUST` (default OFF) |
| 10 | `RecommendationEngine` identity (`loadLiveIdentityRowsForRecommendationProducts`) | `identity_status='approved' AND live_read_enabled=true` (no `review_required=false`) | `serving_decision='public'` — Phase 3b wired behind `RECOMMENDATIONS_USES_CATALOG_ROW_TRUST` (default OFF) |

**Three readers diverge from the gate the audit reported** (`#2, #8, #10`): they accept `review_required=true` rows when the audit's contract would not. Those are surfaced by the policy as `serving_decision='shadow'` with reason code `IDENTITY_REVIEW_REQUIRED_LIVE_READ`. This is the audit's "60 external-mirror serving rows with explicit review_required=true" cohort.

## Reason-code vocabulary

Authoritative source: `src/services/catalogTrustPolicy.js` (`REASON_CODES`).

| Code                                | Decision impact | Meaning                                                                                        |
|-------------------------------------|-----------------|------------------------------------------------------------------------------------------------|
| `PUBLIC_PASSTHROUGH`                | public          | Row passed every gate; emitted for traceability.                                               |
| `IDENTITY_REVIEW_REQUIRED_LIVE_READ`| shadow          | `pdp_identity_listing.review_required=true` (audit's 60-row cohort).                           |
| `IDENTITY_CONFIDENCE_NULL`          | shadow          | IPS eligible, but no identity row or `identity_confidence IS NULL`. **Only emitted for external_seed sources** (c1.v0.3+). Audit's 504-row cohort. |
| `IDENTITY_LIVE_READ_DISABLED`       | shadow          | identity approved but `live_read_enabled=false`. First-party sources exempt (c1.v0.3+).        |
| `IDENTITY_NOT_APPLICABLE_FIRST_PARTY` | advisory      | c1.v0.3+. Marks first-party (non-external_seed) rows where identity gates don't apply.         |
| `FRESHNESS_UNVERIFIED`              | advisory        | No verification timestamp anywhere; advisory only — does not flip decision.                    |
| `SOURCE_QUARANTINED`                | blocked         | `catalog_source_quarantine` active match (PR #663 / migration 134).                            |
| `ROW_TOMBSTONED`                    | blocked         | `catalog_products.suppression_reason` set (PR #666 / migration 135).                           |
| `EXTERNAL_SEED_INACTIVE`            | blocked         | `external_product_seeds.status` != `active`.                                                   |
| `MERCHANT_STORE_INACTIVE`           | blocked         | `merchant_stores.status` != `active`.                                                          |
| `INDEX_NOT_SERVING_ELIGIBLE`        | blocked         | `index_pipeline_state.serving_eligible=false` OR (c1.v0.4+) no IPS row for non-first-party catalog. |
| `PUBLISH_STATE_NOT_PUBLIC`          | blocked         | `catalog_products.sync_status` != `live`. (Name kept for forward-compat with audit copy.)      |
| `IDENTITY_CONFLICT`                 | blocked         | `pdp_identity_listing.identity_status='conflict'`.                                             |
| `OFFER_SUPPRESSED`                  | blocked         | subject_type=`offer`, offer.suppression_reason set.                                            |

## How to consume

```js
// Public catalog reader (recommended):
SELECT product_key, content_key
FROM catalog_row_trust
WHERE serving_decision = 'public';

// Diagnose a specific row:
SELECT * FROM catalog_row_trust
WHERE subject_type = 'product' AND subject_key = $1;

// "What got blocked today by reason X":
SELECT subject_key, serving_reason_codes
FROM catalog_row_trust
WHERE 'EXTERNAL_SEED_INACTIVE' = ANY(serving_reason_codes)
ORDER BY updated_at DESC;
```

## Phase roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Schema + policy v0 + reader-contract matrix + backfill driver | **this PR** (no readers cut over) |
| Phase 2 | Dual-write integration: catalog_sync_service.py, sync-external-seeds-to-catalog.cjs, pdpIdentityGraph.js, catalog_source_quarantine writes all dispatch to catalogTrustPolicy → upsert. | Not started |
| Phase 3 | Reader cutover in risk order: discoveryFeed → RecommendationEngine → findProducts* → pdpIdentityGraph → catalogServingIndex. | **Phase 3a live on prod** (`DISCOVERY_USES_CATALOG_ROW_TRUST=true`, reader #9). **Phase 3b merged, flag OFF** (RecommendationEngine reader #10 — identity-dedup semantics differ from serving; see follow-up). **Phase 3c live on prod** (`FIND_PRODUCTS_USES_CATALOG_ROW_TRUST=true`, readers #6/#7). **Phase 3d in flight:** pdpIdentityGraph reader #2 wired behind `PDP_IDENTITY_USES_CATALOG_ROW_TRUST` |
| Phase 4 | Retire duplicate per-reader predicates. Add 580-violation regression test in CI. | Not started |

## Operational properties (Phase 1)

- **Backfill is idempotent.** UPSERT is conditional on `policy_version` change or decision change.
- **Policy is pure.** `deriveTrust(inputs)` → trust row, no I/O. Unit-testable; fixtures in `tests/catalog_trust_policy.node.test.cjs`.
- **Producers are NOT yet wired.** The trust table will go stale until Phase 2. Backfill should be re-run on a cron or after each ingest cycle until dual-writes are in.
- **No reader consumes the table yet.** Adding a reader before Phase 2 risks serving stale decisions.

## Open items deliberately deferred

- `source_id` (Layer A1 source registry) — left NULL.
- `matched_product_key` / `matched_content_key` — left NULL in Phase 1. Population requires sibling-row lookup in the identity group (Phase 2).
- Offer-subject backfill — Phase 1 only handles `subject_type='product'`.
- Python policy parity. Mirrors `sourceQuarantine` cross-language pattern; deferred to Phase 2 when Python producers (`catalog_sync_service.py`) need to dual-write.
