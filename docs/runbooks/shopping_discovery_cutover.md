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
PIVOTA_API_BASE=https://web-production-fedb.up.railway.app
PIVOTA_BACKEND_BASE_URL=https://web-production-fedb.up.railway.app
PIVOTA_API_KEY=<pivota backend key>
API_MODE=REAL
USE_MOCK=false
DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS=6500
DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS=4
```

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

## Smoke success criteria

The smoke gate validates:

- `get_discovery_feed` is accepted on the public gateway
- `metadata.candidate_source=products_search`
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
   - `candidateSource: products_search`
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
