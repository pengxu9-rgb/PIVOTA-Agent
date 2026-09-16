'use strict';

// ONE owner for the expressions the brand-page seed scan matches on, so the query
// and the index definitions in scripts/catalog/primary_brand_indexes.js cannot
// drift. An index only accelerates an expression it matches CHARACTER FOR
// CHARACTER, so both sides must read these from here.
//
// Why: the brand-direct seed query is the top statement in prod
// pg_stat_statements (2026-09-15: 30,605 calls, 5.26s mean, 161,057s total,
// 17.2 rows per call). It filtered on six OR'd brand expressions, four of them
// `LIKE ANY(array)`, which no index can drive, so every brand page read all
// 11.8k attached seeds (326MB) and re-extracted ~15 JSONB paths per row.
const { normalizedBrandIdentitySql } = require('./canonicalSearchQualitySql');
const { SEED_OWN_BRAND_SQL } = require('./seedSearchOfferScope');

// The rows the brand scan reads, and the predicate the partial indexes carry.
// `coalesce(attached_product_key, '') <> ''` rather than `IS NOT NULL` because a
// partial index is only usable when the query's predicate implies the index's,
// and PostgreSQL cannot derive that from `IS NOT NULL` alone.
const BRAND_SEED_SCAN_PREDICATE = "status = 'active' AND coalesce(attached_product_key, '') <> ''";

const qualify = (alias) => (alias ? `${alias}.` : '');

// The seed's own brand identity: the normalization #2204 indexed for the
// find_products_multi seed lane (accent folding, non-alphanumerics removed),
// with the domain kept as brand-of-last-resort.
//
// The domain leg preserves the old predicate's `indexedBrandSql`, which
// coalesced split_part(domain, '.', 1) after the two brand paths. Today it is
// dead weight — a 2026-09-15 prod census found 0 of 11,817 attached active
// seeds whose own-brand identity is empty — but without it a future seed
// carrying no brand field anywhere in seed_data would silently drop off its
// brand page. It cannot widen anything: coalesce reaches the domain only when
// every brand path is empty.
function seedBrandIdentitySql(alias = '') {
  const own = SEED_OWN_BRAND_SQL.replace(/\bseed_data\b/g, `${qualify(alias)}seed_data`);
  return normalizedBrandIdentitySql(`coalesce(nullif(${own}, ''), split_part(${qualify(alias)}domain, '.', 1), '')`);
}

// The backfill lane matches a title that STARTS WITH an alias followed by a
// space, so it is a prefix scan over this expression.
function seedTitleSql(alias = '') {
  const a = qualify(alias);
  return `lower(coalesce(${a}seed_data->'snapshot'->>'title', ${a}seed_data->>'title', ${a}title, ''))`;
}

module.exports = { BRAND_SEED_SCAN_PREDICATE, seedBrandIdentitySql, seedTitleSql };
