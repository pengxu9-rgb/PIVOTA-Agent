# Diagnosis Shadow Verify (`CV -> Gemini`)

This document describes the shadow verifier path where:

- A (mainline): deterministic CV diagnosis (`photo_findings`, `takeaways`, `plan`) is shown to users.
- B (shadow): Gemini verification runs in background for agreement tracking and data loop only.

Shadow results do **not** alter the user-facing diagnosis payload.

## 1) Enable Shadow Verify

Set environment variables:

- `DIAG_GEMINI_VERIFY=true`
- `DIAG_GEMINI_VERIFY_MODEL=gemini-2.0-flash` (optional)
- `DIAG_VERIFY_TIMEOUT_MS=12000` (preferred)
- `DIAG_GEMINI_VERIFY_TIMEOUT_MS=12000` (legacy fallback)
- `DIAG_GEMINI_VERIFY_RETRIES=1` (optional)
- `DIAG_GEMINI_VERIFY_IOU_THRESHOLD=0.3` (optional)
- `DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD=0.55` (optional)
- `DIAG_GEMINI_VERIFY_HARD_CASE_PATH=tmp/diag_verify/hard_cases.ndjson` (optional)
- `DIAG_VERIFY_MAX_CALLS_PER_MIN=0` (optional; `0` = unlimited)
- `DIAG_VERIFY_MAX_CALLS_PER_DAY=0` (optional; `0` = unlimited)

Required for verifier call:

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
- Photo path must satisfy:
  - `used_photos=true`
  - `quality.grade in {pass,degraded}`

If those conditions are not met, verifier is skipped.

If budget guardrails are exceeded, verifier is skipped with:

- `decision=skip`
- `final_reason=VERIFY_BUDGET_GUARD`
- `skipped_reason=VERIFY_BUDGET_GUARD`

## 2) What Gets Stored

`model_outputs` and pseudo-label artifacts are written via existing store:

- `AURORA_PSEUDO_LABEL_ENABLED=true`
- `AURORA_PSEUDO_LABEL_DIR=<dir>` (default: `tmp/diag_pseudo_label_factory`)

The shadow verifier writes:

- `model_outputs.ndjson` entries for `cv_provider` and `gemini_provider`
- optional pseudo-label rows when pair agreement rules are met
- hard-case queue entries in `hard_cases.ndjson` when disagreement is high

No raw photo bytes are persisted by this verifier path.

## 3) Metrics

Prometheus endpoint includes:

- `verify_calls_total`
- `verify_fail_total`
- `agreement_histogram`
- `hard_case_rate`

Also reused ensemble provider metrics:

- `diag_ensemble_provider_calls_total`
- `diag_ensemble_provider_fail_total`
- `diag_ensemble_provider_latency_ms`
- `diag_ensemble_agreement_score`

## 4) Inspect Disagreement / Hard Cases

Tail hard-case queue:

```bash
tail -n 20 tmp/diag_verify/hard_cases.ndjson
```

Inspect model outputs:

```bash
tail -n 20 tmp/diag_pseudo_label_factory/model_outputs.ndjson
```

Generate agreement report:

```bash
python3 scripts/report_agreement.py --store-dir tmp/diag_pseudo_label_factory
```

## 5) Behavioral Contract

- User-visible diagnosis always comes from A mainline.
- B shadow verifier can only:
  - emit telemetry
  - write model outputs / pseudo-label artifacts
  - enqueue hard cases
- B never mutates `analysis.photo_findings`, `analysis.takeaways`, or `analysis.plan` returned to clients.
