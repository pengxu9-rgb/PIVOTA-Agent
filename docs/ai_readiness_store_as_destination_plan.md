# AI-Readiness — R3: Store-as-Destination Metric (the retailer's real win) — scoping plan

_The metric a RETAILER actually wins/loses on: when AI recommends a product you carry,
does it route the buyer to YOUR store? R0-R2 stopped the mis-attribution + reframed the
words; R3 measures the thing that matters. For review before building. 2026-06-18._

## North-star
A D2C brand wins by being **recommended**. A retailer (Chydan) wins by being the
**AI-routed buying destination** — when a shopper asks an AI to buy a product Chydan
carries, the AI sends them to Chydan (or Chydan's Pivota canonical PDP), not to Amazon,
the brand's own site, or another retailer. R3 measures **store-as-destination rate** and
names **who AI routes buyers to instead** — honestly, from real probe data.

## The metric
For **buyer-destination queries** on the products the merchant carries — the navigational
/ purchase-intent axis ("where can I buy X", "shop X online", "buy X") — compute:
- **store_as_destination_rate** = of those queries, the share where the AI's answer cites
  the merchant's STORE as a place to buy: `merchant_host` (chydan.com) OR the product's
  **Pivota canonical PDP** (`agent.pivota.cc/products/sig_*`).
- **routed_to_instead** = the retailer/destination hosts AI cited where the store was NOT
  among them (amazon.com, the brand's own site, iherb.com, …) — ranked by frequency.
- Per-SKU + brand rollup.

"Store as destination" = the merchant's own store OR its Pivota canonical PDP is the cited
buy-path. (NOT the resold brand's site — that's the brand's destination, not the store's.)

## What EXISTS — reuse, don't rebuild
- **Buyer-intent probes already run + are axis-tagged** — navigational/intent axis
  ("where to buy", "shop", "buy online") in the per-SKU query generator.
- **Cited-host extraction already exists** (`extract_cited_hosts`, the authority_map /
  `host_attribution_summary` cited hosts per query, with the cited-vs-retrieved discipline).
- **The store identity is known** — `merchant_host` (chydan.com); and the retailer-aware
  identity (R1) already excludes resold brands.
- **The Pivota canonical PDP is known per SKU** — `agent.pivota.cc/products/sig_*` (the
  product's `canonical_url` / `pivota_signature_id`), plus its indexing-arc state.
So R3 is a **new aggregation over existing probe data**, filtered to buy-intent queries,
checking for the STORE (or its Pivota PDP) among the cited buy-destinations. No new probes.

## The win-loop (why this is THE retailer metric)
Retailer's path to winning the destination = get the **Pivota canonical PDP** indexed +
cited for the products it carries → AI routes the buyer there → **in-chat checkout**. R3's
store_as_destination_rate + the existing indexing-arc + the canonical PDP form the
retailer's win loop. Ties to [[pivota-frontier-citation-architecture]].

## Design forks — confirm before building
1. **Does the Pivota canonical PDP count as "the store's destination"?** Recommend YES — it's
   the merchant's Pivota-hosted buyable PDP and the whole thesis. So store-destination =
   `merchant_host` OR the Pivota canonical host for that SKU. (Confirm.)
2. **Which queries are "buyer-destination"?** Recommend the navigational/intent axis (reuse the
   existing tag) — "where/shop/buy". (Alt: also include high-intent category "best X to buy".)
3. **Rendering.** A new **"Are you the buy destination?"** panel — for resellers it's the Zone-1
   headline (replacing the brand-centric findability emphasis); for D2C brands it's secondary
   (their own findability already covers it). (Confirm: reseller-only, or both?)
4. **Backend vs portal split.** Backend: the aggregation (store_as_destination_rate +
   routed_to_instead) on the report; portal: the panel.

## Honesty guardrails (locked)
- Store-as-destination is earned by a REAL cited buy-path (the store/Pivota-PDP host actually
  cited for a buy-intent query) — same cited-vs-retrieved discipline; never inferred.
- "routed to instead" lists the actual cited hosts, ranked — no fabrication.
- Don't double-count the resold brand's site as the store's destination (R1 identity holds).

## Acceptance
- A reseller audit shows: *store_as_destination_rate* (e.g. "AI routes buyers to your store on
  1 of 8 buy-intent queries"), and *routed_to_instead* (amazon.com, ownist.com, iherb.com…),
  with the action = get your Pivota canonical PDP indexed/cited so AI routes the buy to you.
- Verified live on a fresh Chydan audit: is chydan.com / its Pivota PDP cited for "where to buy
  {product}"? The number + the competing destinations are real.

## Build slices (after sign-off)
- R3a (backend): aggregate store_as_destination_rate + routed_to_instead over the buy-intent
  probes; attach to the report (per-SKU + brand). Reuse cited-host data + the R1 store identity
  + the Pivota canonical host.
- R3b (portal): the "Are you the buy destination?" panel (reseller headline).
- R3c (later): tie the action to the canonical-PDP indexing arc (the win loop).

## Change log
- 2026-06-18 — plan created. R3 is the retailer's real win metric (store-as-destination), a new
  aggregation over existing buy-intent probe data; no new probes. Forks: Pivota-PDP-counts (rec
  yes), buy-intent query set, reseller-only vs both, where it renders.

## STATUS — R3a + R3b SHIPPED 2026-06-18 (backend #947 → 192f5d5c, portal #94 → c0f54e6)
`_store_as_destination` on brand_rollup (rate from navigational citation + routed_to_instead from authority hosts' cited_on_branded_query); 'Are you the buy destination?' reseller-headline panel. No new probes. R3c (tie the action to the canonical-PDP indexing arc — the explicit win loop) DEFERRED.
