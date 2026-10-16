'use strict';

// Pure projection: an aggregated cross-merchant offer (one entry of agent_pdp_view.offers, itself built by
// the backend `aggregate_offers` over catalog_offers × product_group_members) → the Signal envelope from
// docs/agent-data-exposure-spec.md. No I/O, no app deps — unit-tested in isolation.
//
// seller_trust is intentionally null: return_rate / shipping_rating signals come from the future
// `agent_signal` store (computed from the decision_outcome loop) and are not available yet. We never
// fabricate competition — a single-offer product yields best_offer + an empty competition set.

const { isUnavailableAvailabilityText } = require('../services/offerAvailabilitySql');

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
    // AMOUNT AND CURRENCY MOVE TOGETHER, or neither moves. The file's "each field degrades
    // independently" rule is right for urls and wrong for money: publishing 14.99 with a null
    // currency hands the agent a number to compare a checkout total against with no unit, which
    // is the exact shape #2102/#2104 removed from the sibling readers.
    expected_item_total:
      num(raw.expected_item_total) !== null && str(raw.expected_currency) !== null
        ? num(raw.expected_item_total)
        : null,
    expected_currency:
      num(raw.expected_item_total) !== null && str(raw.expected_currency) !== null
        ? str(raw.expected_currency)
        : null,
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

const trimmed = (v) => String(v).trim();

function toLiveRead(lr) {
  if (!lr || typeof lr !== 'object' || !nonEmptyString(lr.status)) return null;
  const out = { status: trimmed(lr.status) };
  if (nonEmptyString(lr.checked_at)) out.checked_at = trimmed(lr.checked_at);
  if (nonEmptyString(lr.merchant_currency)) out.merchant_currency = trimmed(lr.merchant_currency);
  if (nonEmptyString(lr.expected_total_withheld)) out.expected_total_withheld = trimmed(lr.expected_total_withheld);
  if (lr.stored_price != null && Number.isFinite(Number(lr.stored_price))) out.stored_price = Number(lr.stored_price);
  return out;
}

function toVariantOption(v) {
  if (!v || typeof v !== 'object' || !nonEmptyString(v.variant_id)) return null;
  const out = { variant_id: trimmed(v.variant_id), title: nonEmptyString(v.title) ? trimmed(v.title) : null };
  if (v.price != null && Number.isFinite(Number(v.price))) {
    out.price = Number(v.price);
    out.currency = nonEmptyString(v.currency) ? trimmed(v.currency) : null;
  }
  out.in_stock = v.in_stock === true ? true : v.in_stock === false ? false : null;
  if (v.live_verified === true) out.live_verified = true;
  return out;
}

// THE FRESH-PRICE CONTRACT (pivota-backend #2635). offers.resolve, in a resolved content_key group, sends:
//   price_comparable: true   on exactly the offers eligible for a best price (an exact or same-size member,
//                            a fresh price, a stated ISO currency); absent on every other offer
//   best_price_offer_id      the cheapest of those (id or null), and only for a resolved group
//   price_stale: true        on an offer whose price is not fresh (a catalog price never read, or read over
//                            7 days ago); absent otherwise
//   price_checked_at         the last price read (ISO, or null: none on record)
// The contract is ON for an answer when `best_price_offer_id` is present (null included) or any offer carries
// `price_comparable` or `price_stale`. Off -- what offers.resolve sends with OFFERS_RESOLVE_GROUP_SEED_SIBLINGS
// off -- every signal and the best_offer pick are byte-identical to before.
function freshPriceContractOn(offers, bestPriceOfferId) {
  if (bestPriceOfferId !== undefined) return true;
  return (Array.isArray(offers) ? offers : []).some(
    (o) => o && typeof o === 'object' && ('price_comparable' in o || 'price_stale' in o),
  );
}

// THE GATEWAY'S OWN LIVE READ of this request (services/ucpLiveOfferRead) decides over the stored facts:
// `verified` replaced the stored price with the merchant's answer, so the offer is FRESH whatever the backend
// flagged; `currency_mismatch` means the merchant does not price this market at all, so the stored amount is
// not a price the buyer can be quoted and the offer is STALE whatever the backend said.
const liveReadStatus = (offer) => (offer && offer.live_read && offer.live_read.status) || null;

