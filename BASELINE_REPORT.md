# Skin Diagnosis Baseline (Repo Health + Profiling)

Generated: 2026-02-05  
Scope: `pivota-agent-backend` Aurora BFF skin diagnosis (`/v1/analysis/skin`)  
Goal: establish a **reproducible** performance + quality baseline **without changing public API contracts**.

## 1) Code Map (auto scan results)

### Main entry (route/controller)
- Route mount: `src/server.js` (calls `mountAuroraBffRoutes`)
- Analyze entry: `src/auroraBff/routes.js` → `POST /v1/analysis/skin`

### Skin / diagnosis related modules
- Skin analysis route + rule-based fallback: `src/auroraBff/routes.js`
  - `buildRuleBasedSkinAnalysis(...)`
  - `buildLowConfidenceBaselineSkinAnalysis(...)`
  - `normalizeSkinAnalysisFromLLM(...)`
  - `runOpenAIVisionSkinAnalysis(...)` (optional)
- LLM call policy (when to call vs skip, and how to degrade confidence):
  - `src/auroraBff/skinLlmPolicy.js` (`should_call_llm`, `classifyPhotoQuality`, `downgradeSkinAnalysisConfidence`)
- Diagnosis gating (when to enter diagnosis flow / what to ask next):
  - `src/auroraBff/gating.js` (`looksLikeDiagnosisStart`, `shouldDiagnosisGate`, etc.)
- Routine conflict simulation (feeds conflict cards/heatmap):
  - `src/auroraBff/routineRules.js` (`simulateConflicts`)
  - UI placeholder card currently emitted in chat flow: `src/auroraBff/routes.js` (`type: 'conflict_heatmap'`)
- Environment stress (UI radar payload mapping):
  - Decision client context mapping: `src/auroraBff/auroraDecisionClient.js`
  - UI mapping + card emission: `src/auroraBff/routes.js` (`type: 'env_stress'`)

### Current LLM call points
- OpenAI (Vision JSON): `src/auroraBff/routes.js` → `runOpenAIVisionSkinAnalysis()` → `client.chat.completions.create(...)`
- Aurora decision upstream (typically Gemini behind it):
  - `src/auroraBff/auroraDecisionClient.js` → `auroraChat()` (axios POST `${AURORA_DECISION_BASE_URL}/api/chat`)
- Shared LLM provider abstraction (used elsewhere; not the skin route today):
  - `src/llm/provider.ts` / `src/llm/provider.js` (Gemini/OpenAI)

### Output schema definition locations
- Request schema (Zod): `src/auroraBff/schemas.js` → `SkinAnalysisRequestSchema`
- Response envelope schema (Zod): `src/auroraBff/schemas.js` → `V1ResponseEnvelopeSchema`
- Card payload typing: `src/auroraBff/schemas.js` → `CardSchema.payload` is `record<string, any>` (skin analysis card payload is shaped in `src/auroraBff/routes.js` under `type: 'analysis_summary'`).

## 2) Profiling instrumentation (minimal-intrusion)

Added stage profiler with **safe structured logging** (no image bytes, no prompt content, no face landmarks).

- Profiler module: `src/auroraBff/skinAnalysisProfiling.js`
- Integrated into:
  - `src/auroraBff/routes.js` (`POST /v1/analysis/skin`)
  - `src/auroraBff/routes.js` (`runOpenAIVisionSkinAnalysis`)

Stages (contracted):
- `decode, face, skin_roi, quality, detector, postprocess, llm, render`

Notes:
- `face` is currently **not implemented** (tracked as `skipped:not_implemented`).
- `skin_roi` is implemented in `src/auroraBff/skinDiagnosisV1.js` (YCrCb connected components) and is only executed when photo-based diagnosis runs.
- Logs emitted:
  - `kind=skin_analysis_profile` with `stages[]`, `total_ms`, `llm_summary`
  - `kind=metric name=aurora.skin_analysis.total_ms`

## 3) Bench runner

### Commands
- Minimal (works without any LLM keys):
  - `make bench`
- With custom images:
  - `make bench IMAGES="path/to/a.jpg path/to/dir" REPEAT=20`
- Simulate photo QC / primary inputs:
  - `make bench QC=fail PRIMARY=routine`
  - `make bench QC=degraded DEGRADED_MODE=report`
  - `make bench PRIMARY=none` (baseline-only)
- Save raw results:
  - `make bench OUT=artifacts/bench_analyze.json`

### Implementation
- Node runner (executes the same internal functions used by the route):
  - `scripts/bench-skin-analyze.cjs`
- Python summarizer:
  - `scripts/bench_analyze.py`
- Make target:
  - `Makefile` (`bench`)

## 4) Baseline results (no LLM keys; LLM stage skipped)

Environment:
- OS: Darwin arm64
- Node: v24.10.0
- Python: 3.9.6

Run:
- `make bench REPEAT=30 QC=pass PRIMARY=routine DETECTOR=auto`
- Default image: when `IMAGES` is empty, bench uses a deterministic synthetic PNG (`synthetic_skin.png`) generated in `scripts/bench-skin-analyze.cjs`.

Summary:
- total latency p50: **27.93 ms**
- total latency p95: **43.25 ms**
- LLM calls: **0** (expected: no keys / disabled)

Stage breakdown:

| stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| decode | 1.37 | 1.67 |
| face | 0.00 | 0.00 |
| skin_roi | 1.19 | 5.57 |
| quality | 0.96 | 1.22 |
| detector | 24.00 | 33.50 |
| postprocess | 0.03 | 0.15 |
| llm | 0.00 | 0.00 |
| render | 0.00 | 0.00 |

Interpretation:
- With LLM disabled, the dominant cost is the deterministic image diagnosis **`detector`** stage (feature extraction + scoring).
- Once LLM is enabled, **`llm`** will dominate p95 whenever it is called, so gating remains the highest ROI lever for cost/latency control.

## 5) Top 3 optimization levers (evidence-based)

1) **Reduce/avoid LLM calls when not needed**
   - Evidence: pipeline has 1–2 network LLM calls (`runOpenAIVisionSkinAnalysis`, `auroraChat`) which will dominate p95 once enabled.
   - Implemented: `src/auroraBff/skinLlmPolicy.js` adds `should_call_llm(...)` gating (fail→retake; degraded→only one model; pass+confident detector→template).
   - Next: cache last analysis per `(photo_id, routine_hash)` and tighten the uncertainty trigger threshold to avoid “double LLM” patterns.

2) **Speed up deterministic detector stage**
   - Evidence: in the no-LLM baseline, `detector` is the p95 bottleneck (≈33ms vs ~2ms decode).
   - Levers: reduce analysis resolution (e.g. `ANALYSIS_MAX_SIDE`), sample pixels more aggressively in `computeLabStats`, and avoid per-pixel Lab conversion where possible.

3) **Parallelize memory context loading (quality stage)**
   - Implemented: profile + recent logs load via `Promise.allSettled` in `POST /v1/analysis/skin` (behavior-preserving; analysis continues if storage is unavailable).
   - Next: add per-call timeouts + cache last-known profile/logs snapshot to reduce tail latency under DB contention.

---

## Appendix: How to enable LLM stages locally

- OpenAI Vision:
  - `AURORA_SKIN_VISION_ENABLED=true`
  - `OPENAI_API_KEY=...`
  - optional: `AURORA_SKIN_VISION_MODEL=gpt-4o-mini`
- Aurora upstream text:
  - `AURORA_DECISION_BASE_URL=...` (must be reachable)

When enabled, rerun:
- `make bench IMAGES="path/to/real/selfie.jpg" REPEAT=10`
