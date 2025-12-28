# Starter Technique KB (Internal)

This repo includes a small, generic **starter** Technique KB to make Layer2 demos and internal tests feel complete while the content team is producing licensed TechniqueCards.

## What it is
- Files live under:
  - `src/layer2/kb/us/starter/`
  - `src/layer2/kb/jp/starter/`
- Every starter card must:
  - have `sourceId: "INTERNAL_STARTER"`
  - be brand-free, generic, and original (no copied tutorial wording)
  - use only trigger keys allowed by `src/layer2/dicts/trigger_keys_v1.json`
  - use only canonical role ids in `src/layer2/dicts/roles_v1.json` for `productRoleHints`
  - include tags `starter` and `reviewStatus:approved` (we keep schema strict, so review status is encoded as a tag)

## How it’s used
The KB loader loads technique cards in this order:
1) `src/layer2/kb/<market>/techniques/` (canonical)
2) `src/layer2/kb/<market>/starter/` (fallback)

If a canonical technique id exists, it wins. Starter cards are only used when no canonical card exists for an id.

Starter cards are gated by `ENABLE_STARTER_KB`:
- Default: enabled when `NODE_ENV !== "production"`, disabled in production.
- Override:
  - `ENABLE_STARTER_KB=1` to force-enable
  - `ENABLE_STARTER_KB=0` to force-disable

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
