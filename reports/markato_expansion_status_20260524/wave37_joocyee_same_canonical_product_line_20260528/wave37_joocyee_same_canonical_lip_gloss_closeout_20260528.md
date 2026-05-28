# Wave37 Joocyee Same-Canonical Lip Gloss Closeout

Date: 2026-05-28
Market: US
Scope: Markato expansion, Joocyee same-canonical product-line review and quality-gated serving sync

## Result

- Evaluated 14 Joocyee same-canonical candidates across 2 product lines.
- Applied production catalog/serving sync for 11 `Glazed Lip Gloss` shade variants.
- Published reviewed product-intel repair for 10 Lip Gloss variants that had public commerce docs but no direct high-quality KB.
- Held 3 `Color-correcting Primer` rows because the product-line review required manual exact-merge confirmation.
- No seller-only fallback, no force-filled PDP content, and no `railway up`.

## Product-Line Gate

Sources:

- `color_correcting_primer_product_line_review_dry_run.json`
- `glazed_lip_gloss_product_line_review_dry_run.json`

Color-correcting Primer:

- Seeds seen: 3
- Identities seen: 3
- Action: `hold_manual_review`
- Blockers: `exact_merge_review_required`
- Warnings: `variant_axes_do_not_prove_distinct_sellable_items`
- Candidates updated: 0

Glazed Lip Gloss:

- Seeds seen: 11
- Identities seen: 11
- Action: `already_linked`
- Blockers: 0
- Warnings: 0
- Candidates updated: 0

The Lip Gloss group had reviewable shade/color axes, so it was safe to proceed with `--allow-duplicate-canonical`. The Color Primer group did not prove distinct sellable variants from axes alone, so it remains held.

## Applied IDs

Source: `joocyee_glazed_lip_gloss_ids.txt`

| external_product_id | Product |
| --- | --- |
| `ext_2881559170714581057e21eb` | Glazed Lip Gloss |
| `ext_35ffa71281354a958ef30f7e` | Glazed Lip Gloss |
| `ext_3c9980e0455d648c3173c14e` | Glazed Lip Gloss |
| `ext_41c98523b6fc0a8279c3095c` | Glazed Lip Gloss |
| `ext_4888a0d0940daa58fc77af80` | Glazed Lip Gloss |
| `ext_52a27acd606756dea463a717` | Glazed Lip Gloss |
| `ext_70a0b0b3c68a48630060c7ff` | Glazed Lip Gloss |
| `ext_75c1cd3bbad92bbdbc6ab010` | Glazed Lip Gloss |
| `ext_a9a9d873995dc784e34cb222` | Glazed Lip Gloss |
| `ext_bb9685457f5a919c945ee9ce` | Glazed Lip Gloss |
| `ext_c037778265747b32fc52a16c` | Glazed Lip Gloss |

Held IDs:

| external_product_id | Product | Hold reason |
| --- | --- | --- |
| `ext_3ca7c85748b01b4bc8e2f3bb` | Color-correcting Primer | `exact_merge_review_required` |
| `ext_794deab047eb4a75225329df` | Color-correcting Primer | `exact_merge_review_required` |
| `ext_8bced3f34a8100c3cfa62377` | Color-correcting Primer | `exact_merge_review_required` |

## Serving Sync

Sources:

- `glazed_lip_gloss_serving_sync_dry_run.json`
- `glazed_lip_gloss_serving_sync_apply.json`

Dry-run:

- Requested IDs: 11
- Fetched rows: 11
- Mirror rows: 11
- Planned SKU rows: 20
- Planned offer rows: 20
- Planned index-state rows: 11
- Skipped: 0
- Stale SKU deletes preview: 11
- Stale offer deletes preview: 11

Production apply:

- Product upserts: 11
- SKU upserts: 20
- Offer upserts: 20
- Product group member upserts: 11
- Seed attachment updates: 10
- Index-state upserts: 11
- Identity live-read updates: 0
- Catalog row trust upserts: 11
- Stale offer deletes: 11
- Stale SKU deletes: 11

One earlier apply attempt failed before writes due to a transient production DB connection termination during row fetch. The retry completed successfully and produced `glazed_lip_gloss_serving_sync_apply.json`.

## Product-Intel Repair

Sources:

- `official_seed_product_intel_report_lip_gloss_missing10.json`
- `product_intel_publish_lip_gloss_missing10_dry_run.json`
- `product_intel_publish_lip_gloss_missing10_apply.json`

Reviewed official-seed product-intel was built only for Lip Gloss rows with public commerce docs and missing direct KB.

- Selected rows: 10
- Public-ready rows: 10
- High-quality-ready rows: 10
- Evidence profile: `seller_plus_formula` x10
- Publish dry-run skipped rows: 0
- Publish apply mode: `write`
- Publish apply status: `ok`
- Published entries: 10

Published live row IDs:

- `live_ext_41c98523b6fc0a8279c3095c`
- `live_ext_35ffa71281354a958ef30f7e`
- `live_ext_4888a0d0940daa58fc77af80`
- `live_ext_52a27acd606756dea463a717`
- `live_ext_a9a9d873995dc784e34cb222`
- `live_ext_2881559170714581057e21eb`
- `live_ext_3c9980e0455d648c3173c14e`
- `live_ext_70a0b0b3c68a48630060c7ff`
- `live_ext_75c1cd3bbad92bbdbc6ab010`
- `live_ext_c037778265747b32fc52a16c`

## Readiness After Product Intel

Source: `readiness_after_product_intel_all14/summary.json`

- Scanned rows: 14
- Action required: 3
- DB serving ready: 11
- Public index ready: 11
- Blocker breakdown: `db_serving_ready` x11, `kb_missing` x2, `index_doc_shadow_only` x1
- Lane breakdown: `ready_no_action` x11, `lane_3_kb_rewrite_review` x2, `lane_1_identity_index` x1
- Direct displayable KB: 12
- Direct high-quality KB: 12
- Missing or no direct KB: 2
- Identity ready rows: 14
- Rows with public doc: 11
- Rows with public doc and insight summary: 11
- Source build failures: 0
- Warnings: 0

Interpretation: Lip Gloss is 11/11 ready. The 3 remaining action-required rows are the held Color Primer product-line candidates.

## Live PDP Audit

Source: `live_pdp_modules_audit_final_lip_gloss.json`

- Scanned: 11
- Ready: 11
- Thin: 0
- Not conversion ready: 0
- Domain split: `joocyee.com` x11
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

## Coverage Rollup After Wave37

Source: `latest_rollup_after_wave37/wave24_candidate_rollup.json`

- Production rows: 597
- Catalog attached: 597 / 597 (100%)
- Index serving eligible: 306 (51.3%)
- Identity ready: 317 (53.1%)
- Product intel high-quality: 383 (64.2%)
- Ready or covered: 100
- Hold source gap: 136
- Hold risk review: 358
- Serving index sync: 3
- Recommended next batch rows: 3

Joocyee domain after Wave37:

- Rows: 18
- Catalog attached: 18
- Index serving eligible: 15
- Identity ready: 18
- Product intel high-quality: 16
- Ready or covered: 15
- Serving index sync: 3

## Next Gate

The latest recommended-next batch contains only the 3 Joocyee `Color-correcting Primer` rows. They should not be production-applied as a plain serving sync until the exact-merge and sellable-variant relationship is reviewed or the product-line identity model is explicitly normalized.
