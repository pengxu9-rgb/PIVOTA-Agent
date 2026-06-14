# evidence_claims contract reconciliation (Tier-G item 8 ↔ feat/pdp-evidence-claims-read)

**Date:** 2026-06-14. Two sessions converged on the same feature from opposite
ends — this records the reconciled contract and what item 9 must decide jointly.

## Canonical claim atom (authoritative)

Defined in pivota-backend `models/catalog.py`, consumed by the read side
(`pdpReviewedIngredientAuthority.fetchEvidenceProfileForContentKey`):

```
ProductClaim   { claim_text, source_ref, source_type, evidence_grade, substantiation_status }
EvidenceProfile{ claims: ProductClaim[], review_state }
```
- `source_type` e.g. `ingredient_mechanism` (services/beauty_evidence.py)
- `substantiation_status` ∈ `unverified | substantiated | flagged | rejected` (services/claim_safety.py)
- `review_state` ∈ `observed | reviewed | flagged`
- Plus `RequiredDisclaimer { code, text, applies_to }`

## Two producers, one atom

| Producer | Source | Status |
|---|---|---|
| Supplier-evidence intake (`beauty_evidence.py` → `beauty_product_profiles.evidence_profile`) | INCI-substantiated benefit claims, brand-official precedence by content_key | read side built (`feat/pdp-evidence-claims-read`) |
| **Grounded generator** (`src/groundedProductIntel.js`, this PR) | ingredient KB mechanism + grade + citations + marketing-vs-reality | item 8 |

Both now emit the **same `ProductClaim` atom**. The read side attaches
`product.evidence_profile.claims` (fill-only-when-absent, best-effort).

## This generator's alignment (applied)

Field map the generator now emits (was `evidence_claims[]{claim,evidence_type,confidence}`):

| Was | Now (canonical) | Note |
|---|---|---|
| `claim` | `claim_text` | asserted benefit sentence |
| `drivers[]` (joined) | `source_ref` | the active(s) — traces the claim |
| `evidence_type` | `source_type` | `ingredient_mechanism`; **new value `marketing_vs_reality`** (extension) |
| KB grade | `evidence_grade` | A/B/C — **direct map** (ProductClaim already has this field) |
| `confidence` | `substantiation_status` | graded→`substantiated`; myth→`flagged` |
| — | `evidence_review_state` | `observed` (automated grounded; not human `reviewed`) |

Additive (kept, ignored by strict consumers): `drivers[]`, `mechanism`,
`confidence`, `source_refs[]` (citation URLs), `concern`, `finding` (mvr reality).

To produce a strict `EvidenceProfile`: take `evidence_claims`, project to the 5
canonical fields, wrap as `{ claims, review_state: evidence_review_state }`.

## Decided — item 9 joint decisions (resolved 2026-06-14)

The four open questions were decided jointly and item 9 was built on them.

1. **Container unification → no rename; disambiguate by level + type.** Renaming
   either shipped field is pure churn, so they stay — distinguished by *where* and
   *what type* they are:
   - `product_intel_core.evidence_profile` = a **string** quality-tier enum
     (`grounded_verified` | `seller_only` | `pivota_reviewed` | …). The gate reads this.
   - product-level `evidence_profile` = the **object** canonical
     `EvidenceProfile { claims, review_state }` the read side attaches from
     `beauty_product_profiles`.
   - The bundle's claims live at `product_intel_core.evidence_claims[]` and
     **project** into the product-level `EvidenceProfile` (5 canonical fields +
     `review_state = evidence_review_state`).

   They never collide (different paths). Rule of thumb: *string `evidence_profile`
   = quality tier; object `evidence_profile` = claims container.*

2. **Merge/precedence → human > supplier-brand-official > supplier > KB-grounded;
   dedup by claim `concern`.** Enforced by the existing *fill-only-when-absent*
   guards, not a new merge engine: the read side attaches supplier claims only
   when the product has none (`hasEvidenceClaims`); the grounded fallback runs
   **only when no servable published bundle exists** and **never overrides** one
   (`isServableProductIntelBundle` check inside `hydrateProductWithGroundedIntel`).
   Within suppliers, the content_key selection already orders `external_seed`
   (brand-official) first.

3. **`source_type: marketing_vs_reality` → accepted; no backend change.** The
   backend `ProductClaim` coercer (`services/claim_safety.py::_coerce_claim`)
   treats `source_type` as a **free string** — only `substantiation_status` is a
   closed set — so the honesty-claim kind passes through unchanged. (Verified.)

4. **Gate (item 9 proper) → built.** `isHumanReviewedProductIntelBundle` is now
   one branch of a tier resolver:
   - `isGroundedProductIntelBundle` accepts a bundle only when
     `provenance.{review_tier|tier}='grounded'` ∧ `reviewer_kind='automated_grounded'`
     ∧ `review_status='completed'` ∧ `review_decision='grounded_pass'` ∧
     `grounding.{inci_verified ∧ citations_present ∧ claim_safety='cosmetic_screened'}`
     ∧ non-empty `evidence_claims`. Fail any → Tier-L (reject), blocked.
   - `resolveProductIntelTier` → `human | grounded | reject`;
     `isServableProductIntelBundle` = human ∨ grounded.
   - The public serving gate (`normalizePublishedProductIntelBundle`), the
     generic-reject short-circuit, and the agent `get_intel` gate cut over to
     *servable*. The human-only predicate is preserved for callers that need it.
   - **Produce → serve:** `hydrateProductWithGroundedIntel` (flag
     `PDP_GROUNDED_PRODUCT_INTEL_ENABLED`, default **off**) calls
     `buildGroundedProductIntelBundle` and stamps a *passing* grounded bundle onto
     `product.product_intel`, so the existing sync builder + gate serve it. With
     the flag off the whole path is a no-op, keeping the gate change inert in
     production until deliberately enabled.

   Implementation: `src/pdpProductIntel.js` (resolver + hydrator),
   `src/server.js` (agent gate + serving-path wiring). Tests:
   `tests/pdp_product_intel_tier_gate.test.js`.
