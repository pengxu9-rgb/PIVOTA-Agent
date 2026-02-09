# Shadow Rollout Runbook (Gemini Verifier)

This runbook covers safe rollout of `DIAG_GEMINI_VERIFY` in shadow mode.  
Shadow mode only records verifier outputs and metrics. It does not change user-visible diagnosis findings.

## 1) Preconditions

- `DIAG_GEMINI_VERIFY=false` by default.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) configured in target environment.
- `AURORA_PSEUDO_LABEL_ENABLED=true` and writable `AURORA_PSEUDO_LABEL_DIR`.
- Optional hard-case sink path configured:
  - `DIAG_GEMINI_VERIFY_HARD_CASE_PATH=tmp/diag_verify/hard_cases.ndjson`

## 2) Staging Enablement

Set in staging:

- `DIAG_GEMINI_VERIFY=true`
- `DIAG_VERIFY_TIMEOUT_MS=12000`
- `DIAG_GEMINI_VERIFY_RETRIES=1`
- `DIAG_VERIFY_MAX_CALLS_PER_MIN=<small cap>` (example: `30`)
- `DIAG_VERIFY_MAX_CALLS_PER_DAY=<daily cap>` (example: `10000`)

Validation checklist:

1. `verify_calls_total{status="attempt"}` increments.
2. `verify_calls_total{status="ok"}` and/or `verify_calls_total{status="fail"}` increments.
3. `verify_calls_total{status="guard"}` stays near zero with expected budget.
4. `verify_fail_total{reason="VERIFY_BUDGET_GUARD"}` appears only when cap is intentionally tight.
5. User payload fields (`analysis.photo_findings`, `analysis.plan`, `analysis.takeaways`) remain unchanged by verifier status.

## 3) Production Gradual Rollout

Recommended sequence:

1. Enable with strict caps:
   - `DIAG_VERIFY_MAX_CALLS_PER_MIN` low
   - `DIAG_VERIFY_MAX_CALLS_PER_DAY` low
2. Observe for 24h:
   - latency, fail reason mix, hard-case rate.
3. Increase caps stepwise while monitoring:
   - provider failure rates
   - agreement distribution
   - guard hit rate

Do not remove guard caps until daily report is stable for multiple cycles.

## 4) Rollback

Immediate rollback:

- Set `DIAG_GEMINI_VERIFY=false`
- Redeploy service

Expected post-rollback behavior:

- `verify_calls_total{status="attempt|ok|fail"}` stops increasing.
- Main diagnosis output remains available via CV/rule path.

## 5) Health Signals

Primary metrics:

- `verify_calls_total` (labels: `status=attempt|ok|fail|guard`)
- `verify_fail_total` (by reason)
- `agreement_histogram`
- `hard_case_rate`
- `diag_ensemble_provider_latency_ms` (provider latency guardrail)

Healthy baseline guidance:

- Low `fail/attempt` ratio, no sustained spikes.
- `guard` only when budget intentionally capped.
- `hard_case_rate` stable or decreasing over time.

## 6) Daily Report

Generate daily verifier report:

```bash
make verify-daily
```

Optional explicit date:

```bash
make verify-daily VERIFY_REPORT_DATE=2026-02-09
```

Artifacts:

- `reports/verify_daily_YYYYMMDD.json`
- `reports/verify_daily_YYYYMMDD.md`

Report includes slices by:

- `issue_type`
- `quality_grade`
- `tone_bucket`
- `lighting_bucket`
- `device_class`

It also includes top disagreements and top hard-case reasons.
