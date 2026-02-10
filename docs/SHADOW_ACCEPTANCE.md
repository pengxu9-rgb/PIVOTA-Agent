# Shadow Acceptance

## Purpose
`shadow-acceptance` is a post-deploy/restart gate for Gemini shadow verifier health. It validates:
- smoke behavior (`used_photos` ratio, verifier success deltas),
- optional budget-guard trigger path,
- daily artifact generation and red-line thresholds.

## When to run
- Every restart or deployment in staging.
- Before enabling a higher shadow sample rate in production.

## Commands
### Standard (no guard forcing, safe for production)
```bash
make shadow-acceptance \
  SHADOW_BASE=https://pivota-agent-production.up.railway.app \
  SHADOW_CALLS=20 \
  SHADOW_ALLOW_GUARD_TEST=false
```

If Node `fetch` is unstable in your environment, set:
```bash
SHADOW_ACCEPTANCE_FORCE_CURL_HTTP=true SHADOW_ACCEPTANCE_FORCE_CURL_UPLOAD=true make shadow-acceptance ...
```

### Staging guard validation (explicit only)
```bash
make shadow-acceptance \
  SHADOW_BASE=https://pivota-agent-staging.up.railway.app \
  SHADOW_CALLS=20 \
  SHADOW_GUARD_CALLS=20 \
  SHADOW_ALLOW_GUARD_TEST=true
```

## What `shadow-acceptance` checks
1. **Step A smoke**
   - `used_photos_ratio >= SHADOW_MIN_USED_PHOTOS_RATIO` (default `0.95`)
   - `verify_calls_total{status=success|ok}` delta must be `>= 1`
   - analysis response must keep rendering (`analysis_summary` present)
2. **Step B guard test** (only if `SHADOW_ALLOW_GUARD_TEST=true`)
   - requests include temporary guard override headers
   - require `verify_calls_total{status=guard}` delta `> 0`
   - require `verify_budget_guard_total` delta `> 0`
   - user-visible response must still render (`analysis_summary` unchanged)
3. **Step C daily outputs + thresholds**
   - window is evaluated from the current acceptance run start; if `--since` is older than run start it is clamped to run start (prevents historical data bleed-through)
   - runs `run_shadow_daily` and checks artifact presence:
     - `reports/verify_daily_YYYYMMDD.md`
     - `outputs/pseudo_labels_daily_YYYYMMDD.ndjson`
     - `outputs/hard_cases_daily_YYYYMMDD.jsonl`
     - `outputs/job_summary_YYYYMMDD.json`
   - applies thresholds from job summary:
     - `pass_fail_rate <= SHADOW_MAX_PASS_FAIL_RATE` (default `0.05`)
     - `timeout_rate_vs_calls <= SHADOW_MAX_TIMEOUT_RATE` (default `0.02`)
     - `upstream_5xx_rate_vs_calls <= SHADOW_MAX_UPSTREAM_5XX_RATE` (default `0.02`)
   - checks auth red flags:
     - `upstream_401_count == 0`
     - `upstream_403_count == 0`

## Output
Each run writes:
- `reports/shadow_acceptance_YYYYMMDD_HHMM.md`
- `reports/shadow_acceptance_YYYYMMDD_HHMM.json`

The report clearly marks PASS/FAIL and includes exact failed checks.

## Triage priority on FAIL
1. `UPSTREAM_401` / `UPSTREAM_403` > 0
2. `used_photos_ratio` below threshold
3. timeout / 5xx threshold breach
4. missing daily artifacts
5. guard-path failure (staging only)
