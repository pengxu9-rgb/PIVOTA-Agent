# Commerce Search Runtime Probe

- generated_at: 2026-03-25T05:34:36.200Z
- base_url: https://agent.pivota.cc
- endpoint: /agent/shop/v1/invoke
- total_cases: 6
- strict_cases: 5
- strict_pass_count: 0
- strict_fail_count: 5
- all_strict_green: false

| id | operation | status | latency_ms | products | overall_ok | query_source | serving_mode | top1 |
|---|---|---:|---:|---:|---|---|---|---|
| fp_exact_ipsa | find_products | 200 | 1481 | 0 | false |  |  |  |
| fp_generic_brush | find_products | 200 | 1185 | 0 | false |  |  |  |
| fpm_exact_ipsa_eligible_only | find_products_multi | 200 | 301 | 0 | false |  |  |  |
| fpm_brand_winona | find_products_multi | 200 | 284 | 0 | false |  |  |  |
| fpm_tool_brush | find_products_multi | 200 | 6714 | 0 | false |  |  |  |
| fpm_scenario_date_makeup | find_products_multi | 200 | 5235 | 0 | true |  |  |  |

## Case Details

### fp_exact_ipsa

- label: find_products exact lookup
- operation: find_products
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 1481
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

### fp_generic_brush

- label: find_products generic brush lookup
- operation: find_products
- query: foundation brush
- status: 200
- latency_ms: 1185
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

### fpm_exact_ipsa_eligible_only

- label: find_products_multi exact lookup eligible-only
- operation: find_products_multi
- query: IPSA Time Reset Aqua
- status: 200
- latency_ms: 301
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

### fpm_brand_winona

- label: find_products_multi brand lookup
- operation: find_products_multi
- query: Winona products
- status: 200
- latency_ms: 284
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

### fpm_tool_brush

- label: find_products_multi tool-first brush query
- operation: find_products_multi
- query: foundation brush recommendation
- status: 200
- latency_ms: 6714
- overall_ok: false
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

### fpm_scenario_date_makeup

- label: find_products_multi scenario query
- operation: find_products_multi
- query: 我今晚有个约会，要化妆，要推荐点商品吧？
- status: 200
- latency_ms: 5235
- overall_ok: true
- anchor_hits: (none)
- clarification_triggered: false
- query_source: (none)
- serving_mode: (none)
- commerce_surface: (none)
- top_products: (none)

JSON: reports/search-runtime-validation/commerce_search_runtime_probe_20260325_053420.json