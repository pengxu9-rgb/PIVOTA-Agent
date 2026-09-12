'use strict';
const { buildBrandIdentityPredicate } = require('./canonicalSearchQualitySql');

// Use the same native-currency budget ranges as canonical SQL and the final
// price gate. Values are bound, and malformed price text cannot abort recall.
function buildSeedSearchOfferScope({ currency = null, priceRanges = null, brand = null, inStockOnly = false } = {}, params) {
  const bind = value => { params.push(value); return `$${params.length}`; };
  const nativeCurrency = "upper(trim(coalesce(nullif(trim(price_currency), ''), nullif(trim(seed_data->>'price_currency'), ''), nullif(trim(seed_data#>>'{snapshot,price_currency}'), ''), '')))";
  const rawPrice = "coalesce(nullif(trim(price_amount::text), ''), nullif(trim(seed_data->>'price_amount'), ''), nullif(trim(seed_data#>>'{snapshot,price_amount}'), ''), '')";
  const nativePrice = `(CASE WHEN ${rawPrice} ~ '^[ ]*[0-9]+([.][0-9]+)?[ ]*$' THEN (${rawPrice})::numeric END)`;
  const clauses = [`${nativePrice} > 0`];
  if (inStockOnly) {
    const availability = "coalesce(nullif(trim(availability), ''), nullif(trim(seed_data->>'availability'), ''), nullif(trim(seed_data#>>'{snapshot,availability}'), ''), '')";
    clauses.push(`regexp_replace(lower(${availability}), '[^a-z0-9]', '', 'g') NOT IN ('outofstock', 'oos', 'soldout', 'unavailable', 'false')`);
  }
  if (brand) {
    // Match buildBeautyExternalSeedMainlineProduct's own-brand precedence.
    const fields = ["seed_data->>'brand_name'", "seed_data#>>'{snapshot,brand_name}'", "seed_data#>>'{snapshot,brand}'",
      "seed_data#>>'{snapshot,vendor_name}'", "seed_data#>>'{snapshot,vendor}'", "seed_data->>'brand'",
      "seed_data->>'vendor_name'", "seed_data->>'vendor'", "seed_data#>>'{derived,recall,brand_name}'", "seed_data#>>'{derived,recall,brand}'"];
    const ownBrand = `coalesce(${fields.map(field => `nullif(trim(${field}), '')`).join(',')}, '')`;
    clauses.push(buildBrandIdentityPredicate(brand, ownBrand, params));
  }
  if (currency) clauses.push(`${nativeCurrency} = ${bind(String(currency).trim().toUpperCase())}`);
  if (Array.isArray(priceRanges)) {
    const ranges = priceRanges.map(range => {
      const parts = [];
      if (range.currency) parts.push(`${nativeCurrency} = ${bind(String(range.currency).trim().toUpperCase())}`);
      for (const [field, operator] of [['min', '>='], ['max', '<=']]) {
        if (range[field] == null) continue;
        if (!Number.isFinite(Number(range[field]))) return 'FALSE';
        parts.push(`${nativePrice} ${operator} ${bind(Number(range[field]))}`);
      }
      return parts.length ? `(${parts.join(' AND ')})` : 'FALSE';
    });
    clauses.push(`(${ranges.join(' OR ') || 'FALSE'})`);
  }
  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}
module.exports = { buildSeedSearchOfferScope };
