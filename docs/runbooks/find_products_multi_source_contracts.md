# Find Products Multi Source Contracts

As of March 25, 2026, `find_products_multi` source handling is intentionally split by caller contract rather than by endpoint alone.

## Source Profiles

### `search`
- Contract: stable public search
- Default behavior: internal-cache-first, cache-only for generic discovery/category queries
- Guardrail: ignore caller-provided `external_seed_strategy` overrides such as `unified_relevance` and `supplement_internal_first`
- Goal: keep public search deterministic and avoid bypassing a healthy internal cache hit

### `shopping_agent`
- Contract: broad commerce search
- Default behavior: internal cache base plus external supplement when relevant
- Goal: maximize shopping recall without sacrificing internal anchors

### `aurora-bff`
- Contract: broad commerce search for Aurora surfaces
- Default behavior: same retrieval semantics as `shopping_agent`, with Aurora-specific fallback behavior layered on top
- Goal: keep Aurora search semantics aligned with shopping search while preserving BFF/runtime controls

## Caller Rules

- Use `source=search` for public gateway search, stable smoke tests, and deploy verification.
- Use `source=shopping_agent` for shopping agent discovery, recommendations, and broad commerce retrieval.
- Use `source=aurora-bff` for Aurora chat/BFF shopping retrieval.
- Do not rely on `source=search` plus explicit `external_seed_strategy` to widen recall.

## Important Boundary

This contract clamp is intentionally narrow:
- it blocks public-search broadening overrides that were bypassing healthy cache hits
- it does not redefine every strict retrieval path as internal-only

If a future product decision requires a public broad-search surface, add a new explicit source contract instead of overloading `search`.
