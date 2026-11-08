'use strict';

// THE PRICE FACTS OF ONE AGENT ANSWER, read from the NATIVE tool value (before the UCP shaper or the public
// projection strips price_source / price_as_of / live_read), for the `price_verification_served` line
// (src/observability/priceVerificationLog.js). Dependency-free so the MCP surfaces (mcp-server/src, ESM)
// can import it like externalSeedLane.
//
// A fact is { priced, merchant, at }: the item carries a positive price; the merchant answered it
// (price_source 'merchant_live', or an offer's merchant_price_verified: true); and when (epoch ms, from
// price_as_of or live_read.checked_at; null when unknown). Classifying a fact as live / recent / stored needs
// the request's start time and the surface's window, so it is done by the gateway when the line is written.
// A fact is a few scalars, so a cached answer can carry its facts and a replay is classified honestly.
//
// WHAT COUNTS IS WHAT THE DOOR SERVES. A fact describes the NATIVE item; whether that item's price reaches the
// agent depends on the door:
//   /mcp, invoke, REST  the native value IS the answer, so a price the answer flags for verification
//                       (commerce_verification.required, price_trusted: false) is still a price the agent was
//                       quoted: it counts (as stored, unless the merchant answered it).
//   /ucp/mcp            only the rows the UCP shaper publishes (commerceToolSurface): it drops a row that
//                       needs a live quote, has no id, or has no ISO-currency price.
//   /public/mcp         only the rows the public projection serves with a price (publicReadToolSurface).
//
// WHEN THE MERCHANT ANSWERED. `at` is read from price_as_of, then live_read.checked_at when that read is
// `verified` (a failed or skipped read is stamped too, and dates nothing). On a get_offers signal,
// price_as_of is the gateway's own live read on a verified offer, else the backend's price_checked_at (relayed
// under the fresh-price contract, agentSignals/offerToSignal). So a backend-verified offer
// (merchant_price_verified: true, no live read this request) is dated by the backend's last read when the
// contract carries one, and is `stored` when nothing dates it. freshness.observed_at is deliberately NOT read:
// without the contract it is the row's updated_at, a write, not a price read.
// A live_read.checked_at is stamped when the reader settles, and a reader's lookup memo (request coalescing,
// 30 s: services/ucpLiveOfferRead memoTtlMs) hands a second request the first one's answer with its own stamp.
// So `live` means "the merchant answered during this request, or at most ~30 s before it".

// PRICE_VERIFICATION_LOG (default off, read per call) gates every price line; off, no fact is computed.
const FLAG = 'PRICE_VERIFICATION_LOG';

function priceVerificationLogEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[FLAG]) || '').trim());
}

const TOOL_SURFACES = Object.freeze({
  search_catalog: 'search',
  get_product: 'get_product',
  get_offers: 'get_offers',
  recommend_products: 'recommend_products',
});
const MAX_ITEMS = 200;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function amountOf(item) {
  for (const v of [item.price, item.price_amount, item.priceAmount]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    if (isObj(v)) {
      const cur = isObj(v.current) ? v.current.amount : v.amount;
      if (cur != null && Number.isFinite(Number(cur))) return Number(cur);
    }
  }
  return null;
}

// A merchant's answer, by the price_source that names it: this request's live read ('merchant_live'), the fleet
// cache's answer ('merchant_cache', PRICE_CACHE_MODE=read), or the list contract's tokens for those two when
// LIST_ROW_PRICE_AS_OF relabels a row (services/listPriceTiers.js: 'live', 'cache'). 'stored' is not one.
const MERCHANT_SOURCES = new Set(['merchant_live', 'merchant_cache', 'live', 'cache']);

