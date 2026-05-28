# PBA Delta Gap-Fill Runbook

Keeps `product_beauty_attributes` (PBA) covering the full `ext_*` external_seed
universe. PBA is the attribute layer the relation-graph Phase B preflight gates
(`category_leaf` / `target_area` / `spf_or_otc` mismatch) read from — if a
product is missing from PBA, its relation candidates can't be gated and slip
through to human review ungated.

Script: `scripts/extract-product-beauty-attributes-delta.js` (PR #1576).

## When to run

**Run this AFTER each `external_seed` backfill — it is the closing step of a
backfill, not a scheduled job.**

The PBA gap only grows when an `external_seed` backfill adds new `ext_*`
products (`backfill-external-seed-*.cjs` / the `external-seed-*` GitHub
Actions). Between backfills the gap stays flat, so a timer would mostly fire
noops. Tie the gap-fill to the thing that actually creates work.

There is intentionally **no Railway cron** for this yet: the relation graph is
a pre-rollout pilot (runtime flag `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED` is
off). When the graph goes to production, register a Railway cron on a dedicated
service (`0 6 * * *` UTC, command below) — the prod env already holds the
`DATABASE_URL` + `DEEPSEEK_API_KEY` the job needs.

## How to run

```bash
node scripts/extract-product-beauty-attributes-delta.js
```

Requires env: `DATABASE_URL` (Pivota Infra prod) and `DEEPSEEK_API_KEY`.

Behavior:
- Caps at `PBA_DELTA_LIMIT` rows/run (default **50**).
- No-ops (skips the LLM) if the gap is already 0.
- Emits a single JSON metric line to stdout, e.g.:
  ```json
  {"status":"ok","provider":"deepseek","model":"deepseek-chat",
   "gap_size_pre":5,"gap_size_post":0,"products_classified":5,
   "products_failed":0,"estimated_cost_usd":0.003,
   "alert_threshold_exceeded":false}
  ```
- Logs an ALERT to stderr and sets `alert_threshold_exceeded: true` if the
  post-run gap still exceeds `PBA_DELTA_ALERT_GAP_THRESHOLD` (default **100**) —
  meaning a single 50-row run couldn't catch up; run again or raise the limit.

Cost is ~$0.0006/row (DeepSeek), so a full 50-row run is ~$0.03.

## Checking the gap without running

```sql
SELECT count(DISTINCT external_product_id)
FROM external_product_seeds
WHERE external_product_id LIKE 'ext_%'
  AND external_product_id NOT IN (SELECT product_key FROM product_beauty_attributes);
```

## Notes

- `target_area` is validated against a fixed 14-value enum (incl. `oral`);
  invalid values are rejected at write time (PR #1575).
- If you also re-run the relation-candidate build, run it **after** this
  gap-fill — building before PBA is populated leaves gates dormant (the cause
  of the 2026-05-27 dormant-gate incident; recover with
  `scripts/rescore-relationship-candidate-labels.js`).
