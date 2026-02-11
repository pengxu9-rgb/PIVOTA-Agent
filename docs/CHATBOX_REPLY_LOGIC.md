# Aurora Chatbox — Reply Logic, Integrations, and Card Triggers

Last updated: 2026-02-10

This doc is a **code-backed scan** of:

- Chatbox “reply” routing logic (backend `/v1/chat` + frontend `BffChat`)
- What products/services are integrated in the chat experience
- Which conditions activate which UI cards (and which are hidden)

It is intended to debug issues like **“I asked for a brand’s products, but chat asks me for skin type again even though it was filled before.”**

---

## 0) Architecture at a glance

**Frontend** (`pivota-aurora-chatbox`)

- Primary entry: `src/pages/BffChat.tsx`
- Sends chat turns to BFF: `POST /v1/chat`
- Also calls feature endpoints for product parse/analyze, dupes, photos, etc.

**Backend (BFF)** (`pivota-agent-backend`)

- Primary chat entry: `src/auroraBff/routes.js:9938` (`POST /v1/chat`)
- Upstream LLM/decision system: `auroraChat()` → `AURORA_DECISION_BASE_URL`
  - Prefix injection: `src/auroraBff/auroraDecisionClient.js:48` (`buildContextPrefix`)

---

## 1) Backend `/v1/chat` reply pipeline (high-level)

Source: `pivota-agent-backend/src/auroraBff/routes.js:9938`

### 1.1 Request context + trigger source

- `ctx = buildRequestContext(req, body)` determines:
  - `lang` (`EN|CN`)
  - `trigger_source` (`text|text_explicit|chip|action`)
  - `state` (client session state)
- Trigger-source inference is **conservative** for free text:
  - `detectTextExplicit()` uses a small allowlist (e.g. “推荐/诊断/适合吗/冲突”).
  - Example: “有没有薇诺娜的产品” typically stays `trigger_source="text"`.
- Source: `pivota-agent-backend/src/auroraBff/requestContext.js:39`

### 1.2 Memory context (profile + recent logs)

Best-effort load:

- `profile = getProfileForIdentity(...)`
- `recentLogs = getRecentSkinLogsForIdentity(..., 7)`
- If DB read fails, BFF continues (warn only).

Additional best-effort injection:

- If client sends a profile snapshot under `body.session.profile`, BFF merges it into `profile` so upstream can still see known fields.
- Source: `extractProfilePatchFromSession()` in `pivota-agent-backend/src/auroraBff/routes.js:3183`
- Used in `/v1/chat`: `routes.js:9969` area

### 1.3 Inline profile patching (chips/actions)

If the user clicks clarification chips, BFF attempts to:

- infer a `profile_patch` from the action id / `clarification_id`
- apply it inline for gating
- persist to DB best-effort

Source:

- `parseProfilePatchFromAction()` / `inferProfilePatchFromClarification()` / `normalizeClarificationField()`
  - `pivota-agent-backend/src/auroraBff/routes.js:3095`

Important caveat:

- `normalizeClarificationField()` is now **Unicode-aware** and **never returns an empty string**.
  - It preserves `_` and `:` namespaces, replaces other separators with `_`, and falls back to a stable hash (`cid_<sha1_base36>`) if needed.
  - When hash fallback is used, it increments `clarification_id_normalized_empty_total`.
  - Source: `pivota-agent-backend/src/auroraBff/routes.js:3352`

### 1.4 State machine + recommendation gating

`/v1/chat` supports a state machine. State changes are allowed only for:

- `trigger_source in {chip, action, text_explicit}`
- Free text that is not `text_explicit` cannot legally request state transitions.

Source: `pivota-agent-backend/src/auroraBff/gating.js:170` (`stateChangeAllowed`)

**Recommendation interactions are gated**:

- `recommendationsAllowed()` is strict by design:
  - chips/actions: allowlisted ids (e.g. `chip.start.reco_products`, `chip_get_recos`, etc.)
  - free text: only when `trigger_source === text_explicit` AND looks like a recommendation/fit-check
- Source: `pivota-agent-backend/src/auroraBff/gating.js:86`

### 1.5 Local short-circuits (no upstream call)

`/v1/chat` answers some intents deterministically:

