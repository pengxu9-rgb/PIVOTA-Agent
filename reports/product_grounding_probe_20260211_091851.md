# Product Grounding Probe

- generated_at_utc: 2026-02-11T09:18:51Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `2200`
- upstream_retries: `1`
- include_stable_hints: `false`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | false | true | stable_alias_ref | n/a | 1 | 2339 | 9886499864904 | merch_efbc46b4619cfbdf | 9886499864904 (The Ordinary Niacinamide 10% + Zinc 1%) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |
| Winona Soothing Repair Serum | false | true | stable_alias_ref | n/a | 1 | 2337 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |
| IPSA Time Reset Aqua | false | false | no_candidates | no_candidates | 0 | 2339 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| CeraVe Hydrating Cleanser | false | false | no_candidates | no_candidates | 0 | 2340 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |

## Summary

- total_queries: 4
- resolved_queries: 2
- resolve_rate: 0.500

Artifacts:
- `reports/product_grounding_probe_20260211_091851.md`
- `reports/product_grounding_probe_20260211_091851.csv`
