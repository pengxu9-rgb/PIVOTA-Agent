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
// (`search.market || metadata.market`, silence = US).
//
// A row priced in ANOTHER currency is dropped on every guarded operation. A row that quotes a price
// but NO currency is dropped on find_products_multi only: its cards carry a currency (prod, 7d to
// 2026-09-27: 2 of ~1,800 pages had an unknown one), so a missing one is a defect. The discovery
// feed's full-detail cards carry no `currency` field at all (tests/integration/
// invoke.get_discovery_feed_products_search.test.js), and nothing measures find_products', so there a
// row with no currency is left alone rather than emptying the feed. A row with no price at all
// (`price_absent_reason`) quotes no currency, right or wrong, and is left to the lanes' own policy.
//
// What this cannot see: a seed whose price_currency is blank but that a card builder stamped 'USD'.
// That is refused in the seed SQL instead (seedSearchOfferScope.seedHasPriceCurrencySql).

const { resolveServingCurrency } = require('./buyerMarket');
const { resolveCanonicalSearchProductPrice } = require('./searchProductPrice');

// find_similar_products (2026-09-27): its handler already filters strictly
// (filterProductsToServingCurrency); the door re-checks the body it sends, like every other page.
const GUARDED_OPERATIONS = new Set(['find_products_multi', 'find_products', 'get_discovery_feed', 'find_similar_products']);
// Where a priced row with no currency is itself a defect (see above).
const CURRENCY_REQUIRED_OPERATIONS = new Set(['find_products_multi']);
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

// The currency a card is priced in, read by the SAME function the shopping-agent price contract
// reads it with (resolveCanonicalSearchProductPrice: currency / currency_code / price_currency /
// priceCurrency, a nested price object, offers[], variants[], the seed snapshot). Reading fewer
// fields than the contract dropped a USD card whose currency sat only in variants[] as 'unknown',
// and let an SGD card shaped that way through the lenient operations. When no amount and currency
// pair can be read, a currency the card still writes down is what it claims to be priced in.
function rowCurrency(product) {
  const priced = resolveCanonicalSearchProductPrice(product);
  if (priced) return priced.currency;
  const nested = isPlainObject(product.price) ? product.price.currency : null;
  const written = [product.currency, product.currency_code, product.price_currency, product.priceCurrency, nested]
    .find((value) => value !== null && value !== undefined && String(value).trim() !== '');
  return String(written || '').trim().toUpperCase();
}

const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

function quotesAPrice(product) {
  return [product.price, product.price_amount, product.price_min].some(present);
}

// Every currency a card writes down, wherever it writes it. A similar-products card is assembled in
// stages (recall stamps a currency, card enrichment may copy in a price object with its own), so the
// two can disagree; a card is priced in the serving currency only if every one of them says so.
function statedCurrencies(product) {
  const nested = isPlainObject(product.price) ? product.price.currency : null;
  const pricing = isPlainObject(product.pricing) && isPlainObject(product.pricing.current)
    ? product.pricing.current.currency
    : null;
  return new Set(
    [rowCurrency(product), product.currency, product.currency_code, product.price_currency, product.priceCurrency, nested, pricing]
      .filter(present)
      .map((value) => String(value).trim().toUpperCase()),
  );
}

/**
 * The recommendation surfaces' filter (find_similar_products, get_pdp_v2's similar module, product
 * intel): products NEW to the buyer, so a priced card is kept only when every currency it states is
 * the serving currency. A priced card stating none is dropped (the recall stamps 'USD' on a blank
 * seed, so none left means the price came from somewhere the rule never saw). A card quoting no price
 * is kept. A null servingCurrency -- a market nothing is priced for -- keeps nothing.
 */
function filterProductsToServingCurrency(products, servingCurrency) {
  const list = Array.isArray(products) ? products : [];
  const currency = String(servingCurrency || '').trim().toUpperCase();
  return list.filter((product) => {
    if (!currency) return false;
    if (!isPlainObject(product)) return true;
    const priced = Boolean(resolveCanonicalSearchProductPrice(product)) || quotesAPrice(product);
    if (!priced) return true;
    const stated = statedCurrencies(product);
    return stated.size > 0 && [...stated].every((value) => value === currency);
  });
}