function offerPriceIsStale(offer) {
  if (!offer || typeof offer !== 'object') return false;
  const live = liveReadStatus(offer);
  if (live === 'verified') return false;
  if (live === 'currency_mismatch') return true;
  return offer.price_stale === true || Boolean(offer.requires_live_verification);
}

// `price_checked_at` is relayed only when it is an ISO timestamp that is not in the future; anything else is
// "no read on record" (null), never a date the agent would repeat.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
function validPriceCheckedAt(v, nowMs) {
  if (!nonEmptyString(v)) return null;
  const t = v.trim();
  if (!ISO_TIMESTAMP.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) && ms <= nowMs ? t : null;
}

// Under the contract only: `price_stale` (true, never false: "no warning" is the ordinary state) and
// `price_as_of`, when the price was last READ -- the merchant's live answer on a verified offer, else the
// backend's `price_checked_at` (null: no valid read on record). `freshness.observed_at` follows it: `updated_at`
// is a row write, not a price read, and a stale price must not be dated as if it were current.
function priceFreshnessFields(offer, nowMs) {
  const out = {};
  if (offerPriceIsStale(offer)) out.price_stale = true;
  out.price_as_of =
    liveReadStatus(offer) === 'verified'
      ? offer.live_read.checked_at || null
      : validPriceCheckedAt(offer.price_checked_at, nowMs);
  return out;
}

function offerToSignal(offer, { productId = null, freshPriceContract = false, now = Date.now } = {}) {
  if (!offer || typeof offer !== 'object') return null;
  const merchantId = nonEmptyString(offer.merchant_id) ? offer.merchant_id : null;
  const price = offer.price != null && Number.isFinite(Number(offer.price)) ? Number(offer.price) : null;
  const priceFreshness = freshPriceContract ? priceFreshnessFields(offer, now()) : {};
  return {
    signal_type: 'offer',
    subject: { kind: 'offer', id: merchantId ? `${merchantId}:${productId || ''}` : null },
    value: {
      merchant_id: merchantId,
      merchant_name: offer.merchant_name || null,
      price,
      currency: offer.currency || null,
      ...priceFreshness,
      availability: offer.availability || null,
      // The backend CORRECTS this on a verified offer and leaves `availability` alone, so
      // without it the wire carried `availability: "unknown"` next to `stock_verified: true` —
      // a confirmed-in-stock item with no positive stock statement anywhere on it.
      in_stock: offer.in_stock === true ? true : offer.in_stock === false ? false : null,
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
      // Named for its PROVENANCE. The reco lane publishes its own `price_verified` meaning
      // "consistent with Pivota's own projection" — the opposite claim from "the merchant said
      // so", and one key for both would make them indistinguishable to a model.
      merchant_price_verified:
        offer.merchant_price_verified === true
          ? true
          : offer.merchant_price_verified === false
            ? false
            : null,
      // THE TOP RESULT WAS NOT CONFIRMED. The backend raises this when the whole shortlist came
      // back unverified — the outage case, and precisely when an agent is most likely to act on
      // a stale price. `true` or absent, never `false`: it is a warning, and "no warning" is the
      // ordinary state rather than a claim that everything checked out.
      rank_one_unverified: offer.rank_one_unverified === true ? true : null,
      // The rest of the execution spec. `cart_prefilled` above answers "is there a cart"; this answers
      // "where exactly, with what in it, until when, and how is the click attributed".
      execution_spec: toExecutionSpec(offer.execution_spec),
      // WHAT THE MERCHANT SAID JUST NOW (services/ucpLiveOfferRead). `status` is verified, currency_mismatch
      // (the merchant does not price for this market; `merchant_currency` names what it answered),
      // variant_gone, or a failure to ask (not_ucp / timeout / error / skipped). `stored_price` is our
      // crawl's price when the merchant's differed; `expected_total_withheld` says why no total was offered.
      // Only when a read happened: with every live-read flag off the signal is byte-identical to before.
      ...(toLiveRead(offer.live_read) ? { live_read: toLiveRead(offer.live_read) } : {}),
      // ONE SELLER LISTING's options (pivota-backend #2622): name one as `variant_id` on get_offers for its
      // own cart. No links here.
      ...(Array.isArray(offer.variants) && offer.variants.length
        ? { variant_count: Number.isInteger(offer.variant_count) ? offer.variant_count : offer.variants.length, variants: offer.variants.map(toVariantOption).filter(Boolean) }
        : {}),
    },
    evidence: {
      grade: null,
      confidence: offer.price_confidence != null && Number.isFinite(Number(offer.price_confidence))
        ? Number(offer.price_confidence)
        : null,
      method: 'merchant_reported',
      sources: [],
    },
    // A price the merchant answered moments ago is observed THEN, not when our crawl last wrote the row.
    freshness: {
      observed_at:
        'price_as_of' in priceFreshness
          ? priceFreshness.price_as_of
          : (offer.live_read && offer.live_read.status === 'verified' && offer.live_read.checked_at) || offer.updated_at || null,
      fresh_until: null,
    },
    seller_trust: null, // FUTURE: return_rate / shipping_rating from the agent_signal store
    visibility: 'buyer_safe',
  };
}

