# Markato Wave51 Source Acquisition Packet - 2026-05-28

## Reviewer Decision

Wave50 exhausted the current official HTML source-gap recovery path. This packet converts the remaining held rows into operator-ready acquisition and review lanes instead of forcing unsafe promotions.

- Production apply performed: no
- Git/Railway deployment action performed by this packet: no
- Safe standalone promotion candidates identified: 0
- Source-gap rows packaged: 83
- Retailer-offer attachment candidates packaged: 2

## Inputs

- Wave50 candidate rollup: `current_rollup/wave24_candidate_rollup.json`
- Wave50 official HTML source-gap dry-run: `official_html_source_gap_probe_dry_run/dry-run.json`
- Wave50 Dermstore duplicate dry-run: `dermstore_concealer_serving_sync_dry_run.json`

The official HTML dry-run scanned 83 rows and found no `pdp_ingredients_raw` evidence. The only safe move is source acquisition, canonical mapping, or retailer-offer design.

## Priority Counts

| priority | count |
| --- | --- |
| P0 | 20 |
| P1 | 3 |
| P2 | 53 |
| P3 | 7 |

Priority definitions:

- P0: likely beauty-formula rows that can be unlocked by official full INCI and/or product-specific how-to evidence.
- P1: evidence-review or retailer-offer attachment work that needs human review/design before serving.
- P2: add-on, wholesale, display, pack, or bundle surfaces that need parent/canonical mapping before source recovery.
- P3: utility, service, accessory, kit, book, or otherwise terminal hold candidates.

## Acquisition Lane Counts

| lane | count |
| --- | --- |
| canonical_parent_or_bundle_mapping_request | 53 |
| partner_full_inci_and_how_to_request | 13 |
| non_formula_or_terminal_hold_candidate | 7 |
| partner_full_inci_request | 5 |
| partner_how_to_request | 2 |
| ingredient_evidence_review_request | 2 |
| retailer_offer_attachment_candidate | 1 |

## P0 Brand Requests

| brand | domain | p0_rows | p0_acquisition_lanes | p0_request_focus |
| --- | --- | --- | --- | --- |
| Miss Nella | missnella.com | 8 | partner_full_inci_and_how_to_request:8 | official full INCI / complete ingredients; official product-specific directions / how-to |
| Moss & Noor | mossnoor.com | 5 | partner_how_to_request:1\|partner_full_inci_and_how_to_request:4 | official product-specific directions / how-to; official full INCI / complete ingredients |
| OILUJ | oiluj.com | 3 | partner_full_inci_request:3 | official full INCI / complete ingredients |
| Linhart Smile Care | linhart.nyc | 2 | partner_full_inci_request:2 | official full INCI / complete ingredients; confirm source-backed directions if retained; official product description |
| Baie Botanique | baiebotanique.com | 1 | partner_how_to_request:1 | official product-specific directions / how-to |
| Byra | byrabeauty.com | 1 | partner_full_inci_and_how_to_request:1 | official full INCI / complete ingredients; official product-specific directions / how-to |

## Retailer Offer Attachment Candidates

| priority | source_type | external_product_id | title | duplicate_conflict_source_ids | recommended_action |
| --- | --- | --- | --- | --- | --- |
| P1 | source_gap_backlog | ext_1cc14ab28dee629b0bb1d3db | RMS Beauty Radiance Lock Setting Mist 100ml |  | Resolve through retailer-offer attachment or canonical RMS official source mapping before any serving promotion. |
| P1 | identity_refresh_duplicate_skip | ext_b8af61a562f4ab972197f413 | RMS Beauty Revitalize Hydra Concealer 0.17fl oz (Various Shades) | ext_1c6390a4583df99215617f2b | Attach/merge as retailer offer against the existing canonical product signature; do not force standalone serving. |

Reviewer note: the Dermstore RMS concealer dry-run skipped with `duplicate_pivota_signature_conflict` against official RMS source `ext_1c6390a4583df99215617f2b`. Treat it as offer attachment/merge work, not a standalone serving promotion.

## Terminal Hold Candidates

| brand | external_product_id | title | next_action |
| --- | --- | --- | --- |
| 786 Cosmetics | ext_e96da71bdfd3ec573a4642cd | Shipping Protection | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| RMS Beauty | ext_9ed40a265f7b8f06d4c05645 | The Artist Toolkit | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| UpCircle Beauty | ext_092b6aa9139491c529586778 | Bamboo Cotton Buds - 200 Pieces | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| UpCircle Beauty | ext_08c2ddfec1c05e891513988b | Organic Muslin Face Cloths | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| UpCircle Beauty | ext_ab96b5d595d2fcba9ab8e9b6 | Refill Safety Razor Blades – Pack Of 10 | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| UpCircle Beauty | ext_f79a99a09a933e731880cdfb | Safety Razor Stand | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |
| UpCircle Beauty | ext_48bff725ea55adb2e644f108 | UpCycled Beauty Hardback Book | taxonomy confirmation only; no INCI/how-to request unless formula eligibility is proven |

## Operator Instructions

1. Start with `source_acquisition_requests.csv` P0 rows. Request official full INCI and/or product-specific directions from the brand/partner source listed in `requested_source_fields`.
2. Do not promote rows from `canonical_parent_or_bundle_mapping_request` until parent/variant/bundle identity is resolved.
3. Do not promote `retailer_offer_attachment_candidate` rows until there is an explicit canonical product / retailer-offer attachment path.
4. Keep P3 rows out of beauty-formula serving unless taxonomy review proves they are formula products.
5. After new official source evidence arrives, rerun source-gap audit/backfill in dry-run mode first, then require human review before any apply.

## Artifacts

- `source_acquisition_requests.csv`
- `brand_source_request_summary.csv`
- `retailer_offer_attachment_candidates.csv`
- `source_acquisition_manifest.json`
