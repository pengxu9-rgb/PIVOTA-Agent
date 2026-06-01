# Wave120 TIRTIR + UpCircle + Kylie Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 18 reviewed product-intel rows:

- TIRTIR: 13 rows
- UpCircle: 4 rows
- Kylie Cosmetics: 1 row

## Written Rows

TIRTIR:

- `ext_39b3cafe7938c761c8530f81` - Ice-Cooling Toner Pack Pads
- `ext_07509f4743c82d62b2f15231` - Ice-Cooling Water Drop Serum
- `ext_0c5ff135e1e9209ad85ba45a` - Mask Fit AI Filter Cushion
- `ext_a639cc92b3446b6eee7cabe7` - Mask Fit All Cover Cushion
- `ext_f547012d9e7a18a054240103` - Mask Fit All Cover Cushion Refill
- `ext_68ad409f681f1278525ced16` - Mask Fit Aura Cushion
- `ext_4f43738711dfea4e88975cf4` - Mask Fit Cushion Refill
- `ext_263b61b2d374b255d121c928` - Mask Fit Makeup Fixer
- `ext_a663b50d44c3cc2c3f541e15` - Mask Fit Red Cushion
- `ext_7ba277de9baadb1584ae2a5a` - Mask Fit Red Foundation
- `ext_6df19f2224fec208ca6eeea7` - Matcha Bubble Tea Scrub
- `ext_c989d8297287ad108ef57250` - Matcha Dual Serum
- `ext_fa03729895112b24e3687e85` - Matcha Pack Cleanser

UpCircle:

- `ext_664b859ce2599a57c3f1f7ce` - Body Oil with Passion Fruit Oil
- `ext_23ae4c5d9d8f2a8be363f2cc` - Body Scrub with Coffee + Lemongrass
- `ext_f1f3ce59fac13141b98a911f` - Cinnamon + Ginger Chai Cleansing Bar
- `ext_6815bee1060ef71d9a99ce5b` - Cleansing Face Milk with Oat Powder + Aloe Vera

Kylie Cosmetics:

- `ext_0c7bfbaafb9eab5f2261f109` - Bare Necessities Lip Combo

## Reviewer Decisions

Applied:

- TIRTIR second slice used official brand PDP URLs with formula/usage evidence. Excluded rows with regulated, medical, sample, or ambiguous URL concerns.
- UpCircle was narrowed to four single-product formula/usage rows. Limited bundles, testers, accessories, and blocked bath salts were held.
- Kylie had one safe official line row and was applied.

Held / rejected:

- INNBeauty and Rare Beauty probes produced no safe writes because existing rows were protected reviewed/community-supported content.
- Pixi and RMS probes produced no safe writes; RMS still had the previously blocked toolkit row.
- Nuxe wider probe was held because the changed rows were giftset duplicates or lower-signal line rows.
- UpCircle limited rows and `Bath Salts with Epsom, Sea + Himalayan Pink Salt` were held; bath salts failed `candidate_failed_manual_quality_gate:insufficient_official_pdp_specificity`.
- TIRTIR rows held from second slice: Azelaic Acid 12% Serum, Dermatir Intensive Lotion MD, Hydro UV Shield Sunscreen, Glowy Jelly Tint, and sachet/sample duplicates.

## Validation

Exact post-apply readiness audit:

- scanned rows: 18
- direct high-quality KB: 18/18
- DB serving ready: 8/18
- public index ready: 8/18
- public docs built by dry-run: 8
- identity ready: 13/18
- terminal holds: 2
- blockers: `db_serving_ready` x8, `identity_blocked` x5, `index_doc_shadow_only` x3, `terminal_hold` x2

Live PDP module audit with attached rows included:

- scanned rows: 18
- ready: 9
- thin: 4
- not conversion ready: 5
- ready rows: 9 TIRTIR rows
- thin rows: TIRTIR Mask Fit Cushion Refill, Mask Fit All Cover Cushion Refill, Mask Fit Red Foundation, Mask Fit Red Cushion; each was missing how-to.
- not conversion ready rows: all 4 UpCircle rows and the Kylie row, due source/index content gaps rather than product-intel write failure.

No `railway up` was run.
