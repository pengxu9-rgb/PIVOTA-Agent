# Wave6 Production DB Dry Run Closeout - 2026-05-24

## Scope

This closeout covers the post-deploy production-environment DB dry-run, approved 7-row production apply, and postcheck dry-run for the consolidated Wave6 Tier A Markato US candidate set.

Production DB write was executed only for the 7 main-agent gated apply candidates after explicit approval. No `railway up` was used.

## Inputs

- Tier A prod DB dry-run manifest: `reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run_candidate_manifest.json`
- Tier A prod DB dry-run output: `reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run.json`
- Main-agent apply gate script: `reports/markato_expansion_status_20260524/build_wave6_prod_apply_gate_manifest.cjs`
- Apply-candidate manifest: `reports/markato_expansion_status_20260524/wave6_prod_apply_candidate_manifest.json`
- Hold review: `reports/markato_expansion_status_20260524/wave6_prod_apply_hold_review.json`
- Apply-candidate prod DB dry-run output: `reports/markato_expansion_status_20260524/wave6_prod_apply_candidate_dry_run.json`
- Apply output: `reports/markato_expansion_status_20260524/wave6_prod_apply_candidate_apply.json`
- Postcheck dry-run output: `reports/markato_expansion_status_20260524/wave6_prod_apply_candidate_postcheck_dry_run.json`

## Production DB Dry Run

Production environment DB connectivity was available through Railway production env.

Tier A dry-run result:

- scanned: 20
- database_available: true
- would_insert: 20
- would_insert_unverified: 0
- skipped_existing: 0
- invalid: 0
- requires_seed_correction_count: 0
- correction_followups: 0

This confirms the full 20-row Tier A manifest is structurally acceptable to the seed creation pipeline, but it does not make all 20 safe to apply.

## Main-Agent Apply Gate

The 20 Tier A rows were split after an additional sanity gate:

- apply candidates: 7
- hold review: 13

Hold reasons:

- `price_sanity_hold_usd_amount_ge_250`: 12
- `non_english_source_copy_needs_us_review`: 1

The price sanity gate intentionally holds rows whose observed USD amount is likely a minor-unit or non-normalized currency artifact.

## Apply Candidates

The following 7 rows passed the main-agent production apply gate and a second production DB dry-run:

| Brand | Title | External Product ID | Price |
| --- | --- | --- | --- |
| Seresilk | Silk Night Cream | `ext_df8aac07d6c970d4c213b43f` | USD 79.97 |
| Seresilk | Silk Night Serum | `ext_438058253d57a2c8d75f5906` | USD 78.41 |
| Seresilk | Gentle Silk Cleanser | `ext_0d4ffd13b899460cabb1f392` | USD 28.22 |
| Lucamar Skin Care | Lucamar Baalm 50g UNSCENTED | `ext_065337312a937f0f26d50865` | USD 32 |
| Lucamar Skin Care | Lucamar Baalm 50g | `ext_05c5a41a67fb37dcf352853e` | USD 32 |
| Rohr Remedy | Kakadu Plum Super Serum with Vit C | `ext_c463dcd674e1138b1284ff37` | USD 38 |
| Rohr Remedy | Lilly Pilly Face Moisturiser with Omega-3 | `ext_1b95875bc9bdeee751d0cee1` | USD 25 |

Second dry-run result for the 7 apply candidates:

- scanned: 7
- database_available: true
- would_insert: 7
- would_insert_unverified: 0
- skipped_existing: 0
- invalid: 0
- requires_seed_correction_count: 0
- correction_followups: 0

Commerce facts gate status was `pass` on all 7. Availability was `in_stock` on all 7. Sellable region and shipping remain `unknown`, which is accepted for this seed creation stage but should not be treated as checkout verification.

No ingredient writeback was performed.

## Production Apply

The approved production apply was executed against `wave6_prod_apply_candidate_manifest.json`.

Apply result:

