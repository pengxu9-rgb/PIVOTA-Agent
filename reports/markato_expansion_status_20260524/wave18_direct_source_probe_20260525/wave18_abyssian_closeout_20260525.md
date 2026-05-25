# Wave18 Abyssian Closeout - 2026-05-25

## Outcome

- Direct-source scope: 5 brands probed; Abyssian was the only promoted source in this pass.
- Abyssian official PDP scan: 17 scanned, 6 ready, 11 held.
- Production external seed apply: 6 scanned, 6 inserted, 0 invalid, 0 correction followups.
- Identity graph apply: 6 identity rows built/written, 0 review queue rows.
- Catalog sync/resync: 6 product upserts, 11 SKU upserts, 11 offer upserts.
- Product intel publish: 6 reviewed `seller_plus_formula` bundles published.
- Final readiness after product intel: 6/6 `db_serving_ready`, 6/6 `public_index_ready`, 0 action-required rows.
- Fresh production gateway PDP probe: 6/6 core PDP ready, 0 core failures.

No `railway up` was used. Production writes and audits used production DB env via `railway run` where available; the final live PDP check used direct production gateway probes because the current worktree was not Railway-linked to PIVOTA-Agent after session compaction.

## Ready Products

| Product | External product id | INCI count | How-to | Variant coverage |
| --- | --- | ---: | ---: | ---: |
| Daily Shield Superfood Conditioner | `ext_3916e5e378df1e75041a1b68` | 39 | 194 chars | 3 source variants, 2 live variants |
| Dream Bonds Bio Emulsion | `ext_3508560cf76c6d564d97f6d0` | 27 | 382 chars | 2 |
| Nano Repair Shampoo | `ext_6cb55d2964fca74dbcade8e7` | 34 | 202 chars | 2 |
| Protein Shake Hair Mask | `ext_d8737399fc72ef06c147bd0c` | 30 | 131 chars | 2 |
| Solar Glow Dry Shampoo | `ext_443039d2322b0af440c1ce9a` | 13 | 163 chars | 1 |
| Youth Bloom Hair Mist | `ext_ac6c6e795d7f3efe5cc22f7c` | 30 | 335 chars | 2 |

## Quality Notes

- Live PDP direct gateway probe returned `status=success` for all 6 products.
- Core modules were present for all 6: canonical, media, variant selector, offers, product intel, overview/details, INCI, and how-to.
- Pivota Insights were reviewed and source-bound for all 6; no seller-only fallback was used.
- Public text pollution check found no internal/provenance leakage in overview/details/card surfaces.
- Youth Bloom Hair Mist live variants preserve the reviewed multi-size prices: 75 mL at `$10`, 225 mL at `$31`.
- Product facts and active ingredients are optional warnings for these formula PDPs; full INCI and how-to are present.
- Similar is the only remaining weakness: first-paint similar is deferred for 6/6, and direct similar underfilled for 5/6. This is recommendation coverage, not PDP servability.

## Held Products

Held rows were not promoted into production because they did not pass source-backed quality gates:

- Regulatory claim terms requiring manual review: 6.
- Unavailable or missing product JSON: 4.
- 404/non-official PDP and missing source data: 2.
- Official how-to conflicts with product type: 1.

Notable holds:

- Deep Hydration Shampoo/Conditioner, Hello Volume Shampoo/Conditioner, Sunday Detox Exfoliating Shampoo, and Supergloss Hair Serum: claim terms require manual review before use.
- Nano Repair Conditioner: official how-to conflicts with conditioner product type.
- 360 Molecular Repair and Superfood Recovery Shampoo: unavailable/missing product JSON.
- Nourishing Hair Serum and Nano Repair Hair Mask source URLs resolved as 404.

## Artifacts

- Source audit: `official_source_probe_audit.json`
- DB apply: `prod_db_apply.json`
- Identity graph apply: `identity_graph_apply.json`
- Catalog resync after variant price fix: `catalog_resync_after_variant_price_fix_apply.json`
- Product intel report: `official_seed_product_intel_report_6.json`
- Final readiness: `readiness_after_product_intel/summary.json`
- Fresh live gateway probe: `live_pdp_direct_gateway_probe.json`

## Next Expansion Direction

The next coverage wave should add more source-backed US/USD haircare around the underfilled recommendation categories:

- hair masks and bond treatments
- hair mists and leave-in sprays
- dry shampoos
- conditioners

Keep the same gates: official US/USD PDP, source-backed full INCI, source-backed how-to, clean public copy, reviewed product intel, and no seller-only fallback.
