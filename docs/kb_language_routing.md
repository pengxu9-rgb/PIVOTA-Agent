# Technique KB Language Routing (v0)

TechniqueCardV0 does **not** have a `language` field. Instead, we route “which language card to use” via `triggers` using the whitelisted trigger key `preferenceMode`.

This is designed to be additive and backward compatible:
- Existing cards without any `preferenceMode` trigger remain language-agnostic.
- New bilingual cards can be added as paired `-zh` / `-en` variants.

## Bilingual card convention

Maintain **two cards** for the same technique:
- `<baseId>-zh`
- `<baseId>-en`

The triggers should be identical except for the language gate:

**ZH card**
```json
{ "key": "preferenceMode", "op": "eq", "value": "zh" }
```

**EN card**
```json
{ "key": "preferenceMode", "op": "eq", "value": "en" }
```

You may also use:
```json
{ "key": "preferenceMode", "op": "in", "value": ["zh"] }
```
or
```json
{ "key": "preferenceMode", "op": "in", "value": ["en"] }
```

## How the backend infers language

The backend infers a `preferenceMode` **language value** (`"zh"` or `"en"`) using the following priority:
1) Explicit `userLanguage` (if present in context)
2) `appLanguage` (if present in context)
3) `locale` (request field)
4) HTTP `Accept-Language`
5) Default `"en"`

Only `"zh*"` is treated as Chinese; everything else defaults to English.

Implementation: `src/layer2/kb/languagePreferenceMode.ts`.

## Fallback behavior

When rendering technique steps for a `doActionId`:
- If language cannot be inferred → treat as `"en"`.
- If inferred language is `"zh"` but the `-zh` card is missing or does not match → fall back to the `-en` card (if available).

This fallback is **language-only** and does not change any other rule selection.

Implementation: `src/layer2/kb/resolveTechniqueCardForLanguage.ts` and used in `src/layer2/personalization/renderSkeletonFromKB.*`.

## Lint rules

KB lints enforce:
- If `id` ends with `-zh`, triggers must include `preferenceMode eq zh` (or `in` containing `zh`).
- If `id` ends with `-en`, triggers must include `preferenceMode eq en` (or `in` containing `en`).

Optional pairing check (warning by default; fail when enabled):
- Run `npm run lint:kb:us -- --strict-pairs` or set `KB_LINT_REQUIRE_LANG_PAIRS=1`.

Scripts:
- `scripts/lint-technique-kb-us.js`
- `scripts/lint-technique-kb-jp.js`

