# Aurora KB v0 Production Runbook

## Scope

This runbook covers Aurora Chat V2 KB v0 runtime operation in `aurora-bff`, including:

- Loader/import health (`aurora_kb_v0_loader_error_total`)
- Rule-match and legacy fallback stability (`aurora_kb_v0_rule_match_total`, `aurora_kb_v0_legacy_fallback_total`)
- Weather fallback stability (`aurora_kb_v0_climate_fallback_total`)

Related assets:

- Alerts: `monitoring/alerts/aurora_kb_v0_rules.yml`
- Dashboard: `monitoring/dashboards/aurora_kb_v0_overview.grafana.json`
- Release checklist: `docs/runbooks/aurora_kb_v0_release_checklist.md`
- Go-live playbook: `docs/runbooks/aurora_kb_v0_go_live_playbook.md`

Dashboard label note:

- Panels accept `service/env` filters when those labels are injected by scrape/relabeling.
- If labels are absent in raw metric series, panel queries fall back to unlabeled totals (`or sum(...)`) to avoid empty charts.

## Production Defaults

Set these in production deployment configuration (Railway variables):

- `AURORA_KB_V0_DISABLE=0`
- `AURORA_KB_FAIL_MODE=closed`

Notes:

- `closed`: structural KB errors fail fast at startup.
- `open`: fail-open to legacy path (temporary debugging/emergency only).

Feature-flag mapping (env-backed):

- `kb_v0_enabled = (AURORA_KB_V0_DISABLE != 1)`
- `kb_fail_mode = AURORA_KB_FAIL_MODE` (`closed|open`)

## Medication Normalization Contract

SafetyEngine normalizes medication signals: if medication concepts are detected (for example `MEDICATION_ISOTRETINOIN`), they are promoted into the `medications_any` context so KB v0 medication rules apply deterministically.

## Metrics and Meanings

1. `aurora_kb_v0_loader_error_total`
- Meaning: loader/import/runtime KB read/validation errors.
- Typical root causes: missing KB file, manifest/hash mismatch, JSON parse/schema error.

2. `aurora_kb_v0_rule_match_total`
- Meaning: KB/legacy rule matches actually used in runtime decisions.
- Typical root causes when abnormal: KB import drift, concept matcher drift, traffic/intent mix changes.

3. `aurora_kb_v0_legacy_fallback_total`
- Meaning: merge engine fell back to legacy path due to missing/insufficient KB coverage.
- Typical root causes: concept misses, ontology mismatch, malformed rule references.

4. `aurora_kb_v0_climate_fallback_total`
- Meaning: weather path used climate fallback (destination/geocode/forecast unavailable).
- Typical root causes: weather API issues, destination parsing/geocode errors, upstream timeout.

## Alert Inventory

1. `AuroraKbV0LoaderErrorDetected` (page)
- Trigger: any increase in `aurora_kb_v0_loader_error_total` over 5m.

2. `AuroraKbV0LegacyFallbackRatioHigh` (page)
- Trigger: `legacy_fallback / (rule_match + legacy_fallback) > 5%` for 10m.

3. `AuroraKbV0RuleMatchSpike` (warn)
- Trigger: 5m rule-match rate > 3x 30m baseline for 10m.

4. `AuroraKbV0ClimateFallbackSpike` (warn)
- Trigger: 10m climate fallback increase above configured threshold.

## Alert Quick Actions

| Alert | First action |
|---|---|
| `AuroraKbV0LoaderErrorDetected` | 立即将 `AURORA_KB_V0_DISABLE=1` 回退到 legacy；同时核查 KB 文件/manifest/hash。 |
| `AuroraKbV0LegacyFallbackRatioHigh` | 冻结发布并准备回滚；优先核查 matcher 命中、KB import hash、规则覆盖漂移。 |
| `AuroraKbV0RuleMatchSpike` | 先查流量/意图分布与最近 KB 变更；若无错误指标联动，通常先观察不立即回滚。 |
| `AuroraKbV0ClimateFallbackSpike` | 先查 weather/geocode 依赖与 destination parse；通常先修依赖不立即回滚。 |

## Triage Flow

1. Check loader first
- Inspect `AuroraKbV0LoaderErrorDetected` and dashboard panel `KB Loader Errors`.
- If non-zero growth exists, inspect recent deploy/import and `reports/aurora_kb_v0_import_report.md`.

2. Check fallback ratio second
- Inspect `Legacy Fallback Ratio (5m)` panel.
- If >5%, compare rule-match volume vs fallback volume, then inspect concept/ontology coverage.

3. Check rule-match spike third
- If spike occurs without loader errors, inspect recent KB import changes and intent distribution shifts.

4. Check weather dependency fourth
- If climate fallback spikes, inspect geocode and weather upstream status first.
- Confirm destination parsing path and fallback archetype selection (`raw.climate_profile`).

## Mitigation and Rollback

1. Immediate safe rollback (full legacy)

```bash
AURORA_KB_V0_DISABLE=1
```

2. Temporary fail-open mode (keep KB path but avoid boot-fail)

```bash
AURORA_KB_FAIL_MODE=open
```

3. Restore production steady-state after incident

```bash
AURORA_KB_V0_DISABLE=0
AURORA_KB_FAIL_MODE=closed
```

Rollback policy:

- Prefer `AURORA_KB_V0_DISABLE=1` for fast safety recovery.
- Use `AURORA_KB_FAIL_MODE=open` only as short-lived operational bypass while fixing KB assets.

## Post-release Validation Checklist

Must all pass:

- `http_5xx = 0`
- `schema_violations = 0`
- `validator_errors = 0`
- `safety_with_recommendations = 0`

Operational checks:

- KB v0 metrics are present in `/metrics`.
- KB v0 alerts are loaded and not firing unexpectedly.
- Dashboard panels render non-empty timeseries for production.
- Minimal smoke and soak scripts pass:
  - `npm run test:aurora-bff:unit`
  - `scripts/smoke_chaos_soak_aurora_skin.sh` (CI one-shot subset / pre-prod longer run)
