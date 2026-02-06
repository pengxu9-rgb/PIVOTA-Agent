# Aurora BFF Card Protocol (UI Render Contract)

This document describes the **stable card types** returned by `pivota-agent` Aurora BFF (`/v1/*`) for `aurora.pivota.cc`.

All endpoints return the same envelope:

- `assistant_message` (nullable)
- `suggested_chips` (array)
- `cards` (array of cards)
- `session_patch` (object)
- `events` (array)

Each card has:

- `card_id` (string)
- `type` (string)
- `payload` (object)
- optional: `field_missing` (array of `{ field, reason }`)

## `field_missing` (hard requirement)

If an upstream (Aurora decision system or pivota-backend) does not provide a needed field, the BFF must:

- set that field to `null` / `unknown` (do not fabricate), and
- add a `field_missing` entry with a machine-readable reason (e.g. `upstream_missing_or_unstructured`).

This allows the UI and data pipeline to distinguish “unknown” vs “not implemented” vs “suppressed by gate”.

## Core cards

### `diagnosis_gate`

Emitted when the user asks for **recommendations** or **fit-check**, but the profile is incomplete (Phase 0 diagnosis-first).

`payload`:
- `reason`: `"diagnosis_first"`
- `missing_fields`: string[] (subset of `skinType|sensitivity|barrierStatus|goals`)
- `wants`: `"recommendation" | "fit_check"`
- `profile`: profile summary (nullable)
- `recent_logs`: recent tracker logs (array)

### `gate_notice`

Emitted when the BFF suppresses recommendation/offer/checkout outputs because the user did not explicitly request them.

`field_missing` contains:
- `{ field: "cards", reason: "recommendations_not_requested" }` and/or
- `{ field: "aurora_structured", reason: "recommendations_not_requested" }`

### `session_bootstrap`

Returned by `GET /v1/session/bootstrap`.

`payload`:
- `profile` (nullable)
- `recent_logs` (array)
- `checkin_due` (boolean)
- `is_returning` (boolean)
- `db_ready` (boolean)

### `profile`

Returned by `POST /v1/profile/update`.

`payload`:
- `profile` (profile summary)

### `routine_simulation`

Returned by `POST /v1/routine/simulate`.

`payload`:
- `safe` (boolean)
- `conflicts` (array of `{ severity, message, rule_id?, step_index?, step_indices? }`)
- `summary` (string)

`conflicts[]` notes:
- `severity`: `"warn" | "block"` (string; upstream may extend)
- `rule_id`: machine-readable rule identifier (optional but preferred)
- `step_index`: optional single step index (legacy; not used by heatmap v1)
- `step_indices`: optional step pair indices (preferred for heatmap v1), e.g. `[1, 2]`

### `conflict_heatmap`

Emitted alongside `routine_simulation` when available (feature-flagged rollout).

`payload` (schema version: `aurora.ui.conflict_heatmap.v1`):
- `schema_version`: `"aurora.ui.conflict_heatmap.v1"` (string; fixed)
- `state`: `"unavailable" | "no_conflicts" | "has_conflicts" | "has_conflicts_partial"`
- `title_i18n`: `{ en, zh }`
- `subtitle_i18n`: `{ en, zh }`
- `axes`:
  - `rows`: `{ axis_id:"steps", type:"routine_steps", max_items:16, items:[AxisItem...] }`
  - `cols`: same as `rows`
  - `diagonal_policy`: `"empty"`
- `severity_scale`:
  - `min`: `0`
  - `max`: `3`
  - `meaning`: `"0 none, 1 low, 2 warn, 3 block"`
  - `labels_i18n`: `{ en: string[], zh: string[] }`
  - `mapping_from_routine_simulation`: `{ warn: 2, block: 3 }`
- `cells`:
  - `encoding`: `"sparse"`
  - `default_severity`: `0`
  - `items`: `HeatmapCell[]`
  - `max_items`: `64`
  - `max_rule_ids_per_cell`: `3`
  - `max_recommendations_per_cell`: `3`