- **Brand availability / catalog lookup** → `product_parse` + `offers_resolved`
  - Condition: query matches a known brand alias and looks like “有没有/有货/哪里买/available/in stock…”
  - Feature flag: `AURORA_CHAT_CATALOG_AVAIL_FAST_PATH` (default `true`)
  - Metrics:
    - `catalog_availability_shortcircuit_total{brand_id,reason}`
    - `upstream_call_total{path="aurora_chat"}` should stay unchanged for these turns

- **Weather / environment** → `env_stress` card
  - Condition: env intent AND `trigger_source in {text, text_explicit}`
- **Compatibility / conflict** → `routine_simulation` + `conflict_heatmap`
  - Condition: compatibility intent AND `trigger_source in {text, text_explicit, chip, action}`
- **Routine generation** → `recommendations` card (routine plan)
  - Condition: explicit reco flow + routine intent
- **Product recommendations** → `recommendations` card (catalog-grounded)
  - Condition: explicit reco flow + reco intent
  - Has “diagnosis-first” gate when profile completeness `< 3` → `diagnosis_gate`

All of these are in `pivota-agent-backend/src/auroraBff/routes.js:10150+` and `routes.js:10420+`.

### 1.6 Upstream call + derived cards

If no local short-circuit triggers:

- BFF builds a text prefix with `profile`, `recent_logs`, and `meta`
- calls `auroraChat({ allow_recommendations: allowRecoCards, ... })`
- clarification payload key is `clarification` (not `clarification_request`); when present, BFF turns the first remaining valid question into `suggested_chips`
- strips recommendation cards when not allowed
- derives additional cards from upstream `context`:
  - `env_stress` (from context or local fallback)
  - `routine_simulation` / `conflict_heatmap` (from `context.conflict_detector`)
  - `product_analysis` (from `context.anchor_product`)
- handles `aurora_structured` (“references”) card:
  - UI hides it if `external_verification.citations` is empty

Source: `pivota-agent-backend/src/auroraBff/routes.js:10860+` and `routes.js:11000+`.

### 1.7 Clarification Flow V2 session state (`pending_clarification`)

When `AURORA_CHAT_CLARIFICATION_FLOW_V2=true` and upstream returns multiple clarification questions, BFF stores
`session_patch.state.pending_clarification` in canonical v1 shape:

```json
{
  "v": 1,
  "flow_id": "pc_ab12cd34ef56",
  "created_at_ms": 1739232000000,
  "resume_user_text": "original user message (truncated to <=800 chars)",
  "resume_user_hash": "optional hash",
  "step_index": 0,
  "current": { "id": "skin_type", "norm_id": "skinType" },
  "queue": [
    {
      "id": "goals",
      "norm_id": "goals",
      "question": "What is your top goal now?",
      "options": ["Acne control", "Barrier repair", "Brightening"]
    }
  ],
  "history": []
}
```

Notes:

- BFF still accepts legacy pending state (no `v/flow_id/step_index/norm_id`) and upgrades it in-place on next turn.
- Payload is bounded to control cost and drift:
  - `resume_user_text<=800`, `queue<=5`, `question<=200`, `options<=8`, `option<=80`, `history<=6`.
- On final resume upstream call, BFF can inject a bounded resume prefix:
  - V1: `AURORA_CHAT_RESUME_PREFIX_V1=true` (default)
  - V2 authoritative template: `AURORA_CHAT_RESUME_PREFIX_V2=true` (default `false`)
    - includes original request, answered clarifications, and known profile fields (`skinType/sensitivity/barrierStatus/goals/budgetTier`)
    - explicit instruction: do not restart intake; ask at most one new non-duplicate question if strictly necessary.
- Resume-only probe metrics (detection only, no output rewriting):
  - enable/disable: `AURORA_CHAT_RESUME_PROBE_METRICS` (default `true`)
  - metrics: `resume_response_mode_total{mode}`, `resume_plaintext_reask_detected_total{field}`.

---

## 2) “Why did it ask skin type again?” (observed failure modes)

This class of UX issue can come from multiple layers:

### 2.1 Intent mismatch: brand availability vs “recommendation intake”

