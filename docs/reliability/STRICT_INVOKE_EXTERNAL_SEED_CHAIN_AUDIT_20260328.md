# Strict Invoke External Seed Chain Audit

Date: 2026-03-28

## Scope

This note records the remaining agent-side strict invoke issue after the invoke-rail workflow fixes and the backend EUR-budget FX fix were merged to `main`.

## What This Patch Fixes

- `find_products_multi` strict responses were incorrectly dropping `external_seed` products inside
  [`attachEligibleOfferFieldsToSearchResponse`](../../src/server.js).
- The drop happened only during the final agent response-shaping stage.
- Upstream metadata could already show `external_seed_returned_count=1` and `final_returned_count=1`,
  while the top-level `products` array was empty because the response shaper filtered the item out.

This patch preserves `external_seed` products for `strict_constraint_query=true` responses while still
keeping `eligible_only` internal-search responses internal-only.

## Guardrails Preserved

- Internal products still receive `top_offer_summary` / `exact_resolution_identifiers`.
- `external_seed` products are preserved without injecting `internal_checkout` offer metadata.
- Non-strict `eligible_only` responses still filter `external_seed` products out.

## Verified Local Regression Coverage

- `tests/integration/invoke.find_products_multi_strict_surface.test.js`
  - strict EUR-budget non-empty response preserves FX metadata
  - strict external-seed response remains visible and does not gain internal checkout offers
- `tests/integration/invoke.find_products_multi_eligible_only.test.js`
  - non-strict eligible-only response still filters external-seed rows
- `npm run test:commerce-core:milestone0`

## Production Read-Only Validation Snapshot

Authenticated invoke rail at `https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke`:

- `vitamin c serum under €30`
  - `total = 1`
  - `budget_fx_applied = true`
  - `budget_fx_source = static_default`
  - `budget_fx_unresolved = false`
  - `fallback_triggered = false`
  - `service_commit = 85e0806bee50`

## Remaining Associated Issues Not Solved By This Patch

These are separate runtime issues and should not be conflated with the strict external-seed response fix:

- `IPSA Time Reset Aqua`
  - currently returns broad `cache_cross_merchant_search`
  - first result is not constrained to an exact lookup lane
- `IPSA products`
  - currently also returns broad `cache_cross_merchant_search`

Both queries currently resolve to the same broad cache lane on production, so exact lookup and merchant-ish
query routing still need separate hardening on `main`.
