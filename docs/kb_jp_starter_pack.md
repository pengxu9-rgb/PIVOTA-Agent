# JP Technique KB Starter Pack (Internal)

JP is currently an experiment market. The goal of this starter pack is to ship a **useful, safe, deterministic** Technique KB quickly, then iterate using outcome telemetry and analyzer reports.

## Target first batch (50 cards)

Aim for **50 TechniqueCardV0** JSON files in `src/layer2/kb/jp/techniques/`:
- **Eye:** 25
- **Base:** 12
- **Lip:** 13

This batch should cover the most common adjustment intents already routed by `src/layer2/dicts/intents_v0.json` for market `JP`.

## How to import from CSV

Preferred workflow is spreadsheet → CSV → importer:

```bash
npm run kb:import:csv -- --market JP --input /path/to/export.csv --output src/layer2/kb/jp/techniques
```

Then verify mapping integrity:

```bash
npm run kb:check:mapping -- --market JP
```

## Required role hint usage rules

`productRoleHints` must be **role IDs** from `src/layer2/dicts/roles_v0.json` (or their synonyms).

Rules:
- Prefer **2–4 hints** per card (0 is allowed, but avoid it for core eye/base/lip cards).
- Use tool-oriented roles (e.g. `thin_felt_tip_liner`, `smudge_brush`, `puff`) rather than brand/product names.
- Keep role hints consistent across cards that represent the same technique family.
- If the spreadsheet has free-form role names, ensure they normalize via `roles_v0.json` synonyms.

## Trigger best practices for JP

Trigger keys are restricted by `src/layer2/dicts/trigger_keys_v0.json` and validated in:
- `npm run lint:kb:jp`
- `npm run lint:dicts`

Best practices:
- Prefer **simple, robust triggers**: `eq` on categorical fields and `exists` checks.
- Keep triggers **market-agnostic in logic** (they reference the same structured fields), but tune thresholds conservatively.
- Avoid very narrow ranges that will rarely match; we need coverage first, precision later.
- Use `trigger_all` for required preconditions and `trigger_any` for optional qualifiers.
- Avoid conflicting triggers between cards with similar scope; use difficulty/role hints to differentiate instead.

Trigger DSL reminders (CSV):
- Conditions are semicolon-separated: `key op value; key op value`
- Ops: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `between`, `exists`
- `in` values are comma lists: `preferenceMode in structure,ease`
- `between` supports `min..max` or `min,max`

## Lint gates (required)

Before committing JP KB updates, ensure these pass:

```bash
npm run lint:kb:jp
npm run lint:dicts
npm test
```

## Mapping integrity (required)

Intent-to-technique routing for JP is defined in `src/layer2/dicts/intents_v0.json`.
Any `JP.techniqueIds` reference must satisfy:
- the technique JSON exists in `src/layer2/kb/jp/techniques/`, OR
- it is explicitly listed in `intents_v0.json:placeholders` (short-term only).

Use:

```bash
npm run kb:check:mapping -- --market JP
```

If missing IDs exist, the checker prints the exact missing IDs and suggests:
- create the TechniqueCard JSON file, or
- add a placeholder (temporary).

