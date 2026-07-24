'use strict';

// Test/demo merchant exclusion — the ONE shared predicate for "this seller is a
// rig, not real inventory".
//
// Why this exists: on 2026-07-23 the public ACP feed (GET /acp/feed) shipped and
// served 20/20 test SKUs — 8 from the founder's test store and 12 from Shopify's
// stock dev-store sample catalog (snowboards, "Pivota Review Demo 2"). The feed
// asks the backend for find_products with an EMPTY query; with no merchant_id
// the backend falls back to multi-search, which resolves to the connected_catalog
// lane (live catalogs of connected Shopify stores). The only gate on that lane is
// _is_product_sellable (status ACTIVE + orderable) — no serving/trust gate — and
// the only connected stores are the two test stores, so the test stores WERE the
// feed.
//
// A demo predicate already existed in pivota-backend
// (scripts/step5_working_set.py: DEMO_DOMAIN_PREFIX / DEMO_EXCLUSION_SQL) but its
// own comment scopes it to "the working-set classifier and the sweep gauges" — it
// was wired to no serving path. This module is the serving-side twin: keep the two
// in lockstep, and add new rigs HERE (and there), nowhere else.
//
// Consumed by activeCatalogSourceSql.js, so every catalog read path that already
// uses the shared source gate (PDP sig resolution, canonical search,
// RecommendationEngine, the ProductEntity index feed) inherits the exclusion.

// Sellers whose entire catalog is a rig. Founder-confirmed 2026-07-24.
const TEST_MERCHANT_IDS = Object.freeze([
  // 92sfrj-bi.myshopify.com — the founder's test store. Carries the "Winona
  // Soothing Repair Serum" $1.69 fixture whose description literally reads
  // "Test fixture for PDP", alongside PawStyle/MOYU/KraveBeauty scratch rows.
  'merch_efbc46b4619cfbdf',
  // pivota-review-demo-2.myshopify.com — Shopify's stock dev-store sample
  // catalog. This was the App Store review rig; Pivota moved to custom-app-only
  // credentials on 2026-07-21 after repeated review rejections, so nothing
  // depends on these rows being publicly reachable.
  'merch_shopify_0584b37f7a8be00a5223',
]);

// Storefront domains that are rigs regardless of which merchant_id they mint
// under. Mirrors pivota-backend DEMO_DOMAIN_PREFIX so a re-connected demo store
// under a NEW merchant_id is still excluded without a code change.
const TEST_STORE_DOMAIN_PREFIXES = Object.freeze(['pivota-review-demo']);

// Additive env escape hatch: exclude a newly-spotted rig without a deploy.
// Never subtractive — the baked-in ids above cannot be turned off by env, so a
// misconfigured variable can only over-exclude (safe), never leak (unsafe).
const TEST_MERCHANT_ENV_VAR = 'PIVOTA_TEST_MERCHANT_IDS';

function parseIdList(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The effective exclusion set: baked-in rigs ∪ env additions.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function getTestMerchantIds(env = process.env) {
  const extra = parseIdList(env?.[TEST_MERCHANT_ENV_VAR]);
  return Array.from(new Set([...TEST_MERCHANT_IDS, ...extra]));
}

/**
 * Runtime predicate for row/result filtering (the defence-in-depth leg, used on
 * feed output that comes back from a lane this module does NOT gate in SQL).
 * @param {unknown} merchantId
 * @param {NodeJS.ProcessEnv} [env]
 */
function isTestMerchantId(merchantId, env = process.env) {
  const id = String(merchantId ?? '').trim();
  if (id === '') return false;
  return getTestMerchantIds(env).includes(id);
}

// Single-quote escaping for the literals we inline. Ids are operator-supplied,
// not request-supplied, but this SQL is string-built so quote them properly
// anyway rather than trusting the shape of an env var.
function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * SQL twin of isTestMerchantId(), for the shared catalog source gate.
 * Returns a boolean expression that is TRUE when the row is NOT a rig.
 *
 * The domain leg is opt-in because only catalog_products carries source_domain —
 * products_cache does not (merchant_id / platform / platform_product_id /
 * product_data), so asking for it there would be a 42703 on every read. The
 * merchant-id leg always applies, and it is the leg that covers both known rigs.
 *
 * @param {string} productAlias table alias holding merchant_id (already validated by the caller)
 * @param {{ hasSourceDomain?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
function notTestMerchantSql(productAlias, opts = {}) {
  const { hasSourceDomain = false, env = process.env } = opts;
  const ids = getTestMerchantIds(env).map(quoteSqlLiteral).join(', ');
  const clauses = [`${productAlias}.merchant_id NOT IN (${ids})`];
  if (hasSourceDomain) {
    for (const prefix of TEST_STORE_DOMAIN_PREFIXES) {
      clauses.push(
        `coalesce(${productAlias}.source_domain, '') NOT LIKE ${quoteSqlLiteral(`${prefix}%`)}`,
      );
    }
  }
  return `
    (
      ${clauses.join('\n      AND ')}
    )
  `;
}

module.exports = {
  TEST_MERCHANT_IDS,
  TEST_STORE_DOMAIN_PREFIXES,
  TEST_MERCHANT_ENV_VAR,
  getTestMerchantIds,
  isTestMerchantId,
  notTestMerchantSql,
};
