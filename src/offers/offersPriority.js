'use strict';

/*
 * offersPriority.js — offer presentation order AND the per-offer commerce stamp.
 *
 * ---- THE MERCHANT-PURCHASABILITY GATE, PATH 3 OF 3 ---------------------------------------
 *
 * `enrichOfferCommerceMetadata` stamps `merchant_checkout_url` — a direct "check out
 * here" link — onto EVERY served offer, one layer earlier than the warm handoff and
 * without passing through it at all. A handoff URL is still a recommendation: a page
 * that sends a shopper to a checkout which cannot take their card wastes the same trip
 * whether we call it a purchase, a handoff or a link (docs/merchant-purchasability-gate.md
 * §8, the flowerbeauty.com incident).
 *
 * So the same switch (`MERCHANT_PURCHASABILITY_GATE_ENABLED`, default OFF) and the same
 * `shouldOfferPurchase` — the SAME process singleton and therefore the same bounded cache
 * the warm-handoff seam uses — decide whether that URL is stamped. When the backend is
 * enforcing and says `browse_only` for this merchant × market, the URL is NOT STAMPED.
 * The OFFER SURVIVES: browse/referral is exactly what is left, and dropping the row would
 * delete a result the shopper asked for to avoid a link they did not.
 *
 * ⚠️ THE DECISION IS TAKEN BEFORE THE URL IS BUILT, NOT AFTER. `resolveOfferPurchasability
 * Decisions` runs first and hands `annotateOffersWithCommerceMetadata` a set of declined
 * domains; `enrichOfferCommerceMetadata` then never constructs the `merchant_checkout_url`
 * key at all. Building it and stripping it afterwards would be one refactor away from
 * leaking it, and it is in the mutant sweep.
 *
 * ⚠️ THIS IS A BATCH, AND A BATCH IS WHY THE DOC CALLED IT A FOLLOW-UP. A page of offers
 * spans MANY merchants while the client is a per-merchant read, so three bounds apply and
 * all three are asserted:
 *   1. DEDUPE — N offers for the same merchant × market are ONE question (a `Set` of
 *      distinct domains here, plus the client's own ≤5-minute cache behind it).
 *   2. CONCURRENCY — at most `GATE_CONCURRENCY` reads in flight, so a page of 40 merchants
 *      is not 40 simultaneous sockets.
 *   3. A TOTAL WALL-CLOCK BUDGET — the per-call ceiling must NOT multiply by ceil(M/C).
 *      `GATE_BATCH_BUDGET_MS` bounds the WHOLE batch; each read is clamped to what is left,
 *      and below the client's own `MIN_GATE_BUDGET_MS` floor the remaining merchants are
 *      not asked at all and keep the previous behaviour. Same shape as the warm-handoff
 *      seam's budget clamp, for the same reason: fail-open in name is a cold page in fact
 *      if the gate eats the request.
 *
 * With the switch OFF nothing is asked, no domain is even parsed, and every function here
 * is byte-identical to before this change — pinned by snapshot, not asserted.
 */

const {
  MIN_GATE_BUDGET_MS,
  isGateEnabled,
  getMerchantPurchasabilityClient,
} = require('../services/merchantPurchasabilityClient');

/** At most this many purchasability reads in flight for one page of offers. */
const GATE_CONCURRENCY = 4;

/**
 * HARD WALL-CLOCK CEILING for the WHOLE batch, not per merchant. Without it a page across
 * M merchants costs ceil(M / GATE_CONCURRENCY) × the client's per-call timeout — the client's
 * 1.5 s becoming 15 s on a 40-merchant page against a slow-but-not-dead backend.
 */
const GATE_BATCH_BUDGET_MS = 1200;

function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeUrl(value) {
  const s = asString(value);
  return s ? s : null;
}

function readPurchaseRoute(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(o.purchase_route ?? o.purchaseRoute).toLowerCase();
}

function hasInternalPayload(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return false;
  return Boolean(o.internal_checkout ?? o.internalCheckout);
}

function readCheckoutUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.checkout_url ??
      o.checkoutUrl ??
      o.purchase_url ??
      o.purchaseUrl ??
      o.internal_checkout_url ??
      o.internalCheckoutUrl,
  );
}

function readAffiliateUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.affiliate_url ??
      o.affiliateUrl ??
      o.external_redirect_url ??
      o.externalRedirectUrl ??
      o.external_url ??
      o.externalUrl,
  );
}

function readGenericUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(o.url);
}

function readMerchantCheckoutSession(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  const session =
    o.merchant_checkout_session ??
    o.merchantCheckoutSession ??
    o.checkout_session ??
    o.checkoutSession ??
    o.internal_checkout ??
    o.internalCheckout;
  return session && typeof session === 'object' ? session : null;
}

function isInternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'internal_checkout') return true;
  if (hasInternalPayload(offer)) return true;
  if (readCheckoutUrl(offer)) return true;
  return false;
}

function isExternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'affiliate_outbound') return true;
  if (readAffiliateUrl(offer)) return true;
  return false;
}

function inferCommerceMode(offer) {
  if (isInternalOffer(offer) || readMerchantCheckoutSession(offer)) return 'merchant_embedded_checkout';
  if (isExternalOffer(offer) || readGenericUrl(offer)) return 'links_out';
  return 'merchant_embedded_checkout';
}

function inferCheckoutHandoff(offer) {
  return inferCommerceMode(offer) === 'merchant_embedded_checkout' ? 'embedded' : 'redirect';
}

/**
 * The ONE spelling of "the URL this offer would be stamped with". The gate must ask about
 * exactly the host the shopper would be sent to, so the decision and the stamp read the
 * same expression — a second, drifting copy is how a gate ends up asking about a merchant
 * other than the one in the link.
 */
function readOfferStampedCheckoutUrl(offer) {
  return (
    readCheckoutUrl(offer) ||
    readAffiliateUrl(offer) ||
    readGenericUrl(offer)
  );
}

/** Registrable-ish host of that URL, normalised the way the gate client normalises a domain. */
function readOfferMerchantDomain(offer) {
  const url = readOfferStampedCheckoutUrl(offer);
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function declinedSetOf(options) {
  const set = options && options.declinedDomains;
  return set instanceof Set && set.size > 0 ? set : null;
}

function enrichOfferCommerceMetadata(offer, options) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return offer;

  const commerceMode = inferCommerceMode(offer);
  const checkoutHandoff = inferCheckoutHandoff(offer);
  const checkoutUrl = readOfferStampedCheckoutUrl(offer);
  const merchantCheckoutSession = readMerchantCheckoutSession(offer);

  // THE SEAM. The gate decides whether the key EXISTS; it never edits one that was written.
  // `declinedDomains` is empty (and this is `false`) on every path where the switch is off,
  // the backend is not enforcing, the read failed, or no market was carried — i.e. the
  // previous behaviour, byte for byte.
  const declined = declinedSetOf(options);
  const merchantNotPurchasable = Boolean(
    checkoutUrl && declined && declined.has(readOfferMerchantDomain(offer)),
  );

  return {
    ...offer,
    commerce_mode: commerceMode,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    checkout_handoff: checkoutHandoff,
    order_writeback_mode: 'merchant_direct',
    ...(checkoutUrl && !merchantNotPurchasable ? { merchant_checkout_url: checkoutUrl } : {}),
    ...(merchantCheckoutSession ? { merchant_checkout_session: merchantCheckoutSession } : {}),
  };
}

function annotateOffersWithCommerceMetadata(offers, options) {
  const arr = Array.isArray(offers) ? offers : [];
  return arr.map((offer) => enrichOfferCommerceMetadata(offer, options));
}

