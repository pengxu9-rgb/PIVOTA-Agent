# Celestial Commerce Core Readiness

## Purpose

This runbook defines the trusted readiness workflow for the Celestial commerce core:

- `search`
- `shopping_agent`
- `aurora-bff`
- downstream merchant/product search handoff

It is narrower than the full LLM/agent infrastructure readiness audit.

Pair this runbook with [Celestial Commerce Core Actual Architecture](./celestial_commerce_core_actual_architecture.md) when checking implementation drift against the long-term Celestial plan.

## Execution Rules

- Use only repos under `~/dev` as execution sources.
- Treat `/Desktop/...` as reference-only.
- Use `git push -> PR -> merge` for changes that ship.
- Do not use `railway up`.

## What This Audit Evaluates

### Layer contracts

- L0 public search contract
- L1 shopping-agent contract
- L2 Aurora-BFF commerce contract
- L3 Celestial engine governance assumptions

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

The audit writes a timestamped report under `reports/celestial-commerce-core-readiness/`.

## Gates

- Public search contract gate
- Shopping-agent commerce gate
- Aurora commerce orchestration gate
- Production commerce-core smoke

## Stable Scenario Baseline

The commerce-core baseline should keep these scenario families under one shared smoke:

- public internal-first search contract
- broad `shopping_agent` / `aurora-bff` commerce search
- strict ingredient consistency
- merchant-style query routing
- clarify-required query behavior

Exact product-specific lookup should stay covered, but if a source contract is still live-flaky, keep it in local contract tests until runtime routing is stabilized enough for deterministic production smoke.

## Scorecard Dimensions

- Prompt/Intent Readiness
- Query Decomposition Readiness
- Commerce Search Contract Readiness
- Merchant/Product Routing Readiness
- Fallback/Resilience Readiness
- Observability/Provenance Readiness
- Cross-layer Contract Drift Risk

## Interpretation

- `green`: contract is explicit and covered by at least one stable gate
- `amber`: behavior works but contract or gate coverage is incomplete
- `red`: contract drift, unclear ownership, or a broken/failing gate
