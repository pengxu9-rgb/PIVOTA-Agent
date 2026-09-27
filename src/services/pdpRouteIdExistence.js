'use strict';

// Does ANY stored record correspond to a PDP route id? — the question agent.pivota.cc needs answered before
// it may turn a failed product read into a 404.
//
// WHY THIS EXISTS. get_pdp_v2 answers an unknown id with 400 MISSING_MERCHANT_CONTEXT or a reason-less
// 404 PRODUCT_NOT_FOUND, but it reaches both AFTER lookups that swallow their own failures
// (resolveProductGroupCached(...).catch(() => null), the entry precheck's .catch(() => null), stage
// timeouts, the identity-graph rescue). So the same answer also comes back for a REAL product whose lookup
// timed out or hit a DB error, and the frontend rightly keeps it a 500: a 404 is stored by the ISR/CDN cache
// and would de-index a healthy product long after the incident. The consequence: every mistyped, retired or
// mis-emitted id 500s forever (agent.pivota.cc 2026-09-27: /products/foo, /products/product:sig_…,
// retired pg_ ids crawlers keep re-fetching).
//
// This probe is the missing settled signal. It runs ONE statement over every place a real route id is
// stored, and it does NOT catch: a DB error or timeout propagates, so `exists: false` can only mean the
// statement completed and matched nothing. The asymmetry decides every choice below — a false `true`
// costs a 500 (today's behaviour), a false `false` costs a cached 404 on a live product — so it matches
// wide: over more columns than the renderer reads, never more narrowly than the renderer matches.
//
// Where a route id can live (traced through get_pdp_v2 and the id minters, 2026-09-27):
//   catalog_products        pivota_signature_id (sig_<32hex>), product_key (ext:…::h, prod::…, ext:retailer:…),
//                           source_product_id (ext_…, retailer:…, brand:hash, Shopify ids), content_key (ck_…)
//   product_group_members   product_group_id (pg_<hex>, pg_catalog_…, pg_ext_…, pg_manual_…), platform_product_id
//   external_product_seeds  id, external_product_id, attached_product_key, and the seed_data ids the seed
//                           route status precheck also matches
//   pdp_identity_listing    sellable_item_group_id (the identity graph's sig_<24hex>, stored nowhere else),
//                           product_id
//   content_canonical_election  canonical_sig_id, content_key
//   products_cache          platform_product_id, product_data id / product_id
// Validated on prod 2026-09-27: 3,500 known-good ids across every family (catalog sigs, pg_ / pg_catalog_
// groups, ck_, ext_ seeds, product keys, source ids, identity-graph sig_<24hex>, and 2,500 live sitemap
// URLs) all answered exists:true; foo / sig_000… / product:sig_… / url:x / null answered false.
// `pg:…` ids (pg:<platform>:<pid>, pg:pid:<pid>) are SYNTHESIZED at read time by buildProductGroupId and
// stored nowhere, so a miss proves nothing about them: the probe answers `exists: null` without asking.

const PDP_ROUTE_ID_EXISTENCE_CONTRACT = 'pdp_route_id_existence.v1';
const MAX_ROUTE_ID_CHARS = 512;

// Families minted at read time — absence from every table is their normal state.
const SYNTHESIZED_ROUTE_ID_RE = /^pg:/i;

