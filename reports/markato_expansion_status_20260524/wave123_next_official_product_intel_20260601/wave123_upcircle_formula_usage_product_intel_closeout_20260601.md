# Wave123 UpCircle Formula/Usage Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 5 reviewed UpCircle Beauty product-intel rows with official formula plus usage evidence:

- `ext_4a83a2638c6cb6ca3c3df9e2` - Fennel + Cardamom Chai Cleansing Bar
- `ext_aafb624684ba1a334a53a076` - Flaura Eau De Parfum
- `ext_5f63056adbcee15d15e2aba1` - Hand + Body Lotion with Bergamot Water
- `ext_b13a29406f82ff32d2cc2a32` - Shampoo Creme with Pink Berry
- `ext_5195cd2ff341a491822447d9` - Shampoo Creme with Pink Berry - Jumbo

## Reviewer Decisions

Applied:

- Selected only UpCircle rows with official PDP description, ingredient list, usage instructions, and details.
- Apply scanned 5 rows, changed 5 rows, and upserted 10 KB entries.
- All written rows used `official_pdp_reviewed_formula_and_usage`.

Held / rejected:

- UpCircle limited-evidence rows were held, including deodorant refills, skincare bundles, haircare bundles, home/accessory rows, and tool/accessory rows.
- UpCircle `Home Mist with Lemongrass + Grapefruit Water` was held because it was already a known identity-review hold and should not be forced into serving.
- UpCircle `RETURN + REFILL ... - ON PAUSE` rows were held because paused/refill rows should not be promoted as normal sellable PDPs without explicit merchandising review.
- Fenty Skin returned 0 rows.
- Innbeauty and most RMS rows were already protected high-quality existing rows; RMS `The Artist Toolkit` was blocked by the manual quality gate.

## Validation

Exact post-apply readiness audit:

- scanned rows: 5
- direct high-quality KB: 5/5
- DB serving ready: 0/5
- public index ready: 0/5
- public docs built by dry-run: 0
- identity ready: 5/5
- blockers: `index_doc_shadow_only` x4, `seed_content_blocked` x1

Live PDP module audit with attached rows included:

- scanned rows: 5
- ready: 1
- thin: 0
- not conversion ready: 4
- ready row: `ext_aafb624684ba1a334a53a076` - Flaura Eau De Parfum.
- not conversion ready rows: cleansing bar, hand/body lotion, and both shampoo rows due source/index content module gaps.

Recommended next moves:

- For the four `index_doc_shadow_only` rows, run identity/index serving sync review before counting them as serving-ready.
- For `ext_aafb624684ba1a334a53a076`, repair missing seed category/commercial facts before public serving eligibility.
- Continue product-intel expansion only against formula/usage rows; avoid UpCircle limited bundle/accessory/refill-on-pause rows.

No `railway up` was run.
