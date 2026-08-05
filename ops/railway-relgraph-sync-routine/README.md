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
- Applies non-LLM renewal of expiring `ai_approved` rows by default (see below).
- Keeps the production gates from `scripts/run-relationship-graph-sync-routine.js`:
  DB lock, stale lock recovery, serving suppression thresholds, and critical
  reason gating.
- Records each cron run in `relationship_graph_routine_runs` by default.
- Allows empty selection/build by default so no-op days do not fail the cron.

## Required Variables

- `DATABASE_URL`

Useful tuning variables:

- `RELGRAPH_SYNC_SELECT_HOURS=24`
- `RELGRAPH_SYNC_SELECT_LIMIT=250`
- `RELGRAPH_SYNC_LIMIT=200`
- `RELGRAPH_SYNC_REVIEW_LIMIT=250`
- `RELGRAPH_SYNC_ALLOW_EMPTY=true`
- `RELGRAPH_SYNC_RUN_LEDGER_ENABLED=true`
- `RELGRAPH_SYNC_RUN_TRIGGER=railway_cron`
- `RELGRAPH_SYNC_RUN_LEDGER_FAIL_CLOSED=false`

## AI-Approval Renewal

`ai_approved` rows expire 45 days after review and nothing else renews them —
without renewal the whole ai_approved serving set falls off
`product_relationship_edges` in one cliff (this emptied `get_alternatives` on
2026-07-17..26). The cron therefore runs
`scripts/renew-relationship-ai-approved-labels.js` as its first step and
APPLIES it by default: rows expiring within 14 days (or already expired) that
still pass the serving guard and still resolve to an actively-serving external
seed / catalog product (`activeCatalogProductSourceWhere` — the same liveness
predicate the serving read paths use) / product group get
`last_verified_at`/`expires_at` extended. `label_state` is never modified and
`human_approved` rows are never touched. Renewal is not an LLM call and is not
gated behind `RELGRAPH_SYNC_ALLOW_WRITES` (that gate protects LLM-driven
build/review label-state writes).

The renewal step is optional and timeboxed inside the routine: if it fails or
times out, the rest of the routine still runs. The failure appears in
`summary.warnings` (persisted inside the run ledger row's `summary` JSON — the
ledger `status` column stays `passed`, so do not gate on it for renewal
health). The loud backstop for a renewal path that silently stops working is
the daily Serving Guard Audit workflow's expiry alarm
(`relgraph:serving-status --fail-on-expiry-risk`), which goes red when >30% of
serving edges are within 14 days of expiry or the serving set shrinks below
the floor.

Note: because renewal applies by default, every scheduled run now carries
`--confirm APPLY_RELGRAPH_SYNC_ROUTINE`. The build/review write posture is
still controlled solely by the `RELGRAPH_SYNC_APPLY_BUILD` /
`RELGRAPH_SYNC_APPLY_REVIEW` + `RELGRAPH_SYNC_ALLOW_WRITES` envs — the token's
presence alone no longer implies a graph-label write was intended.

Deliberate policy defaults (change with the founder, not silently):

- Verdicts older than 180 days are NOT auto-renewed (`--max-age-days`); an AI
  verdict must not stay alive forever without a fresh review. Age is measured
  from the AI-verdict date (`provenance.re_verify.first_verified_at`, else
  `last_verified_at` as written at approval) — never `created_at`, which for
  backfilled rows predates the verdict. Age-capped rows expire and show up in
  the renewal report as `skipped.age_capped`.
- `RELGRAPH_SYNC_APPLY_RENEWAL=false` demotes renewal to dry-run.
- `RELGRAPH_SYNC_SKIP_RENEWAL=true` skips the step entirely.
- `RELGRAPH_SYNC_RENEWAL_WINDOW_DAYS=14` tunes the lookahead.
- `RELGRAPH_SYNC_RENEWAL_MAX_AGE_DAYS=180` tunes the re-review age cap.

Write mode stays disabled unless all of these are set deliberately:

- `RELGRAPH_SYNC_APPLY_BUILD=true` or `RELGRAPH_SYNC_APPLY_REVIEW=true`
- `RELGRAPH_SYNC_ALLOW_WRITES=true`
- `RELGRAPH_SYNC_CONFIRM=APPLY_RELGRAPH_SYNC_ROUTINE`

`RELGRAPH_SYNC_APPLY_SYNC=true` is intentionally rejected for the cron runner;
selector mode is read-only and does not mutate catalog rows.

## Status Checks

Use the ledger report for read-only operator checks after manual probes and
scheduled cron runs:

```bash
npm run relgraph:run-ledger -- --all-markets --limit 5
npm run relgraph:run-ledger -- --trigger railway_cron --max-age-minutes 180 --fail-on-empty --fail-on-latest-failed --json
```

The second command exits non-zero if no matching run exists, the latest run did
not pass, or the latest matching run is older than the configured freshness
window. For local checks against Railway production, run it through the linked
service env and point `DATABASE_URL` at the public Postgres URL inside the
process environment.

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
