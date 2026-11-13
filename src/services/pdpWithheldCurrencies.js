'use strict';

// THE CURRENCIES A PRODUCT READ WITHHELD, kept BESIDE the row, never on it.
//
// get_pdp_v2 withholds money that is not in the serving currency (servingCurrencyGuard.withholdOffMarketMoney) and
// names the currencies it withheld in `metadata.serving_currency_guard.withheld_currencies`. The unscoped
// get_product_detail hop projects that page to `{ product }` (normalizePdpV2ToProductDetail), and a product that
// states no price states no currency either, so the projection drops the one fact a caller needs to tell "this
// seller is priced in another currency" from "this row has no price".
//
// The storefront checkout's currency rule (mcp-server/src/ucpCheckoutEscalation.js) needs that fact and reads its
// rows with NO market, so the row cannot be asked to carry it: the product object, the request that fetched it and
// every answer built from it stay exactly as they were. The note is held in a WeakMap keyed on the product object:
// nothing is added to the object, nothing is serialized, and a copy of the row simply has no note (read as
// "unknown", which every reader must treat as "say nothing about this row's currency").
//
// Process-local and per object: it is never a cache of a currency for a product id.

const notes = new WeakMap();

const isObject = (value) => typeof value === 'object' && value !== null;

function codesOf(value) {
  if (!Array.isArray(value)) return [];
  const codes = new Set();
  for (const entry of value) {
    const code = typeof entry === 'string' ? entry.trim().toUpperCase() : '';
    if (/^[A-Z]{3}$/.test(code)) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * The currencies a get_pdp_v2 response body says it withheld (sorted ISO 4217 codes; empty when it names none).
 *
 * ONLY SAFE FOR A PAGE READ WITHOUT OFFERS. The page's `withheld_currencies` is ONE list: the card's own withheld
 * currencies merged with the withheld currencies of every OFFER on the page, which are other sellers' money. The
 * unscoped detail hop asks for `include: ['product_overview']` and nothing else (src/services/pdpDetailHop.js), so
 * no offer is built and the list is the card's alone. If that hop ever included offers, a seller's unpriced row
 * would be labelled with another seller's currency. mcp-server/test/ucpCurrencyFollowsMarket.test.js pins the hop.
 */
function withheldCurrenciesOfPdpResponse(body) {
  const guard = isObject(body) && isObject(body.metadata) ? body.metadata.serving_currency_guard : null;
  return codesOf(isObject(guard) ? guard.withheld_currencies : null);
}

/** Note, beside `product`, the currencies the read that produced it withheld. Nothing is noted for an empty list. */
function noteWithheldCurrencies(product, codes) {
  if (!isObject(product)) return;
  const list = codesOf(codes);
  if (list.length) notes.set(product, Object.freeze(list));
}

/**
 * Note beside `product` what `body` (the get_pdp_v2 response it was projected from) says was withheld. NEVER THROWS,
 * whatever either argument is: the projection that calls this must return its product either way. Returns whether
 * the note was attempted without error.
 */
function noteWithheldCurrenciesOfPdpResponse(product, body) {
  try {
    noteWithheldCurrencies(product, withheldCurrenciesOfPdpResponse(body));
    return true;
  } catch {
    return false;
  }
}

/** The currencies noted for this very object (never for a copy of it), or an empty list. */
function withheldCurrenciesOf(product) {
  const list = isObject(product) ? notes.get(product) : undefined;
  return list ? [...list] : [];
}

module.exports = { noteWithheldCurrencies, noteWithheldCurrenciesOfPdpResponse, withheldCurrenciesOf, withheldCurrenciesOfPdpResponse };
