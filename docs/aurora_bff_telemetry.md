# Aurora BFF Telemetry (UI analytics)

This document covers **frontend → BFF** UI analytics ingestion and how to use it in PostHog.

## Endpoint

- `POST /v1/events`
- Response: `204 No Content`
- Schema (runtime validation): `src/telemetry/schemas/uiEventIngestV0.js`

## Sinks (server-side)

The BFF supports **one** sink (in priority order):

1) PostHog (recommended)
   - `POSTHOG_API_KEY`
   - `POSTHOG_HOST` (or `POSTHOG_URL`)
2) JSONL sink (debug / ad-hoc)
   - `AURORA_EVENTS_JSONL_SINK_DIR=/tmp/...`
3) Fallback: logs only (no persistence)

## Event conventions

All UI events share a common envelope:

- `event_name`
- `brief_id`
- `trace_id`
- `timestamp` (epoch ms)
- `data` (object; arbitrary)

The Aurora chatbox client attaches base context fields in `data`:

- `aurora_uid` (nullable)
- `session_id` (nullable)
- `lang` (`EN|CN`)
- `state` (string)

## Conflict heatmap events (v1)

Event names:

- `aurora_conflict_heatmap_impression`
- `aurora_conflict_heatmap_cell_tap`

### `aurora_conflict_heatmap_impression`

Recommended `data` fields (current implementation; best-effort):

- `request_id` (BFF request_id; nullable)
- `bff_trace_id` (BFF trace_id; nullable)
- `schema_version` (e.g. `aurora.ui.conflict_heatmap.v1`)
- `heatmap_state` (e.g. `has_conflicts|no_conflicts|unavailable`)
- `trigger_source` (e.g. `chip|action|text_explicit`)
- `num_steps`
- `num_cells_nonzero`
- `num_unmapped_conflicts`
- `max_severity` (0..3)
- `routine_simulation_safe` (bool; nullable)
- `routine_conflict_count` (number; nullable)
- `normalized_conflict_count`

### `aurora_conflict_heatmap_cell_tap`

Recommended `data` fields (current implementation; best-effort):

- `request_id` (BFF request_id; nullable)
- `bff_trace_id` (BFF trace_id; nullable)
- `schema_version`
- `heatmap_state`
- `trigger_source`
- `row_index`, `col_index`
- `severity` (0..3)
- `rule_ids` (string[])
- `step_a`, `step_b` (labels)
- `selected_conflict_id` (nullable)
- `match_quality` (`strict|weak|none`; nullable)
- `num_steps`

## Suggested PostHog dashboards

### 1) Adoption / usage

- **Daily impressions**: count of `aurora_conflict_heatmap_impression`
- Breakdown by:
  - `lang`
  - `heatmap_state`
  - `max_severity`

### 2) Comprehension proxy

- **Cell tap rate**: `cell_tap / impression`
- Segment by `max_severity` (do users click more on Block?)

### 3) Data quality

- % of impressions where `num_unmapped_conflicts > 0`
- % where `num_cells_nonzero == 0` but state suggests conflicts (should be near 0)

## Quick verify (production)

```bash
BASE_URL='https://pivota-agent-production.up.railway.app'

curl -sS -o /dev/null -w 'code=%{http_code}\n' \
  -X POST "$BASE_URL/v1/events" \
  -H 'Content-Type: application/json' \
  --data '{"source":"pivota-aurora-chatbox","events":[{"event_name":"aurora_conflict_heatmap_impression","brief_id":"b","trace_id":"t","timestamp":1700000000000,"data":{"aurora_uid":"uid_test","lang":"EN","state":"S7_PRODUCT_RECO","heatmap_state":"has_conflicts","max_severity":2}}]}'
```

Expected: `code=204`.

