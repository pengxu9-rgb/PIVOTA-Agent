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

function answeredAtMs(item) {
  const lr = isObj(item.live_read) ? item.live_read : null;
  for (const raw of [item.price_as_of, lr && lr.checked_at]) {
    const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** The fact of one priced object (search card, product, offer, recommendation product, PDP card). Pure. */
function priceFactOf(item) {
  if (!isObj(item)) return null;
  const amount = amountOf(item);
  // A price the answer itself tells the agent not to rely on (commerce verification required, price not
  // trusted) is withheld by the UCP shaper and the public projection: on no door is it a served price.
  const cv = isObj(item.commerce_verification) ? item.commerce_verification : null;
  const withheld = Boolean(cv && (cv.required === true || cv.price_trusted === false));
  return {
    priced: !withheld && amount !== null && amount > 0,
    merchant: item.price_source === 'merchant_live' || item.merchant_price_verified === true,
    at: answeredAtMs(item),
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
    const facts = items.slice(0, MAX_ITEMS).map(priceFactOf).filter(Boolean);
    return {
      price_facts: {
        tool,
        surface,
        items: facts,
        market: isObj(value) && isObj(value.metadata) && typeof value.metadata.market === 'string'
          && /^[A-Za-z]{2}$/.test(value.metadata.market.trim()) ? value.metadata.market.trim().toUpperCase() : null,
        ...(tool === 'search_catalog' ? { overlay: overlayOutcomeOf(value) } : {}),
      },
    };
  } catch {
    return null;
  }
}

module.exports = { FLAG, priceVerificationLogEnabled, TOOL_SURFACES, priceFactOf, priceFactsOf, pricedItemsOf, overlayOutcomeOf };
