# Wave38 Joocyee Color Primer Exact-Merge Closeout

Date: 2026-05-28
Market: US
Scope: Markato expansion, Joocyee Color-correcting Primer exact-merge review and serving sync

## Result

- Reviewed the 3 held Joocyee `Color-correcting Primer` rows from Wave37.
- Applied exact same-canonical identity merge for 2 non-target rows into target `ext_794deab047eb4a75225329df`.
- Applied production catalog/serving sync for all 3 rows.
- Verified the Color Primer group is 3/3 DB serving ready and 3/3 live PDP ready.
- Verified Joocyee domain is now 18/18 live PDP ready.
- No seller-only fallback, no force-filled PDP content, and no `railway up`.

## Applied IDs

Source: `../wave37_joocyee_same_canonical_product_line_20260528/joocyee_color_correcting_primer_ids.txt`

| external_product_id | Product | Role |
| --- | --- | --- |
| `ext_3ca7c85748b01b4bc8e2f3bb` | Color-correcting Primer | exact-merge candidate |
| `ext_794deab047eb4a75225329df` | Color-correcting Primer | exact-merge target |
| `ext_8bced3f34a8100c3cfa62377` | Color-correcting Primer | exact-merge candidate |

## Exact-Merge Review

Sources:

- `color_primer_exact_merge_dry_run.json`
- `color_primer_exact_merge_apply.json`

Dry-run:

- Seeds seen: 3
- Identities seen: 3
- Action: `merge_ready`
- Blockers: 0
- Warnings: 0
- Candidates to update: 2

Production apply:

- Identity rows updated: 2
- Overrides written: 2

This resolved the Wave37 hold from the product-line gate: the rows shared the same canonical URL and title, and their axes did not prove separate sellable items. They were therefore handled as reviewed exact same-canonical duplicates, not as independent product-line variants.

## Serving Sync

Sources:

- `color_primer_serving_sync_dry_run.json`
- `color_primer_serving_sync_apply.json`

Dry-run:

- Requested IDs: 3
- Fetched rows: 3
- Mirror rows: 3
- Planned SKU rows: 4
- Planned offer rows: 4
- Planned index-state rows: 3
- Skipped: 0
- Serving readiness: all sampled rows `servingEligible=true`, `blockerCode=none`

Production apply:

- Product upserts: 3
- SKU upserts: 4
- Offer upserts: 4
- Product group member upserts: 3
- Seed attachment updates: 2
- Index-state upserts: 3
- Identity live-read updates: 0
- Catalog row trust upserts: 3
- Stale offer deletes: 3
- Stale SKU deletes: 3

An initial apply command was rejected before writes because the required sync confirmation token was omitted. The confirmed retry completed successfully.

## Readiness Verification

Source: `readiness_after_serving_sync/summary.json`

- Scanned rows: 3
- Action required: 0
- DB serving ready: 3
- Public index ready: 3
- Blocker breakdown: `db_serving_ready` x3
- Lane breakdown: `ready_no_action` x3
- Direct displayable KB: 3
- Direct high-quality KB: 3
- Missing or no direct KB: 0
- Identity ready rows: 3
- Public dry-run docs built: 1
- Rows with public doc: 3
- Rows with public doc and insight summary: 3
- Source build failures: 0
- Warnings: 0

The single public dry-run doc is expected for the reviewed exact-merge group and covers all 3 source rows.

## Live PDP Audit

Color Primer source: `live_pdp_modules_audit_after_serving_sync.json`

- Scanned: 3
- Ready: 3
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

Joocyee domain source: `live_pdp_modules_audit_joocyee_domain_after_wave38.json`

- Scanned: 18
- Ready: 18
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

## Coverage Rollup After Wave38

Source: `latest_rollup_after_wave38/wave24_candidate_rollup.json`

- Production rows: 597
- Catalog attached: 597 / 597 (100%)
- Index serving eligible: 309 (51.8%)
- Identity ready: 317 (53.1%)
- Product intel high-quality: 385 (64.5%)
- Ready or covered: 103
- Hold source gap: 136
- Hold risk review: 358
- Recommended next batch rows: 0

Joocyee domain after Wave38:

- Rows: 18
- Catalog attached: 18 / 18 (100%)
- Index serving eligible: 18 / 18 (100%)
- Identity ready: 18 / 18 (100%)
- Product intel high-quality: 18 / 18 (100%)
- Ready or covered: 18 / 18 (100%)
- Hold source gap: 0
- Hold risk review: 0

## Next Gate

The clean recommended-next queue is now empty. Further Markato expansion should come from one of two tracks:

- Source-gap repair: request or recover official full INCI/how-to for held formula rows.
- New-brand expansion: backfill additional Markato merchants into seeds, then run the same quality gates before production serving sync.
