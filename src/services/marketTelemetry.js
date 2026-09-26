'use strict';

// MARKET TELEMETRY — what the caller asked for, what the door bound, and what it served.
//
// WHY THIS EXISTS. Nothing records whether a caller names a market. Measured 2026-09-18, the
// invoke log line carries operation/status/latency/client_channel and no market, locale or
// region field at all, and the Python door emits no equivalent event. So three decisions have
// no data behind them: what a market-less request should default to, whether the two doors
// agree, and how much traffic would move if the default changed.
//
// IT RECORDS WHAT WAS BOUND, AT THE MOMENT IT IS BOUND. It never re-derives the market.
// The first version of this module called marketsForRequest itself, on what it believed the
// door's input was -- and review of #2239 showed it believed wrong in three ways the door does
// not: a flat payload (no `search` object) was counted as `defaulted`, a whitespace
// `search.market` was trimmed away where the door keeps it, and `false` became the string
// "false". Each produced a logged market the SQL never bound, on exactly the number this
// telemetry exists to measure. So the door now calls `observeBoundMarket` beside its own bind,
// with its own values, and this module only formats what it is handed.
//
// When a request never reaches that bind (a safe-empty answer, an upstream-routed lane), there
// is no observation, and the record says so -- `market_observed: false`, `market_bound: null`
// -- rather than guessing what would have been bound.
//
// Fields, all additive, on the invoke completion log line, find_products_multi only:
//   market_observed           true when the door's bind ran for this request
//   market_requested          the value the door read (or the caller sent), capped; else null
//   market_source             explicit_search | explicit_metadata | defaulted
//   market_bound              what the door bound, or null when it bound nothing
//   market_buyer_currency     the currency the named market was read as (Stage 0a,
//                             FIND_PRODUCTS_BUYER_MARKET); null when the market was bound as a
//                             partition, the flag is off, or the door never bound
//   served_currencies         the distinct currencies on the served page
//   served_currency_mismatch  true when the page mixes more than one KNOWN currency
//   served_price_sources      row counts by recall source (a stand-in for price copy -- see below)
//   lane                      the beauty direct lane that answered; ABSENT for every other
//                             path, including all upstream-routed traffic -- so it cannot, on its
//                             own, split the Python door's lanes
//   query_source              the response's own metadata.query_source: which lane actually
//                             served the page, for EVERY lane. Measured 2026-09-26: 31% of 30 days
//                             of traffic (discovery bridge, ingredient direct, early exits) set no
//                             lane and recorded no stage, so which lane served it was unknowable
//   primary_path_used         the response's metadata.route_health.primary_path_used

const MAX_CURRENCIES = 8;
const MAX_PRICE_SOURCES = 6;
// A caller's `market` is free text. Capped so junk cannot bloat every log line or become an
// unbounded metrics label; a real market code is two letters.
const MAX_REQUESTED_CHARS = 16;
// Lane names are code constants, but a lane that relays the backend's value relays whatever the
// backend sent, so they are capped too.
const MAX_SERVED_BY_CHARS = 64;

function capRequested(raw) {
  if (raw == null) return null;
  const text = String(raw);
  return text.length > MAX_REQUESTED_CHARS ? `${text.slice(0, MAX_REQUESTED_CHARS)}…` : text;
}

// The door's OWN precedence, applied to the door's OWN raw values: `search.market ||
// metadata.market`, JavaScript truthiness, no trimming. Whitespace is truthy here exactly as it
// is at the bind; `false`/`0` are falsy here exactly as they are there.
function describeRequested(search, metadata) {
  const fromSearch = search && typeof search === 'object' ? search.market : undefined;
  const fromMetadata = metadata && typeof metadata === 'object' ? metadata.market : undefined;
  const raw = fromSearch || fromMetadata;
  return {
    requested: raw ? capRequested(raw) : null,
    source: fromSearch ? 'explicit_search' : (fromMetadata ? 'explicit_metadata' : 'defaulted'),
  };
}

/**
 * Called BY THE DOOR, beside its bind, with the values it bound. `store` is the per-request
 * observation object (null outside a request). Never throws.
 */
function observeBoundMarket(store, { search, metadata, markets, buyerCurrency } = {}) {
  if (!store || typeof store !== 'object') return;
  try {
    const described = describeRequested(search, metadata);
    store.market_observed = true;
    store.market_requested = described.requested;
    store.market_source = described.source;
    store.market_bound = Array.isArray(markets) ? [...markets] : null;
    store.market_buyer_currency = buyerCurrency || null;
  } catch (_) {
    // Telemetry must never be able to fail the surface it measures.
  }
}

