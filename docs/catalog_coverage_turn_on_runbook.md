# Catalog-coverage turn-on runbook

*2026-06-30. Staged, gated turn-on of the catalog-coverage engine (all 10 PRs merged
to main). Do the steps IN ORDER; validate each before the next. Everything is OFF by
default, so deploying is safe — nothing autonomous runs until you flip the flags.*

Background + architecture: `docs/identity_resolution_deposit_investigation.md`.

**Conventions used below**
- DB queries run against prod via the public proxy. From a `pivota-backend` checkout
  (linked to the Postgres service): `railway run bash -c 'psql "$DATABASE_PUBLIC_URL" -c "<SQL>"'`.
- Scripts run local-against-prod the same way (swap psql for the venv python). In-prod
  alternative: `railway ssh` into the service and run there.
- Env flags: Railway dashboard → service → Variables, or `railway variables --set K=V --service <svc>`.
  Changing a variable redeploys the service (needed — the ticks register at startup).

---

## Step 1 — Deploy (already merged)
Redeploy both services off `main` so the new code ships:
- `pivota-backend` (queue worker, onboard scripts, migration file, scheduler cron).
- `PIVOTA-Agent` (resolver auto-resolve tick).

## Step 2 — Apply migration 158 + enable the resolver tick

```bash
# 2a. Apply the (idempotent) queue migration to prod
railway run bash -c 'psql "$DATABASE_PUBLIC_URL" -f db/migrations/158_catalog_onboard_queue.sql'
railway run bash -c 'psql "$DATABASE_PUBLIC_URL" -c "\d catalog_onboard_queue"'   # verify table exists

# 2b. Turn ON the identity resolver tick (PIVOTA-Agent service)
railway variables --set PDP_IDENTITY_AUTO_RESOLVE_ENABLED=true --service PIVOTA-Agent
#    optional tunables: PDP_IDENTITY_AUTO_RESOLVE_INTERVAL_MINUTES (default 30), PDP_IDENTITY_AUTO_RESOLVE_LIMIT (200)
```
Verify the tick is running (PIVOTA-Agent logs): look for `pdp_identity_auto_resolve tick`.

## Step 3 — Validate ONE real onboard end-to-end (before scaling)

Onboard a single known-Shopify brand and watch it become depositable, then cited.

```bash
# 3a. Onboard kosas (Shopify) → writes external_product_seeds + catalog rows
railway run bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" .venv/bin/python -m \
  scripts.onboard_curated_brands --domain kosas.com --category beauty/makeup --apply'
```
```sql
-- 3b. seeds written?
SELECT count(*) FROM external_product_seeds WHERE domain='kosas.com' AND status='active';

-- 3c. AFTER one resolver-tick interval (~30 min): resolved to high confidence?
SELECT round(avg(identity_confidence),3) avg_conf,
       count(*) FILTER (WHERE identity_confidence>=0.85) ge85, count(*) total
FROM pdp_identity_listing pil
JOIN catalog_products cp ON cp.product_key = pil.product_id  -- or match on content_key
WHERE cp.merchant_id='external_seed' AND cp.brand ILIKE '%kosas%';

-- 3d. AFTER the trust cron (catalog_row_trust_backfill_tick): depositable in the gate's table?
SELECT count(*) FILTER (WHERE t.identity_confidence>=0.85) depositable, count(*) total
FROM catalog_products cp JOIN catalog_row_trust t ON t.product_key=cp.product_key
WHERE cp.merchant_id='external_seed' AND cp.brand ILIKE '%kosas%';
```
```bash
# 3e. Run an audit on a merchant in the same category, then check the matrix:
```
```sql
-- did kosas get cited / deposited as an anchor?
SELECT cited_host, host_type, count(*) FROM citation_observations
WHERE cited_host ILIKE '%kosas%' OR content_key IN (
  SELECT content_key FROM catalog_products WHERE merchant_id='external_seed' AND brand ILIKE '%kosas%')
GROUP BY 1,2 ORDER BY 3 DESC;
```
**Gate:** only proceed if 3d shows depositable > 0. If 0, the resolver/trust step isn't
completing — debug before scaling (do NOT enable the queue).

## Step 4 — Turn ON unattended growth

```bash
# 4a. Seed the queue from a curated brand list (recurrence-prioritized) + drain once manually:
railway run bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" .venv/bin/python -m \
  scripts.run_catalog_onboard_queue --enqueue-curated data/catalog_enrichment/curated_brands.jsonl --drain --apply'
#    (curated_brands.jsonl: one {"domain","category_path","brand"} per line)
#    or get the priority queue first: python -m scripts.competitor_recurrence_report --limit 50

# 4b. Enable the scheduled worker (pivota-backend service)
railway variables --set CATALOG_ONBOARD_ENABLED=true --service <pivota-backend-service>
#    optional: CATALOG_ONBOARD_TICK_LIMIT (default 20)
```
```sql
-- 4c. watch the queue drain
SELECT status, count(*) FROM catalog_onboard_queue GROUP BY 1;
```

---

## Rollback (instant, no deploy)
```bash
railway variables --set CATALOG_ONBOARD_ENABLED=false --service <pivota-backend-service>
railway variables --set PDP_IDENTITY_AUTO_RESOLVE_ENABLED=false --service PIVOTA-Agent
```
Both ticks no-op immediately on the next interval. The queue table + any deposited
anchors remain (idempotent; harmless). Nothing to revert in code.

## Notes / known follow-ups
- Curated feed has gift-item / 0-price / 0-GTIN noise (seen on kosas) — consider a
  quality filter before wide enablement.
- `recurrence_rank` is available but not yet wired into the feeds by default.
- Non-Shopify brands return 0 from `/products.json`; their *relevant* products still flow
  via the audit→Gemini path. Build a sitemap/agent enumerator only if data shows a gap.
