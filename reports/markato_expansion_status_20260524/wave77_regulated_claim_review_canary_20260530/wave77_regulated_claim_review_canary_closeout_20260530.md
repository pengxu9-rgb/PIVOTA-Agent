# Wave77 Regulated-Claim Review Canary Closeout

Date: 2026-05-30
Market: US
Scope: no-write production review of regulated-claim-held rows that otherwise looked index/identity/product-intel ready.

## Reviewer Decision

Do not promote or count this canary as fully approved yet.

The four DB-ready rows passed the live PDP content surface checks, but all four failed the stricter PDP quality gate on `similar_underfill`. The practical blocker is therefore not source content, identity, product intel, media, variants, or pricing; it is the recommendation/similar-products rail.

No production data writes or serving promotions were performed.

## Rows Reviewed

Initial readiness scan covered six rows:

| External product ID | Product | Readiness outcome | Reviewer action |
| --- | --- | --- | --- |
| `ext_c840771410198f627d75673a` | COCONUT MATTER TINTED COCONUT LIP BALM | DB-ready / ready_no_action | Strict PDP reviewed; hold on `similar_underfill` |
| `ext_8982e4384c3bd70a5718c899` | COCONUT MATTER CLEAR LIP CARE | DB-ready / ready_no_action | Strict PDP reviewed; hold on `similar_underfill` |
| `ext_b344f028268229b02a16d0cb` | Delicate Daisys Cooling After Sun Body Oil Aloe Vera | DB-ready / ready_no_action | Strict PDP reviewed; hold on `similar_underfill` |
| `ext_55b774d3c57906a77a7167f0` | 786 Cosmetics Sorrento - Breathable Nail Polish | DB-ready / ready_no_action | Strict PDP reviewed; hold on `similar_underfill` |
| `ext_87a0af88b9bd23b8f2123d1b` | 786 Cosmetics Almond & Ginseng Cuticle Oil | `seed_content_blocked`, `missing:category` | Not strict-reviewed; needs seed commerce category correction first |
| `ext_e86ee213b542fbb671e0804e` | 786 Cosmetics Soy Nail Polish Remover With Almond Essential Oil | `seed_content_blocked`, `missing:category` | Not strict-reviewed; needs seed commerce category correction first |

Readiness summary:

- Scanned rows: 6
- DB-serving-ready rows: 4
- Public-index-ready rows: 4
- Action-required rows: 2
- Blockers: `db_serving_ready=4`, `seed_content_blocked=2`
- Action lane: `ready_no_action=4`, `lane_2_seed_commerce_facts=2`
- Direct high-quality KB: 6
- Identity-ready: 6
- Public docs: 6

## Live PDP Module Gate

The four DB-ready rows were audited with `audit-external-seed-live-pdp-modules.cjs`.

Result:

- Scanned: 4
- Ready: 4
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

By domain:

- `coconutmatter.com`: 2
- `786cosmetics.com`: 1
- `delicatedaisys.com`: 1

Artifact:

- `db_ready_live_pdp_modules.json`

## Strict PDP Quality Gate

All four DB-ready rows were rerun through `audit-external-product-pdp-quality.js` with `--include-attached`.

Strict gate outcome:

| External product ID | Seed | Extractor | Identity | Product intel | Live PDP | Variant | Similar | Similar count | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| `ext_c840771410198f627d75673a` | passed | passed | passed | passed | passed | passed | failed | 3 | failed |
| `ext_8982e4384c3bd70a5718c899` | passed | passed | passed | passed | passed | passed | failed | 2 | failed |
| `ext_b344f028268229b02a16d0cb` | passed | passed | passed | passed | passed | passed | failed | 0 | failed |
| `ext_55b774d3c57906a77a7167f0` | passed | passed | passed | passed | passed | passed | failed | 3 | failed |

Failure reason for every row:

- `similar_underfill`

Artifacts:

- `strict_pdp_quality_ext_c840771410198f627d75673a.json`
- `strict_pdp_quality_ext_8982e4384c3bd70a5718c899.json`
- `strict_pdp_quality_ext_b344f028268229b02a16d0cb.json`
- `strict_pdp_quality_ext_55b774d3c57906a77a7167f0.json`

## Interpretation

The broad rollup `regulated_claim_review` flag is useful as a conservative human-review bucket, but this canary shows that the live PDP blocker for these otherwise strong rows is downstream similar-product coverage.

The correct next move is not to force these rows through a risk override. Either:

1. improve similar-product coverage for the affected product families, then rerun strict PDP quality, or
2. explicitly redefine the strict gate if underfilled similar rails should not block already public-index-ready rows.

Until one of those decisions is made, these four rows should remain review-held for rollup purposes despite having ready PDP modules.

## Next Actionable Work

1. Fix the two 786 Cosmetics seed commerce facts rows by applying source-backed category values, then rerun readiness:
   - `ext_87a0af88b9bd23b8f2123d1b`
   - `ext_e86ee213b542fbb671e0804e`
2. Open a focused similar-underfill lane for the four DB-ready rows:
   - inspect whether category taxonomy, embedding/index coverage, or retrieval thresholds are suppressing similar candidates.
3. After similar coverage is repaired, rerun:
   - live PDP module audit
   - strict PDP quality audit
   - scoped rollup

