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
//   * seed-routed rows resolve detail through external_product_seeds on TWO
//     keys, in the gateway's own order of preference:
//       1. external_product_id = catalog_products.source_product_id — the
//          mirror lane, where source_product_id already IS a seed id;
//       2. attached_product_key = catalog_products.product_key — the P3 minted
//          lane, for catalog_enrichment_agent_v1 rows whose seeds attach by
//          product_key and carry an external_product_id of the form
//          brand:hash while their own source_product_id is a name slug.
//     No acceptable seed on EITHER key ⇒ PRODUCT_NOT_FOUND ⇒ the static/ISR
//     PDP route 500s. Key 2 is why the 1,375 public catalog_enrichment_agent_v1
//     rows stopped being dead: before P3 the gateway only tried key 1, and
//     11/11 sampled minted PDPs hard-500ed; after it, 12/12 sampled minted PDPs
//     answered 200 with a real title, brand, image and price against prod data,
//     while 8 mirror / 4 shopify / 3 url_audit controls were byte-identical.
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

// Path-C "minted canonical" rows. Their seed does NOT answer on the route key:
// it attaches by external_product_seeds.attached_product_key =
// catalog_products.product_key and carries a brand:hash external_product_id,
// while the minted row's own source_product_id is a canonical name slug.
// Measured in prod 2026-07-25: 0 of 2,175 minted rows have ANY seed on the
// route key, while 2,063 carry an attached seed (2,051 an active one).
//
// P3 taught get_pdp_v2 to resolve that second lane — see the LANE 1 arm of the
// seed LATERAL in resolveCatalogProductRefFromPivotaSignatureInner in
// src/server.js — so the lane is now renderable and this predicate has to say
// so, or the sitemap keeps withholding ~1,375 PDPs that render fine.
const MINTED_SOURCE_SYSTEM = 'catalog_enrichment_agent_v1';

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
// Split PER PLATFORM on 2026-07-29, in lockstep with the Python twin
// (pivota-backend services/pdp_renderability.py, same-day change). The single
// boolean this replaced was measured FALSE for shopify (7/7 HTTP 500,
// 2026-07-25) and assumed-by-symmetry for wix. The Wix pilot
// (merch_e68c20b0189746d0, ~/dev/PIVOTA_SYNC_LANE_PILOT_RUNBOOK.md) then
// measured the wix lane end-to-end: 8/8 get_pdp_v2 SUCCESS with real payloads,
// 8/8 public PDP HTTP 200 with product JSON-LD. wix is TRUE on that evidence;
// shopify stays FALSE until its own pilot produces the same artifact — the
// TO RE-ENABLE procedure above applies to it verbatim.
const MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM = Object.freeze({
  shopify: false, // MEASURED FALSE 2026-07-25: 7/7 HTTP 500
  wix: true,      // MEASURED TRUE 2026-07-29: pilot 8/8 gateway + 8/8 PDP 200
});
// Legacy alias: true only if EVERY lane is open (it is not). Kept so stale
// readers fail loudly in review rather than silently reading a wrong boolean.
const MERCHANT_SYNCED_LANE_RENDERABLE = Object.values(
  MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM,
).every(Boolean);

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
 * P3 added the SECOND lane (attached_product_key). It is gated on
 * source_system AND on "the route key answers with NOTHING", rather than OR-ed
 * in flat, because the gateway's seed LATERAL ranks by LANE before it ranks by
 * status: whenever lane 0 answers at all, its winner is what the precheck
 * judges. A flat OR would over-advertise a row holding an inactive route-key
 * seed alongside an active attached one — the gateway would 404
 * external_seed_not_active while the sitemap called it renderable, which is
 * #1583's dead-URL bug recreated on a new lane. The source_system test comes
 * first so non-minted rows never pay for the two extra subqueries and their
 * plan is unchanged.
 *
 * Two details in that arm mirror the gateway EXACTLY rather than
 * approximately, both in the under-advertise direction if they ever diverge:
 *
 *   - `source_system = 'catalog_enrichment_agent_v1'` is an EXACT comparison,
 *     like the gateway's LANE 1. Normalising it with lower/trim here would be
 *     strictly WIDER than the gateway — the OVER-advertise direction.
 *   - the lane-order NOT EXISTS carries the gateway LANE 0 platform conjunct
 *     (`platform = 'external_seed'`), because the gateway falls through to
 *     lane 1 exactly when its OWN lane 0 matched nothing.
 *
 * The ACCEPTANCE arm deliberately does NOT carry that platform guard: it never
 * has, and adding it would change lanes this change is otherwise additive to.
 * So it stays a STATED precondition — the equivalence holds exactly on rows
 * whose platform is `external_seed`, which is all 2,175 minted rows in prod
 * and every seed-mirror row. See the Python twin for the full note.
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
    '(EXISTS (SELECT 1 FROM external_product_seeds _seed_route ' +
    `WHERE _seed_route.external_product_id = ${cpAlias}.source_product_id ` +
    "AND coalesce(lower(trim(_seed_route.status)), '') IN ('', 'active'))" +
    ` OR (${cpAlias}.source_system = '${MINTED_SOURCE_SYSTEM}'` +
    ' AND NOT EXISTS (SELECT 1 FROM external_product_seeds _seed_route_any ' +
    `WHERE _seed_route_any.external_product_id = ${cpAlias}.source_product_id ` +
    `AND lower(trim(coalesce(${cpAlias}.platform, ''))) ` +
    `= '${EXTERNAL_SEED_MERCHANT_ID}')` +
    ' AND EXISTS (SELECT 1 FROM external_product_seeds _seed_route_minted ' +
    `WHERE _seed_route_minted.attached_product_key = ${cpAlias}.product_key ` +
    "AND coalesce(lower(trim(_seed_route_minted.status)), '') " +
    "IN ('', 'active'))))"
  );
}

