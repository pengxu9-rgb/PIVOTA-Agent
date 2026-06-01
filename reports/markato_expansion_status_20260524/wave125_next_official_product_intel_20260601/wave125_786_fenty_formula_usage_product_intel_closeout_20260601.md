# Wave125 786 Cosmetics + Fenty Formula/Usage Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 11 reviewed product-intel rows with official formula plus usage evidence:

- 786 Cosmetics: 9 breathable nail polish shade rows
- Fenty Beauty: 2 body cream rows

## Written Rows

786 Cosmetics:

- `ext_8573685e1cc94840934c764d` - Goychay - Breathable Nail Polish
- `ext_ab5107f3a835da10508757c6` - Havana - Breathable Nail Polish
- `ext_41aeeb470016979417c8637d` - Kabul - Breathable Nail Polish
- `ext_a36359795b89961a7c052b21` - Karachi - Breathable Nail Polish
- `ext_69dcb156e335cb9756e016b2` - Kashmir - Breathable Nail Polish
- `ext_c6d113bff874c00abfb4ba33` - Tallinn - Breathable Nail Polish
- `ext_da3b149ed322142c187224b6` - Toulouse - Breathable Nail Polish
- `ext_f56010dd5bf971f7b7f644a6` - Uluru - Breathable Nail Polish
- `ext_2c4793f5f96ec2d4680fd55b` - Zhangye - Breathable Nail Polish

Fenty Beauty:

- `ext_79da6167f30f91d77e4d018b` - Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter - Fenty Fresh
- `ext_b0cae796baeb2e52326f7643` - Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter - Vanilla Dream

## Reviewer Decisions

Applied:

- Selected only single-product rows with official PDP description, ingredient evidence, usage instructions, detail cues, and variant/shade clarity.
- Apply scanned 11 rows, changed 11 rows, and upserted 22 KB entries.
- All written rows used `official_pdp_reviewed_formula_and_usage`.

Held / rejected:

- 786 Canvas Tote Bag, Gift Card, Shipping Protection, nail-polish sets, and collection/bundle rows remained held.
- Fenty accessories, bundles, sunscreen collector box, AHA mask, and key-ingredients-only cleanser were held.
- Fenty Butta Drop Body Milk remained held because the generated preview still misclassified it as fine fragrance.
- Kylie rows were held because the writeable set was mostly bundles, tools, or generic/incorrect usage copy.
- Guerlain was already protected after Wave124.

## Validation

Exact post-apply readiness audit:

- scanned rows: 11
- direct high-quality KB: 11/11
- DB serving ready: 2/11
- public index ready: 2/11
- public docs built by dry-run: 2
- identity ready: 11/11
- blockers: `db_serving_ready` x2, `index_doc_shadow_only` x9

Live PDP module audit with attached rows included:

- scanned rows: 11
- ready: 11
- thin: 0
- not conversion ready: 0
- weak insights IDs: 0
- seller-only insights IDs: 0
- content gap IDs: 0

Recommended next moves:

- Run identity/index serving sync review for the 9 786 rows before counting them as DB serving-ready.
- Continue 786 only on single-shade formula/usage rows; keep sets, accessories, gift cards, and shipping/service rows out of product-intel apply batches.
- Fenty should stay limited to clean body-care/makeup rows unless sunscreen/active-acid review rules are explicitly expanded.

No `railway up` was run.
