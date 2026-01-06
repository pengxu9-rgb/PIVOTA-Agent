# Recommendations Feed API (role → feed)

Goal: isolate agent uncertainty into **role selection**, while keeping supply + parsing deterministic and governable.

## Endpoints

## Auth (internal)

If `RECOMMENDATIONS_INTERNAL_KEY` is set, callers must provide `X-Internal-Key: <value>`.

In production (`NODE_ENV=production` or `APP_ENV=production`), `RECOMMENDATIONS_INTERNAL_KEY` is required.

### 1) Normalize role hints

`POST /v1/recommendations/roles/normalize`

Request:
```json
{ "roleHints": ["liner", "blending brush"] }
```

Response (example):
```json
{
  "normalizedRoles": [
    { "inputHint": "liner", "normalizedRoleId": "ROLE:liner", "confidence": 1, "reason": "matched_id" },
    { "inputHint": "blending brush", "normalizedRoleId": "ROLE:blending_brush", "confidence": 0.9, "reason": "matched_synonym" }
  ],
  "meta": { "roleTaxonomyVersion": "v1", "roleTaxonomySha": "…", "generatedAt": "…" }
}
```

### 2) Assemble a feed from roles

`POST /v1/recommendations/feed`

Request fields:
- `market`: `"US" | "JP"`
- `locale?`: string
- `roleIds?`: `string[]` (must be prefixed with `ROLE:`)
- `roleHints?`: `string[]` (will be normalized using `roles_v1.json`)
- `maxOffersPerRole?`: number (default `2`)
- `maxTotalOffers?`: number (default `20`)
- `diversity?`:
  - `domainCapPerRole?` (default `2`)
  - `domainCapGlobal?` (default `50`)
  - `dedupe?`: `"global" | "perRole"` (default `global`)
- `resolve?`: `"deferred" | "none" | "inline"` (default `deferred`)
- `debug?`:
  - `includeMapping?` (default `true` when roleHints is present)
  - `includeFilterReasons?` (default `false`)

Response (deferred example):
```json
{
  "normalizedRoles": [{ "inputHint": "liner", "normalizedRoleId": "ROLE:liner", "confidence": 1, "reason": "matched_id" }],
  "feedItems": [
    {
      "roleId": "ROLE:thin_felt_tip_liner",
      "urls": [
        { "url": "https://example.com/p/1", "domain": "example.com", "priority": 90, "source": "pool", "offerKey": "offer_…" }
      ],
      "truncated": false
    }
  ],
  "meta": {
    "requestId": "…",
    "generatedAt": "…",
    "ttlSeconds": 3600,
    "configVersion": "…",
    "roleTaxonomyVersion": "v1",
    "roleTaxonomySha": "…"
  }
}
```

Notes:
- URLs are canonicalized (tracking params stripped) using `src/layer3/external/urlUtils.ts`.
- `offerKey` is a stable hash derived from canonical URL (same as `offerId` from the resolver).
- Allowed domains come from `EXTERNAL_OFFER_ALLOWED_DOMAINS_US|JP` (env) with a dev fallback to `src/layer3/data/external_allowlist_US.txt|JP.txt`.