function answeredAtMs(item, { liveReadDates = true } = {}) {
  // live_read.checked_at says when the reader SETTLED, whatever it found: the readers stamp it on a skipped,
  // timed-out, failed, not-UCP, host-busy or variant-gone read too (ucpLiveOfferRead.applyRead). Only a
  // `verified` read is a merchant answer of that time (as offerToSignal.priceFreshnessFields reads it).
  const lr = liveReadDates && isObj(item.live_read) && item.live_read.status === 'verified' ? item.live_read : null;
  for (const raw of [item.price_as_of, lr && lr.checked_at]) {
    const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * The fact of one priced object (search card, product, offer, recommendation product, PDP card). Pure.
 * `o.liveReadDates: false` (get_product): a product's `live_read` sums up its VARIANTS' read, so a `verified`
 * one does not date the headline price; the product reader stamps `price_as_of` when it read that price.
 */
function priceFactOf(item, o) {
  if (!isObj(item)) return null;
  const amount = amountOf(item);
  // A price flagged for verification is still on the item: whether it is served is the door's call (see WHAT
  // COUNTS above), so the fact does not withhold it.
  return {
    priced: amount !== null && amount > 0,
    merchant: MERCHANT_SOURCES.has(item.price_source) || item.merchant_price_verified === true,
    at: answeredAtMs(item, o),
  };
}

/** The priced objects of a tool's native value. */
function pricedItemsOf(tool, value) {
  if (!isObj(value)) return [];
  if (tool === 'search_catalog') return Array.isArray(value.products) ? value.products : [];
  if (tool === 'get_product') return [isObj(value.product) ? value.product : value];
  if (tool === 'get_offers') {
    return (Array.isArray(value.signals) ? value.signals : []).map((s) => (isObj(s) && isObj(s.value) ? s.value : null));
  }
  if (tool === 'recommend_products') {
    return (Array.isArray(value.signals) ? value.signals : [])
      .map((s) => (isObj(s) && isObj(s.value) && isObj(s.value.product) ? s.value.product : null));
  }
  return [];
}

/** A compact copy of a search answer's `.json` overlay outcome (metadata.live_merchant_price), scalars only. */
function overlayOutcomeOf(value) {
  const m = isObj(value) && isObj(value.metadata) && isObj(value.metadata.live_merchant_price)
    ? value.metadata.live_merchant_price : null;
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && TOKEN.test(v)) out[k] = v;
  }
  if (isObj(m.failure_reasons)) {
    out.failure_reasons = {};
    for (const [k, v] of Object.entries(m.failure_reasons).slice(0, 20)) {
      if (TOKEN.test(k) && Number.isInteger(v)) out.failure_reasons[k] = v;
    }
  }
  if (isObj(m.ucp)) {
    out.ucp = {};
    for (const k of ['mode', 'planned_count', 'settled_count', 'verified_count']) {
      const v = m.ucp[k];
      if ((typeof v === 'string' && TOKEN.test(v)) || Number.isInteger(v)) out.ucp[k] = v;
    }
  }
  return out;
}

/**
 * `{ price_facts: { tool, surface, items: [fact], overlay } }` for a priced tool's native value, to hand to
 * the door's `observe` (the tools/call recorder drops the key; only the price line reads it). null for any
 * other tool, and whenever PRICE_VERIFICATION_LOG is off. Never throws.
 *
 * @param {string} tool  the canonical tool id (search_catalog, get_product, get_offers, recommend_products)
 * @param {object} value the tool's native result
 * @param {{ limit?: number }} [o]  only the first `limit` items (a page the projector will slice to)
 */
function priceFactsOf(tool, value, { limit } = {}) {
  try {
    if (!priceVerificationLogEnabled()) return null;
    const surface = TOOL_SURFACES[tool];
    if (!surface) return null;
    let items = pricedItemsOf(tool, value);
    if (Number.isInteger(limit) && limit >= 0) items = items.slice(0, limit);
    const factOptions = tool === 'get_product' ? { liveReadDates: false } : undefined;
    const facts = items.slice(0, MAX_ITEMS).map((item) => priceFactOf(item, factOptions)).filter(Boolean);
    // A product names the market its live read ran for (`live_read.market`, declared, never inferred).
    const declared = isObj(value) && isObj(value.metadata) ? value.metadata.market : null;
    const market = typeof declared === 'string' ? declared
      : tool === 'get_product' && isObj(items[0]) && isObj(items[0].live_read) ? items[0].live_read.market : null;
    return {
      price_facts: {
        tool,
        surface,
        items: facts,
        market: typeof market === 'string' && /^[A-Za-z]{2}$/.test(market.trim()) ? market.trim().toUpperCase() : null,
        ...(tool === 'search_catalog' ? { overlay: overlayOutcomeOf(value) } : {}),
      },
    };
  } catch {
    return null;
  }
}

