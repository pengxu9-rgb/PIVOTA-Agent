# Railway Relationship Graph Sync Routine

This template is for a dedicated Railway cron service that runs the relationship
graph sync routine without GitHub Actions.

Keep this `railway.toml` outside the repo root. The root service is the web
gateway, and adding cron config at the root would change that service's deploy
behavior.

## Runtime

Command:

```bash
npm run relgraph:sync-routine:cron
```

Default behavior:

- Runs once every day at `10:37 UTC`.
- Uses selector mode against recently updated `catalog_products` and
  `external_product_seeds`.
- Dry-runs graph build/review by default.
- Keeps the production gates from `scripts/run-relationship-graph-sync-routine.js`:
  DB lock, stale lock recovery, serving suppression thresholds, and critical
  reason gating.
- Allows empty selection/build by default so no-op days do not fail the cron.

## Required Variables

- `DATABASE_URL`

Useful tuning variables:

- `RELGRAPH_SYNC_SELECT_HOURS=24`
- `RELGRAPH_SYNC_SELECT_LIMIT=250`
- `RELGRAPH_SYNC_LIMIT=200`
- `RELGRAPH_SYNC_REVIEW_LIMIT=250`
- `RELGRAPH_SYNC_ALLOW_EMPTY=true`

Write mode stays disabled unless all of these are set deliberately:

- `RELGRAPH_SYNC_APPLY_BUILD=true` or `RELGRAPH_SYNC_APPLY_REVIEW=true`
- `RELGRAPH_SYNC_ALLOW_WRITES=true`
- `RELGRAPH_SYNC_CONFIRM=APPLY_RELGRAPH_SYNC_ROUTINE`

`RELGRAPH_SYNC_APPLY_SYNC=true` is intentionally rejected for the cron runner;
selector mode is read-only and does not mutate catalog rows.

## Upstream Assumptions

This cron routine does not replace the PBA delta gap-fill. After external seed
backfills introduce new `ext_*` products, still run
`scripts/extract-product-beauty-attributes-delta.js` before applying relationship
graph changes so preflight gates have product attributes to read.

## Deploy Shape

The normal production policy remains GitHub `main` as source of truth. For the
cron service, create/link a separate Railway service to the same repository and
copy this template to that service's root Railway config.

If a one-off manual service upload is unavoidable, only upload code that is
already merged to `main`, and record the exception in the PR or runbook.
