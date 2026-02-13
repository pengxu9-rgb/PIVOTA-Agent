# Product Grounding Probe

- generated_at_utc: 2026-02-11T07:33:05Z
- base: `https://pivota-agent-production.up.railway.app`
- lang: `en`
- timeout_ms: `2200`
- upstream_retries: `1`
- include_stable_hints: `false`

| query | hinted | resolved | reason | reason_code | confidence | latency_ms | matched_product_id | matched_merchant_id | top_candidate | sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Ordinary Niacinamide 10% + Zinc 1% | false | true | stable_alias_ref | n/a | 1 | 2353 | prod_the_ordinary_niacinamide_10_zinc_1 | merch_efbc46b4619cfbdf | prod_the_ordinary_niacinamide_10_zinc_1 (The Ordinary Niacinamide 10% + Zinc 1%) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |
| CeraVe Hydrating Cleanser | false | false | no_candidates | no_candidates | 0 | 2348 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| La Roche-Posay Cicaplast Baume B5 | false | false | no_candidates | no_candidates | 0 | 2438 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Bioderma Sensibio H2O Micellar | false | false | no_candidates | no_candidates | 0 | 2349 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Winona Soothing Repair Serum | false | true | stable_alias_ref | n/a | 1 | 2347 | prod_winona_soothing_repair_serum | merch_efbc46b4619cfbdf | prod_winona_soothing_repair_serum (Winona Soothing Repair Serum) | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout);stable_alias_ref:ok |
| IPSA Time Reset Aqua | false | false | no_candidates | no_candidates | 0 | 2354 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| SK-II Facial Treatment Essence | false | false | no_candidates | no_candidates | 0 | 2369 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |
| Avene Cicalfate+ Restorative Protective Cream | false | false | no_candidates | no_candidates | 0 | 2359 | n/a | n/a | n/a  | products_cache:fail(db_query_timeout);agent_search_scoped:fail(upstream_timeout);products_cache_global:fail(db_query_timeout) |

## Summary

- total_queries: 8
- resolved_queries: 2
- resolve_rate: 0.250

Artifacts:
- `reports/product_grounding_probe_20260211_073305.md`
- `reports/product_grounding_probe_20260211_073305.csv`