- Text like “有没有某品牌的产品” usually contains “产品” and matches `looksLikeRecommendationRequest()`
  - Source: `pivota-agent-backend/src/auroraBff/gating.js:16`
- But it usually does **not** match `detectTextExplicit()` allowlist
  - `trigger_source="text"` (not `text_explicit`)
  - Source: `pivota-agent-backend/src/auroraBff/requestContext.js:21`
- Result (previous behavior, still possible if fast-path disabled or brand not recognized):
  - `allow_recommendations=false` on the upstream call
  - BFF will not run deterministic reco/product-search paths
  - Upstream may reply with a generic “safe intake” (skin type / barrier / goals), even if the user asked for *availability*.

Mitigation (current behavior, when enabled):

- `/v1/chat` runs a deterministic **brand availability fast-path** before calling upstream.
- This prevents misrouting “有没有薇诺娜的产品/Winona 有货吗/哪里买” into diagnosis intake and avoids an `auroraChat()` call.

### 2.2 Profile context missing or stale

Even if the user filled `skinType` before, upstream may not see it when:

- DB read failed and client didn’t send `session.profile`
- client `bootstrapInfo.profile` is null/stale (e.g. bootstrap didn’t run or local state got reset)
- profile updates happened in a different identity/session

Frontend behavior:

- `applyEnvelope()` updates a local `profileSnapshot` whenever `env.session_patch.profile` is present (even if bootstrap was missing).
- `sendChat()` includes `session.profile` whenever `profileSnapshot` (or bootstrap profile) exists, via `buildChatSession()`.
  - Sources:
    - `pivota-aurora-chatbox/src/pages/BffChat.tsx:2918`
    - `pivota-aurora-chatbox/src/pages/BffChat.tsx:3618`
    - `pivota-aurora-chatbox/src/lib/chatSession.ts`

### 2.3 Clarification→profile patch mapping fails (localized ids)

- This is now largely mitigated:
  - `normalizeClarificationField()` no longer returns empty for non-ASCII ids.
  - When it needs to hash-fallback, `clarification_id_normalized_empty_total` increments (so we can detect upstream schema drift).
- Remaining possible failure mode:
  - Upstream emits an id that doesn’t map to canonical fields AND the option text is ambiguous → patch inference may still return null.
  - Source: `pivota-agent-backend/src/auroraBff/routes.js:3400`

---

## 3) What’s integrated in the Chatbox experience

### 3.1 Frontend → BFF endpoints used (chatbox client)

Source: `pivota-aurora-chatbox/src/pages/BffChat.tsx`

- Session/memory: `GET /v1/session/bootstrap`
- Chat: `POST /v1/chat`
- Profile: `POST /v1/profile/update`
- Tracker log: `POST /v1/tracker/log`
- Photos: `POST /v1/photos/upload`, `POST /v1/analysis/skin`
- Product tools: `POST /v1/product/parse`, `POST /v1/product/analyze`
- Dupes: `POST /v1/dupe/suggest`, `POST /v1/dupe/compare`
- Offers/commerce: `POST /v1/affiliate/outcome`, `POST /agent/shop/v1/invoke`, `POST /agent/v1/products/resolve`
- Auth: `/v1/auth/*`

### 3.2 Backend external services (key ones)

Source: `pivota-agent-backend/src/auroraBff/*`

- Upstream chat/decision system: `AURORA_DECISION_BASE_URL`
  - call path: `auroraChat()` → `auroraDecisionClient.js`
- Pivota backend (catalog + offers resolution; used by reco/offer flows):
  - Product search/resolve: `PIVOTA_BACKEND_BASE_URL/agent/v1/products/*`
  - External offers resolve: `PIVOTA_BACKEND_BASE_URL/api/offers/external/resolve`

---

## 4) Card trigger matrix (backend emit → frontend render)

### 4.1 UI hidden-by-default cards

Frontend hides these unless `debug=true`:

- `gate_notice`
- `budget_gate`
- `session_bootstrap`

Source: `pivota-aurora-chatbox/src/pages/BffChat.tsx:1977`

### 4.2 UI renderable cards (chatbox)

Below is the practical matrix for “what the user actually sees”:

