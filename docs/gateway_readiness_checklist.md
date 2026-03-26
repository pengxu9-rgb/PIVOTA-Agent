# Gateway Readiness Checklist

## Required PR Gates
- `npm run test:gate:full-repo`
- `npm run contract:test`
- `npm run verify:premerge`

The repository now includes [full-repo-gate.yml](/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend/.github/workflows/full-repo-gate.yml) so every pull request has an official full-repo signal. Branch protection should mark `Full Repo Gate` as required.
The full-repo Jest entry now runs through [run_jest_inband.sh](/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend/scripts/run_jest_inband.sh) with `JEST_MAX_OLD_SPACE_SIZE_MB`, and the PR workflow pins that value to `8192` so the gate is reproducible instead of depending on an implicit local heap default.

## Fast Pre-Merge Signal
- `npm run test:gate:commerce:focused`

Use this as the fast local or pre-push signal for gateway and commerce changes. It is not sufficient as the only PR gate once code is ready to merge.
If a local machine needs more headroom for long Jest runs, use `JEST_MAX_OLD_SPACE_SIZE_MB=<mb>` rather than editing package scripts.

## Required Release Gate
- `npm run test:gate:release-smoke`

The repository now includes [gateway-release-smoke.yml](/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend/.github/workflows/gateway-release-smoke.yml) as the official runtime smoke entrypoint. Use it for deployed gateway verification with a concrete `base_url`.

## When Focused-Only Is Acceptable
- Local iteration on a bounded gateway or commerce tranche.
- Refactors that have already kept targeted tests green and are not yet ready for merge.
- Early Aurora route-family extraction work before the tranche is finalized.

## When Runtime Smoke Is Mandatory
- Before production rollout of gateway changes.
- When changing external invoke entrypoints, auth, route registration, or startup wiring.
- When changing Aurora runtime routes or route-family registration.
- When changing critical search and PDP flows that can affect live request routing.

## Critical Paths
- `find_products_multi`
- external invoke auth
- `/agent/v1/products/resolve`
- Aurora runtime routes

## Current Structural Priorities
1. Keep `src/server.js` as composition root only.
2. Continue Aurora-first decomposition in `src/auroraBff/routes.js`.
3. Preserve green `focused`, `full-repo`, and `release-smoke` gates as the rollout baseline.
