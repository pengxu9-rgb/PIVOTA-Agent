# Monitoring Runbook (Aurora Diagnosis)

## Scope
This runbook covers the production monitors defined in:

- `monitoring/alerts/aurora_diagnosis_rules.yml`
- `monitoring/dashboards/aurora_diagnosis_overview.grafana.json`

It applies to diagnosis runtime health, shadow verifier health, and geometry sanitizer stability.

## Metric Contract

### Geometry sanitizer counters and rate

- `geometry_sanitizer_drop_total{issue_type,quality_grade,pipeline_version,device_class}`
- `geometry_sanitizer_clip_total{issue_type,quality_grade,pipeline_version,device_class}`
- `analyze_requests_total{issue_type,quality_grade,pipeline_version,device_class}`
- `geometry_sanitizer_drop_rate{issue_type,quality_grade,pipeline_version,device_class}`

Contract definition:

- `geometry_sanitizer_drop_rate = geometry_sanitizer_drop_total / analyze_requests_total`
- `pipeline_version` must be `A|B|unknown`
- `quality_grade` must be `pass|degraded|fail|unknown`

## Alert Thresholds (default)

1. `AuroraHttp5xxRateHigh`
- Trigger: `5xx_rate > 0.02` for 10m
- Severity: `critical`

2. `AuroraHttpTimeoutRateHigh`
- Trigger: `timeout_rate > 0.01` for 10m
- Severity: `warning`

3. `AuroraVerifyFailSpike`
- Trigger: `increase(verify_fail_total[15m]) > 20`
- Severity: `warning`

4. `AuroraVerifyBudgetGuardTriggered`
- Trigger: `increase(verify_budget_guard_total[15m]) > 0`
- Severity: `warning`

5. `AuroraQualityFailRateSpike`
- Trigger: `quality_fail_rate > 0.35` for 30m
- Severity: `warning`

6. `AuroraGeometryDropRateSpike`
- Trigger: `max(geometry_sanitizer_drop_rate) > 0.20` for 30m
- Severity: `warning`

## First Response Procedure

1. Confirm blast radius in dashboard.
- Check `HTTP 5xx Rate` and `HTTP Timeout Rate` first.
- If elevated, inspect latest deployment and upstream dependency health.

2. Check verifier channel.
- Inspect `Verifier Calls by Status` and `Verifier Failures by Reason`.
- If `verify_budget_guard_total` spikes, verify:
  - `DIAG_VERIFY_MAX_CALLS_PER_MIN`
  - `DIAG_VERIFY_MAX_CALLS_PER_DAY`

3. Check input quality and geometry health.
- Review `Quality Fail / Degraded Rate`.
- Review `Geometry Sanitizer Drop Rate (max)` and slice table.
- If one slice dominates, isolate by `issue_type` and `quality_grade`.

4. Decide mitigation.
- Runtime/API instability: rollback recent deploy.
- Verifier instability only: set `DIAG_GEMINI_VERIFY=false` (shadow rollback).
- Geometry spike only: keep service up, investigate sanitizer thresholds and source geometry quality.

## Sanity Gates in CI/Bench

The following scripts now enforce geometry sanity budgets:

- `scripts/perturb_stability.py` via `--geometry-drop-rate-max` (env: `STABILITY_GEOMETRY_DROP_RATE_MAX`, default `0.2`)
- `scripts/load_test.py` via `--geometry-drop-rate-max` (env: `LOADTEST_GEOMETRY_DROP_RATE_MAX`, default `0.2`)
- `scripts/generate_release_gate.py` checks:
  - `RELEASE_STABILITY_GEOMETRY_DROP_RATE_MAX` (default `0.2`)
  - `RELEASE_LOADTEST_GEOMETRY_DROP_RATE_MAX` (default `0.2`)

## Validation Commands

```bash
make monitoring-validate
make release-gate
```

## Rollback

1. Soft rollback (verifier only):
```bash
DIAG_GEMINI_VERIFY=false
```

2. Full rollback:
- Redeploy previous known-good release.
- Re-run:
```bash
make monitoring-validate
make release-gate
```
