# Skin Diagnosis Regression & Bench

This repo has a **minimal, reproducible regression + fairness slice** framework for the Aurora BFF skin diagnosis flow (not medical; cosmetic-only).

The intent is to catch breakages in:
- photo quality grading + degradation behavior
- LLM call gating (skip/call + reasons)
- conservative behavior on low-quality inputs (no “random guessing”)

## Quick Start

- Unit (fast, offline, no keys needed):
  - `npm run test:aurora-bff:unit`
- E2E contract (offline; validates BFF response envelope + golden snapshot):
  - `make test`
  - Update golden explicitly: `make golden`
- Bench (offline by default; LLM stages auto-skip if not configured):
  - `make bench REPEAT=30`

## What Counts as a Regression (Golden Fields)

We pin **coarse, stable** fields only (avoid floating thresholds):

1) Photo quality
- `diagnosis.quality.grade` (`pass|degraded|fail`)
- `diagnosis.quality.reasons` include/exclude key codes (e.g. `too_dark`)

2) LLM policy (call vs skip)
- `should_call_llm(...).decision` (`call|skip`)
- `should_call_llm(...).reasons[]` include key reason codes
- `should_call_llm(...).downgrade_confidence` is stable for degraded/fail

3) Fairness slice (quality-only)
- A “deeper tone but decent dynamic range” synthetic case should **not** be auto-classified as `too_dark`.

Fixtures live in:
- `tests/fixtures/skin/quality_golden_v1.json`
- `tests/fixtures/skin/llm_policy_golden_v1.json`
- `tests/fixtures/skin/e2e_contract_golden_v1.json`

## Adding New Cases

1) Decide which category your case fits:
- **quality/regression** → update `tests/fixtures/skin/quality_golden_v1.json`
- **LLM policy** → update `tests/fixtures/skin/llm_policy_golden_v1.json`

2) Prefer deterministic synthetic inputs:
- Seeded noise + fixed base RGB
- Avoid external images in git unless they are clearly public/redistributable

3) Keep assertions coarse:
- Prefer `grade != fail` + `reasons exclude "too_dark"` instead of exact numeric metrics.

4) Run:
- `npm run test:aurora-bff:unit`
- `make bench REPEAT=30 QC=pass PRIMARY=routine`

## LLM Keys / Enabling LLM Paths (Optional)

The bench and tests are designed to run **without keys**.

- Enable vision (OpenAI):
  - `AURORA_SKIN_VISION_ENABLED=true OPENAI_API_KEY=... make bench`
- Enable report (Aurora decision upstream):
  - Set `AURORA_DECISION_BASE_URL=...` and ensure `AURORA_BFF_USE_MOCK!=true`

If LLM is unavailable/disabled, the pipeline will:
- skip LLM calls,
- include “why skipped” in the output (`analysis_summary.payload.quality_report.reasons`),
- fall back to deterministic templates.

## Privacy Notes

Profiling/bench logs never include:
- raw image bytes / base64
- face landmarks / pixel arrays
- full prompts or model responses
