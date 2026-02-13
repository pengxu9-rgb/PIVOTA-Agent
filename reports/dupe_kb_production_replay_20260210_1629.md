# Aurora Dupe KB Production Replay (2026-02-10 16:29 UTC)

## Runtime
- service: `PIVOTA-Agent`
- commit: `e0f1069902dd`
- started_at: `2026-02-10T16:14:23.752Z`
- header: `x-service-commit: e0f1069902dd`

## Retrieval replay (production only)
- Endpoint: `POST /v1/dupe/suggest`
- Sample size: `10` random targets from ingest CSV
- Result:
  - `http_success = 10/10`
  - `non_empty = 10/10`
  - `parse_ready (dupes/comparables arrays) = 10/10`
  - `error_rate = 0`
  - latency `p50 = 425ms`, `p95 = 881ms`
  - source attribution: `csv_ingest_staging_full_20260210` for all sampled rows
- Artifact: `reports/dupe_kb_production_replay_202602101627.json`

## Compliance / recommendation metrics snapshot
- `verify_budget_guard_total 0`
- `agreement_histogram_count 0`
- `product_rec_* / claims_*` metric families are present (`# HELP/#TYPE`) but currently have no emitted sample rows in this runtime window.

## Go / No-Go
- **GO for internal production usage** (dupe retrieval path healthy with ingested data).
- Public rollout can proceed on this KB slice if you keep existing hard policy gate (`claims_violation_total` must remain zero when series appears under traffic).

## Operator note
- Your shell lacks `rg`; use `grep`/`egrep` equivalents for metric filtering.
