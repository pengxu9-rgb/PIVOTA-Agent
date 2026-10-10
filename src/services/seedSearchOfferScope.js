'use strict';
const { buildBrandIdentityPredicate } = require('./canonicalSearchQualitySql');

const fields = ["seed_data->>'brand_name'", "seed_data#>>'{snapshot,brand_name}'", "seed_data#>>'{snapshot,brand}'",
      "seed_data#>>'{snapshot,vendor_name}'", "seed_data#>>'{snapshot,vendor}'", "seed_data->>'brand'",
      "seed_data->>'vendor_name'", "seed_data->>'vendor'", "seed_data#>>'{derived,recall,brand_name}'", "seed_data#>>'{derived,recall,brand}'"];
const SEED_OWN_BRAND_SQL = `coalesce(${fields.map(field => `nullif(trim(${field}), '')`).join(',')}, '')`;

// A seed's own currency: the column, then the payload copies -- the order every seed card builder
// reads (buildBeautyExternalSeedMainlineProduct, buildExternalSeedProduct), so the SQL judges the
// currency the card will show. Blank everywhere is ''.
function seedNativeCurrencySql(alias = '') {
  const a = alias ? `${alias}.` : '';
  return `upper(trim(coalesce(nullif(trim(${a}price_currency), ''), nullif(trim(${a}seed_data->>'price_currency'), ''), nullif(trim(${a}seed_data#>>'{snapshot,price_currency}'), ''), '')))`;
}

// A seed with no currency at all is never served (Peng 2026-09-26; pivota-backend #2389 refuses
// NULL the same way). The card builders stamp 'USD' on such a row, so after recall it looks like a
// US price -- only the SQL can still tell it has none. For lanes that cannot bind the buyer's
// currency; the invoke door's servingCurrencyGuard then enforces WHICH currency.
function seedHasPriceCurrencySql(alias = '') {
  return `${seedNativeCurrencySql(alias)} <> ''`;
}

// The same refusal on the column alone -- pivota-backend #2389's exact rule -- for a statement that
// must not detoast seed_data (discoveryFeed's brand by-id `picked` CTE). Stricter in the safe
// direction: a seed priced only in its payload is refused there too.
function seedHasColumnPriceCurrencySql(alias = '') {
  const a = alias ? `${alias}.` : '';
  return `nullif(trim(${a}price_currency), '') IS NOT NULL`;
}

// A catalog product may be recommended to a buyer priced in `currencyParam` (a bound placeholder)
// only when nothing that can price its card says otherwise: not the seed it mirrors (source id),
// not a seed attached to it (minted lane), not one of its offers. A blank currency on any of them
// is "otherwise" too -- the card builders stamp 'USD' on it. A product none of them prices is left
// alone: its card quotes no price. A suppressed offer prices nothing, so it is not asked. Stricter
// than the search mainline ON PURPOSE: a product with live offers in two currencies (the mainline
// would serve the buyer's one) is not recommended -- a recommendation card cannot say which it is. Measured on prod 2026-09-27: 614 serving-eligible similar
// candidates carry no seed join and are priced only by an attached SGD seed + SGD offer.
//
// `allowOtherCurrencyOffers` (BUYER_MARKET_OFFER_SCOPE, buyerMarketOfferScope.js): the offers leg
// becomes the search mainline's -- a product with a live offer in the buyer's currency stays,
// whatever other currencies it is also offered in. A store's USD product gaining SGD sibling offers
// (pivota-backend shopify_markets) is then still recommended to a US buyer, and an SG buyer gets
// it on its SGD offer. A product whose live offers are ALL in other currencies is still refused,
// and the seed legs (which price the card) are unchanged.
function catalogProductPricedOnlyInCurrencySql(cpAlias, currencyParam, { allowOtherCurrencyOffers = false } = {}) {
  const otherCurrencyOffer = `EXISTS (
      SELECT 1 FROM catalog_offers o_cur
      WHERE o_cur.product_key = ${cpAlias}.product_key
        AND o_cur.suppressed_at IS NULL
        AND upper(trim(coalesce(o_cur.currency, ''))) <> ${currencyParam}
    )`;
  const offersLeg = allowOtherCurrencyOffers
    ? `(NOT ${otherCurrencyOffer}
      OR EXISTS (
        SELECT 1 FROM catalog_offers o_own
        WHERE o_own.product_key = ${cpAlias}.product_key
          AND o_own.suppressed_at IS NULL
          AND upper(trim(coalesce(o_own.currency, ''))) = ${currencyParam}
      ))`
    : `NOT ${otherCurrencyOffer}`;
  return `NOT EXISTS (
      SELECT 1 FROM external_product_seeds eps_cur
      WHERE eps_cur.external_product_id = ${cpAlias}.source_product_id AND eps_cur.status = 'active'
        AND ${seedNativeCurrencySql('eps_cur')} <> ${currencyParam}
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_product_seeds eps_cur
      WHERE eps_cur.attached_product_key = ${cpAlias}.product_key AND eps_cur.status = 'active'
        AND ${seedNativeCurrencySql('eps_cur')} <> ${currencyParam}
    )
    AND ${offersLeg}`;
}

