# Product Grounding Probe

- generated_at_utc: 2026-02-13T04:35:20Z
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
| SK-II Facial Treatment Essence | false | false | no_candidates | no_candidates | 0 | 2368 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Winona | false | true | title_contains_query | n/a | 1 | 2203 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | products_cache:ok;products_cache_global:ok;agent_search_global:fail(upstream_timeout) |

## Summary

- total_queries: 2
- resolved_queries: 1
- resolve_rate: 0.500

Artifacts:
- `reports/product_grounding_probe_20260213_043520.md`
- `reports/product_grounding_probe_20260213_043520.csv`