/**
 * Ask the merchant-purchasability gate about every DISTINCT merchant on this page of
 * offers, and answer with the set of domains whose `merchant_checkout_url` must not be
 * stamped for this market.
 *
 * FAILS OPEN, ALWAYS: the empty set is the previous behaviour, and it is what every
 * failure, every non-enforcing backend, every missing market and the switch-off path all
 * return. Nothing here throws into the serving path.
 *
 * @param {Array} offers
 * @param {{ market?: string, env?: object, budgetMs?: number, now?: Function,
 *           shouldOfferPurchase?: Function, concurrency?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
async function resolveOfferPurchasabilityDecisions(offers, options = {}) {
  const declined = new Set();
  const env = options.env || process.env;

  // THE SWITCH, READ FIRST AND HERE. Off means nothing is asked — not "asked and ignored".
  // A page of offers is the latency-sensitive surface in this repo; paying for a read whose
  // answer is discarded is the defect, so the flag is checked before a single domain is
  // parsed. A test with the switch off asserts the injected gate is called ZERO times.
  if (!isGateEnabled(env)) return declined;

  const arr = Array.isArray(offers) ? offers : [];
  if (arr.length === 0) return declined;

  // DEDUPE FIRST: N offers for one merchant × market are ONE question.
  const domains = [...new Set(arr.map((offer) => readOfferMerchantDomain(offer)).filter(Boolean))];
  if (domains.length === 0) return declined;

  const gate = typeof options.shouldOfferPurchase === 'function'
    ? options.shouldOfferPurchase
    : (args) => getMerchantPurchasabilityClient().shouldOfferPurchase(args);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  const totalBudgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0
    ? Math.min(options.budgetMs, GATE_BATCH_BUDGET_MS)
    : GATE_BATCH_BUDGET_MS;
  const concurrency = Math.max(
    1,
    Math.min(
      Number.isFinite(options.concurrency) && options.concurrency > 0 ? options.concurrency : GATE_CONCURRENCY,
      domains.length,
    ),
  );

  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= domains.length) return;
      // THE BATCH BUDGET FLOOR. What is LEFT of the page's budget, not the client's own
      // ceiling — otherwise the ceiling multiplies by ceil(M / concurrency). Below the
      // client's floor there is no useful question left to ask, so the remaining merchants
      // keep the previous behaviour rather than each paying a doomed timeout.
      const remainingMs = totalBudgetMs - (now() - startedAt);
      if (remainingMs < MIN_GATE_BUDGET_MS) return;
      let decision = null;
      try {
        decision = await gate({
          domain: domains[index],
          market: options.market,
          budgetMs: remainingMs,
        });
      } catch {
        decision = null; // fail open: the client does not throw, and a future one must not either
      }
      // STRICTLY `=== false`. A loose compare would take `undefined`/`''`/`0` from a
      // malformed or future answer as a refusal, which is fail-CLOSED by accident.
      if (decision && decision.offer === false) declined.add(domains[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return declined;
}

/** `annotateOffersWithCommerceMetadata`, with the gate consulted first. */
async function annotateOffersWithCommerceMetadataGated(offers, options = {}) {
  const declinedDomains = await resolveOfferPurchasabilityDecisions(offers, options);
  return annotateOffersWithCommerceMetadata(offers, { declinedDomains });
}

function summarizeOfferCommerceMetadata(offers, options) {
  const arr = annotateOffersWithCommerceMetadata(offers, options);
  const modes = Array.from(
    new Set(arr.map((offer) => asString(offer?.commerce_mode)).filter(Boolean)),
  );
  return {
    offers: arr,
    commerce_modes: modes,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    order_writeback_mode: 'merchant_direct',
  };
}

function readOfferCurrency(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(
    o?.price?.currency ??
      o?.price?.current?.currency ??
      o?.currency,
  ).toUpperCase();
}

function offerHasAvailableInventory(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return false;
  const inStock = o?.inventory?.in_stock ?? o?.inventory?.inStock ?? o?.in_stock ?? o?.inStock;
  return inStock !== false;
}

function computeOfferTotal(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return Number.POSITIVE_INFINITY;
  const price = Number(o?.price?.amount ?? o?.price?.current?.amount);
  if (!Number.isFinite(price) || price <= 0) return Number.POSITIVE_INFINITY;
  const shipping = Number(o?.shipping?.cost?.amount ?? 0) || 0;
  return price + shipping;
}

function readExpectedCurrency(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(
    o?.agent_safe_commerce_facts?.currency_target ??
      o?.commerce_facts_v1?.currency_target ??
      o?.commerce_facts?.currency_target,
  ).toUpperCase();
}

function offerMatchesExpectedCurrency(offer) {
  const expected = readExpectedCurrency(offer);
  const observed = readOfferCurrency(offer);
  if (!expected || !observed) return false;
  return expected === observed;
}

