# Product Grounding Probe

- generated_at_utc: 2026-02-11T06:28:39Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `4500`
- upstream_retries: `1`
- include_stable_hints: `false`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | false | false | no_candidates | n/a | 0 | 4502 | n/a | n/a | n/a  | products_cache:fail(db_error);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_error);agent_search_global:fail(upstream_timeout) |
| Winona Soothing Repair Serum | false | false | no_candidates | n/a | 0 | 4502 | n/a | n/a | n/a  | products_cache:fail(db_error);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_error);agent_search_global:fail(upstream_timeout) |
| IPSA Time Reset Aqua | false | false | no_candidates | n/a | 0 | 4502 | n/a | n/a | n/a  | products_cache:fail(db_error);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_error);agent_search_global:fail(upstream_timeout) |

## Summary

- total_queries: 3
- resolved_queries: 0
- resolve_rate: 0.000

Artifacts:
- `reports/product_grounding_probe_20260211_062839.md`
- `reports/product_grounding_probe_20260211_062839.csv`
