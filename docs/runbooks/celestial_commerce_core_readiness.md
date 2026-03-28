# Celestial Commerce Core Readiness

## Purpose

This runbook defines the trusted readiness workflow for the Celestial commerce core:

- Aurora Beauty orchestration
- Shopping Agent decisioning
- execution-facing commerce resolution
- source profile ingress contracts

It is narrower than the full LLM/agent infrastructure readiness audit.

Pair this runbook with [Celestial Commerce Core Actual Architecture](./celestial_commerce_core_actual_architecture.md) when checking implementation drift against the long-term Celestial plan.

When the branch has already accumulated multiple facade-ownership migrations and you want a bounded freeze-and-validate cycle before more refactor, use [Celestial Commerce Core Stabilization Acceptance](./celestial_commerce_core_stabilization_acceptance.md).

For a narrow read-only confirmation on real production data after staging acceptance is in place, use [Celestial Commerce Core Production Canary](./celestial_commerce_core_prod_canary.md).

## Execution Rules

- Use only repos under `~/dev` as execution sources.
- Treat `/Desktop/...` as reference-only.
- Use `git push -> PR -> merge` for changes that ship.
- Do not use `railway up`.

## What This Audit Evaluates

### Layer contracts

- Aurora orchestration contract
- Shopping Agent decisioning contract
- execution-facing resolution contract
- source profile contract

### Core chain

- prompt understanding
- clarify / loop-break behavior
- merchant vs product query decomposition
- retrieval source selection
- result contract shaping
- fallback / timeout / degradation behavior

## Entry Point

Run:

```bash
npm run audit:readiness:commerce-core
```

The supported commerce contract is the authenticated invoke surface:

```bash
POST /agent/shop/v1/invoke
```

The legacy public `POST /api/gateway` probe is still recorded in the report for public-surface observability, but it should no longer be treated as the primary commerce acceptance gate.

Run the shared production smoke against the supported invoke surface:

```bash
COMMERCE_CORE_PROD_SMOKE_ENDPOINT=/agent/shop/v1/invoke \
COMMERCE_CORE_PROD_AUTH_TOKEN=ak_live_your_prod_key \
npm run audit:readiness:commerce-core
```

The production smoke defaults to `https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke`. The report still keeps the separate public probe on `https://agent.pivota.cc`, but marks it as non-authoritative.

You can also provide:

```bash
COMMERCE_CORE_PROD_SMOKE_ENDPOINT=/agent/shop/v1/invoke \
COMMERCE_CORE_PROD_AGENT_API_KEY=ak_live_your_prod_key \
npm run audit:readiness:commerce-core
```

The audit writes a timestamped report under `reports/celestial-commerce-core-readiness/`.

To enrich the gateway governance section with sampled runtime shadow traffic, provide:

```bash
GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH=/path/to/gateway_governance_shadow.ndjson \
npm run audit:readiness:commerce-core
```

If you only have raw gateway logs, provide the log path instead and let the audit extract a bounded shadow sample automatically:

```bash
GATEWAY_GOVERNANCE_LOG_INPUT_PATH=/path/to/gateway.log.ndjson \
npm run audit:readiness:commerce-core
```

For a lighter daily governance-only report, use:

```bash
GATEWAY_GOVERNANCE_LOG_INPUT_PATH=/path/to/gateway.log.ndjson \
npm run audit:gateway-governance:daily
```

For the bounded stabilization pass that combines local gates, readiness, daily governance, and a staging matrix, use:

```bash
npm run audit:stabilization:commerce-core
```

For a narrower non-gating production confirmation pass, use:

```bash
npm run probe:commerce-core:prod-canary
```

## Gates

- Milestone 0 baseline gate
- Public search contract gate
- Shopping-agent commerce gate
- Aurora commerce orchestration gate
- Gateway invocation/access governance gate
- Production commerce-core smoke

## Milestone 0 Rule

Do not start dispatcher rewiring until the milestone0 baseline is in place and passing.

The baseline must cover:

- Aurora clarify
- Shopping Agent ranking
- Search exact resolution
- merchant vs product query
- strict ingredient constraint

## Freeze Rule

Starting in Milestone 1:

- new business logic must not be added directly to `src/server.js`
- new business logic must not be added directly to route helpers
- new behavior must land in the corresponding facade/module

`src/server.js` and route helpers are limited to ingress, dispatch, tracing, provenance, and response mapping changes.

## Stable Scenario Baseline

The commerce-core baseline should keep these scenario families under one shared smoke:

- public internal-first search contract
- broad `shopping_agent` / `aurora-bff` commerce search
- strict ingredient consistency
- merchant-style query routing
- clarify-required query behavior

Exact product-specific lookup should stay covered, but if a source contract is still live-flaky, keep it in local contract tests until runtime routing is stabilized enough for deterministic production smoke.

Current shared live corpus should include:

- `serum`
- `vitamin c serum under €30`
- `IPSA Time Reset Aqua`
- `IPSA products`
- the current clarify-required makeup/date case

## Scorecard Dimensions

- Prompt/Intent Readiness
- Query Decomposition Readiness
- Commerce Search Contract Readiness
- Merchant/Product Routing Readiness
- Fallback/Resilience Readiness
- Gateway Invocation/Access Governance Readiness
- Observability/Provenance Readiness
- Cross-layer Contract Drift Risk

## Interpretation

- `green`: contract is explicit and covered by at least one stable gate
- `amber`: behavior works but contract or gate coverage is incomplete
- `red`: contract drift, unclear ownership, or a broken/failing gate
