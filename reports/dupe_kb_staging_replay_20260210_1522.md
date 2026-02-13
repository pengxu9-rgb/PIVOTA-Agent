# Aurora Dupe KB Staging Replay (2026-02-10 15:22 UTC)

## Summary
- Staging runtime is now reachable and deployed.
- Retrieval path is callable from staging and returns expected dupes/comparables.
- **Critical blocker**: staging and production currently share the same `DATABASE_URL` (same hash), so staging is not data-isolated.

## 1) Staging readiness
- URL: `https://pivota-agent-staging.up.railway.app`
- HTTP: `200`
- Version:
  - `commit=0704925e2538`
  - `started_at=2026-02-10T15:18:28.025Z`
- Header check:
  - `x-service-commit: 0704925e2538`

## 2) Environment isolation check
- `DATABASE_URL` hash (production): `fc603d428f4ad45ee36b59edf732e2e6b3f92aad38b21f2ee6576cd8c93cdc16`
- `DATABASE_URL` hash (staging): `fc603d428f4ad45ee36b59edf732e2e6b3f92aad38b21f2ee6576cd8c93cdc16`
- Result: `same_database_url=true`

Decision for this replay:
- To avoid contaminating production data, **no staging write-ingest was executed** while DB is shared.
- Read-only retrieval replay was executed instead.

## 3) Retrieval verification (same product path)
Endpoint used (both cases):
- `POST /v1/dupe/suggest`
- Body params: `original_url`, `max_dupes=3`, `max_comparables=2`

### Case A
Request body:
```json
{"original_url":"https://www.skinceuticals.com/skincare/anti-aging-creams/triple-lipid-restore-2-4-2/S09.html","max_dupes":3,"max_comparables":2}
```
Response snippet:
```json
{
  "request_id": "db66923d-98ed-4fe5-a5d4-9dbb0a551c2b",
  "kb_key": "url:https://www.skinceuticals.com/skincare/anti-aging-creams/triple-lipid-restore-2-4-2/S09.html",
  "source": "csv_ingest_staging_full_20260210",
  "dupes_len": 3,
  "comparables_len": 2,
  "dupe0": {
    "brand": "ETUDE",
    "name": "SoonJung 2x Barrier Intensive Cream"
  }
}
```

### Case B
Request body:
```json
{"original_url":"https://www.walmart.com/ip/CARENEL-Lip-Sleeping-Mask-23g-Moisturizing-Lip-Mask-Korean-Lip-Mask/7355223716","max_dupes":3,"max_comparables":2}
```
Response snippet:
```json
{
  "request_id": "b4b177ca-453b-4c09-b447-6f43b7ad9263",
  "kb_key": "url:https://www.walmart.com/ip/CARENEL-Lip-Sleeping-Mask-23g-Moisturizing-Lip-Mask-Korean-Lip-Mask/7355223716",
  "source": "csv_ingest_staging_full_20260210",
  "dupes_len": 2,
  "comparables_len": 1,
  "dupe0": {
    "brand": "Summer Fridays",
    "name": "Lip Butter Balm"
  }
}
```

## 4) Read-only staging smoke (10 random URLs)
Artifact: `reports/dupe_kb_staging_retrieval_smoke_202602101519.json`

- total: `10`
- http_success: `10/10`
- parse_ready arrays: `10/10`
- non_empty: `10/10`
- error_rate: `0.0`
- latency: `p50=429ms`, `p95=754ms`
- source_counts: `csv_ingest_staging_full_20260210: 10`

## 5) Go/No-Go
- Staging runtime callable: **GO**
- Full staging ingest validation (write path): **NO-GO until DB isolation is fixed**

## 6) Required follow-up (before public rollout)
1. Provision separate staging DB and set `DATABASE_URL` in staging to that DB.
2. Redeploy staging.
3. Re-run full write-path replay in staging:
   - 5-row dry-run ingest (staging source tag)
   - full 200-row ingest (staging source tag)
   - 10-row retrieval smoke via `/v1/dupe/suggest`
4. Reconfirm `claims_violation_total` remains zero during validation window.