/**
 * SQL twin of the LANE DISPATCH in `pdpRouteResolvable` — "is this row
 * seed-routed at all?".
 *
 * `seedRouteResolvesSql` alone is NOT the renderability predicate; it answers
 * only the seed lane. A merchant-synced (shopify/wix) row whose
 * `source_product_id` happened to collide with some seed's
 * `external_product_id` would satisfy it, while `pdpRouteResolvable` returns
 * MERCHANT_SYNCED_LANE_RENDERABLE — measured FALSE. Callers needing the whole
 * predicate in SQL must AND the two, or they sit on the OVER-advertise side,
 * which for a canonical tag means pointing a live page at a URL that 500s.
 *
 * Mirrors the `seedRouted` disjunction verbatim, including that it is evaluated
 * BEFORE the merchant-synced lane, so an `ext_`-prefixed id under a normal
 * merchant stays seed-gated.
 *
 * @param {string} cpAlias catalog_products alias in the enclosing statement
 */
function seedRoutedLaneSql(cpAlias = 'cp') {
  const sourceSystems = [...SEED_ROUTED_SOURCE_SYSTEMS]
    .map((system) => `'${system}'`)
    .join(', ');
  // `left(..., 4) IN (...)`, NOT `LIKE 'ext_%'` — `_` is a single-character
  // wildcard in LIKE, so the pattern form would also match `extX…` and make
  // this predicate WIDER than the `loweredId.slice(0, 4)` it mirrors. Wider is
  // the over-advertise direction.
  const idPrefixes = EXTERNAL_SEED_ID_PREFIXES.map((prefix) => `'${prefix}'`).join(', ');
  return (
    `(${cpAlias}.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'` +
    ` OR lower(trim(coalesce(${cpAlias}.platform, ''))) = '${EXTERNAL_SEED_MERCHANT_ID}'` +
    ` OR lower(trim(coalesce(${cpAlias}.source_system, ''))) IN (${sourceSystems})` +
    ` OR left(lower(trim(coalesce(${cpAlias}.source_product_id, ''))), 4) IN (${idPrefixes}))`
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
    // Per-platform measured verdicts — see MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM.
    return MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM[loweredPlatform] === true;
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
  MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM,
  MERCHANT_SYNCED_PLATFORMS,
  MINTED_SOURCE_SYSTEM,
  SEED_ROUTED_SOURCE_SYSTEMS,
  pdpRouteResolvable,
  pdpRouteResolvableFromRow,
  seedRoutedLaneSql,
  seedRouteResolvesSql,
};
