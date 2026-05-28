# Wave33 JouJou + MASAMI Serving Sync Closeout - 2026-05-27

## Scope

Expanded Markato US PDP catalog serving coverage for 3 non-Joocyee, reviewed/high-quality product-intel SKUs:

| external_product_id | Brand | Product | Domain |
| --- | --- | --- | --- |
| `ext_83ec9657a96effaf0923f850` | JouJou | APHRODITE Body Oil | `joujoubotanicals.com` |
| `ext_de5c3d5849b1256eca4a7566` | JouJou | FLORAL FILTER Face Mask | `joujoubotanicals.com` |
| `ext_53cf4f0ee46873d280f632db` | MASAMI | Mekabu Hydrating Shine Serum | `lovemasami.com` |

Candidate file:

- `wave33_joujou_masami_serving_sync_candidate_ids.txt`

## Pre-Apply Gates

Readiness before sync:

- scanned rows: 3
- terminal holds: 0
- action required: 3
- DB serving ready: 0/3
- public index ready: 0/3
- blocker breakdown: `index_doc_shadow_only=3`
- direct displayable KB: 3/3
- direct high-quality product intel: 3/3
- identity ready: 3/3
- source build failures: 0
- warnings: 0

Serving-sync dry-run:

- requested ids: 3
- fetched rows: 3
- mirror rows: 3
- planned SKU rows: 3
- planned offer rows: 3
- planned index state rows: 3
- missing ids: 0
- skipped: 0
- `servingEligible=true`: 3/3

Classification check:

- JouJou APHRODITE Body Oil -> `Body Oil`, `beauty/body/body-oil`
- JouJou FLORAL FILTER Face Mask -> `Face Mask`, `beauty/skincare/mask`
- MASAMI Mekabu Hydrating Shine Serum -> `Hair Serum`, `beauty/haircare/hair-serum`

Stale delete preview was limited to one MASAMI legacy canonical SKU/offer:

- stale SKU deletes planned: 1
- stale offer deletes planned: 1

## Production Apply

Production DB write was executed only after the clean dry-run gate:

- product upserts: 3
- SKU upserts: 3
- offer upserts: 3
- product group member upserts: 3
- index state upserts: 3
- catalog row trust upserts: 3
- stale SKU deletes: 1
- stale offer deletes: 1
- missing ids: 0
- skipped: 0

No `railway up` was used.

## Post-Apply Validation

Readiness after sync:

- scanned rows: 3
- terminal holds: 0
- action required: 0
- DB serving ready: 3/3
- public index ready: 3/3
- public dry-run docs: 3
- rows with public doc and insight summary: 3
- direct displayable KB: 3/3
- direct high-quality product intel: 3/3
- identity ready: 3/3
- source build failures: 0
- warnings: 0

Live PDP module audit:

- scanned: 3
- ready: 3
- thin: 0
- not conversion ready: 0
- weak insights ids: 0
- seller-only insights ids: 0
- force-filled ids: 0
- content gap ids: 0

Domain breakdown:

- `joujoubotanicals.com`: 2
- `lovemasami.com`: 1

## Latest Markato Rollup After Wave33

- production rows: 597
- catalog attached: 597/597 (100%)
- DB/index serving eligible: 78/597 (13.1%)
- ready or covered: 70
- identity ready: 304/597 (50.9%)
- high-quality product intel: 364/597 (61.0%)
- recommended next batch rows: 33
- source gap rows: 136
- risk hold rows: 358

Lane counts:

- `ready_or_covered`: 70
- `serving_index_sync`: 20
- `identity_refresh`: 13
- `hold_source_gap`: 136
- `hold_risk_review`: 358

Delta versus prior rollup:

- DB/index serving eligible: 75 -> 78
- ready or covered: 67 -> 70
- serving index sync backlog: 23 -> 20
- recommended next batch rows: 36 -> 33

## Artifacts

- `wave33_joujou_masami_serving_sync_dry_run.json`
- `wave33_joujou_masami_serving_sync_apply.json`
- `readiness_before_serving_sync/`
- `readiness_after_serving_sync/`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_wave33/`

## Next Expansion Notes

The rollup still ranks Joocyee highest by raw `serving_index_sync` count, but Joocyee has known duplicate canonical identity risk from earlier exact dry-runs. Safer next small-batch choices from the latest rollup are:

- RMS Beauty: `ext_9247e1285fadd4b02bc33aad` Makeup Remover Wipe
- Rohr Remedy: `ext_1b95875bc9bdeee751d0cee1` Lilly Pilly Face Moisturiser with Omega-3
- Seresilk: `ext_0d4ffd13b899460cabb1f392` Gentle Silk Cleanser

If we return to Joocyee, run a stricter identity-duplicate review before any serving apply.
