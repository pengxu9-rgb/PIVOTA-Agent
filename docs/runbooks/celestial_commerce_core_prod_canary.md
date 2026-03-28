# Celestial Commerce Core Production Canary

## Purpose

This runbook defines a **read-only confirmatory smoke** for the Celestial commerce core on production data.

Use it only after the local and staging acceptance layers are already in place.

This canary is:

- read-only
- narrow
- non-governance
- non-checkout
- not a production release gate by itself

## What It Covers

The default canary intentionally stays small and stable:

- public internal-first broad search
- `shopping_agent` broad discovery
- `aurora-bff` broad discovery
- exact-ish strict ingredient lookup
- merchant-ish routing
- clarify-required query behavior

It does **not** cover:

- governance negative cases
- checkout or write-back flows
- deep pagination or merchant sweep abuse probes
- broad replay loops or high-frequency load

## Entry Point

Run:

```bash
npm run probe:commerce-core:prod-canary
```

By default this probes the supported authenticated invoke rail:

```bash
AUTH_TOKEN=ak_live_your_prod_key \
npm run probe:commerce-core:prod-canary
```

You can also use:

```bash
AGENT_API_KEY=ak_live_your_prod_key \
npm run probe:commerce-core:prod-canary
```

Optional inputs:

```bash
BASE_URL=https://pivota-agent-production.up.railway.app \
ROUNDS=1 \
VERIFY_DEPLOY=0 \
FAIL_ON_GATE_FAILURES=0 \
npm run probe:commerce-core:prod-canary
```

Supported auth envs for the authenticated invoke path:

- `AUTH_TOKEN`
- `AGENT_API_KEY`
- `COMMERCE_CORE_PROD_AUTH_TOKEN`
- `COMMERCE_CORE_PROD_AGENT_API_KEY`
- `COMMERCE_CORE_PROD_CANARY_ENDPOINT`
- `COMMERCE_CORE_PROD_CANARY_BASE_URL`

Public `POST /api/gateway` remains a non-authoritative observability surface. Do not use it as the default canary rail.

## Default Behavior

- `ROUNDS=1`
- `VERIFY_DEPLOY=0`
- `FAIL_ON_GATE_FAILURES=0`

That default keeps the canary useful for confirmation without turning it into a hard release gate.

If you explicitly want a stricter run, enable:

```bash
VERIFY_DEPLOY=1 FAIL_ON_GATE_FAILURES=1 npm run probe:commerce-core:prod-canary
```

## Output

The canary writes timestamped matrix artifacts under `reports/celestial-commerce-core-prod-canary/`.

The output comes from `search_stability_matrix.js`, so you get:

- summary JSON
- per-case pass/fail rollup
- markdown report
- row-level diagnostics

## Interpretation

- Use a passing canary as a confirmatory signal that real production data still matches the intended commerce contract.
- Use a failing canary as a prompt to investigate drift before any broader release decision.
- Do not use this canary alone to override staging acceptance or readiness `amber` findings.
