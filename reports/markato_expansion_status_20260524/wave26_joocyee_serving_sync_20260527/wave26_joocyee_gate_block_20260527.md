# Wave26 Joocyee Serving Sync Gate Block

Generated: 2026-05-27

## Scope

- Brand: Joocyee
- Domain: joocyee.com
- Market: US
- Candidate batch: 17 serving-index-sync rows from the latest Markato rollup
- Production write status: not applied

## Candidate SKUs

- ext_3ca7c85748b01b4bc8e2f3bb | Color-correcting Primer
- ext_794deab047eb4a75225329df | Color-correcting Primer
- ext_8bced3f34a8100c3cfa62377 | Color-correcting Primer
- ext_4fe791cb17f27395a25f91ee | Dual-Ended Eyebrow Pencil & Cream 2.0
- ext_613e3bbbf834dcce655539b3 | Dual-Ended Eyebrow Pencil & Cream 2.0
- ext_d479efb9a5fafb985e19bd3c | Dual-Ended Eyebrow Pencil & Cream 2.0
- ext_2881559170714581057e21eb | Glazed Lip Gloss
- ext_35ffa71281354a958ef30f7e | Glazed Lip Gloss
- ext_3c9980e0455d648c3173c14e | Glazed Lip Gloss
- ext_41c98523b6fc0a8279c3095c | Glazed Lip Gloss
- ext_4888a0d0940daa58fc77af80 | Glazed Lip Gloss
- ext_52a27acd606756dea463a717 | Glazed Lip Gloss
- ext_70a0b0b3c68a48630060c7ff | Glazed Lip Gloss
- ext_75c1cd3bbad92bbdbc6ab010 | Glazed Lip Gloss
- ext_a9a9d873995dc784e34cb222 | Glazed Lip Gloss
- ext_bb9685457f5a919c945ee9ce | Glazed Lip Gloss
- ext_c037778265747b32fc52a16c | Glazed Lip Gloss

## Gate Result

Pre-apply readiness:

- Scanned rows: 17
- Action required rows: 17
- DB serving ready: 0
- Public index ready: 0
- KB missing: 12
- Index doc shadow only: 5
- Direct displayable KB rows: 5
- Direct high-quality product-intel rows: 5
- Identity rows joined: 17
- Identity ready rows: 17
- Source build failures: 0
- Warnings: 0

Serving sync dry-run:

- Requested IDs: 17
- Fetched rows: 17
- Mirror rows: 0
- Planned SKU rows: 0
- Planned offer rows: 0
- Planned index state rows: 0
- Missing IDs: 0
- Skipped rows: 17
- Skipped reason: `duplicate_canonical_url_identity_review_required` x17

## Decision

No production apply was run for Joocyee.

The exact sync dry-run treated all 17 rows as duplicate-canonical identity-review rows. This is not a normal serving-index-sync batch. These rows need variant/canonical identity review and, for 12 rows, direct KB/product-intel coverage before they should be retried.

## Follow-Up

- Do not include these 17 Joocyee rows in a plain serving-sync apply.
- Add a Joocyee-specific identity consolidation/review step that understands multiple external rows sharing the same canonical PDP.
- Refresh the rollup classifier so duplicate-canonical rows do not keep surfacing as clean `serving_index_sync` candidates.
- After identity consolidation, rerun exact readiness before any write.

## Artifacts

- `wave26_joocyee_serving_sync_candidate_ids.txt`
- `readiness_before_serving_sync/summary.json`
- `wave26_joocyee_serving_sync_dry_run.json`
