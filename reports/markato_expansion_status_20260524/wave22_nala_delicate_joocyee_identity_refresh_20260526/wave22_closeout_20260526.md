# Wave22 Markato Coverage Closeout - 2026-05-26

## Scope

Wave22 expanded reviewed Markato US coverage across 17 external-seed products:

- Nala Care: 8 natural deodorants.
- Delicate Daisys Botanical Beauty: 7 body/face/hair products.
- Joocyee: 2 makeup products.

Held or excluded:

- Medicube 3 candidates were held because catalog sync dry-run returned `identity_review_required`.
- Joocyee Dual-Ended Eyebrow Pencil & Cream 2.0 was held because the variant audit flagged `default_option_size_evidence_missing_axis`.
- Nala Breast Oil was held because evidence was `official_pdp_seed`, not the reviewed `seller_plus_formula` lane.
- Nala Peach & Chamomile and selected Delicate Daisys rows with `missing_hero` active-ingredient status were not advanced.

## Production Apply

Catalog sync production apply:

- requested_ids: 17
- fetched_rows: 17
- mirror_rows: 17
- missing_ids: 0
- skipped: 0
- product_upserts: 17
- sku_upserts: 27
- offer_upserts: 27
- group_member_upserts: 17
- seed_attachment_updates: 2
- index_state_upserts: 17
- identity_live_read_updates: 17

Reviewed product-intel publish:

- report rows: 17
- KB entries written: 17
- skipped_rows: 0
- evidence_profile: `seller_plus_formula` for all 17
- no seller-only fallback

## Readiness

Post product-intel readiness audit:

- scanned_rows: 17
- action_required_rows: 0
- db_serving_ready_rows: 17
- public_index_ready_rows: 17
- KB direct_displayable: 17
- KB direct_high_quality_ready: 17
- identity_ready_rows: 17
- public dry-run docs: 17
- public docs with insight summary: 17
- warnings: 0
- source_build_failures: 0

## Live PDP Final

Final production live PDP audit used build `eed9e1d77804` and conservative probe settings (`concurrency=1`, `timeout-ms=60000`) to avoid post-deploy request timeout noise.

Final result:

- scanned: 17
- ready: 8
- thin: 9
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- blocker_counts: `missing_how_to` = 9

Ready IDs:

- `ext_bb9685457f5a919c945ee9ce` - Joocyee Glazed Lip Gloss
- `ext_794deab047eb4a75225329df` - Joocyee Color-correcting Primer
- `ext_b5dafedce57973dfcca9fb5b` - Delicate Daisys Rejuvenating Night Face Cream Bulgarian Rose
- `ext_9695064b5f7d76303f88beb1` - Delicate Daisys Firming & Toning Body Cream Pineapple & Retinol
- `ext_3405f1b2b381c9a5e0941c20` - Delicate Daisys Glimmer Tanning Body Oil Colloidal Gold
- `ext_770904b0a8a54583347cea85` - Delicate Daisys Herbal Hair Mask Probiotics
- `ext_b344f028268229b02a16d0cb` - Delicate Daisys Cooling After Sun Body Oil Aloe Vera
- `ext_31b732e4e40c0579c5f4c554` - Delicate Daisys Nourishing Probiotic Body Wash Pineapple

Thin IDs are source-backed content holds for missing official how-to:

- `ext_8136f11be69e6c18781a7f02` - Nala Peppermint & Activated Charcoal Natural Deodorant
- `ext_e5f66cf29d6c516775bb0fce` - Nala Essence of Rosewood Extra Strength Natural Deodorant
- `ext_446a5f126507ff6adba46258` - Nala Eucalyptus & Champa Extra Strength Natural Deodorant
- `ext_2ef1955968e55d0bfdf5fe78` - Nala Palo Santo & Sage Sensitive Skin Natural Deodorant
- `ext_5975f96c1d90b02d02329960` - Nala Unscented Sensitive Skin Natural Deodorant
- `ext_21216a67b62b16d88661367f` - Nala Lavender & Vetiver Sensitive Skin Natural Deodorant
- `ext_b36935c92dc89857bf62f25e` - Nala Grapefruit & Neroli Extra Strength Natural Deodorant
- `ext_e08d2e62205f1691dfe30753` - Nala Coastal Waters Extra Strength Natural Deodorant
- `ext_99b5d36c01c7614a5de71fa1` - Delicate Daisys Cleansing Face Milk Bulgarian Rose

## Runtime Fix

The first post-product-intel audit exposed `product_intel_budget_exceeded` on several rich external PDPs. The PDP product-intel sync budget default was raised from 1500ms to 5000ms while preserving `PDP_PRODUCT_INTEL_SYNC_BUDGET_MS` env override. After deployment, product-intel blockers cleared in the conservative final audit.

## Verification

- `npx jest tests/pdp_product_intel_kb_hydration.test.js tests/pdp_product_intel_modules.test.js tests/scripts/audit_external_seed_live_pdp_modules.test.js tests/pdp_config.test.js --runInBand`
- Production `/version`: `eed9e1d77804`
- Production readiness audit after product-intel
- Production live PDP final retry audit

No `railway up` was used; deployment was via `git push` only.
