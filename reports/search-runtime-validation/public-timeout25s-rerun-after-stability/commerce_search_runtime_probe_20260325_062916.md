# Commerce Search Runtime Probe

- generated_at: 2026-03-25T06:29:44.210Z
- base_url: https://agent.pivota.cc
- endpoint: /api/gateway
- total_cases: 6
- strict_cases: 5
- strict_pass_count: 5
- strict_fail_count: 0
- all_strict_green: true

| id | operation | status | latency_ms | products | overall_ok | query_source | serving_mode | top1 |
|---|---|---:|---:|---:|---|---|---|---|
| fp_exact_ipsa | find_products | 200 | 1151 | 1 | true | agent_products_resolver_fallback |  | IPSA Time Reset Aqua |
| fp_generic_brush | find_products | 200 | 2587 | 20 | true | agent_products_search |  | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_exact_ipsa_eligible_only | find_products_multi | 200 | 1801 | 1 | true | agent_products_resolver_fallback | eligible_only | IPSA Time Reset Aqua |
| fpm_brand_winona | find_products_multi | 200 | 1504 | 1 | true | cache_cross_merchant_search | eligible_only | Winona Soothing Repair Serum |
| fpm_tool_brush | find_products_multi | 200 | 1965 | 10 | true | cache_cross_merchant_search | eligible_only | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_scenario_date_makeup | find_products_multi | 200 | 18481 | 0 | true | agent_products_error_fallback | eligible_only |  |

## Case Details

### fp_exact_ipsa

- label: find_products exact lookup
- operation: find_products
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 1151
- overall_ok: true
- anchor_hits: ipsa, time reset aqua
- clarification_triggered: false
- query_source: agent_products_resolver_fallback
- serving_mode: (none)
- commerce_surface: (none)
- top_products: IPSA Time Reset Aqua

### fp_generic_brush

- label: find_products generic brush lookup
- operation: find_products
- query: foundation brush
- status: 200
- latency_ms: 2587
- overall_ok: true
- anchor_hits: brush
- clarification_triggered: false
- query_source: agent_products_search
- serving_mode: (none)
- commerce_surface: (none)
- top_products: Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers | Small Eyeshadow Brush — Soft Wash to Smoky • Soft Synthetic Fibers | Small Eyeshadow Brush — Blend Like a Pro • Soft Synthetic Fibers

### fpm_exact_ipsa_eligible_only

- label: find_products_multi exact lookup eligible-only
- operation: find_products_multi
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 1801
- overall_ok: true
- anchor_hits: ipsa, time reset aqua
- clarification_triggered: false
- query_source: agent_products_resolver_fallback
- serving_mode: eligible_only
- commerce_surface: agent_api
- top_products: IPSA Time Reset Aqua

### fpm_brand_winona

- label: find_products_multi brand lookup
- operation: find_products_multi
- query: Winona products
- status: 200
- latency_ms: 1504
- overall_ok: true
- anchor_hits: winona
- clarification_triggered: false
- query_source: cache_cross_merchant_search
- serving_mode: eligible_only
- commerce_surface: agent_api
- top_products: Winona Soothing Repair Serum

### fpm_tool_brush

- label: find_products_multi tool-first brush query
- operation: find_products_multi
- query: foundation brush recommendation
- status: 200
- latency_ms: 1965
- overall_ok: true
- anchor_hits: brush
- clarification_triggered: false
- query_source: cache_cross_merchant_search
- serving_mode: eligible_only
- commerce_surface: agent_api
- top_products: Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers | Round Foundation Brush — Skin‑Like Finish in Minutes • Soft Synthetic Fibers | Round Foundation Brush — Skin‑Like Finish in Minutes • Soft Synthetic Fibers

### fpm_scenario_date_makeup

- label: find_products_multi scenario query
- operation: find_products_multi
- query: 我今晚有个约会，要化妆，要推荐点商品吧？
- status: 200
- latency_ms: 18481
- overall_ok: true
- anchor_hits: (none)
- clarification_triggered: true
- query_source: agent_products_error_fallback
- serving_mode: eligible_only
- commerce_surface: agent_api
- top_products: (none)

JSON: reports/search-runtime-validation/public-timeout25s-rerun-after-stability/commerce_search_runtime_probe_20260325_062916.json