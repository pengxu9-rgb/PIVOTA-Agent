# Markato Wave57 Baie Botanique How-To Review - 2026-05-29

## Reviewer Decision

Wave57 reviewed the remaining Baie Botanique P0 source-acquisition row from Wave51 against the current official PDP and visible product media.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Official PDP rows reviewed: 1
- Official PDP reachable: 1
- Official description found: 1
- Official INCI found: 1
- Official product media reviewed: 1
- Official explicit how-to found: 0
- Remaining how-to requests: 1

## Finding

The official Baie Botanique cleanser PDP exposes product description and full INCI for `ext_60ded78effb04e9d6389bfce`. The page also includes a product image framed as a layering guide. That media gives regimen context for the cleanser, but it does not provide explicit product-specific usage directions such as apply, massage, rinse, or frequency.

Because the only remaining blocker is `missing_how_to`, there is no safe ingredients-only patch, and there is no source-backed basis to promote the row into serving.

## Still Blocked On How-To

| external_product_id | title | canonical_url | requested_source_fields |
| --- | --- | --- | --- |
| ext_60ded78effb04e9d6389bfce | Rose & Cupuacu Enzyme Cleanser | https://www.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser-sns | official product-specific directions / how-to |

## Operator Instructions

1. Do not promote the Baie Botanique cleanser from Wave57.
2. Do not run an official-html apply for this row; the missing field is how-to only, and the official source did not provide it.
3. Ask brand or partner source for explicit product directions before retrying the serving gate.
4. Keep this as `partner_how_to_request` in the source-acquisition lane.

## Artifacts

- `baie_botanique_howto_source_review.csv`
- `baie_botanique_remaining_how_to_requests.csv`
- `wave57_baie_botanique_howto_review_manifest.json`
