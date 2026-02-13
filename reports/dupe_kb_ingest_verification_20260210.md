# Aurora KB CSV Ingest + Retrieval Verification Report (2026-02-10)

## Scope
- Input CSV: `/Users/pengchydan/Desktop/aurora_kb_ingest_targets200_BIDIRECTIONAL_TOP3TOP2_PLAINJSON_QUOTEALL_TINY.csv`
- Goal: ingest and verify dupes/comparables KB retrievable through Aurora product retrieval path.

---

## A) Ingestion mechanism discovery

### Retrieval path used by system
- Endpoint: `POST /v1/dupe/suggest`
- Code path:
  - `src/auroraBff/routes.js` (route handler)
  - `getDupeKbEntry(...)` / `upsertDupeKbEntry(...)` from `src/auroraBff/dupeKbStore.js`

### Destination storage
- Primary table: `aurora_dupe_kb`
- Migration: `src/db/migrations/018_aurora_dupe_kb.sql`
- Columns:
  - `kb_key` (PK)
  - `original` JSONB
  - `dupes` JSONB
  - `comparables` JSONB
  - `verified` boolean
  - `verified_at` timestamptz
  - `verified_by` text
  - `source` text
  - `source_meta` JSONB
  - timestamps
- Fallback storage (when DB unavailable): JSONL file via `AURORA_DUPE_KB_PATH` (default `data/dupe_kb.jsonl`).

---

## B) Pre-ingest validation (local)

### Validation result: **PASS**
- Row count: `200`
- Header order exact match: `PASS`
- `dupes_json` parse: `200/200 PASS`
- `comparables_json` parse: `200/200 PASS`
- `evidence.expert_notes` includes `Sources:` (string or string-list): `PASS`
- Optional cap checks:
  - `len(dupes) <= 3`: `PASS`
  - `len(comparables) <= 2`: `PASS`

Rejected rows: `0`

---

## C) Staging dry-run ingest (5 rows)

### Remote staging environment
- Checked host `https://pivota-agent-staging.up.railway.app/healthz`
- Response: `404 Application not found`
- Railway project environment listing showed production only.

### Executed isolated staging namespace (same codepath, local instance)
- Staging file: `tmp/aurora_dupe_kb_staging_dryrun_5.jsonl`
- Record count: `5`
- JSON integrity:
  - `dupes` and `comparables` stored as arrays
  - No truncation/parse errors observed

---

## D) Retrieval verification (must be system path)

### Retrieval method
- Used **same product endpoint**: `POST /v1/dupe/suggest`
- Headers: `X-Aurora-UID: kb_ingest_verify_uid`
- Request body shape: `{ original_url, max_dupes, max_comparables }`

### Verification query #1
Request:
```json
{"original_url":"https://www.dermstore.com/p/skinceuticals-c-e-ferulic-with-15-l-ascorbic-acid-vitamin-c-serum-30ml/11289609/","max_dupes":3,"max_comparables":2}
```
Response snippet:
```json
{
  "kb_key": "url:https://www.dermstore.com/p/skinceuticals-c-e-ferulic-with-15-l-ascorbic-acid-vitamin-c-serum-30ml/11289609/",
  "source": "csv_ingest_dryrun",
  "meta": { "served_from_kb": true },
  "dupes_len": 3,
  "comparables_len": 2,
  "dupe0_product": { "brand": "TruSkin", "name": "Vitamin C Facial Serum", "url": "https://www.target.com/p/truskin-vitamin-c-facial-serum-1oz/-/A-82247602" }
}
```

### Verification query #2
Request:
```json
{"original_url":"https://www.drbrennershop.com/products/vitamin-c-serum","max_dupes":3,"max_comparables":2}
```
Response snippet:
```json
{
  "kb_key": "url:https://www.drbrennershop.com/products/vitamin-c-serum",
  "source": "csv_ingest_dryrun",
  "meta": { "served_from_kb": true },
  "dupes_len": 3,
  "comparables_len": 2,
  "dupe0_product": { "brand": "Prequel", "name": "Lucent-C Brightening Vitamin C Serum", "url": "https://prequelskin.com/products/lucent-c-vitamin-c-serum" }
}
```

Evidence of ingest namespace/index usage:
- `meta.served_from_kb = true`
- `source = csv_ingest_dryrun`
- `kb_key` matches ingested `url:<target_url>` keys

---

## E) Full ingest in staging (200 rows)

### Executed isolated staging namespace (local)
- Ingest output: `tmp/aurora_dupe_kb_staging_full_200.jsonl`
- Records ingested: `200`
- Rejected rows: `0`

### 10-target smoke test
- Result summary:
  - Total queries: `10`
  - HTTP success: `10/10`
  - JSON parse success: `10/10`
  - Served from KB: `10/10`
  - Non-empty results: `10/10`
  - Error rate: `0.0`
  - Latency: `p50=10ms`, `p95=11ms`
- Smoke artifact: `tmp/dupe_kb_full_smoke_10.json`

---

## Schema mapping (CSV -> storage)

| CSV column | Mapping target |
| --- | --- |
| `target_brand` | `original.brand` |
| `target_name` | `original.name` |
| `target_url` | `original.url` and key material for `kb_key = "url:<target_url>"` |
| `target_price_usd` | `original.price_usd` (float/null) |
| `category` | `original.category` |
| `sources` | `original.sources` |
| `missing_info` | `original.missing_info` |
| `dupes_json` | `dupes` (JSON array / JSONB) |
| `comparables_json` | `comparables` (JSON array / JSONB) |
| `source_meta_json` | `source_meta` (JSON object / JSONB), plus ingest metadata |

Auxiliary ingest fields set:
- `verified=true`
- `verified_at` fixed ingest timestamp
- `verified_by=csv_ingest_*`
- `source=csv_ingest_*`

---

## Risks / follow-ups

1) **Primary blocker**: remote staging environment not currently callable (`pivota-agent-staging.up.railway.app` returns 404 app-not-found).
2) Remote DB write to actual staging table not performed yet because staging runtime is unavailable.
3) JSON support fallback (if JSON/JSONB unsupported):
   - Keep anchor products in `targets` table (`target_key`, `brand`, `name`, `url`, ...)
   - Explode `dupes_json` / `comparables_json` into `target_relationships` table:
     - `anchor_key`, `candidate_key`, `kind`, `rank`, `similarity`, `confidence`, `evidence`, `source`, `source_meta`, timestamps
   - Keep candidate payload normalized in `candidates` table.

---

## Recommendation

### Current decision: **FIX BLOCKER BEFORE PROD WRITE**
- Retrieval path and data shape are validated end-to-end with isolated staging namespace and system endpoint.
- Before production ingest, restore real staging environment and repeat DB-backed run:
  1) ingest 5 rows to staging DB
  2) verify `/v1/dupe/suggest` on staging host for 2+ targets
  3) ingest full 200 and run 10-target smoke
- If urgent and staging remains unavailable, production write is technically feasible but should require explicit approval and rollback plan.

