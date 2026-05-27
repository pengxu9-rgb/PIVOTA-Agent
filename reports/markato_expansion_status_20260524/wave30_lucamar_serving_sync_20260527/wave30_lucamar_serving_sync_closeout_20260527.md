# Wave30 Lucamar Serving Sync Closeout

Generated: 2026-05-27

## Scope

Processed 3 reviewed Lucamar Skin Care US external seeds:

- `ext_0836525e72365da8ecbcc3b5` - Baa Ram Ewe  Lanolin Skin Balm  120g
- `ext_c26547ca63d530592ed62d63` - Baa Ram Ewe  Lanolin Skin Balm  120g UNSCENTED
- `ext_edcf7e510314384ac432b385` - Baa Ram Ewe Lanolin Skin Balm 50g

## Pre-Apply Gate

- Pre-readiness: 3 scanned, 3 action required, 0 terminal holds.
- Blocker before sync: `index_doc_shadow_only: 3`.
- KB gate: 3/3 direct displayable and 3/3 direct high-quality ready.
- Identity gate: 3/3 identity ready.
- Source build failures: 0.
- Warnings: 0.

## Sync Dry-Run

- Requested ids: 3.
- Fetched rows: 3.
- Mirror rows: 3.
- Planned product/index-state rows: 3.
- Planned SKU rows: 3.
- Planned offer rows: 3.
- Missing ids: 0.
- Skipped rows: 0.
- `servingEligible=false`: 0.
- Stale SKU deletes: 0.
- Stale offer deletes: 0.

## Production Apply

Production DB apply completed with reviewed identity live-read bootstrap enabled.

- Product upserts: 3.
- SKU upserts: 3.
- Offer upserts: 3.
- Product group member upserts: 3.
- Index state upserts: 3.
- Catalog row trust upserts: 3.
- Stale SKU deletes: 0.
- Stale offer deletes: 0.
- Missing/skipped rows: 0.

No `railway up` was used.

## Post-Apply Quality

Readiness after sync:

- Scanned: 3.
- DB serving ready: 3/3.
- Public dry-run docs: 3/3.
- Public docs with insight summary: 3/3.
- KB direct high-quality ready: 3/3.
- Identity ready: 3/3.
- Source build failures: 0.
- Warnings: 0.

Live PDP audit after sync:

- Scanned: 3.
- Ready: 3.
- Thin: 0.
- Not conversion ready: 0.
- Blocker counts: 0.
- Weak insights ids: 0.
- Seller-only insights ids: 0.
- Force-filled ids: 0.
- Content-gap ids: 0.

## Domain Coverage After Rollup

Latest production rollup after Lucamar plus DAEBY/LIME:

- `lucamarskincare.com`: 5 rows, 5 catalog attached, 3 DB serving eligible, 3 ready or covered.
- Identity ready: 5/5.
- High-quality product intel: 5/5.
- Remaining Lucamar holds: 2 risk holds, flagged as `regulated_claim_review:2 | wellness_or_supplement:2`.

## Artifacts

- Candidate ids: `wave30_lucamar_serving_sync_candidate_ids.txt`
- Pre-readiness: `readiness_before_serving_sync/summary.json`
- Dry-run: `wave30_lucamar_serving_sync_dry_run.json`
- Apply: `wave30_lucamar_serving_sync_apply.json`
- Post-readiness: `readiness_after_serving_sync/summary.json`
- Live PDP audit: `live_pdp_modules_audit_after_serving_sync.json`