| Card type | Where rendered | How it activates (summary) |
| --- | --- | --- |
| `aurora_structured` | References card | Backend only emits when upstream returns structured; UI hides if citations empty (`external_verification.citations.length == 0`). Backend also blocks it when `allow_recommendations=false` and structured looks commerce-like. |
| `env_stress` | EnvStressCard | Local short-circuit for weather/env; or derived from upstream `context.env_stress`; may be suppressed if not requested. |
| `routine_simulation` | Inline routine simulation view | Local conflict simulation; or derived from upstream `context.conflict_detector`. |
| `conflict_heatmap` | ConflictHeatmapCard | Usually paired with `routine_simulation`; emitted locally or derived from upstream context. |
| `diagnosis_gate` | Intake card | BFF emits when explicit diagnosis/reco flow needs missing core profile fields. |
| `profile` | Profile summary card | Emitted after successful profile chip patch in chat (without calling upstream). |
| `recommendations` | RecommendationsCard | Deterministic routine/product reco in `/v1/chat` (explicit flow) OR upstream returns it while allowed. UI also filters it unless agent state is `RECO_*`. |
| `product_parse` | Product parse card | From `POST /v1/product/parse`, **or** from `/v1/chat` brand-availability fast-path (`intent=availability`). |
| `product_analysis` | Product analysis card | Derived from upstream `context.anchor_product` in `/v1/chat`, or from `POST /v1/product/analyze`. |
| `dupe_suggest` / `dupe_compare` | Dupe cards | From `POST /v1/dupe/*`. |
| `offers_resolved` | Offer list + outbound buttons | From offer resolution flows (usually as part of recommendations/product analysis), **or** from `/v1/chat` brand-availability fast-path (items may have `offer=null`). |
| `photo_confirm` | Photo confirmation card | From photo upload/confirm flow. |
| `photo_modules_v1` | Photo modules UI | Emitted by diagnosis pipeline; gated by frontend `FF_PHOTO_MODULES_CARD`. |
| `analysis_summary` | Analysis summary card | Emitted by diagnosis pipeline; suppresses chips in UI. |

Key sources:

- UI rendering + hiding: `pivota-aurora-chatbox/src/pages/BffChat.tsx:1977`
- UI reco filtering: `pivota-aurora-chatbox/src/lib/recoGate.ts:4`
- Backend `/v1/chat` emit/derive: `pivota-agent-backend/src/auroraBff/routes.js:9938`

---

## 5) Practical debugging checklist for “重复问 skin type”

1) Confirm frontend sent profile snapshot:
   - request body includes `session.profile` (from `profileSnapshot` or `bootstrapInfo.profile`)
   - Source: `pivota-aurora-chatbox/src/pages/BffChat.tsx:3618`
2) Confirm backend merged it:
   - `extractProfilePatchFromSession(parsed.data.session)` applied
   - Source: `pivota-agent-backend/src/auroraBff/routes.js:3183` and `routes.js:9969`
3) Confirm upstream prefix includes profile:
   - can use `CHAT_PROFILE_PREFIX_ECHO_TEST` mock pathway if enabled
   - Source: `pivota-agent-backend/src/auroraBff/auroraDecisionClient.js:71`
4) If question came from clarification chips, verify `clarification_id` normalization:
   - ensure it maps to `skinType|sensitivity|barrierStatus|goals|budgetTier`
   - Source: `pivota-agent-backend/src/auroraBff/routes.js:3352`
5) For brand availability queries, confirm fast-path hit:
   - response contains `product_parse(intent=availability)` + `offers_resolved`
   - `catalog_availability_shortcircuit_total` increments

---

## 6) Fixes applied (for the recurring UX issue)

1) Brand availability / catalog-search fast-path in `/v1/chat`:
   - Feature flag: `AURORA_CHAT_CATALOG_AVAIL_FAST_PATH`
   - Emits `product_parse` + `offers_resolved`, no diagnosis intake, and avoids `auroraChat()`.
2) Clarification id normalization is Unicode-safe and never-empty:
   - Hash fallback emits `clarification_id_normalized_empty_total`.
3) Session/profile snapshot syncing improved:
   - FE sends `session.profile` when available (`profileSnapshot` or bootstrap).
   - BFF merges it and more frequently echoes `env.session_patch.profile` to keep the client snapshot stable.
