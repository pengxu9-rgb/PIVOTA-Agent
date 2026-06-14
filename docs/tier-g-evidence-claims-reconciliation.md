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

## Open — item 9 must decide jointly (NOT unilateral)

1. **Container unification.** The agent bundle carries `product_intel_core.evidence_claims[]`;
   the PDP product carries `evidence_profile.claims`. Note the **`evidence_profile`
   overload**: a *string* enum in `product_intel_core` vs the *object*
   `EvidenceProfile` at product level. Decide one container name to avoid confusion.
2. **Merge/precedence** when a product has BOTH supplier-intake claims
   (`beauty_product_profiles`) AND KB-grounded claims. Likely: supplier brand-official
   first, KB-grounded fills gaps; dedup by claim concern.
3. **New `source_type: marketing_vs_reality`** — confirm the backend claim vocab
   accepts it (honest myth-correction is a distinct, valuable claim kind).
4. **Gate (item 9 proper):** extend `isHumanReviewedProductIntelBundle` to accept
   `provenance.review_tier='grounded'` + `buildProductIntelBundleInternal` grounded fallback.
