# Layer2 Technique KB (US)

This repo uses a **rules-first** Layer2 personalization pipeline. For adjustments, we generate deterministic skeletons (one per impact area: base/eye/lip), then render user-facing action text from a **Technique Knowledge Base (KB)**.

## What is a Technique Card?

A Technique Card is a small, reusable “action fragment” with:
- deterministic triggers (declarative conditions, no code execution)
- a brand-free action template (atomic steps)
- short rationale bullets
- optional safety notes and product role hints

Schema: `src/layer2/schemas/techniqueCardV0.ts`

Cards live under: `src/layer2/kb/us/techniques/*.json` (US-only).

## How it’s used in Layer2 adjustments

Pipeline:
1. Rule engine selects one rule per area (base/eye/lip) and emits:
   - `doActionIds: string[]` (2–4 technique ids)
   - `becauseFacts`, `whyMechanism`, `evidenceKeys` (facts-locked)
2. Renderer expands `doActionIds` into `doActions: string[]` by loading the KB and rendering `actionTemplate.steps`.
3. LLM rephrase is **style-only**: it may paraphrase the rendered text but must not introduce new facts or new actions.
4. If validation fails, we fall back to deterministic rendering.

Renderer: `src/layer2/personalization/renderSkeletonFromKB.ts`

## Adding a new technique card

1. Add a new JSON file under `src/layer2/kb/us/techniques/`:
   - Choose a unique `id` (prefix `T_`).
   - Set `area` to `base|eye|lip`.
   - Keep `actionTemplate.steps` short, original, and brand-free.
2. Triggers:
   - Only use allowed keys (see below).
   - Use declarative ops only (`lt|lte|gt|gte|eq|neq|in|between|exists`).
3. Run lint:
   - `npm run lint:kb:us`

## Allowed trigger keys

Lint is conservative and currently allows these prefixes:
- `preferenceMode`
- `userFaceProfile.geometry.*`
- `userFaceProfile.quality.*`
- `userFaceProfile.categorical.*`
- `refFaceProfile.geometry.*`
- `refFaceProfile.quality.*`
- `refFaceProfile.categorical.*`
- `lookSpec.breakdown.base.*`
- `lookSpec.breakdown.eye.*`
- `lookSpec.breakdown.lip.*`
- `similarityReport.*`

## RuleId → Technique IDs mapping

Rules (e.g. `EYE_LINER_DIRECTION_ADAPT`) select a small set of technique ids. This mapping lives in:
- `src/layer2/personalization/rules/usAdjustmentRules.ts`

## Safety + non-copyright guidance

- Technique steps must be **original** text. Do not copy/paste from tutorials or brand copy.
- Do not include identity/celebrity language ("look like", "resemble", etc.).
- Keep steps generic and safe; use `safetyNotes` where appropriate.

