# TLS Infra Optimization Runbook

## Scope
This runbook targets high first-request latency on production health probes (`/healthz/lite`) where:

- `first_tls.p90` is above budget
- `first_ttfb.p90` and `first_total.p90` remain above budget after app-side optimizations

Use this after code-level optimizations are already in place.

## Success Criteria

- `first_tls.p90 <= 2.5s`
- `first_ttfb.p90 <= 2.5s`
- `first_total.p90 <= 3.0s`
- `http_failures = 0`

Recommended verification window: `ROUNDS=12`.

## Step 0: Capture Baseline

```bash
ROUNDS=12 OUTPUT_JSON=/tmp/tls_before_12.json ./scripts/eval_tls_budget.sh || true
```

Optional multi-domain baseline:

```bash
HOSTS="pivota-agent-production.up.railway.app,api.your-domain.com" \
ROUNDS=8 \
./scripts/compare_tls_domains.sh
```

## Step 1: Domain / Edge Candidate Ranking

Use `scripts/compare_tls_domains.sh` to rank candidate domains and protocol modes:

```bash
HOSTS="pivota-agent-production.up.railway.app,api.your-domain.com" \
MODES=default,http1.1,http2 \
ROUNDS=8 \
OUTPUT_JSON=/tmp/tls_domain_candidates.json \
./scripts/compare_tls_domains.sh
```

Select the candidate with the lowest `total_p90` while keeping `success_rate=1.0`.

## Step 2: Infra Changes (Priority Order)

1. Edge termination placement
- Prefer the domain/edge path with best `total_p90` from Step 1.
- Keep API origin and TLS termination path stable (avoid chained redirects).

2. TLS profile
- Enable TLS 1.3.
- Enable session resumption/tickets at the edge provider.
- Prefer modern cipher suites (provider defaults are usually sufficient).

3. DNS path simplification
- Avoid multi-hop proxy chains for API domain.
- During tuning, use short DNS TTL (for example 60s) to reduce rollback time.

4. Protocol support
- Keep HTTP/2 enabled.
- If provider supports HTTP/3, test it but keep fallback to HTTP/2.

## Step 3: Post-change Validation

```bash
ROUNDS=12 \
BASELINE_JSON=/tmp/tls_before_12.json \
OUTPUT_JSON=/tmp/tls_after_12.json \
./scripts/eval_tls_budget.sh
```

Interpretation tips:

- `first_app_time = first_ttfb - first_tls` (derived metric in report)
- If `first_app_time` is low but `first_tls` is high, bottleneck is mostly network/TLS path.
- If both are high, combine infra tuning with app startup/warmup tuning.

## Step 4: Rollback Conditions

Rollback immediately when either condition is met:

- `success_rate < 1.0` for probe traffic
- `first_total.p90` regression > 5% versus baseline

Rollback actions:

1. Revert to previous domain/edge route.
2. Restore previous DNS record/proxy mode.
3. Re-run:

```bash
ROUNDS=8 OUTPUT_JSON=/tmp/tls_rollback_check.json ./scripts/eval_tls_budget.sh || true
```

## Change Log Template

Record each infra change with:

- Date/time (UTC)
- Provider/object changed (domain, edge, DNS, TLS policy)
- Before/after report files
- Decision (`keep` or `rollback`)

Example:

```text
2026-02-23T17:10Z | domain edge route switch | before=/tmp/tls_before_12.json after=/tmp/tls_after_12.json | keep
```

