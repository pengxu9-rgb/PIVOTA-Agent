# Wave16 Lucamar Remainder Closeout - 2026-05-25

## Scope

Brand: Lucamar Skin Care
Market: US
Domain: lucamarskincare.com

Promoted 3 source-backed Baa Ram Ewe body balm SKUs from the Wave6 remainder:

- `ext_c26547ca63d530592ed62d63` - Baa Ram Ewe Lanolin Skin Balm 120g UNSCENTED
- `ext_0836525e72365da8ecbcc3b5` - Baa Ram Ewe Lanolin Skin Balm 120g
- `ext_edcf7e510314384ac432b385` - Baa Ram Ewe Lanolin Skin Balm 50g

Held 2 Lucamar lip balm rows because the current official source has ingredient evidence but no explicit official how-to.

## Source And Curation

- Current official Shopify source was fetched and archived under `source/`.
- Catalog-intelligence extraction was rerun with `https://lucamarskincare.com` so source validation stayed brand-owned; using the bare domain misclassified the source as channel/retailer.
- Builder output: 5 scanned, 3 ready, 2 held.
- Ready rows include source-backed `pdp_ingredients_raw`, `ingredients_inci`, `raw_ingredient_text_clean`, `pdp_how_to_use_raw`, product kind `single_formula`, and category path `beauty/bodycare/body-balm`.

## Production DB Writes

Applied to production through `railway run --environment production --service PIVOTA-Agent`; no `railway up` was used.

- External seed creation: 3 inserted, 0 invalid, 0 skipped existing.
- PDP identity graph: 3 written, 0 review queue rows.
- Catalog sync: 3 product/SKU/offer/group/index rows already present or upserted; identity live-read updates: 3.
- Quality snapshot repair: 3 product quality snapshots inserted and 3 index states updated.
- Product-intel KB publish: 3 reviewed `seller_plus_formula` entries written, 0 skipped.

## Quality Gates

Local regression:

- `npx jest --watchman=false --runInBand tests/services/pdp_ingredient_authority.test.js tests/scripts/audit_external_seed_live_pdp_modules.test.js`
- Result: 2 suites passed, 49 tests passed.

Production readiness after product-intel:

- Domain rows scanned: 5
- Current-wave DB serving ready: 3
- Remaining action-required Lucamar rows: 2 old `seed_content_blocked` category rows from earlier Lucamar coverage, not part of this wave.
- Public commerce dry-run docs: 3
- Public docs with insight summary: 3
- Source build failures: 0
- Warnings: 0

Production live PDP modules after deploy:

- Scanned: 3
- Ready: 3
- Thin: 0
- Not conversion ready: 0
- `weak_insights_ids`: 0
- `seller_only_insights_ids`: 0
- `force_filled_ids`: 0
- `content_gap_ids`: 0

## Deployed Fix

Initial live PDP audit found the 3 rows were DB-ready but thin due to `missing_ingredients`. The ingredient text was present in source-backed PDP details, but the authority classifier undercounted common lanolin balm INCI terms such as Lanolin, Cera Alba, Bees Wax, Vitellaria, and fragrance.

Code change:

- Commit: `b1a452289dcaaf2ae40482b2489241214f1f006f`
- Commit message: `fix(pdp): recognize lanolin balm ingredient authority`
- Production deployment: `6b42582a-5e78-4c3c-a31d-93df3904a4ac`
- Production `/version`: `b1a452289dca`

The fix keeps source-backed lanolin balm INCI visible in `ingredients_inci`; it does not enable seller-only fallback or force-filled ingredient display.

## Other Candidate Recovery Checks

Checked but did not promote in this pass:

- OIlUJ: US/USD commerce visible, but current official pages lack explicit full INCI/how-to.
- Aetas: current official source is JP/JPY, so held for market mismatch.
- LIME: US/USD commerce visible, but current official source is image/size-heavy and lacks full INCI/how-to text.
