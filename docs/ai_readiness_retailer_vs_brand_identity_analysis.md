# AI-Readiness — Retailer-vs-Brand Identity (the audit measures the BRAND, not the STORE)

_Deep analysis from the merchant's question: "ownist.com is the product brand's site,
Chydan is a retailer — is Chydan findable or what?" Code-grounded (deployed main
6b73b4cb), 2026-06-18. This is a fundamental scope/identity finding, not a copy bug._

## The finding (confirmed in code)
The audit is a **brand-merchant (D2C) model end-to-end.** It assumes *merchant = the
product brand auditing its own products*. For a **retailer / multi-brand reseller** like
Chydan, it **mis-attributes the resold brands' identity and web presence to the store.**
Every headline metric — findable / cited / recommended — measures whether the BRANDS
Chydan carries (NUTRIONE, Ownist) are present, **not whether Chydan the store is.**

### Why ownist.com showed as "Chydan's findability" (the exact mechanism)
1. The audit builds the merchant identity by **folding each product's `vendor`/`brand`
   into the merchant's identity tuple** — `_merchant_identity_tuple`
   (`agent_center_bd_report_service.py:486-509`), populated at `:8963-8966`. So Chydan's
   identity becomes `("Chydan", "NUTRIONE", "Ownist")` — "the brands I resell" = "who I am."
2. That tuple feeds `derive_brand_aliases` → `brand_aliases = {chydan, nutrione, ownist}`.
3. `_host_is_first_party` (`:5794-5813`) tags a cited host as the merchant's **own_domain**
   if its registrable label is in `brand_aliases`. `ownist.com` → label `ownist` → **first
   party = own_domain → findability.** (Reproduced live: `ownist.com → first_party=True`.)
4. own_domain findability is **name-gate-exempt** (even after the P0 fix) — "your own cited
   page is genuine findability regardless." So the *brand's* site auto-credits as the
   *store's* findability.

So **"Chydan is findable — listed across ownist.com"** actually means *"the Ownist brand's
D2C site is cited by AI."* It answered a question about Ownist, labeled with Chydan's name.

### There is NO retailer-aware model
- Onboarding has **no merchant-type field** (`db/merchant_onboarding.py:15-51` — no
  retailer/reseller/D2C/archetype).
- A `merchant_archetype="channel"` (retailer) path exists but is **dead code**: nothing
  populates it, it defaults to `"brand"`, and even if set it only swaps narrative wording —
  it does NOT change identity, first-party detection, or citation attribution.
- Nothing distinguishes **"is the BRAND recommended"** from **"is THIS STORE where AI routes
  buyers."** They're merged at the identity layer.

## Answering the merchant's three questions honestly

**1. "How often AI named your products — by question type — how do I use/act?"**
Today it measures how often AI named the **product brands** (NUTRIONE/Ownist), split by
question style. For a *brand*, that's directly actionable (improve your PDP → win the
question). For a **retailer**, it's a brand-readiness signal you only partly control — and
it does NOT tell you the thing you actually need: *when AI recommends this product, does it
send the buyer to Chydan?* So as-is, its action value for a reseller is limited; the honest
use is "which of the products I carry are/aren't winning each question type" — a sourcing/
merchandising signal, not a store-visibility one.

**2. "Findability: ownist.com — is Chydan findable or what?"**
**Chydan's own findability is NOT being measured.** ownist.com appears only because Chydan
resells the Ownist product and the audit folded "Ownist" into Chydan's identity. The correct
retailer signal — *is chydan.com (or Chydan's Pivota-canonical / marketplace listing) cited
as a place to buy this product* — is never computed. Your confusion is well-founded: it's a
real mis-attribution for retailers.

**3. "Endorsement — independently recommended — promote product brand or retailer brand?"**
As built, **the product brand.** "Independently recommended" asks whether an editorial/creator/
forum named the brand. For a retailer, the relevant question is different: *does AI recommend
buying this product AT Chydan* (vs Amazon / the brand's own site / other retailers). The audit
doesn't measure store-as-destination at all.

## The fundamental issue + the right direction
The audit was built for **D2C brands**. A **retailer's win condition is different**: not
"is my brand recommended" but **"am I the buying destination AI routes shoppers to."** That's
exactly the Pivota canonical-PDP / in-chat-checkout thesis ([[pivota-frontier-citation-architecture]])
— Chydan's products get a Pivota canonical PDP (`agent.pivota.cc/products/sig_*`) that AI can
cite + route a buy through. So a retailer's findability/citation should be measured at the
**store-listing / Pivota-canonical level**, not the resold brand's D2C site.

Two distinct problems to decide on:
- **(A) Bug — identity conflation:** for a retailer, a resold brand's domain (ownist.com)
  should NOT be the merchant's own_domain/findability. The `_merchant_identity_tuple`
  vendor-folding mis-credits it. (Fixable in the attribution layer — but only meaningful once
  we know the merchant is a retailer.)
- **(B) Scope — retailer model:** does the audit support retailers? If yes, it needs (1) a
  merchant-type signal (onboarding/derived), (2) retailer-aware identity (the STORE, not the
  brands), and (3) a retailer metric: *is this store the AI-routed buying destination for the
  products it carries* (measure chydan.com / Pivota-canonical citation, not brand citation).
  If the audit is **brand-only**, it should at least DETECT a reseller and say "this audit is
  built for the brand that makes the product; as a retailer, here's what these signals do/don't
  mean" rather than mislabel the brand's presence as the store's.

## Open product decisions (for the user)
1. **Who is the audit for** — D2C brands, retailers, or both? (Chydan is testing it as a retailer.)
2. If retailers are in scope: build the **retailer model** (store-as-destination) — a real
   initiative — or, near-term, at least **stop mis-attributing** the resold brand's domain to
   the store + reframe the sections honestly for a reseller.
3. The merchant-type input: onboarding field, or derive from catalog (store domain ∉ product
   vendors ⇒ reseller)?
