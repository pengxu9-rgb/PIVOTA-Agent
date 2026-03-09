# Aurora BFF Card Protocol (UI Render Contract)

This document describes the **stable card payload types** returned by `pivota-agent` Aurora BFF (`/v1/*`) for `aurora.pivota.cc`.

Contract note:

- `POST /v1/chat` uses **ChatCards Response Schema v1** top-level fields (`version`, `assistant_text`, `cards`, `follow_up_questions`, `suggested_quick_replies`, `ops`, `safety`, `telemetry`, `request_id`, `trace_id`).
- Non-chat endpoints in `/v1/*` may still use the legacy envelope (`assistant_message`, `suggested_chips`, `cards`, `session_patch`, `events`) where documented.

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

### `returning_triage`

Emitted by `POST /v1/chat` when a returning diagnosis user re-enters the diagnosis flow and the BFF can build a prior baseline from stored diagnosis artifacts, profile fields, or recent tracker logs.

`payload`:
- `title`: string
- `tags`: string[]
- `sections`: array with exactly 2 entries:
  - `previous_diagnosis_summary`
  - `returning_action_selection`
- `actions`: array with exactly 4 entries:
  - `chip.action.reassess`
  - `chip.action.update_goals`
  - `chip.action.check_progress`
  - `chip.action.new_photo`

`previous_diagnosis_summary`:
- `kind`: `"previous_diagnosis_summary"`
- `title_en`: string
- `title_zh`: string
- `skin_type`: string | null
- `goals`: string[]
- `primary_concerns`: string[]
- `blueprint_id`: string | null
- `summary_text`: string | null

Contract rules:
- `summary_text` must always be present.
- If the LLM summary path fails or returns unusable output, set `summary_text` to `null` instead of omitting it.
- `summary_text` must not invent photo-based findings when the saved baseline did not use a photo.

`returning_action_selection`:
- `kind`: `"returning_action_selection"`
- `title_en`: string
- `title_zh`: string
- `options`: array of 4 objects, one for each action row

Each option row:
- `id`: `"reassess" | "update_goals" | "check_progress" | "new_photo"`
- `action`: `"navigate_skill" | "trigger_photo"`
- `target_skill_id`: string | null
- `action_id`: string
- `label_en`: string
- `label_zh`: string
- `description_en`: string
- `description_zh`: string

### `skin_progress`

Emitted by `POST /v1/chat` when the user asks to review progress and the BFF can build a baseline from prior diagnosis data or profile-backed fallbacks.

`payload`:
- `title`: string
- `tags`: string[]
- `sections`: array with exactly 4 entries in this order:
  - `progress_baseline`
  - `progress_delta`
  - `progress_highlights`
  - `progress_recommendation`
- `actions`: array with exactly 4 entries:
  - `chip.action.reassess`
  - `chip.start.routine`
  - `chip.action.new_photo`
  - `chip.start.checkin`

`progress_baseline`:
- `kind`: `"progress_baseline"`
- `title_en`: string
- `title_zh`: string
- `skin_type`: string | null
- `primary_concerns`: string[]
- `goals`: string[]
- `blueprint_id`: string | null

`progress_delta`:
- `kind`: `"progress_delta"`
- `title_en`: string
- `title_zh`: string
- `overall_trend`: `"improving" | "stable" | "declining" | "mixed"`
- `concern_deltas`: array of objects:
  - `concern_id`: string
  - `direction`: `"improved" | "stable" | "worsened"`
  - `magnitude`: `"slight" | "moderate" | "significant"`
  - `note_en`: string
  - `note_zh`: string
- `confidence`: number
- `checkins_analyzed`: number

`progress_highlights`:
- `kind`: `"progress_highlights"`
- `improvements`: string[]
- `regressions`: string[]
- `stable`: string[]

`progress_recommendation`:
- `kind`: `"progress_recommendation"`
- `text_en`: string
- `text_zh`: string

Contract rules:
- `concern_deltas` must contain structured objects, not plain strings.
- All 4 section kinds must always be emitted; do not silently drop `progress_highlights` or `progress_recommendation`.
- When no highlight items exist yet, use empty arrays rather than omitting the keys.
- When no photo baseline exists, every text-bearing field in `concern_deltas[*].note_*`, `improvements`, `regressions`, `stable`, `text_en`, and `text_zh` must avoid photo/image/visual claims.

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

### `analysis_summary`

Returned by `POST /v1/analysis/skin`.

`payload`:
- `analysis` (object)
- `low_confidence` (boolean)
- `photos_provided` (boolean): user submitted photo metadata this turn.
- `photo_qc` (array): photo slot QC snapshot.
- `used_photos` (boolean): `true` only when photo bytes were actually consumed by diagnosis/vision stages.
- `analysis_source` (string): may include `retake|rule_based|rule_based_with_photo_qc|diagnosis_v1_template|vision_gemini|vision_openai|vision_openai_fallback|aurora_text|baseline_low_confidence`.
- optional `photo_notice` (object; only when `photos_provided=true` and `used_photos=false`):
  - `failure_code` (string enum): `DOWNLOAD_URL_GENERATE_FAILED|DOWNLOAD_URL_FETCH_4XX|DOWNLOAD_URL_FETCH_5XX|DOWNLOAD_URL_TIMEOUT|DOWNLOAD_URL_EXPIRED|DOWNLOAD_URL_DNS`
  - `message` (string): explicit user-facing fallback notice ("answers/history only; please re-upload").
- `quality_report` (object):
  - `photo_quality` `{ grade, reasons[] }`
  - `detector_confidence` (object)
  - optional `detector_policy` (object)
  - `degraded_mode` (string)
  - `llm` `{ vision, report }`
  - `reasons` (string[])

Failure semantics:
- If photo download fails, `field_missing` includes `{ field: "analysis.used_photos", reason: <failure_code> }`.
- If `photos_provided=true` and `used_photos=false`, response must not imply photo-derived findings.

### `confidence_notice`

Returned by `POST /v1/chat` (reco-gate paths) and `POST /v1/analysis/skin` (degraded analysis path) when the system intentionally downgrades instead of returning normal recommendations.

`payload`:
- `reason` (enum):
  - `artifact_missing`
  - `low_confidence`
  - `safety_block`
  - `timeout_degraded`
- `severity`: `"warn" | "block"`
- `confidence`: `{ score, level, rationale[] }`
- `message` (string)
- `actions` (string[]) - required for every `confidence_notice` reason, including `safety_block`.
- `details` (string[])

Contract rules:
- `reason=safety_block` must not be accompanied by `recommendations` card.
- `reason=low_confidence` must keep recommendation outputs conservative (no high-irritation treatment push).
- Low/medium confidence context may still return recommendations, but any treatment/high-irritation item must be removed before output.
- `reason=timeout_degraded` is a valid business downgrade path (not a transport failure).
- Transport/network failures with no response payload are tracked as `transport_error` in soak tooling and must not be reported as `schema_violation`.

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
- In low/medium confidence context, recommendation items must exclude treatment/high-irritation content.

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
