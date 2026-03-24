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
- Production skincare smoke: `scripts/smoke_find_products_multi_skincare_prod.sh`

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
- shopping search targeted regressions
- production skincare smoke
- backend payment-aftercare gate
- backend rollout gate candidate, when present locally
- ACP control-plane contract gate, when present locally

## Interpretation

- `green`: verified with passing tests or production smoke
- `amber`: present but incomplete, local-only, or missing a merged-main gate
- `red`: failing contract or known cross-repo disconnect
