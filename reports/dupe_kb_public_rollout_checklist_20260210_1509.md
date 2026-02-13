# Dupe KB Public Rollout Checklist (2026-02-10 15:09 UTC)

## Scope
- Dataset ingest target: `aurora_kb_ingest_targets200_BIDIRECTIONAL_TOP3TOP2_PLAINJSON_QUOTEALL_TINY.csv`
- Live service: `https://pivota-agent-production.up.railway.app`
- Live commit observed: `0704925e2538`

## Runtime Monitoring Check (post-ingest)
- Retrieval probe sample size: `10`
- HTTP success: `10/10`
- Non-empty dupes/comparables: `10/10`
- Parser-ready arrays: `10/10`
- Error rate: `0.0`
- Latency: `p50=428ms`, `p95=974ms`
- Source attribution: `csv_ingest_staging_full_20260210` for all sampled responses
- Probe artifact: `reports/dupe_kb_post_ingest_monitor_202602101508.json`

## Guard / Compliance Signals (live metrics)
- `product_rec_suppressed_total{reason="LOW_EVIDENCE"} = 378`
- `claims_template_fallback_total{reason="ok"} = 3447`
- `claims_violation_total` series not emitted (no increments observed)
- `product_rec_emitted_total` series not emitted (no increments observed)

## Gate Checks (local)
- `make ingredient-kb-dry-run` PASS
- `make ingredient-kb-audit` PASS
- `make claims-audit` PASS
- Focused tests PASS (`13/13`):
  - `tests/aurora_bff_claims_product_rec.node.test.cjs`
  - `tests/aurora_bff_ingredient_kb_v2.node.test.cjs`
  - `tests/aurora_bff_photo_modules_v1.node.test.cjs`

## Staging Readiness
- Staging endpoint check: `https://pivota-agent-staging.up.railway.app` -> `404 Application not found`
- Dedicated staging runtime is not available.

## Go / No-Go Decision
- Internal rollout: **GO** (ingest and runtime path are healthy)
- Public rollout: **NO-GO** until staging is restored and replayed end-to-end once

## Must-Fix Before Public Users
1. Restore staging environment (reachable URL + DB) and replay:
   - 5-row dry-run ingest
   - full 200 ingest
   - retrieval smoke (>=10 random URLs)
2. Add cache coherency step for `aurora_dupe_kb` ingest (or restart after bulk ingest) to avoid stale LRU returns.
3. Keep hard gate: no public rollout if `claims_violation_total` increments above 0.

## Immediate Next Actions
1. Provision staging app + DB and export environment values.
2. Re-run exact ingest/verify workflow in staging and archive one signed report.
3. If staging passes, schedule controlled production exposure with monitor-on-call window.
