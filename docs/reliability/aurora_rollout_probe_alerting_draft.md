# Aurora Rollout Probe Alerting Draft

## Scope

This draft defines the online health probe and alert rules for Aurora `/v1/chat` rollout invariants:

1. `meta` must be present.
2. `x-aurora-variant` must match `meta.rollout_variant`.
3. `x-aurora-bucket` must match `meta.rollout_bucket`.
4. `x-aurora-policy-version` must match `meta.policy_version`.
5. bucket must stay in `[0, 99]`.

The probe script is `scripts/aurora_rollout_probe.js`.

## Probe Execution

Recommended schedule:

- Every 5 minutes.
- 10 samples per run for fast signal.
- 300+ samples for split-distribution checks.

Example:

```bash
npm run probe:aurora:rollout -- --base https://pivota-agent-production.up.railway.app --samples 10 --concurrency 3
```

Useful env vars:

- `AURORA_ROLLOUT_PROBE_BASE`
- `AURORA_PROBE_BASE_URL` (GitHub Actions alias)
- `AURORA_ROLLOUT_PROBE_SAMPLES`
- `AURORA_PROBE_SAMPLES` (GitHub Actions alias)
- `AURORA_ROLLOUT_PROBE_CONCURRENCY`
- `AURORA_PROBE_CONCURRENCY` (GitHub Actions alias)
- `AURORA_ROLLOUT_PROBE_ALERT_WEBHOOK_URL`
- `AURORA_PROBE_WEBHOOK_URL` (GitHub Actions alias)
- `AURORA_PROBE_WEBHOOK_TOKEN` (GitHub Actions alias)
- `AURORA_ROLLOUT_PROBE_STATE_FILE`
- `AURORA_ROLLOUT_PROBE_POLICY_DEBUG`

CLI aliases are also supported for CI convenience:

- `--webhook` (same as `--webhook-url`)
- `--webhook-token`
- `--window-minutes` (converted to elevated failure window milliseconds)

## Alert Rules

| Rule ID | Severity | Trigger | Notes |
| --- | --- | --- | --- |
| `meta_missing` | high | `meta_null_count > 0` in one run | Envelope regression or bypass path. |
| `header_meta_mismatch` | high | `mismatch_count > 0` in one run | Variant/meta drift or header stripping. |
| `bucket_out_of_range` | high | `bucket_out_of_range_count > 0` | Hashing/parsing bug. |
| `elevated_failures` | high | non-200 or parse errors in 2 runs within 10 minutes | Prevent page on one-off infra flakes. |
| `infra_flake_single_run` | warn | one run has only infra flakes (`403`/`429`/`54113`) | Observe, retry next cycle. |
| `variant_split_drift` | warn | split out of expected ranges when sample >= threshold | Detect accidental env/routing drift. |

## Anti-Flake Policy

1. Retry failed requests once with short backoff.
2. Treat single-run CDN/WAF failures (`403`, `429`, `54113`) as warn.
3. Escalate to high only when failures persist across runs in time window.

## Expected Output

Each run writes:

- `reports/aurora_rollout_probe_<timestamp>.json`
- `reports/aurora_rollout_probe_<timestamp>.md`

The JSON includes:

- Summary counters (`meta_null_count`, `mismatch_count`, non-200, parse error).
- Variant distribution (`header_variant_counts`, `header_variant_pct`).
- Triggered checks and first failure example.

## Suggested Operations Checklist

1. If `meta_missing` or `header_meta_mismatch` triggers: page immediately and freeze ramp.
2. If `infra_flake_single_run` only: monitor, do not page.
3. If `variant_split_drift` warns: verify rollout env vars and bucket mapping.
4. Keep `AURORA_FORCE_VARIANT_ENABLED=false` in production after canary windows.