// Use the same native-currency budget ranges as canonical SQL and the final
// price gate. Values are bound, and malformed price text cannot abort recall.
function buildSeedSearchOfferScope({ currency = null, priceRanges = null, brand = null, inStockOnly = false } = {}, params) {
  const bind = value => { params.push(value); return `$${params.length}`; };
  const nativeCurrency = seedNativeCurrencySql();
  const rawPrice = "coalesce(nullif(trim(price_amount::text), ''), nullif(trim(seed_data->>'price_amount'), ''), nullif(trim(seed_data#>>'{snapshot,price_amount}'), ''), '')";
  const nativePrice = `(CASE WHEN ${rawPrice} ~ '^[ ]*[0-9]+([.][0-9]+)?[ ]*$' THEN (${rawPrice})::numeric END)`;
  const clauses = [`${nativePrice} > 0`];
  if (inStockOnly) {
    const availability = "coalesce(nullif(trim(availability), ''), nullif(trim(seed_data->>'availability'), ''), nullif(trim(seed_data#>>'{snapshot,availability}'), ''), '')";
    clauses.push(`regexp_replace(lower(${availability}), '[^a-z0-9]', '', 'g') IN ('instock', 'available', 'true')`);
  }
  if (brand) {
    // Match buildBeautyExternalSeedMainlineProduct's own-brand precedence.
    clauses.push(buildBrandIdentityPredicate(brand, SEED_OWN_BRAND_SQL, params));
  }
  if (currency) clauses.push(`${nativeCurrency} = ${bind(String(currency).trim().toUpperCase())}`);
  if (Array.isArray(priceRanges)) {
    const ranges = priceRanges.map(range => {
      // Validate BEFORE binding anything. Returning 'FALSE' after the currency
      // was bound left that bind in params with no reference in the statement,
      // which PostgreSQL rejects for the whole query (42P18).
      if (['min', 'max'].some(field => range[field] != null && !Number.isFinite(Number(range[field])))) return 'FALSE';
      const parts = [];
      if (range.currency) parts.push(`${nativeCurrency} = ${bind(String(range.currency).trim().toUpperCase())}`);
      for (const [field, operator] of [['min', '>='], ['max', '<=']]) {
        if (range[field] == null) continue;
        parts.push(`${nativePrice} ${operator} ${bind(Number(range[field]))}`);
      }
      return parts.length ? `(${parts.join(' AND ')})` : 'FALSE';
    });
    clauses.push(`(${ranges.join(' OR ') || 'FALSE'})`);
  }
  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}
module.exports = { buildSeedSearchOfferScope, catalogProductPricedOnlyInCurrencySql, seedHasColumnPriceCurrencySql, seedHasPriceCurrencySql, seedNativeCurrencySql, SEED_OWN_BRAND_SQL };