// ---- the door caches' price-freshness cap (FIX_PLAN 1.17, P2-5) ------------------------------------------------
//
// Shopify's limit for keeping a price or stock answer is 15 minutes, and the fleet price cache honours it
// (services/priceCache.js MAX_PRICE_WINDOW_MS). The DOOR caches replay whole answers on top of that: the /mcp and
// /ucp/mcp read cache up to 15 min (stale-served), the public tier up to 60 min, so a merchant answer could be
// served ~30 min (or more) after it was read. DOOR_CACHE_PRICE_FRESHNESS_CAP (off | on, default off, read per
// store): on, an entry holding a MERCHANT ANSWER (a fact with merchant: true and a read time) is kept only until
// its EARLIEST such answer is 15 minutes old -- its ttl and its stale window both end there, and an entry already
// past it is not stored. Entries with stored prices only keep their own clocks (they carry no merchant answer;
// their age is the 7-day staleness rule's business). Off: every door cache's TTLs exactly as before.
const DOOR_CAP_FLAG = 'DOOR_CACHE_PRICE_FRESHNESS_CAP';
const DOOR_CAP_WINDOW_MS = 15 * 60 * 1000;

function doorCachePriceFreshnessCapEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[DOOR_CAP_FLAG]) || '').trim());
}

/** The earliest merchant-answer read time (epoch ms) among `items` (priced objects), or null. Pure. */
function earliestMerchantAnswerMsOfItems(items, o) {
  let min = null;
  for (const item of Array.isArray(items) ? items : []) {
    const f = priceFactOf(item, o);
    if (f && f.priced && f.merchant && Number.isFinite(f.at)) min = min === null ? f.at : Math.min(min, f.at);
  }
  return min;
}

/** As above, for a priced tool's native value. Pure; independent of PRICE_VERIFICATION_LOG. */
function earliestMerchantAnswerMs(tool, value) {
  try {
    return earliestMerchantAnswerMsOfItems(pricedItemsOf(tool, value), tool === 'get_product' ? { liveReadDates: false } : undefined);
  } catch {
    return null;
  }
}

/**
 * `policy` ({ ttlMs, staleMs } measured from now) capped so the entry ends when its earliest merchant answer is
 * 15 min old; null (do not store) when that is already past; `policy` itself when there is no merchant answer or
 * no policy. Pure.
 */
function capCachePolicyAtPriceAge(policy, earliestMs, nowMs = Date.now()) {
  if (!policy || !Number.isFinite(earliestMs)) return policy;
  const left = earliestMs + DOOR_CAP_WINDOW_MS - nowMs;
  if (!(left > 0)) return null;
  return {
    ...policy,
    ttlMs: Math.min(Number.isFinite(policy.ttlMs) ? policy.ttlMs : left, left),
    staleMs: Math.min(Number.isFinite(policy.staleMs) ? policy.staleMs : left, left),
  };
}

module.exports = {
  FLAG, priceVerificationLogEnabled, TOOL_SURFACES, priceFactOf, priceFactsOf, pricedItemsOf, overlayOutcomeOf,
  DOOR_CAP_FLAG, DOOR_CAP_WINDOW_MS, doorCachePriceFreshnessCapEnabled, earliestMerchantAnswerMs,
  earliestMerchantAnswerMsOfItems, capCachePolicyAtPriceAge,
};
