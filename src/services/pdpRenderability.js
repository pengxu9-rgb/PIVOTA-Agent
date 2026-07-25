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
//   * merchant-synced rows (shopify/wix) were ASSUMED to resolve detail from the
//     merchant upstream and need no seed. Measured, that is FALSE (7/7 HTTP
//     500) — see MERCHANT_SYNCED_LANE_RENDERABLE below.
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
//
// This set is NARROWER than the platform sets the rest of the stack supports
// ({shopify, wix, woocommerce, bigcommerce} in the backend's
// merchant_commerce_readiness / agent_center_sku_match_live services). Moot
// while the lane is closed (below), load-bearing again the moment it re-opens.
const MERCHANT_SYNCED_PLATFORMS = new Set(['shopify', 'wix']);

// …AND WHETHER THAT LANE RENDERS AT ALL. Answer today: NO.
//
// The first cut of this predicate assumed "platform has a sync adapter ⇒ the
// gateway serves detail from the merchant upstream ⇒ renderable", by symmetry
// with the seed lane. That was never measured, and when it WAS measured it came
// back false: 7/7 shopify PDPs the arm called renderable returned HTTP 500
// (2,007 bytes, no product JSON-LD), including rows under merchants with
// catalog_merchants.indexable = true. So the lane is fail-CLOSED like every
// other unproven lane rather than the single fail-OPEN exception.
//
// Blast radius of being honest, measured 2026-07-25: ZERO rows change. Prod has
// 1,561 merchant-synced-lane rows, of which 0 are trust-public and 0 are
// unsuppressed AND index/serving-eligible. What it buys is a defused landmine:
// 737 of those rows are held out of the sitemap only by their merchant's
// indexable=false bit, which is NOT part of this predicate — flip that one bit
// while this arm says true and 737 hard-500 URLs enter the sitemap while
// public_not_renderable reports none of them.
//
// TO RE-ENABLE: measure. If the PDPs render with product JSON-LD, flip this to
// true in BOTH twins in one change (here and pivota-backend
// services/pdp_renderability.py). The right long-term fix is P3 — teach the
// gateway to resolve these rows — not a wider predicate.
const MERCHANT_SYNCED_LANE_RENDERABLE = false;

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
 *
 * NOTE on `IN ('', 'active')`: this is deliberately WIDER than the gateway's
 * own ranking, which orders `status = 'active'` first. NULL / empty / all-space
 * statuses are accepted here because the gateway's precheck lets them through,
 * but a row whose ONLY seed has a blank status would be ranked last rather than
 * refused — a divergence we accept as empirically moot: prod currently holds
 * ZERO NULL-or-empty seed statuses (the non-active values in the wild are
 * 'inactive', 'retired_demo', 'review_blocked', 'disabled', 'blocked', all of
 * which fall outside the set). If blank statuses ever start being written,
 * revisit this together with the gateway ranking rather than only here.
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
  if (MERCHANT_SYNCED_PLATFORMS.has(loweredPlatform)) {
    // MEASURED FALSE — see MERCHANT_SYNCED_LANE_RENDERABLE.
    return MERCHANT_SYNCED_LANE_RENDERABLE;
  }
  return false;
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
  MERCHANT_SYNCED_LANE_RENDERABLE,
  MERCHANT_SYNCED_PLATFORMS,
  SEED_ROUTED_SOURCE_SYSTEMS,
  pdpRouteResolvable,
  pdpRouteResolvableFromRow,
  seedRouteResolvesSql,
};
