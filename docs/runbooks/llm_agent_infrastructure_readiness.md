# Pivota LLM / Agent Infrastructure Readiness

## Purpose

This runbook defines the trusted readiness workflow for Pivota's LLM and agent stack.

## Execution Rules

- Use only repos under `~/dev` as execution sources.
- Treat `/Desktop/...` repos and artifacts as reference-only.
- Use `git push -> PR -> merge` for all fixes and deploy-triggering changes.
- Do not use `railway up`.

## Readiness Sources Of Truth

Readiness conclusions must distinguish:

- local repo truth
- merged `main` truth
- production truth

## Current Release Gates

- Aurora BFF release gate: `.github/workflows/aurora-bff-release-gate.yml`
- Shopping search release gate: `.github/workflows/shopping-search-release-gate.yml`
- Celestial commerce core readiness: `.github/workflows/celestial-commerce-core-readiness.yml`
- Catalog intelligence release gate: `.github/workflows/catalog-intelligence-release-gate.yml`
- Production skincare smoke: `scripts/smoke_find_products_multi_skincare_prod.sh`

## Narrow Commerce-Core Audit

For the layered commerce stack (`search` / `shopping_agent` / `aurora-bff`), run:

```bash
npm run audit:readiness:commerce-core
```

This produces a narrower scorecard focused on source contracts, commerce retrieval semantics, prompt/query decomposition helpers, and production smoke for the commerce core.

## Audit Entry Point

Run:

```bash
npm run audit:readiness:llm-agent
```

The audit writes a timestamped report under `reports/llm-agent-infra-readiness/`.

## What The Audit Checks

- canonical repo inventory under `~/dev`
- branch / HEAD / `origin/main` drift
- dirty worktree counts
- agent public `service_version`
- backend public `/__build` or `/health` `version` surface
- shopping search targeted regressions
- catalog-intelligence clean-main gate
- production skincare smoke
- backend payment-aftercare gate
- backend rollout gate candidate, when present locally
- ACP control-plane contract gate, when present locally

## Interpretation

- `green`: verified with passing tests or production smoke
- `amber`: present but incomplete, local-only, or missing a merged-main gate
- `red`: failing contract or known cross-repo disconnect

## Provenance Standard

Deploy provenance is only `green` when both of these are true:

- the public agent gateway returns a non-empty `metadata.service_version.commit`
- the public backend returns a non-empty `version.commit` and canonical `version.service=pivota-backend`
