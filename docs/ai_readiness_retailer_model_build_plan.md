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
| R0 | **Detect merchant type** (reseller vs brand) | backend | ☐ | the gate everything hangs on |
| R1 | **Reseller-aware identity** — don't fold resold brands into the store's own_domain | backend | ☐ | fixes the ownist.com mis-attribution |
| R2 | **Reframe the sections for resellers** — findability/endorsement copy reflects "the brands you carry" vs "your store" honestly | portal | ☐ | so the numbers read right |
| R3 | **Store-as-destination metric** — is the STORE (chydan.com / Pivota canonical PDP) the AI-routed buy path? | backend + portal | ☐ | the real retailer win; bigger |

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
