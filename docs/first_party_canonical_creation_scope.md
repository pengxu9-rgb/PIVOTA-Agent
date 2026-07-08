# First-Party Canonical Creation — Scope

**Status:** Scoping (not yet built)
**Date:** 2026-06-30
**Repos:** `PIVOTA-Agent` (Node identity graph) + `pivota-backend` (Python trust + reviewer)
**Builds on:** the LLM identity reviewer / matching layer ([pivota-backend#1089](https://github.com/pengxu9-rgb/pivota-backend/pull/1089))

---

## TL;DR

The matching layer does **MATCH** (a merchant listing → an existing approved canonical). This is the **CREATE** half: when a small merchant sells under **their own brand** on their own store (e.g. an AliExpress-sourced product they rebranded — Ownist, not COSRX), there's **no existing canonical to match** and usually **no other sellers to cluster with**. Their store *is* the authoritative source, so they should **become** the canonical — promoted to brand-tier first-party authority — rather than sitting forever in `review_required`.

**The whole thing reduces to: when a brand has no canonical yet AND the merchant owns that brand, the merchant's own listing IS the canonical.** The guardrail is automatic — you can only first-party-*create* a brand that doesn't already exist in the index; a dropshipper "claiming COSRX" can't, because COSRX already has a canonical, so they fall to the MATCH path (where the LLM verifies the actual product).

**Recommendation:** build it — it completes match-**or**-create and unblocks the exact merchant segment described (new-brand DTC sellers). **~1.5–2.5 eng-weeks**, most of it the brand-ownership capture; the promotion mechanism reuses the existing override pipeline.

---

## The architecture — three pieces

### 1. Brand-ownership declaration (the input)
Today there is **no field** for a merchant's brand or store domain. `catalog_merchants` (058_catalog_core.sql) has `merchant_name` but no `owned_brands` / `store_domain` / `owns_brand`. The existing first-party notion — `IDENTITY_NOT_APPLICABLE_FIRST_PARTY` ([catalogTrustPolicy.js:41,437](../PIVOTA-Agent/src/services/catalogTrustPolicy.js)) — recognizes that any merchant `!= 'external_seed'` is "the source of truth," but it's **advisory only** (doesn't flip the decision or promote to canonical). First-party creation makes that latent notion **actionable**.

- **Capture:** at store connect / onboarding, record the brand(s) the merchant declares they own + their store domain. Store as `catalog_merchants.owned_brands TEXT[]` + `store_domain TEXT` (or in the existing `metadata_json` for a no-migration MVP).
- **MVP shortcut:** declaration UI is optional for v1. The ownership signal can be **inferred**: brand ↔ store-domain correspondence (the same `chooseSourceTier` logic, below) + "no other source has claimed this brand." Declaration is the durable, explicit upgrade.

### 2. Brand-tier promotion (the mechanism)
A listing reaches the deposit-clearing ~0.92 the same way the seed catalog does — `computeIdentityConfidence` ([pdpIdentityGraph.js:1321](../PIVOTA-Agent/src/services/pdpIdentityGraph.js)):
```
base 0.6 (brand tier, vs 0.42 merchant)
 + 0.12 official_url + 0.08 official_handle + 0.06 brand_norm + 0.06 title_core = 0.92
```
The blocker today: `chooseSourceTier` ([pdpIdentityGraph.js:1435](../PIVOTA-Agent/src/services/pdpIdentityGraph.js)) only returns `'brand'` for a non-seed listing when the **official_url domain matches the brand name** — which a merchant's store often *doesn't* satisfy cleanly. So their own-brand products score `0.42 → ~0.62` → `review_required`.

**Two ways to promote (pick one):**

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **A. New override `approve_first_party_canonical`** (recommended) | `catalog_trust_policy.derive_trust` honors it → `{status: approved, confidence: 1.0}`, exactly like `force_exact_group` ([catalog_trust_policy.py:336](../pivota-backend/services/catalog_trust_policy.py)) but **no target** (it's its own canonical) | Python-direct, immediate (no Node re-resolution), explicit semantics, mirrors the MATCH primitive | one small new action_type in `derive_trust` (+ Node `applyIdentityOverrides` for consistency) |
| **B. Existing `prefer_source_tier='brand'` override** ([pdpIdentityGraph.js:4808](../PIVOTA-Agent/src/services/pdpIdentityGraph.js)) | already supported — sets `source_tier='brand'` → `computeIdentityConfidence` base 0.6 → ~0.92 | zero new code; "honest" confidence from real signals | needs Node **re-resolution** to recompute; only reaches 0.85 **if** the listing has official_url + handle present |

**Recommendation: A** for reliability + immediacy (a declared brand owner is authoritative; confidence 1.0 is consistent with the override-is-authoritative pattern). Keep **B** as a fallback/alternative when we'd rather the score reflect real signals. Both reuse the existing `pdp_identity_override` pipeline (5,975 rows in prod; the LLM reviewer already writes to it).

### 3. The CREATE branch in the reviewer (the orchestration)
Extend `services/llm_identity_reviewer.py`. Today: `no_candidate` → mark `llm_no_candidate`. New:
```
for a review_required merchant listing with NO approved same-brand canonical:
  if merchant owns this brand (declared OR brand↔domain match) AND no conflicting claim:
     CREATE → write approve_first_party_canonical override + recompute trust
              → listing becomes the approved canonical for that (brand, product)
  else:
     keep llm_no_candidate  (truly brandless / unclear ownership → human)
```
This composes cleanly with what's shipped: once a brand is first-party-created, a *later* third-party seller of the same product hits the **existing MATCH path** (the LLM matches them to this canonical). MATCH + CREATE = full match-or-create.

---

## The guardrail (simpler than it looks)

The worry — "a dropshipper declares 'COSRX' and hijacks the brand" — is handled **structurally**, not by a heuristic:

- **CREATE only fires when the brand has NO existing approved canonical.** If COSRX is already in the index (it is — the seed has it at 0.92), the merchant's COSRX product hits the **MATCH** path, where the LLM verifies the *actual product* (and rejects a generic look-alike). They literally cannot CREATE over an existing brand.
- So CREATE is reachable only for brands **new to the index** — which is exactly the legitimate new-brand DTC case. A merchant inventing brand "Ownist" owns "Ownist" by definition, even if the product was AliExpress-sourced.

Guardrail query (cheap):
```sql
SELECT 1 FROM catalog_products cp
JOIN catalog_row_trust crt ON crt.product_key = cp.product_key
WHERE lower(btrim(cp.brand)) = :brand_norm
  AND crt.identity_status = 'approved'
  AND cp.merchant_id <> :this_merchant
LIMIT 1;   -- if a row exists → NOT a CREATE; route to MATCH
```
This is the same candidate-lookup the reviewer already runs (no candidate == no existing canonical). The only addition is the ownership check.

---

## Effort

| Phase | Work | Est. |
|---|---|---|
| **P1 — Brand-ownership capture** | `catalog_merchants.owned_brands[]` + `store_domain` (or metadata_json MVP); set at store-connect; a read accessor. UI optional for v1 (inference covers it) | 4–6 d |
| **P2 — CREATE primitive** | `approve_first_party_canonical` action_type in `derive_trust` (Python) + `applyIdentityOverrides` (Node) → approved/confidence 1.0, self-canonical | 2–3 d |
| **P3 — Reviewer CREATE branch** | extend `llm_identity_reviewer`: ownership check + guardrail + write the override + recompute trust + queue status `resolved_first_party`; CLI/tick wiring | 2–3 d |
| **P4 — Validate** | prove on a real new-brand merchant (e.g. the Ownist store, or one of the AliExpress-rebrand merchants): products promote to approved canonical, deposit, and a later third-party seller MATCHES to them | 1–2 d |
| **Total** | | **~1.5–2.5 eng-weeks** |

P2+P3 are the core (~1 week) and reuse everything from #1089. P1 (capture) is the bulk and the only piece with a schema/onboarding touch.

---

## Decisions to confirm
1. **Ownership signal for v1:** explicit declaration (needs onboarding capture) vs. inference (brand↔store-domain + no-existing-canonical, zero onboarding work). *Lean: ship inference first (fast, covers the Ownist case), add declaration as the durable upgrade.*
2. **Promotion mechanism:** new `approve_first_party_canonical` action_type (recommended) vs. `prefer_source_tier='brand'` (zero new code, but re-resolution + signal-dependent).
3. **Confidence value:** 1.0 (override-authoritative, like force_exact_group) vs. let it score ~0.92 from brand-tier signals (more honest, needs the signals present).
4. **Auto vs. reviewed:** auto-CREATE on inference + guardrail, or require a light LLM/human confirm for the first batch. *Lean: auto for declared brands; LLM-assisted for inferred-only.*

## Gotchas (from the code)
- **`official_url` must be present** for the brand-tier signals to add up under Option B — a Shopify sync usually populates `canonical_url`, but verify per merchant; under Option A this doesn't matter (confidence 1.0 is set directly).
- **`chooseSourceTier` brand↔domain match is loose** (`includes`) — `ownist.myshopify.com` contains `ownist` so it *may* auto-tier, but custom domains / mismatched brand names won't. The override path doesn't depend on this.
- **Grouping interaction:** a first-party canonical is its OWN content_key — no re-point needed. Later MATCHing sellers re-point *their* content_key to it (the #1089 grouping path), so cross-seller grouping still works once a brand grows resellers.
- **`prefer_source_tier` is Node-only** — it changes `pdp_identity_listing` confidence via re-resolution, not via Python `derive_trust`; that's why Option A (Python-direct) is more immediate.
