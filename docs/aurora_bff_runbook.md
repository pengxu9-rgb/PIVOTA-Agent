# Aurora BFF (pivota-agent) Runbook

This document covers deploying and operating the Aurora BFF/Orchestrator inside `pivota-agent-backend` on Railway.

## What it is

- A stable `/v1/*` API surface for `aurora.pivota.cc` that returns a unified envelope:
  - `assistant_message` + `suggested_chips` + `cards` + `session_patch` + `events`
- Strong server-side gates:
  - **Diagnosis-first (Phase 0)**: blocks recommendations/offers when minimal profile is missing
  - **Recommendations gate**: blocks recommendation/offer/checkout cards unless explicitly triggered
- Long-term memory keyed by `X-Aurora-UID`:
  - `aurora_user_profiles`
  - `aurora_skin_logs`

## Required Railway variables

### Database

- `DATABASE_URL` (Postgres)
- Optional:
  - `DB_AUTO_MIGRATE=true` (default: run migrations on prod boot; set to `false` to disable)
  - `DB_SSL=true` (Railway Postgres often needs SSL)

### Upstreams

- `AURORA_DECISION_BASE_URL` (Aurora decision system base, e.g. `https://...`)
- `PIVOTA_BACKEND_BASE_URL` (pivota-backend base). If unset, the service falls back to `PIVOTA_API_BASE`.
- `PIVOTA_BACKEND_AGENT_API_KEY` (or compatible API key env) for photo upload/download-url bridge when checkout token is absent.

### Skin photo diagnosis knobs

- `AURORA_SKIN_VISION_ENABLED` (`true|false`)
- `AURORA_SKIN_VISION_MODEL`
- `AURORA_SKIN_VISION_TIMEOUT_MS`
- `AURORA_BFF_ANALYSIS_BUDGET_MS` (default `12000`; analysis hard budget; on timeout returns `confidence_notice(reason=timeout_degraded)` with conservative baseline)
- `AURORA_BFF_CHAT_RECO_BUDGET_MS` (default `9000`; reco hard budget; on timeout returns `confidence_notice(reason=timeout_degraded)` without recommendations card)
- `AURORA_PHOTO_UPLOAD_MAX_BYTES`
- `AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS`
- `AURORA_PHOTO_FETCH_TIMEOUT_MS`
- `AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS`
- `AURORA_PHOTO_FETCH_RETRIES`
- `AURORA_PHOTO_FETCH_RETRY_BASE_MS`
- `AURORA_PHOTO_CACHE_MAX_ITEMS`
- `AURORA_PHOTO_CACHE_TTL_MS`

Recommended rollout defaults:
- `staging`: `AURORA_BFF_ANALYSIS_BUDGET_MS=9000`, `AURORA_BFF_CHAT_RECO_BUDGET_MS=7000` (catch long-tail issues earlier)
- `production`: `AURORA_BFF_ANALYSIS_BUDGET_MS=12000`, `AURORA_BFF_CHAT_RECO_BUDGET_MS=9000` (reduce over-degrade risk)

Budget clamp note (intentional):
- `AURORA_BFF_ANALYSIS_BUDGET_MS` and `AURORA_BFF_CHAT_RECO_BUDGET_MS` are clamped to a minimum of `1000ms`.
- Setting either env below `1000` will not tighten budgets further.
- Rationale: avoid over-sensitive tuning and prevent normal traffic from degrading due to short latency jitter.
- Timeout downgrade behavior remains fully validated via fault injection (`timeout`, `ECONNRESET`, invalid payload, empty cards), so safety fallback contracts are still enforced even when clamp prevents ultra-tight budget forcing.

Operational expectation:
- `aurora_skin_analysis_timeout_degraded_rate` and `aurora_skin_reco_timeout_degraded_rate` should be near-baseline in healthy traffic.
- Sustained spikes indicate upstream/network instability or slow-path regressions and should trigger investigation.
Failure-code contract (for `analysis_summary.payload.photo_notice.failure_code`):
- `DOWNLOAD_URL_GENERATE_FAILED`
- `DOWNLOAD_URL_FETCH_4XX`
- `DOWNLOAD_URL_FETCH_5XX`
- `DOWNLOAD_URL_TIMEOUT`
- `DOWNLOAD_URL_EXPIRED`
- `DOWNLOAD_URL_DNS`

### CORS

- `ALLOWED_ORIGINS` or `CORS_ALLOWED_ORIGINS`:
  - Include `https://aurora.pivota.cc`

### Feature flags (do NOT enable in prod unless intended)

- `AURORA_BFF_USE_MOCK=true` → mock Aurora + mock offers resolve (for offline/dev only)
- `AURORA_BFF_INCLUDE_RAW_CONTEXT=true` → includes `aurora_context_raw` card in `/v1/chat`
- `AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED=true` → emit full `conflict_heatmap` payload (otherwise placeholder-only)

## PDP hotset prewarm (Winona/IPSA jitter control)

Use this block to reduce first-screen/backfill jitter on hot PDPs (for example Winona/IPSA).

### Env vars

