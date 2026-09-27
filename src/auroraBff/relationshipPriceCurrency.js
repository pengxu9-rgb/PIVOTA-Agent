'use strict';

// The currency of a relationship-graph price, read from the SAME record that supplied the amount.
//
// 2026-09-27 prod census: none of the 4,964 serving edges with candidate_snapshot.price carried a
// currency, and none of the 7,667 price_evidence rows did. The seed SELECTs read
// eps.price_currency; the snapshot normalizer dropped it, and the builder divided the two bare
// amounts into a price_ratio whatever their currencies were.
//
// Rules:
// - A currency is an ISO-4217 alpha code. '$', 'US$', '840' and '' name no currency, and nothing
//   defaults one in (not the market's, not the other side's).
// - The currency comes from the record whose field supplied the amount. A product object merged
//   from several layers is read layer by layer, so an amount from one layer never borrows a
//   currency from another.
// - A record that names two different currencies names none.
// - A ratio compares two amounts only when both are known in ONE currency.

const PRICE_CURRENCY_KEYS = Object.freeze(['price_currency', 'priceCurrency', 'currency', 'currency_code', 'currencyCode']);

// An object price ({ amount, currency }) is descended the way the amount readers descend it.
const PRICE_OBJECT_AMOUNT_KEYS = Object.freeze([
  'amount',
  'value',
  'price',
  'min',
  'min_price',
  'minPrice',
  'sale_price',
  'salePrice',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCurrencyCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

// The one currency a record names, or null. Every currency key the record carries must be a valid
// code and agree; a '$' beside 'USD' or a 'JPY' beside 'USD' is ambiguous and names none.
function recordCurrency(record) {
  if (!isPlainObject(record)) return null;
  let found = null;
  for (const key of PRICE_CURRENCY_KEYS) {
    const raw = record[key];
    if (raw == null || raw === '') continue;
    const code = normalizeCurrencyCode(raw);
    if (!code || (found && found !== code)) return null;
    found = code;
  }
  return found;
}

function namesAnyCurrency(record) {
  return isPlainObject(record) && PRICE_CURRENCY_KEYS.some((key) => record[key] != null && record[key] !== '');
}

// The currency of a price VALUE held by `holder`. The amount is found by descending
// holder -> value -> value.amount -> ...; of the records on that path, the DEEPEST one that names a
// currency decides (and if it names two, there is none). A scalar price therefore takes its
// holder's currency, and an object price ({ amount, currency }) its own.
function valueCurrency(value, holder) {
  let deciding = namesAnyCurrency(holder) ? holder : null;
  let node = value;
  for (let depth = 0; isPlainObject(node) && depth < 8; depth += 1) {
    if (namesAnyCurrency(node)) deciding = node;
    const current = node;
    node = PRICE_OBJECT_AMOUNT_KEYS.map((key) => current[key]).find((item) => item != null);
  }
  return deciding ? recordCurrency(deciding) : null;
}

// The holder that `{ ...layers[0], ...layers[1], ... }[key]` would read: the LAST layer that owns
// the key (a later own null still shadows an earlier value, exactly as the spread does).
function spreadOwner(layers, key) {
  let owner = null;
  for (const layer of layers) {
    if (isPlainObject(layer) && Object.prototype.hasOwnProperty.call(layer, key)) owner = layer;
  }
  return owner;
}

// Reads a price the way `toNumber(a[k1] ?? b[k2] ?? ...)` does and returns its currency beside it.
// `fields` is an ordered list of [holder, key]; a holder may be an array of spread layers.
// `toNumber` is the caller's own amount parser, so amounts are unchanged by this module.
function readPriceWithCurrency(fields, toNumber) {
  for (const [holder, key] of Array.isArray(fields) ? fields : []) {
    const record = Array.isArray(holder) ? spreadOwner(holder, key) : holder;
    if (!isPlainObject(record)) continue;
    const value = record[key];
    if (value == null) continue;
    const amount = toNumber(value);
    return { amount, currency: amount == null ? null : valueCurrency(value, record) };
  }
  return { amount: null, currency: null };
}

// candidate / anchor. Null unless both amounts are known, the anchor's is positive, and both are
// in one known currency.
function comparablePriceRatio(anchor, candidate) {
  const a = isPlainObject(anchor) ? anchor : {};
  const c = isPlainObject(candidate) ? candidate : {};
  if (a.amount == null || c.amount == null || !(a.amount > 0)) return null;
  if (!a.currency || a.currency !== c.currency) return null;
  return c.amount / a.amount;
}

module.exports = {
  PRICE_CURRENCY_KEYS,
  normalizeCurrencyCode,
  recordCurrency,
  readPriceWithCurrency,
  comparablePriceRatio,
};