function scoreCommerceFactsCompleteness(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return 0;
  const facts = o.agent_safe_commerce_facts || o.commerce_facts_v1 || o.commerce_facts || {};
  let score = 0;
  if (facts?.regional_price?.amount != null && readOfferCurrency(offer)) score += 1;
  if (asString(facts?.availability?.status)) score += 1;
  if (asString(facts?.shipping?.status) && asString(facts?.shipping?.status).toLowerCase() !== 'unknown') score += 1;
  if (asString(facts?.returns?.status) && asString(facts?.returns?.status).toLowerCase() !== 'unknown') score += 1;
  if (Array.isArray(facts?.promotions) && facts.promotions.length > 0) score += 1;
  return score;
}

function scoreOfferForPriority(offer) {
  return offer && typeof offer === 'object' ? 0 : 99;
}

function compareOffersForPresentation(a, b) {
  const aInStock = offerHasAvailableInventory(a) ? 1 : 0;
  const bInStock = offerHasAvailableInventory(b) ? 1 : 0;
  if (aInStock !== bInStock) return bInStock - aInStock;

  const aCurrencyMatch = offerMatchesExpectedCurrency(a) ? 1 : 0;
  const bCurrencyMatch = offerMatchesExpectedCurrency(b) ? 1 : 0;
  if (aCurrencyMatch !== bCurrencyMatch) return bCurrencyMatch - aCurrencyMatch;

  const aTotal = computeOfferTotal(a);
  const bTotal = computeOfferTotal(b);
  if (aTotal !== bTotal) return aTotal < bTotal ? -1 : 1;

  const completenessDelta = scoreCommerceFactsCompleteness(b) - scoreCommerceFactsCompleteness(a);
  if (completenessDelta !== 0) return completenessDelta;

  return scoreOfferForPriority(a) - scoreOfferForPriority(b);
}

function prioritizeOffers(offers) {
  const arr = Array.isArray(offers) ? offers.slice() : [];
  if (arr.length <= 1) return arr;

  const scored = arr.map((o, idx) => ({ o, idx }));
  scored.sort((a, b) => compareOffersForPresentation(a.o, b.o) || a.idx - b.idx);
  return scored.map((x) => x.o);
}

function pickDefaultOfferId(offers) {
  const prioritized = prioritizeOffers(offers);
  return prioritized[0]?.offer_id || null;
}

function readResolveResponseOffers(upstreamData) {
  const data = upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : null;
  if (!data) return [];
  if (Array.isArray(data.offers)) return data.offers;
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    return data.data.offers;
  }
  return [];
}

function prioritizeOffersResolveResponse(upstreamData, options) {
  const data = upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : null;
  if (!data) return upstreamData;

  if (Array.isArray(data.offers)) {
    const prioritized = prioritizeOffers(data.offers);
    const summary = summarizeOfferCommerceMetadata(prioritized, options);
    return {
      ...data,
      offers: summary.offers,
      ...(pickDefaultOfferId(summary.offers) ? { default_offer_id: pickDefaultOfferId(summary.offers) } : {}),
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    const prioritized = prioritizeOffers(data.data.offers);
    const summary = summarizeOfferCommerceMetadata(prioritized, options);
    return {
      ...data,
      data: {
        ...data.data,
        offers: summary.offers,
        ...(pickDefaultOfferId(summary.offers) ? { default_offer_id: pickDefaultOfferId(summary.offers) } : {}),
      },
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  return upstreamData;
}

/** `prioritizeOffersResolveResponse`, with the gate consulted first. Same bounds, same fail-open. */
async function prioritizeOffersResolveResponseGated(upstreamData, options = {}) {
  const declinedDomains = await resolveOfferPurchasabilityDecisions(
    readResolveResponseOffers(upstreamData),
    options,
  );
  return prioritizeOffersResolveResponse(upstreamData, { declinedDomains });
}

module.exports = {
  GATE_BATCH_BUDGET_MS,
  GATE_CONCURRENCY,
  readOfferMerchantDomain,
  resolveOfferPurchasabilityDecisions,
  annotateOffersWithCommerceMetadataGated,
  prioritizeOffersResolveResponseGated,
  annotateOffersWithCommerceMetadata,
  enrichOfferCommerceMetadata,
  compareOffersForPresentation,
  computeOfferTotal,
  isInternalOffer,
  pickDefaultOfferId,
  prioritizeOffers,
  prioritizeOffersResolveResponse,
  summarizeOfferCommerceMetadata,
};
