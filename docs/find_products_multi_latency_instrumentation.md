# find_products_multi latency: per-leg instrumentation + first fixes

**Date:** 2026-07-10. **Motivation:** prod `invoke request complete` logs showed
`operation=find_products_multi latency_ms=8530–15172` with `upstream_ms=0` on every
request, and generic head terms ("lipstick") exceeding 90s. The public MCP tier
(`mcp-server/src/publicReadCache.js`) masks this with a TTL+SWR cache; this change is
the real fix's first slice: make the cost attributable, bound the worst tail, and stop
shipping pool-sized payloads. Target: p95 < 3s (see the latency gate note in
`docs/openai_apps_dark_launch_verification.md`, branch `openai-apps` track).

## Why upstream_ms was always 0

`callTrackedUpstream` only accumulated `upstreamElapsedMs` when
`CHECKOUT_TIMING_OPS.has(op)` (`preview_quote`/`create_order`/`submit_payment`).
`find_products_multi` never matched, so the completion log claimed `upstream_ms=0`
while the pipeline spent seconds in sequential HTTP + LLM legs. Fixed: FPM ops now
measure into `upstreamElapsedMs` too.

## What is emitted now

Every `find_products_multi` / `find_products` request logs, in the existing
`invoke request complete` line (`src/server.js`, `res.on('finish')` handler):

