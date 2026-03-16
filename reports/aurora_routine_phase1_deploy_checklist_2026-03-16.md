# Aurora Routine Phase 1.1 Deploy Checklist

## Scope
- Goal: deploy and validate the minimal `routine builder` explicit-routing slice only.
- Repos in scope:
  - Frontend: `~/dev/pivota-aurora-chatbox`
  - Backend: `~/dev/PIVOTA-Agent`
- This checklist is for deployment prep and rollout sequencing only. It does not assume any additional module development.

## Deploy Surface Truth

### Frontend
- Hosting config is `vercel.json`.
- Build command from `package.json`: `npm run build`
- Build expands to: `npm run typecheck && vite build`
- Node version pinned by both `.node-version` and `.nvmrc`: `20`
- No checked-in `.vercel/project.json` was found in repo, so project binding is not source-controlled here.

### Backend
- Container build is driven by `Dockerfile`.
- Runtime command: `node src/server.js`
- Health endpoint used by container healthcheck: `GET /healthz`
- Node version pinned by both `.node-version` and `.nvmrc`: `20`
- `.railwayignore` exists and excludes `reports/`, `.env*`, `node_modules/`, etc.

## Critical Env / Routing Facts

### Frontend compile-time flags
- `VITE_FF_AURORA_ROUTINE_BUILDER_VIA_SKILL`
  - Current code default: `false`
  - This is a Vite build-time env, not a runtime remote flag.
- Existing compile-time skill flags already in code:
  - `VITE_FF_AURORA_PRODUCT_ANALYZE_VIA_SKILL`
  - `VITE_FF_AURORA_DUPE_SEARCH_VIA_SKILL`
  - `VITE_FF_AURORA_DUPE_COMPARE_VIA_SKILL`

### Frontend backend target
- `src/lib/pivotaAgentBff.ts` resolves backend base URL in this order:
  1. `VITE_PIVOTA_AGENT_URL`
  2. `VITE_SHOP_GATEWAY_URL`
  3. default hardcoded production Railway URL
- `vercel.json` also rewrites `/v1/*`, `/v2/*`, `/health*`, `/metrics` to `https://pivota-agent-production.up.railway.app`

### Operational implication
- A Vercel preview deploy is **not isolated by default**:
  - if `VITE_PIVOTA_AGENT_URL` points to production, preview still hits production
  - if the app uses relative `/v1/*`, `vercel.json` still rewrites to production
- So “preview first” only helps if env/rewrite strategy is explicitly changed. In the current checked-in setup, preview still exercises production backend.

## Backend Verification Hooks
- Production commit verification script exists:
  - `scripts/verify_deployed_commit_matches.sh`
- Script behavior:
  - polls `https://pivota-agent-production.up.railway.app/v1/session/bootstrap`
  - reads `x-service-commit`
  - compares against local git SHA

## Pre-Deploy Checks

### Frontend local checks
- `npm run typecheck`
- `npm run build`
- Targeted tests for this slice:
  - `npx vitest run src/test/agent_state_machine.test.ts src/test/bffchat_routine_skill_route.test.tsx src/test/bffchat_routine_entry_stability.test.tsx`

### Backend local checks
- `node --check src/auroraBff/orchestrator/skill_router.js`
- `node --check src/auroraBff/agentStateMachine.js`
- `node --test tests/aurora_chat_v2_diagnosis_start.node.test.cjs`
- `npx jest tests/aurora_bff.test.js -t "Routine: chip.start.routine is recognized by state machine from IDLE_CHAT" --runInBand`

## Recommended Rollout Sequence

### Step 1: Backend deploy first
- Reason:
  - frontend flag-off path still falls back locally, but backend should be ready before any flag-on validation
  - backend routing/state-machine fix is low blast-radius and independently verifiable

### Step 2: Verify backend commit
- Run:
```bash
cd ~/dev/PIVOTA-Agent
BASE_URL=https://pivota-agent-production.up.railway.app \
TARGET_COMMIT=$(git rev-parse --short=12 HEAD) \
bash scripts/verify_deployed_commit_matches.sh
```

### Step 3: Frontend production deploy with `VITE_FF_AURORA_ROUTINE_BUILDER_VIA_SKILL=false`
- This is the safe landing build.
- Expected behavior after deploy:
  - Home / Routine page now enter via `chip.start.routine`
  - `chip.start.routine` resolves to `ROUTINE_INTAKE`
  - UI still opens local routine sheet
  - no live user depends on `routine.apply_blueprint` yet

### Step 4: Run live test on production with flag-off build
- Minimum checklist:
  - Home -> routine builder
  - Routine page -> start builder
  - deeplink `chip.start.routine`
  - legacy `open=routine`
  - routine form -> `Save & analyze`
  - diagnosis follow-up -> routine
  - confirm no unexpected `/v1/chat` dependency on routine entry when flag is off

### Step 5: Only after Step 4 passes, validate flag-on build
- Because this flag is compile-time, flag-on validation requires a separate frontend build/deploy.
- In current repo setup, do **not** assume preview is isolated from production backend.
- Safe choices:
  - deploy a separate preview build knowingly hitting production backend but only for operator testing
  - or deploy a second production build in a controlled window after Step 4 sign-off

### Step 6: Flag-on validation checklist
- Confirm:
  - `chip.start.routine -> /v1/chat -> routine.apply_blueprint`
  - valid `routine` card renders and does not open local sheet
  - missing/invalid skill payload falls back to local routine sheet
  - `routine.intake_products` follow-up opens local intake sheet and does not loop through `chip.start.routine`
  - telemetry appears:
    - `aurora_skill_route_result`
    - `aurora_skill_route_fallback`

## Do Not Do
- Do not combine this rollout with new `ingredient`, `travel`, or `tracker` migrations.
- Do not treat `VITE_FF_AURORA_ROUTINE_BUILDER_VIA_SKILL` as a runtime toggle; it is a build toggle.
- Do not assume Vercel preview is isolated unless frontend env/rewrite targets are explicitly changed.

## Current Unknowns
- No checked-in Vercel project binding is present, so the exact Vercel project name / alias mapping is outside repo state.
- No checked-in Railway service config beyond `Dockerfile` and `.railwayignore` is present, so deploy trigger specifics appear to live in Railway dashboard or external integration.
