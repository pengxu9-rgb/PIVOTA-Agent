'use strict';

// MARKET TELEMETRY — what the caller asked for, what the door bound, and what it served.
//
// WHY THIS EXISTS. Nothing records whether a caller names a market. Measured 2026-09-18, the
// invoke log line carries operation/status/latency/client_channel and no market, locale or
// region field at all, and the Python door emits no equivalent event. So three decisions have
// no data behind them: what a market-less request should default to, whether the two doors
// agree, and how much traffic would move if the default changed.
//
// It is DESCRIPTIVE ONLY. Nothing here decides anything — `marketsForRequest` (servedMarkets.js)
// remains the single authority on what gets bound, and this module calls it rather than
// re-deriving it, so the telemetry cannot drift from the behaviour it reports. Adding a second
// implementation of "what market is this" is the exact mistake this system already made eight
// times (see servedMarkets.js's header).
//
// The recorded fields, all additive:
//   market_requested          what the caller sent, verbatim, or null
//   market_source             explicit_search | explicit_metadata | defaulted
//   market_bound              what the door actually bound (from marketsForRequest)
//   served_currencies         the distinct currencies on the served page
//   served_currency_mismatch  true when a page mixes currencies -- observed in prod on the
//                             Python door (SGD 28.20 beside USD 10.40), so this is a real
//                             counter, not a hypothetical one
//   served_price_sources      row counts by recall source, the nearest honest stand-in for
//                             "which copy of the price did this row carry"

const { marketsForRequest } = require('./servedMarkets');

const MAX_CURRENCIES = 8;
const MAX_PRICE_SOURCES = 6;

function firstString(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * What the caller asked for, and where they said it. `search.market` wins over
 * `metadata.market` because that is the precedence the door itself applies.
 */
function resolveRequestedMarket(search = {}, metadata = {}) {
  const fromSearch = firstString(search && search.market);
  const fromMetadata = firstString(metadata && metadata.market);
  const requested = fromSearch || fromMetadata || null;
  const source = fromSearch ? 'explicit_search' : (fromMetadata ? 'explicit_metadata' : 'defaulted');
  // The SAME call the door makes, so `market_bound` is what was bound, not a guess at it.
  let bound = [];
  try {
    bound = marketsForRequest(requested);
  } catch (err) {
    bound = [];
  }
  return { requested, source, bound };
}

/**
 * The currencies and recall sources of a served page. Reads only what a product already
 * carries; a row with no currency is counted as `unknown` rather than stamped with a default,
 * because "we do not know" and "USD" are different answers and the second one is how a
 * currency gets invented.
 */
function summariseServedProducts(products = []) {
  const list = Array.isArray(products) ? products : [];
  const currencies = new Set();
  const priceSources = new Map();
  for (const product of list) {
    if (!product || typeof product !== 'object') continue;
    const currency = firstString(product.currency, product.price_currency).toUpperCase();
    currencies.add(currency || 'unknown');
    const source = firstString(
      product.source,
      product.search_recall_source,
      product.catalog_source,
    ) || 'unknown';
    priceSources.set(source, (priceSources.get(source) || 0) + 1);
  }
  const served = [...currencies].sort().slice(0, MAX_CURRENCIES);
  // "Mixed" means more than one KNOWN currency on one page. A page of three SGD rows and one
  // row with no currency is incomplete, not mixed, and conflating the two would make the
  // counter useless for the question it exists to answer.
  const known = served.filter((code) => code !== 'unknown');
  return {
    served_currencies: served,
    served_currency_mismatch: known.length > 1,
    served_price_sources: Object.fromEntries([...priceSources.entries()].slice(0, MAX_PRICE_SOURCES)),
  };
}

/** The lane that produced the rows, from the stage breakdown the handler already records. */
function laneFromStageBreakdown(stages = []) {
  const list = Array.isArray(stages) ? stages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const lane = firstString(list[i] && list[i].lane);
    if (lane) return lane;
  }
  return null;
}

/**
 * The whole record for one find_products_multi response. Returns `{}` for anything else, so
 * the log line is unchanged for every other operation.
 */
function buildMarketTelemetry({ operation, search, metadata, products, stages } = {}) {
  if (String(operation || '').trim().toLowerCase() !== 'find_products_multi') return {};
  const requested = resolveRequestedMarket(search || {}, metadata || {});
  const served = summariseServedProducts(products);
  const lane = laneFromStageBreakdown(stages);
  return {
    market_requested: requested.requested,
    market_source: requested.source,
    market_bound: requested.bound,
    ...served,
    ...(lane ? { lane } : {}),
  };
}

module.exports = {
  buildMarketTelemetry,
  laneFromStageBreakdown,
  resolveRequestedMarket,
  summariseServedProducts,
};
