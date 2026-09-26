'use strict';

// The brand page's commerce-index lane (discoveryFeed's fetchBrandScopedCanonicalCandidates) finds the
// content keys of a brand by comparing catalog_products.brand two ways: lowercased, and lowercased with
// every non-alphanumeric run removed ("Dr. Jart+" -> "drjart"). It did that with one
// `lower(brand) = ANY(...) OR regexp_replace(lower(brand), ...) = ANY(...)` filter, which no index
// served, so every brand-page cache miss scanned all of catalog_products and ran regexp_replace on each
// row: ~44ms in prod on 2026-09-17 (15,552 rows, 425 distinct brands), for every brand.
//
// Each comparison is now its own UNION branch over an expression index. No prefix bound is needed:
// brand is varchar(255), so even a fully case-expanded lower(brand) stays far below the ~2704-byte btree
// key limit. The expressions live here so the query and the index definitions
// (scripts/catalog/primary_brand_indexes.js) cannot drift apart.
const CANONICAL_BRAND_MATCH_PREDICATE = 'content_key IS NOT NULL AND brand IS NOT NULL';

function column(alias, name) {
  return alias ? `${alias}.${name}` : name;
}

function canonicalBrandLowerSql(alias = '') {
  return `lower(${column(alias, 'brand')})`;
}

function canonicalBrandCompactSql(alias = '') {
  return `regexp_replace(lower(${column(alias, 'brand')}), '[^a-z0-9]+', '', 'g')`;
}

function canonicalBrandMatchPredicateSql(alias = '') {
  return `${column(alias, 'content_key')} IS NOT NULL AND ${column(alias, 'brand')} IS NOT NULL`;
}

// The body of the brand_match CTE: the content keys whose brand matches either spelling. UNION removes
// duplicates exactly as the old SELECT DISTINCT did.
function canonicalBrandMatchSql({ alias = 'cp', lowerAliasesParam, compactAliasesParam }) {
  return `
          SELECT ${alias}.content_key
          FROM catalog_products ${alias}
          WHERE ${canonicalBrandMatchPredicateSql(alias)}
            AND ${canonicalBrandLowerSql(alias)} = ANY(${lowerAliasesParam}::text[])
          UNION
          SELECT ${alias}.content_key
          FROM catalog_products ${alias}
          WHERE ${canonicalBrandMatchPredicateSql(alias)}
            AND ${canonicalBrandCompactSql(alias)} = ANY(${compactAliasesParam}::text[])`;
}

module.exports = {
  CANONICAL_BRAND_MATCH_PREDICATE,
  canonicalBrandCompactSql,
  canonicalBrandLowerSql,
  canonicalBrandMatchPredicateSql,
  canonicalBrandMatchSql,
};
