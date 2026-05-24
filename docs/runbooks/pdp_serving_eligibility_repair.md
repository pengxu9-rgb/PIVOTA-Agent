# PDP Serving Eligibility Repair Runbook

Use this runbook when public `sig_*` PDP URLs are present in
`/sitemap-products.xml` but strict `get_pdp_v2` returns
`PRODUCT_NOT_SERVABLE`, or when PDP v2 responses show module health warnings
that are being confused with an old/degraded PDP version.

## 1. Baseline First

Run the read-only sitemap audit before changing data:

```bash
npm run pdp:audit:sitemap-serving -- --out reports/pdp_sitemap_serving_baseline.json
```

The baseline must preserve:

- `product_id`
- HTTP status and `error`
- `blocker_code` / `blocker_detail`
- `module_health_severity`
- `missing_modules`

Do not proceed from a sample-only result when this is a release gate. Sample
runs are useful for triage; release acceptance requires the full sitemap set.

## 2. Classify Blockers

Group failed rows by `blocker_code` and repair the source signal, not the PDP
gate:

- `low_quality / no quality snapshot found`: generate or repair the matching
  `product_quality_snapshot`, then recompute `index_pipeline_state`.
- `no_seed` or `serving_eligibility_missing`: verify external seed mirror into
  `catalog_products`, `content_key`, and `agent_pdp_view`.
- `no_image`, `no_price`, `short_description`: repair exact-source catalog
  image, offer price, or description fields, then refresh view state.
- `entity_unresolved`, `seed_audit_fail`, `extractor_regression`: fix the
  identity, audit, or extractor baseline before recompute.
- `not_live` / `non_core_product`: do not force-publish unless product and
  lifecycle owners explicitly approve.

Never use a broad `allow_ineligible` or `low_quality` bypass for public PDPs.

## 3. Quarantine Or Delete Old PDPs

Old PDPs do not need to be made eligible through mock rows or synthetic DB
state. Treat them as one of three buckets:

- Quarantine by default: keep the source row for audit/history, but ensure
  `index_pipeline_state.serving_eligible` is false and the canonical feed,
  sitemap, and fallback seed path cannot emit the URL.
- Repair only when the source evidence is real: fill the missing mirror,
  quality snapshot, offer, image, description, identity, or audit signal, then
  recompute `index_pipeline_state`.
- Delete or archive only when the row is duplicate, test-only, orphaned from a
  live source, or permanently non-core. Export the before state and delete by
  exact identifiers such as `sig_id`, `content_key`, and source row id; never
  delete by broad brand/category predicates.

Deletion is not a substitute for the public gate. After quarantine, repair, or
delete, the release criterion is still a full strict sitemap audit with zero
non-serving URLs.

## 4. Data Repair Rules

- Dry-run first and store the dry-run artifact.
- Export affected rows before writes: `sig_id`, `content_key`,
  `external_product_id`, `blocker_code`, `blocker_detail`,
  `content_quality_score`, `quality_scored_at`, offer/image/description state.
- Patch only exact-source rows. Do not overwrite already-qualified
  descriptions, images, prices, Product Intel, or ingredient fields.
- Reject footer, navigation, generic boilerplate, title-mismatched, and
  seller-only content as repair input.
- After each write batch, refresh `agent_pdp_view` and recompute
  `index_pipeline_state` for affected `content_key` values.

## 5. Acceptance

Run the audit again:

```bash
npm run pdp:audit:sitemap-serving -- --out reports/pdp_sitemap_serving_after.json
```

Release acceptance:

- `failed_count = 0`
- `product_not_servable_count = 0`
- no `ext_*`, test merchant, or non-serving URLs in the sitemap
- module health warnings may remain only when they are optional coverage gaps
- `metadata.module_degrade.applied` is true only for degraded/core failures

## 6. Release Evidence

The release owner must attach:

- target frontend/backend/Agent commits
- production `/version` and `/healthz` commit checks
- before/after blocker distribution
- before/after sitemap counts
- full strict sitemap audit output
- cache purge or explicit stale-window decision
- rollback target and command
