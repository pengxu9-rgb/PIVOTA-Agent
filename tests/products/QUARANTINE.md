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

### Highest-value cases to rewrite against the mainline contract (~10, in priority order)

Line numbers refer to the quarantined file.

1. `shopping-agent source forces strict main path on public search route` (L523) —
   route-ownership guarantee for the public search surface; the core "who owns the
   decision" assertion.
2. `v2 primary contract mismatch does not fall back to legacy public search bridge`
   (L703) — anti-regression guard that retired GET-bridge fallbacks stay dead.
3. `public beauty second-stage supplement stays on v2 transport instead of old GET
   search routes` (L778) — same guard for the supplement leg.
4. `generic beauty ingredient queries bypass legacy aurora GET bridge and resolve on
   the local direct path` (L476) — ingredient direct-recall entry condition.
5. `ingredient-intent search uses direct KB and attached-seed recall before invoke
   fallback` (L3160) — the ingredient recall ladder ordering.
6. `ingredient-intent search returns direct-empty with explicit miss reason before
   generic clarify` (L3743) — honest-miss semantics (strict_empty + reason) instead of
   generic clarification.
7. `external_seed_only search returns direct seed products for guidance discovery`
   (L2941) — guidance discovery direct path over external seeds.
8. `ingredient_plan_guidance_only server-owned ladder fastpath bypasses legacy
   fallback layers` (L5067) — guidance fastpath ownership.
9. `invoke brand-like shopping queries rescue local external seeds after upstream seed
   loader strict-empty` (L5987) — local-seed rescue behavior on upstream miss.
10. `aurora source returns strict_empty with fallback_strategy when primary and
    secondary both fail` (L1189) — terminal failure contract (strict_empty metadata),
    re-expressed for the mainline's failure semantics.

Also worth folding in while rewriting #5/#6: the variant-collapse case
(`ingredient-intent direct recall collapses sunscreen refill and shade variants`,
L3647), which covers user-visible dedupe quality.

### Retired (do not rewrite)

Everything else — in particular the resolver-first/resolver-fallback flag matrix
(L380–L2395), the two-pass primary/semantic-retry fallback chains (L945–L2891), and
the legacy timeout/budget cases (L1345, L2891) — asserts plumbing that no longer
exists on the mainline route.

Note: route-level tests for the mainline are viable again via nock since the proxy-env
scrub landed (PR #1754); new tests should follow the `shopping_mainline` suite's
pattern.