- `AURORA_BFF_PDP_CORE_PREFETCH_ENABLED` (`true|false`, default `true`)
- `AURORA_BFF_PDP_CORE_PREFETCH_INCLUDE` (default `offers,reviews_preview,similar`)
- `AURORA_BFF_PDP_CORE_PREFETCH_TIMEOUT_MS` (default `1600`)
- `AURORA_BFF_PDP_CORE_PREFETCH_DEDUP_TTL_MS` (default `120000`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED` (`true|false`, default `true`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_INTERVAL_MS` (default `600000`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_INITIAL_DELAY_MS` (default `1000`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_CONCURRENCY` (default `2`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_BOOTSTRAP_ROUNDS` (default `2`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_BOOTSTRAP_GAP_MS` (default `1000`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_JSON` (JSON array of `product_ref`/`subject`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_LIST` (compact list, e.g. `merch_x:pid_a,merch_x:pid_b`)
- `AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY` (enables prewarm ops endpoints)

Default hotset includes:

- `merch_efbc46b4619cfbdf:9886500749640` (Winona)
- `merch_efbc46b4619cfbdf:9886500127048` (IPSA)

### Manual trigger and state check

With `AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY` configured:

```bash
AURORA_BASE_URL='https://pivota-agent-production.up.railway.app' \
AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY='***' \
node scripts/pdp_hotset_prewarm_once.js
```

State-only check:

```bash
AURORA_BASE_URL='https://pivota-agent-production.up.railway.app' \
AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY='***' \
node scripts/pdp_hotset_prewarm_once.js --state-only
```

Direct endpoint check:

```bash
curl -sS "$BASE_URL/v1/ops/pdp-prefetch/state" \
  -H "X-Aurora-Admin-Key: $AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY" | jq .
```

### Fixed regression workflow (warmup 1 + formal 100)

Use this when comparing Winona/IPSA performance without mixing first-hit cold-start noise into steady-state decisions.

```bash
cd pivota-agent-backend
npm run probe:frontend:winona-ipsa:fixed
```

Equivalent explicit command:

```bash
cd pivota-agent-backend
WARMUP_ROUNDS=1 FORMAL_ROUNDS=100 node scripts/run_frontend_live_regression_winona_ipsa.js
```

Output files are written to `pivota-agent-backend/reports/` with name:

- `frontend_live_regression_winona_ipsa_warmup1_formal100_<timestamp>.json`
- `frontend_live_regression_winona_ipsa_warmup1_formal100_<timestamp>.md`

The report includes three summaries:

- `summary_formal`: decision baseline (steady state)
- `summary_warmup`: first-hit cost (cold-start signal)
- `summary_all`: combined trend

### Post-deploy first-visit mitigation checklist

1. Keep `AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED=true`.
2. Keep hotset entries for Winona/IPSA in `AURORA_BFF_PDP_HOTSET_PREWARM_LIST` (or JSON form).
3. After deployment success, run one manual prewarm:

```bash
cd pivota-agent-backend
AURORA_BASE_URL='https://pivota-agent-production.up.railway.app' \
AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY='***' \
node scripts/pdp_hotset_prewarm_once.js
```

4. Then run fixed regression (`warmup1+formal100`) and track:
   - `summary_warmup.est_e2e_first_ms` (first-visit user impact)
   - `summary_formal.est_e2e_p95_ms` (steady-state SLA)
   - `summary_formal.reviews_408_count` / `similar_408_count` (backfill timeout pressure)

### Rollback

If prewarm is suspected to cause load/latency regressions:

1. Set `AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED=false`
2. Set `AURORA_BFF_PDP_CORE_PREFETCH_INCLUDE=offers`
3. Redeploy and re-run the Winona/IPSA live regression probe

## DB migrations

New tables are created by migration:

- `src/db/migrations/012_aurora_bff_memory.sql`

To run manually:

```bash
npm run db:migrate
```

## Rollback

If you need to roll back the Aurora memory tables:

1) Drop tables (data loss):

```sql
DROP TABLE IF EXISTS aurora_skin_logs;
DROP TABLE IF EXISTS aurora_user_profiles;
```

2) Remove migration marker (optional, only if you want the migration to re-run later):

```sql
DELETE FROM schema_migrations WHERE id = '012_aurora_bff_memory.sql';
```

## Smoke checks

### Contract

- OpenAPI: `docs/aurora_bff_openapi.json`
- Card protocol (UI render contract): `docs/aurora_bff_cards.md`
- Telemetry (`/v1/events`): `docs/aurora_bff_telemetry.md`

### Health

- `GET /healthz`
- `GET /healthz/db`

### BFF endpoints

All requests should include at least:

- `X-Aurora-UID: <uuid>`
- (optional) `X-Brief-ID`, `X-Trace-ID`, `X-Lang`

## Chaos soak (pre-prod reliability gate)

### Scripts

- `scripts/smoke_chaos_soak_aurora_skin.sh`
- `tools/validate_envelope.js`
- `scripts/toxiproxy_setup.sh`
- `scripts/toxiproxy_chaos_on.sh`
- `scripts/toxiproxy_chaos_off.sh`

### Hard invariants (auto-stop)

- No empty cards without notice (`cards=[]` + no `confidence_notice` is forbidden)
- Envelope schema must always pass (`tests/contracts/aurora_chat_envelope.schema.json`)
- `confidence_notice` must include recoverable `actions`
- `safety_block` must not emit `recommendations`
- low/medium confidence context must not leak treatment/high-irritation recommendations

Transport handling policy:
- Network/connection failures that produce no response body are classified as `transport_error` (not schema violation).
- `curl rc=35` is retried once (short delay). If still failing, the soak writes a transport placeholder JSON and continues.
- `transport_error` is tracked independently in `summary.json` and `events.ndjson`.

### 2h mini chaos soak (before major changes)

```bash
BASE='https://<preprod-bff>' \
DURATION_HOURS=2 \
BASE_RPS=1 \
CHAOS_RPS=3 \
SPIKE_RPS=20 \
TOXIPROXY_ENABLED=true \
TOXIPROXY_UPSTREAM='<upstream-host:port>' \
scripts/smoke_chaos_soak_aurora_skin.sh
```

Quick local dry-run (5 minutes):

```bash
BASE='https://<preprod-bff>' \
DURATION_SECONDS=300 \
BASE_RPS=1 \
CHAOS_RPS=2 \
SPIKE_RPS=5 \
TOXIPROXY_ENABLED=false \
scripts/smoke_chaos_soak_aurora_skin.sh
```

Default profile:
- hourly 10m chaos window + hourly 30s spike
- CN/EN 50/50
- scenario mix: `use_photo=false+routine` 40%, `photo usable` 30%, `photo forced fail` 20%, `safety red-flag` 10%

### 24h full soak (weekly)

```bash
BASE='https://<preprod-bff>' \
DURATION_HOURS=24 \
BASE_RPS=1 \
CHAOS_RPS=3 \
SPIKE_RPS=20 \
TOXIPROXY_ENABLED=true \
TOXIPROXY_UPSTREAM='<upstream-host:port>' \
scripts/smoke_chaos_soak_aurora_skin.sh
```

### Output & machine-readable summary

Each run writes to:
- `tmp/chaos_soak_run_YYYYMMDD_HHMMSS/summary.json`
- `tmp/chaos_soak_run_YYYYMMDD_HHMMSS/summary.csv`
- `tmp/chaos_soak_run_YYYYMMDD_HHMMSS/events.ndjson`
- `tmp/chaos_soak_run_YYYYMMDD_HHMMSS/failures/` (last 50 failing samples on auto-stop)

### Suggested pre-prod gate thresholds

- `schema_violation_rate == 0` (counted only when `response_received=true`)
- `empty_cards == 0` (counted only when `response_received=true`)
- `notice_without_actions == 0`
- rolling `5xx_rate (5m) <= 0.5%`
- rolling `reco_output_guard_fallback_rate (10m) <= 0.5%`
- `transport_errors <= 3` for 2h mini gate
- rolling `transport_error_rate (5m) <= 0.5%`

Quick check:

```bash
curl -sS -X POST "$BASE_URL/v1/chat" \
  -H 'Content-Type: application/json' \
  -H 'X-Aurora-UID: test_uid' \
  -d '{"message":"Recommend a moisturizer"}' | jq .
```

Expected: diagnosis-first response with chips, and **no** recommendation/offer cards.

## UI telemetry (`/v1/events`)

The Aurora chat frontend can send **UI analytics** events to the BFF:

- Endpoint: `POST /v1/events`
- Response: `204 No Content` on success
- Payload schema: `src/telemetry/schemas/uiEventIngestV0.js`

### Configuration (Railway env vars)

The BFF supports **one** of these sinks (in priority order):

1) PostHog (recommended)
   - `POSTHOG_API_KEY`
   - `POSTHOG_HOST` (or `POSTHOG_URL`)
2) JSONL sink (for debugging)
   - `AURORA_EVENTS_JSONL_SINK_DIR=/tmp/...` (writes `aurora-ui-events-YYYY-MM-DD.jsonl`)
3) Fallback: server logs (no persistence)

### Quick verify (production)

```bash
BASE_URL='https://pivota-agent-production.up.railway.app'

curl -sS -o /dev/null -w 'code=%{http_code}\n' \
  -X POST "$BASE_URL/v1/events" \
  -H 'Content-Type: application/json' \
  --data '{"source":"pivota-aurora-chatbox","events":[{"event_name":"aurora_conflict_heatmap_cell_tap","brief_id":"b","trace_id":"t","timestamp":1700000000000,"data":{"aurora_uid":"uid_test"}}]}'
```

Expected: `code=204`.

## Release gate (recommended)

- Run unit tests: `npm run test:aurora-bff:unit`
- Runtime smoke (hits `BASE`; checks key `/v1/*` flows + `/v1/events` ingest):

```bash
BASE='https://pivota-agent-production.up.railway.app' make runtime-smoke
```

- Reco gate smoke (artifact_missing / low_confidence / medium-high / safety_block):

```bash
BASE='https://pivota-agent-production.up.railway.app' bash scripts/smoke_aurora_skin_reco_gates.sh
```
