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

By default this probes the public `POST /api/gateway` contract.

If the deployed commerce entrypoint is now authenticated, probe the supported invoke surface explicitly instead:

```bash
ENDPOINT=/agent/shop/v1/invoke \
AUTH_TOKEN=ak_live_your_prod_key \
npm run probe:commerce-core:prod-canary
```

When `BASE_URL` is left at the public default and `ENDPOINT=/agent/shop/v1/invoke`, the wrapper now auto-switches the probe base to `https://pivota-agent-production.up.railway.app`.

You can also use:

```bash
ENDPOINT=/agent/shop/v1/invoke \
AGENT_API_KEY=ak_live_your_prod_key \
npm run probe:commerce-core:prod-canary
```

Optional inputs:

```bash
BASE_URL=https://agent.pivota.cc \
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
