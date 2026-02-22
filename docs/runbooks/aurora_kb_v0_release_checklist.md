# Aurora KB v0 Release Checklist

## Change Scope

This release includes production-readiness assets only:

- Production default env guidance for KB v0 switches
- Prometheus rules: `monitoring/alerts/aurora_kb_v0_rules.yml`
- Grafana dashboard: `monitoring/dashboards/aurora_kb_v0_overview.grafana.json`
- Runbook + release checklist docs
- CI gate update for minimal chaos soak subset

No API schema changes and no core decision logic refactor are included.

## Migration Contract Note

SafetyEngine normalizes medication signals: if medication concepts are detected (for example `MEDICATION_ISOTRETINOIN`), they are promoted into the `medications_any` context so KB v0 medication rules apply deterministically.

## Default Switches (Production)

- `AURORA_KB_V0_DISABLE=0`
- `AURORA_KB_FAIL_MODE=closed`

Emergency-only:

- `AURORA_KB_V0_DISABLE=1` (full legacy fallback)
- `AURORA_KB_FAIL_MODE=open` (temporary fail-open)

## Pre-release Gates

1. Unit gate

```bash
npm run test:aurora-bff:unit
```

Expected: all green.

2. Monitoring asset validation

```bash
make monitoring-validate
```

Expected: pass, with KB v0 alert/dashboard/runbook assets present.

3. Chaos soak script operability (minimal subset)

```bash
BASE='https://pivota-agent-production.up.railway.app' \
DURATION_SECONDS=60 \
BASE_RPS=1 CHAOS_RPS=1 SPIKE_RPS=2 \
bash scripts/smoke_chaos_soak_aurora_skin.sh --once --scenario use_photo_false --lang EN
```

Expected: script exits 0 and writes `summary.json`.

## Rollback Strategy

1. Fast rollback to legacy

```bash
AURORA_KB_V0_DISABLE=1
```

2. If startup is blocked by KB integrity and rollback is not yet desired

```bash
AURORA_KB_FAIL_MODE=open
```

3. After incident mitigation, revert to steady-state

```bash
AURORA_KB_V0_DISABLE=0
AURORA_KB_FAIL_MODE=closed
```

## Post-release Observability Checks

1. Hard invariants

- `http_5xx=0`
- `schema_violations=0`
- `validator_errors=0`
- `safety_with_recommendations=0`

2. KB v0 metrics health

- `aurora_kb_v0_loader_error_total`: no growth
- `aurora_kb_v0_legacy_fallback_total`: no sustained ratio drift
- `aurora_kb_v0_rule_match_total`: stable vs baseline
- `aurora_kb_v0_climate_fallback_total`: no unexpected spike

3. Alert thresholds to watch

- Loader error increase > 0 in 5m (page)
- Legacy fallback ratio > 5% for 10m (page)
- Rule match 5m rate > 3x 30m baseline for 10m (warn)
- Climate fallback 10m increase above configured threshold (warn)
