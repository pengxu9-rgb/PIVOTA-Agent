# Travel EFGH Benchmark Gate

## Scope
- Dataset: `tests/golden/aurora_travel_efgh_4.jsonl`
- Mapping:
  - `E = travel_mt_001`
  - `F = travel_mt_002`
  - `G = travel_mt_003`
  - `H = travel_mt_004`

## Commands

### 1) Local mock sanity
```bash
node scripts/aurora_travel_gate.js \
  --mode local-mock \
  --cases tests/golden/aurora_travel_efgh_4.jsonl \
  --expected-count 4 \
  --report-prefix aurora_travel_efgh_gate
```

### 2) Staging run
```bash
npm run benchmark:travel:multiturn:run -- \
  --base-url https://pivota-agent-staging.up.railway.app \
  --chat-retries 2 \
  --retry-backoff-ms 1200
```

### 3) Production run
```bash
npm run benchmark:travel:multiturn:run -- \
  --base-url https://pivota-agent-production.up.railway.app \
  --chat-retries 2 \
  --retry-backoff-ms 1200
```

### 4) Export scoring packets
```bash
npm run benchmark:travel:multiturn:export -- \
  --run reports/travel-expert-multiturn/runs/multiturn-run-YYYYMMDD_HHMMSS.json
```

## Output contract
- Run report schema: `travel_expert_multiturn_run.v2`
- Bundle schema: `travel_expert_multiturn_scoring_packet.v2`
- Manifest schema: `travel_expert_multiturn_scoring_manifest.v2`
- Score template schema: `travel_expert_scores.v1`

## Delivery files
- `reports/travel-expert-multiturn/runs/multiturn-run-*.json`
- `reports/travel-expert-multiturn/scoring-packets/<token>/aurora_travel_multiturn_scoring_bundle.json`
- `reports/travel-expert-multiturn/scoring-packets/<token>/aurora_travel_multiturn_scoring_bundle.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/case-travel_mt_001.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/case-travel_mt_002.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/case-travel_mt_003.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/case-travel_mt_004.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/efgh_result_summary.md`
- `reports/travel-expert-multiturn/scoring-packets/<token>/external_llm_scoring_prompt.md`
