# Deploy Policy: GitHub Push Only (Production)

## Policy

Production deployment source of truth is **GitHub `main`**.

- Allowed: merge to `main` -> Railway auto-deploy from GitHub.
- Disallowed for normal flow: manual `railway up` to production.

Reason: manual `railway up` can be overwritten by later GitHub auto-deploy and causes commit drift.

## Standard Deployment Flow

1. Commit code in feature branch.
2. Open PR and pass CI.
3. Merge PR into `main`.
4. Wait for Railway auto-deploy.
5. Verify deployed commit matches merged commit:

```bash
BASE_URL="https://pivota-agent-production.up.railway.app" \
TARGET_COMMIT="$(git rev-parse --short=12 HEAD)" \
bash scripts/verify_deployed_commit_matches.sh
```

6. Run runtime smoke gate (already covered by `.github/workflows/aurora-bff-release-gate.yml` on `push main`).
7. Keep the production drift guard enabled:

```bash
gh workflow run production-deploy-drift-guard.yml
```

This verifies that production `/version.commit` still matches GitHub `main`. If production drifts to an older deployment and the rollback webhook is configured, the guard will trigger rollback automatically.

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
The scheduled workflow `.github/workflows/production-deploy-drift-guard.yml` is the backstop that catches later drift or an accidental old redeploy.
