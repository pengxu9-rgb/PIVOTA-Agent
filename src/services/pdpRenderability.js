'use strict';

// Node twin of pivota-backend services/pdp_renderability.py.
//
// Answers: will agent.pivota.cc/products/{sig} actually render?
//
// This exists because catalogTrustPolicy's c1.v0.5 gate needs the answer, and
// the trust row for a given product must come out the same whether the Python
// upserter or this repo's upserter/backfill wrote it. Keep the two files in
// lockstep; tests/pdp_renderability.node.test.cjs and
// pivota-backend tests/test_pdp_renderability.py run the same row matrix.
//
// WHAT THE PREDICATE ENCODES (measured 2026-07-25, 29 live PDP fetches):
// the identity layer has NO bearing on whether a PDP renders. Rows with no
// pdp_identity_listing row at all served full 200s with product JSON-LD; rows
// with an approved, live-read-enabled listing served hard 500s. get_pdp_v2's
// serving gate (fetchPdpServingEligibilityFromDb in src/server.js) reads
// catalog_products + index_pipeline_state + external_product_seeds and never
// touches pdp_identity_listing. What decides it is whether the gateway can
// resolve a CONTENT ROUTE:
//
//   * seed-routed rows resolve detail through external_product_seeds keyed by
//     external_product_id = catalog_products.source_product_id. No acceptable
//     seed on that key ⇒ PRODUCT_NOT_FOUND ⇒ the static/ISR PDP route 500s.
//     (This is why all 1,375 public catalog_enrichment_agent_v1 rows are dead:
//     their seeds attach by attached_product_key and carry an
//     external_product_id of the form `brand:hash`, while source_product_id is
//     a name slug — the keys never meet.)
//   * merchant-synced rows (shopify/wix) resolve detail from the merchant
//     upstream and need no seed.
//   * everything else (url_audit audit-minted rows, brand_authored stubs) has
//     neither route.
//
// Lane order matters: the seed lane is tested FIRST, so an `ext_`-prefixed id
// under a normal merchant stays seed-gated — mirroring isExternalSeedProductId
// in src/server.js, which keys off the id, not the merchant.

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

// Source systems whose rows exist only as a projection of external_product_seeds.
const SEED_ROUTED_SOURCE_SYSTEMS = new Set([
  'external_product_seeds_mirror_v1',
  'catalog_enrichment_agent_v1',
]);

// Platforms with a live catalog-sync adapter. A platform missing here reads as
// NOT renderable — fail-closed, so a new adapter stays out of the sitemap
// rather than being advertised as a possible 500. Add the platform when an
// adapter ships; the public_not_renderable invariant is the alarm.
const MERCHANT_SYNCED_PLATFORMS = new Set(['shopify', 'wix']);

const EXTERNAL_SEED_ID_PREFIXES = ['ext_', 'ext:'];

/**
 * SQL fragment: does an acceptable seed answer on this row's route key?
 *
 * Two distinct gateway failures collapse into one predicate — no seed answers
 * `external_product_id = source_product_id` at all, and a seed answers but the
 * status-precheck winner is not active. The gateway resolves ONE row preferring
 * active, so "an acceptable row EXISTS" is exactly "the winner is acceptable",
 * and unlike "no unacceptable row exists" it does not drop a live product that
 * carries a good active seed beside a stale inactive one. A falsy status counts
 * as acceptable: the gateway's check is
 * `if (externalSeedStatus && externalSeedStatus !== 'active')`.
 */
function seedRouteResolvesSql(cpAlias = 'cp') {
  return (
    'EXISTS (SELECT 1 FROM external_product_seeds _seed_route ' +
    `WHERE _seed_route.external_product_id = ${cpAlias}.source_product_id ` +
    "AND coalesce(lower(trim(_seed_route.status)), '') IN ('', 'active'))"
  );
}

/**
 * @param {Object} args
 * @param {string|null} args.merchantId
 * @param {string|null} args.platform
 * @param {string|null} args.sourceSystem
 * @param {string|null} args.sourceProductId
 * @param {boolean} args.seedRouteOk  result of seedRouteResolvesSql for this row
 * @returns {boolean}
 */
function pdpRouteResolvable({
  merchantId,
  platform,
  sourceSystem,
  sourceProductId,
  seedRouteOk,
}) {
  const loweredId = String(sourceProductId ?? '').trim().toLowerCase();
  const loweredPlatform = String(platform ?? '').trim().toLowerCase();
  const seedRouted =
    String(merchantId ?? '') === EXTERNAL_SEED_MERCHANT_ID ||
    loweredPlatform === EXTERNAL_SEED_MERCHANT_ID ||
    SEED_ROUTED_SOURCE_SYSTEMS.has(String(sourceSystem ?? '').trim().toLowerCase()) ||
    EXTERNAL_SEED_ID_PREFIXES.includes(loweredId.slice(0, 4));

  if (seedRouted) return Boolean(seedRouteOk);
  return MERCHANT_SYNCED_PLATFORMS.has(loweredPlatform);
}

/**
 * Tri-state wrapper for the trust-policy input: returns null (never blocks)
 * when the caller's row does not carry the seed-route column, so a producer
 * not yet taught to select it keeps its c1.v0.4 output exactly.
 */
function pdpRouteResolvableFromRow(row) {
  if (!row || row.pdp_seed_route_ok == null) return null;
  return pdpRouteResolvable({
    merchantId: row.merchant_id,
    platform: row.platform,
    sourceSystem: row.source_system,
    sourceProductId: row.source_product_id,
    seedRouteOk: Boolean(row.pdp_seed_route_ok),
  });
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  MERCHANT_SYNCED_PLATFORMS,
  SEED_ROUTED_SOURCE_SYSTEMS,
  pdpRouteResolvable,
  pdpRouteResolvableFromRow,
  seedRouteResolvesSql,
};
