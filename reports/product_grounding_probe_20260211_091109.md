# Product Grounding Probe

- generated_at_utc: 2026-02-11T09:11:09Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `4500`
- upstream_retries: `1`
- include_stable_hints: `true`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | true | true | hint_product_ref | n/a | 1 | 2 | 9886499864904 | merch_efbc46b4619cfbdf | 9886499864904 (The Ordinary Niacinamide 10% + Zinc 1%) | hints_product_ref:ok |
| Winona Soothing Repair Serum | true | true | hint_product_ref | n/a | 1 | 1 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | hints_product_ref:ok |
| IPSA Time Reset Aqua | false | false | no_candidates | no_candidates | 0 | 4647 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| CeraVe Hydrating Cleanser | false | false | no_candidates | no_candidates | 0 | 4395 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |

## Summary

- total_queries: 4
- resolved_queries: 2
- resolve_rate: 0.500

Artifacts:
- `reports/product_grounding_probe_20260211_091109.md`
- `reports/product_grounding_probe_20260211_091109.csv`
