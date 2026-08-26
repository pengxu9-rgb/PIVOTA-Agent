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

// EXECUTION SPEC v0 passthrough. The backend composes this at `offers.resolve` (every url built by ONE
// function, so `cart_url` cannot describe a destination different from the one `affiliate_url` resolves to).
// This projection must not re-derive any of it — the whole point is that there is a single composer.
//
// What it DOES do is refuse to relay anything that is not the shape it claims to be. Every field here is a
// statement an agent will repeat to a buyer: where they will land, what they will find in the cart, when the
// link dies. A malformed value must read as "not said" rather than be passed along as a claim, so each field
// degrades to null independently — a bad `expires_at` must not cost the agent a good `cart_url`.
//
// Absent spec -> null, NOT {}. An empty object reads as "a spec exists and it is blank"; null reads as
// "nobody said", which is the truth for an older backend or a non-external offer. Same reasoning as
// cart_prefilled above.
function toExecutionSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v) => (nonEmptyString(v) ? v : null);
  // Money and counts are NUMBERS. A string that happens to look numeric is not a total: it would
  // sort and compare as text wherever an agent does arithmetic on it, so it degrades to null
  // rather than being coerced.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tracking = raw.tracking && typeof raw.tracking === 'object' && !Array.isArray(raw.tracking)
    ? raw.tracking
    : {};
  return {
    merchant_domain: str(raw.merchant_domain),
    // Withheld by the backend when its host is not the one the domain allowlist approved. Null here means
    // "we will not vouch for a product page", never "there isn't one".
    pdp_url: str(raw.pdp_url),
    cart_url: str(raw.cart_url),
    // The NUMERIC storefront variant id. `variantid` is PAN-exempt in the sanitizer; the cart permalink that
    // embeds it is exempt only via its shape gate (see CART_PERMALINK_RE) — without that, ~1 in 10 of these
    // urls would come back as `/cart/[REDACTED_PAN]:1`.
    variant_id: str(raw.variant_id),
    // Passed through as a label rather than checked against a known set: an unknown rail from a newer backend
    // is information the agent can ignore, whereas nulling it would silently drop a rail the moment one is
    // added. It is not a promise about a URL, which is why it does not get the strict treatment above.
    rail: str(raw.rail),
    expires_at: str(raw.expires_at),
    // WHAT THE MERCHANT SAID, JUST NOW. The backend's live-verification hop asks the merchant's
    // own storefront before the handoff and publishes what it found. Without these an agent gets
    // a spec that looks identical whether we checked it a second ago or are reciting a row that
    // is, on the audit's measurement, wrong 31.1% of the time.
    //
    // `expected_item_total` is only ever populated when the shop's declared currency MATCHED the
    // one the offer quotes — the backend refuses to compare across currencies rather than
    // publishing a number in the wrong unit. `expected_quantity` says what the total is FOR,
    // because a total is only right for the quantity the cart encodes.
    expected_item_total: num(raw.expected_item_total),
    expected_currency: str(raw.expected_currency),
    expected_quantity: num(raw.expected_quantity),
    // When the promise stops being one. An agent holding a spec past this must re-resolve rather
    // than act on a total whose shelf life has run out.
    expected_total_expires_at: str(raw.expected_total_expires_at),
    tracking: {
      click_id: str(tracking.click_id),
      // WHICH carrier holds the join key in the url the agent was handed — `attributes[pivota_click_id]` on a
      // cart, a plain query param on a referral. Naming the wrong one sends an agent looking for a key that is
      // not in the string.
      param: str(tracking.param),
      join_mode: str(tracking.join_mode),
    },
  };
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
      // DID WE ACTUALLY CHECK, AND WHAT DID WE ESTABLISH. Three separate facts, because they
      // fail separately: stock can be confirmed while price cannot (the storefront endpoint the
      // backend reads carries an amount with NO currency code, so a price is only verified once
      // the shop's declared currency is known to match). Folding them into one flag is what
      // produced a yen amount published under a dollar label in an earlier cut.
      //
      // Absence stays null throughout: an older backend, a non-external offer, or an offer
      // outside the verified top-3 has no verdict, and "we did not look" is not "we looked and
      // it failed". Only an explicit backend boolean is believed.
      stock_verified:
        offer.stock_verified === true ? true : offer.stock_verified === false ? false : null,
      merchant_price_verified:
        offer.merchant_price_verified === true
          ? true
          : offer.merchant_price_verified === false
            ? false
            : null,
      // Named for its PROVENANCE. The reco lane publishes its own `price_verified` meaning
      // "consistent with Pivota's own projection" — the opposite claim from "the merchant said
      // so", and one key for both would make them indistinguishable to a model.
      rank_one_unverified: offer.rank_one_unverified === true ? true : null,
      // The rest of the execution spec. `cart_prefilled` above answers "is there a cart"; this answers
      // "where exactly, with what in it, until when, and how is the click attributed".
      execution_spec: toExecutionSpec(offer.execution_spec),
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
