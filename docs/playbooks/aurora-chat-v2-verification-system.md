# Aurora Chat V2 Verification System

## Scope
This playbook defines the unified verification system for Aurora Chat V2:
- PR lite blocking gate
- Nightly full evaluation
- Online rollout probe integration
- Travel20 dedicated acceptance set

## Pipelines

### 1) PR Lite Blocking
Workflow: `.github/workflows/aurora-chat-pr-lite.yml`

Runs:
1. Targeted node tests
2. `Travel20` local-mock gate

Command:
```bash
npm run gate:aurora:pr-lite
```

Blocking rules:
- Any test/gate failure blocks merge
- `meta_null_count` must be `0`
- `header/meta mismatch` must be `0`

Artifacts:
- `reports/aurora_chat_v2_pr_lite_*.json`
- `reports/aurora_chat_v2_pr_lite_*.md`
- `reports/aurora_travel_gate_*.json`
- `reports/aurora_travel_gate_*.md`

### 2) Nightly Full Evaluation
Workflow: `.github/workflows/aurora-chat-nightly-full.yml`

Runs:
1. `npm run test:aurora-bff:unit`
2. `npm run test:replay-quality`
3. `Travel20` local-mock gate
4. `Travel20` staging-live gate
5. Follow-up canary

Command:
```bash
npm run eval:aurora:nightly-full -- --base "$AURORA_EVAL_BASE_URL"
```

Default base:
- `AURORA_EVAL_BASE_URL`
- fallback: `https://pivota-agent-staging.up.railway.app`

Artifacts:
- `reports/aurora_chat_v2_nightly_full_*.json`
- `reports/aurora_chat_v2_nightly_full_*.md`
- `reports/aurora_travel_gate_*.json`
- `reports/aurora_travel_gate_*.md`
- `reports/chat_followup_canary_nightly_*.md`

### 3) Online Probe (Existing)
Workflow: `.github/workflows/aurora_rollout_probe.yml`

Purpose:
- Detect `meta` null
- Detect header/meta mismatch
- Detect rollout split drift

## Travel20 Definition
Dataset: `tests/golden/aurora_travel_weather_20.jsonl`

Composition:
- `missing_fields`: 8
- `complete_fields`: 8
- `api_fail`: 4
- EN/CN split: `10 / 10`

Validation modes:
- `local-mock`: deterministic weather success/failure injection
- `staging-live`: real environment verification

Gate command:
```bash
npm run gate:aurora:travel20 -- --mode local-mock --strict-meta true
npm run gate:aurora:travel20 -- --mode staging-live --base "$AURORA_EVAL_BASE_URL" --strict-meta false
```

## Expected Assertions

### Missing fields
- `intent_canonical=travel_planning`
- `gate_type=soft`
- required travel fields requested
- no `env_stress` card

### Complete fields
- travel route continues without ask loop
- `env_stress` card present with EPI strategy
- local-mock strict expectation: `env_source=weather_api`

### API fail
- no deadlock
- fallback still returns actionable strategy
- local-mock strict expectation: `env_source=climate_fallback` and `degraded=true`

## Release Gate Positioning
`aurora-bff-release-gate.yml` is release-focused and triggered by:
- `push` to `main`
- `workflow_dispatch`

PR gating is moved to `aurora-chat-pr-lite.yml`.

## Troubleshooting

### `meta` missing
Check:
- `AURORA_CHAT_RESPONSE_META_ENABLED=true`
- response shape from `/v1/chat`

### travel complete case unexpectedly asks fields
Check:
- `intent_canonical` in response meta
- `travel_plan.destination/start_date/end_date` presence in payload

### env_source not weather_api in local-mock
Check:
- `AURORA_TRAVEL_WEATHER_LIVE_ENABLED=true`
- mock fetch path for geocode + forecast

### staging-live instability
If external weather API is unstable:
- allow `climate_fallback` in live mode
- keep `local-mock` as strict deterministic blocker
