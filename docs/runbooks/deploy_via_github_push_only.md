# Deploy Policy: GitHub Push Only (Production)

> [!WARNING]
> **SUPERSEDED 2026-08-25 — this describes the Railway era and is not how production ships.**
> Since the 2026-08-22 cutover the production gateway is **GCP Cloud Run behind
> `gateway.pivota.cc`**, built with `infra/gcp/cloudbuild.gateway.yaml` and deployed by
> `infra/gcp/deploy_gateway.sh prod <sha>` (both in the `pivota-backend` repo). It does **not**
> deploy on merge, by design.
>
> `pivota-agent-production.up.railway.app` is a retired standby. Its GitHub auto-deploy trigger was
> removed on 2026-08-25, and `production-deploy-promote.yml` no longer runs on push — it only ever
> verified the Railway host, so on merge it reported success the Cloud Run gateway had not earned.
> Whether production runs `main` is answered by `.github/workflows/gateway-prod-drift.yml`.

## Policy

Production deployment source of truth is **GitHub `main`**.

- Allowed: merge to `main` -> Railway auto-deploy from GitHub.
- Disallowed for normal flow: manual `railway up` to production.

Reason: manual `railway up` can be overwritten by later GitHub auto-deploy and causes commit drift.

## Standard Deployment Flow

1. Commit code in feature branch.
2. Open PR and pass CI.
3. Merge PR into `main`.
4. Wait for Railway production deploy.
   (Historical. `production-deploy-promote.yml` no longer runs on push, and the Railway auto-deploy
   trigger is removed; nothing ships on merge. See the banner above.)
5. Verify deployed commit matches merged commit:

```bash
BASE_URL="https://pivota-agent-production.up.railway.app" \
TARGET_COMMIT="$(git rev-parse --short=12 HEAD)" \
bash scripts/verify_deployed_commit_matches.sh
```

6. Run runtime smoke gate (already covered by `.github/workflows/aurora-bff-release-gate.yml` on `push main`).
7. Keep the production drift guard enabled:

```bash
gh workflow run gateway-prod-drift.yml
```

This verifies that the gateway's `/health` `version.commit` still matches GitHub `main`, reading gateway.pivota.cc — the host that actually serves users. It does NOT roll anything back: the workflow it replaced fired a Railway rollback webhook, which post-cutover pointed at the retired platform. Deploying is a deliberate step, not something an alarm should do on your behalf.

## Fast Local Check

From repo root:

```bash
npm run deploy:verify:production
```

This checks `/version.commit`, with `/healthz.version.commit` as fallback, against local `HEAD` short SHA.

For a repo-truth check against GitHub `main`, use the scheduled workflow instead of local `HEAD`.

## Emergency Exception

If manual `railway up` is unavoidable:

1. Record incident reason in PR/runbook.
2. Deploy the exact same code already merged to GitHub `main`.
3. Use `AURORA_GIT_SHA=<merged commit>` only as a temporary override if Railway does not inject a commit SHA for that manual deploy.
4. Re-run commit match verification until pass.
5. Clear any temporary `AURORA_GIT_SHA` override after the deployment chain is healthy again.

Do not keep production in a state where deployed commit is not traceable to `main`.
The scheduled workflow `.github/workflows/gateway-prod-drift.yml` is the backstop that catches later drift or an accidental old redeploy. It runs hourly and holds fire for 120 minutes after a runtime commit lands, so a normal merge-then-deploy never trips it.

## Required Production Wiring

At least one of these must be true:

1. Railway production is directly connected to GitHub `main`.
2. ~~`RAILWAY_PRODUCTION_DEPLOY_WEBHOOK_URL` or `PIVOTA_AGENT_PROD_DEPLOY_WEBHOOK_URL` is configured
   in GitHub Actions secrets so `production-deploy-promote.yml` can trigger production from the
   `main` push.~~ **Dead path — do not wire this up.** That workflow no longer runs on push, and it
   targeted Railway, not the Cloud Run gateway. Adding the secret would deploy nothing and restore
   the false-green this was removed to stop.

If neither is true, `git push` does not actually own production deploys and the policy is broken.
