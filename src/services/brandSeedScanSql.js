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

// A btree key must fit 2704 bytes or the INSERT that would exceed it fails
// permanently — and CREATE INDEX fails outright if such a row already exists.
// #2204's sibling index hashes (md5) for the same reason; this one must stay
// prefix-searchable, so it truncates instead. 512 is far past any real brand or
// title prefix, and CJK titles reach 2704 BYTES at only ~900 characters.
// left() counts CHARACTERS, so the worst case is 512 x 4 bytes = 2048, still under
// the limit once the market/tool columns are added.
const IDENTITY_MAX_CHARS = 512;
const bounded = (expression) => `left(${expression}, ${IDENTITY_MAX_CHARS})`;

const qualify = (alias) => (alias ? `${alias}.` : '');

// The rows the brand scan reads. `coalesce(attached_product_key, '') <> ''`
// rather than `IS NOT NULL` because a partial index is only usable when the
// query's predicate implies the index's, and PostgreSQL cannot derive that from
// `IS NOT NULL` alone.
function brandSeedScanPredicateSql(alias = '') {
  const a = qualify(alias);
  return `${a}status = 'active' AND coalesce(${a}attached_product_key, '') <> ''`;
}
const BRAND_SEED_SCAN_PREDICATE = brandSeedScanPredicateSql();

// The seed's own brand, in the SAME field precedence the retired predicate used
// (derived.recall.brand first, snapshot paths last). Precedence decides which
// brand page a row belongs to when two fields disagree — a Shopify snapshot
// routinely carries the STORE in `vendor` while `brand` carries the brand — so
// reusing #2204's SEED_OWN_BRAND_SQL order here would silently move such rows
// off their brand's page. `derived.recall.brand_name` is appended LAST: it is a
// path the old chain never read, so it can only add reachability, never move a
// row that any other path already names.
const SEED_BRAND_CHAIN_FIELDS = [
  "seed_data#>>'{derived,recall,brand}'",
  "seed_data->>'brand'",
  "seed_data->>'brand_name'",
  "seed_data->>'vendor'",
  "seed_data->>'vendor_name'",
  "seed_data#>>'{snapshot,brand}'",
  "seed_data#>>'{snapshot,brand_name}'",
  "seed_data#>>'{snapshot,vendor}'",
  "seed_data#>>'{snapshot,vendor_name}'",
  "seed_data#>>'{derived,recall,brand_name}'",
];

// The retired predicate ORed a SECOND chain (`indexedBrandSql`): brand,
// snapshot.brand, then the domain. It is not a fallback of the chain above —
// a seed with brand_name 'Tocobo' on mixsoon.com matched BOTH 'tocobo' (own
// chain) and 'mixsoon' (this one), i.e. appeared on two brand pages. Folding
// the domain into a single chain would have dropped it from the mixsoon page,
// so the two chains stay separate and the scan probes both.
const SEED_DOMAIN_CHAIN_FIELDS = [
  "seed_data->>'brand'",
  "seed_data#>>'{snapshot,brand}'",
];

const chainSql = (fields, alias, extra = []) => {
  const parts = fields
    .map((field) => field.replace(/\bseed_data\b/g, `${qualify(alias)}seed_data`))
    .map((field) => `nullif(trim(${field}), '')`)
    .concat(extra);
  return `coalesce(${parts.join(', ')}, '')`;
};

// Identity = accent-folded, alphanumerics only (#2204's normalization), bounded.
function seedBrandIdentitySql(alias = '') {
  return bounded(normalizedBrandIdentitySql(chainSql(SEED_BRAND_CHAIN_FIELDS, alias)));
}

function seedDomainIdentitySql(alias = '') {
  const domain = `nullif(trim(split_part(${qualify(alias)}domain, '.', 1)), '')`;
  return bounded(normalizedBrandIdentitySql(chainSql(SEED_DOMAIN_CHAIN_FIELDS, alias, [domain])));
}

// The backfill lane matches a title that STARTS WITH an alias followed by a
// space, so it is a prefix scan over this expression.
function seedTitleSql(alias = '') {
  const a = qualify(alias);
  return bounded(`lower(coalesce(${a}seed_data->'snapshot'->>'title', ${a}seed_data->>'title', ${a}title, ''))`);
}

// LIKE treats % and _ as wildcards, so an alias carrying either must be escaped
// before it is bound as a prefix pattern. "100% PURE" is a real brand, and an
// unescaped '%' both widens the match to everything and defeats the index's
// prefix optimization. The default escape character is backslash.
function likePrefixPattern(value, suffix = '') {
  return `${String(value || '').replace(/([\\%_])/g, '\\$1')}${suffix}%`;
}

// A prefix probe on an IDENTITY expression, written as the byte range the text_pattern_ops index answers on
// its own. `identity LIKE 'fenty%'` produced the same index range but also a Filter that PostgreSQL re-ran on
// every row the range returned, and re-running it means re-extracting the brand from the row's seed_data:
// for Fenty Beauty in prod on 2026-09-17 the index returned 826 rows in 0.1ms and the filter took ~130ms per
// branch (383ms for the scan).
//
// The range is exactly the prefix set on the identity expressions, not an approximation:
//  - text_pattern_ops compares bytes, and UTF-8 byte order is code point order;
//  - every string with byte prefix `key` lies in [key, key || U+10FFFF) unless the character right after
//    the prefix is U+10FFFF itself, and no string without that prefix lies in the range;
//  - identitySql keeps only [:alnum:] characters (everything else becomes a space, and spaces are removed),
//    and U+10FFFF is a noncharacter that [:alnum:] never matches, so an identity value never contains it.
// Keys are alphanumeric identity keys (brandIdentityKey), so nothing needs escaping. Only for the identity
// expressions: the title lane matches raw title text, where U+10FFFF cannot be ruled out, and keeps LIKE.
const IDENTITY_PREFIX_UPPER_SENTINEL = '\u{10FFFF}';

function identityPrefixUpperBound(key) {
  return `${String(key || '')}${IDENTITY_PREFIX_UPPER_SENTINEL}`;
}

function identityPrefixRangeSql(identitySql, lowerBind, upperBind) {
  return `${identitySql} ~>=~ ${lowerBind}::text AND ${identitySql} ~<~ ${upperBind}::text`;
}

// A prefix key covered by a shorter prefix key on the same expression matches nothing the shorter one does
// not ('fentybeauty%' is inside 'fenty%'), so its UNION branch is pure repeated work.
function uncoveredPrefixKeys(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).filter(Boolean))];
  return unique.filter((key) => !unique.some((other) => other !== key && key.startsWith(other)));
}

module.exports = {
  BRAND_SEED_SCAN_PREDICATE,
  IDENTITY_PREFIX_UPPER_SENTINEL,
  IDENTITY_MAX_CHARS,
  brandSeedScanPredicateSql,
  identityPrefixRangeSql,
  identityPrefixUpperBound,
  likePrefixPattern,
  seedBrandIdentitySql,
  seedDomainIdentitySql,
  seedTitleSql,
  uncoveredPrefixKeys,
};
