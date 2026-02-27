# Monitoring Runbook (Aurora Diagnosis)

## Scope
This runbook covers the production monitors defined in:

- `monitoring/alerts/aurora_diagnosis_rules.yml`
- `monitoring/dashboards/aurora_diagnosis_overview.grafana.json`

It applies to diagnosis runtime health, shadow verifier health, geometry sanitizer stability, recommendation-context observability, and ingredients query-first observability.

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

### Analysis / recommendation observability counters

- `aurora_skin_analysis_real_model_total{source}`
- `aurora_skin_llm_call_total{stage,outcome}`
- `aurora_reco_context_used_total{signal}`
- `aurora_schema_violation_total{reason,path}`

Interpretation:

- `aurora_skin_analysis_real_model_total`: final analysis source mix (vision/rule-based/baseline/retake).
- `aurora_skin_llm_call_total`: per-stage LLM call decision outcomes (`call|skip|error`) for `vision` and `report`.
- `aurora_reco_context_used_total`: whether recommendation responses consumed recent logs / itinerary / safety flags.
- `aurora_schema_violation_total`: response envelope schema mismatches before fallback envelope output. Any increase is a release blocker.

### Ingredients query-first observability

- `aurora_ingredients_flow_total{stage,outcome}`
- `ingredients_first_answer_latency_ms` (histogram)
- `ingredients_unwanted_diagnosis_rate`
- `ingredients_to_reco_optin_rate`

Interpretation:

- `aurora_ingredients_flow_total`: ingredients entry/mode/answer/opt-in and unwanted diagnosis counters.
- `ingredients_first_answer_latency_ms`: latency from `ingredients_entry_opened` to `ingredients_answer_served` (from `/v1/events` ingestion).
- `ingredients_unwanted_diagnosis_rate`: unwanted diagnosis gates over ingredients entries (target `< 0.5%`).
- `ingredients_to_reco_optin_rate`: explicit reco opt-ins from ingredient path over ingredients entries.

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

7. `AuroraSkinRecoGeneratedRateLow`
- Trigger: `aurora:skin_reco_generated_rate:15m < 0.35` with `aurora:skin_reco_request_rate:15m > 0.02` for 20m
- Severity: `warning`

8. `AuroraSkinLowConfidenceRateHigh`
- Trigger: `aurora:skin_low_confidence_rate:15m > 0.55` with `aurora:skin_reco_request_rate:15m > 0.02` for 30m
- Severity: `warning`

9. `AuroraSkinSafetyBlockRateHigh`
- Trigger: `aurora:skin_safety_block_rate:15m > 0.18` with `aurora:skin_reco_request_rate:15m > 0.02` for 15m
- Severity: `warning`

10. `AuroraChatProxyFallbackRateHigh`
- Trigger: `aurora:chat_proxy_fallback_rate:5m > 0.05` for 10m
- Severity: `warning`
- Note: this alert depends on proxy-side metrics (`aurora_chat_proxy_requests_total` / `aurora_chat_proxy_fallback_total`) being exported by the gateway runtime.

11. `AuroraRecoTimeoutDegradedRateHigh`
- Trigger: `aurora_skin_reco_timeout_degraded_rate > 0.01` with `aurora:skin_reco_request_rate:15m > 0.02` for 10m
- Severity: `warning`
- Meaning: reco stage is degrading too often due to budget timeout.

12. `AuroraAnalysisTimeoutDegradedRateHigh`
- Trigger: `aurora_skin_analysis_timeout_degraded_rate > 0.01` with `increase(aurora_skin_flow_total{stage="analysis_request",outcome="hit"}[15m]) > 20` for 10m
- Severity: `warning`
- Meaning: analysis stage is degrading too often due to budget timeout.

