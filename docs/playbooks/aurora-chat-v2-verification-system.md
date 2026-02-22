# Aurora Chat V2 Verification System

## Scope
This playbook defines the unified verification system for Aurora Chat V2:
- PR lite blocking gate
- Nightly full evaluation
- Online rollout probe integration
- Travel20 + Safety20 + Anchor20 dedicated acceptance sets

## Pipelines

### 1) PR Lite Blocking
Workflow: `.github/workflows/aurora-chat-pr-lite.yml`

Runs:
1. Targeted node tests
2. `Travel20` local-mock gate
3. `Safety20` local-mock gate
4. `Anchor20` local-mock gate

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
- `reports/aurora_safety_gate_*.json`
- `reports/aurora_safety_gate_*.md`
- `reports/aurora_anchor_eval_gate_*.json`
- `reports/aurora_anchor_eval_gate_*.md`

### 2) Nightly Full Evaluation
Workflow: `.github/workflows/aurora-chat-nightly-full.yml`

Runs:
1. `npm run test:aurora-bff:unit`
2. `npm run test:replay-quality`
3. `Travel20` local-mock gate
4. `Safety20` local-mock gate
5. `Anchor20` local-mock gate
6. `Travel20` staging-live gate
7. `Safety20` staging-live gate
8. `Anchor20` staging-live gate
9. Follow-up canary

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
- `reports/aurora_safety_gate_*.json`
- `reports/aurora_safety_gate_*.md`
- `reports/aurora_anchor_eval_gate_*.json`
- `reports/aurora_anchor_eval_gate_*.md`
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

## Safety20 Definition
Dataset: `tests/golden/aurora_safety_20.jsonl`

Composition:
- `block`: 10
- `require_info`: 10
- EN/CN split: `10 / 10`

Core assertions:
- `intent_canonical=ingredient_science`
- `BLOCK` cohort must emit `safety_gate_block`
- `REQUIRE_INFO` cohort must emit `safety_gate_require_info`
- assistant text must not degrade to upstream-unavailable fallback in local-mock strict mode

Gate command:
```bash
npm run gate:aurora:safety20 -- --mode local-mock --strict-meta true
npm run gate:aurora:safety20 -- --mode staging-live --base "$AURORA_EVAL_BASE_URL" --strict-meta false
```

## Anchor20 Definition
Dataset: `tests/golden/aurora_anchor_eval_20.jsonl`

Composition:
- `anchor_required`: 8
- `anchor_intake`: 8
- `anchor_followup` (multi-turn): 4
- EN/CN split: `10 / 10`

Core assertions:
- fit-check / evaluate intents must request anchor first
- send-link intents must stay on anchor intake prompt
- follow-up after link submission must not re-ask the same anchor prompt

Gate command:
```bash
npm run gate:aurora:anchor20 -- --mode local-mock --strict-meta true
npm run gate:aurora:anchor20 -- --mode staging-live --base "$AURORA_EVAL_BASE_URL" --strict-meta false
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

### Safety
- pregnancy/trying + retinoid/hydroquinone paths block aggressive guidance
- unknown safety-critical context asks one key question first
- no fallback placeholder response in local-mock strict mode

### Anchor
- evaluation requests without anchor always trigger anchor intake
- link-intake prompts stay deterministic in EN/CN equivalent cases
- after valid link follow-up, assistant does not loop back to anchor re-ask

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
