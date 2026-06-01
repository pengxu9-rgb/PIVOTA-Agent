# Wave121 TIRTIR + Baie Botanique Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly 14 reviewed product-intel rows:

- TIRTIR: 11 rows
- Baie Botanique: 3 rows

## Written Rows

TIRTIR:

- `ext_2ed925c42fe7f2dfd73f98db` - Matcha Tea Pads
- `ext_d368298110b2622b6aa73530` - Milk Creamy Foam Cleanser
- `ext_768ca6b8f29b99645a02a72d` - Milk Skin Toner
- `ext_a6d24d905734889cd2a91fde` - Milk Skin Toner Light
- `ext_48efa66217f45990e58a3b50` - Mood Glider Lip And Blush Stick
- `ext_daab8cbcc38d218fdb6d7d22` - My Glow Ampoule Highlighter
- `ext_1c44481f8143059d23195915` - My Glow Lip Oil
- `ext_582d80fdcf353c0e8c0edd9d` - Waterism Glow Melting Balm
- `ext_de52f233645e757f2fcf89b0` - Waterism Lip Plumper
- `ext_02bd3cd623ef5dfb6e46d0d3` - Water Mellow Lip Balm
- `ext_62f7f0e601b4a7076878dcc2` - Reflect Glow Prep Primer

Baie Botanique:

- `ext_f11383c339335d64f05a964e` - Regenerating Eye Cream
- `ext_60ded78effb04e9d6389bfce` - Rose & Cupuacu Enzyme Cleanser
- `ext_1d312f4c2dac999920d9b936` - Rose Renew Face Wash

## Reviewer Decisions

Applied:

- Selected TIRTIR non-regulated cleanser, toner, makeup, lip, and primer rows with official formula/usage evidence.
- Selected Baie Botanique eye cream and cleanser/face-wash rows; sunscreen rows were excluded.
- Apply scanned 14 rows, changed 14 rows, and upserted 22 KB entries.
- Replacement policy skipped 6 protected verified/community-supported keys instead of overwriting them.

Held / rejected:

- TIRTIR held: Azelaic Acid 12% Serum, Dermatir Intensive Lotion MD, Hydro UV Shield Sunscreen, Glowy Jelly Tint, sachets, stickers, keyring/accessory rows, acid/high-strength active serums, and lower-confidence line rows.
- Baie Botanique held: all sunscreen/SPF rows and lower-signal serum line row.
- Miss Nella and Nourwish were not applied because their probes were mostly limited evidence and manual-quality blocks.

## Validation

Exact post-apply readiness audit:

- scanned rows: 14
- direct high-quality KB: 14/14
- DB serving ready: 11/14
- public index ready: 11/14
- public docs built by dry-run: 11
- identity ready: 13/14
- blockers: `db_serving_ready` x11, `index_doc_shadow_only` x2, `identity_blocked` x1

Live PDP module audit with attached rows included:

- scanned rows: 14
- ready: 11
- thin: 2
- not conversion ready: 1
- thin rows: Baie Rose Renew Face Wash and TIRTIR Reflect Glow Prep Primer, each missing how-to.
- not conversion ready row: Baie Rose & Cupuacu Enzyme Cleanser, due source/index content gaps rather than product-intel write failure.

No `railway up` was run.
