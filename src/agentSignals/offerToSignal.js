'use strict';

// Pure projection: an aggregated cross-merchant offer (one entry of agent_pdp_view.offers, itself built by
// the backend `aggregate_offers` over catalog_offers × product_group_members) → the Signal envelope from
// docs/agent-data-exposure-spec.md. No I/O, no app deps — unit-tested in isolation.
//
// seller_trust is intentionally null: return_rate / shipping_rating signals come from the future
// `agent_signal` store (computed from the decision_outcome loop) and are not available yet. We never
// fabricate competition — a single-offer product yields best_offer + an empty competition set.

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function offerToSignal(offer, { productId = null } = {}) {
  if (!offer || typeof offer !== 'object') return null;
  const merchantId = nonEmptyString(offer.merchant_id) ? offer.merchant_id : null;
  const price = offer.price != null && Number.isFinite(Number(offer.price)) ? Number(offer.price) : null;
  return {
    signal_type: 'offer',
    subject: { kind: 'offer', id: merchantId ? `${merchantId}:${productId || ''}` : null },
    value: {
      merchant_id: merchantId,
      merchant_name: offer.merchant_name || null,
      price,
      currency: offer.currency || null,
      availability: offer.availability || null,
      is_primary: offer.is_primary === true,
      url: offer.url || null,
      // Attributed-redirect lane: backend offers.resolve stamps a signed /r attribution link on external
      // (affiliate_outbound) offers as `affiliate_url`. Surface it — the shared sanitizer preserves it
      // verbatim (shape-gated) so agents can send buyers through the attributed hop.
      affiliate_url: nonEmptyString(offer.affiliate_url) ? offer.affiliate_url : null,
      purchase_route: nonEmptyString(offer.purchase_route) ? offer.purchase_route : null,
      // WHAT FOLLOWING `affiliate_url` ACTUALLY DOES. It resolves either to a PRE-FILLED CART
      // on the merchant's own storefront or to a bare product page, and an agent could not
      // previously tell which: the decision was made inside the backend's redirect builder,
      // stamped into the signed token as `join_mode`, and never returned. For a card-rail
      // handoff that is the difference between "the buyer lands on a checkout with the item in
      // it" and "the buyer lands on a PDP and has to find the variant themselves" — a
      // materially different completion path, and the first field of the execution spec.
      //
      // THREE states, because there are three facts. `true` = the backend resolved a cart
      // permalink; `false` = the backend resolved this to a bare PDP; `null` = nobody said.
      // Collapsing the third into `false` would be a fabrication in the other direction: an
      // agent reading `false` has every reason to tell the buyer "this goes to a product page,
      // you'll have to pick the variant yourself", and that sentence is FALSE whenever the
      // field was merely absent — an older backend, a non-external offer, or the ordinary
      // state before the backend half of this ships. A boolean cannot say "I do not know",
      // so it would have to lie; `null` can.
      //
      // Only an EXPLICIT backend boolean is believed. `=== true` / `=== false` rather than
      // truthiness so a stray string, `1`, or `0` can never be read as either claim.
      cart_prefilled:
        offer.cart_prefilled === true ? true : offer.cart_prefilled === false ? false : null,
    },
    evidence: {
      grade: null,
      confidence: offer.price_confidence != null && Number.isFinite(Number(offer.price_confidence))
        ? Number(offer.price_confidence)
        : null,
      method: 'merchant_reported',
      sources: [],
    },
    freshness: { observed_at: offer.updated_at || null, fresh_until: null },
    seller_trust: null, // FUTURE: return_rate / shipping_rating from the agent_signal store
    visibility: 'buyer_safe',
  };
}

function offersToSignals(offers, opts = {}) {
  const { productId = null, limit = 10 } = opts;
  if (!Array.isArray(offers)) return { best_offer: null, signals: [] };
  const signals = [];
  for (const o of offers) {
    const s = offerToSignal(o, { productId });
    if (s) signals.push(s);
  }
  // best = primary first, then lowest price — mirrors the backend aggregate_offers ordering.
  const priced = signals.filter((s) => typeof s.value.price === 'number');
  priced.sort((a, b) => {
    if (a.value.is_primary !== b.value.is_primary) return a.value.is_primary ? -1 : 1;
    return a.value.price - b.value.price;
  });
  const best_offer = priced.length ? priced[0] : signals[0] || null;
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 10, 10));
  return { best_offer, signals: signals.slice(0, cap) };
}

module.exports = { offerToSignal, offersToSignals };
