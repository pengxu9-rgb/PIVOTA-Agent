# Markato Wave60 Miss Nella Roll-On Perfume Evidence Review - 2026-05-29

## Reviewer Decision

Wave60 reviewed the two P1 Miss Nella roll-on perfume rows that Wave51 flagged for human ingredient-evidence review.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Official rows reviewed: 2
- Official Shopify product JSON rows reviewed: 2
- Official HTML ingredient accordions found: 2
- Official how-to accordions found: 2
- Official media assets downloaded/reviewed: 14/14
- Complete INCI-grade rows found: 0
- Patch candidates: 0
- Remaining source requests: 2

## Finding

Both official PDPs provide product descriptions, a how-to accordion, and an ingredient accordion. The how-to evidence is usable: the official source directs rolling onto wrists and neck and reapplying as needed.

The ingredient evidence is not complete enough for promotion. The official ingredient accordion lists a generic oil base plus fragrance components rather than a complete INCI-grade declaration for the carrier/base and full formula. All 14 official images were reviewed; they show front-label, scent, lifestyle, and easy-roll-on evidence, but no back-label ingredient panel.

The correct reviewer decision is to keep both rows on content-evidence hold until the brand/partner provides complete INCI-grade ingredient declarations.

## Still Blocked

| external_product_id | title | blocker |
| --- | --- | --- |
| ext_cfbb0ca2b9d0c7b411793b0b | 'Cool Like Me' Roll On Perfume | incomplete INCI-grade ingredient evidence |
| ext_6f491538dbf9a790b66cf269 | 'Sweet Like Me' Roll On Perfume | incomplete INCI-grade ingredient evidence |

## Operator Instructions

1. Do not promote either roll-on perfume from Wave60.
2. Do not use the generic oil-base ingredient text as complete INCI evidence.
3. Ask Miss Nella/partner for complete carrier/base INCI and fragrance declaration before retrying source patching or serving readiness.

## Artifacts

- `missnella_rollon_perfume_evidence_review.csv`
- `missnella_rollon_perfume_remaining_source_requests.csv`
- `wave60_missnella_perfume_evidence_review_manifest.json`
