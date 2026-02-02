# Aurora BFF Service Boundary (pivota-agent)

This document states what **pivota-agent** (Aurora BFF/Orchestrator) is responsible for, vs what must remain upstream.

## pivota-agent (must own)

- **Stable external contract**: all `/v1/*` endpoints return the same envelope:
  - `assistant_message` + `suggested_chips` + `cards` + `session_patch` + `events`
- **Strong gates** (server-side safety net):
  - Phase 0 **Diagnosis-first**: no recommendations/offers before minimal profile
  - **Recommendation gate**: no recommendation/offer/checkout cards unless explicit trigger
- **Identity + memory**:
  - anonymous user key: `X-Aurora-UID`
  - long-term profile + tracker logs in Postgres
- **Schema normalization**:
  - never “pretend to know” missing upstream fields
  - explicitly return `unknown` or `field_missing` reasons
- **Aggregation + fault tolerance**:
  - timeouts, retries, degradations, `request_id`/`trace_id`
- **Observability**:
  - emit `events` with: `request_id`, `trace_id`, `aurora_uid`, `brief_id`, `lang`, `trigger_source`, `state`

## Aurora decision system (must reuse; do NOT rewrite)

All knowledge + reasoning capabilities should be delegated upstream:

- KB/RAG/vector search (products, ingredients, expert notes, social signals)
- product entity parsing (name/link → entity)
- product suitability assessment + evidence
- dupe/competitor generation (tradeoffs + evidence)
- routine reasoning (if unavailable, pivota-agent can temporarily run a simple rule fallback for conflicts only)

### Upstream field requirements (to avoid UI “hollow cards”)

When the BFF calls Aurora, it expects Aurora to return **valid JSON objects** in `answer` for these tasks:

- **Product parse** (`/v1/product/parse`)
  - required keys: `product`, `confidence`, `missing_info`
- **Product analyze** (`/v1/product/analyze`)
  - required keys: `assessment`, `evidence`, `confidence`, `missing_info`
  - `evidence` must include:
    - `science` + `social_signals` + `expert_notes`
    - and optionally `confidence` + `missing_info`
- **Dupe compare** (`/v1/dupe/compare`)
  - required keys: `tradeoffs`, `evidence`, `confidence`, `missing_info`
- **Reco generate** (`/v1/reco/generate`)
  - required keys: `recommendations`, `evidence`, `confidence`, `missing_info`

If Aurora omits any of these (or returns unstructured text), `pivota-agent` must:

- set the affected fields to `null`/`unknown` (do not guess), and
- include `field_missing` reasons on the returned card (e.g. `upstream_missing_or_unstructured`).

## pivota-backend (must reuse)

Commerce/offer/checkout capabilities must come from pivota-backend:

- SKU mapping / product inventory sources
- offers resolution (external outbound preferred)
- internal checkout as optional branch (never the default CTA)
