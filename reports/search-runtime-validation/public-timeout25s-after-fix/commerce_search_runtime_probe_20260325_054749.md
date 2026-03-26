# Commerce Search Runtime Probe

- generated_at: 2026-03-25T05:48:26.293Z
- base_url: https://agent.pivota.cc
- endpoint: /api/gateway
- total_cases: 6
- strict_cases: 5
- strict_pass_count: 3
- strict_fail_count: 2
- all_strict_green: false

| id | operation | status | latency_ms | products | overall_ok | query_source | serving_mode | top1 |
|---|---|---:|---:|---:|---|---|---|---|
| fp_exact_ipsa | find_products | 200 | 1044 | 1 | true | agent_products_resolver_fallback |  | IPSA Time Reset Aqua |
| fp_generic_brush | find_products | 200 | 4247 | 20 | true | agent_products_search |  | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_exact_ipsa_eligible_only | find_products_multi | 200 | 2774 | 1 | true | agent_products_resolver_fallback | eligible_only | IPSA Time Reset Aqua |
| fpm_brand_winona | find_products_multi | 200 | 2562 | 1 | false | cache_cross_merchant_search |  | Winona Soothing Repair Serum |
| fpm_tool_brush | find_products_multi | 200 | 2421 | 10 | false | cache_cross_merchant_search |  | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_scenario_date_makeup | find_products_multi | 200 | 23597 | 0 | true | agent_products_error_fallback | eligible_only |  |

## Case Details

### fp_exact_ipsa

- label: find_products exact lookup
- operation: find_products
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 1044
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
- latency_ms: 4247
- overall_ok: true
- anchor_hits: brush
- clarification_triggered: false
- query_source: agent_products_search
- serving_mode: (none)
- commerce_surface: (none)
- top_products: Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers | Small Eyeshadow Brush — Soft Wash to Smoky • Soft Synthetic Fibers • With Pouch | Small Eyeshadow Brush — Soft Wash to Smoky • Soft Synthetic Fibers

### fpm_exact_ipsa_eligible_only

- label: find_products_multi exact lookup eligible-only
- operation: find_products_multi
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 2774
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
- latency_ms: 2562
- overall_ok: false
- anchor_hits: winona
- clarification_triggered: false
- query_source: cache_cross_merchant_search
- serving_mode: (none)
- commerce_surface: (none)
- top_products: Winona Soothing Repair Serum

### fpm_tool_brush

- label: find_products_multi tool-first brush query
- operation: find_products_multi
- query: foundation brush recommendation
- status: 200
- latency_ms: 2421
- overall_ok: false
- anchor_hits: brush
- clarification_triggered: false
- query_source: cache_cross_merchant_search
- serving_mode: (none)
- commerce_surface: (none)
- top_products: Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers | Round Foundation Brush — Skin‑Like Finish in Minutes • Soft Synthetic Fibers | Round Foundation Brush — Skin‑Like Finish in Minutes • Soft Synthetic Fibers

### fpm_scenario_date_makeup

- label: find_products_multi scenario query
- operation: find_products_multi
- query: 我今晚有个约会，要化妆，要推荐点商品吧？
- status: 200
- latency_ms: 23597
- overall_ok: true
- anchor_hits: (none)
- clarification_triggered: true
- query_source: agent_products_error_fallback
- serving_mode: eligible_only
- commerce_surface: agent_api
- top_products: (none)

JSON: reports/search-runtime-validation/public-timeout25s-after-fix/commerce_search_runtime_probe_20260325_054749.json