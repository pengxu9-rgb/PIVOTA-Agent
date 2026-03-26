# Commerce Search Runtime Probe

- generated_at: 2026-03-25T05:32:26.504Z
- base_url: https://agent.pivota.cc
- endpoint: /api/gateway
- total_cases: 6
- strict_cases: 6
- strict_pass_count: 3
- strict_fail_count: 3
- all_strict_green: false

| id | operation | status | latency_ms | products | overall_ok | query_source | serving_mode | top1 |
|---|---|---:|---:|---:|---|---|---|---|
| fp_exact_ipsa | find_products | 200 | 1553 | 1 | true | agent_products_resolver_fallback |  | IPSA Time Reset Aqua |
| fp_generic_brush | find_products | 200 | 3577 | 20 | true | agent_products_search |  | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_exact_ipsa_eligible_only | find_products_multi | 200 | 2412 | 1 | true | agent_products_resolver_fallback | eligible_only | IPSA Time Reset Aqua |
| fpm_brand_winona | find_products_multi | 200 | 1586 | 1 | false | cache_cross_merchant_search |  | Winona Soothing Repair Serum |
| fpm_tool_brush | find_products_multi | 200 | 2194 | 10 | false | cache_cross_merchant_search |  | Small Foundation Brush — Seamless, Streak‑Free Base • Soft Synthetic Fibers |
| fpm_scenario_date_makeup | find_products_multi | 0 | 15005 | 0 | false |  |  |  |

## Case Details

### fp_exact_ipsa

- label: find_products exact lookup
- operation: find_products
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 1553
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
- latency_ms: 3577
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
- latency_ms: 2412
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
- latency_ms: 1586
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
- latency_ms: 2194
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
- status: 0
- latency_ms: 15005
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- error: timeout of 15000ms exceeded

JSON: reports/search-runtime-validation/commerce_search_runtime_probe_20260325_053200.json