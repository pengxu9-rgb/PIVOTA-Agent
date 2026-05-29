# Markato Wave58 OILUJ + Byra Source Triage - 2026-05-29

## Reviewer Decision

Wave58 reviewed four P0 source-acquisition rows after Wave57:

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Official rows reviewed: 4
- Official pages reachable: 4
- Official product JSON reviewed: 1
- Official media assets reviewed: 2
- Official descriptions found: 4
- Common-name ingredient evidence found: 3
- Formal INCI found: 0
- Official explicit how-to found: 0
- Patch candidates: 0
- Remaining source requests: 4

## Finding

Byra `Deep Calm - Eau De Parfum 30ml` now loads through the official PDP and Shopify product JSON endpoint. The official source provides product description and claim context, and the two product images were reviewed, but no ingredient declaration or product-specific directions were found.

The three OILUJ pages are reachable and provide official common-name composition context. They describe moringa oil, moringa/lavender oil, and moringa/sandalwood oil formulations, but they do not present a formal INCI-grade ingredient declaration. That is useful for partner follow-up, but it is not a safe full-INCI patch source.

## Still Blocked

| external_product_id | brand | title | requested_source_fields |
| --- | --- | --- | --- |
| ext_d2be72abe173e52d5baa6879 | Byra | Deep Calm - Eau De Parfum 30ml | official full INCI / complete ingredients; official product-specific directions / how-to |
| ext_ab35eb07e8635bb1e1be3ebf | OILUJ | OILUJ, Life Oil | official full INCI / complete ingredients |
| ext_1493a61baf165a6c00e4977b | OILUJ | OILUJ, Life Oil: Organic Moringa/ French Lavender Blend | official full INCI / complete ingredients |
| ext_07cfaab25950196c3ec1b5f3 | OILUJ | OILUJ, Life Oil: Organic Moringa/Sandalwood Blend | official full INCI / complete ingredients |

## Operator Instructions

1. Do not run an official-html apply for these four rows from Wave58.
2. Do not promote any Byra or OILUJ row from this wave.
3. For OILUJ, ask the brand/partner for INCI-grade ingredient names for the oil products before retrying a patch.
4. For Byra, ask for both full ingredients and product-specific directions before retrying serving readiness.

## Artifacts

- `oiluj_byra_official_source_triage.csv`
- `oiluj_byra_remaining_source_requests.csv`
- `wave58_oiluj_byra_source_triage_manifest.json`
