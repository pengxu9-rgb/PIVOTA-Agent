# Celestial Commerce Core Stabilization Acceptance

## Purpose

This runbook defines the bounded acceptance workflow to use when the Celestial commerce-core refactor has crossed the "worth validating" threshold and should pause before more ownership migration.

Use it when:

- gateway governance has already landed as a real candidate surface
- `shopping_agent`, `commerce_resolution`, and `aurora_beauty` each own meaningful runtime behavior
- the branch is large enough that more refactor would raise regression risk faster than it improves clarity

This is a **staging/pre-prod hardening** workflow, not a production rollout workflow.

## GitHub Dispatch

For current `main` validation with repo-managed staging credentials, use the GitHub workflow `Celestial Commerce Core Staging Stabilization`.

It performs the same invoke-first sequence documented here:

1. wait for the staging deployment to serve the target `main` commit over authenticated `POST /agent/shop/v1/invoke`
2. run the narrow staging invoke smoke
3. run the bounded stabilization acceptance and upload timestamped artifacts

## What This Cycle Freezes

- No new large ownership migrations
- No new business behavior unless it is a blocker fix found during acceptance
- No production release decision from this workflow alone

Allowed changes during the cycle:

- blocker fixes
- minimum observability or documentation additions required to complete the acceptance pass

## Entry Point

Run:

```bash
npm run audit:stabilization:commerce-core
```

Optional inputs:

```bash
STAGING_BASE_URL=https://pivota-agent-staging.up.railway.app \
STAGING_AUTH_TOKEN=ak_live_default_profile_key \
STAGING_PUBLIC_AUTH_TOKEN=ak_live_public_profile_key \
STAGING_GENERIC_MCP_AUTH_TOKEN=ak_live_generic_mcp_key \
GATEWAY_GOVERNANCE_LOG_INPUT_PATH=/path/to/gateway.log.ndjson \
npm run audit:stabilization:commerce-core
```

If no raw gateway log path or sampled shadow file is supplied, the workflow falls back to the checked-in shadow sample fixture so the acceptance report remains runnable locally.

For the production-governance provenance leg, the preferred Phase 2 path is to enable automated Railway export instead of relying on a checked-in fixture:

```bash
RAILWAY_API_TOKEN=railway_workspace_token \
GATEWAY_GOVERNANCE_AUTO_FETCH=1 \
npm run audit:stabilization:commerce-core
```

Supported override envs:

- `GATEWAY_GOVERNANCE_RAILWAY_PROJECT` default: `Pivota Agent`
- `GATEWAY_GOVERNANCE_RAILWAY_ENVIRONMENT` default: `production`
- `GATEWAY_GOVERNANCE_RAILWAY_SERVICE` default: `PIVOTA-Agent`
- `GATEWAY_GOVERNANCE_RAILWAY_WORKSPACE` optional workspace selector
- `GATEWAY_GOVERNANCE_FETCH_LINES` default: `500`

The staging matrix uses the supported live commerce entrypoint `POST /agent/shop/v1/invoke`. Public `POST /api/gateway` should not be treated as the primary commerce acceptance rail for this workflow. If a case requires auth and the matching staging profile is not configured, the case is marked `review_required` instead of failing.

Supported auth envs:

- default live cases: `STAGING_AUTH_TOKEN` or `STAGING_AGENT_API_KEY`
- named governance profiles: `STAGING_<PROFILE>_AUTH_TOKEN` or `STAGING_<PROFILE>_AGENT_API_KEY`
- `CELESTIAL_COMMERCE_STAGING_*` variants are also accepted

Examples:

- `STAGING_PUBLIC_AUTH_TOKEN` for `auth_profile=public`
- `STAGING_GENERIC_MCP_AUTH_TOKEN` for `auth_profile=generic_mcp`

If staging auth introspection is down but you still need bounded pre-prod acceptance traffic, the invoke runtime now supports an explicit emergency fallback. This is intended only for staging/pre-prod, never as a production auth model:

```bash
AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED=true
AGENT_AUTH_EMERGENCY_API_KEYS=ak_live_default_profile_key
AGENT_AUTH_EMERGENCY_AGENT_ID=agent_staging_acceptance
```

With that fallback enabled on the deployed staging service, `/agent/shop/v1/invoke` can keep accepting the configured staging key even when introspection is temporarily unavailable, so the 9 live acceptance cases can produce real results instead of `AUTH_INTROSPECT_UNAVAILABLE`.

## Git Push Rollout Sequence

Use `git push` to ship this staging-only acceptance fix. Do not use `railway up`.

1. Set these envs on the staging service:

```bash
AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED=true
AGENT_AUTH_EMERGENCY_API_KEYS=ak_live_your_staging_acceptance_key
AGENT_AUTH_EMERGENCY_AGENT_ID=agent_staging_acceptance
```

2. Push the branch through the normal repo deployment path:

```bash
git push origin HEAD
```

3. After staging deploys, run the narrow invoke smoke first:

```bash
STAGING_AUTH_TOKEN=ak_live_your_staging_acceptance_key \
npm run smoke:commerce-core:staging-invoke
```

Expected outcomes:

- `pass`: staging invoke auth is usable; continue to the full stabilization run
- `review_required` with `staging_auth_introspect_unavailable`: emergency fallback is not active yet, or staging did not pick up the new config

4. Only after the narrow smoke is no longer infra-blocked, rerun the bounded acceptance workflow:

```bash
STAGING_AUTH_TOKEN=ak_live_your_staging_acceptance_key \
STAGING_PUBLIC_AUTH_TOKEN=ak_live_your_staging_acceptance_key \
STAGING_GENERIC_MCP_AUTH_TOKEN=ak_live_your_staging_acceptance_key \
npm run audit:stabilization:commerce-core
```

## What The Workflow Produces

The workflow writes a timestamped report under `reports/celestial-commerce-core-stabilization/`.

Artifacts include:

- one-page stabilization review
- local baseline step inventory
- linked readiness report
- linked gateway governance daily summary
- staging acceptance matrix
- Aurora guidance-only manual-review report with per-case checklist and verdict

## Expected Decision Outputs

Only three decision labels are valid:

- `GO for continued staging hardening`
- `HOLD for architecture stabilization`
- `NO-GO`

The default expectation for the current branch shape is usually `HOLD` until the amber readiness items and any unresolved Aurora manual-review items are reduced.

## Staging Matrix Scope

The acceptance matrix is intentionally split into:

- semantic cases that can be auto-checked against stable search/invoke contracts
- governance smoke cases that confirm shadow block/downgrade provenance
- manual Aurora guidance-only cases where live data shape is too unstable for brittle title assertions

Those Aurora manual cases are now emitted as a separate report under the stabilization artifact root. The staging matrix still records them as `review_required`, but the stabilization decision consumes the dedicated Aurora report so a fully-passed manual review no longer looks like an unresolved staging blocker.

## Exit Rule

Do not resume broad refactor after the report if the decision is `NO-GO`.

If the decision is `HOLD`, continue only with:

- blocker fixes discovered by this cycle
- the smallest next ownership cut that addresses the top hold reason

If the decision is `GO`, the next step is still staging hardening, not production rollout.

After the staging layer is in place and you want a narrow real-data confirmation without turning it into a release gate, run [Celestial Commerce Core Production Canary](./celestial_commerce_core_prod_canary.md).
