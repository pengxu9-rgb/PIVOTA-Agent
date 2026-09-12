# Deploying the gateway

The gateway that serves the agent door runs on **Cloud Run** (`gateway`, project
`pivota-prod`, region `us-west1`). **No CI workflow builds or deploys it.** Every
revision in that service was pushed by `gcloud` from someone's terminal, and until
`cloudbuild.yaml` landed the build shape existed only in Cloud Build history.

## Build

```bash
COMMIT=$(git rev-parse HEAD)
gcloud builds submit --project pivota-shared --config cloudbuild.yaml \
  --substitutions COMMIT_SHA=$COMMIT .
```

Produces `us-west1-docker.pkg.dev/pivota-shared/pivota/gateway:$COMMIT` and `:latest`.

## Deploy

```bash
gcloud run deploy gateway --project pivota-prod --region us-west1 \
  --image us-west1-docker.pkg.dev/pivota-shared/pivota/gateway:$COMMIT
```

An `--image`-only deploy keeps the service account and all existing env vars, so the
385 variables on this service do not need restating.

## Why `/version` can lie, and what fixes it

`src/server.js` resolves the reported commit from the ENVIRONMENT
(`RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` / `SOURCE_VERSION` / `AURORA_GIT_SHA`),
never from the image. The build had been passing `--build-arg COMMIT_SHA` since before
the Dockerfile declared an `ARG` for it, so Docker discarded it — an image genuinely
could not say what it was built from, and `/version` reported whatever the last deploy
happened to inject. The Dockerfile now bakes `GIT_COMMIT_SHA` from the build arg; a
deploy-time env var still overrides it.

## Known: the release gate checks a different service

`Shopping Search Release Gate` has failed on **every commit on main** for at least the
last 8 runs (back past 2026-09-11T00:14Z), including `7d9f1092b9c2`, the revision that
was live while those runs were failing. Both runtime-smoke jobs fail with
`FAIL: deployment commit mismatch`.

`scripts/verify_deployed_commit_matches.sh` probes `INVOKE_BASE_URL`, which defaults to
`https://pivota-agent-production.up.railway.app` — a **Railway** service — while the
agent door is served by Cloud Run. It is a POST-deploy verification wired as a
PRE-deploy gate, pointed at a different deployment target than the one that serves
traffic. Deploying is what would make it pass, not the other way round; treat its red
as unresolved infrastructure, not as a signal about the commit under test.
