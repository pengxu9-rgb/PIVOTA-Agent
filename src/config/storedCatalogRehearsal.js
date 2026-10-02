'use strict';

// Opt-in configuration assertion for the isolated full-serving catalog rehearsal.
// This is not a network sandbox or a substitute for the rehearsal's read-only DB
// role and transport allowlist. It prevents dangerous defaults from quietly
// arming background work when the normal server is used for that rehearsal.
const DISABLED_FLAGS = Object.freeze([
  'DB_AUTO_MIGRATE',
  'CREATOR_CATALOG_AUTO_SYNC_ENABLED',
  'PDP_IDENTITY_AUTO_RESOLVE_ENABLED',
  'PDP_CORE_PREWARM_ENABLED',
  'CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED',
  'CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED',
  'MERCHANT_VARIANT_SOURCING_ENABLED',
  'SERVE_LIVE_MERCHANT_PRICE',
  'EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED',
  'PDP_SIMILAR_FIRST_PAINT_INLINE_ENABLED',
  'PDP_SIMILAR_FIRST_PAINT_PREWARM_ENABLED',
  'PDP_SIMILAR_CARD_DETAIL_ENRICH_ENABLED',
  'PDP_SIMILAR_CARD_ENRICH_CACHE_ENABLED',
  'PDP_SIMILAR_VISIBLE_SIG_HYDRATION_CACHE_ENABLED',
  'PDP_SYNC_SAVINGS_PRESENTATION_HYDRATION_ENABLED',
  'PDP_EXTERNAL_SEED_UPSTREAM_GROUP_RESOLVE_ENABLED',
  'PDP_EXTERNAL_SEED_LEGACY_DETAIL_FALLBACK_ENABLED',
  'CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED',
  'GATEWAY_DYNAMIC_BRAND_DETECT',
  'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED',
  'AURORA_BFF_PDP_CORE_PREFETCH_ENABLED',
  'AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL',
  'AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH',
  'AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_POST_ENRICHMENT_ENABLED',
  'AURORA_BFF_RECO_PDP_LIGHT_ENRICH',
  'AURORA_INGREDIENT_GOAL_ENRICH_ENABLED',
  'AURORA_ROUTINE_PRODUCT_AUTOSCAN_ENABLED',
  'FIND_PRODUCTS_MULTI_LLM_ENABLED',
]);

const REMOTE_INDEX_CONFIG = Object.freeze([
  'CATALOG_SERVING_INDEX_BASE_URL', 'CATALOG_SERVING_BASE_URL',
]);

function assertStoredCatalogRehearsal(env = process.env) {
  const requested = env.GATEWAY_STORED_CATALOG_REHEARSAL;
  if (requested == null || requested === '') return { enabled: false };
  if (requested !== '1') throw new Error('STORED_CATALOG_REHEARSAL_FLAG_INVALID');
  // Several cache flags deliberately use !== 'false', so synonyms such as 0,
  // FALSE or off would leave them armed. Require the exact common safe spelling.
  const unsafe = DISABLED_FLAGS.filter((name) => env[name] !== 'false');
  unsafe.push(...REMOTE_INDEX_CONFIG.filter((name) => String(env[name] || '').trim() !== ''));
  if (unsafe.length) {
    // Only names, never configuration values (which may contain credentials).
    throw new Error(`STORED_CATALOG_REHEARSAL_UNSAFE_CONFIG:${unsafe.join(',')}`);
  }
  return { enabled: true, disabled_flags: [...DISABLED_FLAGS] };
}

module.exports = { assertStoredCatalogRehearsal, DISABLED_FLAGS, REMOTE_INDEX_CONFIG };
