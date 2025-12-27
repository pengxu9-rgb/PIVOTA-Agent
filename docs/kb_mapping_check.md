# Technique KB Mapping Check

This repo keeps a frozen intent → technique mapping in `src/layer2/dicts/intents_v0.json`.

For each market, every `techniqueId` referenced by an intent must be either:
- present as a `TechniqueCardV0` JSON file under `src/layer2/kb/<market>/techniques/`, or
- explicitly allowed as a temporary placeholder in `src/layer2/dicts/intents_v0.json.placeholders`.

## Command

```bash
npm run kb:check:mapping -- --market JP
```

CI mode (non-zero exit code when missing non-placeholder ids exist):

```bash
npm run kb:check:mapping -- --market JP --ci
```

## Output

The command prints:
- Missing technique ids grouped by intent
- “Top missing intents” ranked by the number of unique missing technique ids

## How to fix missing ids

For each missing technique id, choose one:
1) Create the missing technique card:
   - `src/layer2/kb/<market>/techniques/<TECHNIQUE_ID>.json`
2) Short-term only: add the id to `src/layer2/dicts/intents_v0.json.placeholders`

