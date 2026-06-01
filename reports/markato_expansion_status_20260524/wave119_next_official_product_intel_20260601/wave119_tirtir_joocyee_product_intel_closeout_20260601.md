# Wave119 TIRTIR + Joocyee Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 17 reviewed product-intel rows:

- TIRTIR: 15 rows
- Joocyee: 2 rows

## Written Rows

TIRTIR:

- `ext_fa7c10a18a8ee11fa3d1d68a` - Airy Bloom Mesh Blush
- `ext_cb315ad422dd53f36c31904e` - Ampoule Mask Packs
- `ext_d4821c6edda6594aed724f35` - Banana BDRN Eye Mask ( 7ea )
- `ext_a931bd8cc0a35f9557bbc381` - Banana BDRN Eye Serum
- `ext_1d8c27b856564035c82f3c6b` - Ceramic Cream
- `ext_93bc270bdddd0b29e2097dd9` - Ceramic Cream Light
- `ext_8cfa0e837e468e79ecd6cc3a` - Ceramic Milk Ampoule
- `ext_59e20f5ac3693f442e3bdfd2` - Ceramide Moisture Gel Mask
- `ext_b0c69b8e4b3b439d52f4b8bb` - Collagen Firming Gel Mask
- `ext_4968167c701faea363cf29ba` - Collagen Lifting Eye Cream
- `ext_4e8c76f135dacc76b2653045` - Flawless Pore Prep Primer
- `ext_cab1810f4fae3a388fd00c9b` - Glide & Hide Blurring Concealer
- `ext_c7334c30ca5401f2ea0aa01f` - Glossy Coating Mist
- `ext_5b2a492be891f19ac5b998c9` - Hydro Boost Enzyme Cleansing Balm
- `ext_19eb840d0184fc50040ca660` - Hydro Boost Enzyme Powder Wash

Joocyee:

- `ext_10d91302e0cbb32d89cb0cb7` - Dual-Ended Eyebrow Pencil & Cream 2.0
- `ext_bb9685457f5a919c945ee9ce` - Glazed Lip Gloss

## Reviewer Decisions

Applied:

- TIRTIR and Joocyee rows used official brand PDP URLs with formula/usage or key-ingredient/usage evidence.
- Apply scanned 17 rows, changed 17 rows, and upserted 25 KB entries.
- Replacement policy still skipped 9 protected keys rather than overwriting verified or community-supported content.

Held:

- Catkin Moonlight Lip Balm: 19 changed IDs all pointed at the same canonical official URL. Held for variant/identity review instead of bulk-writing duplicate line content.
- Terra & Co.: held because the batch was oral-care, limited evidence, and included two manual-quality blocks.
- Linhart: held because the changed rows were oral-care/whitening adjacent and lower-signal than the selected TIRTIR/Joocyee batch.
- Flower Knows: held duplicate palette rows on the same canonical URL; `Single Mystery Pick` was blocked by `candidate_failed_manual_quality_gate:variant_only_intro_without_product_copy`.
- Byra: held because the batch used limited evidence and included three manual-quality blocks.
- Guerlain: no safe writes; existing content protected high-quality reviewed content.

Excluded from TIRTIR apply:

- `ext_21d2c4d0ecbfe8289a755991` - Azelaic Acid 12% Serum
- `ext_03784852f86b262442d136a1` - Dermatir Intensive Lotion MD
- `ext_4dcc28e0f84ce9b3fcec9241` - Hydro UV Shield Sunscreen
- `ext_76c0f966701116de62498f48` - Glowy Jelly Tint

## Validation

Exact post-apply readiness audit:

- scanned rows: 17
- direct high-quality KB: 17/17
- DB serving ready: 12/17
- public index ready: 12/17
- public docs built by dry-run: 14
- identity ready: 16/17
- terminal holds: 2
- blockers: `db_serving_ready` x12, `index_doc_shadow_only` x2, `terminal_hold` x2, `identity_blocked` x1

Live PDP module audit with attached rows included:

- scanned rows: 17
- ready: 12
- thin: 3
- not conversion ready: 2
- thin rows: TIRTIR Airy Bloom Mesh Blush, Banana BDRN Eye Mask, Banana BDRN Eye Serum; each was missing how-to.
- not conversion ready rows: both Joocyee rows, due source/index content gaps rather than product-intel write failure.

No `railway up` was run.
