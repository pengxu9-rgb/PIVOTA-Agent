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

### CORS

- `ALLOWED_ORIGINS` or `CORS_ALLOWED_ORIGINS`:
  - Include `https://aurora.pivota.cc`

### Feature flags (do NOT enable in prod unless intended)

- `AURORA_BFF_USE_MOCK=true` → mock Aurora + mock offers resolve (for offline/dev only)
- `AURORA_BFF_INCLUDE_RAW_CONTEXT=true` → includes `aurora_context_raw` card in `/v1/chat`
- `AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED=true` → emit full `conflict_heatmap` payload (otherwise placeholder-only)

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

### Health

- `GET /healthz`
- `GET /healthz/db`

### BFF endpoints

All requests should include at least:

- `X-Aurora-UID: <uuid>`
- (optional) `X-Brief-ID`, `X-Trace-ID`, `X-Lang`

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
- Runtime smoke (hits `BASE` and includes `/v1/events` ingest check):

```bash
BASE='https://pivota-agent-production.up.railway.app' make runtime-smoke
```
