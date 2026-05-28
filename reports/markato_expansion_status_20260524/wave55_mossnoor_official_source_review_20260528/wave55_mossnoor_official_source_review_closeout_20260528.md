# Markato Wave55 Moss & Noor Official Source Review - 2026-05-28

## Reviewer Decision

Wave55 reviewed the five Moss & Noor P0 source-acquisition rows from Wave51 against current official Moss & Noor PDPs.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Official PDP rows reviewed: 5
- Official INCI found: 5
- Official how-to found: 0
- Ingredients-only dry-run candidates: 4
- Remaining how-to requests: 5

## Finding

The official Moss & Noor shower gel PDPs expose title, description, scent, size, and full INCI. They do not expose explicit product-use directions. That means four rows can move to an ingredients-only production dry-run, but none should be promoted or marked ready from Wave55.

## Ingredients-Only Candidates

| external_product_id | title | canonical_url | patch_scope |
| --- | --- | --- | --- |
| ext_83b8555768814cac5243aef1 | After Workout Shower Gel - Crispy Cucumber 500 ml | https://mossnoor.com/products/after-workout-shower-gel-crispy-cucumber | pdp_ingredients_raw_only |
| ext_67472974111568c15ac3920d | After Workout Shower Gel - Fresh Grapefruit | https://mossnoor.com/products/shower-gel | pdp_ingredients_raw_only |
| ext_cf945cc7bfe99bf9864bd6df | After Workout Shower Gel - Fresh Grapefruit 500 ml | https://mossnoor.com/products/after-workout-shower-gel-fresh-grapefruit-500-ml | pdp_ingredients_raw_only |
| ext_876342422f9629ea9363953c | After Workout Shower Gel - Light Mint | https://mossnoor.com/products/after-workout-shower-gel-light-mint | pdp_ingredients_raw_only |

## Still Blocked On How-To

| external_product_id | title | canonical_url | requested_source_fields |
| --- | --- | --- | --- |
| ext_a7ab937f43db2868c6f9e383 | After Workout Shower Gel - Clean Eucalyptus | https://mossnoor.com/products/after-workout-shower-gel-clean-eucalyptus | official product-specific directions / how-to |
| ext_83b8555768814cac5243aef1 | After Workout Shower Gel - Crispy Cucumber 500 ml | https://mossnoor.com/products/after-workout-shower-gel-crispy-cucumber | official product-specific directions / how-to |
| ext_67472974111568c15ac3920d | After Workout Shower Gel - Fresh Grapefruit | https://mossnoor.com/products/shower-gel | official product-specific directions / how-to |
| ext_cf945cc7bfe99bf9864bd6df | After Workout Shower Gel - Fresh Grapefruit 500 ml | https://mossnoor.com/products/after-workout-shower-gel-fresh-grapefruit-500-ml | official product-specific directions / how-to |
| ext_876342422f9629ea9363953c | After Workout Shower Gel - Light Mint | https://mossnoor.com/products/after-workout-shower-gel-light-mint | official product-specific directions / how-to |

## Operator Instructions

1. If production DB access is available, run an official-html dry-run for the four `pdp_ingredients_raw_only` rows before any apply.
2. Do not promote any Moss & Noor row from this wave; product-specific how-to remains missing for all five.
3. Ask brand/partner source for explicit shower-gel directions if the serving gate continues to require how-to.
4. Treat the Clean Eucalyptus row as source-confirmed but not an ingredients patch candidate because its current blocker is only `missing_how_to`.

## Artifacts

- `mossnoor_official_pdp_source_review.csv`
- `mossnoor_ingredients_only_patch_candidates.csv`
- `mossnoor_remaining_how_to_requests.csv`
- `wave55_mossnoor_official_source_review_manifest.json`
