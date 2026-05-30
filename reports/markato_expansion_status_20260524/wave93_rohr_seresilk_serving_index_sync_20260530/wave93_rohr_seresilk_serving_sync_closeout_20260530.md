# Wave93 Rohr Remedy/Seresilk Serving Sync Closeout

Generated: 2026-05-30

## Scope

Reviewed and promoted two `serving_index_sync` candidates from the wave92 rollup:

- `ext_1b95875bc9bdeee751d0cee1` - Lilly Pilly Face Moisturiser with Omega-3
- `ext_0d4ffd13b899460cabb1f392` - Gentle Silk Cleanser

## Dry Run

Artifact:

- `rohr_seresilk_serving_sync_dry_run.json`

Result:

- requested IDs: 2
- fetched rows: 2
- mirror rows: 2
- planned SKU rows: 2
- planned offer rows: 2
- planned index-state rows: 2
- missing IDs: 0
- skipped rows: 0
- stale deletes planned: 0
- serving sample blocker: `none` for both rows

## Preflight Audit

Artifacts:

- `rohr_lilly_pilly_pdp_quality_preflight.json`
- `seresilk_gentle_silk_cleanser_pdp_quality_preflight.json`

Results:

| external product ID | product | seed | extractor | identity | product_intel | live PDP | similar | variant | similar count | broken images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ext_1b95875bc9bdeee751d0cee1` | Lilly Pilly Face Moisturiser with Omega-3 | passed | passed | passed | passed | passed | passed | passed | 6 | 0 |
| `ext_0d4ffd13b899460cabb1f392` | Gentle Silk Cleanser | passed | passed | passed | passed | passed | passed | passed | 6 | 0 |

## Apply

Artifact:

- `rohr_seresilk_serving_sync_apply.json`

Production apply result:

- product upserts: 2
- SKU upserts: 2
- offer upserts: 2
- group-member upserts: 2
- index-state upserts: 2
- catalog-row-trust upserts: 2
- stale SKU deletes: 0
- stale offer deletes: 0
- final blocker: `none` for both rows
- final serving eligible: true for both rows

## Post-Sync Audit

Artifacts:

- `rohr_lilly_pilly_pdp_quality_after_serving_sync.json`
- `seresilk_gentle_silk_cleanser_pdp_quality_after_serving_sync.json`

Results:

| external product ID | product | status | live PDP | similar | variant | similar count | failure reasons | broken images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ext_1b95875bc9bdeee751d0cee1` | Lilly Pilly Face Moisturiser with Omega-3 | passed | passed | passed | passed | 6 | none | 0 |
| `ext_0d4ffd13b899460cabb1f392` | Gentle Silk Cleanser | passed | passed | passed | passed | 6 | none | 0 |

## Commerce Reviewer Note

The PDP/content gates passed for both rows. Seresilk also carried medium-confidence USD commerce facts with `market_switch_status=ok`.

Rohr Remedy passed the live PDP and offer module gates at USD 30, but the serving artifact still marks `agent_safe_commerce_facts.price.status=unverified` because the prior source capture had low market-confidence and `market_switch_status=unknown`. This was not treated as a content evidence blocker under the current serving gate, but it should be revisited if the expansion gate is tightened to require verified market pricing for every external referral offer.

## Rollup After Wave93

Artifact directory:

- `current_rollup_after_wave93/`

Current rollup:

- production rows: 613
- catalog attached: 613/613
- index serving eligible: 262/613
- identity ready: 392/613
- product-intel high quality: 547/613
- ready_or_covered: 122
- hold_source_gap: 99
- hold_risk_review: 385
- serving_index_sync: 7

Recommended next batch:

- UpCircle Beauty `ext_664b859ce2599a57c3f1f7ce` - Body Oil with Passion Fruit Oil
- UpCircle Beauty `ext_23ae4c5d9d8f2a8be363f2cc` - Body Scrub with Coffee + Lemongrass
- UpCircle Beauty `ext_6815bee1060ef71d9a99ce5b` - Cleansing Face Milk with Oat Powder + Aloe Vera
- UpCircle Beauty `ext_96484ace25be03a8f8cb595d` - RETURN + REFILL Night Cream with Hyaluronic Acid + Niacinamide - ON PAUSE
- UpCircle Beauty `ext_714399863bd72a30bcc6259c` - RETURN + REFILL Organic Face Oil with Coffee Extract - ON PAUSE
- UpCircle Beauty `ext_c384be41af865ac0aecd06ed` - RETURN + REFILL Shampoo Creme with Pink Berry - ON PAUSE
- Oio Lab `ext_3a23e2090b4ac8dfcf1301fc` - Aquasphere

## Outcome

Wave93 added two live serving-eligible rows after clean exact-ID dry run, live preflight, production serving sync, and post-sync PDP validation. The next real move is the reduced 7-row `serving_index_sync` queue, starting with the UpCircle rows.
