'use strict';

// NO PAGE LEAVES THE INVOKE DOOR PRICED IN ANOTHER CURRENCY THAN THE BUYER'S.
//
// Peng 2026-09-26: a result in the wrong currency is a wrong result and must never reach the agent
// frontend. The beauty mainline enforces that in its own SQL (buyerMarket.resolveServingCurrency),
// but it is one of many lanes that answer find_products_multi: an inventory on 2026-09-27 found
// seed rows reaching the page through the ingredient lane, the brand fastpath rescue, the discovery
// bridge, the creator-apparel lane, the canonical-direct lane, the caches and the upstream proxy --
// none of which bound a currency. Each lane is fixed where it reads seeds too, but a lane added
// next month would not be, so the rule is also enforced HERE, on the body every return path sends
// (the invoke `res.json` interceptor), whichever lane built it.
//
// The serving currency is the one the door BOUND when the mainline ran (so this can never disagree
// with that SQL: an SG buyer's SGD page is kept), else it is resolved from the request the same way
// (`search.market || metadata.market`, silence = US). A row that carries a price but no currency is
// dropped: it cannot be shown to be priced for the buyer. A row with no price at all (a card the
// door already marked `price_absent_reason`) quotes no currency, right or wrong, and is left to the
// lanes' own price policy.
//
// What this cannot see: a seed whose price_currency is blank but that a card builder stamped 'USD'.
// That is refused in the seed SQL instead (seedSearchOfferScope.seedHasPriceCurrencySql).

const { resolveServingCurrency } = require('./buyerMarket');

const GUARDED_OPERATIONS = new Set(['find_products_multi', 'find_products', 'get_discovery_feed']);
const MAX_REPORTED_CURRENCIES = 8;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The door's own read: `payload.search` when it is a plain object, otherwise the payload itself
// (a flat `{query, market}` payload), then `search.market || metadata.market`.
function requestedMarketOf(payload, metadata) {
  const body = isPlainObject(payload) ? payload : {};
  const search = isPlainObject(body.search) ? body.search : body;
  return search.market || (isPlainObject(metadata) ? metadata.market : undefined);
}

function servingCurrencyFor({ observation, payload, metadata } = {}) {
  if (isPlainObject(observation) && observation.market_observed === true) {
    return observation.market_serving_currency || null;
  }
  return resolveServingCurrency(requestedMarketOf(payload, metadata));
}

function rowCurrency(product) {
  const nested = isPlainObject(product.price) ? product.price.currency : null;
  return String(product.currency || product.price_currency || nested || '').trim().toUpperCase();
}

const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

function quotesAPrice(product) {
  return [product.price, product.price_amount, product.price_min].some(present);
}

/**
 * Returns the body to send. Untouched unless it is a guarded operation's body with a `products`
 * list holding a row not priced in the serving currency; then those rows are removed, `total`
 * shrinks by as many, and `metadata.serving_currency_guard` says what was dropped.
 */
function enforceServingCurrency({ operation, observation, payload, metadata, body } = {}) {
  if (!GUARDED_OPERATIONS.has(String(operation || '').trim().toLowerCase())) return body;
  if (!isPlainObject(body) || !Array.isArray(body.products) || body.products.length === 0) return body;
  const servingCurrency = servingCurrencyFor({ observation, payload, metadata });
  const kept = [];
  const droppedCurrencies = new Set();
  for (const product of body.products) {
    const currency = isPlainObject(product) ? rowCurrency(product) : '';
    const unpricedCard = isPlainObject(product) && !currency && !quotesAPrice(product);
    if (unpricedCard || (servingCurrency && currency === servingCurrency)) kept.push(product);
    else droppedCurrencies.add(currency || 'unknown');
  }
  const droppedCount = body.products.length - kept.length;
  if (droppedCount === 0) return body;
  const existingMetadata = isPlainObject(body.metadata) ? body.metadata : {};
  return {
    ...body,
    products: kept,
    ...(Number.isFinite(Number(body.total)) && body.total !== null
      ? { total: Math.max(kept.length, Number(body.total) - droppedCount) }
      : {}),
    metadata: {
      ...existingMetadata,
      serving_currency_guard: {
        serving_currency: servingCurrency,
        dropped_count: droppedCount,
        dropped_currencies: [...droppedCurrencies].sort().slice(0, MAX_REPORTED_CURRENCIES),
      },
    },
  };
}

module.exports = {
  GUARDED_OPERATIONS,
  enforceServingCurrency,
  requestedMarketOf,
  servingCurrencyFor,
};
