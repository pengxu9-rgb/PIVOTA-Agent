# Wave118 Nuxe + RMS Product Intel Closeout - 2026-06-01

## Scope

Production-backed official-PDP product-intel continuation batch.

Applied exactly four reviewed product-intel rows:

- `ext_a75e4db085eb7c5f07d9098f` - Nuxe - Anti-Aging Routine, Super Serum [10]
- `ext_a88deef3fdce8d7c74077c0f` - Nuxe - Detangling Hair Brush
- `ext_f16d1ed12f9f2c9966d47d78` - RMS Beauty - Radiance Lock Setting Mist
- `ext_1c6390a4583df99215617f2b` - RMS Beauty - Revitalize Hydra Concealer

## Reviewer Decisions

Written:

- Nuxe dry-run selected 2 safe rows from the first 10; apply upserted 4 KB entries across external product IDs and signature IDs.
- RMS dry-run selected 2 safe official-brand-PDP rows; apply upserted 4 KB entries across external product IDs and signature IDs.

Held / rejected:

- Tom Ford first slice: 10 scanned, 0 changed; skipped because existing content is protected high-quality reviewed content.
- Beekman first slice: 10 scanned, 0 changed; skipped because existing content is protected high-quality reviewed content.
- Naturium first slice: 10 scanned, 0 changed; skipped because existing content is protected high-quality reviewed content.
- Ole Henriksen probe: 0 rows matched the brand filter.
- Murad probe: 2 changed candidates were not applied because their source URLs were Ulta retailer PDPs, not official brand PDPs; 1 additional row was blocked by `candidate_failed_manual_quality_gate:insufficient_official_pdp_specificity`.
- Nuxe duplicate Giftset The Iconics rows were held because two product IDs pointed at the same canonical official URL.
- RMS The Artist Toolkit was blocked by `candidate_failed_manual_quality_gate:variant_only_intro_without_product_copy`.

## Validation

Exact post-apply readiness audit:

- scanned rows: 4
- direct high-quality KB: 4/4
- DB serving ready: 1/4
- public index ready: 1/4
- identity ready: 3/4
- blockers: `index_doc_shadow_only` x2, `seed_content_blocked` x1, `db_serving_ready` x1

Live PDP module audit with attached rows included:

- scanned rows: 4
- ready: 2
- thin: 0
- not conversion ready: 2
- ready rows: both Nuxe rows
- not conversion ready rows: both RMS rows, due source/index content gaps rather than product-intel write failure

No `railway up` was run.
