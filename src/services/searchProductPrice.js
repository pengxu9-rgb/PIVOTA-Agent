'use strict';

// A search card's price: an amount and a currency read FROM THE SAME SOURCE. Moved verbatim out of
// server.js (2026-09-27) so the invoke door's two readers of it -- the shopping-agent price contract
// (enforceFindProductsMultiPriceContract) and the serving-currency guard (servingCurrencyGuard) --
// are one function and cannot disagree about which currency a card is priced in.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (value != null) {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return null;
}

// A shopping card must carry an amount and currency from the same source.
function readCanonicalSearchPricePair(value, fallbackCurrency = '') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const amount = Number(value);
    const currency = String(fallbackCurrency || '').trim().toUpperCase();
    return Number.isFinite(amount) && amount > 0 && currency ? { amount, currency } : null;
  }
  if (!isPlainObject(value)) return null;

  const localCurrency = firstNonEmptyString(
    value.currency,
    value.currency_code,
    value.price_currency,
    value.priceCurrency,
    fallbackCurrency,
  );
  for (const field of ['amount', 'value', 'price_amount', 'priceAmount', 'current_price', 'currentPrice', 'sale_price', 'salePrice', 'min_price', 'minPrice']) {
    const amount = Number(value[field]);
    if (Number.isFinite(amount) && amount > 0 && localCurrency) {
      return { amount, currency: String(localCurrency).trim().toUpperCase() };
    }
  }
  for (const field of ['price', 'pricing', 'current', 'sale', 'min', 'offer_price', 'offerPrice']) {
    const pair = readCanonicalSearchPricePair(value[field], localCurrency);
    if (pair) return pair;
  }
  return null;
}

function resolveCanonicalSearchProductPrice(product) {
  if (!isPlainObject(product)) return null;
  const productCurrency = firstNonEmptyString(
    product.currency,
    product.currency_code,
    product.price_currency,
    product.priceCurrency,
  );
  const direct = readCanonicalSearchPricePair(product, productCurrency);
  if (direct) return direct;

  for (const collection of [product.offers, product.variants]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const pair = readCanonicalSearchPricePair(entry, productCurrency);
      if (pair) return pair;
    }
  }

  // Citation rows retain their exact source snapshot until finalization. Each
  // object is evaluated independently, so an amount can never borrow a
  // currency from a different source.
  for (const source of [product.seed_data, product.external_seed]) {
    if (!isPlainObject(source)) continue;
    const directSourcePair = readCanonicalSearchPricePair(source);
    if (directSourcePair) return directSourcePair;
    const snapshotPair = readCanonicalSearchPricePair(source.snapshot);
    if (snapshotPair) return snapshotPair;
  }
  return null;
}

module.exports = {
  readCanonicalSearchPricePair,
  resolveCanonicalSearchProductPrice,
};
