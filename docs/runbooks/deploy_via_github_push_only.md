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

## Fast Local Check

From repo root:

```bash
npm run deploy:verify:production
```

This checks `x-service-commit` from `/v1/session/bootstrap` against local `HEAD` short SHA.

## Emergency Exception

If manual `railway up` is unavoidable:

1. Record incident reason in PR/runbook.
2. Immediately backfill by pushing the exact same code to GitHub `main`.
3. Re-run commit match verification until pass.

Do not keep production in a state where deployed commit is not traceable to `main`.
