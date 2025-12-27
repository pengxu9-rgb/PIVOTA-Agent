# Frozen Dicts (v0) — Single Source of Truth

This repo treats the JSON files under `src/layer2/dicts/` as the **only source of truth** for Layer2/3 controlled vocabularies and routing maps.

These dicts are intentionally **frozen + versioned** so that:
- backend behavior is deterministic and reviewable
- contract fixtures stay stable
- markets are isolated (US vs JP)

## Files

- `src/layer2/dicts/lookspec_lexicon_v0.json`
  - Market-aware LookSpec controlled vocabularies (US + JP).
- `src/layer2/dicts/vibe_tags_us_v0.json`
- `src/layer2/dicts/vibe_tags_jp_v0.json`
  - Market-isolated vibe tag IDs (JP includes optional display labels).
- `src/layer2/dicts/trigger_keys_v0.json`
  - Whitelist of allowed trigger keys used in Technique KB `triggers`.
- `src/layer2/dicts/roles_v0.json`
  - Role hints dictionary (canonical IDs + synonyms + normalization rules).
- `src/layer2/dicts/intents_v0.json`
  - Intent → technique ID mappings per market (used by rule engines).

## Update policy (add-only)

These dicts are **add-only**:
- Do not delete or rename existing IDs.
- Prefer adding new IDs and leaving old ones in place.
- If something must be deprecated, keep the ID but stop producing it from code paths (or mark it in the dict in a backward-compatible way).

Reason: older jobs/fixtures may reference historic IDs, and we want replays + analysis to remain valid.

## Linting

Run:
- `npm run lint:dicts`

It validates:
- ID uniqueness + ASCII constraints
- size bounds (vibe tags, roles, intents)
- Technique KB trigger keys only use `trigger_keys_v0.json`
- intent mappings reference existing technique IDs (or declared placeholders)

`npm test` runs `lint:dicts` automatically via `pretest`.

## Integrity tests

Jest includes a deterministic integrity suite:
- `tests/layer2/dicts_integrity.test.ts`

It asserts that:
- contract LookSpec fixtures stay within the frozen lexicon + vibe tag dicts
- Technique KB trigger keys are whitelisted by `trigger_keys_v0.json`
- Technique KB `productRoleHints` normalize to `roles_v0.json` IDs
- `intents_v0.json` only references technique IDs present in the market KB (or declared placeholders)

## Smoke script

Run a minimal in-memory pipeline (no images) for both markets:
- `npm run smoke:layer2`

This loads contract fixtures and exercises:
- adjustment selection (US rules; JP deterministic fallback intents)
- KB rendering
- deterministic step-plan fallback (LLM disabled)
