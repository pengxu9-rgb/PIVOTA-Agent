# Product Grounding Probe

- generated_at_utc: 2026-02-12T00:22:01Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `2500`
- upstream_retries: `1`
- include_stable_hints: `false`
- curl_retry_max: `6`
- curl_retry_delay_sec: `1`
- curl_connect_timeout_sec: `5`
- curl_max_time_sec: `45`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | false | true | stable_alias_ref | n/a | 1 | 2649 | 9886499864904 | merch_efbc46b4619cfbdf | 9886499864904 (The Ordinary Niacinamide 10% + Zinc 1%) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |
| Winona Soothing Repair Serum | false | true | stable_alias_ref | n/a | 1 | 2650 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |

## Summary

- total_queries: 2
- resolved_queries: 2
- resolve_rate: 1.000

Artifacts:
- `reports/product_grounding_probe_20260212_002201.md`
- `reports/product_grounding_probe_20260212_002201.csv`