13. `AuroraRecoOutputGuardFallbackRateHigh`
- Trigger: `aurora_skin_reco_output_guard_fallback_rate > 0.001` with `aurora:skin_reco_request_rate:15m > 0.02` for 10m
- Severity: `warning`
- Meaning: upstream reco payload quality drift (empty/unrenderable cards) is rising and guard fallback is being consumed too often.

14. `AuroraResponseSchemaViolationDetected`
- Trigger: `increase(aurora_schema_violation_total[10m]) > 0`
- Severity: `critical`
- Meaning: server generated an invalid envelope shape and had to fallback.

15. `AuroraIngredientsUnwantedDiagnosisRateHigh`
- Trigger: `aurora:ingredients_unwanted_diagnosis_rate:15m > 0.005` with `aurora:ingredients_entry_rate:15m > 0.01` for 10m
- Severity: `warning`
- Meaning: ingredient starter flow is being misrouted to diagnosis too often.

16. `AuroraIngredientsFirstAnswerLatencyHigh`
- Trigger: `aurora:ingredients_first_answer_latency_p95_ms:15m > 8000` with `aurora:ingredients_entry_rate:15m > 0.01` for 10m
- Severity: `warning`
- Meaning: ingredient query-first first response latency is degraded.

## Post-merge first-day watchlist

Track these four metrics first:

1. `aurora_skin_reco_timeout_degraded_rate`
2. `aurora_skin_analysis_timeout_degraded_rate`
3. `aurora_skin_reco_output_guard_fallback_rate`
4. HTTP `5xx` rate
5. `increase(aurora_schema_violation_total[10m])`
6. `ingredients_unwanted_diagnosis_rate`
7. `histogram_quantile(0.95, sum(rate(ingredients_first_answer_latency_ms_bucket[15m])) by (le))`

Suggested action thresholds:

- `timeout_degraded_rate > 1%` sustained for 10m:
  - inspect upstream p95/p99 latency and network reset spikes.
- `reco_output_guard_fallback_rate > 0.1%` sustained for 10m:
  - inspect upstream recommendation card schema/serialization drift.
- Any non-zero schema violations from soak/contract validation:
  - treat as P0 and stop rollout.

Suggested full-rollout watch cadence:

1. 0-2h after deploy: every 30 minutes run key smoke scripts and capture metrics snapshot.
2. 24h window: continuous dashboard + alert watch; run one low-pressure 30-minute chaos soak.
3. 72h window: publish stability report + defect priority list.
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
- Timeout-degraded spike: verify upstream p95/p99 and connection reset rates before tightening budgets (budgets are clamped to `>=1000ms` by design).
- Output-guard fallback spike: inspect upstream reco card schema/serialization and reco-stage contract violations.
- Schema violation detected: stop rollout progress immediately, inspect `aurora_schema_violation_total{reason,path}` labels, and patch response builder/schema drift before continuing.

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
BASE=https://pivota-agent-production.up.railway.app bash scripts/smoke_aurora_skin_reco_gates.sh
```

## Chat Follow-up Canary (post-env rollout)

Use this probe to validate the high-risk chat regressions after env changes:

- No fallback to diagnosis intake for brand availability asks
- No repeated `skinType` clarification for this flow
- No increase in `claims_violation_total`

Manual run:

```bash
node scripts/chat_followup_canary.mjs --base https://pivota-agent-production.up.railway.app
```

Outputs:
- JSON summary to stdout
- Markdown report under `reports/chat_followup_canary_*.md`

Hard gates (script exit non-zero on failure):
- `cards` contain `product_parse` and `offers_resolved`
- `cards` do not contain `diagnosis_gate`
- assistant message does not ask intake profile fields (skin type / barrier / goals)
- `catalog_availability_shortcircuit_total` increases by at least 1
- `repeated_clarify_field_total{field="skinType"}` delta is 0
- `claims_violation_total` delta is 0

Scheduled probe:
- `.github/workflows/chat-followup-canary.yml` runs hourly (`cron: 17 * * * *`) and uploads report artifacts.

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
