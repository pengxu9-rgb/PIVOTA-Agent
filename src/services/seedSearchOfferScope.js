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

// The offer writers that COPY a seed's money onto catalog_offers (pivota-backend: the seed mirror,
// the variant-identity backfill, the variant-offer projection). Their row is a projection of the
// seed, not a read of its own. A Shopify-Markets capture (shopify_markets_us_localization,
// us_market_capture) reads the store's own US price and is deliberately not on this list.
const SEED_PROJECTED_OFFER_SOURCE_SYSTEMS = Object.freeze([
  'external_product_seeds_mirror_v1',
  'variant_identity_backfill_v1',
  'variant_offer_projection_v1',
]);

// A SEED-PROJECTED OFFER IS A PRICE ONLY IN THE CURRENCY ITS SEED'S PAGE READ STATES (Peng
// 2026-10-19: a price's currency is the buyer market's, never defaulted, never relabelled).
//
// Live 2026-10-19, US search_catalog "skintific glow cushion peptide lip serum set": the card read
// USD 23.56 off one of 20 offers the variant backfill wrote on 09-10 from seed_data.variants. The
// seed has since been re-read (snapshot AUD 57, price_currency AUD 56, mirror offer AUD 56, and the
// store's live read answers AUD); nothing retired the 20 USD rows, so an older read of the listing
// kept answering as a US price.
//
// WHICH of the seed's currencies is its currency, measured on prod 2026-10-19 (read-only censuses
// spccy-1019 .. spccy3-1019, active seeds with a live projected offer):
//   - the SNAPSHOT is the page as read. Where the column disagrees with it, the column is the
//     writers' old `or 'USD'` default (column USD, snapshot GBP 483 / QAR 367 / EUR 166 / INR 108 /
//     ZAR 64 seeds), and a USD offer copied off such a column is an amount read in another currency;
//   - the COLUMN stands in when the seed kept no snapshot (absent or JSON null) or a snapshot with no
//     currency;
//   - a seed_data or snapshot stored as anything but an object (a JSON string) hides the page read,
//     so it states NO currency; it is not parsed here, where one malformed string would abort recall;
//   - seed_data.price_currency is NOT evidence: it is a copy the writers default to 'USD' too (16
//     serving SGD offers, column SGD, snapshot SGD, amount equal to both, seed_data 'USD').
//
// So a projected offer is a price only when an ACTIVE seed (status compared case-insensitively) is
// attached to its listing AND every active attached seed states the offer's currency. An orphan --
// its seed retired, detached, or superseded (a superseded seed keeps its attached key as a
// tombstone, but not its status) -- has no read behind it and is refused too (PR controller review
// of #2467). Wherever an offer is picked such a row is not a candidate, and the card is priced by
// another offer or not at all.
//
// `productKeyExpr` is the listing the offer prices (SQL, not a value); the seeds are probed through
// idx on external_product_seeds(attached_product_key, attached_variant_id). An offer from any other
// writer is not judged here.
function seedCurrencySql(alias) {
  const column = `nullif(upper(trim(${alias}.price_currency)), '')`;
  const snapshot = `${alias}.seed_data->'snapshot'`;
  return `(CASE
              WHEN ${alias}.seed_data IS NOT NULL AND jsonb_typeof(${alias}.seed_data) NOT IN ('object', 'null') THEN NULL
              WHEN jsonb_typeof(${snapshot}) = 'object'
                THEN coalesce(nullif(upper(trim(${alias}.seed_data#>>'{snapshot,price_currency}')), ''), ${column})
              WHEN ${snapshot} IS NULL OR jsonb_typeof(${snapshot}) = 'null' THEN ${column}
            END)`;
}

function seedProjectedOfferInSeedCurrencySql(offerAlias, productKeyExpr) {
  const systems = SEED_PROJECTED_OFFER_SOURCE_SYSTEMS.map((value) => `'${value}'`).join(', ');
  // ONE index probe per offer (PR controller, spccy6-1019: two correlated EXISTS cost +30-35% on scoped
  // queries). bool_and over the active attached seeds is NULL when there are none -- IS TRUE fails that
  // orphan closed -- and false as soon as one seed states another currency or none.
  return `(coalesce(${offerAlias}.source_system, '') NOT IN (${systems})
          OR (
            SELECT bool_and(${seedCurrencySql('eps_own')} IS NOT DISTINCT FROM upper(trim(coalesce(${offerAlias}.currency, ''))))
            FROM external_product_seeds eps_own
            WHERE eps_own.attached_product_key = ${productKeyExpr}
              AND lower(trim(coalesce(eps_own.status, ''))) = 'active'
          ) IS TRUE)`;
}

// KILL SWITCH, default ON (a currency-correctness rule: silence keeps it). Any of 0/false/off/no/
// disabled in CANONICAL_SEED_PROJECTED_OFFER_CURRENCY_GUARD turns the guard off at every site, read
// per call, and each site's statement is then byte-identical to the one before the guard existed.
const SEED_PROJECTED_OFFER_CURRENCY_GUARD_FLAG = 'CANONICAL_SEED_PROJECTED_OFFER_CURRENCY_GUARD';
const GUARD_OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
function isSeedProjectedOfferCurrencyGuardEnabled(env = process.env) {
  return !GUARD_OFF_VALUES.has(String(env[SEED_PROJECTED_OFFER_CURRENCY_GUARD_FLAG] ?? '').trim().toLowerCase());
}

// The guard as a WHERE conjunct for a site: `${prefix}AND (...)`, or '' with the kill switch off.
// `prefix` is what precedes the AND (a newline and the site's indent), so a site interpolates it at
// the END of its previous line and "off" adds not even a blank line.
function seedProjectedOfferCurrencyGuardSql(offerAlias, productKeyExpr, { prefix = '\n        ', env = process.env } = {}) {
  if (!isSeedProjectedOfferCurrencyGuardEnabled(env)) return '';
  return `${prefix}AND ${seedProjectedOfferInSeedCurrencySql(offerAlias, productKeyExpr)}`;
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
// whatever other currencies it is also offered in. A product carrying offers in several served
// currencies (a USD sibling beside a non-USD base offer today; SGD siblings beside USD once
// pivota-backend #2553 lands) is then recommended to each buyer whose currency it has a live offer
// in, when its card can be priced for that buyer. A product whose live offers are ALL in other currencies is still refused,
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
module.exports = {
  buildSeedSearchOfferScope, catalogProductPricedOnlyInCurrencySql, seedHasColumnPriceCurrencySql, seedHasPriceCurrencySql,
  seedNativeCurrencySql, seedProjectedOfferInSeedCurrencySql, seedProjectedOfferCurrencyGuardSql,
  isSeedProjectedOfferCurrencyGuardEnabled, SEED_OWN_BRAND_SQL, SEED_PROJECTED_OFFER_CURRENCY_GUARD_FLAG,
  SEED_PROJECTED_OFFER_SOURCE_SYSTEMS,
};
