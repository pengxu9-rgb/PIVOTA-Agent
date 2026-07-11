# Quarantined suites

## product_search_proxy_route.test.js.quarantined_20260711

Quarantined 2026-07-11 (jest burndown, branch `fix/jest-burndown-20260711`).

**Why:** 67 of 69 tests red since before the 2026-06-08 graft. The whole ~6,300-line
suite is written against the retired proxy topology for
`GET /agent/v1/products/search` — GET v1 upstream bridge, resolver-first/resolver-fallback
flag matrix, invoke-secondary-fallback chains, and legacy soft-fallback payload shapes.
The route now serves via the `beauty_external_seed_mainline` orchestration, so the
suite's nock expectations and response-shape assertions no longer describe the product.
Rewriting it wholesale was out of scope for the burndown, so it was renamed out of
jest's `testMatch` rather than deleted (the file is preserved verbatim next to this
note as a reference corpus).

**Do not** revive it by renaming back; individual cases should be rewritten against
the mainline contract instead.

### REWRITTEN 2026-07-11 → `tests/products/product_search_proxy_route.test.js`

8 of the 10 highest-value cases (all 6 priority cases + #5, #6) were re-expressed
against the current mainline and land GREEN in the new
`tests/products/product_search_proxy_route.test.js`. The rewrite drives
`POST /agent/shop/v1/invoke {operation:find_products_multi}` — the entry the public
GET route now delegates into (`handleAgentProductsSearchViaInvoke → handleInvokeRequest`,
src/server.js ~34608) — and preserves the anti-bridge invariant by nocking the retired
GET `/agent/v1(/v2)/products/search` routes and asserting they are never hit. It
exercises all three surviving lanes: `authoritative_shopping` (POST v2 transport),
`beauty_external_seed_mainline` (DB external_product_seeds recall), and
`ingredient_recall_direct` (DB canonical-chain + seed recall).

Ported (green):
- #1 route ownership (L523) → "shopping-agent source owns the main path via the authoritative v2 transport"
- #2 v2 contract mismatch / no legacy bridge (L703) → "v2 contract mismatch (422) does not bridge to the legacy GET search route"
- #3 supplement stays off old GET routes (L778) → "beauty query serves from the external-seed mainline and never the legacy GET routes"
- #4 ingredient direct-recall entry (L476) → "ingredient-intent query resolves on the direct lane and bypasses the legacy aurora GET bridge"
- #5 direct recall before fallback (L3160) → "ingredient-intent direct recall serves canonical-chain rows without any invoke fallback"
- #6 honest direct-empty miss (L3743) → "ingredient-intent empty recall returns direct-empty with explicit miss reason, not a clarify"
- #7 external-seed direct products (L2941) → "external-seed recall returns direct seed products carrying merchant_id=external_seed"
- #10 terminal strict_empty failure (L1189) → "upstream 5xx returns strict_empty without adopting any legacy fallback"

Still un-ported (this corpus file is kept as their reference):
- #8 `ingredient_plan_guidance_only server-owned ladder fastpath bypasses legacy
  fallback layers` (L5067) — original asserts the retired `products_cache pc JOIN
  merchant_onboarding mo` lane; the guidance fastpath now needs its own current-contract probe.
- #9 `invoke brand-like shopping queries rescue local external seeds after upstream
  seed loader strict-empty` (L5987) — the "after upstream seed loader strict-empty"
  precondition can't be modeled reliably without brittle upstream-loader mocking.
- #11 (fold-in) `ingredient-intent direct recall collapses sunscreen refill and shade
  variants` (L3647) — near-dup collapse is gated OFF by default
  (`PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED=false`) and its refill/shade dedupe
  semantics are too flaky to pin without a dedicated probe. Deferred to keep the suite green.

### Retired (do not rewrite)

Everything else — in particular the resolver-first/resolver-fallback flag matrix
(L380–L2395), the two-pass primary/semantic-retry fallback chains (L945–L2891), and
the legacy timeout/budget cases (L1345, L2891) — asserts plumbing that no longer
exists on the mainline route.

Note: route-level tests for the mainline are viable again via nock since the proxy-env
scrub landed (PR #1754); new tests should follow the `shopping_mainline` suite's
pattern.
