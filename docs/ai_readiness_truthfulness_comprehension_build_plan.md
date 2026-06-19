# AI-Readiness — Truthfulness & Comprehension — Build Plan & Tracker

_Sequences the fixes from `ai_readiness_truthfulness_comprehension_analysis.md` (the
diagnosis). Created 2026-06-18 from the live-eyeball findings. Order: P0 (truth) →
P1 (comprehension + dedup) → P2 (polish). Each step lists the concrete design call +
acceptance. Nothing built yet._

## North-star (anti-drift)
The audit must be **truthful** (never claim an endorsement/listing the merchant doesn't
have — apply the cited-vs-retrieved discipline everywhere, not just the outreach oracle)
and **comprehensible** (every number/term a non-expert merchant can read: what it means,
the scale, what good looks like, what to do). If a change asserts a signal not backed by
the merchant actually being named, or shows a bare number with no meaning, it's drift.

## Locked design decisions (carry through every step)
- **Endorsement/findability is earned by the merchant being NAMED**, not by a host's role.
  Gate on `cites_exact_sku OR cites_near_variant` (own-domain is exempt — your own cited
  page IS findability). Hosts cited but NOT naming you → "who AI cites instead", never
  "recommends you".
- **Define terms in plain language where the number lives**; the 4 dimensions are fixed,
  so their definitions can be hardcoded portal-side (no backend dependency).
- **One product-identity rule everywhere** — `_product_id_variants` (shared `sig_<hex>`)
  for dedup, supersession, AND reconciliation.
- Honesty copy ("the only honest signal") must not outrun the data — fix the data first.

## Progress tracker
| ID | Step | Surface | Status | Notes |
|----|------|---------|--------|-------|
| P0 | **Truthful endorsement/findability** — gate `_citation_signals` on merchant-named | backend | ☐ | the trust fix; data exists |
| P1a | **Numbers-with-meaning + define terms** | portal | ☐ | band word + scale + glossary + product-vs-store |
| P1b | **Unify dedup on `_product_id_variants` + collapse brand-action-per-SKU** | backend | ☐ | kills residual duplicates |
| P2a | **`in_progress` clarity** — drop the "running" spinner; show owner | portal | ☐ | small |
| P2b | **"What AI names instead" — co-locate action + show frequency** | portal | ☐ | small |
| Q | **Operator follow-tests** — should BD operators run re-tests for merchants? | — | ☐ | product decision |

---

## P0 — Truthful endorsement/findability (backend)
**Change:** in `_citation_signals` (`agent_center_bd_report_service.py:5844-5891`), gate the
buckets on whether the host actually cited the merchant:
- `findability_hosts`: `own_domain` (always — your cited page) + `marketplace_self_listing`
  hosts WHERE `cites_exact_sku or cites_near_variant` (the SKU is genuinely listed there).
- `endorsement_hosts` / `endorsement_category_hosts`: endorsement-role host WHERE
  `cites_exact_sku or cites_near_variant` (it named you).
- `has_independent_endorsement` / `independently_recommended_for_category`: derive from the
  GATED endorsement sets (so they're false when no host named you).
- Hosts cited but not naming the merchant: ensure they flow to the existing "who AI cites
  instead" / competitor surfaces (don't silently drop).
**Design calls:**
1. Own-domain findability — keep ungated (your own cited listing is real findability). ✅
2. Near-variant — count `cites_near_variant` as named? Recommend YES (a near variant of your
   SKU is still you) — but label findability "listed across" only for exact, soften to
   "found near your variants" for near. (Confirm.)
3. The no-endorsement narrative path must read honestly ("not yet independently recommended —
   here's how") — verify `merchant_narrative_builder` fallback when the gated sets are empty.
**Acceptance:** a test store whose SKU is never named shows ZERO "recommended/earns
recommendation/listed across" claims; the hosts that grounded category answers without naming
it appear under "who AI cites instead". Verify on a fresh Chydan audit — the false claims gone.

## P1a — Numbers-with-meaning + define terms (portal)
**Change:**
- Brand median strip (`page.tsx:3210-3232`): render the **band word** (Needs work / Ready / …)
  next to each number, not just color; add the **scale** (an at-a-glance "/100" or the band);
  add a one-line **definition per dimension** (Identity = "can AI tell exactly which product
  this is", Content = "does the listing answer buyer questions", Routability = "can AI route a
  shopper to buy it", Citation = "does AI actually name/recommend you — the outcome"). Hardcode
  these (4 fixed dimensions).
- Move/duplicate the band **legend above** the first numbers (it's currently screens below).
- Define **cited / citation / findable / recommended** once, in plain copy (a compact "How to
  read this report" affordance or inline ⓘ).
- **CitationByIntentPanel**: plainer ratio copy ("of the N '{type}' questions we tested, AI
  named your store/product in M"), show the green/amber threshold, and answer the merchant's
  question — is it the PRODUCT or the STORE being cited, and via what.
**Design calls:**
1. Term definitions: inline ⓘ tooltips vs a small persistent "How to read" block. Recommend a
   compact "How to read" block at the top of Zone 1 + band word inline (no dependency on the
   empty per-dimension `meaning`/`question` payload fields). (Confirm.)
2. "Cited = product or store?" — decide the precise merchant-facing definition (likely "AI named
   your product/brand in its written answer") and use it consistently.
**Acceptance:** a non-expert reads any number and can say what it measures, whether it's good,
and what to do; core terms are defined on-page.

## P1b — Unify dedup + collapse brand-action-per-SKU (backend)
**Change:**
- `dedupe_pending_tasks` (`db/merchant_tasks.py:651`) + cross-audit supersession
  (`task_queue_service.py:581,596,604`): use `_product_id_variants` for the product component
  (match reconciliation) so URL-form vs catalog-form dupes collapse.
- Collapse the "same generic brand-style action across N SKUs" class: brand-level levers
  (indexing/schema/attribution that are account-wide) should materialize **once** (no
  product_key), not per-product. (`_extract_action_items` currently stamps each product's key
  on these.)
- Align the key-source fallback (`product_key or sku_key` vs `product_key or merchant_pdp_url`).
**Design call:** which levers are "brand-level, materialize once" vs genuinely per-product?
Recommend brand-level: `indexing_acceleration`, schema/sitemap, `general_recommendation`
attribution headlines; per-product: `sku_enrichment`, content_revision, niche_content. (Confirm
the split — wrong call either re-introduces dupes or hides a real per-product task.)
**Acceptance:** the action plan shows each distinct action once; no URL-vs-catalog twins; brand
actions appear once, per-product actions once per product.

## P2a — `in_progress` clarity (portal)
Drop the spinning `Loader2` for `in_progress` (`MerchantTaskQueuePanel.tsx:535-536`); render a
static "Started" chip + owner ("owned by you" / "owned by Pivota" when BD-owned). No implied
background execution. **Acceptance:** a merchant who didn't start a task never sees a spinner
implying Pivota is running it.

## P2b — "What AI names instead" — action + frequency (portal)
Co-locate the "how to win" action with the names (not a separate conditional callout); render
`times_named` so the list is rankable ("named 6×"). **Acceptance:** the block says what it is,
how often, and what to do, in one place.

## Q — Operator follow-tests (product decision)
The custom-prompt box + Step-5 RetestPanel already let a MERCHANT re-test. Open: should Pivota
**BD operators** run follow-up tests on a merchant's behalf (the BD task route exists)? Decide
scope before building anything here.

## Change log
- 2026-06-18 — plan created from the live-eyeball deep analysis. P0 (false claims) is the
  priority + bounded; P1 comprehension + dedup unification; P2 polish. Design calls flagged.
