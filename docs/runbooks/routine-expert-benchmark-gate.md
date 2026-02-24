# Routine Expert Benchmark Gate Runbook

## Goal
- Evaluate `Routine Expert` output quality against Gemini baseline on the fixed 120-case set.
- Enforce gates:
1. `aurora_mean >= gemini_mean * 1.15`
2. `aurora_safety_violations == 0`
3. `aurora_module_completeness >= 0.95`

## Files
- Dataset: `datasets/routine_expert_benchmark_120.json`
- Multiturn seed dataset (bootstrapping): `datasets/routine_expert_multiturn_seed.json`
- Score templates:
1. `reports/routine-expert/aurora_scores.template.json`
2. `reports/routine-expert/gemini_scores.template.json`
- Runtime score files (input to gate):
1. `reports/routine-expert/aurora_scores.json`
2. `reports/routine-expert/gemini_scores.json`

## Local usage
1. Generate or refresh dataset:
`npm run benchmark:routine:dataset`
2. Generate score templates:
`npm run benchmark:routine:init-templates -- --force true`
3. Copy templates to runtime score files and fill real scores:
`cp reports/routine-expert/aurora_scores.template.json reports/routine-expert/aurora_scores.json`
`cp reports/routine-expert/gemini_scores.template.json reports/routine-expert/gemini_scores.json`
4. Run gate:
`npm run gate:routine-expert:benchmark`

## Multiturn quickstart (seed)
0. Run the 4-turn-case conversations against `/v1/chat` and export raw run report:
`npm run benchmark:routine:multiturn:run`

1. Generate multiturn templates from seed dataset:
`npm run benchmark:routine:multiturn:init-templates -- --force true`
2. Fill runtime score files:
`cp reports/routine-expert-multiturn/aurora_scores.template.json reports/routine-expert-multiturn/aurora_scores.json`
`cp reports/routine-expert-multiturn/gemini_scores.template.json reports/routine-expert-multiturn/gemini_scores.json`
3. Evaluate:
`npm run benchmark:routine:multiturn:eval`

Notes:
- The evaluator/template builder now reads dimensions from `rubric_dimensions` in dataset JSON.
- If `totals.total` does not match `cases.length`, scripts warn and continue using `cases.length`.

## Output
- JSON: `reports/routine-expert-benchmark-YYYYMMDD.json`
- Markdown: `reports/routine-expert-benchmark-YYYYMMDD.md`

## CI
- Workflow: `.github/workflows/routine-expert-benchmark-gate.yml`
- PR behavior:
1. Always regenerates dataset and templates.
2. Runs gate only if both runtime score files exist.
- Manual dispatch behavior:
1. Runs gate with input paths.
2. Missing score files causes failure (intended fail-fast).
