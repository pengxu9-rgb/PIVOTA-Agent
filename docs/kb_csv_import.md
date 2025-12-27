# Technique KB CSV Import

This repo supports importing Technique KB cards from a spreadsheet export (CSV) into `TechniqueCardV0` JSON files.

## Command

```bash
npm run kb:import:csv -- --market JP --input /path/to/techniques.csv --output src/layer2/kb/jp/techniques
```

Options:
- `--market` (required): `US` or `JP`
- `--input` (required): path to a CSV file
- `--output` (optional): output directory (defaults to `src/layer2/kb/<market>/techniques`)
- `--on-duplicate` (optional): `reject` (default) or `update` (overwrite existing JSON files)
- `--prepare-pr` (optional): runs `kb:prepare-pr` dry-run if that script exists

After writing files, the importer runs `npm run lint:kb:<market>` to ensure the KB stays valid.

## CSV Columns (exact names)

Required:
- `id`
- `market` (must match `--market`; can be blank to inherit `--market`)
- `area` (`base` | `eye` | `lip`)
- `difficulty` (`easy` | `medium` | `hard`)
- `title`
- `step1`..`step6` (2–6 total non-empty; each ≤ 120 chars)
- `why1`..`why3` (at least 1 total non-empty)

Triggers (optional):
- `trigger_all`
- `trigger_any`
- `trigger_none`

Role hints (optional):
- `productRoleHint1`..`productRoleHint5`

Metadata (optional):
- `sourceId`
- `sourcePointer`
- `tags` (comma- or semicolon-separated list)

## Trigger DSL

Each trigger cell is a semicolon-separated list of conditions, each in the form:

```
key op value
```

Supported ops:
- `eq`, `neq`, `lt`, `lte`, `gt`, `gte`
- `in` (comma list)
- `between` (`min..max` or `min,max`)
- `exists` (no value)

Examples:
- `lookSpec.breakdown.eye.intent eq cat_eye; userFaceProfile.geometry.eyeTiltDeg lt 0`
- `preferenceMode in structure,ease`
- `similarityReport.delta between -10..10`
- `refFaceProfile.categorical.eyeType exists`

Trigger keys are validated against `src/layer2/dicts/trigger_keys_v0.json`.

## Product role hints

`productRoleHint*` values are normalized and validated using `src/layer2/dicts/roles_v0.json`.
Use canonical role IDs or their defined synonyms (e.g. `thin felt-tip liner` → `thin_felt_tip_liner`).