/**
 * A row that quotes a price, in the serving currency and no other. The discovery feed's buyer-market
 * fallback pool admits only these: an unpriced row is a card with no price on a page whose every
 * price is foreign to the deployment -- the buyer cannot tell what it would cost (JP, live
 * 2026-10-09: 3 of 9 cards). filterProductsToServingCurrency keeps unpriced rows on purpose (the
 * door must not empty a page over a missing price); this is the stricter read for a pool that is
 * built from scratch.
 */
function isPricedInServingCurrency(product, servingCurrency) {
  const currency = String(servingCurrency || '').trim().toUpperCase();
  if (!currency || !isPlainObject(product)) return false;
  const priced = resolveCanonicalSearchProductPrice(product);
  if (!priced) return false; // the resolver answers only a finite amount > 0 with a currency
  const stated = statedCurrencies(product);
  return stated.size > 0 && [...stated].every((value) => value === currency);
}

function withoutVariants(product) {
  const { variants: _variants, ...rest } = product;
  return rest;
}

// The product's own money and labels, without what it carries from elsewhere: its variants (judged one by one),
// its offers (other listings' money) and a seed row's source snapshot.
function ownRecord(product) {
  const { variants: _variants, offers: _offers, seed_data: _seedData, external_seed: _externalSeed, ...rest } = product;
  return rest;
}

const PRODUCT_CURRENCY_LABELS = ['currency', 'currency_code', 'price_currency', 'priceCurrency'];

// The money a record quotes: every amount field and the price objects, and an offer's shipping cost (shipping.cost,
// below). Currency labels stay (they price nothing).
const PDP_MONEY_FIELDS = ['price', 'price_amount', 'priceAmount', 'current_price', 'currentPrice', 'price_min', 'price_max',
  'pricing', 'compare_at_price', 'compareAtPrice', 'original_price', 'originalPrice', 'list_price', 'sale_price', 'salePrice',
  'shipping_cost'];

function withoutShippingCost(record) {
  if (!isPlainObject(record.shipping) || !('cost' in record.shipping)) return record;
  const { cost: _cost, ...shipping } = record.shipping;
  return { ...record, shipping };
}

function withoutMoney(record) {
  const next = withoutShippingCost({ ...record });
  for (const field of PDP_MONEY_FIELDS) delete next[field];
  return next;
}

// A record quotes money when it has a price, or a sale price alone.
function quotesPdpMoney(record) {
  return Boolean(resolveCanonicalSearchProductPrice(record)) || quotesAPrice(record)
    || present(record.sale_price) || present(record.salePrice);
}

// The currency an offer's shipping cost states, when it is not the serving one (the offer builder writes the cost as
// {amount, currency}, in the offer's currency unless the seller named its own).
function offMarketShippingCurrency(record, currency) {
  const cost = isPlainObject(record.shipping) ? record.shipping.cost : null;
  if (!isPlainObject(cost) || !present(cost.currency) || !present(cost.amount)) return null;
  const code = String(cost.currency).trim().toUpperCase();
  return code !== currency ? code : null;
}

/**
 * get_pdp_v2's guard: the product (and each variant) with any money it quotes in another currency than the serving
 * one removed, and the currencies removed. Only the off-market money goes: the page, its listing, its stock and its
 * actions stay, so a lane that prices the card from an offer in the buyer's currency still does. A variant that
 * states no currency is priced in the product's (the builder labels it so), and is judged by it.
 *
 * NO SERVING CURRENCY, NOTHING JUDGED. servingCurrencyFor answers null both for an unkeyable market ('en-US',
 * 'US,SG') and for a named market no currency is mapped for ('DE'); the page is then returned as is. The
 * recommendation and sibling-offer filters keep NOTHING on a null (they add rows to a page; dropping them all costs
 * the page nothing). Here the money is the page's own listing's, and withholding every price on every page for a
 * market the gateway does not serve would unprice the page outright, which get_pdp_v2's purchasability contract for
 * an unkeyable market does not do. So this guard covers a market with a currency, and only that.
 * @returns {{ product: object, withheld: string[] }}
 */
