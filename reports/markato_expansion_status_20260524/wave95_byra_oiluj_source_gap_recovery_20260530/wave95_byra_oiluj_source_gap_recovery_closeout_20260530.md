# Wave95 Byra / OILUJ Source-Gap Recovery Closeout - 2026-05-30

## Scope

Wave95 continued the Markato US source-gap lane after Wave94 cleared the serving-index sync queue.

Targets reviewed:

- Byra `ext_d2be72abe173e52d5baa6879` - Deep Calm Eau De Parfum 30ml
- OILUJ `ext_ab35eb07e8635bb1e1be3ebf` - Life Oil
- OILUJ `ext_1493a61baf165a6c00e4977b` - Life Oil Organic Moringa / French Lavender Blend
- OILUJ `ext_07cfaab25950196c3ec1b5f3` - Life Oil Organic Moringa / Sandalwood Blend

## Code Change

Added a narrow `oiluj.com` official HTML parser to `scripts/backfill-external-seed-official-html-pdp-fields.cjs`.

Parser behavior:

- Reads only the current product's `wsite-com-product-short-description` block.
- Recovers short official ingredient formulas only from explicit official product-body language.
- Leaves the pure Life Oil row unchanged because the official wording is single-ingredient but not strong enough under this parser's recovery rule.

Validation:

- `node --check scripts/backfill-external-seed-official-html-pdp-fields.cjs` passed.

## Dry Runs

Byra official HTML dry run:

- scanned: 1
- dry_run: 1
- patch fields: `pdp_details_sections`
- ingredients chars: 0
- how-to chars: 0
- outcome: no apply; this did not close the actual missing INCI/how-to gap.

OILUJ official HTML dry run:

- scanned: 3
- dry_run: 2
- skipped: 1
- patch fields: `pdp_ingredients_raw: 2`
- skipped row: `ext_ab35eb07e8635bb1e1be3ebf`

## Applies

Official source apply:

- requested/scanned: 2
- updated: 2
- patch fields: `pdp_ingredients_raw: 2`

Serving sync dry run:

- requested/fetched/mirror rows: 2/2/2
- planned SKU/offer/index rows: 2/2/2
- missing IDs: 0
- skipped: 0
- planned stale deletes: 0
- both rows planned `servingEligible: true`

Serving sync apply:

- product upserts: 2
- SKU upserts: 2
- offer upserts: 2
- group member upserts: 2
- index state upserts: 2
- catalog row trust upserts: 2
- stale deletes: 0

## Live PDP Reviewer Gate

Post-sync live PDP quality audits were run for both recovered OILUJ rows.

Passed gates for both rows:

- seed gate
- extractor gate
- identity gate
- product intel gate
- live PDP gate
- offer/price module
- image health: 0 broken images
- variant gate

Failed gate for both rows:

- similar gate
- `similar_count: 2`
- failure reason: `similar_underfill`
- root cause: `similar_issue`

Because the live reviewer gate failed, both recovered rows were not left in serving.

## Holds Applied

Content evidence hold:

- rows held: 2
- reason: `post_sync_audit_failed_similar_gate`
- evidence: `similar_underfill_after_official_source_recovery`
- updated external product seeds: 2
- updated catalog products: 2
- updated catalog SKUs: 2
- updated index rows: 2

Post-hold sync result:

- both rows now `servingEligible: false`
- blocker code: `content_evidence_hold`
- blocker detail: `post_sync_audit_failed_similar_gate`

## Outcome

Wave95 recovered official ingredient source data for 2 OILUJ rows but added 0 serving rows because the live PDP similar rail was underfilled.

Rows source-recovered but held:

- `ext_1493a61baf165a6c00e4977b`
- `ext_07cfaab25950196c3ec1b5f3`

Rows not recovered:

- Byra `ext_d2be72abe173e52d5baa6879`: official dry run only found detail sections, not INCI/how-to.
- OILUJ `ext_ab35eb07e8635bb1e1be3ebf`: official single-ingredient wording was not applied by this conservative parser.

## Current Rollup

After Wave95:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 278/613
- identity ready: 392/613
- product intel high quality: 547/613
- ready or covered: 127
- hold source gap: 101
- hold risk review: 385
- recommended next batch rows: 0

OILUJ domain after Wave95:

- rows: 5
- catalog attached: 5/5
- index serving eligible: 3
- identity ready: 5
- product intel high quality: 5
- hold source gap: 3
- hold risk review: 2
- quality flags: `content_evidence_hold:2`, `missing_full_inci:1`

## Next Actionable Lanes

1. Similar rail repair for held but otherwise live-PDP-ready rows, including the 2 OILUJ rows and prior similar-underfill holds.
2. Continue source-gap probes only where official pages expose INCI/how-to strongly enough to pass reviewer gates.
3. Avoid forcing Byra Deep Calm or OILUJ pure Life Oil into serving until official source evidence closes the actual missing fields.