// Every lookup, named, so the answer can say which store matched. `$1` is the lowercased route id; `$2` is
// [route id as given, lowercased]. The ref-key columns match case-insensitively through their
// bounded-prefix indexes (relationshipGraphRefKeySql.js) with a full-value recheck — the same match the
// renderer's catalog resolver makes. Every other column is matched on its own index against both
// spellings, which covers the renderer's exact lookups (it never matches those case-insensitively, so a
// case variant it could not render is not a product this probe has to find). The seed_data ids are read
// through their `status = 'active'` partial indexes: an inactive seed is already answered by get_pdp_v2's
// own settled 404 (`external_seed_not_active`) on the seed route.
const ROUTE_ID_LOOKUPS = Object.freeze([
  ['catalog_signature', `SELECT 1 FROM catalog_products WHERE left(lower(pivota_signature_id), 512) = left($1, 512) AND lower(pivota_signature_id) = $1`],
  ['catalog_product_key', `SELECT 1 FROM catalog_products WHERE left(lower(product_key::text), 512) = left($1, 512) AND lower(product_key::text) = $1`],
  ['catalog_source_product_id', `SELECT 1 FROM catalog_products WHERE left(lower(source_product_id::text), 512) = left($1, 512) AND lower(source_product_id::text) = $1`],
  ['catalog_content_key', `SELECT 1 FROM catalog_products WHERE content_key = ANY($2::text[])`],
  ['product_group', `SELECT 1 FROM product_group_members WHERE left(lower(product_group_id), 512) = left($1, 512) AND lower(product_group_id) = $1`],
  ['product_group_member', `SELECT 1 FROM product_group_members WHERE platform_product_id = ANY($2::text[])`],
  ['seed_id', `SELECT 1 FROM external_product_seeds WHERE id::text = ANY($2::text[])`],
  ['seed_external_product_id', `SELECT 1 FROM external_product_seeds WHERE external_product_id = ANY($2::text[])`],
  ['seed_attached_product_key', `SELECT 1 FROM external_product_seeds WHERE attached_product_key = ANY($2::text[])`],
  ['seed_data_external_product_id', `SELECT 1 FROM external_product_seeds WHERE status = 'active' AND seed_data ? 'external_product_id' AND seed_data->>'external_product_id' = ANY($2::text[])`],
  ['seed_data_product_id', `SELECT 1 FROM external_product_seeds WHERE status = 'active' AND seed_data ? 'product_id' AND seed_data->>'product_id' = ANY($2::text[])`],
  ['seed_snapshot_product_id', `SELECT 1 FROM external_product_seeds WHERE status = 'active' AND seed_data ? 'snapshot' AND seed_data->'snapshot'->>'product_id' = ANY($2::text[])`],
  ['identity_group', `SELECT 1 FROM pdp_identity_listing WHERE sellable_item_group_id = ANY($2::text[])`],
  ['identity_listing', `SELECT 1 FROM pdp_identity_listing WHERE product_id = ANY($2::text[])`],
  ['content_election_sig', `SELECT 1 FROM content_canonical_election WHERE canonical_sig_id = ANY($2::text[])`],
  ['content_election_key', `SELECT 1 FROM content_canonical_election WHERE content_key = ANY($2::text[])`],
  // Three branches, not one OR: an OR across the three expressions forced a seq scan that detoasts every
  // product_data (172 ms on prod's 82 rows, 2026-09-27); each branch has its own index.
  ['products_cache_platform_product_id', `SELECT 1 FROM products_cache WHERE platform_product_id = ANY($2::text[])`],
  ['products_cache_data_id', `SELECT 1 FROM products_cache WHERE product_data->>'id' = ANY($2::text[])`],
  ['products_cache_data_product_id', `SELECT 1 FROM products_cache WHERE product_data->>'product_id' = ANY($2::text[])`],
]);

const ROUTE_ID_EXISTENCE_SQL = `
  SELECT
    ${ROUTE_ID_LOOKUPS.map(([name, sql]) => `EXISTS (${sql}) AS ${name}`).join(',\n    ')}
`;

class PdpRouteIdExistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeRouteId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {string} productId  the route id exactly as the page received it
 * @param {{ queryFn: (sql:string, params:any[]) => Promise<{rows:object[]}> }} deps
 * @returns {Promise<{contract:string, product_id:string, exists:boolean|null, reason?:string, matched?:string[]}>}
 *   Throws on invalid input (code INVALID_ROUTE_ID) and — deliberately — on ANY query failure.
 */
async function probePdpRouteIdExistence(productId, { queryFn } = {}) {
  const id = normalizeRouteId(productId);
  if (!id || id.length > MAX_ROUTE_ID_CHARS) {
    throw new PdpRouteIdExistenceError(
      'INVALID_ROUTE_ID',
      `product_id must be a non-empty string of at most ${MAX_ROUTE_ID_CHARS} characters`,
    );
  }
  if (SYNTHESIZED_ROUTE_ID_RE.test(id)) {
    return { contract: PDP_ROUTE_ID_EXISTENCE_CONTRACT, product_id: id, exists: null, reason: 'synthesized_id_family' };
  }
  if (typeof queryFn !== 'function') {
    throw new PdpRouteIdExistenceError('NO_DATABASE', 'no database is configured');
  }
  // No try/catch: a failed statement must never read as "absent".
  const spellings = Array.from(new Set([id, id.toLowerCase()]));
  const res = await queryFn(ROUTE_ID_EXISTENCE_SQL, [id.toLowerCase(), spellings]);
  const row = res && Array.isArray(res.rows) ? res.rows[0] : null;
  if (!row || typeof row !== 'object') {
    // A statement that returns no row did not answer the question.
    throw new PdpRouteIdExistenceError('EXISTENCE_QUERY_EMPTY', 'existence query returned no row');
  }
  for (const [name] of ROUTE_ID_LOOKUPS) {
    // Every column must be an explicit boolean; anything else is not an answer.
    if (typeof row[name] !== 'boolean') {
      throw new PdpRouteIdExistenceError('EXISTENCE_QUERY_MALFORMED', `existence query column ${name} is not boolean`);
    }
  }
  const matched = ROUTE_ID_LOOKUPS.map(([name]) => name).filter((name) => row[name] === true);
  return { contract: PDP_ROUTE_ID_EXISTENCE_CONTRACT, product_id: id, exists: matched.length > 0, matched };
}

module.exports = {
  PDP_ROUTE_ID_EXISTENCE_CONTRACT,
  PdpRouteIdExistenceError,
  probePdpRouteIdExistence,
  __internal: { ROUTE_ID_LOOKUPS, ROUTE_ID_EXISTENCE_SQL, SYNTHESIZED_ROUTE_ID_RE, MAX_ROUTE_ID_CHARS },
};
