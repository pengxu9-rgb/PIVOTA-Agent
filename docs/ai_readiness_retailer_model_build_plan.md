# AI-Readiness — Retailer-Aware Model — Build Plan & Tracker

_From the retailer-vs-brand identity analysis. Goal: the audit serves BOTH D2C brands
AND retailers/resellers, without mis-attributing resold brands to the store. Created
2026-06-18. Order: detect type → de-conflate identity → reframe → store-as-destination._

## North-star
- A **D2C brand** (sells its own products): "is MY brand findable/recommended" — current
  model, correct, must stay unchanged.
- A **retailer/reseller** (sells other brands' products, e.g. Chydan): the resold brands'
  domains (ownist.com) are NOT the store's findability; the retailer's win is being the
  **AI-routed buying destination** for the products it carries. Never label a resold brand's
  presence as the store's.

## The root bug (from the analysis)
`_merchant_identity_tuple` (`agent_center_bd_report_service.py:486-509`) folds EVERY audited
product's `vendor`/`brand` into the merchant identity → `derive_brand_aliases` → any resold
brand's domain is tagged the merchant's `own_domain`/findability. There is no merchant-type
concept (the `merchant_archetype="channel"` path is dead code).

## Locked principle
Identity changes are **type-gated**: a D2C brand's audit must be byte-identical to today; only
a detected reseller gets the corrected attribution. No regressions for brands.

## Progress tracker
| ID | Step | Surface | Status | Notes |
|----|------|---------|--------|-------|
| R0 | ✅ **Detect merchant type** (derive from catalog) — `_audit_merchant_vendors` returns is_reseller; brand_rollup.merchant_type carried | backend | 🟢 merged + deployed | #946 (fe4cd5bf) |
| R1 | ✅ **Reseller-aware identity** — fold a vendor only when it IS the merchant; resold brands excluded → ownist.com no longer the store's findability | backend | 🟢 merged + deployed | #946 (fe4cd5bf) |
| R2 | ✅ **Reframe for resellers** — reseller-context banner: 'this measures YOUR store, not the brands'; defines Findable/Recommended for a retailer | portal | 🟢 merged + deployed | #93 (0f39485) |
| R3 | ✅ **Store-as-destination metric** — store_as_destination {rate, routed_to_instead}; 'Are you the buy destination?' reseller-headline panel | backend + portal | 🟢 merged + deployed | #947 (192f5d5c) + portal #94 (c0f54e6) |

## R0 — Detect merchant type (the foundational design call)
Two ways to know a merchant is a reseller:
- **(A) Derive from catalog (no migration, ship now):** the merchant is a reseller when their
  own brand/domain is NOT the vendor of the products they audit — i.e. NONE of the audited
  products' `vendor` brand-forms match the merchant's own brand/domain brand-forms. Chydan
  (brand=chydan; vendors=NUTRIONE,Ownist → no match) ⇒ reseller. BB Lab (store bblab.shop;
  vendor "BB Lab" → match) ⇒ brand. Robust for the common cases; edge case = a D2C brand whose
  catalog vendor string differs from its store name (rare; would be mis-detected as reseller).
- **(B) Explicit onboarding field (cleaner, needs schema + onboarding UI):** add
  `merchant_type` (brand | retailer) to `merchant_onboarding`; ask at onboarding. Authoritative,
  no heuristic risk, but a migration + UI change + back-fill for existing merchants.
- **Recommended: (A) now (derive), with the result CACHEABLE into a `merchant_type` field later
  (B) for authority.** (A) unblocks R1-R3 immediately; (B) hardens it.

**Implementation of (A):** a pure helper `_merchant_is_reseller(merchant_brand, merchant_host,
product_vendors) -> bool` (reuse `derive_brand_aliases`/brand-form matching). Gate R1 on it.

## R1 — Reseller-aware identity
For a detected reseller, `_merchant_identity_tuple` folds in a product vendor ONLY if it matches
the merchant's own brand/domain (i.e. the merchant IS that brand) — so resold brands are NOT
folded. Result: `ownist.com` is no longer first-party/own_domain for Chydan; it surfaces honestly
as a brand/host AI cites, not "your findability." D2C brands unchanged (their vendor matches).
**Acceptance:** Chydan's audit no longer shows ownist.com/bblab.shop as Chydan's findability; a
D2C brand's audit is unchanged.

## R2 — Reframe sections for resellers
When merchant_type=reseller, the report copy distinguishes "the brands you carry" (NUTRIONE/Ownist
— context) from "your store" (Chydan — the subject). "Findability" for a reseller = is your STORE
cited as a place to buy; "the products you sell" get a separate, honest framing. Portal copy keyed
on a `merchant_type` flag carried on the report.

## R3 — Store-as-destination metric (the real retailer win, bigger)
Measure whether the STORE is the AI-routed buying destination: is `chydan.com` / the Pivota
canonical PDP (`agent.pivota.cc/products/sig_*`) cited as where to buy the products it carries
(vs Amazon / the brand's own site / other retailers)? New signal; ties to the Pivota
canonical-PDP / in-chat-checkout thesis ([[pivota-frontier-citation-architecture]]). Scope
separately after R0-R2 land.

## Open design call (need the user)
1. **R0 detection: derive-from-catalog (A, ship now) vs explicit onboarding field (B)?** Recommend
   A now, graduate to B. (Confirm.)
2. How aggressive should R2's reframe be — relabel a few sections, or a distinct reseller report mode?

## Change log
- 2026-06-18 — plan created from the retailer-vs-brand identity finding. R0 detection is the gate;
  R1 the bug fix (de-conflate); R2 reframe; R3 the store-as-destination metric (bigger, later).
- 2026-06-18 — R0 + R1 SHIPPED (backend #946 → fe4cd5bf). Derive-from-catalog merchant-type detection + reseller-aware identity: `_audit_merchant_vendors` folds a product vendor into the merchant identity ONLY when the vendor IS the merchant (D2C selling its own products); a reseller's resold brands are excluded so their domains (ownist.com) stop being mis-credited as the store's findability. brand_rollup.merchant_type='reseller'|'brand' carried for R2. Type-gated (D2C unchanged). Manifests on the NEXT audit. 55 tests pass. Remaining: R2 (portal reframe copy keyed on merchant_type), R3 (store-as-destination metric — the bigger retailer win).
- 2026-06-18 — R2 SHIPPED (portal #93 → Vercel 0f39485). When merchant_type=reseller, the narrative leads with a context banner clarifying the audit measures whether AI routes shoppers to THE STORE (not whether the resold brands are recommended) + defines the terms for a retailer. R0+R1+R2 = the mis-attribution is fixed AND the page reads right for a reseller. Only R3 (store-as-destination metric — is the store the AI-routed buy path) remains — the bigger retailer-win initiative, scope separately.
- 2026-06-18 — R3 SHIPPED (backend #947 → 192f5d5c, portal #94 → c0f54e6). store_as_destination = for buy-intent (navigational) queries, the store's citation rate + routed_to_instead (the destinations AI named instead, ranked) — reuses existing probe data, no new probes. Portal 'Are you the buy destination?' panel = the reseller Zone-1 headline. THE RETAILER-AWARE MODEL (R0-R3) IS COMPLETE: detect type → de-conflate identity → reframe → measure store-as-destination. Manifests on the next audit.
