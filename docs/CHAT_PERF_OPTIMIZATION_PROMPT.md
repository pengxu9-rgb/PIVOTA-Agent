# Aurora Chatbox — Multi‑LLM Optimization Prompt (Performance + Routing + UX)

Last updated: 2026-02-10

Copy/paste this prompt into *multiple LLMs* to get independent, system-level proposals for improving Aurora chatbox reply correctness and performance.

---

## Role

You are a senior full‑stack + LLM product engineer (pragmatic, shipping‑oriented).

Your job: propose **minimal‑risk, reversible** changes in an existing codebase to improve chat UX + stability + latency.

---

## System Context (facts)

### Architecture

- Frontend: `pivota-aurora-chatbox`
  - Main page: `src/pages/BffChat.tsx`
  - Every chat turn hits BFF: `POST /v1/chat`
  - Client sends `session={ state, profile }` when it has a local snapshot.
- Backend (BFF): `pivota-agent-backend`
  - Chat entry: `src/auroraBff/routes.js` (`POST /v1/chat`)
  - Upstream LLM: `auroraChat()` in `src/auroraBff/auroraDecisionClient.js`
  - Profile + logs come from `src/auroraBff/memoryStore.js`

### Gating

- `trigger_source` inference is conservative: `src/auroraBff/requestContext.js`
- Recommendations are strict for compliance:
  - `recommendationsAllowed()` / `recommendationsAllowed()` → `src/auroraBff/gating.js`
  - Free text generally does **not** unlock commerce/reco paths unless explicitly allowlisted (`text_explicit`).

### Cards that matter (chatbox)

- Renderable & useful:
  - `product_parse`, `offers_resolved`, `product_analysis`
  - `diagnosis_gate`, `profile`
  - `env_stress`, `routine_simulation`, `conflict_heatmap`
- Often hidden / filtered:
  - `aurora_structured` hidden when citations empty
  - recommendations are filtered by agent state (`src/lib/recoGate.ts`)
  - `gate_notice|budget_gate|session_bootstrap` hidden unless debug

More detail: `pivota-agent-backend/docs/CHATBOX_REPLY_LOGIC.md`

---

## Current Fixes Already Implemented (treat as baseline)

1) **Unicode-safe clarification id normalization** (reduces lost profile patch → repeated questions)
- `normalizeClarificationField()` never returns empty; preserves `_` `:`; hash fallback `cid_<sha1_base36>`
- Metric: `clarification_id_normalized_empty_total`
- Location: `pivota-agent-backend/src/auroraBff/routes.js`

2) **Brand availability fast-path** (prevents “brand availability” from misrouting into diagnosis intake; avoids upstream)
- Detect “有没有某品牌的产品 / 有货吗 / 哪里买 / available / in stock …”
- Returns `product_parse(intent=availability)` + `offers_resolved`
- Feature flag: `AURORA_CHAT_CATALOG_AVAIL_FAST_PATH` (default `true`)
- Metric: `catalog_availability_shortcircuit_total{brand_id,reason}`
- Location: `pivota-agent-backend/src/auroraBff/routes.js`

3) **Session/profile snapshot sync hardened**
- FE sends `session.profile` when local snapshot exists (not only after bootstrap)
- BFF merges `session.profile` into server profile; more frequently echoes `env.session_patch.profile`
- Metrics:
  - `profile_context_missing_total{side=frontend|backend}`
  - `session_patch_profile_emitted_total{changed=true|false}`
- Locations:
  - FE: `pivota-aurora-chatbox/src/pages/BffChat.tsx`
  - FE helper: `pivota-aurora-chatbox/src/lib/chatSession.ts`
  - BFF: `pivota-agent-backend/src/auroraBff/routes.js`

4) **Repeated-clarification observability**
- Metric: `repeated_clarify_field_total{field}`
- Trigger: upstream asks for already-known profile fields (skinType/sensitivity/barrierStatus/goals/budgetTier)

---

## The Remaining Problems to Solve

### P0 — Repeated questions for already-known profile fields

Even with correct snapshot syncing, upstream may still ask (prompt drift / safety templates / imperfect prefix).

Goal: **< 1%** repeated asks for `skinType` in sessions where `skinType` is known.

### P1 — More deterministic routing for commerce intents (without widening compliance risk)

Brand availability is fixed, but other commerce-like intents can still misroute:

- “有没有 X 的产品 / 旗舰店 / 哪里买 / 价格多少 / 链接”
- “这个产品有没有 / 有什么替代 / 适合吗” (mixed intent)

Goal: handle common commerce intents with **safe, deterministic** paths that do NOT require diagnosis intake.

### P2 — Reduce `auroraChat()` usage and tail latency

Goal: reduce upstream calls for intents we can answer locally and reduce upstream prompt size/latency for those we can’t.

Constraints:
- Don’t “unlock all free text → reco” (compliance risk).
- Prefer fast-paths with restricted answer scope.
- Add metrics + rollback switches.

---

## Your Task (what to produce)

Propose a **systematic plan** to improve correctness + stability + performance, with:

1) **Hypotheses**
   - Enumerate likely root causes for repeated profile asks and misrouting (even after current fixes).
2) **Concrete proposals**
   - Backend: deterministic intent detection, fast-path expansions, caching, prefix shaping, post-processing guardrails.
   - Frontend: payload consistency, state sync edge cases, UI fallbacks (keep minimal).
   - Prompt/prefix: known_data/missing_data schema, negative constraints (“do not ask known fields”), size reduction.
3) **Implementation details**
   - Exact file paths and functions to touch.
   - Feature flags for anything risky.
   - Proposed metrics to confirm impact.
4) **Tests**
   - Unit/integration tests you’d add/update to lock the behavior.
5) **Rollback plan**
   - How to disable quickly if metrics regress.

---

## Guardrails (must follow)

- Do NOT expand free-text reco eligibility broadly.
- Commerce fast-paths:
  - Must not produce medical diagnosis / treatment / “cure” claims.
  - Must not recommend “ghost products” (only show catalog‑grounded items or say “no results”).
  - If response text contains medical blacklist words, BFF must downgrade to a safe message.
- Keep changes minimal and reversible.

---

## Output Format (strict)

Return:

1) `Summary` (5–10 lines)
2) `Proposals` (bullet list; each item includes: scope, risk, rollback flag, metrics)
3) `Code Touchpoints` (file path + function names)
4) `Test Plan` (unit + integration)
5) `Metrics` (new/updated; with labels)
6) `Open Questions` (only if truly blocking)

