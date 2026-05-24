# Wave6 Markato Batch 4 Summary

Generated: 2026-05-24T05:07:31.320Z

Read-only guardrails observed: no `railway up`, no git push, no DB apply/production writes. Dry-runs were executed with `DATABASE_URL` unset.

## Counts

- Brands: 7
- Extracted products: 141
- Manifest rows: 97
- Review passed brands: 5
- Review blocked brands: 2
- Curated candidates: 14
- Held rows: 83
- DB-ready candidate rows after no-DB dry-run: 14
- Dry-run invalid rows: 0

## Brand Rollup

| Brand | Manifest Rows | Review | Curated | DB-Ready | Held | Review Blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Lucamar Skin Care | 11 | pass | 7 | 7 | 4 | - |
| abyssian | 25 | blocked | 0 | 0 | 25 | anti_abuse_signal:perimeterx |
| 7Journeys | 5 | pass | 5 | 5 | 0 | - |
| Pairfum | 0 | blocked | 0 | 0 | 0 | zero_accepted_items_from_extractor; anti_abuse_signal:cloudflare |
| Rohr Remedy | 13 | pass | 2 | 2 | 11 | - |
| Gun Ana | 18 | pass | 0 | 0 | 18 | - |
| HIRO | 25 | pass | 0 | 0 | 25 | - |

## DB-Ready Candidate Rows

| Brand | Title | Price | Dry Run | External Product ID |
| --- | --- | --- | --- | --- |
| Lucamar Skin Care | Lucamar Baalm 50g  UNSCENTED | 14 USD | would_insert_unverified | ext_065337312a937f0f26d50865 |
| Lucamar Skin Care | Baa Ram Ewe  Lanolin Skin Balm  120g UNSCENTED | 17 USD | would_insert_unverified | ext_c26547ca63d530592ed62d63 |
| Lucamar Skin Care | Musk: My Lips Are Sealed Lip Balm 10gms | 8 USD | would_insert_unverified | ext_74a7dddbe9cfad5b36ea4bc1 |
| Lucamar Skin Care | Baa Ram Ewe  Lanolin Skin Balm  120g | 17 USD | would_insert_unverified | ext_0836525e72365da8ecbcc3b5 |
| Lucamar Skin Care | Vanilla:   My Lips Are Sealed Natural Lip Balm 10gms | 8 USD | would_insert_unverified | ext_cfdd4c8d3521fe733d0fc75d |
| Lucamar Skin Care | Lucamar Baalm 50g | 14 USD | would_insert_unverified | ext_05c5a41a67fb37dcf352853e |
| Lucamar Skin Care | Baa Ram Ewe Lanolin Skin Balm 50g | 12 USD | would_insert_unverified | ext_edcf7e510314384ac432b385 |
| 7Journeys | 7 Journeys Extra Soft Glow Renewal Moisturizer 50g - Hydrating & Firming | 480 USD | would_insert_unverified | ext_c3feb615476441d19d3d7cad |
| 7Journeys | 7 Journeys Miracle Timeless Eye Cream 30g (Hydrating & Glowing) | 540 USD | would_insert_unverified | ext_0d1e0a286ec9983daa6588e9 |
| 7Journeys | 7 Journeys Antarctic Timeless Serum 45ml (Hydration & Anti-aging) | 540 USD | would_insert_unverified | ext_ab73ef0b2176992ac7edae2e |
| 7Journeys | 7 Journeys Glow Renewal Serum 45ml (Hydrated & Glowing Skin) | 660 USD | would_insert_unverified | ext_ebe749514b521fc5985e2347 |
| 7Journeys | 7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets) | 550 USD | would_insert_unverified | ext_824c5edce946bb360f763cac |
| Rohr Remedy | Kakadu Plum Super Serum with Vit C | 44 USD | would_insert_unverified | ext_c463dcd674e1138b1284ff37 |
| Rohr Remedy | Lilly Pilly Face Moisturiser with Omega-3 | 30 USD | would_insert_unverified | ext_1b95875bc9bdeee751d0cee1 |

## Blockers And Holds

- abyssian: review_gate_blocker; anti_abuse_signal:perimeterx. Next: Do not apply from this extraction; rerun/review only after the anti-abuse signal is cleared or operator explicitly approves the source path.
- Pairfum: review_gate_blocker; zero_accepted_items_from_extractor, anti_abuse_signal:cloudflare. Next: Recover a non-blocked official PDP/catalog source or build a reviewed manual manifest before any seed dry-run.
- Gun Ana: market_currency_blocker; EUR observed for US market, commerce_facts_gate_hold. Next: Find a verified US/USD market URL or route this brand to the correct non-US market before seed creation.
- HIRO: regulated_claims_lane_blocker; wellness_supplement_claims, bundles/accessories present. Next: Route to the regulated claims lane; create no US seeds unless specific supplement rows are explicitly approved.
- Lucamar Skin Care held 4 duplicate-copy or therapeutic-claim rows.
- Rohr Remedy held 11 accessory, bundle, out-of-stock, unboxed, or therapeutic/antimicrobial-claim rows.

## Exact Next Steps

- Keep this batch read-only until an operator approves a DB apply lane.
- Before any apply, run the same curated manifests with a DB-backed dry-run/postcheck to detect existing rows and duplicate canonical URLs.
- Do not continue abyssian until the PerimeterX anti-abuse review blocker is cleared or explicitly accepted by an operator.
- Do not continue Pairfum from this extractor output; recover an official non-blocked source or reviewed manual PDP list first.
- Do not create Gun Ana US seeds from this output; verify a US/USD market URL or move it to the correct market lane.
- Route HIRO rows to the regulated wellness/supplement claims lane before any seed creation.
- Keep Rohr/Lucamar held rows out of apply until accessory, duplicate, out-of-stock, unboxed, and therapeutic/antimicrobial-claim issues are resolved.

## Key Artifacts

- Batch summary JSON: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/batch_summary.json
- DB-ready candidate manifest: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/db_ready_candidate_manifest.json
- Curation summary: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/curation_summary.json
- Curation decisions CSV: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/curation_decisions.csv
- Dry-runs: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/dry_runs
- Manifests: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/manifests
- Reviews: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_4/reviews
