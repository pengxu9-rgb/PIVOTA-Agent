# Product Grounding Probe

- generated_at_utc: 2026-02-13T03:37:48Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `2200`
- upstream_retries: `1`
- include_stable_hints: `true`
- curl_retry_max: `6`
- curl_retry_delay_sec: `1`
- curl_connect_timeout_sec: `5`
- curl_max_time_sec: `45`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | true | true | hint_product_ref | n/a | 1 | 1 | 9886499864904 | merch_efbc46b4619cfbdf | 9886499864904 (The Ordinary Niacinamide 10% + Zinc 1%) | hints_product_ref:ok |
| CeraVe Hydrating Cleanser | false | false | no_candidates | no_candidates | 0 | 2347 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| La Roche-Posay Cicaplast Baume B5 | false | false | no_candidates | no_candidates | 0 | 2393 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Bioderma Sensibio H2O Micellar | false | false | no_candidates | no_candidates | 0 | 2350 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Winona Soothing Repair Serum | true | true | hint_product_ref | n/a | 1 | 0 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | hints_product_ref:ok |
| IPSA Time Reset Aqua | false | true | stable_alias_match | stable_alias_match | 1 | 0 | 9886500127048 | merch_efbc46b4619cfbdf | 9886500127048 (IPSA Time Reset Aqua) | stable_alias_ref:ok(alias_exact) |
| SK-II Facial Treatment Essence | false | false | no_candidates | no_candidates | 0 | 2448 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Avene Cicalfate+ Restorative Protective Cream | false | false | no_candidates | no_candidates | 0 | 2348 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |

## Summary

- total_queries: 8
- resolved_queries: 3
- resolve_rate: 0.375

Artifacts:
- `reports/product_grounding_probe_20260213_033748.md`
- `reports/product_grounding_probe_20260213_033748.csv`
