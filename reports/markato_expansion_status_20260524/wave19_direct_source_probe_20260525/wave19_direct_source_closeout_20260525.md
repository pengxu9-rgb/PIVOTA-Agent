# Wave19 Direct Source Closeout - 2026-05-25

## Outcome

- Direct-source official PDP scan: 9 scanned, 4 ready, 5 held.
- Production external seed apply: 4 scanned, 4 inserted, 0 invalid, 0 correction followups.
- Identity graph apply: 4 identity rows built/written, 0 review queue rows.
- Catalog sync: 4 product upserts, 5 SKU upserts, 5 offer upserts.
- Product intel publish: 4 reviewed bundles published; 3 `seller_plus_formula`, 1 `official_pdp_seed`.
- Final readiness after product intel: 4/4 `db_serving_ready`, 4/4 `public_index_ready`, 0 action-required rows.
- Fresh production backend invoke PDP audit: 4/4 ready, 0 thin, 0 not conversion ready.

Deployment used `git push origin HEAD:main` only. No `railway up` was used.

## Ready Products

| Product | External product id | Source INCI/material | How-to | Variant coverage |
| --- | --- | ---: | ---: | ---: |
| Aetās The Serum | `ext_684249c7a94a1a6f43fdbd77` | 28 INCI entries | 144 chars | 2 shade/undertone variants |
| DAEBY Daily Cleanser | `ext_e1c4eb330321ebc6e9672d73` | 30 INCI entries | 110 chars | single SKU |
| DAEBY Exfoliating Facial Scrub | `ext_81f5ddbf0c3ba5da04eabf9b` | 21 INCI entries | 98 chars | single SKU |
| Seresilk Pure Silk Exfoliator | `ext_4a50d003cfa7b0e4c7fc2f01` | INCI not applicable, silk material source | 376 chars | single SKU |

## Quality Notes

- Aetās serum `Skin Undertone` variants are accepted as displayable `Shade` axes; live PDP shows `β (Cool)` and `γ (Warm)` with no bad labels.
- DAEBY how-to was recovered from official CDN image evidence and stored as reviewed source-backed directions.
- Seresilk is handled as an accessory/tool, not a formula PDP; INCI is intentionally not applicable and no force-fill was used.
- Product intel is reviewed and public-ready for all 4 products; no seller-only fallback was published.
- Final live audit used the production backend invoke route: `https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke`.
- Earlier `/api/gateway` probes on the Railway backend returned `Cannot POST /api/gateway`; those artifacts are endpoint-path failures, not PDP content failures.
- Similar is deferred/empty on first paint for these products, but it is not a PDP servability blocker.

## Held Products

Held rows were not promoted because they failed source-backed readiness gates:

- Aetās The Cleanser 200mL, The Lotion 200mL, and The Moisturizer 50mL: official US/USD pages found but out of stock, so held.
- DAEBY Bathroom Basics Set and Skincare Essentials Set: set/collection rows with missing official how-to, so held.

## Artifacts

- Source audit: `official_source_probe_audit.json`
- DB apply: `prod_db_apply.json`
- Identity graph apply: `identity_graph_apply.json`
- Catalog sync: `catalog_sync_apply.json`
- Product intel report: `official_seed_product_intel_report_4.json`
- Product intel publish: `product_intel_publish_apply.json`
- Final readiness: `readiness_after_product_intel/summary.json`
- Final live PDP audit: `live_pdp_modules_audit_after_deploy_invoke.json`

## Next Expansion Direction

Continue expanding official-source rows where the page has US/USD sellability, full source-backed INCI or reviewed non-formula material handling, and explicit how-to. Good next targets are single-SKU skincare/haircare/body-care formulas from the remaining Markato merchant pool; defer sets, out-of-stock rows, and formula PDPs with missing INCI or missing how-to.