// "THIS SELLER CANNOT SELL IT" — the backend's OFFER_UNAVAILABLE_AVAILABILITIES (pivota-backend
// services/offer_buyability.py). The list itself lives in ONE place, src/services/offerAvailabilitySql.js,
// which also builds the SQL availability tier from it, so this pick and the canonical search / index feed
// LATERALs cannot drift apart. Only an explicit statement counts. The `in_stock` FLAG decides whenever it is
// a boolean — exactly as the backend's `_offer_is_known_unavailable` reads only the flag — and the
// availability string is consulted only when the flag is absent. That order matters: live verification
// CORRECTS `in_stock` to true on a restocked offer and leaves the feed's stale `availability: "out_of_stock"`
// beside it. `unknown`, null and anything unrecognised are NOT unavailability — the backend reports them as
// `in_stock: true` and ranks them with the in-stock offers, and ranking them lower here would make
// `best_offer` disagree with the backend's offers[0].
//
// NO PURCHASE-ROUTE EXEMPTION. INTERNAL (buy-here) offers used to be exempt here, mirroring a backend
// exemption, because their `in_stock` was computed from inventory_quantity alone and an untracked-inventory
// Shopify variant arrived as `in_stock: false`. pivota-backend #2221 removed the backend twin: an internal
// offer's `in_stock` is now the eligibility gate's own verdict (`standard_variant_in_stock`), so a false flag
// is trustworthy and a sold-out buy-here offer must not win best_offer over a seller that can sell.
function isKnownUnavailable(signal) {
  if (signal.value.in_stock === true) return false;
  if (signal.value.in_stock === false) return true;
  return isUnavailableAvailabilityText(signal.value.availability);
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

// A gateway live read that CHANGED an offer's facts this request: the merchant's price/stock answer, "gone",
// or "not priced in this market". The backend picked `best_price_offer_id` before it, on the stored facts.
function liveReadChangedFacts(offer) {
  const status = liveReadStatus(offer);
  return status === 'verified' || status === 'variant_gone' || status === 'currency_mismatch';
}

/**
 * THE BEST PRICE under the contract: ONE ranking, the gateway's `compare` (sellable, primary, stock tier,
 * price), over ONE set -- the SERVED offers (the signals this answer returns) that are `price_comparable`,
 * FRESH after this request's live reads (offerPriceIsStale), priced, and in ONE stated ISO currency (that of
 * the first such offer in the backend's rank order; a declared market has already cut the list to its own).
 * Nothing outside that set can be best: not another size, not a variant-less offer, not a stale price, not
 * another currency. An empty set is NO best price (best_offer null), never a fallback to the cheapest offer.
 *
 * `best_price_offer_id` does not rank. It names the claim's source: `offers_resolve` when the gateway's pick
 * IS the backend's and no live read changed the served offers' facts since the backend picked, else
 * `gateway`. The backend's id is reported beside it, so a pick outside the set is visible.
 */
function bestFreshComparable(served, compare, bestPriceOfferId) {
  const offerOf = new Map(served.map((p) => [p.signal, p.offer]));
  const eligible = served
    .filter((p) => p.offer.price_comparable === true && !offerPriceIsStale(p.offer))
    .map((p) => p.signal)
    .filter((s) => typeof s.value.price === 'number' && ISO_CURRENCY.test(String(s.value.currency || '').trim().toUpperCase()));
  const backendId = nonEmptyString(bestPriceOfferId) ? bestPriceOfferId : null;
  const reportBackend = bestPriceOfferId !== undefined ? { offers_resolve_offer_id: backendId } : {};
  if (!eligible.length) {
    return { best: null, best_price: { offer_id: null, reason: 'no_fresh_comparable_price', ...reportBackend } };
  }
  const basis = String(eligible[0].value.currency).trim().toUpperCase();
  const pool = eligible.filter((s) => String(s.value.currency).trim().toUpperCase() === basis).sort(compare);
  const best = pool[0];
  const offerId = offerOf.get(best).offer_id == null ? null : String(offerOf.get(best).offer_id);
  const fromBackend = backendId !== null && offerId === backendId && !served.some((p) => liveReadChangedFacts(p.offer));
  return {
    best,
    best_price: {
      offer_id: offerId,
      price: best.value.price,
      currency: basis,
      source: fromBackend ? 'offers_resolve' : 'gateway',
      ...reportBackend,
    },
  };
}

function offersToSignals(offers, opts = {}) {
  const { productId = null, limit = 10, bestPriceOfferId, now = Date.now } = opts;
  if (!Array.isArray(offers)) return { best_offer: null, signals: [] };
  const freshPriceContract = freshPriceContractOn(offers, bestPriceOfferId);
  const signals = [];
  const pairs = [];
  for (const o of offers) {
    const s = offerToSignal(o, { productId, freshPriceContract, now });
    if (s) {
      signals.push(s);
      pairs.push({ offer: o, signal: s });
    }
  }
  // best = SELLABLE, then primary, then CONFIRMED-IN-STOCK, then lowest price.
  //
  // SELLABLE FIRST. Measured on prod 2026-09-18: get_offers on the Purito Oat-in Calming Gel Cream
  // named eyurs.com $13 `out_of_stock` as best_offer over sokoglam.com $19.50 `in_stock`, because with
  // live verification off every offer is unchecked and price alone decided. A buyer's agent following
  // best_offer was sent to a seller that cannot sell. It sits above the verification tier. A VERIFIED
  // offer is never "known unavailable" here — the backend drops an offer its live check found out of
  // stock (GONE) and stamps every VERIFIED one `in_stock: true` — but the two tiers CAN disagree below
  // that: a check that merely FAILED (`stock_verified: false`, e.g. a fetch error) says nothing about
  // stock, while an unchecked offer whose feed says `in_stock: false` does. The sellable one wins. It
  // outranks `is_primary` because the primary seller being out of stock does not make it somewhere a
  // buyer can buy.
  //
  // The stock tier is not a preference, it is a correction. The backend already sorts its
  // shortlist verified-first, and without mirroring that here a cheaper offer we could NOT
  // confirm wins `best_offer` over one the merchant just confirmed — so the tool that advertises
  // live verification would hand the agent the unverified offer as its headline answer. An agent
  // that reads only `best_offer` never sees `rank_one_unverified` either, because that rides on
  // signals[0].
  //
  // Explicitly `=== false` for the middle tier: null means "not checked", which is not evidence
  // against an offer and must not be penalised the way a failed check is.
  const stockTier = (s) => {
    if (s.value.stock_verified === true) return 0;
    if (s.value.stock_verified === false) return 2;
    return 1; // unchecked — no evidence either way
  };
  const compare = (a, b) => {
    const sellable = Number(isKnownUnavailable(a)) - Number(isKnownUnavailable(b));
    if (sellable !== 0) return sellable;
    if (a.value.is_primary !== b.value.is_primary) return a.value.is_primary ? -1 : 1;
    const tier = stockTier(a) - stockTier(b);
    if (tier !== 0) return tier;
    return a.value.price - b.value.price;
  };
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 10, 10));
  if (freshPriceContract) {
    // Only what this answer serves can be best: the backend's pick may sit beyond the cap.
    const { best, best_price } = bestFreshComparable(pairs.slice(0, cap), compare, bestPriceOfferId);
    return { best_offer: best, signals: signals.slice(0, cap), best_price };
  }
  const priced = signals.filter((s) => typeof s.value.price === 'number');
  priced.sort(compare);
  const best_offer = priced.length ? priced[0] : signals[0] || null;
  return { best_offer, signals: signals.slice(0, cap) };
}

module.exports = { offerToSignal, offersToSignals };
