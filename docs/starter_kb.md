# Starter Technique KB (Internal)

This repo includes a small, generic **starter** Technique KB to make Layer2 demos and internal tests feel complete while the content team is producing licensed TechniqueCards.

## What it is
- Files live under:
  - `src/layer2/kb/us/starter/`
  - `src/layer2/kb/jp/starter/`
- Every starter card must:
  - have `sourceId: "INTERNAL_STARTER"`
  - be brand-free, generic, and original (no copied tutorial wording)
  - use only trigger keys allowed by `src/layer2/dicts/trigger_keys_v0.json`
  - use only canonical role ids in `src/layer2/dicts/roles_v0.json` for `productRoleHints`

## How it’s used
The KB loader loads technique cards in this order:
1) `src/layer2/kb/<market>/techniques/` (canonical)
2) `src/layer2/kb/<market>/starter/` (fallback)

If a canonical technique id exists, it wins. Starter cards are only used when no canonical card exists for an id.

## Regenerating
Generate deterministically from dicts and commit the results:
- `npm run kb:starter:generate -- --market ALL --count 20`

## Replacing with licensed cards
When licensed TechniqueCards are ready:
- add/update files in `src/layer2/kb/<market>/techniques/`
- keep starter cards as a safety fallback (or delete them if you explicitly decide to ship without any fallback coverage)

## Policy
- Starter cards are **internal/demo** scaffolding.
- Do not introduce brand names or identity/celebrity language.
- Treat `sourceId="INTERNAL_STARTER"` as a strict marker; tests enforce it.