- `unmapped_conflicts`: `UnmappedConflict[]` (max ~10)
- `footer_note_i18n`: `{ en, zh }`
- `generated_from`: `{ routine_simulation_schema_version, routine_simulation_safe, conflict_count }`
- optional: `debug` (default omitted)

Where:

`AxisItem`:
- `index`: number (0-based)
- `step_key`: string (e.g. `"step_0"`)
- `label_i18n`: `{ en, zh }`
- `short_label_i18n`: `{ en, zh }`

`HeatmapCell`:
- `cell_id`: string (e.g. `"cell_1_2"`)
- `row_index`: number
- `col_index`: number
- `severity`: `0..3` (number)
- `rule_ids`: string[] (max ~3)
- `headline_i18n`: `{ en, zh }`
- `why_i18n`: `{ en, zh }`
- `recommendations`: `{ en, zh }[]` (max ~3)

`UnmappedConflict`:
- `rule_id`: string
- `severity`: `0..3` (number)
- `message_i18n`: `{ en, zh }`

## Product intelligence cards (delegated to Aurora)

### `product_parse`

Returned by `POST /v1/product/parse`.

`payload`:
- `product` (object | null)
- `confidence` (number | null)
- `missing_info` (string[])

### `product_analysis`

Returned by `POST /v1/product/analyze`.

`payload`:
- `assessment` (object | null)
- `evidence` (object; normalized; never omitted)
- `confidence` (number | null)
- `missing_info` (string[])

`assessment` highlights:
- `assessment.hero_ingredient` (optional object):
  - `name` (string)
  - `role` (string | null)
  - `why` (string)
  - If Aurora does not return it, the BFF may derive it from `evidence` (do not fabricate; add `missing_info` if needed).

Evidence normalization:
- `evidence.science.{key_ingredients,mechanisms,fit_notes,risk_notes}` are always arrays
- `evidence.social_signals.{typical_positive,typical_negative,risk_for_groups}` are always arrays
- `evidence.expert_notes` is always an array
- optional `evidence.social_signals.platform_scores` is a record of numbers

### `dupe_compare`

Returned by `POST /v1/dupe/compare`.

`payload`:
- `tradeoffs` (string[])
- `evidence` (object; normalized; never omitted)
- `confidence` (number | null)
- `missing_info` (string[])

## Recommendations + commerce cards

### `recommendations`

Returned by:
- `POST /v1/chat` (only when recommendation gate is explicitly unlocked), and/or
- `POST /v1/reco/generate` (explicit recommendations endpoint).

`payload`:
- `recommendations` (array)
- `evidence` (object; normalized; never omitted)
- `confidence` (number | null)
- `missing_info` (string[])

Per-item enrichment (best-effort):
- `recommendations[].alternatives` (optional array; max ~3): `dupe` / `similar` / `premium` options with tradeoffs.
- If enrichment fails or is partial, the BFF uses `field_missing` (e.g. `{ field: "recommendations[].alternatives", reason: "alternatives_partial" }`).

Notes:
- Do not return checkout links unless explicitly requested in the trigger.
- Prefer external outbound/affiliate routes by default.

### `offers_resolved`

Returned by `POST /v1/offers/resolve`.

`payload`:
- `market` (string)
- `items` (array of `{ product, offer }`)

If offer snapshot resolution fails or is not configured, `field_missing` is populated (e.g. `pivota_backend_not_configured`).

### `affiliate_outcome`

Returned by `POST /v1/affiliate/outcome`.

`payload`:
- `outcome`: `"success" | "failed" | "save"`
- optional: `url`, `offer_id`

## Debug cards (optional)

### `aurora_structured`

Optional card emitted by `POST /v1/chat` when the upstream answer contains extractable JSON.

Safety:
- If the JSON contains commerce-like fields (offers/checkout/recommendations) and the user did not explicitly request recommendations, this card is suppressed and replaced by a `gate_notice`.

### `aurora_context_raw`

Optional card emitted by `POST /v1/chat` when `AURORA_BFF_INCLUDE_RAW_CONTEXT=true`.