/**
 * The request side, for a request the door never bound. It reads the payload the way the early
 * lane does -- `payload.search` when that is a plain object, otherwise the payload itself -- so
 * a flat `{query, market}` payload is not miscounted as `defaulted`. It reports NO binding.
 */
function describeUnboundRequest(payload, metadata) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const search = body.search && typeof body.search === 'object' && !Array.isArray(body.search)
    ? body.search
    : body;
  const described = describeRequested(search, metadata);
  return {
    market_observed: false,
    market_requested: described.requested,
    market_source: described.source,
    market_bound: null,
    market_buyer_currency: null,
  };
}

/**
 * The currencies and recall sources of a served page.
 *
 * A row with no currency is `unknown`, not a default. On THIS door that can only be a non-seed
 * row: the seed card builder already stamps `'USD'` on seed rows that lack a currency
 * (server.js buildBeautyExternalSeedMainlineProduct) before this module ever sees them -- so a
 * seed row with a genuinely unknown currency is reported as USD here. That is the upstream
 * default, not this module's.
 *
 * `served_price_sources` counts the RECALL source (`canonical_chain`, `external_seed`, ...), the
 * same field the door uses to classify recall. It is the nearest honest stand-in for "which
 * copy of the price did this row carry"; read it as recall source, not as offer-vs-seed.
 */
function summariseServedProducts(products = []) {
  const list = Array.isArray(products) ? products : [];
  const currencies = new Set();
  const priceSources = new Map();
  for (const product of list) {
    if (!product || typeof product !== 'object') continue;
    const currency = String(product.currency || product.price_currency || '').trim().toUpperCase();
    currencies.add(currency || 'unknown');
    const source = String(product.source || product.search_recall_source || product.catalog_source || '').trim()
      || 'unknown';
    priceSources.set(source, (priceSources.get(source) || 0) + 1);
  }
  const served = [...currencies].sort().slice(0, MAX_CURRENCIES);
  // "Mixed" means more than one KNOWN currency. A page of SGD rows plus one unpriced row is
  // incomplete, not mixed; conflating the two would make the counter useless for its question.
  const known = served.filter((code) => code !== 'unknown');
  return {
    served_currencies: served,
    served_currency_mismatch: known.length > 1,
    served_price_sources: Object.fromEntries([...priceSources.entries()].slice(0, MAX_PRICE_SOURCES)),
  };
}

/** The lane that produced the rows: the LAST lane recorded, since every lane's failure path
 *  answers the request itself rather than falling through. */
function capServedBy(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  return text.length > MAX_SERVED_BY_CHARS ? `${text.slice(0, MAX_SERVED_BY_CHARS)}…` : text;
}

// Which lane served the page, as the page itself says: every lane stamps metadata.query_source.
function servedByFromBody(body) {
  const metadata = body && typeof body === 'object' && !Array.isArray(body) ? body.metadata : null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const routeHealth =
    metadata.route_health && typeof metadata.route_health === 'object' ? metadata.route_health : null;
  const querySource = capServedBy(metadata.query_source);
  const primaryPathUsed = capServedBy(routeHealth && routeHealth.primary_path_used);
  return {
    ...(querySource ? { query_source: querySource } : {}),
    ...(primaryPathUsed ? { primary_path_used: primaryPathUsed } : {}),
  };
}

function laneFromStageBreakdown(stages = []) {
  const list = Array.isArray(stages) ? stages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const lane = String((list[i] && list[i].lane) || '').trim();
    if (lane) return lane;
  }
  return null;
}

/**
 * The whole record for one response. `body` is the response body as sent; the products are
 * read from it HERE, so that reading is testable rather than a seam in the handler.
 * Returns `{}` for any operation other than find_products_multi.
 */
function buildMarketTelemetry({ operation, observation, payload, metadata, body, stages } = {}) {
  if (String(operation || '').trim().toLowerCase() !== 'find_products_multi') return {};
  const market = observation && observation.market_observed === true
    ? {
      market_observed: true,
      market_requested: observation.market_requested,
      market_source: observation.market_source,
      market_bound: observation.market_bound,
      market_buyer_currency: observation.market_buyer_currency || null,
    }
    : describeUnboundRequest(payload, metadata);
  const products = body && typeof body === 'object' && !Array.isArray(body) ? body.products : null;
  const lane = laneFromStageBreakdown(stages);
  return {
    ...market,
    ...summariseServedProducts(products),
    ...(lane ? { lane } : {}),
    ...servedByFromBody(body),
  };
}

module.exports = {
  MAX_REQUESTED_CHARS,
  buildMarketTelemetry,
  describeRequested,
  describeUnboundRequest,
  laneFromStageBreakdown,
  observeBoundMarket,
  servedByFromBody,
  summariseServedProducts,
};
