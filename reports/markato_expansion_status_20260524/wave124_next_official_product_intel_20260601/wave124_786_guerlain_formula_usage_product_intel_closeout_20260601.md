# Wave124 786 Cosmetics + Guerlain Formula/Usage Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 11 reviewed product-intel rows with official formula plus usage evidence:

- 786 Cosmetics: 10 breathable nail polish shade rows
- Guerlain: 1 lipstick row

## Written Rows

786 Cosmetics:

- `ext_0d844fc65fd3348e35a09c80` - Abu Dhabi - Breathable Nail Polish
- `ext_151aebc5b6246b8d2d9a877b` - Agra - Breathable Nail Polish
- `ext_faf89834933316df0d8da973` - Azores - Breathable Nail Polish
- `ext_2fc7cc1ac3370464b4b923d3` - Bahrain - Breathable Nail Polish
- `ext_33fa1a749060cefdd3e0dc2b` - Beirut - Breathable Nail Polish
- `ext_36b452da1e0dde5c19bd2ed0` - Casablanca - Breathable Nail Polish
- `ext_5f55c01bae5cd6b5f0a0e78e` - Dakar - Breathable Nail Polish
- `ext_efe7512de8c6df9f75ca19e0` - Dubrovnik - Breathable Nail Polish
- `ext_abd25039dea2189dfcca8079` - Patagonia - Breathable Nail Polish
- `ext_55b774d3c57906a77a7167f0` - Sorrento - Breathable Nail Polish

Guerlain:

- `ext_dc290a89c2c5daa2a5eab5cf` - ROUGE G THE CUSTOMIZABLE ULTRA-CARE LIPSTICK

## Reviewer Decisions

Applied:

- Selected only single-product rows with official PDP description, INCI/ingredient evidence, usage instructions, detail cues, and variant/shade clarity.
- Apply scanned 11 rows, changed 11 rows, and upserted 22 KB entries.
- All written rows used `official_pdp_reviewed_formula_and_usage`.

Held / rejected:

- 786 Canvas Tote Bag, Gift Card, Shipping Protection, nail-polish sets, and collection/bundle rows were held.
- Terra & Co dry-run was all limited evidence and was not applied.
- Joocyee was already protected high-quality.
- Guerlain had only one writeable row; the rest were protected high-quality.

## Validation

Exact post-apply readiness audit:

- scanned rows: 11
- direct high-quality KB: 11/11
- DB serving ready: 1/11
- public index ready: 1/11
- public docs built by dry-run: 1
- identity ready: 11/11
- blockers: `db_serving_ready` x1, `index_doc_shadow_only` x10

Live PDP module audit with attached rows included:

- scanned rows: 11
- ready: 9
- thin: 1
- not conversion ready: 1
- ready rows: 9 of the 10 786 nail-polish shade rows.
- thin row: Guerlain ROUGE G, missing how-to in the live module audit despite DB-serving readiness.
- not conversion ready row: 786 Sorrento, due source/index content module gaps.

Recommended next moves:

- Run identity/index serving sync review for the 10 786 rows before counting them as DB serving-ready.
- Treat the Guerlain row as DB-ready but live-PDP thin until how-to hydration is resolved.
- Continue 786 only on single-shade formula/usage rows; keep sets, accessories, gift cards, and shipping/service rows out of product-intel apply batches.

No `railway up` was run.
