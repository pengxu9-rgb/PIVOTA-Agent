# Shopping Discovery Cutover

## Goal

Cut Shopping Discovery onto the public `pivota-agent` contract while keeping candidate recall on the commerce data plane.

- External/UI entrypoint: `https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke`
- Discovery operation: `get_discovery_feed`
- Internal recall rail: `https://web-production-fedb.up.railway.app/agent/v1/products/search`

Do not cut the creator UI directly onto `web-production-fedb` for discovery.

## Required production env

Set on `pivota-agent-production`:

```bash
DISCOVERY_PRODUCTS_SEARCH_BASE_URL=https://web-production-fedb.up.railway.app
DISCOVERY_PRODUCTS_SEARCH_API_KEY=<pivota backend key>
API_MODE=REAL
USE_MOCK=false
DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS=1800
DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS=4
DISCOVERY_RECALL_BUDGET_MS=1800
CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET=US
```

Compatibility-only fallback envs such as `PIVOTA_BACKEND_BASE_URL`, `PIVOTA_API_BASE`, and `PIVOTA_API_KEY`
should not be used as the production discovery mainline. If discovery is still relying on those fallbacks,
`/healthz.discovery.discovery_ready` can stay true, but `discovery.products_search_ready.legacy_config_fallback`
or related warning codes will indicate a degraded configuration that must be cleaned up before cutover signoff.

Set on creator UI:

```bash
PIVOTA_AGENT_URL=https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke
CREATOR_AGENT_API_KEY=<public invoke key>
```

## Deployment flow

Production source of truth remains GitHub `main` plus Railway auto-deploy.

1. Merge the discovery change into `main`.
2. Wait for Railway auto-deploy.
3. Verify deployed commit:

```bash
npm run deploy:verify:production
```

Deploy consistency uses `/version`, with `/healthz.version.commit` as fallback. It does not rely on invoke payload metadata.

4. Run discovery smoke:

```bash
CREATOR_AGENT_API_KEY=<public invoke key> \
BASE_URL=https://pivota-agent-production.up.railway.app \
npm run smoke:discovery:prod
```

5. Verify `/healthz`:

```bash
curl -s https://pivota-agent-production.up.railway.app/healthz | jq '.discovery'
```

Required health signals:

- `discovery.discovery_ready=true`
- `discovery.products_search_ready.ready=true`
- `discovery.db_backed_providers_ready.ready=true`
- `discovery.single_provider_mode=false`
- `products_available=true`

## Smoke success criteria

The smoke gate validates:

- `get_discovery_feed` is accepted on the public gateway
- `metadata.catalog_status` is not `unavailable`
- `metadata.provider_breakdown` contains at least one `successful=true` provider
- `products_search.failure_reason` is not `missing_base_url`, `http_401`, `http_403`, or `timeout`
- deploy provenance is already verified separately via `/version`
- cold-start `home_hot_deals` returns `cold_start_curated`
- history-seeded `home_hot_deals` returns `personalized_interest`
- history-seeded `browse_products` page 1 suppresses the exact recent-view product
- debug responses expose `rank_debug.recall_summary`

## UI cutover checks

After backend smoke passes:

1. Open creator UI with `?tab=deals&debug=1`
2. Verify `/api/creator-agent/discovery` returns `200`
3. Verify debug panel shows:
   - `catalogStatus` is not `unavailable`
   - at least one provider in `providerBreakdown` is successful
   - `discoveryStrategy: cold_start_curated` for empty-history sessions
   - `discoveryStrategy: personalized_interest` after browsing at least one product
4. Verify no unsupported-operation or mock fallback errors appear

## Rollback

If the deploy is unhealthy:

1. Stop cutover and keep UI on the same public `pivota-agent` URL
2. Roll back the gateway deploy through normal GitHub/Railway revert flow
3. Re-run:

```bash
npm run deploy:verify:production
CREATOR_AGENT_API_KEY=<public invoke key> BASE_URL=https://pivota-agent-production.up.railway.app npm run smoke:discovery:prod
```

Do not work around a broken public gateway by pointing the UI or external callers directly at `web-production-fedb`.
