# Product Grounding Probe

- generated_at_utc: 2026-02-11T12:36:18Z
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
| The Ordinary Niacinamide 10% + Zinc 1% | true | true | hint_product_ref | n/a | 1 | 0 | 9886499864904 | merch_efbc46b4619cfbdf | 9886499864904 (The Ordinary Niacinamide 10% + Zinc 1%) | hints_product_ref:ok |
| Winona Soothing Repair Serum | true | true | hint_product_ref | n/a | 1 | 0 | 9886500749640 | merch_efbc46b4619cfbdf | 9886500749640 (Winona Soothing Repair Serum) | hints_product_ref:ok |
| IPSA Time Reset Aqua | false | false | no_candidates | no_candidates | 0 | 2347 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |

## Summary

- total_queries: 3
- resolved_queries: 2
- resolve_rate: 0.667

Artifacts:
- `reports/product_grounding_probe_20260211_123618.md`
- `reports/product_grounding_probe_20260211_123618.csv`