function withholdOffMarketMoney(product, servingCurrency) {
  const currency = String(servingCurrency || '').trim().toUpperCase();
  if (!currency || !isPlainObject(product)) return { product, withheld: [] };
  const withheld = new Set();
  // The product is judged on its OWN fields: its offers, and the source snapshot a seed row carries, are
  // not money this page quotes, so a currency only they state is not withheld (nor reported).
  const own = ownRecord(product);
  // A variant that states no currency is priced in the product's: the builder labels it with that one.
  const inherited = [...statedCurrencies(own)];
  const offOf = (record, fallback) => {
    if (!isPlainObject(record) || !quotesPdpMoney(record)) return [];
    const stated = [...statedCurrencies(record)];
    return (stated.length ? stated : fallback).filter((code) => code !== currency);
  };
  const strip = (record, fallback) => {
    const off = offOf(record, fallback);
    for (const code of off) withheld.add(code);
    return off.length ? withoutMoney(record) : record;
  };
  const headlineOffCurrencies = offOf(own, []);
  for (const code of headlineOffCurrencies) withheld.add(code);
  const headlineOff = headlineOffCurrencies.length > 0;
  let next = headlineOff ? withoutMoney(withoutVariants(product)) : withoutVariants(product);
  // A price in the serving currency with a shipping cost in another: the cost goes, the price stays.
  const shippingOff = headlineOff ? null : offMarketShippingCurrency(own, currency);
  if (shippingOff) {
    withheld.add(shippingOff);
    next = withoutShippingCost(next);
  }
  let variantKeptMoney = false;
  if (Array.isArray(product.variants)) {
    next.variants = product.variants.map((variant) => {
      if (!isPlainObject(variant)) return variant;
      const kept = strip(variant, inherited);
      if (kept === variant && quotesPdpMoney(variant)) variantKeptMoney = true;
      return kept;
    });
  }
  if (!withheld.size) return { product, withheld: [] };
  // The headline went but a variant kept its money, in the serving currency by construction: the product's
  // labels now name that currency, so the builder does not label the kept money with the withheld one.
  if (headlineOff && variantKeptMoney) {
    for (const field of PRODUCT_CURRENCY_LABELS) if (field in next) next[field] = currency;
    next.currency = currency;
  }
  return { product: next, withheld: [...withheld].sort().slice(0, MAX_REPORTED_CURRENCIES) };
}

/**
 * Returns the body to send. Untouched unless it is a guarded operation's body with a `products`
 * list holding a row not priced in the serving currency; then those rows are removed, `total`
 * shrinks by as many, and `metadata.serving_currency_guard` says what was dropped.
 */
function enforceServingCurrency({ operation, observation, payload, metadata, body } = {}) {
  const op = String(operation || '').trim().toLowerCase();
  if (!GUARDED_OPERATIONS.has(op)) return body;
  const currencyRequired = CURRENCY_REQUIRED_OPERATIONS.has(op);
  if (!isPlainObject(body) || !Array.isArray(body.products) || body.products.length === 0) return body;
  const servingCurrency = servingCurrencyFor({ observation, payload, metadata });
  const kept = [];
  const droppedCurrencies = new Set();
  for (const product of body.products) {
    const currency = isPlainObject(product) ? rowCurrency(product) : '';
    const noCurrencyToJudge = isPlainObject(product) && !currency && !(currencyRequired && quotesAPrice(product));
    if (noCurrencyToJudge || (servingCurrency && currency === servingCurrency)) kept.push(product);
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
  CURRENCY_REQUIRED_OPERATIONS,
  GUARDED_OPERATIONS,
  enforceServingCurrency,
  filterProductsToServingCurrency,
  isPricedInServingCurrency,
  withholdOffMarketMoney,
  requestedMarketOf,
  servingCurrencyFor,
};