- scanned: 7
- database_available: true
- inserted: 7
- skipped_existing: 0
- would_insert: 0
- would_insert_unverified: 0
- invalid: 0
- requires_seed_correction_count: 0
- correction_followups: 0

Inserted seed rows:

| Seed ID | External Product ID | Status |
| --- | --- | --- |
| `eps_44c1397b319a538f47b4ca1d` | `ext_df8aac07d6c970d4c213b43f` | inserted |
| `eps_68187b19d2f43540ff7e1b59` | `ext_438058253d57a2c8d75f5906` | inserted |
| `eps_5ae568728c95aa19d64a9413` | `ext_0d4ffd13b899460cabb1f392` | inserted |
| `eps_0d072fad09b3413bc8b13c49` | `ext_065337312a937f0f26d50865` | inserted |
| `eps_499592237ce0da6e864a8846` | `ext_05c5a41a67fb37dcf352853e` | inserted |
| `eps_5b49f8c120d2920838ae83d6` | `ext_c463dcd674e1138b1284ff37` | inserted |
| `eps_5ee0b414653347fb5af51740` | `ext_1b95875bc9bdeee751d0cee1` | inserted |

## Postcheck

The post-apply production dry-run was executed against the same manifest.

Postcheck result:

- scanned: 7
- database_available: true
- inserted: 0
- skipped_existing: 7
- would_insert: 0
- would_insert_unverified: 0
- invalid: 0
- requires_seed_correction_count: 0
- correction_followups: 0

This confirms the 7 approved rows now exist in production DB and are no longer reported as new insert candidates.

## Holds

Hold review rows:

| Brand | Title | External Product ID | Reason |
| --- | --- | --- | --- |
| Aetas | The Serum | `ext_38b10ae142ef283bdc0acca8` | `non_english_source_copy_needs_us_review` |
| AFRAKARI | Radiance Elixir | `ext_63426418919f510613d11dfc` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Prickly Pear Elixir | `ext_212d963582191d90a381b919` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Recovery Serum | `ext_92fd955718af4577fe7a921f` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Kalahari Melon Seed Oil | `ext_4d2036846dfde9236a2e5db9` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Pure Marula Oil | `ext_d72da473fbf1b8456b2e9ab8` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Renewal Facial Oil | `ext_3d1d0b42b8eca59a501ff39e` | `price_sanity_hold_usd_amount_ge_250` |
| AFRAKARI | Cape Kelp Hydrating Cleanser | `ext_81b379a35a0ad778e3650f0e` | `price_sanity_hold_usd_amount_ge_250` |
| 7Journeys | 7 Journeys Extra Soft Glow Renewal Moisturizer 50g - Hydrating & Firming | `ext_c3feb615476441d19d3d7cad` | `price_sanity_hold_usd_amount_ge_250` |
| 7Journeys | 7 Journeys Miracle Timeless Eye Cream 30g (Hydrating & Glowing) | `ext_0d1e0a286ec9983daa6588e9` | `price_sanity_hold_usd_amount_ge_250` |
| 7Journeys | 7 Journeys Antarctic Timeless Serum 45ml (Hydration & Anti-aging) | `ext_ab73ef0b2176992ac7edae2e` | `price_sanity_hold_usd_amount_ge_250` |
| 7Journeys | 7 Journeys Glow Renewal Serum 45ml (Hydrated & Glowing Skin) | `ext_ebe749514b521fc5985e2347` | `price_sanity_hold_usd_amount_ge_250` |
| 7Journeys | 7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets) | `ext_824c5edce946bb360f763cac` | `price_sanity_hold_usd_amount_ge_250` |

## Next

Keep the 13 hold rows out of apply until their hold reasons are resolved:

- Aetas needs US copy review because source copy is non-English.
- AFRAKARI and 7Journeys need price normalization review before seed creation.

Deployment remains git-driven only; do not use `railway up`.
