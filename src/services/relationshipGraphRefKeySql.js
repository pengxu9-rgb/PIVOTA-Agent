'use strict';

// The relationship graph resolves each edge ref ("product:ext_…", a signature, a URL) to a catalog row by
// comparing its lowercased key against five catalog_products columns. It used to do that with one join
// ON lower(a) = k OR lower(b) = k OR …: no index covers an OR of expressions, so PostgreSQL materialized
// every active catalog row and compared it against every ref. In prod on 2026-09-16 that was 7.4s for the
// 41 refs of three anchors (571,417 rows removed by the join filter, ~1M temp blocks), and it is what made
// brand pages with a relationship-graph recall take ~1.4s at p50 and ~5.3s at p95.
//
// Each column is now its own indexed equality branch. The index covers left(lower(col), 512), not
// lower(col): a btree key is capped at ~2704 bytes, and an index on the unbounded expression would make
// any later write of a longer URL fail. Every branch therefore probes the bounded prefix (the index
// condition) and rechecks the full value, so matches are exactly those of the old OR.
const REF_KEY_PREFIX_CHARS = 512;

const RELATIONSHIP_GRAPH_REF_KEY_COLUMNS = Object.freeze([
  'source_product_id',
  'product_key',
  'pivota_signature_id',
  'canonical_url',
  'pivota_canonical_url',
]);

function assertRefKeyColumn(column) {
  if (!RELATIONSHIP_GRAPH_REF_KEY_COLUMNS.includes(column)) {
    throw new Error(`not a relationship graph ref key column: ${column}`);
  }
}

// The indexed expression. `alias` is omitted for the index definition.
function refKeyIndexExpressionSql(column, alias = '') {
  assertRefKeyColumn(column);
  const ref = alias ? `${alias}.${column}` : column;
  return `left(lower(${ref}), ${REF_KEY_PREFIX_CHARS})`;
}

// One join condition: the index probe on the bounded prefix, then the exact recheck.
function refKeyMatchSql(column, productAlias, refKeySql) {
  assertRefKeyColumn(column);
  return (
    `${refKeyIndexExpressionSql(column, productAlias)} = left(${refKeySql}, ${REF_KEY_PREFIX_CHARS})` +
    ` AND lower(${productAlias}.${column}) = ${refKeySql}`
  );
}

function refKeyIndexName(column) {
  assertRefKeyColumn(column);
  return `idx_catalog_products_ref_key_${column}_v1`;
}

module.exports = {
  REF_KEY_PREFIX_CHARS,
  RELATIONSHIP_GRAPH_REF_KEY_COLUMNS,
  refKeyIndexExpressionSql,
  refKeyIndexName,
  refKeyMatchSql,
};
