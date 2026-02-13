# Product Grounding Probe

- generated_at_utc: 2026-02-13T04:36:58Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `1600`
- upstream_retries: `0`
- include_stable_hints: `false`
- curl_retry_max: `6`
- curl_retry_delay_sec: `1`
- curl_connect_timeout_sec: `5`
- curl_max_time_sec: `45`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SK-II Facial Treatment Essence | false | false | no_candidates | no_candidates | 0 | 1739 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout) |

## Summary

- total_queries: 1
- resolved_queries: 0
- resolve_rate: 0.000

Artifacts:
- `reports/product_grounding_probe_20260213_043658.md`
- `reports/product_grounding_probe_20260213_043658.csv`