- `upstream_ms` — real summed HTTP-leg time (was always 0).
- `fpm_stage_breakdown` — array of `{stage, latency_ms, ...extras}` entries, one per
  executed pipeline leg (mirrors the discovery feed's `provider_breakdown`).
- `fpm_stage_total_ms` — sum of stage latencies. NOTE: legs that run in parallel
  (resolver_first + primary_upstream) both count, so this can exceed `latency_ms`;
  that is expected — it measures work, not wall clock.
- `fpm_upstream_http_ms` — sum of stages flagged `upstream_http: true`.

### Stage taxonomy

| stage | what it is | HTTP? |
|---|---|---|
| `context_build` | `buildFindProductsMultiContext` (NLU / query understanding, may include LLM semantic rewrite) | no |
| `citable_supplement` | ADR-007 citable item prefetch | no (DB) |
| `resolver_first` | resolver probe for lookup/brand queries (extras: `adopted`, `parallel_primary_started`, `discarded_speculative_primary`) | yes |
| `primary_upstream` | the main recall call (agent_v2 POST / agent_v1 GET / strict invoke) | yes |
| `legacy_contract_fallback` | agent_v1 retry after canonical-contract error | yes |
| `resolver_after_exception` / `secondary_invoke_fallback` | exception-path fallbacks | yes |
| `normalize_hydrate` | response normalization + catalog-identity SQL hydration (extras: `returned`) | no (DB) |
| `second_stage_context` | second `buildFindProductsMultiContext` with expansion mode | no |
| `second_stage_upstream` | widened re-query when primary underfills | yes |
| `resolver_after_primary` / `secondary_fallback_after_primary` | post-primary quality fallbacks | yes |
| `external_seed_supplement` | external-seed fill on the cross-merchant cache path | yes |
| `brand_rescue_pre_policy` / `brand_rescue_post_policy` | local external-seed brand rescue | no (DB) |
| `policy_apply` | `applyFindProductsMultiPolicy` ranking (extras: `skipped`) | no (CPU) |
| `llm_rerank` | LLM rerank pass (extras: `applied`, `provider`, `error`) | LLM |
| `pdp_identity_rescue` | PDP identity-graph rescue | no (DB) |
| `savings_hydrate` | savings presentation hydration | maybe |

Stages that don't run for a given request are simply absent — the breakdown is also a
map of which legs fired. Anything unaccounted (wall `latency_ms` minus overlapping
stage time) is gateway CPU / cross-merchant cache recall (not yet wrapped — it has
many early-return fastpaths; wrap next if the residual is large).

## Behavior changes (each with a kill switch)

1. **LLM rerank hard timeout** — `src/findProductsMulti/rerankLlm.js`. The OpenAI
   client previously used SDK defaults (600s timeout, 2 retries): one slow
   `gpt-5.1-mini` call on a ~240KB prompt explains the 90s head-term tails (head
   terms surface external-seed candidates, which is exactly the rerank trigger, and
   the rerank auto-enables whenever any OpenAI/Gemini key is present).
   Now: `PIVOTA_RERANK_LLM_TIMEOUT_MS` (default **2500ms**, clamp 500–15000) per
   provider, `maxRetries: 0` for OpenAI, Gemini capped at `min(12000, env)`. Worst
   case with a 2-provider chain ≈ 2× the deadline; rerank already fails open
   (ordering kept).
2. **Resolver-first ∥ primary race** — `FPM_PARALLEL_RESOLVER_PRIMARY` (default
   **on**). For lookup/brand-class queries the resolver probe used to run *before*
   the primary (up to ~1.2s serialized). Now the primary starts concurrently; if the
   resolver adopts, the in-flight primary is discarded (extra backend read, bounded
   by its axios timeout — this is the deliberate trade). The
   post-resolver-miss primary-timeout reduction is skipped when the primary is
   already in flight.
3. **Honor explicit page_size/limit** — `FPM_ENFORCE_REQUESTED_PAGE_SIZE` (default
   **on**). Upstream returns a pool (~52 rows) regardless of requested limit and the
   gateway never trimmed it. Now `enforceFindProductsMultiRequestedPageSize` trims at
   the `res.json` choke point, i.e. **after** policy ranking, LLM rerank, and the
   citable-supplement append — deliberately, because Phase-1 active-aware ranking
   promotes items from deep in the pool (the rank-38/52 fix) and must keep seeing the
   full pool. Only applies when the client sent an explicit `page_size`/`limit`
   (default-omitted requests keep pool-sized responses — no silent change for
   existing consumers); strict-contract responses (`shop_invoke_strict`) are exempt
   (parity-locked). `total` keeps the pool size; `metadata.page_size_enforcement =
   {applied, requested_page_size, pre_trim_count}` records the trim. Note: items the
   citable supplement appended beyond the limit are trimmed like any other row; the
   supplement mainly matters on underfilled long-tail queries where trimming never
   bites. This also directly shrinks the 678KB responses flagged in
   `docs/openai_apps_audit.md`.

## What this does NOT yet fix

- The primary upstream leg itself (2.2–3.8s in the Python backend) — p95 < 3s is not
  reachable from the gateway alone; use the new breakdown to build the backend case.
- Cross-merchant cache recall / beauty mainline legs are not individually wrapped.
- `max_results` is still ignored everywhere (only `page_size`/`limit` are honored).
- `FPM_GATEWAY_TOTAL_BUDGET_MS` (default 2500) still only gates resolver-first and
  second-stage expansion; `context_build` and `llm_rerank` bypass it. Once prod
  breakdowns confirm where time goes, consider a rerank budget guard (note: with the
  2.5s default budget it would de-facto disable rerank — decide deliberately).

## Prod verification recipe

After deploy (`api.pivota.cc/version` for the SHA), grep Railway logs for
`invoke request complete` with `operation=find_products_multi`:

1. `upstream_ms` should be non-zero and ≈ the sum of `upstream_http` stages.
2. `fpm_stage_breakdown` should attribute the 8–15s: expect `primary_upstream`
   2200–3800ms; watch `context_build`, `second_stage_*`, and `llm_rerank` for the
   remainder.
3. Head-term probe (`"lipstick"`): `llm_rerank.latency_ms` must now cap ≈2.5s per
   provider; no more >90s requests.
4. Lookup probe (brand/product-title query): `resolver_first` entry shows
   `parallel_primary_started: true`; wall `latency_ms` ≈ max(resolver, primary), not
   the sum.
5. Explicit page_size probe: request `page_size: 5` → 5 products,
   `metadata.page_size_enforcement.pre_trim_count` shows the pool size.

Rollback: `FPM_PARALLEL_RESOLVER_PRIMARY=false`, `FPM_ENFORCE_REQUESTED_PAGE_SIZE=false`,
`PIVOTA_RERANK_LLM_TIMEOUT_MS=600000` (≈old behavior; clamped to 15000 — set the flag
consumers' env only if truly needed). Instrumentation has no flag; it is log-only.

## Tests

- `tests/find_products_multi_page_size_enforcement.test.js` — trim/no-op/strict-exempt
  /invalid-value contract for the enforcement helper (via `server._debug`).
- `tests/find_products_multi_rerank_llm_timeout.test.js` — bounded timeout flows to the
  provider call; default 2500ms; env clamped.
- Gotcha found while testing: route-level find_products_multi cannot be exercised with
  nock in the jest env (the shopping mainline primary throws `ERR_INVALID_URL`
  pre-existing on main, and beauty queries route to in-process/DB primitives) — unit
  test FPM internals via `module.exports._debug`, matching existing suites.
- Pre-existing failure on main (not this change): `find_products_multi_context.test.js`
  › "exact stable-alias product title uses lookup class" expects `lookup`, gets
  `exploratory`.
