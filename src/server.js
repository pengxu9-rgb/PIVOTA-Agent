/*
 * Pivota Agent gateway.
 * Exposes /agent/shop/v1/invoke and forwards to Pivota internal API based on operation.
 */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { createHash, randomUUID } = require('crypto');
const { InvokeRequestSchema, OperationEnum } = require('./schema');
const logger = require('./logger');
const { runMigrations } = require('./db/migrate');
const { query } = require('./db');
const { CREATOR_CONFIGS, getCreatorConfig } = require('./creatorConfig');
const { mockProducts, searchProducts, getProductById } = require('./mockProducts');
const {
  buildOfferId,
  buildProductGroupId,
  extractMerchantIdFromOfferId,
  parseOfferId,
} = require('./offers/offerIds');
const { prioritizeOffersResolveResponse } = require('./offers/offersPriority');
const { buildPdpPayload } = require('./pdpBuilder');
const {
  getAllPromotions,
  getPromotionById,
  upsertPromotion,
  softDeletePromotion,
} = require('./promotionStore');
const {
  buildCreatorCategoryTree,
  getCreatorCategoryProducts,
} = require('./services/categories');
const { recommendHandler } = require('./recommend/index');
const {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
} = require('./findProductsMulti/policy');
const { maybeRerankFindProductsMultiResponse } = require('./findProductsMulti/rerankLlm');
const { embedText } = require('./services/embeddings');
const {
  semanticSearchCreatorProductsFromCache,
} = require('./services/productsCacheVectorSearch');
const {
  scoreByTagFacetOverlap,
  scorePairOverlap,
} = require('./services/productTagSignals');
const noopMountRoute = () => {};
let mountLookReplicatorRoutes = noopMountRoute;
try {
  ({ mountLookReplicatorRoutes } = require('./lookReplicator'));
} catch (err) {
  logger.error(
    { err: err?.message || String(err) },
    'lookReplicator module failed to load; disabling look replicator routes',
  );
}
const { mountOutcomeTelemetryRoutes, mountLookReplicatorEventRoutes, mountUiEventRoutes } = require('./telemetry');
const { mountLayer1CompatibilityRoutes } = require('./layer1/routes/layer1Compatibility');
const { mountLayer1BundleRoutes } = require('./layer1/routes/layer1BundleValidate');
const { mountExternalOfferRoutes } = require('./layer3/routes/externalOffers');
const { mountRecommendationRoutes } = require('./recommendations/routes');
let mountAuroraBffRoutes = noopMountRoute;
let auroraBffInternal = {};
try {
  const auroraRoutes = require('./auroraBff/routes');
  mountAuroraBffRoutes =
    typeof auroraRoutes?.mountAuroraBffRoutes === 'function'
      ? auroraRoutes.mountAuroraBffRoutes
      : noopMountRoute;
  auroraBffInternal = auroraRoutes?.__internal && typeof auroraRoutes.__internal === 'object'
    ? auroraRoutes.__internal
    : {};
} catch (err) {
  logger.error(
    { err: err?.message || String(err) },
    'auroraBff routes failed to load; disabling aurora routes for this process',
  );
}
const { applyGatewayGuardrails } = require('./guardrails/gatewayGuardrails');
const { recommend: recommendPdpProducts, getCacheStats: getPdpRecsCacheStats } = require('./services/RecommendationEngine');
const {
  resolveProductRef,
  _internals: productGroundingResolverInternals = {},
} = require('./services/productGroundingResolver');
const {
  upsertMissingCatalogProduct,
  listMissingCatalogProducts,
  toCsv: missingCatalogProductsToCsv,
} = require('./services/missingCatalogProductsStore');

const resolveStableAliasByQuery =
  typeof productGroundingResolverInternals.resolveKnownStableProductRef === 'function'
    ? productGroundingResolverInternals.resolveKnownStableProductRef
    : null;
const normalizeResolverText =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();
const tokenizeResolverQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

const getAuroraPdpPrefetchStateSnapshot =
  typeof auroraBffInternal.getPdpPrefetchStateSnapshot === 'function'
    ? auroraBffInternal.getPdpPrefetchStateSnapshot
    : null;

const PORT = process.env.PORT || 3000;
const SERVICE_STARTED_AT = new Date().toISOString();
const SERVICE_GIT_SHA = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '').trim();
const SERVICE_GIT_BRANCH = String(process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || '').trim();
const SERVICE_NAME = String(process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || 'pivota-agent-gateway').trim();
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';
const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
const REVIEWS_API_BASE = (
  process.env.REVIEWS_API_BASE ||
  process.env.REVIEWS_BACKEND_URL ||
  process.env.REVIEWS_BACKEND ||
  'https://web-production-fedb.up.railway.app'
).replace(/\/$/, '');
const UI_GATEWAY_URL = (process.env.PIVOTA_GATEWAY_URL || 'http://localhost:3000/agent/shop/v1/invoke').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

// Agent budgeting & loop protection (per /ui/chat turn)
const MAX_AGENT_STEPS_PER_TURN = Number(process.env.AGENT_MAX_STEPS_PER_TURN || 8);
const MAX_TOOL_CALLS_PER_TURN = Number(process.env.AGENT_MAX_TOOL_CALLS_PER_TURN || 8);
const MAX_TOTAL_RUNTIME_MS = Number(process.env.AGENT_MAX_TOTAL_RUNTIME_MS || 20000);
const MAX_TOOL_LOOP_DUPLICATES = Number(process.env.AGENT_MAX_TOOL_LOOP_DUPLICATES || 3);
const MAX_CONTEXT_MESSAGES = Number(process.env.AGENT_MAX_CONTEXT_MESSAGES || 40);
const MAX_TOOL_CONTENT_CHARS = Number(process.env.AGENT_MAX_TOOL_CONTENT_CHARS || 8000);
const MAX_TASK_POLL_ATTEMPTS = Number(process.env.AGENT_MAX_TASK_POLL_ATTEMPTS || 10);
const TASK_POLL_INTERVAL_MS = Number(process.env.AGENT_TASK_POLL_INTERVAL_MS || 500);
const ROUTE_DEBUG_ENABLED =
  process.env.FIND_PRODUCTS_MULTI_DEBUG_STATS === '1' ||
  process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === '1';
const SEARCH_RELEVANCE_DEBUG_ENABLED =
  ROUTE_DEBUG_ENABLED ||
  String(process.env.SEARCH_RELEVANCE_DEBUG || '').trim().toLowerCase() === '1' ||
  String(process.env.SEARCH_RELEVANCE_DEBUG || '').trim().toLowerCase() === 'true';

function parseTimeoutMs(envValue, fallbackMs) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const CREATOR_CATALOG_CACHE_TTL_SECONDS = parsePositiveInt(
  process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
  7 * 24 * 60 * 60,
  { min: 300, max: 30 * 24 * 60 * 60 },
);
const CREATOR_CATALOG_AUTO_SYNC_ENABLED = (() => {
  const raw = String(process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED || '').trim().toLowerCase();
  if (!raw) return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  return ['1', 'true', 'yes', 'on'].includes(raw);
})();
const CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
  120000,
  { min: 1000, max: 10 * 60 * 1000 },
);
const CREATOR_CATALOG_AUTO_SYNC_RETRIES = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_RETRIES,
  1,
  { min: 0, max: 5 },
);
const CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
  3000,
  { min: 100, max: 60 * 1000 },
);
const CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
  6 * 60 * 60,
  { min: 60, max: 7 * 24 * 60 * 60 },
);
const CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS,
  24 * 60 * 60,
  { min: 5 * 60, max: 30 * 24 * 60 * 60 },
);
const CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS = parsePositiveInt(
  process.env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS,
  Math.max(240000, CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS * 4),
  { min: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS, max: 20 * 60 * 1000 },
);

function getCreatorCatalogAutoSyncIntervalConfig() {
  const maxIntervalMinutes = Math.max(
    1,
    Math.min(360, Math.floor(CREATOR_CATALOG_CACHE_TTL_SECONDS / 4 / 60)),
  );
  const configuredRaw = String(process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES || '').trim();
  const configuredMinutes = configuredRaw ? parsePositiveInt(configuredRaw, null, { min: 1, max: 24 * 60 }) : null;
  if (configuredMinutes == null) {
    return {
      intervalMinutes: maxIntervalMinutes,
      maxIntervalMinutes,
      configuredMinutes: null,
      clamped: false,
    };
  }
  const intervalMinutes = Math.min(configuredMinutes, maxIntervalMinutes);
  return {
    intervalMinutes,
    maxIntervalMinutes,
    configuredMinutes,
    clamped: configuredMinutes > maxIntervalMinutes,
  };
}

// Upstream request timeouts.
// NOTE: Shopify pricing flows can involve multiple sequential upstream calls; the gateway
// timeout must not be lower than the backend's own HTTP client timeouts.
const UPSTREAM_TIMEOUT_SEARCH_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_SEARCH_MS, 15000);
const UPSTREAM_TIMEOUT_SLOW_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_SLOW_MS, 60000);
const UPSTREAM_TIMEOUT_ADMIN_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_ADMIN_MS, 15000);
const UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS = Math.max(
  1200,
  Math.min(
    parseTimeoutMs(
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS,
      Math.min(UPSTREAM_TIMEOUT_SEARCH_MS, 5000),
    ),
    6000,
  ),
);
const FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS = Math.max(
  1500,
  Math.min(
    parseTimeoutMs(process.env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS, 6500),
    10000,
  ),
);
const FIND_PRODUCTS_MULTI_TIMEOUT_ALLOW_UNSAFE_LOWER =
  String(process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER || 'false')
    .toLowerCase() === 'true';
const configuredFindProductsMultiTimeoutMs = parseTimeoutMs(
  process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
  Math.min(UPSTREAM_TIMEOUT_SEARCH_MS, FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS),
);
let UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = Math.max(
  1500,
  Math.min(configuredFindProductsMultiTimeoutMs, 10000),
);
if (
  !FIND_PRODUCTS_MULTI_TIMEOUT_ALLOW_UNSAFE_LOWER &&
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS < FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS
) {
  logger.warn(
    {
      configured_timeout_ms: configuredFindProductsMultiTimeoutMs,
      enforced_timeout_ms: FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS,
      hint: 'Set UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER=true to bypass this floor.',
    },
    'UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS is below safe floor; clamping to reduce timeout-induced empty results',
  );
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS;
}
const UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS = parseTimeoutMs(
  process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
  Math.min(
    UPSTREAM_TIMEOUT_SLOW_MS,
    Math.max(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS * 2, 9000),
  ),
);
const UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS = parseTimeoutMs(
  process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
  Math.min(
    UPSTREAM_TIMEOUT_SLOW_MS,
    Math.max(
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS + 1800,
      FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS + 1000,
      8000,
    ),
  ),
);
const UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT =
  String(process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT || '').toLowerCase() === 'true';
// Reviews are optional UI modules; keep their upstream timeout low so PDP can render quickly
// even when the reviews service is degraded.
const UPSTREAM_TIMEOUT_REVIEWS_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_REVIEWS_MS, 4000);
const UPSTREAM_TIMEOUT_SEARCH_RETRY_MS = parseTimeoutMs(
  process.env.UPSTREAM_TIMEOUT_SEARCH_RETRY_MS,
  Math.min(UPSTREAM_TIMEOUT_SLOW_MS, Math.max(UPSTREAM_TIMEOUT_SEARCH_MS * 3, 45_000)),
);
const PDP_V2_CORE_HOT_CACHE_ENABLED =
  String(process.env.PDP_V2_CORE_HOT_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const PDP_V2_CORE_HOT_CACHE_TTL_MS = Math.max(
  1000,
  parseTimeoutMs(process.env.PDP_V2_CORE_HOT_CACHE_TTL_MS, 20 * 1000),
);
const PDP_V2_CORE_HOT_CACHE_MAX_ENTRIES = Math.max(
  20,
  Number(process.env.PDP_V2_CORE_HOT_CACHE_MAX_ENTRIES || 400) || 400,
);
const PDP_CORE_PREWARM_ENABLED =
  String(process.env.PDP_CORE_PREWARM_ENABLED || 'false').toLowerCase() === 'true';
const PDP_CORE_PREWARM_TIMEOUT_MS = Math.max(
  1000,
  parseTimeoutMs(process.env.PDP_CORE_PREWARM_TIMEOUT_MS, 6500),
);
const PDP_CORE_PREWARM_INTERVAL_MS = Math.max(
  30_000,
  parseTimeoutMs(process.env.PDP_CORE_PREWARM_INTERVAL_MS, 5 * 60 * 1000),
);
const PDP_CORE_PREWARM_INITIAL_DELAY_MS = Math.max(
  0,
  Number(process.env.PDP_CORE_PREWARM_INITIAL_DELAY_MS || 3000) || 3000,
);
const PDP_CORE_PREWARM_GATEWAY_URL = String(process.env.PDP_CORE_PREWARM_GATEWAY_URL || '').trim();
const PDP_CORE_PREWARM_TARGETS = parsePdpCorePrewarmTargets(
  process.env.PDP_CORE_PREWARM_TARGETS || '',
  DEFAULT_MERCHANT_ID,
);

const SLOW_UPSTREAM_OPS = new Set([
  'preview_quote',
  'create_order',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

function getUpstreamTimeoutMs(operation) {
  if (operation === 'find_products') return UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS;
  if (operation === 'find_products_multi') return UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
  return SLOW_UPSTREAM_OPS.has(operation) ? UPSTREAM_TIMEOUT_SLOW_MS : UPSTREAM_TIMEOUT_SEARCH_MS;
}

const PROXY_SEARCH_FALLBACK_TIMEOUT_MS = parseTimeoutMs(
  process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
  Math.max(6500, Math.min(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS, 10000)),
);
const PROXY_SEARCH_RESOLVER_TIMEOUT_MS = parseTimeoutMs(
  process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
  1600,
);
const PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS = parseTimeoutMs(
  process.env.PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
  1200,
);
const PROXY_SEARCH_RESOLVER_DETAIL_ENABLED = (() => {
  const defaultValue = process.env.NODE_ENV === 'test' ? 'false' : 'true';
  return String(process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED || defaultValue).toLowerCase() === 'true';
})();
const PROXY_SEARCH_RESOLVER_FIRST_ENABLED = (() => {
  const defaultValue = process.env.NODE_ENV === 'test' ? 'false' : 'true';
  return String(process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED || defaultValue).toLowerCase() === 'true';
})();
const PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = (() => {
  const defaultValue = process.env.NODE_ENV === 'test' ? 'false' : 'true';
  return String(process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY || defaultValue).toLowerCase() === 'true';
})();
const PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = (() => {
  const defaultValue = process.env.NODE_ENV === 'test' ? 'false' : 'true';
  return (
    String(process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED || defaultValue)
      .toLowerCase() === 'true'
  );
})();
const PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED =
  String(process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const PROXY_SEARCH_INVOKE_FALLBACK_ENABLED =
  String(process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED || 'false').toLowerCase() === 'true';
const PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
  String(process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED || 'false').toLowerCase() === 'true';
const PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS =
  String(process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS || 'true').toLowerCase() ===
  'true';
const PROXY_SEARCH_AURORA_FORCE_FAST_MODE =
  String(process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE || 'true').toLowerCase() !== 'false';
const PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK =
  String(process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK || 'true').toLowerCase() !== 'false';
const PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK =
  String(process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK || 'true').toLowerCase() !== 'false';
const PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS =
  String(process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS || 'true').toLowerCase() !==
  'false';
const PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED =
  String(process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED || 'false').toLowerCase() === 'true';
const PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = (() => {
  const raw = String(process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY || 'legacy')
    .trim()
    .toLowerCase();
  return raw === 'supplement_internal_first' ? raw : 'legacy';
})();
const PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE =
  String(process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE || 'true').toLowerCase() !==
  'false';
const PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT =
  String(process.env.PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT || 'true').toLowerCase() !==
  'false';
const PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS = Math.max(
  1200,
  Math.min(
    parseTimeoutMs(
      process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
      Math.min(
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
        Math.max(5000, FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS - 500),
      ),
    ),
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
  ),
);
const PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS = Math.max(
  1200,
  Math.min(
    parseTimeoutMs(process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS, UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS),
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
  ),
);
const PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = Math.max(
  300,
  Math.min(
    parseTimeoutMs(process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS, 900),
    PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
  ),
);
const PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS = Math.max(
  300,
  Math.min(
    parseTimeoutMs(process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS, 450),
    PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
  ),
);
const PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS = Math.max(
  200,
  Math.min(
    parseTimeoutMs(process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS, 450),
    3000,
  ),
);
const PROXY_SEARCH_RESOLVER_CACHE_TTL_MS = Math.max(
  1000,
  parseTimeoutMs(process.env.PROXY_SEARCH_RESOLVER_CACHE_TTL_MS, 5 * 60 * 1000),
);
const PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS = Math.max(
  500,
  parseTimeoutMs(process.env.PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS, 45 * 1000),
);
const PROXY_SEARCH_RESOLVER_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number(process.env.PROXY_SEARCH_RESOLVER_CACHE_MAX_ENTRIES || 2000) || 2000,
);
const FIND_PRODUCTS_MULTI_EXPANSION_MODE = (() => {
  const raw = String(process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE || 'conservative')
    .trim()
    .toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';
  if (raw === 'aggressive') return 'aggressive';
  return 'conservative';
})();
const FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = (() => {
  const raw = String(process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE || 'aggressive')
    .trim()
    .toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';
  if (raw === 'conservative') return 'conservative';
  return 'aggressive';
})();
const SEARCH_STRICT_EMPTY_ENABLED =
  String(process.env.SEARCH_STRICT_EMPTY_ENABLED || 'true').toLowerCase() !== 'false';
const SEARCH_EXTERNAL_FILL_GATED =
  String(process.env.SEARCH_EXTERNAL_FILL_GATED || 'true').toLowerCase() !== 'false';
const PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED =
  String(process.env.PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED || 'false').toLowerCase() ===
  'true';
const FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS = Math.max(
  100,
  parseTimeoutMs(process.env.FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS, 2200),
);
const FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS = Math.max(
  300,
  parseTimeoutMs(process.env.FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS, 1200),
);
const FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS = Math.max(
  1500,
  parseTimeoutMs(process.env.FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS, 3500),
);
const FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS = Math.max(
  1800,
  parseTimeoutMs(process.env.FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS, 4500),
);

const OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS = parseTimeoutMs(
  process.env.OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
  1800,
);
const OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS = parseTimeoutMs(
  process.env.OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
  2600,
);
const OFFERS_RESOLVE_SUBJECT_RETRY_MAX = Math.max(
  0,
  Math.min(3, Number(process.env.OFFERS_RESOLVE_SUBJECT_RETRY_MAX || 0)),
);
const OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX = Math.max(
  0,
  Math.min(3, Number(process.env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX || 0)),
);
const OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS = Math.max(
  25,
  Number(process.env.OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS || 120) || 120,
);
const OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS = Math.max(
  25,
  Number(process.env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS || 120) || 120,
);
const OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD = Math.max(
  1,
  Math.min(10, Number(process.env.OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD || 1)),
);
const OFFERS_RESOLVE_CIRCUIT_OPEN_MS = Math.max(
  1000,
  Number(process.env.OFFERS_RESOLVE_CIRCUIT_OPEN_MS || 30000) || 30000,
);
const OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT =
  String(process.env.OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT || 'true').toLowerCase() ===
  'true';
const OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES =
  String(process.env.OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES || 'true').toLowerCase() ===
  'true';
const OFFERS_RESOLVE_CIRCUITS = {
  subject_resolve: { failure_count: 0, open_until_ms: 0, last_reason: null },
  cache_search: { failure_count: 0, open_until_ms: 0, last_reason: null },
};
const OFFERS_RESOLVE_REASON_CODE_SET = new Set([
  'mapped_hit',
  'subject_direct',
  'canonical_ref_direct',
  'stable_alias_ref',
  'no_candidates',
  'db_timeout',
  'upstream_timeout',
  'fallback_external',
]);

// Resolve-product candidates cache (Phase 2 perf: avoid repeated slow scans).
const RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED =
  process.env.RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED !== 'false';
const RESOLVE_PRODUCT_CANDIDATES_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
};
const RESOLVE_PRODUCT_CANDIDATES_TTL_MS = parseTimeoutMs(
  process.env.RESOLVE_PRODUCT_CANDIDATES_TTL_MS,
  60 * 1000,
);

function buildOrderLineSnapshots(orderRequest, options = {}) {
  const req = orderRequest && typeof orderRequest === 'object' ? orderRequest : {};
  const items = Array.isArray(req.items) ? req.items : [];
  const orderId = options.orderId || req.order_id || req.orderId || null;
  const resolvedOfferId = options.resolvedOfferId || null;
  const resolvedMerchantId = options.resolvedMerchantId || null;
  const currency = req.currency || null;
  const selectedDelivery = req.selected_delivery_option || req.selectedDeliveryOption || null;
  const shippingSnapshot = selectedDelivery
    ? {
        method_label: selectedDelivery.method_label || selectedDelivery.label || selectedDelivery.name || null,
        eta_days_range: selectedDelivery.eta_days_range || selectedDelivery.etaDaysRange || null,
        cost: selectedDelivery.cost || selectedDelivery.price || null,
      }
    : null;
  const returnsSnapshotRaw = req.returns_snapshot || req.returns || req.returns_policy || null;
  const returnsSnapshot = returnsSnapshotRaw
    ? {
        return_window_days:
          returnsSnapshotRaw.return_window_days ||
          returnsSnapshotRaw.returnWindowDays ||
          returnsSnapshotRaw.window_days ||
          returnsSnapshotRaw.windowDays ||
          null,
        free_returns:
          typeof returnsSnapshotRaw.free_returns === 'boolean'
            ? returnsSnapshotRaw.free_returns
            : typeof returnsSnapshotRaw.freeReturns === 'boolean'
              ? returnsSnapshotRaw.freeReturns
              : null,
      }
    : null;
  const policyHash = returnsSnapshot
    ? createHash('sha256')
        .update(JSON.stringify(returnsSnapshot))
        .digest('hex')
        .slice(0, 16)
    : null;

  return items.map((item, idx) => {
    const merchantId =
      item.merchant_id ||
      item.merchantId ||
      resolvedMerchantId ||
      req.merchant_id ||
      req.merchantId ||
      null;
    const productId = item.product_id || item.productId || null;
    const productGroupId =
      buildProductGroupId({ merchant_id: merchantId, product_id: productId }) || null;
    const variantId = item.variant_id || item.variantId || null;
    const unitPrice = Number(item.unit_price || item.price || 0);
    const quantity = Number(item.quantity || 0) || 1;
    const subtotal =
      typeof item.subtotal === 'number' && Number.isFinite(item.subtotal)
        ? item.subtotal
        : unitPrice * quantity;
    const lineId =
      item.line_id || item.lineId || (orderId ? `line_${orderId}_${idx + 1}` : `line_${idx + 1}`);

    return {
      line_id: lineId,
      offer_id: resolvedOfferId || item.offer_id || item.offerId || null,
      merchant_id: merchantId,
      product_id: productId,
      product_group_id: productGroupId,
      variant_id: variantId,
      quantity,
      price_snapshot: {
        unit_price: unitPrice,
        subtotal,
        currency,
      },
      ...(shippingSnapshot ? { shipping_snapshot: shippingSnapshot } : {}),
      ...(returnsSnapshot
        ? { returns_snapshot: { ...returnsSnapshot, policy_hash: policyHash } }
        : {}),
      created_at: new Date().toISOString(),
    };
  });
}

function getResolveProductCandidatesCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = RESOLVE_PRODUCT_CANDIDATES_CACHE.get(key);
  if (!hit) {
    RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    RESOLVE_PRODUCT_CANDIDATES_CACHE.delete(key);
    RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS.misses += 1;
    return null;
  }
  RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS.hits += 1;
  return hit;
}

function setResolveProductCandidatesCache(
  cacheKey,
  value,
  ttlMs = RESOLVE_PRODUCT_CANDIDATES_TTL_MS,
) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Number(ttlMs) || RESOLVE_PRODUCT_CANDIDATES_TTL_MS;
  RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS.sets += 1;
  RESOLVE_PRODUCT_CANDIDATES_CACHE.set(key, {
    value,
    storedAtMs: Date.now(),
    expiresAtMs: Date.now() + Math.max(5_000, ttl),
  });
}

function snapshotResolveProductCandidatesCacheStats() {
  return {
    enabled: RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED,
    ttl_ms: RESOLVE_PRODUCT_CANDIDATES_TTL_MS,
    size: RESOLVE_PRODUCT_CANDIDATES_CACHE.size,
    ...RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS,
  };
}

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function parsePdpCorePrewarmTargets(raw, defaultMerchantId) {
  const source = String(raw || '').trim();
  if (!source) return [];

  const fallbackMerchantId = String(defaultMerchantId || '').trim();
  const seen = new Set();
  const out = [];

  for (const tokenRaw of source.split(/[,\n]/g)) {
    const token = String(tokenRaw || '').trim();
    if (!token) continue;

    let merchantId = fallbackMerchantId;
    let productId = token;
    const sepIdx = token.indexOf(':');
    if (sepIdx > 0) {
      merchantId = String(token.slice(0, sepIdx)).trim() || fallbackMerchantId;
      productId = String(token.slice(sepIdx + 1)).trim();
    }
    if (!merchantId || !productId) continue;

    const dedupeKey = `${merchantId}:${productId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ merchant_id: merchantId, product_id: productId });
  }

  return out;
}

const PROXY_SEARCH_RESOLVER_CACHE = new Map(); // key -> { value, expiresAtMs }

function buildProxySearchResolverCacheKey({
  queryText,
  lang,
  preferMerchants,
  searchAllMerchants,
  fetchDetail,
  resolverTimeoutMs,
}) {
  const timeoutBucket = Number.isFinite(Number(resolverTimeoutMs))
    ? Math.max(100, Math.round(Number(resolverTimeoutMs) / 50) * 50)
    : null;
  return JSON.stringify({
    q: String(queryText || '').trim().toLowerCase(),
    lang: String(lang || '').trim().toLowerCase() || 'en',
    prefer_merchants: Array.isArray(preferMerchants)
      ? preferMerchants.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    search_all_merchants: searchAllMerchants === true ? true : false,
    fetch_detail: fetchDetail === true,
    resolver_timeout_ms_bucket: timeoutBucket,
  });
}

function getProxySearchResolverCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = PROXY_SEARCH_RESOLVER_CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PROXY_SEARCH_RESOLVER_CACHE.delete(key);
    return null;
  }
  return safeCloneJson(hit.value);
}

function setProxySearchResolverCacheEntry(cacheKey, value, ttlMs = PROXY_SEARCH_RESOLVER_CACHE_TTL_MS) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Math.max(500, Number(ttlMs) || PROXY_SEARCH_RESOLVER_CACHE_TTL_MS);
  while (PROXY_SEARCH_RESOLVER_CACHE.size >= PROXY_SEARCH_RESOLVER_CACHE_MAX_ENTRIES) {
    const firstKey = PROXY_SEARCH_RESOLVER_CACHE.keys().next().value;
    if (!firstKey) break;
    PROXY_SEARCH_RESOLVER_CACHE.delete(firstKey);
  }
  PROXY_SEARCH_RESOLVER_CACHE.set(key, {
    value: safeCloneJson(value),
    expiresAtMs: Date.now() + ttl,
  });
}

// Product-detail cache (avoid repeated slow upstream product fetches).
const PRODUCT_DETAIL_CACHE_ENABLED =
  process.env.PRODUCT_DETAIL_CACHE_ENABLED !== 'false';
const PRODUCT_DETAIL_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const PRODUCT_DETAIL_INFLIGHT = new Map(); // cacheKey -> Promise<product|null>
const PRODUCT_DETAIL_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
  evictions: 0,
  db_hits: 0,
};
const PRODUCT_DETAIL_CACHE_TTL_MS = parseTimeoutMs(
  process.env.PRODUCT_DETAIL_CACHE_TTL_MS,
  10 * 60 * 1000,
);
const PRODUCT_DETAIL_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.PRODUCT_DETAIL_CACHE_MAX_ENTRIES || 2000) || 2000,
);
const PRODUCT_DETAIL_STALE_LOOKUP_ENABLED =
  String(process.env.PRODUCT_DETAIL_STALE_LOOKUP_ENABLED || 'true').toLowerCase() === 'true';
const PRODUCT_DETAIL_STALE_MAX_AGE_HOURS = parsePositiveInt(
  process.env.PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
  30 * 24,
  { min: 1, max: 24 * 90 },
);

function getProductDetailCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = PRODUCT_DETAIL_CACHE.get(key);
  if (!hit) {
    PRODUCT_DETAIL_CACHE_METRICS.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PRODUCT_DETAIL_CACHE.delete(key);
    PRODUCT_DETAIL_CACHE_METRICS.misses += 1;
    return null;
  }
  PRODUCT_DETAIL_CACHE_METRICS.hits += 1;
  return hit;
}

function setProductDetailCache(
  cacheKey,
  value,
  ttlMs = PRODUCT_DETAIL_CACHE_TTL_MS,
) {
  const key = String(cacheKey || '');
  if (!key) return;

  const ttl = Number(ttlMs) || PRODUCT_DETAIL_CACHE_TTL_MS;
  const now = Date.now();

  // Simple eviction (insertion order = oldest first).
  if (PRODUCT_DETAIL_CACHE.size >= PRODUCT_DETAIL_CACHE_MAX_ENTRIES) {
    const overflow = PRODUCT_DETAIL_CACHE.size - PRODUCT_DETAIL_CACHE_MAX_ENTRIES + 1;
    let removed = 0;
    for (const k of PRODUCT_DETAIL_CACHE.keys()) {
      PRODUCT_DETAIL_CACHE.delete(k);
      removed += 1;
      if (removed >= overflow) break;
    }
    if (removed > 0) PRODUCT_DETAIL_CACHE_METRICS.evictions += removed;
  }

  PRODUCT_DETAIL_CACHE_METRICS.sets += 1;
  PRODUCT_DETAIL_CACHE.set(key, {
    value: safeCloneJson(value),
    storedAtMs: now,
    expiresAtMs: now + Math.max(5_000, ttl),
  });
}

function snapshotProductDetailCacheStats() {
  return {
    enabled: PRODUCT_DETAIL_CACHE_ENABLED,
    ttl_ms: PRODUCT_DETAIL_CACHE_TTL_MS,
    max_entries: PRODUCT_DETAIL_CACHE_MAX_ENTRIES,
    size: PRODUCT_DETAIL_CACHE.size,
    ...PRODUCT_DETAIL_CACHE_METRICS,
  };
}

// Resolve-product-group cache (avoid repeated slow upstream group lookups).
const RESOLVE_PRODUCT_GROUP_CACHE_ENABLED =
  process.env.RESOLVE_PRODUCT_GROUP_CACHE_ENABLED !== 'false';
const RESOLVE_PRODUCT_GROUP_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const RESOLVE_PRODUCT_GROUP_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
};
const RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS = parseTimeoutMs(
  process.env.RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
  10 * 60 * 1000,
);

function getResolveProductGroupCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = RESOLVE_PRODUCT_GROUP_CACHE.get(key);
  if (!hit) {
    RESOLVE_PRODUCT_GROUP_CACHE_METRICS.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    RESOLVE_PRODUCT_GROUP_CACHE.delete(key);
    RESOLVE_PRODUCT_GROUP_CACHE_METRICS.misses += 1;
    return null;
  }
  RESOLVE_PRODUCT_GROUP_CACHE_METRICS.hits += 1;
  return hit;
}

function setResolveProductGroupCache(
  cacheKey,
  value,
  ttlMs = RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Number(ttlMs) || RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS;
  RESOLVE_PRODUCT_GROUP_CACHE_METRICS.sets += 1;
  RESOLVE_PRODUCT_GROUP_CACHE.set(key, {
    value: safeCloneJson(value),
    storedAtMs: Date.now(),
    expiresAtMs: Date.now() + Math.max(5_000, ttl),
  });
}

function snapshotResolveProductGroupCacheStats() {
  return {
    enabled: RESOLVE_PRODUCT_GROUP_CACHE_ENABLED,
    ttl_ms: RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
    size: RESOLVE_PRODUCT_GROUP_CACHE.size,
    ...RESOLVE_PRODUCT_GROUP_CACHE_METRICS,
  };
}

function snapshotPdpV2CoreHotCacheStats() {
  if (!getAuroraPdpPrefetchStateSnapshot) {
    return {
      available: false,
      reason: 'aurora_bff_prefetch_snapshot_not_exported',
    };
  }

  try {
    const snapshot = getAuroraPdpPrefetchStateSnapshot();
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      return {
        available: true,
        ...snapshot,
      };
    }
    return {
      available: true,
      snapshot: snapshot == null ? null : snapshot,
    };
  } catch (err) {
    return {
      available: false,
      reason: 'aurora_bff_prefetch_snapshot_failed',
      error: String(err && err.message ? err.message : err || 'unknown_error'),
    };
  }
}

// PDP optional-module cache/singleflight (reviews + similar):
// reduces repeated upstream fan-out when clients quickly reopen/switch PDPs.
const PDP_REVIEW_SUMMARY_CACHE_ENABLED =
  process.env.PDP_REVIEW_SUMMARY_CACHE_ENABLED !== 'false';
const PDP_REVIEW_SUMMARY_CACHE = new Map(); // key -> { value, expiresAtMs }
const PDP_REVIEW_SUMMARY_INFLIGHT = new Map(); // key -> Promise<object|null>
const PDP_REVIEW_SUMMARY_CACHE_TTL_MS = parseTimeoutMs(
  process.env.PDP_REVIEW_SUMMARY_CACHE_TTL_MS,
  90 * 1000,
);
const PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS = Math.max(
  3_000,
  parseTimeoutMs(process.env.PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS, 20 * 1000),
);
const PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES || 800) || 800,
);
const PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES = Math.max(
  20,
  Number(process.env.PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES || 300) || 300,
);

const PDP_SIMILAR_INFLIGHT = new Map(); // key -> Promise<any>
const PDP_SIMILAR_INFLIGHT_MAX_ENTRIES = Math.max(
  20,
  Number(process.env.PDP_SIMILAR_INFLIGHT_MAX_ENTRIES || 300) || 300,
);

function buildPdpReviewSummaryCacheKey({ merchantId, platform, platformProductId }) {
  const mid = String(merchantId || '').trim();
  const pf = String(platform || '').trim().toLowerCase();
  const pid = String(platformProductId || '').trim();
  if (!mid || !pf || !pid) return '';
  return `${mid}::${pf}::${pid}`;
}

function getPdpReviewSummaryCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return { found: false, value: null };
  const hit = PDP_REVIEW_SUMMARY_CACHE.get(key);
  if (!hit) return { found: false, value: null };
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PDP_REVIEW_SUMMARY_CACHE.delete(key);
    return { found: false, value: null };
  }
  return { found: true, value: safeCloneJson(hit.value) };
}

function setPdpReviewSummaryCacheEntry(cacheKey, value, ttlMs) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Math.max(1_000, Number(ttlMs) || PDP_REVIEW_SUMMARY_CACHE_TTL_MS);

  if (PDP_REVIEW_SUMMARY_CACHE.size >= PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES) {
    const overflow = PDP_REVIEW_SUMMARY_CACHE.size - PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES + 1;
    let removed = 0;
    for (const k of PDP_REVIEW_SUMMARY_CACHE.keys()) {
      PDP_REVIEW_SUMMARY_CACHE.delete(k);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  PDP_REVIEW_SUMMARY_CACHE.set(key, {
    value: safeCloneJson(value),
    expiresAtMs: Date.now() + ttl,
  });
}

function buildPdpSimilarInflightKey(args = {}) {
  const product = args?.pdp_product && typeof args.pdp_product === 'object' ? args.pdp_product : {};
  const merchantId = String(
    product.merchant_id || product.merchantId || product.merchant?.id || '',
  ).trim();
  const productId = String(product.product_id || product.productId || product.id || '').trim();
  if (!merchantId || !productId) return '';
  const limit = Math.max(1, Math.min(24, Number(args?.k || 6) || 6));
  const locale = String(args?.locale || 'en-US').trim().toLowerCase();
  const currency = String(args?.currency || product.currency || 'USD').trim().toUpperCase();
  const bypass = Boolean(
    args?.options?.no_cache || args?.options?.cache_bypass || args?.options?.bypass_cache,
  );
  return `${merchantId}::${productId}::${limit}::${locale}::${currency}::${bypass ? '1' : '0'}`;
}

function trimOldestInflightEntries(map, maxEntries) {
  while (map.size >= maxEntries) {
    const firstKey = map.keys().next().value;
    if (!firstKey) break;
    map.delete(firstKey);
  }
}

function parseNullableProductPrice(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeProductDetailPrice(product) {
  if (!product || typeof product !== 'object') return product;
  const normalized = { ...product };

  let resolvedPrice = parseNullableProductPrice(normalized.price);
  if (resolvedPrice === null && Array.isArray(normalized.variants)) {
    for (const variant of normalized.variants) {
      if (!variant || typeof variant !== 'object') continue;
      const candidate =
        parseNullableProductPrice(variant.price) ??
        parseNullableProductPrice(variant.price_amount) ??
        parseNullableProductPrice(variant.amount) ??
        parseNullableProductPrice(variant.value);
      if (candidate !== null) {
        resolvedPrice = candidate;
        break;
      }
    }
  }

  normalized.price = resolvedPrice;
  return normalized;
}

async function fetchProductDetailFromProductsCache(args) {
  if (!process.env.DATABASE_URL) return null;
  const merchantId = String(args?.merchantId || '').trim();
  const productId = String(args?.productId || '').trim();
  if (!merchantId || !productId) return null;
  const includeExpired = args?.includeExpired === true;
  const staleMaxAgeHours = Math.max(
    1,
    Math.min(
      24 * 90,
      Number.isFinite(Number(args?.staleMaxAgeHours))
        ? Number(args?.staleMaxAgeHours)
        : PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
    ),
  );

  try {
    const fetchFresh = async () => {
      const res = await query(
        `
          SELECT product_data, cached_at
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND (
              platform_product_id = $2
              OR product_data->>'id' = $2
              OR product_data->>'product_id' = $2
              OR product_data->>'productId' = $2
            )
          ORDER BY cached_at DESC
          LIMIT 1
        `,
        [merchantId, productId],
      );
      return res?.rows && res.rows[0] ? res.rows[0] : null;
    };

    const fetchStale = async () => {
      if (!PRODUCT_DETAIL_STALE_LOOKUP_ENABLED) return null;
      const res = await query(
        `
          SELECT product_data, cached_at
          FROM products_cache
          WHERE merchant_id = $1
            AND (cached_at IS NULL OR cached_at >= now() - ($3 * interval '1 hour'))
            AND (
              platform_product_id = $2
              OR product_data->>'id' = $2
              OR product_data->>'product_id' = $2
              OR product_data->>'productId' = $2
            )
          ORDER BY cached_at DESC
          LIMIT 1
        `,
        [merchantId, productId, staleMaxAgeHours],
      );
      return res?.rows && res.rows[0] ? res.rows[0] : null;
    };

    let row = await fetchFresh();
    let staleFallbackUsed = false;
    if (!row && includeExpired) {
      row = await fetchStale();
      staleFallbackUsed = Boolean(row);
    }

    const productData = row?.product_data;
    if (!productData || typeof productData !== 'object') return null;

    const normalized = {
      ...productData,
      merchant_id: merchantId,
      product_id: String(productData.product_id || productData.id || productId).trim() || productId,
    };
    const withPrice = normalizeProductDetailPrice(normalized);
    return {
      product: withPrice,
      cached_at: row?.cached_at || null,
      stale_fallback_used: staleFallbackUsed,
      stale_max_age_hours: staleFallbackUsed ? staleMaxAgeHours : null,
    };
  } catch (err) {
    logger.warn(
      { err: err.message, merchantId, productId },
      'Failed to load product detail from products_cache',
    );
    return null;
  }
}

function attachProductDetailSource(product, detailSource) {
  if (!product || typeof product !== 'object') return product;
  const source = String(detailSource || '').trim();
  if (!source) return product;
  try {
    Object.defineProperty(product, '__detail_source', {
      value: source,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    product.__detail_source = source;
  }
  return product;
}

function inferDetailSourceFromQuerySource(querySource) {
  const source = String(querySource || '').trim().toLowerCase();
  if (!source) return null;
  if (source === 'products_cache') return 'fresh_cache';
  if (source === 'products_cache_stale') return 'stale_cache';
  if (source === 'upstream') return 'upstream';
  return null;
}

function getProductDetailSource(product) {
  if (!product || typeof product !== 'object') return null;
  const source = String(product.__detail_source || '').trim();
  return source || null;
}

async function fetchProductDetailForOffers(args) {
  const merchantId = String(args?.merchantId || '').trim();
  const productId = String(args?.productId || '').trim();
  const checkoutToken = args?.checkoutToken;
  if (!merchantId || !productId) return null;

  const cacheKey = JSON.stringify({
    merchantId,
    productId,
    hasCheckoutToken: Boolean(checkoutToken),
  });

  if (PRODUCT_DETAIL_CACHE_ENABLED) {
    const cachedEntry = getProductDetailCacheEntry(cacheKey);
    const cachedValue = cachedEntry?.value;
    const cachedProduct =
      cachedValue && typeof cachedValue === 'object'
        ? cachedValue.product || cachedValue?.data?.product
        : null;
    const cachedSource = inferDetailSourceFromQuerySource(cachedValue?.metadata?.query_source);
    if (cachedProduct && typeof cachedProduct === 'object') {
      return attachProductDetailSource(
        normalizeProductDetailPrice({
        ...cachedProduct,
        merchant_id: merchantId,
        product_id:
          String(cachedProduct.product_id || cachedProduct.id || productId).trim() ||
          productId,
        }),
        cachedSource || 'fresh_cache',
      );
    }
  }

  const inflight = PRODUCT_DETAIL_INFLIGHT.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const loadPromise = (async () => {
    if (process.env.DATABASE_URL) {
      const fromDb = await fetchProductDetailFromProductsCache({
        merchantId,
        productId,
        includeExpired: false,
      });
      if (fromDb?.product) {
        const normalizedDb = attachProductDetailSource(
          normalizeProductDetailPrice(fromDb.product),
          'fresh_cache',
        );
        if (PRODUCT_DETAIL_CACHE_ENABLED) {
          setProductDetailCache(cacheKey, {
            status: 'success',
            success: true,
            product: normalizedDb,
            metadata: {
              query_source: 'products_cache',
              cached_at: fromDb.cached_at || null,
            },
          });
        }
        return normalizedDb;
      }
    }

    let upstreamProduct = null;
    try {
      upstreamProduct = await fetchLegacyProductDetailFromUpstream({
        merchantId,
        productId,
        checkoutToken,
      });
    } catch {
      upstreamProduct = null;
    }

    if (upstreamProduct && typeof upstreamProduct === 'object') {
      const normalizedUpstream = attachProductDetailSource(
        normalizeProductDetailPrice({
          ...upstreamProduct,
          merchant_id: merchantId,
          product_id:
            String(upstreamProduct.product_id || upstreamProduct.id || productId).trim() ||
            productId,
        }),
        'upstream',
      );

      if (PRODUCT_DETAIL_CACHE_ENABLED) {
        setProductDetailCache(cacheKey, {
          status: 'success',
          success: true,
          product: normalizedUpstream,
          metadata: { query_source: 'upstream' },
        });
      }
      return normalizedUpstream;
    }

    if (process.env.DATABASE_URL && PRODUCT_DETAIL_STALE_LOOKUP_ENABLED) {
      const staleFromDb = await fetchProductDetailFromProductsCache({
        merchantId,
        productId,
        includeExpired: true,
        staleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
      });
      if (staleFromDb?.product) {
        const normalizedStale = attachProductDetailSource(
          normalizeProductDetailPrice(staleFromDb.product),
          'stale_cache',
        );
        if (PRODUCT_DETAIL_CACHE_ENABLED) {
          setProductDetailCache(cacheKey, {
            status: 'success',
            success: true,
            product: normalizedStale,
            metadata: {
              query_source: 'products_cache_stale',
              cached_at: staleFromDb.cached_at || null,
              stale_max_age_hours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
            },
          });
        }
        return normalizedStale;
      }
    }

    return null;
  })();

  PRODUCT_DETAIL_INFLIGHT.set(cacheKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    PRODUCT_DETAIL_INFLIGHT.delete(cacheKey);
  }
}

async function resolveProductGroupCached(args) {
  const productId = String(args?.productId || '').trim();
  const merchantId = String(args?.merchantId || '').trim() || null;
  const platform = args?.platform ? String(args.platform).trim() : null;
  const checkoutToken = args?.checkoutToken;
  const bypassCache = args?.bypassCache === true;
  const debug = args?.debug === true;

  if (!productId) return null;

  const cacheKey = JSON.stringify({
    productId,
    merchantId,
    platform,
    hasCheckoutToken: Boolean(checkoutToken),
  });
  const cacheEnabled = RESOLVE_PRODUCT_GROUP_CACHE_ENABLED && !bypassCache;
  if (!cacheEnabled) RESOLVE_PRODUCT_GROUP_CACHE_METRICS.bypasses += 1;
  const cachedEntry = cacheEnabled ? getResolveProductGroupCacheEntry(cacheKey) : null;
  if (cachedEntry?.value) {
    const ageMs =
      typeof cachedEntry.storedAtMs === 'number'
        ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
        : 0;
    return debug
      ? {
          ...cachedEntry.value,
          cache: { hit: true, age_ms: ageMs, ttl_ms: RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS },
        }
      : cachedEntry.value;
  }

  const resolvedGroup = merchantId
    ? await resolveProductGroupFromUpstream({
        merchantId,
        productId,
        platform,
        checkoutToken,
      })
    : await resolveProductGroupByProductIdFromUpstream({
        productId,
        platform,
        checkoutToken,
      });

  const productGroupIdRaw =
    resolvedGroup?.product_group_id || resolvedGroup?.productGroupId || null;
  const productGroupId =
    typeof productGroupIdRaw === 'string' && productGroupIdRaw.trim()
      ? productGroupIdRaw.trim()
      : null;
  const membersRaw = Array.isArray(resolvedGroup?.members) ? resolvedGroup.members : [];
  const members = membersRaw
    .map((m) => ({
      merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
      merchant_name: m?.merchant_name || m?.merchantName || undefined,
      product_id: String(m?.product_id || m?.productId || '').trim(),
      platform: m?.platform ? String(m.platform).trim() : undefined,
      is_primary: Boolean(m?.is_primary || m?.isPrimary),
    }))
    .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));

  const canonicalMember = members.find((m) => m.is_primary) || members[0] || null;

  const result = {
    status: 'success',
    ...(productGroupId ? { product_group_id: productGroupId } : {}),
    canonical_product_ref: canonicalMember
      ? {
          merchant_id: canonicalMember.merchant_id,
          product_id: canonicalMember.product_id,
          ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
        }
      : null,
    members,
  };

  if (cacheEnabled) setResolveProductGroupCache(cacheKey, result);
  return debug
    ? { ...result, cache: { hit: false, age_ms: 0, ttl_ms: RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS } }
    : result;
}

function normalizeOfferMoney(amount, currency) {
  const raw = amount;
  let normalizedAmount = 0;
  let normalizedCurrency = String(currency || 'USD').toUpperCase() || 'USD';

  if (typeof raw === 'number') {
    normalizedAmount = raw;
  } else if (typeof raw === 'string') {
    normalizedAmount = Number(raw) || 0;
  } else if (raw && typeof raw === 'object') {
    const obj = raw;
    const candidateAmount =
      obj.amount ??
      obj.current?.amount ??
      obj.price ??
      obj.value ??
      null;
    if (typeof candidateAmount === 'number') normalizedAmount = candidateAmount;
    else if (typeof candidateAmount === 'string') normalizedAmount = Number(candidateAmount) || 0;

    const candidateCurrency =
      obj.currency ??
      obj.current?.currency ??
      obj.currency_code ??
      null;
    if (typeof candidateCurrency === 'string' && candidateCurrency.trim()) {
      normalizedCurrency = candidateCurrency.trim().toUpperCase();
    }
  }

  return {
    amount: Number(normalizedAmount) || 0,
    currency: normalizedCurrency,
  };
}

function computeOfferTotal(offer) {
  return Number(offer?.price?.amount || 0) + Number(offer?.shipping?.cost?.amount || 0);
}

async function buildOffersFromGroupMembers(args) {
  const productGroupId = args?.productGroupId ? String(args.productGroupId).trim() : null;
  const groupMembers = Array.isArray(args?.members) ? args.members : [];
  const checkoutToken = args?.checkoutToken;
  const limit = Math.min(Math.max(1, Number(args?.limit || groupMembers.length || 10) || 10), 50);
  const preferredMerchantId = args?.preferredMerchantId ? String(args.preferredMerchantId).trim() : null;

  if (!groupMembers.length) return null;

  const members = groupMembers
    .map((m) => ({
      merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
      merchant_name: m?.merchant_name || m?.merchantName || undefined,
      product_id: String(m?.product_id || m?.productId || '').trim(),
      platform: m?.platform ? String(m.platform).trim() : undefined,
      is_primary: Boolean(m?.is_primary || m?.isPrimary),
    }))
    .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id))
    .slice(0, limit);

  const canonicalMember = members.find((m) => m.is_primary) || members[0] || null;
  const canonicalProductRef = canonicalMember
    ? {
        merchant_id: canonicalMember.merchant_id,
        product_id: canonicalMember.product_id,
        ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
      }
    : null;

  const merchantNameById = new Map(
    members
      .map((m) => [String(m.merchant_id || '').trim(), m.merchant_name])
      .filter(([mid]) => Boolean(mid)),
  );

  const fetched = [];
  const chunkSize = 4;
  for (let i = 0; i < members.length; i += chunkSize) {
    const chunk = members.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      chunk.map(async (m) =>
        fetchProductDetailForOffers({
          merchantId: m.merchant_id,
          productId: m.product_id,
          checkoutToken,
        }).catch(() => null),
      ),
    );
    fetched.push(...results);
  }

  const products = fetched.filter(Boolean);
  if (!products.length) return null;

  const resolvedProductGroupId =
    productGroupId ||
    (canonicalProductRef?.platform
      ? buildProductGroupId({
          platform: String(canonicalProductRef.platform || '').trim(),
          platform_product_id: String(
            products[0]?.platform_product_id || products[0]?.platformProductId || '',
          ).trim(),
        })
      : null) ||
    (products[0]?.platform
      ? buildProductGroupId({
          platform: String(products[0].platform || '').trim(),
          platform_product_id: String(products[0].platform_product_id || products[0].platformProductId || '').trim(),
        })
      : null) ||
    `pg:pid:${String(canonicalProductRef?.product_id || products[0]?.product_id || products[0]?.id || '').trim()}`;

  const offers = products.map((p) => {
    const mid = String(p.merchant_id || '').trim();
    const offerProductId = String(p.product_id || '').trim() || undefined;
    const currency = p.currency || 'USD';
    const shipCost = p.shipping?.cost || p.shipping_cost || null;
    const shipCostAmount =
      shipCost == null
        ? undefined
        : Number(typeof shipCost === 'object' ? shipCost.amount : shipCost);
    const shipCostCurrency =
      shipCost && typeof shipCost === 'object'
        ? String(shipCost.currency || currency)
        : currency;
    const etaRaw = p.shipping?.eta_days_range || p.shipping?.etaDaysRange || null;
    const etaRange =
      Array.isArray(etaRaw) && etaRaw.length >= 2
        ? [Number(etaRaw[0]) || 0, Number(etaRaw[1]) || 0]
        : undefined;

    return {
      offer_id:
        buildOfferId({
          merchant_id: mid,
          product_group_id: resolvedProductGroupId,
          fulfillment_type: p.fulfillment_type || 'merchant',
          tier: 'default',
        }) ||
        `of:v1:${mid}:${resolvedProductGroupId}:${p.fulfillment_type || 'merchant'}:default`,
      product_group_id: resolvedProductGroupId,
      product_id: offerProductId,
      merchant_id: mid,
      merchant_name:
        p.merchant_name ||
        p.store_name ||
        merchantNameById.get(mid) ||
        undefined,
      price: normalizeOfferMoney(p.price, currency),
      shipping:
        p.shipping || etaRange || shipCostAmount != null
          ? {
              method_label: p.shipping?.method_label || p.shipping?.methodLabel || undefined,
              eta_days_range: etaRange,
              ...(shipCostAmount != null && Number.isFinite(shipCostAmount)
                ? { cost: normalizeOfferMoney(shipCostAmount, shipCostCurrency) }
                : {}),
            }
          : undefined,
      returns: p.returns || undefined,
      inventory: {
        in_stock: typeof p.in_stock === 'boolean' ? p.in_stock : undefined,
      },
      fulfillment_type: p.fulfillment_type || undefined,
      risk_tier: 'standard',
    };
  });

  const sortedByTotal = [...offers].sort((a, b) => computeOfferTotal(a) - computeOfferTotal(b));
  const bestPriceOfferId = sortedByTotal[0]?.offer_id || null;
  const preferredOfferId = preferredMerchantId
    ? offers.find((o) => o.merchant_id === preferredMerchantId)?.offer_id || null
    : null;
  const defaultOfferId = preferredOfferId || bestPriceOfferId;

  return {
    status: 'success',
    product_group_id: resolvedProductGroupId,
    canonical_product_ref: canonicalProductRef,
    offers_count: offers.length,
    offers,
    default_offer_id: defaultOfferId,
    best_price_offer_id: bestPriceOfferId,
  };
}

// --- Currency helpers (Creator cache surfaces) ---
// Creator feeds/search can be served directly from products_cache for speed.
// For Shopify stores, product_data prices are in the shop currency, but some
// legacy cache rows can have currency mislabeled as USD. Fix labels in-flight
// using shop.json, cached per merchant to avoid repeated Shopify calls.
const SHOPIFY_MERCHANT_CURRENCY_CACHE = new Map(); // merchant_id -> { currency, expiresAtMs }
const SHOPIFY_MERCHANT_CURRENCY_TTL_MS = 6 * 60 * 60 * 1000;
const SHOPIFY_MERCHANT_CURRENCY_NEG_TTL_MS = 10 * 60 * 1000;

function getCachedShopifyMerchantCurrency(merchantId) {
  const mid = String(merchantId || '').trim();
  if (!mid) return null;
  const hit = SHOPIFY_MERCHANT_CURRENCY_CACHE.get(mid);
  if (!hit) return null;
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    SHOPIFY_MERCHANT_CURRENCY_CACHE.delete(mid);
    return null;
  }
  return hit.currency || null;
}

function setCachedShopifyMerchantCurrency(merchantId, currency, ttlMs = SHOPIFY_MERCHANT_CURRENCY_TTL_MS) {
  const mid = String(merchantId || '').trim();
  const cur = String(currency || '').trim().toUpperCase();
  if (!mid) return;
  SHOPIFY_MERCHANT_CURRENCY_CACHE.set(mid, {
    currency: cur || null,
    expiresAtMs: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : SHOPIFY_MERCHANT_CURRENCY_TTL_MS),
  });
}

function parseShopifyAccessToken(apiKeyRaw) {
  if (!apiKeyRaw) return '';
  const raw = String(apiKeyRaw).trim();
  if (!raw) return '';
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const token = parsed.access_token || parsed.token || '';
      return String(token || '').trim();
    }
  } catch (_) {
    // ignore
  }
  return raw;
}

async function fetchShopifyMerchantCurrency(merchantId) {
  const cached = getCachedShopifyMerchantCurrency(merchantId);
  if (cached) return cached;

  if (!process.env.DATABASE_URL) return null;

  const mid = String(merchantId || '').trim();
  if (!mid) return null;

  let storeRow;
  try {
    const res = await query(
      `
        SELECT domain, api_key
        FROM merchant_stores
        WHERE merchant_id = $1
          AND platform = 'shopify'
          AND status IN ('active', 'connected')
        ORDER BY connected_at DESC NULLS LAST
        LIMIT 1
      `,
      [mid],
    );
    storeRow = res.rows && res.rows[0] ? res.rows[0] : null;
  } catch (err) {
    logger.warn({ err: err.message, merchantId: mid }, 'Failed to query merchant_stores for Shopify currency');
    return null;
  }

  const domain = storeRow && storeRow.domain ? String(storeRow.domain).trim() : '';
  const accessToken = parseShopifyAccessToken(storeRow && storeRow.api_key ? storeRow.api_key : '');

  if (!domain || !accessToken) {
    setCachedShopifyMerchantCurrency(mid, null, SHOPIFY_MERCHANT_CURRENCY_NEG_TTL_MS);
    return null;
  }

  try {
    const url = `https://${domain}/admin/api/2024-07/shop.json`;
    const resp = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
      validateStatus: () => true,
    });

    if (resp.status !== 200) {
      setCachedShopifyMerchantCurrency(mid, null, SHOPIFY_MERCHANT_CURRENCY_NEG_TTL_MS);
      return null;
    }

    const cur = String(resp.data && resp.data.shop && resp.data.shop.currency ? resp.data.shop.currency : '')
      .trim()
      .toUpperCase();
    if (!cur) {
      setCachedShopifyMerchantCurrency(mid, null, SHOPIFY_MERCHANT_CURRENCY_NEG_TTL_MS);
      return null;
    }

    setCachedShopifyMerchantCurrency(mid, cur, SHOPIFY_MERCHANT_CURRENCY_TTL_MS);
    return cur;
  } catch (err) {
    logger.warn({ err: err.message, merchantId: mid }, 'Failed to fetch Shopify shop currency');
    setCachedShopifyMerchantCurrency(mid, null, SHOPIFY_MERCHANT_CURRENCY_NEG_TTL_MS);
    return null;
  }
}

async function applyShopifyCurrencyOverride(products) {
  if (!Array.isArray(products) || products.length === 0) return products;

  const merchantIds = new Set();
  for (const p of products) {
    if (!p) continue;
    const platform = String(p.platform || '').toLowerCase();
    if (platform !== 'shopify') continue;
    const cur = String(p.currency || '').trim().toUpperCase();
    // Only bother when the label is missing or looks like a legacy USD default.
    if (cur && cur !== 'USD') continue;
    const mid = String(p.merchant_id || p.merchantId || '').trim();
    if (mid) merchantIds.add(mid);
  }

  if (merchantIds.size === 0) return products;

  const mids = Array.from(merchantIds);
  const currencies = await Promise.all(mids.map((mid) => fetchShopifyMerchantCurrency(mid)));
  const currencyByMerchant = new Map();
  mids.forEach((mid, idx) => {
    const cur = currencies[idx];
    if (cur) currencyByMerchant.set(mid, cur);
  });

  if (currencyByMerchant.size === 0) return products;

  for (const p of products) {
    if (!p) continue;
    const platform = String(p.platform || '').toLowerCase();
    if (platform !== 'shopify') continue;
    const mid = String(p.merchant_id || p.merchantId || '').trim();
    const cur = currencyByMerchant.get(mid);
    if (!cur) continue;
    p.currency = cur;
  }

  return products;
}

async function probeCreatorCacheDbStats(merchantIds, intentTarget = 'unknown', options = {}) {
  const force = options && options.force === true;
  if (!force && !ROUTE_DEBUG_ENABLED) return null;
  if (!process.env.DATABASE_URL) return { db_configured: false };
  if (!Array.isArray(merchantIds) || merchantIds.length === 0) return { db_configured: true, merchant_ids_count: 0 };

  const baseWhere = `
    merchant_id = ANY($1)
    AND (expires_at IS NULL OR expires_at > now())
    AND ${buildSellableStatusPredicate("product_data->>'status'")}
    AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
  `;

  const pet = buildPetSignalSql(2);
  const petWhere = intentTarget === 'pet' ? ` AND ${pet.sql}` : '';
  const petParams = intentTarget === 'pet' ? pet.params : [];

  try {
    const [allRes, sellableRes, petRes, embRes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM products_cache WHERE merchant_id = ANY($1)`, [merchantIds]),
      query(`SELECT COUNT(*)::int AS c FROM products_cache WHERE ${baseWhere}`, [merchantIds]),
      intentTarget === 'pet'
        ? query(
            `SELECT COUNT(*)::int AS c FROM products_cache WHERE ${baseWhere}${petWhere}`,
            [merchantIds, ...petParams],
          )
        : Promise.resolve({ rows: [{ c: null }] }),
      query(
        `SELECT COUNT(*)::int AS c FROM products_cache_embeddings_fallback WHERE merchant_id = ANY($1)`,
        [merchantIds],
      ),
    ]);

    return {
      db_configured: true,
      merchant_ids_count: merchantIds.length,
      products_cache_total: Number(allRes.rows?.[0]?.c || 0),
      products_cache_sellable_total: Number(sellableRes.rows?.[0]?.c || 0),
      products_cache_pet_signal_sellable_total:
        intentTarget === 'pet' ? Number(petRes.rows?.[0]?.c || 0) : null,
      embeddings_fallback_total: Number(embRes.rows?.[0]?.c || 0),
    };
  } catch (err) {
    return {
      db_configured: true,
      merchant_ids_count: merchantIds.length,
      error: String(err && err.message ? err.message : err),
    };
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getCreatorCatalogMerchantIds() {
  const all = [];
  for (const cfg of CREATOR_CONFIGS || []) {
    if (Array.isArray(cfg.merchantIds)) {
      for (const mid of cfg.merchantIds) all.push(mid);
    }
  }
  return uniqueStrings(all);
}

function getCatalogSyncMerchantIdsFromEnv() {
  const raw = String(
    process.env.CATALOG_SYNC_MERCHANT_IDS ||
      process.env.CREATOR_CATALOG_MERCHANT_IDS ||
      '',
  ).trim();
  if (!raw) return [];
  return uniqueStrings(raw.split(','));
}

async function discoverCatalogSyncMerchantIdsFromDb(limit = 5000) {
  if (!process.env.DATABASE_URL) return { merchantIds: [], source: 'db_not_configured' };
  const normalizedLimit = Math.min(Math.max(1, Number(limit || 5000)), 5000);
  const allowRelaxedFallback =
    String(process.env.CATALOG_SYNC_DISCOVERY_RELAXED || '').trim().toLowerCase() === 'true';

  try {
    const shopifyStoresRes = await query(
      `
        SELECT DISTINCT merchant_id
        FROM merchant_stores
        WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
          AND lower(COALESCE(platform, '')) = 'shopify'
          AND lower(COALESCE(status, '')) = 'active'
          AND COALESCE(NULLIF(trim(domain), ''), '') <> ''
          AND COALESCE(NULLIF(trim(api_key), ''), '') <> ''
        ORDER BY merchant_id ASC
        LIMIT $1
      `,
      [normalizedLimit],
    );
    const shopifyStoreMerchantIds = uniqueStrings(
      (shopifyStoresRes.rows || []).map((row) => row?.merchant_id),
    );
    if (shopifyStoreMerchantIds.length) {
      return { merchantIds: shopifyStoreMerchantIds, source: 'merchant_stores_shopify_active' };
    }
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err) },
      'Catalog sync merchant discovery via merchant_stores failed',
    );
  }

  if (!allowRelaxedFallback) {
    return { merchantIds: [], source: 'merchant_stores_empty' };
  }

  try {
    const onboardingRes = await query(
      `
        SELECT DISTINCT merchant_id
        FROM merchant_onboarding
        WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
          AND lower(COALESCE(status, '')) = 'approved'
          AND COALESCE(psp_connected, false) = true
        ORDER BY merchant_id ASC
        LIMIT $1
      `,
      [normalizedLimit],
    );
    const onboardingMerchantIds = uniqueStrings(
      (onboardingRes.rows || []).map((row) => row?.merchant_id),
    );
    if (onboardingMerchantIds.length) {
      return { merchantIds: onboardingMerchantIds, source: 'merchant_onboarding_relaxed' };
    }
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err) },
      'Catalog sync merchant discovery via merchant_onboarding failed in relaxed mode',
    );
  }

  try {
    const cacheRes = await query(
      `
        SELECT DISTINCT merchant_id
        FROM products_cache
        WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
          AND merchant_id <> 'external_seed'
        ORDER BY merchant_id ASC
        LIMIT $1
      `,
      [normalizedLimit],
    );
    const cacheMerchantIds = uniqueStrings(
      (cacheRes.rows || []).map((row) => row?.merchant_id),
    );
    if (cacheMerchantIds.length) {
      return { merchantIds: cacheMerchantIds, source: 'products_cache_relaxed' };
    }
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err) },
      'Catalog sync merchant discovery via products_cache failed in relaxed mode',
    );
  }

  return { merchantIds: [], source: 'db_empty_relaxed' };
}

async function resolveCatalogSyncMerchantIds() {
  const envMerchantIds = getCatalogSyncMerchantIdsFromEnv();
  if (envMerchantIds.length) {
    return { merchantIds: envMerchantIds, source: 'env' };
  }

  const discovered = await discoverCatalogSyncMerchantIdsFromDb();
  if (discovered.merchantIds.length) return discovered;

  const creatorMerchantIds = getCreatorCatalogMerchantIds();
  if (creatorMerchantIds.length) {
    return { merchantIds: creatorMerchantIds, source: 'creator_configs_fallback' };
  }

  return { merchantIds: [], source: discovered.source || 'none' };
}

const catalogSyncState = {
  last_run_at: null,
  last_success_at: null,
  last_error: null,
  per_merchant: {},
  target_source: null,
  target_count: 0,
  target_eligible_count: 0,
  target_suppressed_count: 0,
  target_sample: [],
  target_suppressed_sample: [],
};

function isCatalogSyncRetryableError(err) {
  const status = Number(err?.response?.status || 0);
  if (status === 429 || status >= 500) return true;

  const code = String(err?.code || '').trim().toUpperCase();
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const message = String(err?.message || '').trim().toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

function isCatalogSyncNonRetryableError(err) {
  const status = Number(err?.response?.status || 0);
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;

  const detailStatus = Number(
    err?.response?.data?.status ||
      err?.response?.data?.error?.status ||
      err?.response?.data?.detail?.status ||
      0,
  );
  if (detailStatus === 400 || detailStatus === 401 || detailStatus === 403 || detailStatus === 404) {
    return true;
  }

  const code = String(err?.code || '').trim().toUpperCase();
  if (code === 'ENOTFOUND') return true;

  const message = String(
    err?.response?.data?.detail?.message ||
      err?.response?.data?.detail ||
      err?.response?.data?.error?.message ||
      err?.message ||
      '',
  )
    .trim()
    .toLowerCase();
  if (!message) return false;
  if (message.includes('shopify api error: 404')) return true;
  if (message.includes('\"errors\":\"not found\"')) return true;
  if (message.includes("errors':'not found")) return true;
  if (message.includes('shopify') && message.includes('not found')) return true;
  return false;
}

function isCatalogSyncInvalidMerchantError(err) {
  const status = Number(err?.response?.status || 0);
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;

  const detailStatus = Number(
    err?.response?.data?.status ||
      err?.response?.data?.error?.status ||
      err?.response?.data?.detail?.status ||
      0,
  );
  if (detailStatus === 400 || detailStatus === 401 || detailStatus === 403 || detailStatus === 404) {
    return true;
  }

  const message = String(
    err?.response?.data?.detail?.message ||
      err?.response?.data?.detail ||
      err?.response?.data?.error?.message ||
      err?.message ||
      '',
  )
    .trim()
    .toLowerCase();
  if (!message) return false;
  if (message.includes('shopify api error: 404')) return true;
  if (message.includes('\"errors\":\"not found\"')) return true;
  if (message.includes("errors':'not found")) return true;
  if (message.includes('shopify') && message.includes('not found')) return true;
  if (message.includes('invalid api key')) return true;
  if (message.includes('access denied')) return true;
  if (message.includes('unauthorized')) return true;
  if (message.includes('forbidden')) return true;
  return false;
}

function isCatalogSyncTimeoutError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  const message = String(err?.message || '').trim().toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

function getCatalogSyncAttemptTimeoutMs({ merchantState, attempt }) {
  const timeoutStreak = Math.max(0, Number(merchantState?.timeout_streak || 0));
  const attemptIndex = Math.max(0, Number(attempt || 1) - 1);
  const growth = Math.min(timeoutStreak + attemptIndex, 3);
  const multiplier = Math.pow(2, growth);
  const baseTimeoutMs = Number(CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS || 0);
  const maxTimeoutMs = Number(CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS || baseTimeoutMs);
  return Math.max(
    baseTimeoutMs,
    Math.min(maxTimeoutMs, Math.floor(baseTimeoutMs * multiplier)),
  );
}

function getCatalogSyncSuppressionStatus(merchantId, nowMs = Date.now()) {
  const state = catalogSyncState.per_merchant[merchantId];
  const blockedUntilMs = Number(state?.blocked_until_ms || 0);
  if (!blockedUntilMs || blockedUntilMs <= nowMs) {
    return {
      suppressed: false,
      reason: null,
      blocked_until: null,
      invalid_merchant: false,
    };
  }
  return {
    suppressed: true,
    reason: state?.invalid_merchant ? 'invalid_merchant_cooldown' : 'non_retryable_cooldown',
    blocked_until: state?.blocked_until || new Date(blockedUntilMs).toISOString(),
    invalid_merchant: state?.invalid_merchant === true,
  };
}

function summarizeCatalogSyncMerchantState() {
  const rows = Object.entries(catalogSyncState.per_merchant || {}).map(([merchantId, state]) => ({
    merchant_id: merchantId,
    ok: state?.ok === true,
    skipped: state?.skipped === true,
    invalid_merchant: state?.invalid_merchant === true,
    status: Number.isFinite(Number(state?.status)) ? Number(state.status) : null,
    attempts: Number.isFinite(Number(state?.attempts)) ? Number(state.attempts) : null,
    timeout_streak: Number.isFinite(Number(state?.timeout_streak)) ? Number(state.timeout_streak) : 0,
    last_run_at: state?.last_run_at || null,
    blocked_until: state?.blocked_until || null,
    error: state?.error ? String(state.error) : null,
  }));
  rows.sort((a, b) => {
    const ta = Date.parse(String(a.last_run_at || '')) || 0;
    const tb = Date.parse(String(b.last_run_at || '')) || 0;
    return tb - ta;
  });
  return rows.slice(0, 20);
}

async function runCreatorCatalogAutoSync() {
  const enabled = CREATOR_CATALOG_AUTO_SYNC_ENABLED;
  if (!enabled) return;
  if (!PIVOTA_API_BASE) return;

  const adminKey = process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY || ADMIN_API_KEY;
  if (!adminKey) {
    logger.warn('CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no admin key is configured');
    return;
  }

  const merchantTarget = await resolveCatalogSyncMerchantIds();
  const resolvedMerchantIds = merchantTarget.merchantIds;
  const nowMs = Date.now();
  const merchantIds = [];
  const suppressedMerchants = [];
  for (const merchantId of resolvedMerchantIds) {
    const suppression = getCatalogSyncSuppressionStatus(merchantId, nowMs);
    if (!suppression.suppressed) {
      merchantIds.push(merchantId);
      continue;
    }
    const existingState = catalogSyncState.per_merchant[merchantId];
    catalogSyncState.per_merchant[merchantId] = {
      ...(existingState && typeof existingState === 'object' ? existingState : {}),
      ok: false,
      skipped: true,
      last_run_at: new Date().toISOString(),
      status: Number.isFinite(Number(existingState?.status)) ? Number(existingState.status) : null,
      attempts: 0,
      duration_ms: 0,
      invalid_merchant: existingState?.invalid_merchant === true,
      error:
        existingState?.error ||
        'Skipped due to temporary cooldown after non-retryable sync error',
      blocked_until_ms: Number(existingState?.blocked_until_ms || 0) || null,
      blocked_until: suppression.blocked_until,
    };
    suppressedMerchants.push({
      merchant_id: merchantId,
      reason: suppression.reason,
      blocked_until: suppression.blocked_until,
      invalid_merchant: suppression.invalid_merchant,
    });
  }
  catalogSyncState.target_source = merchantTarget.source || null;
  catalogSyncState.target_count = resolvedMerchantIds.length;
  catalogSyncState.target_eligible_count = merchantIds.length;
  catalogSyncState.target_suppressed_count = suppressedMerchants.length;
  catalogSyncState.target_sample = resolvedMerchantIds.slice(0, 20);
  catalogSyncState.target_suppressed_sample = suppressedMerchants.slice(0, 20);
  if (!merchantIds.length) {
    logger.warn(
      {
        target_source: merchantTarget.source || null,
        target_count: resolvedMerchantIds.length,
        suppressed_count: suppressedMerchants.length,
      },
      'CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no sync target merchants were resolved',
    );
    return;
  }

  const limit = Math.min(
    Number(process.env.CREATOR_CATALOG_AUTO_SYNC_LIMIT || 200) || 200,
    5000,
  );
  const ttlSeconds = CREATOR_CATALOG_CACHE_TTL_SECONDS;
  const maxAttempts = Math.max(1, Number(CREATOR_CATALOG_AUTO_SYNC_RETRIES || 0) + 1);

  catalogSyncState.last_run_at = new Date().toISOString();
  catalogSyncState.last_error = null;

  for (const merchantId of merchantIds) {
    const existingState = catalogSyncState.per_merchant[merchantId];
    const url = `${PIVOTA_API_BASE}/agent/internal/shopify/products/sync/${encodeURIComponent(
      merchantId,
    )}?limit=${encodeURIComponent(String(limit))}&ttl_seconds=${encodeURIComponent(String(ttlSeconds))}`;
    const startedAtMs = Date.now();
    let attempt = 0;
    let res = null;
    let err = null;
    let timeoutUsedMs = CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS;
    for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
      timeoutUsedMs = getCatalogSyncAttemptTimeoutMs({
        merchantState: existingState,
        attempt,
      });
      try {
        res = await axios.post(url, null, {
          headers: { 'X-ADMIN-KEY': adminKey },
          timeout: timeoutUsedMs,
        });
        err = null;
        break;
      } catch (attemptErr) {
        err = attemptErr;
        const retryable = isCatalogSyncRetryableError(attemptErr);
        const nonRetryable = isCatalogSyncNonRetryableError(attemptErr);
        if (attempt < maxAttempts && retryable && !nonRetryable) {
          const delayMs = Math.min(
            CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1),
            30000,
          );
          logger.warn(
            {
              merchantId,
              attempt,
              max_attempts: maxAttempts,
              retry_in_ms: delayMs,
              timeout_ms: timeoutUsedMs,
              status: attemptErr?.response?.status || null,
              code: attemptErr?.code || null,
              non_retryable: nonRetryable,
              error: attemptErr?.message || String(attemptErr),
            },
            'Creator catalog auto sync attempt failed; retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        break;
      }
    }

    if (!err && res) {
      catalogSyncState.per_merchant[merchantId] = {
        ok: true,
        skipped: false,
        last_run_at: new Date().toISOString(),
        attempts: attempt,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        summary: res.data && res.data.summary ? res.data.summary : res.data,
        status: Number.isFinite(Number(res.status)) ? Number(res.status) : 200,
        timeout_ms: timeoutUsedMs,
        timeout_streak: 0,
        invalid_merchant: false,
        error: null,
        blocked_until_ms: null,
        blocked_until: null,
      };
      catalogSyncState.last_success_at = new Date().toISOString();
      logger.info(
        {
          merchantId,
          limit,
          ttl_seconds: ttlSeconds,
          attempts: attempt,
          duration_ms: Math.max(0, Date.now() - startedAtMs),
          timeout_ms: timeoutUsedMs,
        },
        'Creator catalog auto sync succeeded',
      );
    } else if (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const message =
        (data && data.detail && typeof data.detail === 'object' && data.detail.message) ||
        (data && typeof data.detail === 'string' ? data.detail : null) ||
        err.message;
      const nonRetryable = isCatalogSyncNonRetryableError(err);
      const invalidMerchant = isCatalogSyncInvalidMerchantError(err);
      const timeoutError = isCatalogSyncTimeoutError(err);
      const previousTimeoutStreak = Math.max(0, Number(existingState?.timeout_streak || 0));
      const timeoutStreak = timeoutError ? Math.min(previousTimeoutStreak + 1, 10) : 0;
      const blockedUntilMs = nonRetryable
        ? Date.now() +
          (invalidMerchant
            ? CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS
            : CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS) *
            1000
        : null;
      catalogSyncState.per_merchant[merchantId] = {
        ok: false,
        skipped: false,
        last_run_at: new Date().toISOString(),
        attempts: attempt,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        status: status || null,
        timeout_ms: timeoutUsedMs,
        timeout_streak: timeoutStreak,
        invalid_merchant: invalidMerchant,
        error: message,
        blocked_until_ms: blockedUntilMs,
        blocked_until: blockedUntilMs ? new Date(blockedUntilMs).toISOString() : null,
      };
      catalogSyncState.last_error = `${merchantId}: ${message}`;
      logger.warn(
        {
          merchantId,
          status,
          message,
          attempts: attempt,
          timeout_ms: timeoutUsedMs,
          max_attempts: maxAttempts,
          timeout_streak: timeoutStreak,
          non_retryable: nonRetryable,
          invalid_merchant: invalidMerchant,
          blocked_until: blockedUntilMs ? new Date(blockedUntilMs).toISOString() : null,
        },
        'Creator catalog auto sync failed',
      );
    }
  }
}

// API Mode: MOCK (default), HYBRID, or REAL
// MOCK: Use internal mock data
// HYBRID: Real product search, mock payment
// REAL: All real API calls (requires API key)
// If API_MODE is not explicitly provided but an API key is configured,
// default to REAL so tests and production behave sensibly.
const API_MODE = process.env.API_MODE || (PIVOTA_API_KEY ? 'REAL' : 'MOCK');
const USE_MOCK = API_MODE === 'MOCK';
const USE_HYBRID = API_MODE === 'HYBRID';
const REAL_API_ENABLED = API_MODE === 'REAL' && Boolean(PIVOTA_API_KEY);

// Load tool schema once for chat endpoint.
const toolSchemaPath = path.join(__dirname, '..', 'docs', 'tool-schema.json');
const toolSchema = JSON.parse(fs.readFileSync(toolSchemaPath, 'utf-8'));

function buildQueryString(params) {
  const sp = new URLSearchParams();
  const entries = params && typeof params === 'object' ? Object.entries(params) : [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        sp.append(key, String(item));
      }
      continue;
    }
    sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

function normalizeAgentProductsListResponse(raw, ctx = {}) {
  if (!raw) return raw;

  const nowIso = new Date().toISOString();

  const getProducts = (obj) => {
    if (!obj) return [];
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.products)) return obj.products;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.results)) return obj.results;
    const data = obj.data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.products)) return data.products;
      if (Array.isArray(data.items)) return data.items;
      if (Array.isArray(data.results)) return data.results;
    }
    return [];
  };

  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const products = getProducts(raw);

  const totalRaw =
    base.total ??
    base.count ??
    base.total_count ??
    base.totalCount ??
    base.page_total ??
    base.pageTotal;
  const total = typeof totalRaw === 'number' ? totalRaw : products.length;

  const limitRaw = ctx.limit ?? base.limit ?? base.page_size ?? base.pageSize;
  const offsetRaw = ctx.offset ?? base.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  const page =
    Number.isFinite(limit) && limit > 0 && Number.isFinite(offset) && offset >= 0
      ? Math.floor(offset / limit) + 1
      : base.page || 1;

  const mergedMetadata =
    base.metadata && typeof base.metadata === 'object' && !Array.isArray(base.metadata)
      ? { ...base.metadata }
      : {};

  if (!mergedMetadata.query_source) mergedMetadata.query_source = 'agent_products_search';
  if (!mergedMetadata.fetched_at) mergedMetadata.fetched_at = nowIso;

  return {
    ...base,
    status: base.status || 'success',
    success: typeof base.success === 'boolean' ? base.success : true,
    products,
    total,
    page,
    page_size: typeof base.page_size === 'number' ? base.page_size : products.length,
    reply: base.reply ?? null,
    metadata: mergedMetadata,
  };
}

function withProxySearchFallbackMetadata(body, patch) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? { ...body.metadata }
      : {};
  metadata.proxy_search_fallback = {
    ...(metadata.proxy_search_fallback &&
    typeof metadata.proxy_search_fallback === 'object' &&
    !Array.isArray(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {}),
    ...patch,
  };
  return { ...body, metadata };
}

function buildSearchRouteHealth({
  primaryPathUsed,
  primaryLatencyMs,
  fallbackTriggered,
  fallbackReason,
  ambiguityScorePre = null,
  ambiguityScorePost = null,
  clarifyTriggered = false,
  degradeFlags = null,
}) {
  return {
    primary_path_used: String(primaryPathUsed || 'unknown'),
    primary_latency_ms: Math.max(0, Number(primaryLatencyMs || 0) || 0),
    fallback_triggered: Boolean(fallbackTriggered),
    fallback_reason: fallbackReason ? String(fallbackReason) : null,
    ambiguity_score_pre: Number.isFinite(Number(ambiguityScorePre))
      ? Math.max(0, Math.min(1, Number(ambiguityScorePre)))
      : null,
    ambiguity_score_post: Number.isFinite(Number(ambiguityScorePost))
      ? Math.max(0, Math.min(1, Number(ambiguityScorePost)))
      : null,
    clarify_triggered: Boolean(clarifyTriggered),
    degrade_flags:
      degradeFlags && typeof degradeFlags === 'object' && !Array.isArray(degradeFlags)
        ? {
            vector_skipped: Boolean(degradeFlags.vector_skipped),
            behavior_skipped: Boolean(degradeFlags.behavior_skipped),
            nlu_degraded: Boolean(degradeFlags.nlu_degraded),
          }
        : null,
  };
}

function buildSearchTrace({
  traceId,
  rawQuery,
  expandedQuery,
  expansionMode,
  intent,
  cacheStage,
  upstreamStage,
  resolverStage,
  finalDecision,
  queryClass = null,
  rewriteGate = null,
  associationPlan = null,
}) {
  return {
    trace_id: String(traceId || ''),
    raw_query: String(rawQuery || ''),
    expanded_query: String(expandedQuery || rawQuery || ''),
    expansion_mode: String(expansionMode || 'conservative'),
    query_class: queryClass ? String(queryClass) : null,
    rewrite_gate:
      rewriteGate && typeof rewriteGate === 'object' && !Array.isArray(rewriteGate)
        ? rewriteGate
        : null,
    association_plan:
      associationPlan && typeof associationPlan === 'object' && !Array.isArray(associationPlan)
        ? associationPlan
        : null,
    intent_domain: intent?.primary_domain || null,
    intent_target: intent?.target_object?.type || null,
    intent_scenario: intent?.scenario?.name || null,
    scenario: intent?.scenario?.name || null,
    cache_stage: cacheStage || null,
    upstream_stage: upstreamStage || null,
    resolver_stage: resolverStage || null,
    final_decision: String(finalDecision || 'unknown'),
  };
}

function classifyBeautyMixBucket(product) {
  const text = buildFallbackCandidateText(product);
  if (!text) return 'other';
  if (
    /\b(foundation|concealer|primer|powder|cushion|bb cream|cc cream)\b/i.test(text) ||
    /(粉底|遮瑕|妆前|妝前|定妆|定妝|气垫|氣墊)/.test(text)
  ) {
    return 'base_makeup';
  }
  if (
    /\b(eyeshadow|eye shadow|eyeliner|mascara|brow|eyebrow)\b/i.test(text) ||
    /(眼影|眼线|眼線|睫毛膏|眉笔|眉筆|眉粉)/.test(text)
  ) {
    return 'eye_makeup';
  }
  if (
    /\b(lipstick|lip gloss|lip tint|lip balm|lip liner)\b/i.test(text) ||
    /(口红|口紅|唇釉|唇膏|唇蜜|唇线|唇線)/.test(text)
  ) {
    return 'lip_makeup';
  }
  if (
    /\b(brush|brush set|puff|sponge|applicator|curler|tweezer|tool|tools)\b/i.test(text) ||
    /(化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|睫毛夹|睫毛夾|工具)/.test(text)
  ) {
    return 'tools';
  }
  if (
    /\b(toner|serum|essence|lotion|moisturizer|sunscreen|cleanser|cream)\b/i.test(text) ||
    /(化妆水|化妝水|精华|精華|乳液|面霜|防晒|防曬|洁面|潔面|面膜)/.test(text)
  ) {
    return 'skincare';
  }
  return 'other';
}

function buildCategoryMixTopN(products, topN = 10) {
  const list = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN) || 10)) : [];
  const buckets = {};
  for (const product of list) {
    const bucket = classifyBeautyMixBucket(product);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }
  return buckets;
}

function buildSearchRelevanceDebug({ intent, products, diversityPenaltyApplied = false }) {
  const domain = String(intent?.primary_domain || '');
  if (!domain) return null;
  const out = {
    intent_domain: intent?.primary_domain || null,
    intent_scenario: intent?.scenario?.name || null,
    diversity_penalty_applied: Boolean(diversityPenaltyApplied),
  };
  if (domain === 'beauty') {
    out.category_mix_topN = buildCategoryMixTopN(products, 10);
  } else {
    out.category_mix_topN = null;
  }
  return out;
}

function withSearchDiagnostics(body, diagnostics = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? { ...body.metadata }
      : {};

  if (diagnostics.route_health) metadata.route_health = diagnostics.route_health;
  if (diagnostics.search_trace) metadata.search_trace = diagnostics.search_trace;
  if (diagnostics.strict_empty != null) metadata.strict_empty = Boolean(diagnostics.strict_empty);
  if (diagnostics.strict_empty_reason) {
    metadata.strict_empty_reason = String(diagnostics.strict_empty_reason);
  }
  if (diagnostics.relevance_debug && typeof diagnostics.relevance_debug === 'object') {
    metadata.relevance_debug = diagnostics.relevance_debug;
  }
  if (diagnostics.fallback_strategy && typeof diagnostics.fallback_strategy === 'object') {
    metadata.fallback_strategy = diagnostics.fallback_strategy;
  }

  return {
    ...body,
    metadata,
  };
}

function withStrictEmptyFallback({
  body,
  queryParams,
  reason,
  upstreamStatus = null,
  upstreamCode = null,
  upstreamMessage = null,
  route = null,
}) {
  const emptyBody = buildProxySearchSoftFallbackResponse({
    queryParams,
    reason,
    upstreamStatus,
    upstreamCode,
    upstreamMessage,
    route,
  });
  return withSearchDiagnostics(emptyBody, {
    strict_empty: true,
    strict_empty_reason: reason || 'strict_empty',
  });
}

function buildProxySearchSoftFallbackResponse({
  queryParams,
  reason,
  upstreamStatus = null,
  upstreamCode = null,
  upstreamMessage = null,
  route = null,
  reply = 'Search is temporarily unavailable. Please retry shortly.',
}) {
  const normalized = normalizeAgentProductsListResponse(
    {
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: parseQueryNumber(queryParams?.limit ?? queryParams?.page_size) || 0,
      reply,
      metadata: {
        query_source: 'agent_products_error_fallback',
        upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
        upstream_error_code: upstreamCode ? String(upstreamCode) : null,
        upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
        fallback_route: route || null,
      },
    },
    {
      limit: queryParams?.limit,
      offset: queryParams?.offset,
    },
  );
  return withProxySearchFallbackMetadata(normalized, {
    applied: true,
    reason: reason || 'error_soft_fallback',
    route: route || null,
    upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
    upstream_error_code: upstreamCode ? String(upstreamCode) : null,
    upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
  });
}

function firstQueryParamValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null && String(item).trim()) return item;
    }
    return value.length > 0 ? value[0] : undefined;
  }
  return value;
}

function parseQueryBoolean(value) {
  const raw = firstQueryParamValue(value);
  if (raw == null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseQueryNumber(value) {
  const raw = firstQueryParamValue(value);
  if (raw == null || String(raw).trim() === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function parseQueryStringArray(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .flatMap((item) => String(item || '').split(','))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeAgentSource(source) {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function isShoppingSource(source) {
  const normalized = normalizeAgentSource(source);
  return normalized === 'shopping-agent' || normalized === 'shopping-agent-ui';
}

function isCreatorUiSource(source) {
  return normalizeAgentSource(source) === 'creator-agent-ui';
}

function isCatalogGuardSource(source) {
  const normalized = normalizeAgentSource(source);
  return (
    isShoppingSource(source) ||
    normalized === 'creator-agent' ||
    normalized === 'creator-agent-ui' ||
    (PROXY_SEARCH_AURORA_FORCE_FAST_MODE && isAuroraSource(source))
  );
}

function isResolverFirstCatalogSource(source) {
  return isShoppingSource(source) || normalizeAgentSource(source) === 'creator-agent';
}

function isAuroraSource(source) {
  const normalized = normalizeAgentSource(source);
  return normalized === 'aurora-chatbox' || normalized === 'aurora-bff';
}

function getAuroraFallbackOverrides(source, operation) {
  const isAurora = isAuroraSource(source) && String(operation || '').trim() === 'find_products_multi';
  return {
    active: isAurora,
    strategySource: isAurora ? 'aurora_force_path' : 'default',
    disableSkipAfterResolverMiss: isAurora && PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
    forceSecondaryFallback: isAurora && PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
    forceInvokeFallback: isAurora && PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
  };
}

function getProxySearchPrimaryTimeoutMs(source, baseTimeoutMs) {
  const fallbackBase = Math.min(getUpstreamTimeoutMs('find_products_multi'), PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS);
  const requested = Number(baseTimeoutMs);
  const safeBase = Number.isFinite(requested) ? Math.max(300, requested) : fallbackBase;
  if (!isAuroraSource(source)) return safeBase;
  return Math.max(300, Math.min(safeBase, PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS));
}

function getProxySearchFallbackTimeoutMs(source) {
  if (!isAuroraSource(source)) return PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
  return Math.max(300, Math.min(PROXY_SEARCH_FALLBACK_TIMEOUT_MS, PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS));
}

function getProxySearchResolverTimeoutMs(source) {
  if (!isAuroraSource(source)) return PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
  return Math.max(200, PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS);
}

function getFallbackAdoptUsableThreshold({ source, primaryUsableCount, primaryIrrelevant }) {
  const baseThreshold = Math.max(1, Number.isFinite(Number(primaryUsableCount)) ? Number(primaryUsableCount) : 0);
  if (!primaryIrrelevant) return baseThreshold;
  if (PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT && isAuroraSource(source)) return 1;
  return baseThreshold;
}

function applyShoppingCatalogQueryGuards(queryParams, source) {
  const params =
    queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
      ? { ...queryParams }
      : {};
  if (!isCatalogGuardSource(source)) return params;
  const isAurora = isAuroraSource(source);
  return {
    ...params,
    allow_external_seed: isAurora ? PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED : true,
    allow_stale_cache: false,
    external_seed_strategy: isAurora
      ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
      : 'supplement_internal_first',
    fast_mode: true,
  };
}

function isExternalSeedProduct(product) {
  if (!product || typeof product !== 'object') return false;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  const source = String(product.source || '').trim().toLowerCase();
  return merchantId === 'external_seed' || source === 'external_seed';
}

function buildSearchProductKey(product) {
  if (!product || typeof product !== 'object') return '';
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  const productId = String(
    product.product_id || product.productId || product.id || product.platform_product_id || '',
  ).trim();
  return `${merchantId}::${productId}`;
}

function extractSearchQueryText(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const raw =
    firstQueryParamValue(query.query) ??
    firstQueryParamValue(query.q) ??
    firstQueryParamValue(query.keyword) ??
    firstQueryParamValue(query.text);
  return String(raw || '').trim();
}

function normalizeSearchQueryParams(rawQuery) {
  const queryParams =
    rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery) ? { ...rawQuery } : {};
  const queryText = extractSearchQueryText(queryParams);
  const hasQuery = String(firstQueryParamValue(queryParams.query) || '').trim().length > 0;
  if (queryText && !hasQuery) {
    queryParams.query = queryText;
  }
  return { queryText, queryParams };
}

async function withStageBudget(promise, timeoutMs, timeoutLabel) {
  const budgetMs = Math.max(1, Number(timeoutMs || 0) || 0);
  if (!budgetMs) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Stage budget exceeded (${timeoutLabel || 'stage'}): ${budgetMs}ms`);
          err.code = 'STAGE_TIMEOUT';
          err.stage = timeoutLabel || 'stage';
          reject(err);
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractSearchProductId(product) {
  if (!product || typeof product !== 'object') return '';
  const raw =
    product.product_id ||
    product.productId ||
    product.platform_product_id ||
    product.platformProductId ||
    product.sku_id ||
    product.skuId ||
    product.id;
  return String(raw || '').trim();
}

function hasUsableSearchProduct(product) {
  if (!product || typeof product !== 'object') return false;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  if (!merchantId) return false;
  return Boolean(extractSearchProductId(product));
}

function countUsableSearchProducts(products) {
  if (!Array.isArray(products)) return 0;
  return products.filter((product) => hasUsableSearchProduct(product)).length;
}

function normalizeSearchTextForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchTextForMatch(raw) {
  return normalizeSearchTextForMatch(raw)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

const SEARCH_QUERY_NOISE_RE =
  /有货|库存|有没有|有無|有沒|有没|是否有|能买|能买吗|哪里买|哪裡買|相關|相关|related|推荐|推薦|recommend(?:ed|ation|ations)?|products?|items?|show\s+me|where\s+to\s+buy|in\s+stock|instock|availability|available|search|find|please|商品|产品|買|购买|買う|买/gimu;
const SEARCH_QUERY_STOP_TOKENS = new Set([
  'a',
  'an',
  'and',
  'any',
  'available',
  'availability',
  'beauty',
  'buy',
  'find',
  'for',
  'how',
  'i',
  'in',
  'instock',
  'is',
  'item',
  'items',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'product',
  'products',
  'recommend',
  'recommended',
  'related',
  'search',
  'show',
  'stock',
  'the',
  'to',
  'where',
  'with',
  'you',
  'your',
  '可以买',
  '能买吗',
  'products',
  '买',
  '产品',
  '商品',
  '推荐',
  '相關',
  '相关',
  '有货',
  '库存',
  '有没有',
  '哪里买',
  '哪裡買',
  '护肤',
  '化妆',
  '化妆品',
  '美妆',
]);

function sanitizeSearchQueryForRelevance(raw) {
  return String(raw || '')
    .replace(SEARCH_QUERY_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSearchAnchorTokens(queryText) {
  const sanitized = sanitizeSearchQueryForRelevance(queryText);
  const resolverInput = sanitized || String(queryText || '');
  const resolverNormalized = normalizeResolverText(resolverInput);
  const resolverTokens = Array.isArray(tokenizeResolverQuery(resolverNormalized))
    ? tokenizeResolverQuery(resolverNormalized)
    : [];
  const looseTokens = tokenizeSearchTextForMatch(resolverInput);

  const anchors = [];
  const seen = new Set();
  for (const token of [...resolverTokens, ...looseTokens]) {
    const normalized = normalizeSearchTextForMatch(token);
    if (!normalized || SEARCH_QUERY_STOP_TOKENS.has(normalized)) continue;
    if (/^[0-9]+$/.test(normalized)) continue;

    const isLatin = /^[a-z0-9]+$/.test(normalized);
    if (isLatin && normalized.length < 3) continue;
    if (!isLatin && normalized.length < 2) continue;

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    anchors.push(normalized);
    if (anchors.length >= 10) break;
  }
  return anchors;
}

function buildResolverQueryCandidates(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return [];

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(raw);
  const sanitized = sanitizeSearchQueryForRelevance(raw);
  pushCandidate(sanitized);

  const anchorTokens = extractSearchAnchorTokens(raw);
  if (anchorTokens.length > 0) {
    pushCandidate(anchorTokens.join(' '));
    for (const token of anchorTokens.slice(0, 3)) {
      pushCandidate(token);
    }
  }

  return candidates.slice(0, 5);
}

function isLookupStyleSearchQuery(queryText, anchorTokens = null) {
  const raw = String(queryText || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (/(ipsa|茵芙莎|winona|薇诺娜|the ordinary|sk[\s-]?ii|流金水|神仙水|time reset aqua)/i.test(lower)) {
    return true;
  }
  if (/(有货|库存|有没有|哪里买|能买|能买吗|where to buy|in stock|available|availability)/i.test(lower)) {
    return true;
  }
  const anchors = Array.isArray(anchorTokens) ? anchorTokens : extractSearchAnchorTokens(raw);
  if (!anchors.length) return false;
  if (anchors.length <= 2 && raw.length <= 48 && !/(推荐|recommend|best|适合|怎么|教程|搭配|guide|tips)/i.test(lower)) {
    return true;
  }
  return false;
}

function buildFallbackCandidateText(product) {
  if (!product || typeof product !== 'object') return '';
  const parts = [
    product.title,
    product.name,
    product.display_name,
    product.brand,
    product.vendor,
    product.product_name,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return normalizeSearchTextForMatch(parts.join(' '));
}

const LOOKUP_EQUIVALENCE_FAMILIES = [
  ['winona', '薇诺娜'],
  ['ipsa', '茵芙莎', '流金水'],
  ['time reset aqua', '流金水', 'ipsa'],
  ['the ordinary', 'ordinary'],
  ['sk ii', 'skii', '神仙水'],
];

function isKnownLookupAliasQuery(queryText) {
  const normalizedQuery = normalizeSearchTextForMatch(queryText);
  if (!normalizedQuery) return false;
  for (const family of LOOKUP_EQUIVALENCE_FAMILIES) {
    const normalizedFamilyTerms = family
      .map((term) => normalizeSearchTextForMatch(term))
      .filter(Boolean);
    if (normalizedFamilyTerms.some((term) => term && normalizedQuery.includes(term))) {
      return true;
    }
  }
  return false;
}

function expandLookupAnchorTokens(queryText, anchorTokens) {
  const normalizedQuery = normalizeSearchTextForMatch(queryText);
  const normalizedAnchors = Array.isArray(anchorTokens)
    ? anchorTokens
        .map((token) => normalizeSearchTextForMatch(token))
        .filter(Boolean)
    : [];
  const expanded = new Set(normalizedAnchors);
  const anchorSet = new Set(normalizedAnchors);
  const queryTokens = new Set(tokenizeSearchTextForMatch(normalizedQuery));

  for (const family of LOOKUP_EQUIVALENCE_FAMILIES) {
    const normalizedFamilyTerms = family
      .map((term) => normalizeSearchTextForMatch(term))
      .filter(Boolean);
    if (!normalizedFamilyTerms.length) continue;

    const matched = normalizedFamilyTerms.some((term) => {
      if (!term) return false;
      if (anchorSet.has(term)) return true;
      if (normalizedQuery.includes(term)) return true;
      return !term.includes(' ') && queryTokens.has(term);
    });
    if (!matched) continue;

    for (const term of normalizedFamilyTerms) {
      expanded.add(term);
      if (term.includes(' ')) {
        for (const sub of term.split(' ')) {
          const normalizedSub = normalizeSearchTextForMatch(sub);
          if (normalizedSub && normalizedSub.length >= 2) {
            expanded.add(normalizedSub);
          }
        }
      }
    }
  }

  return Array.from(expanded);
}

function isProxySearchFallbackRelevant(normalized, queryText) {
  const products = Array.isArray(normalized?.products) ? normalized.products : [];
  if (!products.length) return false;

  const normalizedQuery = normalizeSearchTextForMatch(queryText);
  if (!normalizedQuery) return true;

  const hasPetHarnessSignal = hasPetHarnessSearchSignal(queryText);
  if (hasPetHarnessSignal) {
    for (const product of products.slice(0, 8)) {
      if (!hasUsableSearchProduct(product)) continue;
      const candidateText = buildFallbackCandidateText(product);
      if (!candidateText) continue;
      if (hasStrictPetHarnessCatalogSignal(candidateText)) return true;
    }
    return false;
  }

  if (hasBeautyMakeupSearchSignal(queryText)) {
    for (const product of products.slice(0, 8)) {
      if (!hasUsableSearchProduct(product)) continue;
      const candidateText = buildFallbackCandidateText(product);
      if (!candidateText) continue;
      if (hasBeautyCatalogProductSignal(candidateText)) return true;
    }
    return false;
  }

  const anchorTokens = extractSearchAnchorTokens(queryText);
  const lookupTokens = expandLookupAnchorTokens(queryText, anchorTokens);
  if (isLookupStyleSearchQuery(queryText, anchorTokens) && lookupTokens.length > 0) {
    for (const product of products.slice(0, 8)) {
      if (!hasUsableSearchProduct(product)) continue;
      const candidateText = buildFallbackCandidateText(product);
      if (!candidateText) continue;
      if (lookupTokens.some((token) => candidateText.includes(token))) return true;
    }
    return false;
  }

  const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
  const longQuery = queryTokens.length >= 2;

  for (const product of products.slice(0, 8)) {
    if (!hasUsableSearchProduct(product)) continue;
    const candidateText = buildFallbackCandidateText(product);
    if (!candidateText) continue;
    if (candidateText.includes(normalizedQuery)) return true;
    if (!longQuery) return true;
    const overlapCount = queryTokens.filter((token) => candidateText.includes(token)).length;
    if (overlapCount >= 2) return true;
  }

  return false;
}

function isSupplementCandidateRelevant(product, queryText, options = {}) {
  if (!product || typeof product !== 'object') return false;
  const candidateText = buildFallbackCandidateText(product);
  if (!candidateText) return false;

  if (hasPetHarnessSearchSignal(queryText)) {
    if (!hasStrictPetHarnessCatalogSignal(candidateText)) return false;
  }

  if (hasBeautyMakeupSearchSignal(queryText) && !hasBeautyCatalogProductSignal(candidateText)) {
    return false;
  }

  const normalizedQuery =
    typeof options.normalizedQuery === 'string'
      ? options.normalizedQuery
      : normalizeSearchTextForMatch(queryText);
  if (!normalizedQuery) return true;

  const anchorTokens = Array.isArray(options.anchorTokens)
    ? options.anchorTokens
    : extractSearchAnchorTokens(queryText);
  const lookupTokens = expandLookupAnchorTokens(queryText, anchorTokens);
  if (isLookupStyleSearchQuery(queryText, anchorTokens) && lookupTokens.length > 0) {
    return lookupTokens.some((token) => candidateText.includes(token));
  }

  if (candidateText.includes(normalizedQuery)) return true;

  const queryTokens = Array.isArray(options.queryTokens)
    ? options.queryTokens
    : Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
  if (!queryTokens.length) return true;
  if (queryTokens.length === 1) {
    return candidateText.includes(queryTokens[0]);
  }
  const overlapCount = queryTokens.filter((token) => candidateText.includes(token)).length;
  return overlapCount >= 2;
}

function shouldFallbackProxySearch(normalized, statusCode) {
  if (Number(statusCode) >= 500) return true;
  if (Number(statusCode) < 200 || Number(statusCode) >= 300) return false;
  const products = Array.isArray(normalized?.products) ? normalized.products : [];
  const usableCount = countUsableSearchProducts(products);
  const total = Number(normalized?.total);
  if (products.length > 0 && usableCount === 0) return true;
  if (Number.isFinite(total) && total > 0 && usableCount === 0) return true;
  if (products.length === 0 && Number.isFinite(total) && total === 0) return true;
  return false;
}

function buildFindProductsMultiPayloadFromQuery(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const search = {};

  const textQuery = extractSearchQueryText(query);
  if (!textQuery) return null;
  search.query = textQuery;

  const merchantId = String(firstQueryParamValue(query.merchant_id || query.merchantId) || '').trim();
  if (merchantId) search.merchant_id = merchantId;

  const merchantIds = parseQueryStringArray(query.merchant_ids || query.merchantIds);
  if (merchantIds.length > 0) search.merchant_ids = merchantIds;

  const searchAllMerchants = parseQueryBoolean(query.search_all_merchants || query.searchAllMerchants);
  if (searchAllMerchants !== undefined) search.search_all_merchants = searchAllMerchants;

  const inStockOnly = parseQueryBoolean(query.in_stock_only || query.inStockOnly);
  if (inStockOnly !== undefined) search.in_stock_only = inStockOnly;

  const lang = String(firstQueryParamValue(query.lang) || '').trim();
  if (lang) search.lang = lang;

  const category = String(firstQueryParamValue(query.category) || '').trim();
  if (category) search.category = category;

  const minPrice = parseQueryNumber(query.min_price ?? query.price_min);
  if (minPrice !== undefined) search.min_price = minPrice;

  const maxPrice = parseQueryNumber(query.max_price ?? query.price_max);
  if (maxPrice !== undefined) search.max_price = maxPrice;

  const limit = parseQueryNumber(query.limit ?? query.page_size);
  if (limit !== undefined) search.limit = Math.max(1, Math.min(100, Math.floor(limit)));

  const offset = parseQueryNumber(query.offset);
  if (offset !== undefined) {
    const normalizedOffset = Math.max(0, Math.floor(offset));
    if (search.limit) {
      search.page = Math.floor(normalizedOffset / search.limit) + 1;
    } else {
      search.offset = normalizedOffset;
    }
  }

  return { search };
}

async function fetchExternalSeedSupplementFromBackend({ queryParams, checkoutToken, neededCount }) {
  const query = queryParams && typeof queryParams === 'object' ? queryParams : {};
  const queryText = extractSearchQueryText(query);
  if (!queryText) {
    return {
      products: [],
      metadata: { attempted: false, applied: false, reason: 'empty_query', requested_count: Number(neededCount || 0) },
    };
  }

  const requestedCount = Math.max(1, Number(neededCount || 1));
  const limit = Math.min(Math.max(requestedCount * 4, 20), 200);
  const upstreamParams = {
    merchant_id: 'external_seed',
    query: queryText,
    ...(query.category ? { category: query.category } : {}),
    ...(query.min_price != null ? { min_price: query.min_price } : {}),
    ...(query.max_price != null ? { max_price: query.max_price } : {}),
    in_stock_only: parseQueryBoolean(query.in_stock_only ?? query.inStockOnly) !== false,
    limit,
    offset: 0,
    allow_external_seed: true,
    allow_stale_cache: false,
    external_seed_strategy: 'supplement_internal_first',
    fast_mode: true,
  };

  const url = `${PIVOTA_API_BASE}/agent/v1/products/search`;
  const resp = await axios({
    method: 'GET',
    url,
    params: upstreamParams,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: Math.min(6500, getUpstreamTimeoutMs('find_products_multi')),
    validateStatus: () => true,
  });

  const normalized = normalizeAgentProductsListResponse(resp.data, {
    limit,
    offset: 0,
  });
  const products = Array.isArray(normalized?.products)
    ? normalized.products.filter((p) => isExternalSeedProduct(p))
    : [];
  const normalizedQuery = normalizeSearchTextForMatch(queryText);
  const anchorTokens = extractSearchAnchorTokens(queryText);
  const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
  const relevantProducts = products.filter((p) =>
    isSupplementCandidateRelevant(p, queryText, {
      normalizedQuery,
      anchorTokens,
      queryTokens,
    }),
  );
  const filteredOutIrrelevantCount = Math.max(0, products.length - relevantProducts.length);

  return {
    products: relevantProducts,
    metadata: {
      attempted: true,
      applied: relevantProducts.length > 0,
      reason:
        relevantProducts.length > 0
          ? 'external_seed_candidates_found'
          : filteredOutIrrelevantCount > 0
            ? 'external_seed_candidates_filtered_irrelevant'
            : 'no_external_seed_candidates',
      requested_count: requestedCount,
      fetched_count: relevantProducts.length,
      filtered_out_irrelevant_count: filteredOutIrrelevantCount,
      upstream_status: Number(resp.status || 0) || 0,
    },
  };
}

async function queryFindProductsMultiFallback({
  queryParams,
  checkoutToken,
  reason,
  requestSource,
  timeoutMs,
}) {
  const payload = buildFindProductsMultiPayloadFromQuery(queryParams);
  if (!payload) return null;

  const url = `${PIVOTA_API_BASE}/agent/shop/v1/invoke`;
  const normalizedRequestSource = String(requestSource || '').trim().toLowerCase();
  const preserveAuroraSource =
    PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE && isAuroraSource(normalizedRequestSource);
  const requestBody = {
    operation: 'find_products_multi',
    payload,
    metadata: {
      source: preserveAuroraSource ? normalizedRequestSource : 'agent_search_proxy_fallback',
      ...(normalizedRequestSource ? { request_source: normalizedRequestSource } : {}),
      trigger_reason: reason || 'unknown',
    },
  };

  const effectiveFallbackTimeoutMs = Math.max(
    300,
    Number(timeoutMs || PROXY_SEARCH_FALLBACK_TIMEOUT_MS) || PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
  );

  const resp = await axios({
    method: 'POST',
    url,
    data: requestBody,
    headers: {
      'Content-Type': 'application/json',
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: effectiveFallbackTimeoutMs,
    validateStatus: () => true,
  });

  const normalized = normalizeAgentProductsListResponse(resp.data, {
    limit: parseQueryNumber(queryParams?.limit ?? queryParams?.page_size),
    offset: parseQueryNumber(queryParams?.offset),
  });

  return {
    status: resp.status,
    usableCount: countUsableSearchProducts(normalized?.products),
    data: withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'unknown',
    }),
  };
}

function buildResolverReferenceOnlyResult({
  queryText,
  resolved,
  resolvedQueryUsed,
  resolvedMerchantId,
  resolvedProductId,
  resolveSources,
  reason,
}) {
  const candidateTitle = Array.isArray(resolved?.candidates)
    ? String(resolved.candidates?.[0]?.title || '').trim()
    : '';
  const resolvedTitle = String(
    candidateTitle ||
      resolved?.title ||
      resolved?.alias ||
      resolvedQueryUsed ||
      queryText,
  ).trim();
  const productRow = {
    id: resolvedProductId,
    product_id: resolvedProductId,
    merchant_id: resolvedMerchantId,
    platform_product_id: resolvedProductId,
    ...(resolvedTitle ? { title: resolvedTitle, name: resolvedTitle } : {}),
    canonical_product_ref: {
      merchant_id: resolvedMerchantId,
      product_id: resolvedProductId,
    },
  };

  const normalized = normalizeAgentProductsListResponse({
    status: 'success',
    success: true,
    products: [productRow],
    total: 1,
    page: 1,
    page_size: 1,
    metadata: {
      query_source: 'agent_products_resolver_ref_fallback',
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        'detail_unavailable_ref_only',
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
      resolve_query_used: resolvedQueryUsed || queryText,
      resolve_detail_source: 'reference_only',
    },
  });

  return {
    status: 200,
    usableCount: countUsableSearchProducts(normalized?.products),
    resolved: true,
    resolve_reason: resolved?.reason || null,
    resolve_reason_code:
      resolved?.reason_code ||
      resolved?.metadata?.resolve_reason_code ||
      'detail_unavailable_ref_only',
    resolve_confidence:
      Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
    resolve_latency_ms:
      Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
    resolve_sources: resolveSources,
    resolve_query_used: resolvedQueryUsed || queryText,
    data: withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'resolver_ref_only',
    }),
  };
}

async function queryResolveSearchFallback({
  queryParams,
  checkoutToken,
  reason,
  fetchDetail = true,
  timeoutMs,
}) {
  const query = queryParams && typeof queryParams === 'object' ? queryParams : {};
  const queryText = extractSearchQueryText(query);
  if (!queryText) return null;

  const lang = String(firstQueryParamValue(query.lang) || 'en').trim().toLowerCase() || 'en';
  const merchantId = String(firstQueryParamValue(query.merchant_id || query.merchantId) || '').trim();
  const merchantIds = parseQueryStringArray(query.merchant_ids || query.merchantIds);
  const preferMerchants = uniqueStrings([
    merchantId,
    ...merchantIds,
  ]);
  const searchAllMerchants = parseQueryBoolean(query.search_all_merchants || query.searchAllMerchants);
  const effectiveResolverTimeoutMs = Math.max(
    200,
    Number(timeoutMs || PROXY_SEARCH_RESOLVER_TIMEOUT_MS) || PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
  );
  const resolveOptions = {
    ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
    ...(searchAllMerchants !== undefined ? { search_all_merchants: searchAllMerchants } : {}),
    timeout_ms: effectiveResolverTimeoutMs,
    upstream_retries: 0,
    stable_alias_short_circuit: true,
  };
  const resolverCacheKey = buildProxySearchResolverCacheKey({
    queryText,
    lang,
    preferMerchants,
    searchAllMerchants,
    fetchDetail,
    resolverTimeoutMs: effectiveResolverTimeoutMs,
  });
  const cached = getProxySearchResolverCacheEntry(resolverCacheKey);
  if (cached) return cached;

  const toResolveSources = (input) =>
    Array.isArray(input?.metadata?.sources)
      ? input.metadata.sources
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            source: String(item.source || '').trim() || null,
            ok: item.ok === true,
            count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
            reason: String(item.reason || '').trim() || null,
            error_code: String(item.error_code || '').trim() || null,
          }))
      : [];

  const resolverQueryCandidates = buildResolverQueryCandidates(queryText);
  let resolved = null;
  let resolvedQueryUsed = queryText;
  for (const candidateQuery of resolverQueryCandidates) {
    const candidateText = String(candidateQuery || '').trim();
    if (!candidateText) continue;

    let stableAliasMatch = null;
    if (resolveStableAliasByQuery) {
      try {
        const normalizedCandidate = normalizeResolverText(candidateText);
        const candidateTokens = tokenizeResolverQuery(normalizedCandidate);
        if (normalizedCandidate && candidateTokens.length > 0) {
          stableAliasMatch = resolveStableAliasByQuery({
            query: candidateText,
            normalizedQuery: normalizedCandidate,
            queryTokens: candidateTokens,
          });
        }
      } catch {
        stableAliasMatch = null;
      }
    }

    if (
      stableAliasMatch &&
      stableAliasMatch.product_ref &&
      String(stableAliasMatch.product_ref.product_id || '').trim() &&
      String(stableAliasMatch.product_ref.merchant_id || '').trim()
    ) {
      resolved = {
        resolved: true,
        reason: 'stable_alias_match',
        reason_code: 'stable_alias_match',
        confidence: Number.isFinite(Number(stableAliasMatch.score))
          ? Number(stableAliasMatch.score)
          : 1,
        product_ref: {
          product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
          merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
        },
        candidates: [
          {
            title: String(stableAliasMatch.title || stableAliasMatch.alias || candidateText || '').trim() || null,
            product_ref: {
              product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
              merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
            },
            score: Number.isFinite(Number(stableAliasMatch.score))
              ? Number(stableAliasMatch.score)
              : 1,
          },
        ],
        metadata: {
          latency_ms: 0,
          sources: [
            {
              source: 'stable_alias_ref',
              ok: true,
              reason: stableAliasMatch.reason || 'stable_alias_match',
              count: 1,
            },
          ],
          stable_alias_short_circuit: true,
        },
      };
      resolvedQueryUsed = candidateText;
      break;
    }

    try {
      const candidateResolved = await resolveProductRef({
        query: candidateText,
        lang,
        hints: null,
        options: resolveOptions,
        pivotaApiBase: PIVOTA_API_BASE,
        pivotaApiKey: PIVOTA_API_KEY,
        checkoutToken,
      });
      if (!resolved) {
        resolved = candidateResolved;
        resolvedQueryUsed = candidateText;
      }
      if (
        candidateResolved &&
        candidateResolved.resolved &&
        candidateResolved.product_ref &&
        String(candidateResolved.product_ref.product_id || '').trim() &&
        String(candidateResolved.product_ref.merchant_id || '').trim()
      ) {
        resolved = candidateResolved;
        resolvedQueryUsed = candidateText;
        break;
      }
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: candidateText },
        'proxy agent search resolver fallback failed',
      );
      continue;
    }
  }

  const resolvedRef = resolved && resolved.resolved ? resolved.product_ref : null;
  const resolvedProductId = String(resolvedRef?.product_id || '').trim();
  const resolvedMerchantId = String(resolvedRef?.merchant_id || '').trim();
  const resolveSources = toResolveSources(resolved);
  if (!resolvedProductId || !resolvedMerchantId) {
    const missResult = {
      status: 200,
      usableCount: 0,
      data: null,
      resolved: false,
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        null,
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
      resolve_sources: resolveSources,
      resolve_query_used: resolvedQueryUsed || queryText,
    };
    setProxySearchResolverCacheEntry(
      resolverCacheKey,
      missResult,
      PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
    );
    return missResult;
  }

  let detail = null;
  let detailSource = null;
  if (fetchDetail && PROXY_SEARCH_RESOLVER_DETAIL_ENABLED) {
    try {
      const detailFromCache = await fetchProductDetailFromProductsCache({
        merchantId: resolvedMerchantId,
        productId: resolvedProductId,
        includeExpired: true,
        staleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
      });
      if (detailFromCache?.product) {
        detail = detailFromCache.product;
        detailSource = detailFromCache?.stale_fallback_used
          ? 'products_cache_stale'
          : 'products_cache';
      }
      if (!detail) {
        detail = await fetchProductDetailFromUpstream({
          merchantId: resolvedMerchantId,
          productId: resolvedProductId,
          checkoutToken,
          timeoutMs: PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
          noRetry: true,
        });
        if (detail) detailSource = 'upstream';
      }
    } catch (err) {
      logger.warn(
        {
          err: err?.message || String(err),
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        'proxy agent search resolver fallback detail fetch failed',
      );
    }
  }

  if (fetchDetail && PROXY_SEARCH_RESOLVER_DETAIL_ENABLED && !detail) {
    if (isLookupStyleSearchQuery(queryText, extractSearchAnchorTokens(queryText))) {
      const refOnlyResult = buildResolverReferenceOnlyResult({
        queryText,
        resolved,
        resolvedQueryUsed,
        resolvedMerchantId,
        resolvedProductId,
        resolveSources,
        reason,
      });
      setProxySearchResolverCacheEntry(
        resolverCacheKey,
        refOnlyResult,
        PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
      );
      logger.info(
        {
          query: queryText,
          query_used: resolvedQueryUsed || queryText,
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        'proxy agent search resolver fallback returned reference-only candidate (detail unavailable)',
      );
      return refOnlyResult;
    }

    const missResult = {
      status: 200,
      usableCount: 0,
      data: null,
      resolved: false,
      resolve_reason: resolved?.reason || null,
      resolve_reason_code: 'detail_unavailable',
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
      resolve_sources: resolveSources,
      resolve_query_used: resolvedQueryUsed || queryText,
    };
    setProxySearchResolverCacheEntry(
      resolverCacheKey,
      missResult,
      PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
    );
    logger.info(
      {
        query: queryText,
        query_used: resolvedQueryUsed || queryText,
        merchant_id: resolvedMerchantId,
        product_id: resolvedProductId,
      },
      'proxy agent search resolver fallback skipped unresolved detail candidate',
    );
    return missResult;
  }

  const candidateTitle = Array.isArray(resolved?.candidates)
    ? String(resolved.candidates?.[0]?.title || '').trim()
    : '';
  const title = String(
    detail?.title ||
      detail?.name ||
      detail?.display_name ||
      candidateTitle ||
      queryText,
  ).trim();

  const productRow = {
    ...(detail && typeof detail === 'object' ? detail : {}),
    id: String(detail?.id || detail?.product_id || resolvedProductId),
    product_id: String(detail?.product_id || detail?.id || resolvedProductId),
    merchant_id: String(detail?.merchant_id || resolvedMerchantId),
    platform_product_id: String(
      detail?.platform_product_id ||
        detail?.platformProductId ||
        detail?.product_id ||
        resolvedProductId,
    ),
    ...(title ? { title } : {}),
    ...(title && !detail?.name ? { name: title } : {}),
    canonical_product_ref: {
      merchant_id: resolvedMerchantId,
      product_id: resolvedProductId,
    },
  };

  const normalized = normalizeAgentProductsListResponse({
    status: 'success',
    success: true,
    products: [productRow],
    total: 1,
    page: 1,
    page_size: 1,
    metadata: {
      query_source: 'agent_products_resolver_fallback',
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        null,
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
      resolve_query_used: resolvedQueryUsed || queryText,
      ...(detailSource ? { resolve_detail_source: detailSource } : {}),
    },
  });

  const successResult = {
    status: 200,
    usableCount: countUsableSearchProducts(normalized?.products),
    resolved: true,
    resolve_reason: resolved?.reason || null,
    resolve_reason_code:
      resolved?.reason_code ||
      resolved?.metadata?.resolve_reason_code ||
      null,
    resolve_confidence:
      Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
    resolve_latency_ms:
      Number.isFinite(Number(resolved?.metadata?.latency_ms)) ? Number(resolved.metadata.latency_ms) : null,
    resolve_sources: resolveSources,
    resolve_query_used: resolvedQueryUsed || queryText,
    data: withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'resolver_fallback',
    }),
  };
  setProxySearchResolverCacheEntry(resolverCacheKey, successResult, PROXY_SEARCH_RESOLVER_CACHE_TTL_MS);
  return successResult;
}

function isResolverMiss(result) {
  if (!result || typeof result !== 'object') return false;
  return Number(result.usableCount || 0) <= 0;
}

function shouldReducePrimaryTimeoutAfterResolverMiss(result, queryText = '') {
  if (!isResolverMiss(result)) return false;
  if (hasPetSearchSignal(queryText)) return false;
  const reasonCode = normalizeOffersResolveReasonCode(
    result?.resolve_reason_code || result?.resolve_reason || '',
    '',
  );
  return reasonCode === 'no_candidates' || reasonCode === 'upstream_timeout' || reasonCode === 'db_timeout';
}

function shouldSkipSecondaryFallbackAfterResolverMiss(
  result,
  queryText = '',
  { disableSkipAfterResolverMiss = false } = {},
) {
  if (disableSkipAfterResolverMiss) return false;
  if (!PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS) return false;
  if (isKnownLookupAliasQuery(queryText)) return false;
  if (isStrongResolverFirstQuery(queryText)) return false;
  if (hasPetSearchSignal(queryText)) return false;
  return shouldReducePrimaryTimeoutAfterResolverMiss(result, queryText);
}

function shouldAllowSecondaryFallback(operation, { forceSecondaryFallback = false } = {}) {
  if (forceSecondaryFallback) return true;
  if (operation === 'find_products_multi') {
    return PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
  }
  return true;
}

function shouldAllowInvokeFallback(operation, { forceInvokeFallback = false } = {}) {
  if (forceInvokeFallback) return true;
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  return PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
}

function shouldAllowResolverFallback(operation) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  return PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
}

function shouldBypassSecondaryFallbackSkipOnPrimaryException({ err }) {
  const status = Number(err?.response?.status || err?.status || 0);
  if (Number.isFinite(status) && status >= 500) return true;

  const code = String(err?.code || '').trim().toUpperCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return true;
  }

  const message = String(err?.message || '').trim();
  return /timeout|timed out|socket hang up|aborted|network error/i.test(message);
}

function isUuidLikeSearchQuery(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  return (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{32}$/i.test(s)
  );
}

function isStrongResolverFirstQuery(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return false;
  if (isKnownLookupAliasQuery(raw)) return true;
  if (isUuidLikeSearchQuery(raw)) return true;
  if (!resolveStableAliasByQuery) return false;

  const queryCandidates = buildResolverQueryCandidates(raw);
  for (const candidate of queryCandidates) {
    try {
      const normalized = normalizeResolverText(candidate);
      const tokens = tokenizeResolverQuery(normalized);
      if (!normalized || !tokens.length) continue;
      const match = resolveStableAliasByQuery({
        query: candidate,
        normalizedQuery: normalized,
        queryTokens: tokens,
      });
      if (
        match &&
        match.product_ref &&
        String(match.product_ref.product_id || '').trim() &&
        String(match.product_ref.merchant_id || '').trim()
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function shouldUseResolverFirstSearch({ operation, metadata, queryText }) {
  if (!PROXY_SEARCH_RESOLVER_FIRST_ENABLED) return false;
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  if (!String(queryText || '').trim()) return false;

  const source = normalizeAgentSource(metadata?.source);
  if (isCreatorUiSource(source)) return false;
  if (!source) return true;
  const isCatalogSource = isResolverFirstCatalogSource(source);
  if (PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY && isCatalogSource) {
    const anchorTokens = extractSearchAnchorTokens(queryText);
    return (
      isStrongResolverFirstQuery(queryText) ||
      isLookupStyleSearchQuery(queryText, anchorTokens)
    );
  }

  return isCatalogSource || isAuroraSource(source);
}

function normalizeAgentProductDetailResponse(raw) {
  if (!raw) return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.product) return raw;
    if (raw.data && typeof raw.data === 'object' && raw.data.product) {
      return { ...raw, product: raw.data.product };
    }
    const looksLikeProduct =
      (raw.id || raw.product_id || raw.productId || raw.title || raw.name) &&
      typeof raw !== 'string';
    if (looksLikeProduct) {
      return { status: 'success', success: true, product: raw };
    }
    if (raw.data && typeof raw.data === 'object') {
      const d = raw.data;
      const dLooksLikeProduct = d && (d.id || d.product_id || d.productId || d.title || d.name);
      if (dLooksLikeProduct) {
        return { ...raw, product: d };
      }
    }
  }
  return raw;
}

// Routing map for real Pivota API endpoints
const ROUTE_MAP = {
  find_products: {
    // Use the stable Agent Search endpoint (GET) to avoid upstream /agent/shop/v1/invoke timeouts.
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query',
  },
  find_similar_products: {
    // Delegate to Python shopping gateway for multi-merchant similarity.
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body'
  },
  // Cross-merchant product search via backend shopping gateway
  find_products_multi: {
    // Prefer the stable Agent Search endpoint (GET). We can opt into cross-merchant
    // search via merchant_ids[] or search_all_merchants=true.
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query',
  },
  products_recommendations: {
    method: 'GET',
    path: '/agent/v1/products/recommendations',
    paramType: 'query'
  },
  'products.recommendations': {
    method: 'GET',
    path: '/agent/v1/products/recommendations',
    paramType: 'query'
  },
  get_product_detail: {
    method: 'GET',
    // Use the agent-facing product detail endpoint (legacy but stable).
    // The newer `/agent/v1/products/merchants/{merchant_id}/product/{product_id}` shape
    // can differ by identifier type and has shown PRODUCT_NOT_FOUND for ids returned by search.
    path: '/agent/v1/products/{merchant_id}/{product_id}',
    paramType: 'path',
  },
  preview_quote: {
    method: 'POST',
    path: '/agent/v1/quotes/preview',
    paramType: 'body',
  },
  create_order: {
    method: 'POST',
    path: '/agent/v1/orders/create',
    paramType: 'body'
  },
  confirm_payment: {
    method: 'POST',
    path: '/agent/v1/orders/{order_id}/confirm-payment',
    paramType: 'path'
  },
  submit_payment: {
    method: 'POST',
    path: '/agent/v1/payments',
    paramType: 'body'
  },
  get_order_status: {
    method: 'GET',
    path: '/agent/v1/orders/{order_id}/track',
    paramType: 'path'
  },
  request_after_sales: {
    method: 'POST',
    path: '/agent/v1/orders/{order_id}/refund',
    paramType: 'mixed' // path params + optional body
  },
  track_product_click: {
    method: 'POST',
    path: '/agent/v1/events/product-click',
    paramType: 'body'
  },
  'offers.resolve': {
    // Offer resolution is implemented in the Python shopping gateway (POST /agent/shop/v1/invoke).
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body',
  }
};

let openaiClient;
function getOpenAIClient() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for /ui/chat');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// Helper: call upstream Pivota API with a slightly longer timeout and a
// single retry for key read-heavy operations when we hit a timeout.
// This keeps the gateway responsive while being more tolerant of
// occasional slow product/search slowness.
async function callUpstreamWithOptionalRetry(operation, axiosConfig) {
  const timeoutRetryableOps = ['find_products', 'find_similar_products'];
  if (UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT) {
    timeoutRetryableOps.push('find_products_multi');
  }
  const busyRetryableOps = [
    'find_products',
    'find_products_multi',
    'find_similar_products',
    'get_product_detail',
    'preview_quote',
    'create_order',
    'submit_payment',
    'get_order_status',
    'request_after_sales',
    'track_product_click',
    'offers.resolve',
  ];
  const maxBusyAttempts = Math.max(
    1,
    Math.min(5, Number(process.env.UPSTREAM_RETRY_MAX_ATTEMPTS || 3)),
  );
  const baseDelayMs = Math.max(50, Number(process.env.UPSTREAM_RETRY_BASE_MS || 250));
  const capDelayMs = Math.max(baseDelayMs, Number(process.env.UPSTREAM_RETRY_MAX_MS || 2000));

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseRetryAfterMs(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const v = headers['retry-after'] ?? headers['Retry-After'];
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;

    const seconds = Number(s);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(s);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

    return null;
  }

  function isTemporaryUnavailable(err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const msg =
      (data && typeof data === 'object' && data.error && data.error.message) ||
      (data && typeof data === 'object' && data.message) ||
      null;
    const detailError =
      (data &&
        typeof data === 'object' &&
        data.error &&
        data.error.details &&
        data.error.details.error) ||
      null;

    return (
      status === 503 &&
      (msg === 'TEMPORARY_UNAVAILABLE' || detailError === 'TEMPORARY_UNAVAILABLE')
    );
  }

  function retryDelayMs(attempt, err) {
    const exp = Math.min(capDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = Math.floor(Math.random() * Math.min(150, exp * 0.2));
    const computed = Math.min(capDelayMs, exp + jitter);

    const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
    if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
      return Math.min(capDelayMs, Math.max(computed, retryAfterMs));
    }
    return computed;
  }

  function getTimeoutRetryMs(op, previousTimeoutMs) {
    const prev = Number(previousTimeoutMs || 0) || 0;
    if (op === 'find_products_multi') {
      const bounded = Math.min(
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
        Math.max(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS, prev + 1200),
      );
      return Math.max(prev, bounded);
    }
    if (op === 'find_products') {
      const bounded = Math.min(
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
        Math.max(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS, prev + 1000),
      );
      return Math.max(prev, bounded);
    }
    return Math.max(prev, UPSTREAM_TIMEOUT_SEARCH_RETRY_MS);
  }

  let attempt = 0;
  while (true) {
    try {
      return await axios(axiosConfig);
    } catch (err) {
      attempt += 1;

      // Timeout retry (legacy behavior): one retry for read-heavy search operations.
      if (
        err.code === 'ECONNABORTED' &&
        timeoutRetryableOps.includes(operation) &&
        attempt === 1
      ) {
        const prevTimeoutMs = Number(axiosConfig?.timeout || 0) || null;
        const retryTimeoutMs = getTimeoutRetryMs(operation, prevTimeoutMs);
        if (retryTimeoutMs && retryTimeoutMs !== prevTimeoutMs) {
          axiosConfig.timeout = retryTimeoutMs;
        }
        logger.warn(
          {
            url: axiosConfig.url,
            operation,
            previous_timeout_ms: prevTimeoutMs,
            retry_timeout_ms: axiosConfig?.timeout || null,
          },
          'Upstream timeout, retrying once',
        );
        continue;
      }

      // DB busy / temporary unavailable: retry with short exponential backoff.
      if (
        isTemporaryUnavailable(err) &&
        busyRetryableOps.includes(operation) &&
        attempt < maxBusyAttempts
      ) {
        const delayMs = retryDelayMs(attempt, err);
        logger.warn(
          {
            url: axiosConfig.url,
            operation,
            attempt,
            max_attempts: maxBusyAttempts,
            delay_ms: delayMs,
          },
          'Upstream temporary unavailable, retrying',
        );
        await sleep(delayMs);
        continue;
      }

      throw err;
    }
  }
}

function shouldIncludePdp(payload) {
  if (!payload) return false;
  const view = String(payload.view || '').toLowerCase();
  if (view === 'pdp') return true;
  const include = Array.isArray(payload.include) ? payload.include : [];
  return include.includes('pdp') || include.includes('pdp_payload');
}

function getPdpOptions(payload) {
  const include = Array.isArray(payload?.include) ? payload.include : [];
  return {
    includeRecommendations: include.includes('recommendations') || Boolean(payload?.recommendations?.limit),
    includeEmptyReviews: include.includes('reviews_preview') || payload?.include_empty_reviews === true,
    templateHint: payload?.template_hint || payload?.template || null,
    entryPoint: payload?.context?.entry_point || payload?.entry_point || null,
    experiment: payload?.context?.experiment || payload?.experiment || null,
    debug:
      payload?.debug === true ||
      payload?.options?.debug === true ||
      payload?.context?.debug === true,
  };
}

async function fetchProductDetailFromUpstream(args) {
  const { merchantId, productId, skuId, checkoutToken } = args;
  const timeoutMsRaw = Number(args?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : getUpstreamTimeoutMs('get_product_detail');
  const url = `${PIVOTA_API_BASE}/agent/shop/v1/invoke`;
  const data = {
    operation: 'get_product_detail',
    payload: {
      product: {
        merchant_id: merchantId,
        product_id: productId,
        ...(skuId ? { sku_id: skuId } : {}),
      },
    },
  };
  const axiosConfig = {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: timeoutMs,
    data,
  };
  const resp = args?.noRetry
    ? await axios(axiosConfig)
    : await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig);
  return resp?.data?.product || null;
}

async function fetchLegacyProductDetailFromUpstream(args) {
  const { merchantId, productId, checkoutToken } = args;
  const url = `${PIVOTA_API_BASE}/agent/v1/products/${encodeURIComponent(
    merchantId,
  )}/${encodeURIComponent(productId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: getUpstreamTimeoutMs('get_product_detail'),
  };
  const resp = await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig);
  return resp?.data?.product || null;
}

async function fetchVariantDetailFromUpstream(args) {
  const { merchantId, variantId, checkoutToken } = args;
  const url = `${PIVOTA_API_BASE}/agent/v1/products/merchants/${encodeURIComponent(
    merchantId,
  )}/variant/${encodeURIComponent(variantId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: getUpstreamTimeoutMs('get_product_detail'),
  };
  const resp = await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig);
  return resp?.data || null;
}

async function fetchProductGroupMembersFromUpstream(args) {
  const { productGroupId, checkoutToken } = args;
  const url = `${PIVOTA_API_BASE}/agent/v1/product-groups/${encodeURIComponent(productGroupId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

async function resolveProductGroupFromUpstream(args) {
  const { merchantId, productId, platform, checkoutToken } = args;
  const queryString = buildQueryString({
    merchant_id: merchantId,
    product_id: productId,
    ...(platform ? { platform } : {}),
  });
  const url = `${PIVOTA_API_BASE}/agent/v1/product-groups/resolve${queryString}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

async function resolveProductGroupByProductIdFromUpstream(args) {
  const { productId, platform, checkoutToken } = args;
  const queryString = buildQueryString({
    product_id: productId,
    ...(platform ? { platform } : {}),
  });
  const url = `${PIVOTA_API_BASE}/agent/v1/product-groups/resolve-by-product-id${queryString}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

function normalizeOptionsRecord(raw) {
  const out = {};
  if (!raw) return out;

  const normKey = (v) => String(v || '').trim().toLowerCase();
  const normVal = (v) => String(v || '').trim().toLowerCase();

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue;
      const key = normKey(it.name || it.option || it.key);
      const val = normVal(it.value);
      if (!key || !val) continue;
      out[key] = val;
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const key = normKey(k);
      const val = normVal(v);
      if (!key || !val) continue;
      out[key] = val;
    }
    return out;
  }

  return out;
}

function optionsRecordEquals(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

function extractVariantId(v) {
  const raw = v?.variant_id || v?.variantId || v?.id || null;
  return raw == null ? '' : String(raw).trim();
}

function extractVariantSku(v) {
  const raw = v?.sku || v?.sku_id || v?.skuId || v?.sku_code || null;
  return raw == null ? '' : String(raw).trim().toUpperCase();
}

function extractVariantOptions(v) {
  const raw = v?.options || v?.selected_options || v?.selectedOptions || null;
  return normalizeOptionsRecord(raw);
}

function findVariantIdInProduct(product, selector) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return null;

  const desiredSku = selector?.sku ? String(selector.sku).trim() : '';
  const desiredOptions = selector?.options && typeof selector.options === 'object' ? selector.options : null;

  if (desiredSku) {
    const hit = variants.find((v) => extractVariantSku(v) === desiredSku);
    const id = hit ? extractVariantId(hit) : '';
    if (id) return id;
  }

  if (desiredOptions && Object.keys(desiredOptions).length > 0) {
    for (const v of variants) {
      const opts = extractVariantOptions(v);
      if (optionsRecordEquals(opts, desiredOptions)) {
        const id = extractVariantId(v);
        if (id) return id;
      }
    }
  }

  return null;
}

async function rewriteCheckoutItemsForOfferSelection(args) {
  const { offerId, merchantId, items, checkoutToken } = args;
  const parsed = offerId ? parseOfferId(offerId) : null;
  const productGroupId = parsed?.product_group_id ? String(parsed.product_group_id).trim() : null;
  if (!productGroupId) return { product_group_id: null, product_id: null, items };

  const groupResp = await fetchProductGroupMembersFromUpstream({
    productGroupId,
    checkoutToken,
  }).catch(() => null);
  const members = Array.isArray(groupResp?.members) ? groupResp.members : [];
  const targetMember = members.find(
    (m) => String(m?.merchant_id || m?.merchantId || '').trim() === String(merchantId || '').trim(),
  );
  const targetProductId = String(targetMember?.product_id || targetMember?.productId || '').trim() || null;
  if (!targetProductId) return { product_group_id: productGroupId, product_id: null, items };

  const productCache = new Map();
  const fetchProduct = async (mid, pid) => {
    const key = `${mid}:${pid}`;
    if (productCache.has(key)) return productCache.get(key);
    const p = await fetchLegacyProductDetailFromUpstream({ merchantId: mid, productId: pid, checkoutToken }).catch(
      () => null,
    );
    productCache.set(key, p || null);
    return p || null;
  };

  const targetProduct = await fetchProduct(merchantId, targetProductId);
  if (!targetProduct) return { product_group_id: productGroupId, product_id: targetProductId, items };

  async function deriveVariantSelectorFromGroup(variantId, preferredProductId) {
    const vid = String(variantId || '').trim();
    if (!vid) return { sku: null, options: null };
    const preferredPid = String(preferredProductId || '').trim();
    const ordered = preferredPid
      ? [
          ...members.filter(
            (m) => String(m?.product_id || m?.productId || '').trim() === preferredPid,
          ),
          ...members.filter(
            (m) => String(m?.product_id || m?.productId || '').trim() !== preferredPid,
          ),
        ]
      : members;

    for (const m of ordered) {
      const mid = String(m?.merchant_id || m?.merchantId || '').trim();
      const pid = String(m?.product_id || m?.productId || '').trim();
      if (!mid || !pid) continue;
      const p = await fetchProduct(mid, pid);
      if (!p) continue;
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const hit = variants.find((v) => extractVariantId(v) === vid);
      if (!hit) continue;
      const sku = extractVariantSku(hit) || null;
      const options = extractVariantOptions(hit);
      return {
        sku,
        options: options && Object.keys(options).length ? options : null,
      };
    }
    return { sku: null, options: null };
  }

  const rewritten = [];
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = rawItem && typeof rawItem === 'object' ? { ...rawItem } : null;
    if (!item) continue;

    const originalProductId = String(item.product_id || item.productId || '').trim();
    const originalVariantId = String(item.variant_id || item.variantId || '').trim();
    const originalSku = String(item.sku || item.sku_id || item.skuId || '')
      .trim()
      .toUpperCase();
    const selectedOptionsRaw = item.selected_options || item.selectedOptions || item.options || null;
    const selectedOptions = normalizeOptionsRecord(selectedOptionsRaw);

    let desiredSku = originalSku || null;
    let desiredOptions = Object.keys(selectedOptions).length ? selectedOptions : null;

    if (!desiredSku && !desiredOptions && originalVariantId) {
      const derived = await deriveVariantSelectorFromGroup(originalVariantId, originalProductId);
      desiredSku = derived.sku;
      desiredOptions = derived.options;
    }

    const mappedVariantId = findVariantIdInProduct(targetProduct, {
      sku: desiredSku,
      options: desiredOptions,
    });

    // If product_id changes across sellers, we must be able to map a variant_id safely.
    if (!mappedVariantId && originalProductId && originalProductId !== targetProductId) {
      const err = new Error('Selected variant is not available for this seller.');
      err.code = 'VARIANT_MAPPING_FAILED';
      throw err;
    }

    item.product_id = targetProductId;
    if (mappedVariantId) {
      item.variant_id = mappedVariantId;
      item.variantId = mappedVariantId;
    }
    // Preserve helpful hints for downstream logs/debugging.
    if (desiredSku && !item.sku) item.sku = desiredSku;
    if (desiredOptions && !item.selected_options) item.selected_options = desiredOptions;
    rewritten.push(item);
  }

  return { product_group_id: productGroupId, product_id: targetProductId, items: rewritten };
}

async function fetchSimilarProductsFromUpstream(args) {
  const { merchantId, productId, limit, checkoutToken, timeoutMs } = args;
  const url = `${PIVOTA_API_BASE}/agent/shop/v1/invoke`;
  const data = {
    operation: 'find_similar_products',
    payload: {
      // Upstream shopping gateway expects the flat payload shape.
      // The nested `payload.similar` shape is supported at this gateway boundary,
      // but must be normalized before forwarding upstream.
      merchant_id: merchantId,
      product_id: productId,
      limit: limit || 6,
    },
  };
  const axiosConfig = {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    },
    timeout: Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : getUpstreamTimeoutMs('find_similar_products'),
    data,
  };
  const resp = await callUpstreamWithOptionalRetry('find_similar_products', axiosConfig);
  return Array.isArray(resp?.data?.products) ? resp.data.products : [];
}

async function fetchReviewSummaryFromUpstream(args) {
  const { merchantId, platform, platformProductId, checkoutToken } = args;
  const mid = String(merchantId || '').trim();
  const pf = String(platform || '').trim();
  const pid = String(platformProductId || '').trim();
  if (!mid || !pf || !pid) return null;

  const url = `${REVIEWS_API_BASE}/agent/shop/v1/invoke`;
  const data = {
    operation: 'get_review_summary',
    payload: {
      sku: {
        merchant_id: mid,
        platform: pf,
        platform_product_id: pid,
        variant_id: null,
      },
    },
  };

  const axiosConfig = {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(checkoutToken ? { 'X-Checkout-Token': checkoutToken } : {}),
    },
    timeout: UPSTREAM_TIMEOUT_REVIEWS_MS,
    data,
  };

  // Avoid long retries (e.g. search retry timeout) for optional review summary.
  const resp = await callUpstreamWithOptionalRetry('get_review_summary', axiosConfig);
  const summary = resp?.data?.review_summary;
  return summary && typeof summary === 'object' ? summary : null;
}

async function fetchReviewSummaryCached(args = {}) {
  const merchantId = String(args?.merchantId || '').trim();
  const platform = String(args?.platform || '').trim();
  const platformProductId = String(args?.platformProductId || '').trim();
  if (!merchantId || !platform || !platformProductId) return null;

  const bypassCache = Boolean(args?.bypassCache);
  const cacheKey = buildPdpReviewSummaryCacheKey({
    merchantId,
    platform,
    platformProductId,
  });
  if (!cacheKey) return null;

  if (PDP_REVIEW_SUMMARY_CACHE_ENABLED && !bypassCache) {
    const cached = getPdpReviewSummaryCacheEntry(cacheKey);
    if (cached.found) return cached.value;
  }

  const existing = PDP_REVIEW_SUMMARY_INFLIGHT.get(cacheKey);
  if (existing) return existing;

  trimOldestInflightEntries(PDP_REVIEW_SUMMARY_INFLIGHT, PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES);
  const task = (async () => {
    try {
      const summary = await fetchReviewSummaryFromUpstream({
        ...args,
        merchantId,
        platform,
        platformProductId,
      });
      if (PDP_REVIEW_SUMMARY_CACHE_ENABLED && !bypassCache) {
        const ttl = summary ? PDP_REVIEW_SUMMARY_CACHE_TTL_MS : PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS;
        setPdpReviewSummaryCacheEntry(cacheKey, summary, ttl);
      }
      return summary;
    } finally {
      PDP_REVIEW_SUMMARY_INFLIGHT.delete(cacheKey);
    }
  })();
  PDP_REVIEW_SUMMARY_INFLIGHT.set(cacheKey, task);
  return task;
}

async function fetchSimilarProductsDeduped(args = {}) {
  const inflightKey = buildPdpSimilarInflightKey(args);
  const runOnce = async () => {
    const rec = await recommendPdpProducts(args);
    return Array.isArray(rec?.items) ? rec.items : [];
  };

  if (!inflightKey) return runOnce();
  const existing = PDP_SIMILAR_INFLIGHT.get(inflightKey);
  if (existing) return existing;

  trimOldestInflightEntries(PDP_SIMILAR_INFLIGHT, PDP_SIMILAR_INFLIGHT_MAX_ENTRIES);
  const task = (async () => {
    try {
      return await runOnce();
    } finally {
      PDP_SIMILAR_INFLIGHT.delete(inflightKey);
    }
  })();
  PDP_SIMILAR_INFLIGHT.set(inflightKey, task);
  return task;
}

function extractUpstreamErrorCode(err) {
  const data = err && err.response ? err.response.data : null;

  function looksLikeErrorCode(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s || s.length > 80) return false;
    return /^[A-Z][A-Z0-9_]+$/.test(s);
  }

  // Preferred shape: Pivota unified error envelope
  // {
  //   status: "error",
  //   error: { code, message, details: { error, message, ... } }
  // }
  if (data && typeof data === 'object') {
    const pivotaErr = data.error && typeof data.error === 'object' ? data.error : null;
    if (pivotaErr) {
      const details =
        pivotaErr.details && typeof pivotaErr.details === 'object' ? pivotaErr.details : null;
      const underlying =
        details && typeof details.error === 'string' && looksLikeErrorCode(details.error)
          ? details.error
          : typeof pivotaErr.message === 'string' && looksLikeErrorCode(pivotaErr.message)
            ? pivotaErr.message
            : typeof pivotaErr.code === 'string' && looksLikeErrorCode(pivotaErr.code)
              ? pivotaErr.code
              : null;
      const msg =
        (details && typeof details.message === 'string' && details.message) ||
        (typeof pivotaErr.message === 'string' && !looksLikeErrorCode(pivotaErr.message)
          ? pivotaErr.message
          : '') ||
        (typeof pivotaErr.code === 'string' && !looksLikeErrorCode(pivotaErr.code) ? pivotaErr.code : '') ||
        (err && err.message ? err.message : '');
      return { code: underlying, message: msg, data, detail: details || pivotaErr };
    }
  }

  // Fallbacks: FastAPI default shapes or legacy gateway errors
  const detail = data && typeof data === 'object' ? (data.detail ?? data) : data;
  const code =
    detail && typeof detail === 'object'
      ? typeof detail.code === 'string'
        ? detail.code
        : typeof detail.error === 'string'
          ? detail.error
          : null
      : null;
  const message =
    detail && typeof detail === 'object' && typeof detail.message === 'string'
      ? detail.message
      : typeof detail === 'string'
        ? detail
        : err && err.message
          ? err.message
          : '';
  return { code, message, data, detail };
}

function isRetryableQuoteError(code) {
  return code === 'QUOTE_EXPIRED' || code === 'QUOTE_MISMATCH';
}

function isPydanticMissingBodyField(err, fieldName) {
  const resp = err && err.response ? err.response : null;
  if (!resp || resp.status !== 422) return false;
  const data = resp.data;
  const detail = data && typeof data === 'object' ? data.detail : null;
  if (!Array.isArray(detail)) return false;
  return detail.some((item) => {
    const loc = item && typeof item === 'object' ? item.loc : null;
    return Array.isArray(loc) && loc.includes(fieldName);
  });
}

const app = express();

async function fetchBackendAdmin({ method, path, params, data }) {
  if (!ADMIN_API_KEY) {
    const err = new Error('ADMIN_API_KEY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }
  const url = `${PIVOTA_API_BASE}${path}`;
  return await axios({
    method,
    url,
    headers: {
      ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
      'X-ADMIN-KEY': ADMIN_API_KEY,
    },
    timeout: UPSTREAM_TIMEOUT_ADMIN_MS,
    ...(params ? { params } : {}),
    ...(data ? { data } : {}),
  });
}

// ---------------- Promotion / deals enrichment helpers ----------------

const CHANNEL_CREATOR = 'creator_agents';

// Simple admin guard for internal promotions API
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: 'ADMIN_API_KEY_NOT_CONFIGURED' });
  }
  const provided = req.header('X-ADMIN-KEY') || req.header('x-admin-key');
  if (!provided || provided !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  return next();
}

function isPromoActive(promo, nowTs) {
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  return nowTs >= start && nowTs <= end && !promo.deletedAt;
}

function matchesScope(promo, product) {
  const scope = promo.scope || {};
  if (scope.global) return true;

  const pid = String(product.product_id || product.id || '');
  if (scope.productIds && scope.productIds.includes(pid)) return true;

  const category = (product.category || product.product_type || '').toLowerCase();
  if (
    scope.categoryIds &&
    scope.categoryIds.some((c) => category && category.includes(String(c).toLowerCase()))
  ) {
    return true;
  }

  const brand = (product.vendor || product.brand || '').toLowerCase();
  if (
    scope.brandIds &&
    scope.brandIds.some((b) => brand && brand.includes(String(b).toLowerCase()))
  ) {
    return true;
  }

  return false;
}

function allowedForCreator(promo, creatorId) {
  if (!creatorId) {
    // If not exposing to creators, skip; otherwise allow when creator not specified
    return promo.exposeToCreators !== false;
  }
  if (promo.exposeToCreators === false) return false;
  if (promo.allowedCreatorIds && promo.allowedCreatorIds.length > 0) {
    return promo.allowedCreatorIds.includes(creatorId);
  }
  return true;
}

function findApplicablePromotionsForProduct(product, now, promotions, creatorId) {
  const nowTs = now.getTime();
  const productMerchant = String(product.merchant_id || product.merchantId || '');
  return promotions.filter(
    (promo) =>
      isPromoActive(promo, nowTs) &&
      // Merchant ownership: promo.merchantId is the owner, scope is only targeting.
      (!promo.merchantId ||
        !productMerchant ||
        String(promo.merchantId) === productMerchant) &&
      matchesScope(promo, product) &&
      Array.isArray(promo.channels) &&
      promo.channels.includes(CHANNEL_CREATOR) &&
      allowedForCreator(promo, creatorId)
  );
}

function computeUrgency(endAt) {
  if (!endAt) return 'LOW';
  const end = new Date(endAt).getTime();
  const now = Date.now();
  const diffMs = end - now;
  if (diffMs <= 0) return 'LOW';
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours <= 1) return 'HIGH';
  if (diffHours <= 24) return 'MEDIUM';
  return 'LOW';
}

function promotionToDealPayload(promo, productPrice) {
  const base = {
    id: promo.id,
    type: promo.type,
    label: promo.humanReadableRule || promo.name || 'Deal',
  };

  if (promo.config?.kind === 'FLASH_SALE') {
    const flashPrice = promo.config.flashPrice || null;
    const originalPrice =
      promo.config.originalPrice || productPrice || (productPrice === 0 ? 0 : null);
    const discountPercent =
      originalPrice && originalPrice > 0 && flashPrice
        ? Math.round((1 - flashPrice / originalPrice) * 100)
        : undefined;

    return {
      ...base,
      discount_percent: discountPercent,
      flash_price: flashPrice || undefined,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    return {
      ...base,
      discount_percent: promo.config.discountPercent,
      threshold_quantity: promo.config.thresholdQuantity,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  if (promo.config?.kind === 'FREE_SHIPPING' || promo.type === 'FREE_SHIPPING') {
    return {
      ...base,
      free_shipping: true,
      min_subtotal: promo.config?.minSubtotal,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  return base;
}

function enrichProductsWithDeals(products, promotions, now = new Date(), creatorId = null) {
  if (!Array.isArray(products) || !products.length) return products;
  return products.map((product) => {
    const applicablePromos = findApplicablePromotionsForProduct(
      product,
      now,
      promotions,
      creatorId
    );
    const allDeals = applicablePromos.map((p) =>
      promotionToDealPayload(p, product.price || product.price_cents || product.unit_price)
    );

    let bestDeal = null;
    if (allDeals.length) {
      bestDeal = allDeals.reduce((best, current) => {
        if (!best) return current;
        const bestDiscount = best.discount_percent || 0;
        const currentDiscount = current.discount_percent || 0;
        if (currentDiscount > bestDiscount) return current;
        if (currentDiscount === bestDiscount) {
          const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
          const bestUrgency = rank[best.urgency_level || 'LOW'];
          const currentUrgency = rank[current.urgency_level || 'LOW'];
          return currentUrgency > bestUrgency ? current : best;
        }
        return best;
      }, null);
    }

    return {
      ...product,
      best_deal: bestDeal || product.best_deal || null,
      all_deals: allDeals.length ? allDeals : product.all_deals,
    };
  });
}

/**
 * Apply deal enrichment to various response shapes:
 * - { products: [...] }
 * - { groups: [{ products: [...] }]}
 * - { results: { key: [...] } }
 */
function applyDealsToResponse(upstreamData, promotions, now = new Date(), creatorId = null) {
  if (!upstreamData || !promotions || !promotions.length) {
    return upstreamData;
  }

  const clone = JSON.parse(JSON.stringify(upstreamData));

  // Flat products
  if (Array.isArray(clone.products)) {
    clone.products = enrichProductsWithDeals(clone.products, promotions, now, creatorId);
  }

  // groups: [{ products: [...] }]
  if (Array.isArray(clone.groups)) {
    clone.groups = clone.groups.map((g) => {
      if (Array.isArray(g.products)) {
        return { ...g, products: enrichProductsWithDeals(g.products, promotions, now, creatorId) };
      }
      return g;
    });
  }

  // results: { key: [...] }
  if (clone.results && typeof clone.results === 'object') {
    const newResults = {};
    for (const key of Object.keys(clone.results)) {
      const arr = clone.results[key];
      newResults[key] = Array.isArray(arr)
        ? enrichProductsWithDeals(arr, promotions, now, creatorId)
        : arr;
    }
    clone.results = newResults;
  }

  // data.products (nested)
  if (clone.data && Array.isArray(clone.data.products)) {
    clone.data.products = enrichProductsWithDeals(
      clone.data.products,
      promotions,
      now,
      creatorId
    );
  }

  // Similar-products style payloads:
  // { base_product_id, strategy_used, items: [{ product: {...}, best_deal, all_deals, ... }] }
  if (Array.isArray(clone.items)) {
    clone.items = clone.items.map((item) => {
      if (!item || !item.product) return item;

      const enrichedList = enrichProductsWithDeals(
        [item.product],
        promotions,
        now,
        creatorId
      );
      const enrichedProduct = enrichedList && enrichedList[0] ? enrichedList[0] : item.product;

      return {
        ...item,
        product: enrichedProduct,
        best_deal: enrichedProduct.best_deal || item.best_deal || null,
        all_deals: enrichedProduct.all_deals || item.all_deals || [],
      };
    });
  }

  return clone;
}

// Helper: compute similar products (simple heuristic: price band, exclude ids)
function pickSimilarProducts(products, baseProductId, limit = 8, excludeIds = []) {
  if (!Array.isArray(products)) return [];
  const excludes = new Set(excludeIds || []);
  excludes.add(baseProductId);

  const base = products.find(
    (p) => String(p.product_id || p.id) === String(baseProductId)
  );
  const basePrice = base ? Number(base.price || base.unit_price || 0) : null;

  let candidates = products.filter(
    (p) => !excludes.has(String(p.product_id || p.id))
  );

  if (basePrice && basePrice > 0) {
    const min = basePrice * 0.7;
    const max = basePrice * 1.3;
    const priced = candidates.filter((p) => {
      const price = Number(p.price || p.unit_price || 0);
      return price >= min && price <= max;
    });

    if (priced.length) {
      candidates = priced;
    }

    candidates.sort((a, b) => {
      const pa = Math.abs(Number(a.price || a.unit_price || 0) - basePrice);
      const pb = Math.abs(Number(b.price || b.unit_price || 0) - basePrice);
      return pa - pb;
    });
  }

  return candidates.slice(0, limit);
}

function deriveQueryFromProduct(product) {
  if (!product) return '';
  const title = (product.title || '').trim();
  if (title) return title;
  const ptype = (product.product_type || product.category || '').trim();
  if (ptype) return ptype;
  const desc = (product.description || '').trim();
  if (desc) return desc.slice(0, 60);
  return String(product.product_id || product.id || '').trim();
}

function computeHumanReadableRule(promo) {
  if (promo.humanReadableRule) return promo.humanReadableRule;
  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    const t = promo.config.thresholdQuantity;
    const d = promo.config.discountPercent;
    if (t && d) return `Buy ${t}, get ${d}% off`;
    return 'Bundle & save';
  }
  if (promo.config?.kind === 'FLASH_SALE') {
    const fp = promo.config.flashPrice;
    if (fp) return `Flash deal`;
    return 'Flash deal';
  }
  return promo.name || 'Deal';
}

function sanitizePromotionForResponse(promo) {
  if (!promo) return promo;
  const scope = promo.scope || {};
  return {
    ...promo,
    // Ensure merchantId is always present at root
    merchantId:
      promo.merchantId ||
      promo.merchant_id ||
      scope.merchantIds?.[0] ||
      scope.merchant_ids?.[0] ||
      null,
    scope: {
      productIds: scope.productIds || scope.product_ids || [],
      categoryIds: scope.categoryIds || scope.category_ids || [],
      brandIds: scope.brandIds || scope.brand_ids || [],
      global: scope.global === true,
    },
  };
}

function computePromotionStatus(promo, nowTs) {
  if (promo.deletedAt) return 'ENDED';
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 'UNKNOWN';
  if (nowTs < start) return 'UPCOMING';
  if (nowTs > end) return 'ENDED';
  return 'ACTIVE';
}

function validateAndNormalizePromotion(payload, existing = {}, { requireAll = false } = {}) {
  const body = payload?.promotion ?? payload ?? {};
  const merged = { ...existing, ...body };
  const errors = [];

  const type = merged.type || merged.config?.kind || merged.config?.type;
  if (!type && requireAll) errors.push('type is required');
  if (type && !['MULTI_BUY_DISCOUNT', 'FLASH_SALE'].includes(type)) {
    errors.push('type must be MULTI_BUY_DISCOUNT or FLASH_SALE');
  }

  if (!merged.name && requireAll) errors.push('name is required');

  const startTs = merged.startAt ? new Date(merged.startAt).getTime() : NaN;
  const endTs = merged.endAt ? new Date(merged.endAt).getTime() : NaN;
  if (requireAll && Number.isNaN(startTs)) errors.push('startAt is required and must be a date');
  if (requireAll && Number.isNaN(endTs)) errors.push('endAt is required and must be a date');
  if (!Number.isNaN(startTs) && !Number.isNaN(endTs) && endTs <= startTs) {
    errors.push('endAt must be after startAt');
  }

  const channels = Array.isArray(merged.channels) ? merged.channels : [];
  if (requireAll && channels.length === 0) {
    errors.push('channels must be a non-empty array');
  }

  const merchantId =
    merged.merchantId ||
    merged.merchant_id ||
    merged.scope?.merchantIds?.[0] ||
    merged.scope?.merchant_ids?.[0] ||
    null;
  if (requireAll && !merchantId) {
    errors.push('merchantId is required');
  }

  const scope = merged.scope || {};
  const normalizedScope = {
    productIds: scope.productIds || [],
    categoryIds: scope.categoryIds || [],
    brandIds: scope.brandIds || [],
    global: scope.global === true,
  };

  const config = merged.config || {};
  if (type === 'FLASH_SALE') {
    const flashPrice = Number(config.flashPrice ?? merged.flashPrice ?? 0);
    const originalPrice = Number(config.originalPrice ?? merged.originalPrice ?? 0);
    if (requireAll && Number.isNaN(flashPrice)) errors.push('flashPrice must be a number');
    if (requireAll && Number.isNaN(originalPrice)) errors.push('originalPrice must be a number');
    merged.config = {
      kind: 'FLASH_SALE',
      flashPrice,
      originalPrice,
      ...(config.stockLimit !== undefined ? { stockLimit: config.stockLimit } : {}),
    };
  } else if (type === 'MULTI_BUY_DISCOUNT') {
    const thresholdQuantity = Number(config.thresholdQuantity ?? merged.thresholdQuantity ?? 0);
    const discountPercent = Number(config.discountPercent ?? merged.discountPercent ?? 0);
    if (requireAll && (!thresholdQuantity || Number.isNaN(thresholdQuantity))) {
      errors.push('thresholdQuantity must be provided for MULTI_BUY_DISCOUNT');
    }
    if (requireAll && (Number.isNaN(discountPercent) || discountPercent <= 0 || discountPercent > 100)) {
      errors.push('discountPercent must be between 1 and 100');
    }
    merged.config = {
      kind: 'MULTI_BUY_DISCOUNT',
      thresholdQuantity,
      discountPercent,
    };
  }

  if (errors.length) {
    return { error: errors.join('; ') };
  }

  const normalized = {
    id: merged.id || merged.promotion_id || randomUUID(),
    name: merged.name,
    type,
    description: merged.description || '',
    startAt: merged.startAt,
    endAt: merged.endAt,
    merchantId: merchantId,
    channels: channels.length ? channels : merged.channels || [],
    scope: normalizedScope,
    config: merged.config,
    exposeToCreators: merged.exposeToCreators !== false,
    allowedCreatorIds: merged.allowedCreatorIds || [],
    humanReadableRule: '',
    createdAt: merged.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: merged.deletedAt || null,
  };

  normalized.humanReadableRule = computeHumanReadableRule(normalized);

  return { promotion: normalized };
}

async function getActivePromotions(now = new Date(), creatorId = null) {
  let promos = [];
  try {
    promos = await getAllPromotions();
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load promotions');
    promos = [];
  }

  // Temporary: keep filtering logic simple and permissive so that
  // promotions reliably apply while we iterate on console flows.
  // Each promotion already carries merchantId and channels; matching
  // to products is handled in findApplicablePromotionsForProduct.
  return promos
    .filter((p) => !p.deletedAt)
    .map((p) => ({
      ...p,
      humanReadableRule: computeHumanReadableRule(p),
    }));
}

const SELLABLE_PRODUCT_STATUS_VALUES = [
  'active',
  'published',
  'online',
  'live',
  'enabled',
  'available',
];

const NON_SELLABLE_PRODUCT_STATUS_VALUES = new Set([
  'inactive',
  'disabled',
  'deleted',
  'archived',
  'archive',
  'draft',
  'hidden',
  'unpublished',
  'blocked',
]);

function buildSellableStatusPredicate(statusExpr) {
  const expr = `lower(coalesce(${statusExpr}, ''))`;
  const allowed = SELLABLE_PRODUCT_STATUS_VALUES.map((value) => `'${value}'`).join(', ');
  return `(${expr} = '' OR ${expr} IN (${allowed}))`;
}

function isStatusActive(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return true;
  if (SELLABLE_PRODUCT_STATUS_VALUES.includes(normalized)) return true;
  if (NON_SELLABLE_PRODUCT_STATUS_VALUES.has(normalized)) return false;
  // Unknown status should fail-open to avoid dropping sellable catalogs due
  // partner-specific status enums.
  return true;
}

function isProductSellable(product, options = {}) {
  if (!product || typeof product !== 'object') return false;
  if (!isStatusActive(product.status)) return false;
  const inStockOnly = options?.inStockOnly !== false;
  // Prefer in-stock products when inventory information is available.
  // When callers explicitly set in_stock_only=false, do not treat inventory<=0 as a hard block,
  // because some platforms/merchants can continue selling when inventory is not tracked.
  if (inStockOnly) {
    const rawInv =
      product.inventory_quantity ??
      product.inventoryQuantity ??
      (product.inventory && product.inventory.quantity);
    if (rawInv != null) {
      const inv = Number(rawInv);
      if (Number.isFinite(inv) && inv <= 0) return false;
    }
  }
  return true;
}

function looksSkuLikeQuery(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return false;
  if (!/[0-9]/.test(s)) return false;
  return /^[a-z0-9-]{6,}$/.test(s);
}

function tokenizeQueryForCache(q) {
  const rawInput = String(q || '').trim();
  const lowerInput = rawInput.toLowerCase();
  const sanitizedInput = sanitizeSearchQueryForRelevance(rawInput);
  const resolverInput = sanitizedInput || rawInput;
  const resolverNormalized = normalizeResolverText(resolverInput);
  const resolverTokens = Array.isArray(tokenizeResolverQuery(resolverNormalized))
    ? tokenizeResolverQuery(resolverNormalized)
    : [];
  const latinTokens = lowerInput.split(/[^a-z0-9]+/g).filter(Boolean);
  const cjkTokens = Array.from(
    new Set(
      (resolverInput.match(/[\u4e00-\u9fff]{2,}/g) || [])
        .map((token) => String(token || '').trim())
        .filter(Boolean),
    ),
  );
  const raw = [...latinTokens, ...resolverTokens, ...cjkTokens];
  if (hasPetSearchSignal(rawInput)) {
    raw.push('dog', 'pet');
    if (hasPetHarnessSearchSignal(rawInput)) {
      raw.push('harness', 'leash', 'collar');
    }
  }
  if (hasBeautyMakeupSearchSignal(rawInput)) {
    raw.push(
      'makeup',
      'cosmetic',
      'beauty',
      'foundation',
      'concealer',
      'lipstick',
      'blush',
      'mascara',
      'eyeshadow',
      'brush',
      'palette',
      'fenty',
      'tom ford',
    );
  }
  const stop = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'bought',
    'by',
    'can',
    'could',
    'do',
    'does',
    'for',
    'from',
    'have',
    'help',
    'i',
    'in',
    'is',
    'it',
    'just',
    'like',
    'me',
    'my',
    'of',
    'on',
    'or',
    'please',
    'some',
    'that',
    'the',
    'their',
    'them',
    'this',
    'to',
    'u',
    'we',
    'what',
    'which',
    'with',
    'you',
    'your',
    '什么',
    '有什麼',
    '有什么',
    '有沒有',
    '有哪些',
    '哪些',
    '的吗',
    '的嗎',
    '有吗',
    '有嗎',
    '吗',
    '嗎',
    '呢',
    '的',
    '了',
  ]);

  const kept = [];
  for (const t of raw) {
    const normalizedToken = normalizeSearchTextForMatch(t);
    if (!normalizedToken) continue;
    if (stop.has(normalizedToken)) continue;
    const isLatinToken = /^[a-z0-9]+$/.test(normalizedToken);
    if (isLatinToken && normalizedToken.length < 3 && normalizedToken !== 'xs' && normalizedToken !== 'xl') {
      continue;
    }
    if (!isLatinToken && normalizedToken.length < 2) continue;
    kept.push(normalizedToken);
  }

  // Keep unique, preserve order.
  const seen = new Set();
  const uniq = [];
  for (const t of kept) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }

  const lookupExpanded = isLookupStyleSearchQuery(rawInput, extractSearchAnchorTokens(rawInput))
    ? expandLookupAnchorTokens(rawInput, uniq)
    : uniq;

  const expandedSeen = new Set();
  const expandedUniq = [];
  for (const token of lookupExpanded) {
    const normalizedToken = normalizeSearchTextForMatch(token);
    if (!normalizedToken) continue;
    if (stop.has(normalizedToken)) continue;
    if (expandedSeen.has(normalizedToken)) continue;
    expandedSeen.add(normalizedToken);
    expandedUniq.push(normalizedToken);
  }

  // Clamp to avoid pathological SQL, but ensure we don't drop "important" tokens
  // that often appear at the end (e.g. appended canonical keywords).
  // Strategy:
  // - If <= 8 tokens: return as-is.
  // - Else: take a balanced slice (first 4 + last 4), preserving order.
  if (expandedUniq.length <= 8) return expandedUniq;
  const first = expandedUniq.slice(0, 4);
  const last = expandedUniq.slice(-4);
  const outSeen = new Set();
  const out = [];
  for (const t of [...first, ...last]) {
    if (outSeen.has(t)) continue;
    outSeen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function detectToyOutfitIntentFromQuery(q) {
  const s = String(q || '').toLowerCase();
  const toy = /\b(labubu|toy|toys|doll|dolls|plush|plushie|figure|collectible)\b/.test(s);
  const outfit = /\b(clothes|clothing|outfit|accessory|accessories|hat)\b/.test(s) || /衣服|穿/.test(s);
  const lingerie = /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(s);
  return { toy_intent: toy, outfit_intent: toy && outfit, lingerie_intent: lingerie };
}

function buildUnderwearExclusionSql(startIndex) {
  const tokens = [
    'lingerie',
    'underwear',
    'bra',
    'panties',
    'panty',
    'briefs',
    'thong',
    'push-up',
    'push up',
    'backless',
    "women's sleepwear",
    'womens sleepwear',
    'women sleepwear',
    'sleepwear set',
    "women's lingerie",
    'lingerie set',
    'ropa interior',
    'sujetador',
    'bragas',
  ];

  const fields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'product_type',''))",
  ];

  const parts = [];
  const params = [];
  let idx = startIndex;
  for (const tok of tokens) {
    const p = `%${tok}%`;
    params.push(p);
    const ors = fields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    parts.push(`(${ors})`);
    idx += 1;
  }
  return {
    sql: parts.length ? `NOT (${parts.join(' OR ')})` : 'TRUE',
    params,
    nextIndex: idx,
  };
}

async function loadCreatorSellableFromCache(creatorId, page = 1, limit = 20, options = {}) {
  const config = getCreatorConfig(creatorId);
  if (!config || !Array.isArray(config.merchantIds) || config.merchantIds.length === 0) {
    const err = new Error('Unknown creator');
    err.code = 'UNKNOWN_CREATOR';
    throw err;
  }

  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(Math.max(1, Number(limit || 20)), 100);
  const fetchLimit = Math.max(safeLimit * Math.max(safePage, 1) * 2, 20);
  const inStockOnly = options?.inStockOnly !== false;

  // Optional: load explicit creator_picks so we can surface curated
  // recommendations at the top of the Featured feed and tag them for
  // frontends (e.g. Creator Agent UI) to power a "Creator picks" filter.
  let pickRankByProductId = new Map();
  try {
    const picksRes = await query(
      `
        SELECT product_id, rank
        FROM creator_picks
        WHERE creator_id = $1
        ORDER BY rank ASC
        LIMIT $2
      `,
      [creatorId, safeLimit * 4],
    );
    pickRankByProductId = new Map(
      (picksRes.rows || [])
        .map((r) => {
          const pid = String(r.product_id || '').trim();
          const rank = Number(r.rank);
          return [pid, rank];
        })
        .filter(([pid, rank]) => pid && Number.isFinite(rank)),
    );
  } catch (err) {
    logger.warn(
      { err: err.message, creatorId },
      'Failed to load creator_picks for creator featured feed; continuing without explicit picks',
    );
  }

  // Apply lightweight gating at the SQL layer (avoid deleted/expired/inactive).
  // In-stock preference is handled in JS so that in_stock_only=false can
  // still surface products where inventory is not tracked.
  const baseWhere = `
    merchant_id = ANY($1)
    AND (expires_at IS NULL OR expires_at > now())
    AND ${buildSellableStatusPredicate("product_data->>'status'")}
  `;

  const rowsRes = await query(
    `
      SELECT product_data
      FROM products_cache
      WHERE ${baseWhere}
      ORDER BY cached_at DESC
      LIMIT $2
    `,
    [config.merchantIds, fetchLimit],
  );

  let baseProducts = (rowsRes.rows || [])
    .map((r) => r.product_data)
    .filter(Boolean)
    .filter((p) => isProductSellable(p, { inStockOnly }));

  if (baseProducts.length === 0) {
    try {
      const relaxedRowsRes = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = ANY($1)
          ORDER BY cached_at DESC NULLS LAST, id DESC
          LIMIT $2
        `,
        [config.merchantIds, fetchLimit],
      );
      baseProducts = (relaxedRowsRes.rows || [])
        .map((r) => r.product_data)
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }));
    } catch (err) {
      logger.warn(
        { err: err.message, creatorId },
        'Creator featured strict cache query empty and relaxed fallback failed',
      );
    }
  }

  // Ensure explicit creator picks are always present in the featured pool,
  // even when they are older than the default cached_at window.
  let pickProducts = [];
  const pickIds = Array.from(pickRankByProductId.keys());
  if (pickIds.length > 0) {
    try {
      const pickRowsRes = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE ${baseWhere}
            AND (
              platform_product_id = ANY($2)
              OR product_data->>'id' = ANY($2)
              OR product_data->>'product_id' = ANY($2)
            )
          ORDER BY cached_at DESC
        `,
        [config.merchantIds, pickIds],
      );
      pickProducts = (pickRowsRes.rows || [])
        .map((r) => r.product_data)
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }));
    } catch (err) {
      logger.warn(
        { err: err.message, creatorId, pickIdsCount: pickIds.length },
        'Failed to hydrate creator_picks from products_cache; continuing with base products only',
      );
    }
  }

  const products = [...pickProducts, ...baseProducts];

  // De-dupe in case multiple cache rows exist for the same product.
  const seen = new Set();
  const unique = [];
  for (const p of products) {
    const mid = String(p.merchant_id || p.merchantId || '').trim();
    const pid = String(p.id || p.product_id || p.productId || '').trim();
    const key = `${mid}::${pid || JSON.stringify(p).slice(0, 64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  // Reorder so that explicit creator picks (from creator_picks) appear
  // first while preserving relative order for non-picks. Also tag them
  // with creator_pick metadata for downstream UIs.
  const decorated = unique.map((p) => {
    const pid = String(p.id || p.product_id || p.productId || '').trim();
    const rank =
      pid && pickRankByProductId.has(pid) ? pickRankByProductId.get(pid) : null;
    return { product: p, pickRank: rank };
  });

  decorated.sort((a, b) => {
    const ar = a.pickRank == null ? Number.POSITIVE_INFINITY : a.pickRank;
    const br = b.pickRank == null ? Number.POSITIVE_INFINITY : b.pickRank;
    if (ar !== br) return ar - br;
    return 0;
  });

  const sorted = decorated.map(({ product, pickRank }) => {
    if (pickRank == null) return product;
    return {
      ...product,
      creator_pick: true,
      creator_pick_rank: pickRank,
    };
  });

  const startIdx = (safePage - 1) * safeLimit;
  const pageItems = sorted.slice(startIdx, startIdx + safeLimit);
  const effectiveTotal = sorted.length;

  await applyShopifyCurrencyOverride(pageItems);

  return {
    products: pageItems,
    total: effectiveTotal,
    page: safePage,
    page_size: pageItems.length,
    merchantIds: config.merchantIds,
  };
}

function buildPetSignalSql(startIndex) {
  // Regex boundary for latin words; also include CJK pet keywords without boundaries.
  // Use ~* for case-insensitive matching.
  const latin = '(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|perro|perros|mascota|mascotas|gato|gatos|chien|chiens|chienne|chiot|chat|chats)';
  const cjk = '(狗狗|狗|猫猫|猫|宠物|犬服|猫服|犬|ペット|わんちゃん)';
  // IMPORTANT: Postgres uses \m and \M as word-boundary tokens. Do NOT double-escape
  // here, otherwise the regex engine sees a literal "\m" string and never matches.
  const re = `(\\m${latin}\\M|${cjk})`;

  const fields = [
    "coalesce(product_data->>'title','')",
    "coalesce(product_data->>'description','')",
    "coalesce(product_data->>'product_type','')",
  ];

  const idx = startIndex;
  const ors = fields.map((f) => `${f} ~* $${idx}`).join(' OR ');
  return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
}

function hasPetSearchSignal(queryText) {
  const q = String(queryText || '');
  if (!q) return false;
  return (
    /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|perro|perros|mascota|mascotas|gato|gatos|chien|chiens|chat|chats)\b/i.test(
      q,
    ) ||
    /狗狗|狗|猫猫|猫|宠物|犬|犬服|猫服|ペット|わんちゃん/.test(q)
  );
}

function hasPetHarnessSearchSignal(queryText) {
  const q = String(queryText || '');
  if (!q) return false;
  return (
    /\b(harness|leash|dog\s+leash|pet\s+leash|collar|lead|no-?pull)\b/i.test(q) ||
    /背带|背帶|胸背|牵引|牽引|牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|项圈|項圈|胸背带|胸背帶|狗绳|狗繩|胴輪|ハーネス|リード|首輪/.test(
      q,
    )
  );
}

function hasPetLeashSearchSignal(queryText) {
  const q = String(queryText || '');
  if (!q) return false;
  return (
    /\b(leash|dog\s+leash|pet\s+leash|lead|training\s+leash|collar)\b/i.test(q) ||
    /牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|狗绳|狗繩|项圈|項圈|リード|首輪/.test(q)
  );
}

function hasStrictPetHarnessCatalogSignal(candidateText) {
  const text = String(candidateText || '');
  if (!text) return false;
  return (
    /\b(harness|leash|dog\s+leash|pet\s+leash|collar|lead|no-?pull|training\s+leash)\b/i.test(text) ||
    /(背带|背帶|胸背|牵引|牽引|牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|项圈|項圈|胴輪|ハーネス|リード|首輪|arn[eé]s|correa|collier)/i.test(
      text,
    )
  );
}

function hasBeautyMakeupSearchSignal(queryText) {
  const q = String(queryText || '');
  if (!q) return false;
  return (
    /\b(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow)\b/i.test(
      q,
    ) ||
    /化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|约会妆|約會妝/.test(
      q,
    )
  );
}

function hasBeautyCatalogProductSignal(candidateText) {
  const text = String(candidateText || '');
  if (!text) return false;
  return (
    /\b(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow|brush|palette|toner|serum|skincare|fenty|tom ford|winona|ipsa)\b/i.test(
      text,
    ) ||
    /(化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|化妆刷|化妝刷|刷具|粉扑|美妆蛋|妆前|妝前|定妆|定妝|薇诺娜|薇諾娜|茵芙莎|流金水)/.test(
      text,
    )
  );
}

function classifyBeautyBucketFromProduct(product) {
  const text = buildFallbackCandidateText(product);
  if (!text) return 'other';

  if (
    /\b(brush|brushes|blender|sponge|puff|applicator|tool|tools|brush\s*set)\b/i.test(text) ||
    /化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|工具|刷子|パフ|ブラシ/.test(text)
  ) {
    return 'tools';
  }
  if (
    /\b(foundation|concealer|primer|powder|cushion|bb\s*cream|cc\s*cream|setting\s*powder)\b/i.test(text) ||
    /粉底|遮瑕|妆前|妝前|散粉|蜜粉|气垫|氣墊/.test(text)
  ) {
    return 'base_makeup';
  }
  if (
    /\b(eyeshadow|eye\s*shadow|mascara|eyeliner|brow|eyebrow)\b/i.test(text) ||
    /眼影|睫毛膏|眼线|眼線|眉笔|眉筆|眉粉/.test(text)
  ) {
    return 'eye_makeup';
  }
  if (
    /\b(lipstick|lip\s*tint|lip\s*gloss|lip\s*balm|lip\s*liner|lip)\b/i.test(text) ||
    /口红|口紅|唇膏|唇彩|唇釉|润唇|潤唇/.test(text)
  ) {
    return 'lip_makeup';
  }
  if (
    /\b(skincare|serum|toner|essence|moisturizer|cream|cleanser|sunscreen)\b/i.test(text) ||
    /护肤|護膚|精华|精華|化妆水|化妝水|乳液|面霜|洁面|潔面|防晒|防曬/.test(text)
  ) {
    return 'skincare';
  }
  return 'other';
}

function computeBeautyBucketMix(products, topN = 10) {
  const buckets = {
    base_makeup: 0,
    eye_makeup: 0,
    lip_makeup: 0,
    skincare: 0,
    tools: 0,
    other: 0,
  };
  const top = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN || 10))) : [];
  for (const product of top) {
    const bucket = classifyBeautyBucketFromProduct(product);
    buckets[bucket] = Number(buckets[bucket] || 0) + 1;
  }
  return buckets;
}

function isBeautyGeneralDiversitySupplementCandidate(intent, products, limit) {
  if (!intent || intent.primary_domain !== 'beauty') return false;
  const scenario = String(intent?.scenario?.name || '');
  if (scenario === 'beauty_tools' || scenario === 'eye_shadow_brush') return false;
  const topN = Math.max(1, Number(limit || 10));
  const mix = computeBeautyBucketMix(products, topN);
  const coreBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare'];
  const distinctCore = coreBuckets.filter((bucket) => Number(mix[bucket] || 0) > 0).length;
  const toolsCount = Number(mix.tools || 0);
  return distinctCore < 2 && toolsCount >= Math.ceil(topN * 0.6);
}

function blendBeautyDiversitySupplement(internalProducts, supplementProducts, limit) {
  const targetLimit = Math.max(1, Number(limit || 10));
  const priorityBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare', 'tools', 'other'];
  const seen = new Set();
  const merged = [];
  const internal = Array.isArray(internalProducts) ? internalProducts : [];
  const supplement = Array.isArray(supplementProducts) ? supplementProducts : [];

  const addUnique = (product) => {
    const key = buildSearchProductKey(product) || JSON.stringify(product || {}).slice(0, 96);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(product);
  };

  for (const product of internal) addUnique(product);
  for (const product of supplement) addUnique(product);

  const queues = new Map(priorityBuckets.map((bucket) => [bucket, []]));
  for (const product of merged) {
    const bucket = classifyBeautyBucketFromProduct(product);
    if (!queues.has(bucket)) queues.set(bucket, []);
    queues.get(bucket).push(product);
  }

  const output = [];
  while (output.length < targetLimit) {
    let progressed = false;
    for (const bucket of priorityBuckets) {
      const queue = queues.get(bucket);
      if (!queue || queue.length === 0) continue;
      output.push(queue.shift());
      progressed = true;
      if (output.length >= targetLimit) break;
    }
    if (!progressed) break;
  }

  return output;
}

function buildPetHarnessSignalSql(startIndex) {
  const latin = '(harness|leash|collar|lead|no-?pull|dog\\s+harness|dog\\s+leash|pet\\s+harness|pet\\s+leash)';
  const cjk = '(背带|胸背|牵引|牵引绳|遛狗绳|狗链|项圈|胸背带|胴輪|ハーネス)';
  const re = `(\\m${latin}\\M|${cjk})`;
  const fields = [
    "coalesce(product_data->>'title','')",
    "coalesce(product_data->>'description','')",
    "coalesce(product_data->>'product_type','')",
  ];
  const idx = startIndex;
  const ors = fields.map((f) => `${f} ~* $${idx}`).join(' OR ');
  return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
}

function buildBeautySignalSql(startIndex) {
  const latin =
    '(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow|brush|palette|toner|serum|skincare|fenty|tom\\s*ford|winona|ipsa)';
  const cjk =
    '(化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|化妆刷|化妝刷|刷具|粉扑|美妆蛋|妆前|妝前|定妆|定妝|薇诺娜|薇諾娜|茵芙莎|流金水)';
  const re = `(\\m${latin}\\M|${cjk})`;
  const fields = [
    "coalesce(product_data->>'title','')",
    "coalesce(product_data->>'description','')",
    "coalesce(product_data->>'product_type','')",
    "coalesce(product_data->>'vendor','')",
  ];
  const idx = startIndex;
  const ors = fields.map((f) => `${f} ~* $${idx}`).join(' OR ');
  return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
}

async function searchCreatorSellableFromCache(creatorId, queryText, page = 1, limit = 20, options = {}) {
  const config = getCreatorConfig(creatorId);
  if (!config || !Array.isArray(config.merchantIds) || config.merchantIds.length === 0) {
    const err = new Error('Unknown creator');
    err.code = 'UNKNOWN_CREATOR';
    throw err;
  }

  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(Math.max(1, Number(limit || 20)), 100);
  const offset = (safePage - 1) * safeLimit;
  const q = String(queryText || '').trim().toLowerCase();
  const inStockOnly = options?.inStockOnly !== false;

  function productKey(p) {
    const mid = String(p?.merchant_id || p?.merchantId || '').trim();
    const pid = String(p?.id || p?.product_id || p?.productId || '').trim();
    return `${mid}::${pid || JSON.stringify(p).slice(0, 64)}`;
  }

  // Base gating (avoid deleted/expired/inactive). In-stock preference is handled
  // in JS so that in_stock_only=false can still surface products where inventory
  // is not tracked.
  const baseWhere = `
    merchant_id = ANY($1)
    AND (expires_at IS NULL OR expires_at > now())
    AND ${buildSellableStatusPredicate("product_data->>'status'")}
  `;

  const terms = tokenizeQueryForCache(q);
  const skuLike = looksSkuLikeQuery(q);
  const { toy_intent, outfit_intent, lingerie_intent } = detectToyOutfitIntentFromQuery(q);
  const intentTarget = String(options?.intent?.target_object?.type || '').toLowerCase();

  const whereParts = [];
  const params = [config.merchantIds];
  let idx = 2;

  // If we have no usable terms, behave like cold-start.
  if (terms.length === 0) {
    return await loadCreatorSellableFromCache(creatorId, safePage, safeLimit, { inStockOnly });
  }

  const matchFields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'description',''))",
    "lower(coalesce(product_data->>'product_type',''))",
    "lower(coalesce(product_data->>'sku',''))",
    "lower(coalesce(product_data->>'vendor',''))",
  ];

  for (const t of terms) {
    params.push(`%${t}%`);
    const ors = matchFields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    const termParts = [`(${ors})`];
    if (skuLike) {
      // Variant SKU can be nested; bounded text scan for SKU-like queries only.
      termParts.push(`lower(CAST(product_data AS TEXT)) LIKE $${idx}`);
    }
    whereParts.push(`(${termParts.join(' OR ')})`);
    idx += 1;
  }

  // Intent-aware safety:
  // - For pet/human searches, avoid surfacing lingerie unless explicitly asked for it.
  // - For pet searches, additionally require a pet signal to prevent "featured" bleed-through.
  let underwearClause = null;
  let underwearParams = [];
  let afterUnderwearIdx = idx;
  const shouldExcludeUnderwear =
    !lingerie_intent && ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');

  if (shouldExcludeUnderwear) {
    const built = buildUnderwearExclusionSql(idx);
    underwearClause = built.sql;
    underwearParams = built.params;
    afterUnderwearIdx = built.nextIndex;
  }

  const queryWhere = whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE';
  let petClause = null;
  let petParams = [];
  let afterPetIdx = afterUnderwearIdx;
  if (intentTarget === 'pet') {
    const built = buildPetSignalSql(afterUnderwearIdx);
    petClause = built.sql;
    petParams = built.params;
    afterPetIdx = built.nextIndex;
  }

  const finalWhere = [baseWhere, queryWhere, ...(underwearClause ? [underwearClause] : []), ...(petClause ? [petClause] : [])].join(
    ' AND '
  );

  const pageFetch = Math.min(Math.max(safeLimit * 3, 60), 300);
  const pageOffset = Math.max(0, offset);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM products_cache
    WHERE ${finalWhere}
  `;

  const rowsSql = `
    SELECT product_data
    FROM products_cache
    WHERE ${finalWhere}
    ORDER BY cached_at DESC
    OFFSET $${afterPetIdx}
    LIMIT $${afterPetIdx + 1}
  `;

  const countParams = underwearClause
    ? petClause
      ? [...params, ...underwearParams, ...petParams]
      : [...params, ...underwearParams]
    : petClause
      ? [...params, ...petParams]
      : params;
  const rowsParams = underwearClause
    ? petClause
      ? [...params, ...underwearParams, ...petParams, pageOffset, pageFetch]
      : [...params, ...underwearParams, pageOffset, pageFetch]
    : petClause
      ? [...params, ...petParams, pageOffset, pageFetch]
      : [...params, pageOffset, pageFetch];

  const [countRes, rowsRes] = await Promise.all([
    query(countSql, countParams),
    query(rowsSql, rowsParams),
  ]);

  const total = Number(countRes.rows?.[0]?.total || 0);
  const rawProducts = (rowsRes.rows || []).map((r) => r.product_data).filter(Boolean);

  const lexicalScoreByKey = new Map();

  // Rank candidates in-memory for better UX (title matches > description matches).
  const scored = rawProducts
    .filter((p) => isProductSellable(p, { inStockOnly }))
    .map((p) => {
      const title = String(p.title || '').toLowerCase();
      const desc = String(p.description || '').toLowerCase();
      const ptype = String(p.product_type || p.productType || '').toLowerCase();
      const sku = String(p.sku || '').toLowerCase();
      const tags = Array.isArray(p.tags) ? p.tags.join(' ').toLowerCase() : String(p.tags || '').toLowerCase();
      const recTags = Array.isArray(p.recommendation_meta?.tags)
        ? p.recommendation_meta.tags.join(' ').toLowerCase()
        : '';
      const recFacets = p.recommendation_meta?.facets ? JSON.stringify(p.recommendation_meta.facets).toLowerCase() : '';
      const blob = `${title} ${ptype} ${sku} ${tags} ${recTags} ${recFacets} ${desc}`;

      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        else if (ptype.includes(t)) score += 2;
        else if (blob.includes(t)) score += 1;
      }

      // Tags/facets are stable catalog semantics; prioritize them when available.
      score += scoreByTagFacetOverlap(terms, p).score;

      if (skuLike) {
        const q0 = q.replace(/[^a-z0-9-]+/g, '');
        if (q0 && sku === q0) score += 6;
        else if (q0 && blob.includes(q0)) score += 3;
      }

      // Gentle boost for toy-like when the query is toy/outfit intent.
      if ((toy_intent || outfit_intent) && /\b(labubu|doll|plush|toy|outfit)\b/.test(blob)) {
        score += 1;
      }

      // Penalize obvious object mismatches at recall time.
      // This prevents generic terms like "dress" from being dominated by doll outfits
      // when the user is clearly asking for human clothing.
      const toyLike =
        /\b(labubu|doll|vinyl face doll|blind box|plush|plushie|figure|collectible)\b/.test(blob) ||
        /盲盒|公仔|娃娃|娃衣/.test(blob);
      const petLike =
        /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets)\b/.test(blob) ||
        /\b(perro|perros|mascota|mascotas|gato|gatos)\b/.test(blob) ||
        /\b(chien|chiens|chat|chats|animal|animaux)\b/.test(blob) ||
        /狗|猫|宠物|犬服|猫服|ペット/.test(blob);

      if (intentTarget === 'human') {
        if (!toy_intent && !outfit_intent && toyLike) score -= 100;
        if (petLike) score -= 60;
      } else if (intentTarget === 'pet') {
        if (toyLike) score -= 100;
      } else if (intentTarget === 'toy') {
        if (petLike) score -= 40;
      }

      return { p, score, key: productKey(p) };
    })
    .sort((a, b) => b.score - a.score);

  for (const row of scored) {
    if (row && row.key) {
      lexicalScoreByKey.set(row.key, typeof row.score === 'number' ? row.score : Number(row.score || 0));
    }
  }

  const lexicalProducts = scored.slice(0, safeLimit).map((x) => x.p);
  const retrievalSources = [
    { source: 'lexical_cache', used: true, count: lexicalProducts.length, candidate_count: rawProducts.length },
  ];

  if (lexicalProducts.length === 0) {
    try {
      const relaxedWhere = [
        'merchant_id = ANY($1)',
        queryWhere,
        ...(underwearClause ? [underwearClause] : []),
        ...(petClause ? [petClause] : []),
      ].join(' AND ');
      const relaxedRowsSql = `
        SELECT product_data
        FROM products_cache
        WHERE ${relaxedWhere}
        ORDER BY cached_at DESC NULLS LAST, id DESC
        OFFSET $${afterPetIdx}
        LIMIT $${afterPetIdx + 1}
      `;
      const relaxedRowsRes = await query(relaxedRowsSql, rowsParams);
      const relaxedProductsRaw = (relaxedRowsRes.rows || [])
        .map((r) => r.product_data)
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }));
      const seen = new Set();
      const relaxedProducts = [];
      for (const product of relaxedProductsRaw) {
        const key = productKey(product);
        if (seen.has(key)) continue;
        seen.add(key);
        relaxedProducts.push(product);
        if (relaxedProducts.length >= safeLimit) break;
      }
      retrievalSources.push({
        source: 'lexical_cache_relaxed',
        used: true,
        count: relaxedProducts.length,
        candidate_count: relaxedProductsRaw.length,
      });
      if (relaxedProducts.length > 0) {
        await applyShopifyCurrencyOverride(relaxedProducts);
        return {
          products: relaxedProducts,
          total: Math.max(total, relaxedProducts.length),
          page: safePage,
          page_size: safeLimit,
          merchantIds: config.merchantIds,
          retrieval_sources: retrievalSources,
        };
      }
    } catch (err) {
      retrievalSources.push({
        source: 'lexical_cache_relaxed',
        used: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  // If lexical returned nothing for pet intent (common for non-English queries
  // against an English catalog), do a pet-constrained browse fallback so we can
  // still show some relevant creator items.
  if (lexicalProducts.length === 0 && intentTarget === 'pet') {
    try {
      let underwearClause2 = null;
      let underwearParams2 = [];
      let idx2 = 2;
      const shouldExcludeUnderwear2 =
        !lingerie_intent && ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');
      if (shouldExcludeUnderwear2) {
        const built = buildUnderwearExclusionSql(idx2);
        underwearClause2 = built.sql;
        underwearParams2 = built.params;
        idx2 = built.nextIndex;
      }
      const builtPet = buildPetSignalSql(idx2);
      const petClause2 = builtPet.sql;
      const petParams2 = builtPet.params;
      idx2 = builtPet.nextIndex;

      const browseWhere = [baseWhere, ...(underwearClause2 ? [underwearClause2] : []), petClause2].join(' AND ');
      const pageFetch2 = Math.min(Math.max(safeLimit * 4, 80), 300);
      const browseRes = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE ${browseWhere}
          ORDER BY cached_at DESC
          LIMIT $${idx2}
        `,
        [config.merchantIds, ...underwearParams2, ...petParams2, pageFetch2],
      );

      const browseProducts = (browseRes.rows || [])
        .map((r) => r.product_data)
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }))
        .slice(0, safeLimit);

      retrievalSources.push({
        source: 'pet_browse_fallback',
        used: true,
        count: browseProducts.length,
      });

      if (browseProducts.length > 0) {
        await applyShopifyCurrencyOverride(browseProducts);
        return {
          products: browseProducts,
          total: Math.max(total, browseProducts.length),
          page: safePage,
          page_size: safeLimit,
          merchantIds: config.merchantIds,
          retrieval_sources: retrievalSources,
        };
      }
    } catch (err) {
      retrievalSources.push({
        source: 'pet_browse_fallback',
        used: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  if (lexicalProducts.length === 0 && hasBeautyMakeupSearchSignal(q)) {
    try {
      let underwearClause2 = null;
      let underwearParams2 = [];
      let idx2 = 2;
      const shouldExcludeUnderwear2 =
        !lingerie_intent &&
        ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');
      if (shouldExcludeUnderwear2) {
        const built = buildUnderwearExclusionSql(idx2);
        underwearClause2 = built.sql;
        underwearParams2 = built.params;
        idx2 = built.nextIndex;
      }
      const builtBeauty = buildBeautySignalSql(idx2);
      const beautyClause2 = builtBeauty.sql;
      const beautyParams2 = builtBeauty.params;
      idx2 = builtBeauty.nextIndex;

      const browseWhere = [baseWhere, ...(underwearClause2 ? [underwearClause2] : []), beautyClause2].join(' AND ');
      const pageFetch2 = Math.min(Math.max(safeLimit * 4, 80), 300);
      const browseRes = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE ${browseWhere}
          ORDER BY cached_at DESC
          LIMIT $${idx2}
        `,
        [config.merchantIds, ...underwearParams2, ...beautyParams2, pageFetch2],
      );

      const browseProducts = (browseRes.rows || [])
        .map((r) => r.product_data)
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }))
        .slice(0, safeLimit);

      retrievalSources.push({
        source: 'beauty_browse_fallback',
        used: true,
        count: browseProducts.length,
      });

      if (browseProducts.length > 0) {
        await applyShopifyCurrencyOverride(browseProducts);
        return {
          products: browseProducts,
          total: Math.max(total, browseProducts.length),
          page: safePage,
          page_size: safeLimit,
          merchantIds: config.merchantIds,
          retrieval_sources: retrievalSources,
        };
      }
    } catch (err) {
      retrievalSources.push({
        source: 'beauty_browse_fallback',
        used: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  const vectorEnabled =
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true' &&
    process.env.DATABASE_URL &&
    safePage === 1;

  const intentLang = String(options?.intent?.language || '').toLowerCase();
  const shouldTryVector =
    vectorEnabled &&
    // Keep vector recall for non-English queries, or when lexical returns nothing.
    // This avoids paying embedding/vector latency on healthy lexical hits.
    ((intentLang && intentLang !== 'en' && intentLang !== 'other') || lexicalProducts.length === 0);

  if (shouldTryVector) {
    try {
      const embedding = await embedText(queryText, { cache: true });
      const vecLimit = Math.min(Math.max(safeLimit * 6, 80), 240);
      const vecHits = await semanticSearchCreatorProductsFromCache({
        merchantIds: config.merchantIds,
        queryVector: embedding.vector,
        dim: embedding.dim,
        provider: embedding.provider,
        model: embedding.model,
        limit: vecLimit,
        intentTarget,
        excludeUnderwear: shouldExcludeUnderwear,
      });

      const vectorScoreByKey = new Map();
      const vecProducts = vecHits
        .map((x) => {
          const p = x && x.product ? x.product : null;
          if (!p) return null;
          vectorScoreByKey.set(productKey(p), typeof x.score === 'number' ? x.score : Number(x.score || 0));
          return p;
        })
        .filter(Boolean)
        .filter((p) => isProductSellable(p, { inStockOnly }));

      retrievalSources.push({
        source: 'vector_cache',
        used: true,
        count: vecProducts.length,
        provider: embedding.provider,
        model: embedding.model,
        dim: embedding.dim,
      });

      const nonEnglishQuery = intentLang && intentLang !== 'en' && intentLang !== 'other';
      const shouldBlend =
        vecProducts.length > 0 &&
        (lexicalProducts.length < safeLimit || nonEnglishQuery || intentTarget === 'human' || intentTarget === 'pet');

      if (shouldBlend) {
        const seen = new Set();
        const merged = [];
        const lexicalTake = nonEnglishQuery ? Math.min(Math.ceil(safeLimit * 0.4), lexicalProducts.length) : lexicalProducts.length;

        for (const p of lexicalProducts.slice(0, lexicalTake)) {
          const key = productKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(p);
        }
        for (const p of vecProducts) {
          if (merged.length >= safeLimit) break;
          const key = productKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(p);
        }
        // If still not full, backfill from remaining lexical items.
        if (merged.length < safeLimit && lexicalTake < lexicalProducts.length) {
          for (const p of lexicalProducts.slice(lexicalTake)) {
            if (merged.length >= safeLimit) break;
            const key = productKey(p);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(p);
          }
        }

        // Final rerank: keep strong lexical matches first, but allow high-similarity
        // vector hits to surface above weak lexical noise. Tags/facets already feed
        // into lexical scoring and embeddings, so this provides a stable blend.
        merged.sort((a, b) => {
          const ak = productKey(a);
          const bk = productKey(b);
          const aLex = lexicalScoreByKey.get(ak) || 0;
          const bLex = lexicalScoreByKey.get(bk) || 0;
          const aVec = vectorScoreByKey.get(ak) || 0;
          const bVec = vectorScoreByKey.get(bk) || 0;
          const aScore = aLex + aVec * 4.0;
          const bScore = bLex + bVec * 4.0;
          return bScore - aScore;
        });

        await applyShopifyCurrencyOverride(merged);
        return {
          products: merged,
          total: Math.max(total, merged.length),
          page: safePage,
          page_size: safeLimit,
          merchantIds: config.merchantIds,
          retrieval_sources: retrievalSources,
        };
      }
    } catch (err) {
      // Fail-open: vector recall is an optional enhancement; do not block lexical search.
      retrievalSources.push({
        source: 'vector_cache',
        used: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  await applyShopifyCurrencyOverride(lexicalProducts);
  return {
    products: lexicalProducts,
    total,
    page: safePage,
    page_size: safeLimit,
    merchantIds: config.merchantIds,
    retrieval_sources: retrievalSources,
  };
}

async function searchCrossMerchantFromCache(queryText, page = 1, limit = 20, options = {}) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(Math.max(1, Number(limit || 20)), 100);
  const offset = (safePage - 1) * safeLimit;
  const q = String(queryText || '').trim().toLowerCase();
  const inStockOnly = options?.inStockOnly !== false;

  const terms = tokenizeQueryForCache(q);
  if (terms.length === 0) {
    return await loadCrossMerchantBrowseFromCache(safePage, safeLimit, { inStockOnly });
  }

  const skuLike = looksSkuLikeQuery(q);
  const buildQueryFilter = (fieldPrefix = 'pc.') => {
    const matchFields = [
      `lower(coalesce(${fieldPrefix}product_data->>'title',''))`,
      `lower(coalesce(${fieldPrefix}product_data->>'description',''))`,
      `lower(coalesce(${fieldPrefix}product_data->>'product_type',''))`,
      `lower(coalesce(${fieldPrefix}product_data->>'sku',''))`,
      `lower(coalesce(${fieldPrefix}product_data->>'vendor',''))`,
    ];
    const whereParts = [];
    const params = [];
    let idx = 1;
    for (const t of terms) {
      params.push(`%${t}%`);
      const ors = matchFields.map((field) => `${field} LIKE $${idx}`).join(' OR ');
      const termParts = [`(${ors})`];
      if (skuLike) {
        termParts.push(`lower(CAST(${fieldPrefix}product_data AS TEXT)) LIKE $${idx}`);
      }
      whereParts.push(`(${termParts.join(' OR ')})`);
      idx += 1;
    }
    return {
      params,
      idx,
      queryWhere: whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE',
    };
  };
  const toRankedUniqueProducts = (rows = []) => {
    const rawProducts = (rows || [])
      .map((row) => {
        const product = row.product_data;
        if (!product) return null;

        const merchantId = String(row.merchant_id || '').trim();
        const merchantName = row.merchant_name ? String(row.merchant_name).trim() : '';
        const out = { ...product };
        if (merchantId && !out.merchant_id && !out.merchantId) out.merchant_id = merchantId;
        if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
        return out;
      })
      .filter(Boolean)
      .filter((product) => isProductSellable(product, { inStockOnly }));

    const scored = rawProducts
      .map((product) => {
        const title = String(product.title || '').toLowerCase();
        const desc = String(product.description || '').toLowerCase();
        const ptype = String(product.product_type || product.productType || '').toLowerCase();
        const sku = String(product.sku || '').toLowerCase();
        const tags = Array.isArray(product.tags) ? product.tags.join(' ').toLowerCase() : String(product.tags || '').toLowerCase();
        const blob = `${title} ${ptype} ${sku} ${tags} ${desc}`;

        let score = 0;
        for (const t of terms) {
          if (title.includes(t)) score += 3;
          else if (ptype.includes(t)) score += 2;
          else if (blob.includes(t)) score += 1;
        }
        score += scoreByTagFacetOverlap(terms, product).score;
        if (skuLike) {
          const q0 = q.replace(/[^a-z0-9-]+/g, '');
          if (q0 && sku === q0) score += 6;
          else if (q0 && blob.includes(q0)) score += 3;
        }
        return { product, score };
      })
      .sort((a, b) => b.score - a.score);

    const seen = new Set();
    const unique = [];
    for (const row of scored) {
      const product = row.product;
      const mid = String(product.merchant_id || product.merchantId || '').trim();
      const pid = String(product.id || product.product_id || product.productId || '').trim();
      const key = `${mid}::${pid || JSON.stringify(product).slice(0, 64)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(product);
      if (unique.length >= safeLimit) break;
    }
    return { products: unique, candidateCount: rawProducts.length };
  };

  const strictFilter = buildQueryFilter('pc.');
  const queryWhere = strictFilter.queryWhere;
  const baseWhere = `
    (pc.expires_at IS NULL OR pc.expires_at > now())
    AND ${buildSellableStatusPredicate("pc.product_data->>'status'")}
    AND mo.status NOT IN ('deleted', 'rejected')
    AND mo.psp_connected = true
  `;

  const pageFetch = Math.min(Math.max(safeLimit * 4, 80), 400);
  const pageOffset = Math.max(0, offset);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM products_cache pc
    JOIN merchant_onboarding mo
      ON mo.merchant_id = pc.merchant_id
    WHERE ${baseWhere}
      AND ${queryWhere}
  `;

  const rowsSql = `
    SELECT pc.merchant_id,
           mo.business_name AS merchant_name,
           pc.product_data
    FROM products_cache pc
    JOIN merchant_onboarding mo
      ON mo.merchant_id = pc.merchant_id
    WHERE ${baseWhere}
      AND ${queryWhere}
    ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
    OFFSET $${strictFilter.idx}
    LIMIT $${strictFilter.idx + 1}
  `;

  const retrievalSources = [];
  const [countRes, rowsRes] = await Promise.all([
    query(countSql, strictFilter.params),
    query(rowsSql, [...strictFilter.params, pageOffset, pageFetch]),
  ]);

  const strictTotal = Number(countRes.rows?.[0]?.total || 0);
  const strictRanked = toRankedUniqueProducts(rowsRes.rows || []);
  retrievalSources.push({
    source: 'lexical_cache',
    used: true,
    count: strictRanked.products.length,
    candidate_count: strictRanked.candidateCount,
    total: strictTotal,
  });

  if (strictRanked.products.length > 0) {
    await applyShopifyCurrencyOverride(strictRanked.products);
    return {
      products: strictRanked.products,
      total: strictTotal,
      page: safePage,
      page_size: strictRanked.products.length,
      retrieval_sources: retrievalSources,
    };
  }

  try {
    const relaxedFilter = buildQueryFilter('');
    const relaxedBaseWhere = `
      (expires_at IS NULL OR expires_at > now())
      AND ${buildSellableStatusPredicate("product_data->>'status'")}
      AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
    `;
    const relaxedCountSql = `
      SELECT COUNT(*)::int AS total
      FROM products_cache
      WHERE ${relaxedBaseWhere}
        AND ${relaxedFilter.queryWhere}
    `;
    const relaxedRowsSql = `
      SELECT merchant_id,
             NULL::text AS merchant_name,
             product_data
      FROM products_cache
      WHERE ${relaxedBaseWhere}
        AND ${relaxedFilter.queryWhere}
      ORDER BY cached_at DESC NULLS LAST, id DESC
      OFFSET $${relaxedFilter.idx}
      LIMIT $${relaxedFilter.idx + 1}
    `;
    const [relaxedCountRes, relaxedRowsRes] = await Promise.all([
      query(relaxedCountSql, relaxedFilter.params),
      query(relaxedRowsSql, [...relaxedFilter.params, pageOffset, pageFetch]),
    ]);
    const relaxedTotal = Number(relaxedCountRes.rows?.[0]?.total || 0);
    const relaxedRanked = toRankedUniqueProducts(relaxedRowsRes.rows || []);
    retrievalSources.push({
      source: 'lexical_cache_relaxed_no_onboarding',
      used: true,
      count: relaxedRanked.products.length,
      candidate_count: relaxedRanked.candidateCount,
      total: relaxedTotal,
    });

    if (relaxedRanked.products.length === 0 && hasPetSearchSignal(q)) {
      const preferHarnessResults = hasPetHarnessSearchSignal(q);
      const petSignalFilter = preferHarnessResults
        ? buildPetHarnessSignalSql(1)
        : buildPetSignalSql(1);
      const petRowsSql = `
        SELECT pc.merchant_id,
               mo.business_name AS merchant_name,
               pc.product_data
        FROM products_cache pc
        JOIN merchant_onboarding mo
          ON mo.merchant_id = pc.merchant_id
        WHERE ${baseWhere}
          AND ${petSignalFilter.sql}
        ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
        OFFSET $${petSignalFilter.nextIndex}
        LIMIT $${petSignalFilter.nextIndex + 1}
      `;
      const petRowsRes = await query(
        petRowsSql,
        [...petSignalFilter.params, pageOffset, pageFetch],
      );
      const petRanked = toRankedUniqueProducts(petRowsRes.rows || []);
      retrievalSources.push({
        source: preferHarnessResults ? 'pet_harness_browse_fallback' : 'pet_browse_fallback',
        used: true,
        count: petRanked.products.length,
        candidate_count: petRanked.candidateCount,
      });

      if (petRanked.products.length > 0) {
        await applyShopifyCurrencyOverride(petRanked.products);
        return {
          products: petRanked.products,
          total: Math.max(strictTotal, relaxedTotal, petRanked.products.length),
          page: safePage,
          page_size: petRanked.products.length,
          retrieval_sources: retrievalSources,
        };
      }
    }

    if (relaxedRanked.products.length === 0 && hasBeautyMakeupSearchSignal(q)) {
      const beautySignalFilter = buildBeautySignalSql(1);
      const beautyRowsSql = `
        SELECT pc.merchant_id,
               mo.business_name AS merchant_name,
               pc.product_data
        FROM products_cache pc
        JOIN merchant_onboarding mo
          ON mo.merchant_id = pc.merchant_id
        WHERE ${baseWhere}
          AND ${beautySignalFilter.sql}
        ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
        OFFSET $${beautySignalFilter.nextIndex}
        LIMIT $${beautySignalFilter.nextIndex + 1}
      `;
      const beautyRowsRes = await query(
        beautyRowsSql,
        [...beautySignalFilter.params, pageOffset, pageFetch],
      );
      const beautyRanked = toRankedUniqueProducts(beautyRowsRes.rows || []);
      retrievalSources.push({
        source: 'beauty_browse_fallback',
        used: true,
        count: beautyRanked.products.length,
        candidate_count: beautyRanked.candidateCount,
      });

      if (beautyRanked.products.length > 0) {
        await applyShopifyCurrencyOverride(beautyRanked.products);
        return {
          products: beautyRanked.products,
          total: Math.max(strictTotal, relaxedTotal, beautyRanked.products.length),
          page: safePage,
          page_size: beautyRanked.products.length,
          retrieval_sources: retrievalSources,
        };
      }
    }

    await applyShopifyCurrencyOverride(relaxedRanked.products);
    return {
      products: relaxedRanked.products,
      total: Math.max(strictTotal, relaxedTotal, relaxedRanked.products.length),
      page: safePage,
      page_size: relaxedRanked.products.length,
      retrieval_sources: retrievalSources,
    };
  } catch (err) {
    retrievalSources.push({
      source: 'lexical_cache_relaxed_no_onboarding',
      used: false,
      error: String(err && err.message ? err.message : err),
    });
    return {
      products: [],
      total: strictTotal,
      page: safePage,
      page_size: 0,
      retrieval_sources: retrievalSources,
    };
  }
}

async function loadCrossMerchantBrowseFromCache(page = 1, limit = 20, options = {}) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(Math.max(1, Number(limit || 20)), 100);
  const inStockOnly = options?.inStockOnly !== false;

  // Oversample so JS-level filtering (in-stock-only, de-dupe) can still fill the page.
  const fetchLimit = Math.min(Math.max(safeLimit * Math.max(safePage, 1) * 5 + 20, 50), 500);

  const rowsRes = await query(
    `
      SELECT pc.merchant_id,
             mo.business_name AS merchant_name,
             pc.product_data
      FROM (
        SELECT id, expires_at, merchant_id, product_data
        FROM products_cache
        WHERE expires_at > now()
          AND ${buildSellableStatusPredicate("product_data->>'status'")}
        ORDER BY expires_at DESC, id DESC
        LIMIT $1
      ) pc
      JOIN merchant_onboarding mo
        ON mo.merchant_id = pc.merchant_id
      WHERE mo.status NOT IN ('deleted', 'rejected')
        AND mo.psp_connected = true
      ORDER BY pc.expires_at DESC, pc.id DESC
    `,
    [fetchLimit],
  );

  const baseProducts = (rowsRes.rows || [])
    .map((r) => {
      const p = r.product_data;
      if (!p) return null;
      const mid = String(r.merchant_id || '').trim();
      const merchantName = r.merchant_name ? String(r.merchant_name).trim() : '';

      const out = { ...p };
      if (mid && !out.merchant_id && !out.merchantId) out.merchant_id = mid;
      if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
      return out;
    })
    .filter(Boolean)
    .filter((p) => isProductSellable(p, { inStockOnly }));

  const seen = new Set();
  const unique = [];
  for (const p of baseProducts) {
    const mid = String(p.merchant_id || p.merchantId || '').trim();
    const pid = String(p.id || p.product_id || p.productId || '').trim();
    const key = `${mid}::${pid || JSON.stringify(p).slice(0, 64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  const startIdx = (safePage - 1) * safeLimit;
  const pageItems = unique.slice(startIdx, startIdx + safeLimit);

  await applyShopifyCurrencyOverride(pageItems);

  return {
    products: pageItems,
    total: unique.length,
    page: safePage,
    page_size: pageItems.length,
  };
}

async function loadMerchantBrowseFromCache(merchantId, page = 1, limit = 20, options = {}) {
  const mid = String(merchantId || '').trim();
  if (!mid) return { products: [], total: 0, page: 1, page_size: 0 };

  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(Math.max(1, Number(limit || 20)), 100);
  const inStockOnly = options?.inStockOnly !== false;

  // Oversample so JS-level filtering (in-stock-only, de-dupe) can still fill the page.
  const fetchLimit = Math.min(Math.max(safeLimit * Math.max(safePage, 1) * 6 + 30, 60), 600);

  const rowsRes = await query(
    `
      SELECT pc.id,
             pc.merchant_id,
             mo.business_name AS merchant_name,
             pc.product_data
      FROM products_cache pc
      JOIN merchant_onboarding mo
        ON mo.merchant_id = pc.merchant_id
      WHERE pc.merchant_id = $1
        AND (pc.expires_at IS NULL OR pc.expires_at > now())
        AND ${buildSellableStatusPredicate("pc.product_data->>'status'")}
        AND mo.status NOT IN ('deleted', 'rejected')
        AND mo.psp_connected = true
      ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
      LIMIT $2
    `,
    [mid, fetchLimit],
  );

  const baseProducts = (rowsRes.rows || [])
    .map((r) => {
      const p = r.product_data;
      if (!p) return null;
      const merchantName = r.merchant_name ? String(r.merchant_name).trim() : '';

      const out = { ...p };
      if (!out.merchant_id && !out.merchantId) out.merchant_id = mid;
      if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
      return out;
    })
    .filter(Boolean)
    .filter((p) => isProductSellable(p, { inStockOnly }));

  const seen = new Set();
  const unique = [];
  for (const p of baseProducts) {
    const pid = String(p.id || p.product_id || p.productId || '').trim();
    const key = `${mid}::${pid || JSON.stringify(p).slice(0, 64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  const startIdx = (safePage - 1) * safeLimit;
  const pageItems = unique.slice(startIdx, startIdx + safeLimit);

  await applyShopifyCurrencyOverride(pageItems);

  return {
    products: pageItems,
    total: unique.length,
    page: safePage,
    page_size: pageItems.length,
  };
}

function buildPetFallbackQuery(intent, rawUserQuery) {
  const lang = intent?.language || 'en';
  const queryText = String(rawUserQuery || '');
  const wantsHarness = hasPetHarnessSearchSignal(queryText);
  switch (lang) {
    case 'zh':
      return wantsHarness ? '狗 狗狗 宠物 背带 牵引绳 狗链' : '狗 狗狗 宠物 外套 衣服';
    case 'es':
      return wantsHarness ? 'perro arnes correa collar' : 'perro ropa abrigo chaqueta';
    case 'fr':
      return wantsHarness ? 'chien harnais laisse collier' : 'chien vêtement manteau veste';
    case 'ja':
      return wantsHarness ? '犬 ハーネス リード 首輪' : '犬 犬服 服';
    default:
      return wantsHarness ? 'dog harness dog leash dog collar' : 'dog jacket dog clothes';
  }
}

async function loadCreatorProductFromCache(creatorId, productId) {
  const config = getCreatorConfig(creatorId);
  if (!config || !Array.isArray(config.merchantIds) || config.merchantIds.length === 0) return null;
  const pid = String(productId || '').trim();
  if (!pid) return null;

  const res = await query(
    `
      SELECT product_data
      FROM products_cache
      WHERE merchant_id = ANY($1)
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          product_data->>'id' = $2
          OR product_data->>'product_id' = $2
          OR product_data->>'productId' = $2
        )
      ORDER BY cached_at DESC
      LIMIT 1
    `,
    [config.merchantIds, pid],
  );
  return res.rows?.[0]?.product_data || null;
}

async function findSimilarCreatorFromCache(creatorId, productId, limit = 9) {
  const base = await loadCreatorProductFromCache(creatorId, productId);
  if (!base) return null;

  const baseTitle = String(base.title || '').toLowerCase();
  const baseDesc = String(base.description || '').toLowerCase();
  const baseType = String(base.product_type || base.productType || '').toLowerCase();
  const baseTags = Array.isArray(base.tags) ? base.tags.join(' ').toLowerCase() : String(base.tags || '').toLowerCase();
  const baseRecTags = Array.isArray(base.recommendation_meta?.tags)
    ? base.recommendation_meta.tags.join(' ').toLowerCase()
    : '';
  const baseRecFacets = base.recommendation_meta?.facets ? JSON.stringify(base.recommendation_meta.facets).toLowerCase() : '';
  const baseBlob = `${baseTitle} ${baseType} ${baseTags} ${baseRecTags} ${baseRecFacets} ${baseDesc}`.trim();

  const baseToy = /\b(labubu|doll|plush|toy|collectible)\b/.test(baseBlob);
  const baseUnderwear = /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(baseBlob);

  const anchor = [];
  if (baseBlob.includes('labubu')) anchor.push('labubu');
  if (/\bdoll\b/.test(baseBlob)) anchor.push('doll');
  if (/\boutfit\b/.test(baseBlob)) anchor.push('outfit');
  if (anchor.length === 0) {
    // Prefer tags/facets (more stable than title words), then fallback to title tokens.
    const tagTokens = [];
    if (Array.isArray(base.tags)) tagTokens.push(...base.tags);
    if (Array.isArray(base.recommendation_meta?.tags)) tagTokens.push(...base.recommendation_meta.tags);
    const facets = base.recommendation_meta?.facets || {};
    for (const v of Object.values(facets)) {
      if (!v) continue;
      if (Array.isArray(v)) tagTokens.push(...v);
      else tagTokens.push(v);
    }
    anchor.push(...tokenizeQueryForCache(tagTokens.join(' ')).slice(0, 6));
    if (anchor.length < 3) anchor.push(...tokenizeQueryForCache(baseTitle).slice(0, 3));
  }

  const queryText = anchor.join(' ');
  const found = await searchCreatorSellableFromCache(creatorId, queryText, 1, Math.min(Math.max(6, limit * 3), 60));
  const candidates = (found.products || []).filter((p) => String(p.id || p.product_id || '') !== String(productId));

  const filtered = candidates.filter((p) => {
    const t = `${String(p.title || '').toLowerCase()} ${String(p.description || '').toLowerCase()} ${String(
      p.product_type || p.productType || '',
    ).toLowerCase()}`;
    const isUnderwear = /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(t);
    if (baseToy && !baseUnderwear && isUnderwear) return false;
    return true;
  });

  const ranked = filtered
    .map((p) => ({ p, score: scorePairOverlap(base, p).score }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);

  return {
    base_product_id: String(productId),
    strategy_used: 'cache_creator_similar',
    items: ranked.slice(0, Math.max(1, Number(limit || 9))).map((p) => ({ product: p })),
  };
}

function extractCreatorId(payload) {
  if (!payload) return null;
  return (
    payload.creator_id ||
    payload.creatorId ||
    payload.metadata?.creator_id ||
    payload.metadata?.creatorId ||
    payload.search?.creator_id ||
    payload.similar?.creator_id ||
    null
  );
}

function getDefaultCreatorId() {
  const env =
    process.env.DEFAULT_CREATOR_ID ||
    process.env.CREATOR_ID ||
    '';
  const trimmed = String(env || '').trim();
  if (trimmed) return trimmed;

  const first =
    Array.isArray(CREATOR_CONFIGS) &&
    CREATOR_CONFIGS[0] &&
    CREATOR_CONFIGS[0].creatorId
      ? String(CREATOR_CONFIGS[0].creatorId).trim()
      : '';
  return first || null;
}

function normalizeMetadata(rawMetadata = {}, payload = {}) {
  let creatorId =
    rawMetadata.creator_id ||
    rawMetadata.creatorId ||
    payload.creator_id ||
    payload.creatorId ||
    payload.search?.creator_id ||
    null;

  const creatorName =
    rawMetadata.creator_name ||
    rawMetadata.creatorName ||
    payload.creator_name ||
    payload.creatorName ||
    null;

  const traceId =
    rawMetadata.trace_id ||
    rawMetadata.traceId ||
    payload.trace_id ||
    payload.traceId ||
    null;

  const source = rawMetadata.source || payload.source || 'shopping-agent-ui';

  // Creator cache routes require a known creator_id. When the caller is the
  // creator UI and doesn't provide one, default to the first configured creator
  // so cache-based search works out of the box.
  if (!creatorId && isCreatorUiSource(source)) {
    creatorId = getDefaultCreatorId();
  }

  return {
    ...rawMetadata,
    ...(creatorId && { creator_id: creatorId, creatorId }),
    ...(creatorName && { creator_name: creatorName, creatorName }),
    ...(traceId && { trace_id: traceId, traceId }),
    ...(source && { source }),
  };
}

// CORS configuration - allow UI to call Gateway
// NOTE: Must run BEFORE body parsing so browser clients still receive CORS headers
// even when JSON parsing fails (otherwise Aurora Chatbox sees "No Access-Control-Allow-Origin").
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const defaults = [
    'https://look-replicator.pivota.cc',
    'https://aurora.pivota.cc',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ];

  const fromEnv = String(process.env.ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedOrigins = new Set([...defaults, ...fromEnv]);

  // Prevent CDN/proxy caching from mixing preflight responses across different
  // requested headers/methods.
  res.header('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');

  const isAllowedOrigin = origin && origin !== 'null' && allowedOrigins.has(origin);
  if (isAllowedOrigin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // Allow both legacy and newer header names used by clients (Creator UI / SDKs).
  // Also echo requested headers to avoid preflight failures when browsers add new ones.
  const baseAllowedHeaders = [
    'content-type',
    'authorization',
    'x-api-key',
    'x-agent-api-key',
    'x-checkout-token',

    // Aurora Chatbox / Glow integration headers
    'x-aurora-uid',
    'x-aurora-lang',
    'x-trace-id',
    'x-brief-id',
    'x-lang',
    'x-session-id',
  ];
  const requested = String(req.headers['access-control-request-headers'] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = Array.from(new Set([...baseAllowedHeaders, ...requested]))
    .map((h) => h
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-'))
    .join(', ');
  res.header('Access-Control-Allow-Headers', allowedHeaders);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Body parser with error handling
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf);
    } catch(e) {
      throw new Error('Invalid JSON');
    }
  }
}));

// Add a lightweight build marker for debugging deployments (no secrets).
app.use((req, res, next) => {
  if (SERVICE_GIT_SHA) res.setHeader('X-Service-Commit', SERVICE_GIT_SHA.slice(0, 12));
  if (SERVICE_GIT_BRANCH) res.setHeader('X-Service-Branch', SERVICE_GIT_BRANCH);
  res.setHeader('X-Service-Name', SERVICE_NAME);
  return next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Lightweight request logging.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
});

const healthRouteHandler = (req, res) => {
  const dbConfigured = Boolean(process.env.DATABASE_URL);
  const taxonomyEnabled = process.env.TAXONOMY_ENABLED !== 'false';
  const minSellable = Math.max(Number(process.env.HEALTHZ_MIN_SELLABLE_PRODUCTS || 20) || 20, 0);
  const includeCacheStats = process.env.HEALTHZ_INCLUDE_CACHE_STATS === 'true';

  const creatorIdForStats = process.env.HEALTHZ_CACHE_STATS_CREATOR_ID || 'nina-studio';
  const creatorConfig = getCreatorConfig(creatorIdForStats);
  const merchantIds = uniqueStrings(creatorConfig?.merchantIds || []);

  const cacheStatsPromise =
    includeCacheStats && dbConfigured && merchantIds.length
      ? probeCreatorCacheDbStats(merchantIds, 'unknown', { force: true })
      : Promise.resolve(null);

  cacheStatsPromise
    .then((cacheStats) => {
      const sellable = cacheStats && typeof cacheStats.products_cache_sellable_total === 'number'
        ? cacheStats.products_cache_sellable_total
        : null;
      const cacheWarning = typeof sellable === 'number' ? sellable < minSellable : null;

      res.json({
    ok: true,
    use_mock: USE_MOCK,
    port: PORT,
    api_mode: API_MODE,
    modes: {
      mock: USE_MOCK,
      hybrid: USE_HYBRID,
      real_api_enabled: REAL_API_ENABLED
    },
    version: {
      service: SERVICE_NAME,
      commit: SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null,
      branch: SERVICE_GIT_BRANCH || null,
      started_at: SERVICE_STARTED_AT,
    },
    backend: {
      api_base: PIVOTA_API_BASE,
      api_key_configured: !!PIVOTA_API_KEY,
      db_configured: dbConfigured,
      taxonomy_enabled: taxonomyEnabled,
      taxonomy_view_id: process.env.TAXONOMY_VIEW_ID || 'GLOBAL_FASHION',
      taxonomy_version: process.env.TAXONOMY_VERSION || null,
    },
    resolve_product_candidates_cache: snapshotResolveProductCandidatesCacheStats(),
    resolve_product_group_cache: snapshotResolveProductGroupCacheStats(),
    product_detail_cache: snapshotProductDetailCacheStats(),
    pdp_v2_core_hot_cache: snapshotPdpV2CoreHotCacheStats(),
    pdp_recommendations_cache: getPdpRecsCacheStats(),
    products_available: true,
    catalog_cache: includeCacheStats
      ? {
          creator_id: creatorIdForStats,
          merchant_ids: merchantIds,
          min_sellable_products: minSellable,
          warning: cacheWarning,
          stats: cacheStats,
        }
      : undefined,
    catalog_sync: {
      enabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      interval_minutes: getCreatorCatalogAutoSyncIntervalConfig().intervalMinutes,
      interval_minutes_max: getCreatorCatalogAutoSyncIntervalConfig().maxIntervalMinutes,
      cache_ttl_seconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
      request_timeout_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
      request_timeout_max_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS,
      retry_attempts: CREATOR_CATALOG_AUTO_SYNC_RETRIES,
      retry_backoff_ms: CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
      non_retryable_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
      invalid_merchant_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS,
      target_source: catalogSyncState.target_source,
      target_count: catalogSyncState.target_count,
      target_eligible_count: catalogSyncState.target_eligible_count,
      target_suppressed_count: catalogSyncState.target_suppressed_count,
      target_sample: catalogSyncState.target_sample,
      target_suppressed_sample: catalogSyncState.target_suppressed_sample,
      last_run_at: catalogSyncState.last_run_at,
      last_success_at: catalogSyncState.last_success_at,
      last_error: catalogSyncState.last_error,
      per_merchant: summarizeCatalogSyncMerchantState(),
    },
    features: {
      product_search: true,
      order_creation: true,
      payment: USE_MOCK || USE_HYBRID ? 'mock' : 'real',
      tracking: true,
      layer1_compatibility: true,
      find_products_multi_vector_enabled:
        process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true',
    },
    message: `Running in ${API_MODE} mode. ${USE_MOCK ? 'Using internal mock products.' : USE_HYBRID ? 'Real products, mock payment.' : 'Full real API integration.'}`
      });
    })
    .catch((err) => {
      logger.warn({ err: err.message }, 'healthz cache stats probe failed');
      res.json({
        ok: true,
        api_mode: API_MODE,
        version: {
          service: SERVICE_NAME,
          commit: SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null,
          branch: SERVICE_GIT_BRANCH || null,
          started_at: SERVICE_STARTED_AT,
        },
        backend: { api_base: PIVOTA_API_BASE, api_key_configured: !!PIVOTA_API_KEY, db_configured: dbConfigured },
        resolve_product_candidates_cache: snapshotResolveProductCandidatesCacheStats(),
        resolve_product_group_cache: snapshotResolveProductGroupCacheStats(),
        product_detail_cache: snapshotProductDetailCacheStats(),
        pdp_v2_core_hot_cache: snapshotPdpV2CoreHotCacheStats(),
        pdp_recommendations_cache: getPdpRecsCacheStats(),
        products_available: true,
        warning: 'healthz_cache_stats_failed',
      });
    });
};

app.get('/healthz', healthRouteHandler);
app.get('/health', healthRouteHandler);

app.get('/version', (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    commit: SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null,
    full_sha: SERVICE_GIT_SHA || null,
    branch: SERVICE_GIT_BRANCH || null,
    started_at: SERVICE_STARTED_AT,
  });
});

app.get('/healthz/db', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(200).json({ ok: true, db_ready: false, reason: 'DATABASE_URL not configured' });
  }
  try {
    await query('SELECT 1');
    return res.status(200).json({ ok: true, db_ready: true });
  } catch (err) {
    return res.status(200).json({ ok: true, db_ready: false, error: err.message });
  }
});

// ---------------- Look Replicator (agent task) ----------------

mountLookReplicatorRoutes(app, { logger });

// ---------------- Telemetry (US): Outcome signals ----------------

mountOutcomeTelemetryRoutes(app, { logger });

// ---------------- Telemetry (internal): Look Replicator events ----------------

mountLookReplicatorEventRoutes(app, { logger });

// ---------------- Telemetry (internal): Aurora Chatbox UI events ----------------

mountUiEventRoutes(app, { logger });

// ---------------- Layer 3: External offers (external-first) ----------------

mountExternalOfferRoutes(app);

// ---------------- Recommendations: role → feed ----------------

mountRecommendationRoutes(app);

// ---------------- Aurora BFF (Lifecycle Skincare Partner) ----------------

mountAuroraBffRoutes(app, { logger });

// ---------------- Layer 1 (US): Compatibility ----------------

mountLayer1CompatibilityRoutes(app, { logger });
mountLayer1BundleRoutes(app, { logger });

// ---------------- Creator-scoped category APIs ----------------

app.get('/creator/:creatorId/categories', async (req, res) => {
  const creatorId = req.params.creatorId;
  const includeCounts =
    req.query.includeCounts === undefined ? true : req.query.includeCounts !== 'false';
  const includeEmpty = req.query.includeEmpty === 'true';
  const dealsOnly = req.query.dealsOnly === 'true';
  const locale = req.query.locale ? String(req.query.locale) : undefined;
  const viewId = req.query.view ? String(req.query.view) : undefined;

  try {
    const tree = await buildCreatorCategoryTree(creatorId, {
      includeCounts,
      includeEmpty,
      dealsOnly,
      ...(locale ? { locale } : {}),
      ...(viewId ? { viewId } : {}),
    });
    return res.json(tree);
  } catch (err) {
    if (err.code === 'UNKNOWN_CREATOR') {
      return res.status(404).json({ error: 'Unknown creator' });
    }
    logger.error({ err: err.message, creatorId }, 'Failed to build creator category tree');
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

app.get('/creator/:creatorId/categories/:categorySlug/products', async (req, res) => {
  const creatorId = req.params.creatorId;
  const categorySlug = req.params.categorySlug;
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const locale = req.query.locale ? String(req.query.locale) : undefined;
  const viewId = req.query.view ? String(req.query.view) : undefined;

  try {
    const result = await getCreatorCategoryProducts(creatorId, categorySlug, {
      page,
      limit,
      ...(locale ? { locale } : {}),
      ...(viewId ? { viewId } : {}),
    });
    return res.json(result);
  } catch (err) {
    if (err.code === 'UNKNOWN_CREATOR') {
      return res.status(404).json({ error: 'Unknown creator' });
    }
    if (err.code === 'UNKNOWN_CATEGORY') {
      return res.status(404).json({ error: 'Unknown category' });
    }
    logger.error(
      { err: err.message, creatorId, categorySlug },
      'Failed to load creator category products'
    );
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Lightweight debug endpoint to inspect promotions configuration on the gateway.
// Safe for now: does NOT return any secrets, only booleans and mode.
app.get('/debug/promotions-config', (req, res) => {
  const promoBackendBase =
    process.env.PROMOTIONS_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '';
  const promoMode = process.env.PROMOTIONS_MODE || 'local';
  const useRemotePromo = !!promoBackendBase && promoMode !== 'local';
  const promoAdminKeyPresent =
    !!(process.env.PROMOTIONS_ADMIN_KEY || process.env.ADMIN_API_KEY);

  res.json({
    promoMode,
    promoBackendBase,
    useRemotePromo,
    promoAdminKeyPresent,
  });
});

// Debug endpoint: inspect the raw promotions as seen by the gateway.
// Protected by the same admin key as /api/merchant/promotions.
app.get('/debug/promotions', requireAdmin, async (req, res) => {
  try {
    const promos = await getAllPromotions();
    res.json(promos);
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load promotions in debug endpoint');
    res.status(500).json({ error: 'FAILED_TO_LOAD_PROMOTIONS', message: err.message });
  }
});

// ---------------- Merchant promotions admin API (v0, admin-key protected) ----------------

app.get('/api/merchant/promotions', requireAdmin, async (req, res) => {
  try {
    const { status, type, channel, creatorId, search } = req.query;
    const nowTs = Date.now();
    const allPromos = await getAllPromotions();
    const promotions = allPromos
      .filter((p) => !p.deletedAt)
      .filter((p) => {
        if (type && p.type !== type) return false;
        if (channel && (!Array.isArray(p.channels) || !p.channels.includes(channel))) return false;
        if (creatorId) {
          if (p.exposeToCreators === false) return false;
          if (p.allowedCreatorIds?.length && !p.allowedCreatorIds.includes(creatorId))
            return false;
        }
        if (search) {
          const s = String(search).toLowerCase();
          const name = (p.name || '').toLowerCase();
          const desc = (p.description || '').toLowerCase();
          if (!name.includes(s) && !desc.includes(s)) return false;
        }
        if (status) {
          const currentStatus = computePromotionStatus(p, nowTs);
          if (currentStatus !== status) return false;
        }
        return true;
      })
      .map((p) => ({
        ...sanitizePromotionForResponse(p),
        humanReadableRule: computeHumanReadableRule(p),
        status: computePromotionStatus(p, nowTs),
      }));

    res.json({ promotions, total: promotions.length });
  } catch (err) {
    logger.error(
      { err: err?.message || String(err) },
      'Failed to list merchant promotions'
    );
    return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
  }
});

app.get('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const promo = await getPromotionById(req.params.id);
    if (!promo || promo.deletedAt) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    const nowTs = Date.now();
    return res.json({
      promotion: {
        ...sanitizePromotionForResponse(promo),
        humanReadableRule: computeHumanReadableRule(promo),
        status: computePromotionStatus(promo, nowTs),
      },
    });
  } catch (err) {
    logger.error(
      { err: err?.message || String(err), promoId: req.params.id },
      'Failed to fetch merchant promotion'
    );
    return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
  }
});

app.post('/api/merchant/promotions', requireAdmin, async (req, res) => {
  try {
    const { promotion, error } = validateAndNormalizePromotion(req.body, {}, { requireAll: true });
    if (error) {
      return res.status(400).json({ error: 'INVALID_PROMOTION', message: error });
    }
    const nowTs = Date.now();
    await upsertPromotion(promotion);
    return res.status(201).json({
      promotion: {
        ...sanitizePromotionForResponse(promotion),
        status: computePromotionStatus(promotion, nowTs),
      },
    });
  } catch (err) {
    const { code, message } = extractUpstreamErrorCode(err);
    const status = (err && err.response && err.response.status) || err?.status || 502;
    logger.error(
      { status, code, err: message || err?.message || String(err) },
      'Failed to create merchant promotion'
    );
    return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
  }
});

app.patch('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await getPromotionById(req.params.id);
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    const { promotion, error } = validateAndNormalizePromotion(
      { ...req.body, id: existing.id },
      existing,
      { requireAll: true }
    );
    if (error) {
      return res.status(400).json({ error: 'INVALID_PROMOTION', message: error });
    }
    const nowTs = Date.now();
    await upsertPromotion(promotion);
    return res.json({
      promotion: {
        ...sanitizePromotionForResponse(promotion),
        status: computePromotionStatus(promotion, nowTs),
      },
    });
  } catch (err) {
    const { code, message } = extractUpstreamErrorCode(err);
    const status = (err && err.response && err.response.status) || err?.status || 502;
    logger.error(
      { status, code, err: message || err?.message || String(err), promoId: req.params.id },
      'Failed to update merchant promotion'
    );
    return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
  }
});

app.delete('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await softDeletePromotion(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    return res.json({ ok: true });
  } catch (err) {
    const { code, message } = extractUpstreamErrorCode(err);
    const status = (err && err.response && err.response.status) || err?.status || 502;
    logger.error(
      { status, code, err: message || err?.message || String(err), promoId: req.params.id },
      'Failed to delete merchant promotion'
    );
    return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
  }
});

// ---------------- Merchant risk ops API (v0, admin-key protected) ----------------

app.get('/api/merchant/disputes', requireAdmin, async (req, res) => {
  const { merchantId, orderId, status, source, limit, offset } = req.query;
  try {
    const resp = await fetchBackendAdmin({
      method: 'GET',
      path: '/agent/internal/disputes',
      params: {
        ...(merchantId ? { merchantId } : {}),
        ...(orderId ? { orderId } : {}),
        ...(status ? { status } : {}),
        ...(source ? { source } : {}),
        ...(limit ? { limit } : {}),
        ...(offset ? { offset } : {}),
      },
    });
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 500;
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_FETCH_DISPUTES',
      message: message || 'Failed to fetch disputes',
      details: data || null,
    });
  }
});

app.post('/api/merchant/disputes/sync', requireAdmin, async (req, res) => {
  const orderId = req.body?.orderId || req.body?.order_id;
  const limit = req.body?.limit;

  if (!orderId) {
    return res.status(400).json({ error: 'MISSING_ORDER_ID', message: 'orderId is required' });
  }

  try {
    const resp = await fetchBackendAdmin({
      method: 'POST',
      path: '/agent/internal/disputes/sync',
      params: {
        orderId,
        ...(limit ? { limit } : {}),
      },
    });
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 500;
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_SYNC_DISPUTES',
      message: message || 'Failed to sync disputes',
      details: data || null,
    });
  }
});

app.get('/api/merchant/returns', requireAdmin, async (req, res) => {
  const { merchantId, status, limit, offset } = req.query;
  try {
    const resp = await fetchBackendAdmin({
      method: 'GET',
      path: '/agent/internal/returns',
      params: {
        ...(merchantId ? { merchantId } : {}),
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
        ...(offset ? { offset } : {}),
      },
    });
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 500;
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_FETCH_RETURNS',
      message: message || 'Failed to fetch returns',
      details: data || null,
    });
  }
});

app.post('/api/merchant/returns/sync', requireAdmin, async (req, res) => {
  const merchantId = req.body?.merchantId || req.body?.merchant_id;
  const limit = req.body?.limit;
  const apiVersion = req.body?.apiVersion || req.body?.api_version;

  if (!merchantId) {
    return res.status(400).json({ error: 'MISSING_MERCHANT_ID', message: 'merchantId is required' });
  }

  try {
    const resp = await fetchBackendAdmin({
      method: 'POST',
      path: '/agent/internal/returns/sync',
      params: {
        merchantId,
        ...(limit ? { limit } : {}),
        ...(apiVersion ? { apiVersion } : {}),
      },
    });
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 500;
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_SYNC_RETURNS',
      message: message || 'Failed to sync returns',
      details: data || null,
    });
  }
});

// ---------------- Photo uploads (selfie) + QC ----------------

async function proxyPhotosToBackend(req, res) {
  const checkoutToken =
    String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

  const url = `${PIVOTA_API_BASE}${req.path}`;
  const method = String(req.method || 'GET').toUpperCase();

  try {
    const resp = await axios({
      method,
      url,
      headers: {
        ...(method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(checkoutToken
          ? { 'X-Checkout-Token': checkoutToken }
          : {
              ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
              ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
            }),
      },
      timeout: UPSTREAM_TIMEOUT_ADMIN_MS,
      ...(method === 'GET' || method === 'DELETE' ? { params: req.query } : { data: req.body }),
      validateStatus: () => true,
    });

    return res.status(resp.status).json(resp.data);
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 500;
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_PROXY_PHOTOS',
      message: message || 'Failed to proxy photo upload request',
      details: data || null,
    });
  }
}

app.post('/photos/presign', proxyPhotosToBackend);
app.post('/photos/confirm', proxyPhotosToBackend);
app.get('/photos/qc', proxyPhotosToBackend);
app.delete('/photos', proxyPhotosToBackend);

// ---------------- Agent search proxy (PDP resolution) ----------------

// Aurora Chatbox uses this to resolve `merchant_id` for a given `product_id`/name so it can open PDP.
// Keep it lightweight: pass-through query params; server-side auth only.
async function proxyAgentSearchToBackend(req, res) {
  const checkoutToken =
    String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

  const url = `${PIVOTA_API_BASE}${req.path}`;
  const { queryText, queryParams } = normalizeSearchQueryParams(req.query);
  const source = String(firstQueryParamValue(req.query?.source) || '').trim().toLowerCase();
  const auroraFallbackOverrides = getAuroraFallbackOverrides(source, 'find_products_multi');
  const guardedQueryParams = applyShoppingCatalogQueryGuards(queryParams, source);
  const resolverTimeoutMs = getProxySearchResolverTimeoutMs(source);
  const secondaryFallbackTimeoutMs = getProxySearchFallbackTimeoutMs(source);
  const resolverFirstMetadata = source ? { source } : null;
  const traceId = randomUUID();
  const startedAtMs = Date.now();
  const normalizedQuery = String(queryText || '').trim();
  const resolverStage = {
    called: false,
    hit: false,
    miss: false,
    latency_ms: null,
  };
  const cacheStage = {
    hit: false,
    candidate_count: 0,
    relevant_count: 0,
    retrieval_sources: [],
  };

  const respondSearch = (
    status,
    body,
    {
      finalDecision = 'upstream_returned',
      primaryPathUsed = 'proxy_search_primary',
      fallbackTriggered = false,
      fallbackReason = null,
      upstreamStage = null,
      strictEmptyReason = null,
      expansionMode = 'off',
      expandedQuery = normalizedQuery,
      intent = null,
      fallbackStrategy = null,
    } = {},
  ) => {
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    let out = withSearchDiagnostics(body, {
      route_health: buildSearchRouteHealth({
        primaryPathUsed,
        primaryLatencyMs: latencyMs,
        fallbackTriggered,
        fallbackReason,
      }),
      search_trace: buildSearchTrace({
        traceId,
        rawQuery: normalizedQuery,
        expandedQuery,
        expansionMode,
        intent,
        cacheStage,
        upstreamStage,
        resolverStage,
        finalDecision,
      }),
      ...(fallbackStrategy && typeof fallbackStrategy === 'object'
        ? { fallback_strategy: fallbackStrategy }
        : {}),
      ...(strictEmptyReason
        ? {
            strict_empty: true,
            strict_empty_reason: strictEmptyReason,
          }
        : {}),
    });

    if (
      SEARCH_STRICT_EMPTY_ENABLED &&
      normalizedQuery &&
      Array.isArray(out?.products) &&
      out.products.length === 0 &&
      !out?.metadata?.strict_empty
    ) {
      out = withSearchDiagnostics(out, {
        strict_empty: true,
        strict_empty_reason: strictEmptyReason || 'no_candidates',
      });
    }
    return res.status(status).json(out);
  };

  let resolverFirstResult = null;
  const shouldAttemptResolverFirst = shouldUseResolverFirstSearch({
      operation: 'find_products_multi',
      metadata: resolverFirstMetadata,
      queryText,
  }) && PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;

  if (shouldAttemptResolverFirst) {
    resolverStage.called = true;
    const resolverStartedAtMs = Date.now();
    try {
      resolverFirstResult = await withStageBudget(
        queryResolveSearchFallback({
        queryParams: guardedQueryParams,
        checkoutToken,
        reason: 'resolver_first',
        timeoutMs: resolverTimeoutMs,
        }),
        FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
        'resolver_stage',
      );
      resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
      if (
        resolverFirstResult &&
        resolverFirstResult.status >= 200 &&
        resolverFirstResult.status < 300 &&
        resolverFirstResult.usableCount > 0
      ) {
        resolverStage.hit = true;
        return respondSearch(resolverFirstResult.status, resolverFirstResult.data, {
          finalDecision: 'resolver_returned',
          primaryPathUsed: 'resolver_first',
          fallbackTriggered: true,
          fallbackReason: 'resolver_first',
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
        });
      }
      resolverStage.miss = true;
    } catch (resolverErr) {
      resolverStage.miss = true;
      resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
      logger.warn(
        { err: resolverErr?.message || String(resolverErr) },
        'proxy agent search resolver-first failed; falling back to upstream',
      );
    }
  }

  try {
    const basePrimaryTimeoutMs = getProxySearchPrimaryTimeoutMs(source, Math.min(
      getUpstreamTimeoutMs('find_products_multi'),
      PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
    ));
    const primaryTimeoutMs =
      shouldReducePrimaryTimeoutAfterResolverMiss(resolverFirstResult, queryText)
        ? Math.min(basePrimaryTimeoutMs, PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS)
        : basePrimaryTimeoutMs;
    const skipSecondaryFallback = shouldSkipSecondaryFallbackAfterResolverMiss(
      resolverFirstResult,
      queryText,
      {
        disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
      },
    );
    const allowSecondaryFallback = shouldAllowSecondaryFallback('find_products_multi', {
      forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
    });
    const allowResolverFallback = shouldAllowResolverFallback('find_products_multi');
    const allowInvokeFallback = true;
    const fallbackStrategy = {
      source: auroraFallbackOverrides.strategySource,
      request_source: source || null,
      resolver_attempted: false,
      secondary_attempted: false,
      secondary_skipped_reason: null,
      allow_secondary_fallback: allowSecondaryFallback,
      allow_invoke_fallback: allowInvokeFallback,
      skip_secondary_after_resolver_miss: skipSecondaryFallback,
      aurora_external_seed_forced: Boolean(auroraFallbackOverrides.active),
      aurora_external_seed_enabled: Boolean(
        auroraFallbackOverrides.active && PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      ),
      aurora_seed_strategy: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
        : null,
      fallback_adopt_usable_threshold: null,
    };

    const upstreamStartedAtMs = Date.now();
    const resp = await axios({
      method: 'GET',
      url,
      params: guardedQueryParams,
      headers: {
        ...(checkoutToken
          ? { 'X-Checkout-Token': checkoutToken }
          : {
              ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
              ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
            }),
      },
      timeout: primaryTimeoutMs,
      validateStatus: () => true,
    });
    const upstreamStage = {
      called: true,
      timeout: false,
      status: Number(resp?.status || 0) || 0,
      latency_ms: Math.max(0, Date.now() - upstreamStartedAtMs),
    };

    const normalized = normalizeAgentProductsListResponse(resp.data, {
      limit: parseQueryNumber(guardedQueryParams?.limit ?? guardedQueryParams?.page_size),
      offset: parseQueryNumber(guardedQueryParams?.offset),
    });
    const primaryUsableCount = countUsableSearchProducts(normalized?.products);
    const primaryUnusable = Boolean(queryText) && shouldFallbackProxySearch(normalized, resp.status);
    const primaryRelevant = queryText ? isProxySearchFallbackRelevant(normalized, queryText) : true;
    const primaryIrrelevant = Boolean(queryText) && primaryUsableCount > 0 && !primaryRelevant;
    const shouldFallback = primaryUnusable || primaryIrrelevant;
    const fallbackAdoptUsableThreshold = getFallbackAdoptUsableThreshold({
      source,
      primaryUsableCount,
      primaryIrrelevant,
    });
    fallbackStrategy.fallback_adopt_usable_threshold = fallbackAdoptUsableThreshold;

    if (shouldFallback) {
      if (allowResolverFallback && !skipSecondaryFallback) {
        fallbackStrategy.resolver_attempted = true;
        try {
          const resolverFallback = await queryResolveSearchFallback({
            queryParams: guardedQueryParams,
            checkoutToken,
            reason: 'resolver_after_primary',
            timeoutMs: resolverTimeoutMs,
          });
          if (
            resolverFallback &&
            resolverFallback.status >= 200 &&
            resolverFallback.status < 300 &&
            resolverFallback.usableCount > 0
          ) {
            resolverStage.hit = true;
            return respondSearch(resolverFallback.status, resolverFallback.data, {
              finalDecision: 'resolver_returned',
              primaryPathUsed: 'proxy_search_primary',
              fallbackTriggered: true,
              fallbackReason: 'resolver_after_primary',
              upstreamStage,
              fallbackStrategy,
            });
          }
        } catch (resolverErr) {
          logger.warn(
            { err: resolverErr?.message || String(resolverErr) },
            'proxy agent search resolver fallback failed; keeping primary response',
          );
        }
      }

      if (allowSecondaryFallback && allowInvokeFallback && !skipSecondaryFallback) {
        fallbackStrategy.secondary_attempted = true;
        try {
          const fallback = await queryFindProductsMultiFallback({
            queryParams: guardedQueryParams,
            checkoutToken,
            reason: primaryUnusable
              ? primaryUsableCount > 0
                ? 'insufficient_primary'
                : 'empty_or_unusable_primary'
              : 'primary_irrelevant',
            requestSource: source,
            timeoutMs: secondaryFallbackTimeoutMs,
          });
          if (
            fallback &&
            fallback.status >= 200 &&
            fallback.status < 300 &&
            fallback.usableCount >= fallbackAdoptUsableThreshold &&
            isProxySearchFallbackRelevant(fallback.data, queryText)
          ) {
            return respondSearch(fallback.status, fallback.data, {
              finalDecision: 'upstream_returned',
              primaryPathUsed: 'proxy_search_primary',
              fallbackTriggered: true,
              fallbackReason: primaryUnusable ? 'secondary_after_primary_unusable' : 'secondary_after_primary_irrelevant',
              upstreamStage,
              fallbackStrategy,
            });
          }
        } catch (fallbackErr) {
          logger.warn(
            { err: fallbackErr?.message || String(fallbackErr) },
            'proxy agent search fallback invoke failed; keeping primary response',
          );
        }
      } else if (!allowSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'secondary_disabled';
      } else if (!allowInvokeFallback) {
        fallbackStrategy.secondary_skipped_reason = 'invoke_fallback_disabled';
      } else if (skipSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'resolver_miss_skip_secondary';
      }
    }

    if (primaryIrrelevant && Number(resp.status) >= 200 && Number(resp.status) < 300) {
      const reason = skipSecondaryFallback ? 'primary_irrelevant_skip_secondary' : 'primary_irrelevant_no_fallback';
      return respondSearch(
        200,
        withStrictEmptyFallback({
          body: normalized,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: resp.status,
          route: 'proxy_search_primary_irrelevant',
        }),
        {
          finalDecision: 'strict_empty',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage,
          strictEmptyReason: reason,
          fallbackStrategy,
        },
      );
    }

    if (Number(resp.status) >= 500) {
      const reason = 'primary_status_5xx';
      return respondSearch(
        200,
        withStrictEmptyFallback({
          body: normalized,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: resp.status,
          route: 'proxy_search_primary_status',
        }),
        {
          finalDecision: 'strict_empty',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage,
          strictEmptyReason: reason,
          fallbackStrategy,
        },
      );
    }

    return respondSearch(
      resp.status,
      withProxySearchFallbackMetadata(normalized, {
        applied: false,
        reason:
          primaryIrrelevant
            ? skipSecondaryFallback
              ? 'primary_irrelevant_skip_secondary'
              : 'primary_irrelevant_no_fallback'
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : shouldFallback
              ? 'fallback_not_better'
              : 'not_needed',
      }),
      {
        finalDecision:
          Array.isArray(normalized?.products) && normalized.products.length > 0
            ? 'upstream_returned'
            : 'strict_empty',
        primaryPathUsed: 'proxy_search_primary',
        fallbackTriggered: Boolean(shouldFallback),
        fallbackReason:
          primaryIrrelevant
            ? skipSecondaryFallback
              ? 'primary_irrelevant_skip_secondary'
              : 'primary_irrelevant_no_fallback'
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : shouldFallback
              ? 'fallback_not_better'
              : null,
        upstreamStage,
        strictEmptyReason:
          Array.isArray(normalized?.products) && normalized.products.length > 0
            ? null
            : shouldFallback && skipSecondaryFallback
            ? 'resolver_miss_skip_secondary'
            : 'no_candidates',
        fallbackStrategy,
      },
    );
  } catch (err) {
    const skipSecondaryFallback = shouldSkipSecondaryFallbackAfterResolverMiss(
      resolverFirstResult,
      queryText,
      {
        disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
      },
    );
    const allowSecondaryFallback = shouldAllowSecondaryFallback('find_products_multi', {
      forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
    });
    const allowResolverFallback = shouldAllowResolverFallback('find_products_multi');
    const allowInvokeFallback = true;
    const bypassSkipSecondaryFallback = shouldBypassSecondaryFallbackSkipOnPrimaryException({ err });
    const allowResolverFallbackOnException =
      allowResolverFallback && (!skipSecondaryFallback || bypassSkipSecondaryFallback);
    const allowSecondaryFallbackOnException =
      allowSecondaryFallback &&
      allowInvokeFallback &&
      (!skipSecondaryFallback || bypassSkipSecondaryFallback);
    const fallbackStrategy = {
      source: auroraFallbackOverrides.strategySource,
      request_source: source || null,
      resolver_attempted: false,
      secondary_attempted: false,
      secondary_skipped_reason: null,
      allow_secondary_fallback: allowSecondaryFallback,
      allow_invoke_fallback: allowInvokeFallback,
      skip_secondary_after_resolver_miss: skipSecondaryFallback,
      bypass_skip_after_exception: bypassSkipSecondaryFallback,
      aurora_external_seed_forced: Boolean(auroraFallbackOverrides.active),
      aurora_external_seed_enabled: Boolean(
        auroraFallbackOverrides.active && PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      ),
      aurora_seed_strategy: auroraFallbackOverrides.active
        ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
        : null,
    };
    if (queryText) {
      if (allowResolverFallbackOnException) {
        fallbackStrategy.resolver_attempted = true;
        try {
          const resolverStartedAtMs = Date.now();
          resolverStage.called = true;
          const resolverFallback = await queryResolveSearchFallback({
            queryParams: guardedQueryParams,
            checkoutToken,
            reason: 'resolver_after_exception',
            timeoutMs: resolverTimeoutMs,
          });
          resolverStage.latency_ms = Math.max(0, Date.now() - resolverStartedAtMs);
          if (
            resolverFallback &&
            resolverFallback.status >= 200 &&
            resolverFallback.status < 300 &&
            resolverFallback.usableCount > 0
          ) {
            resolverStage.hit = true;
            return respondSearch(resolverFallback.status, resolverFallback.data, {
              finalDecision: 'resolver_returned',
              primaryPathUsed: 'proxy_search_primary',
              fallbackTriggered: true,
              fallbackReason: 'resolver_after_exception',
              upstreamStage: {
                called: true,
                timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
                status: Number(err?.response?.status || err?.status || 0) || 0,
                latency_ms: Math.max(0, Date.now() - startedAtMs),
              },
              fallbackStrategy,
            });
          }
          resolverStage.miss = true;
        } catch (resolverErr) {
          resolverStage.miss = true;
          logger.warn(
            { err: resolverErr?.message || String(resolverErr) },
            'proxy agent search resolver fallback failed after primary exception',
          );
        }
      }

      if (allowSecondaryFallbackOnException) {
        fallbackStrategy.secondary_attempted = true;
        try {
          const fallback = await queryFindProductsMultiFallback({
            queryParams: guardedQueryParams,
            checkoutToken,
            reason: 'primary_request_failed',
            requestSource: source,
            timeoutMs: secondaryFallbackTimeoutMs,
          });
          if (
            fallback &&
            fallback.status >= 200 &&
            fallback.status < 300 &&
            fallback.usableCount > 0 &&
            isProxySearchFallbackRelevant(fallback.data, queryText)
          ) {
            return respondSearch(fallback.status, fallback.data, {
              finalDecision: 'upstream_returned',
              primaryPathUsed: 'proxy_search_primary',
              fallbackTriggered: true,
              fallbackReason: 'secondary_after_exception',
              upstreamStage: {
                called: true,
                timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
                status: Number(err?.response?.status || err?.status || 0) || 0,
                latency_ms: Math.max(0, Date.now() - startedAtMs),
              },
              fallbackStrategy,
            });
          }
        } catch (fallbackErr) {
          logger.warn(
            { err: fallbackErr?.message || String(fallbackErr) },
            'proxy agent search fallback invoke failed after primary exception',
          );
        }
      } else if (!allowSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'secondary_disabled';
      } else if (!allowInvokeFallback) {
        fallbackStrategy.secondary_skipped_reason = 'invoke_fallback_disabled';
      } else if (skipSecondaryFallback && !bypassSkipSecondaryFallback) {
        fallbackStrategy.secondary_skipped_reason = 'resolver_miss_skip_secondary';
      }
    }

    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || (err?.code === 'ECONNABORTED' ? 504 : 500);
    if (queryText) {
      const reason = err?.code === 'ECONNABORTED' ? 'primary_timeout' : 'primary_exception';
      return respondSearch(
        200,
        withStrictEmptyFallback({
          body: null,
          queryParams: guardedQueryParams,
          reason,
          upstreamStatus: statusCode,
          upstreamCode: code || err?.code || null,
          upstreamMessage: message || err?.message || null,
          route: 'proxy_search_exception',
        }),
        {
          finalDecision: 'strict_empty',
          primaryPathUsed: 'proxy_search_primary',
          fallbackTriggered: true,
          fallbackReason: reason,
          upstreamStage: {
            called: true,
            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
            status: Number(statusCode || 0) || 0,
            latency_ms: Math.max(0, Date.now() - startedAtMs),
          },
          strictEmptyReason: reason,
          fallbackStrategy,
        },
      );
    }
    return res.status(statusCode).json({
      error: code || 'FAILED_TO_PROXY_AGENT_SEARCH',
      message: message || 'Failed to proxy agent search request',
      details: data || null,
    });
  }
}

app.get('/agent/v1/products/search', proxyAgentSearchToBackend);
app.get('/agent/v1/beauty/products/search', (req, res) => {
  const mergedQuery =
    req.query && typeof req.query === 'object' && !Array.isArray(req.query)
      ? { ...req.query }
      : {};
  if (!String(firstQueryParamValue(mergedQuery.source) || '').trim()) {
    mergedQuery.source = 'aurora-bff';
  }
  if (!String(firstQueryParamValue(mergedQuery.catalog_surface) || '').trim()) {
    mergedQuery.catalog_surface = 'beauty';
  }
  const queryString = buildQueryString(mergedQuery);
  return res.redirect(307, `/agent/v1/products/search${queryString}`);
});

// ---------------- Product grounding resolver (Aurora recos → PDP-openable product_ref) ----------------

function normalizeResolveLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'en';
  if (s === 'cn' || s === 'zh' || s === 'zh-cn' || s === 'zh_hans') return 'cn';
  return 'en';
}

function pickResolveOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const prefer =
    o.prefer_merchants ||
    o.preferMerchants ||
    o.prefer_merchant_ids ||
    o.preferMerchantIds ||
    undefined;
  return {
    ...(prefer ? { prefer_merchants: prefer } : {}),
    ...(o.search_all_merchants !== undefined ? { search_all_merchants: o.search_all_merchants } : {}),
    ...(o.searchAllMerchants !== undefined ? { search_all_merchants: o.searchAllMerchants } : {}),
    ...(o.allow_external_seed !== undefined ? { allow_external_seed: o.allow_external_seed } : {}),
    ...(o.allowExternalSeed !== undefined ? { allow_external_seed: o.allowExternalSeed } : {}),
    ...(o.timeout_ms !== undefined ? { timeout_ms: o.timeout_ms } : {}),
    ...(o.timeoutMs !== undefined ? { timeout_ms: o.timeoutMs } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
    ...(o.candidates_limit !== undefined ? { candidates_limit: o.candidates_limit } : {}),
    ...(o.candidatesLimit !== undefined ? { candidates_limit: o.candidatesLimit } : {}),
    ...(o.min_confidence !== undefined ? { min_confidence: o.min_confidence } : {}),
    ...(o.minConfidence !== undefined ? { min_confidence: o.minConfidence } : {}),
    ...(o.upstream_retries !== undefined ? { upstream_retries: o.upstream_retries } : {}),
    ...(o.upstreamRetries !== undefined ? { upstream_retries: o.upstreamRetries } : {}),
    ...(o.upstream_retry_backoff_ms !== undefined ? { upstream_retry_backoff_ms: o.upstream_retry_backoff_ms } : {}),
    ...(o.upstreamRetryBackoffMs !== undefined ? { upstream_retry_backoff_ms: o.upstreamRetryBackoffMs } : {}),
    ...(o.stable_alias_short_circuit !== undefined ? { stable_alias_short_circuit: o.stable_alias_short_circuit } : {}),
    ...(o.stableAliasShortCircuit !== undefined ? { stable_alias_short_circuit: o.stableAliasShortCircuit } : {}),
    ...(o.allow_stable_alias_for_uuid !== undefined ? { allow_stable_alias_for_uuid: o.allow_stable_alias_for_uuid } : {}),
    ...(o.allowStableAliasForUuid !== undefined ? { allow_stable_alias_for_uuid: o.allowStableAliasForUuid } : {}),
  };
}

function normalizeResolveFailureCode(raw, fallback = 'no_candidates') {
  const code = String(raw || '').trim().toLowerCase();
  if (code === 'db_error' || code === 'upstream_timeout' || code === 'no_candidates') return code;
  return fallback;
}

function inferResolveFailureCode({ result, err } = {}) {
  const explicit = normalizeResolveFailureCode(
    result?.reason_code || result?.reasonCode || result?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(result?.reason || '').trim().toLowerCase();
  if (reason === 'no_candidates' || reason === 'low_confidence' || reason === 'empty_query') return 'no_candidates';
  if (reason.startsWith('db_') || reason === 'products_cache_missing') return 'db_error';
  if (reason.includes('timeout') || reason.startsWith('upstream_') || reason === 'upstream_error') return 'upstream_timeout';

  const sourceReasons = Array.isArray(result?.metadata?.sources)
    ? result.metadata.sources
        .map((item) => String(item && item.reason ? item.reason : '').trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (sourceReasons.some((r) => r.startsWith('db_') || r === 'products_cache_missing')) return 'db_error';
  if (sourceReasons.some((r) => r.includes('timeout') || r.startsWith('upstream_'))) return 'upstream_timeout';

  const errText = String(err?.code || err?.message || err || '').trim().toLowerCase();
  if (errText.includes('timeout') || errText.includes('econnaborted') || errText.includes('etimedout')) {
    return 'upstream_timeout';
  }
  if (errText.includes('db_') || errText.includes('database') || errText.includes('postgres')) {
    return 'db_error';
  }
  return 'no_candidates';
}

app.post('/agent/v1/products/resolve', async (req, res) => {
  const checkoutToken =
    String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const queryText = String(
    body.query ||
      body.product_id ||
      body.productId ||
      body.sku_id ||
      body.skuId ||
      '',
  ).trim();
  const lang = normalizeResolveLang(body.lang);
  let options = pickResolveOptions(body.options);
  const hints = body.hints && typeof body.hints === 'object' && !Array.isArray(body.hints) ? body.hints : null;

  if (!queryText) {
    return res.status(400).json({
      error: 'MISSING_PARAMETERS',
      message: 'query is required',
    });
  }

  // Aurora Chatbox should remain merchant-agnostic. If callers don't specify prefer_merchants,
  // default to the server-side creator catalog merchants (when available) so we can resolve
  // via products_cache instead of timing out on upstream search.
  const callerHint = String(body.caller || '').trim().toLowerCase();
  const hasAuroraUid = Boolean(String(req.header('X-Aurora-Uid') || req.header('x-aurora-uid') || '').trim());
  const origin = String(req.headers.origin || '').trim();
  const shouldDefaultPreferMerchants =
    callerHint === 'aurora_chatbox' || callerHint === 'aurora-chatbox' || hasAuroraUid || origin === 'https://aurora.pivota.cc';
  if (shouldDefaultPreferMerchants) {
    if (options.stable_alias_short_circuit === undefined) {
      options = { ...options, stable_alias_short_circuit: true };
    }
    if (options.allow_stable_alias_for_uuid === undefined) {
      options = { ...options, allow_stable_alias_for_uuid: true };
    }
  }
  const preferMerchantsRaw = options?.prefer_merchants;
  const hasPreferMerchants =
    (Array.isArray(preferMerchantsRaw) && preferMerchantsRaw.length > 0) ||
    (typeof preferMerchantsRaw === 'string' && preferMerchantsRaw.trim().length > 0);
  if (shouldDefaultPreferMerchants && !hasPreferMerchants) {
    const defaultMerchantsResult = await resolveCatalogSyncMerchantIds();
    const defaultMerchants = defaultMerchantsResult.merchantIds;
    if (defaultMerchants.length) {
      options = {
        ...options,
        prefer_merchants: defaultMerchants,
        ...(options.search_all_merchants === undefined ? { search_all_merchants: true } : {}),
        ...(options.upstream_retries === undefined ? { upstream_retries: 0 } : {}),
      };
    }
  }

  try {
    const result = await resolveProductRef({
      query: queryText,
      lang,
      hints,
      options,
      pivotaApiBase: PIVOTA_API_BASE,
      pivotaApiKey: PIVOTA_API_KEY,
      checkoutToken,
    });

    const unresolvedReasonCode = !result?.resolved ? inferResolveFailureCode({ result }) : null;
    const responsePayload =
      !result?.resolved && unresolvedReasonCode
        ? {
            ...result,
            reason_code: unresolvedReasonCode,
            metadata: {
              ...(result?.metadata && typeof result.metadata === 'object' ? result.metadata : {}),
              resolve_reason_code: unresolvedReasonCode,
            },
          }
        : result;

    // Best-effort: record gaps for ops restock (do not block the UI).
    if (!responsePayload?.resolved) {
      const caller =
        String(body.caller || req.header('X-Caller') || req.header('User-Agent') || '')
          .trim()
          .slice(0, 120) || null;
      const sessionId =
        String(body.session_id || body.sessionId || req.header('X-Session-Id') || req.header('x-session-id') || '')
          .trim()
          .slice(0, 120) || null;
      const event = {
        query: queryText,
        normalized_query: responsePayload?.normalized_query || null,
        lang,
        hints,
        caller,
        session_id: sessionId,
        reason: responsePayload?.reason || 'unresolved',
        reason_code: unresolvedReasonCode || null,
        timestamp: new Date().toISOString(),
      };
      logger.info({ event_name: 'missing_catalog_product', ...event }, 'missing_catalog_product');
      upsertMissingCatalogProduct(event).catch((err) => {
        logger.warn({ err: err?.message || String(err) }, 'missing_catalog_product upsert failed');
      });
    }

    return res.json(responsePayload);
  } catch (err) {
    const reasonCode = inferResolveFailureCode({ err });
    logger.warn({ err: err?.message || String(err) }, 'products.resolve failed; returning unresolved');
    return res.json({
      resolved: false,
      product_ref: null,
      confidence: 0,
      reason: 'internal_error',
      reason_code: reasonCode,
      candidates: [],
      normalized_query: queryText,
      metadata: {
        lang,
        error: 'internal_error',
        resolve_reason_code: reasonCode,
      },
    });
  }
});

function offersResolveIsRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function offersResolvePickFirstTrimmed(...values) {
  for (const raw of values) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s) return s;
  }
  return '';
}

function offersResolveIsUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim());
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeOffersResolveReasonCode(raw, fallback = 'no_candidates') {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return fallback;
  if (OFFERS_RESOLVE_REASON_CODE_SET.has(token)) return token;
  if (
    token === 'db_error' ||
    token === 'db_query_timeout' ||
    token === 'products_cache_missing' ||
    token.startsWith('db_') ||
    token.includes('database') ||
    token.includes('postgres')
  ) {
    return 'db_timeout';
  }
  if (
    token === 'timeout' ||
    token === 'upstream_error' ||
    token.startsWith('upstream_') ||
    token.includes('timed out') ||
    token.includes('timeout')
  ) {
    return 'upstream_timeout';
  }
  if (
    token === 'no_result' ||
    token === 'no_results' ||
    token === 'not_found' ||
    token === 'not_found_in_cache' ||
    token === 'low_confidence' ||
    token === 'empty_query'
  ) {
    return 'no_candidates';
  }
  if (token === 'mapped' || token === 'mapped_direct' || token === 'cache_hit') return 'mapped_hit';
  if (token === 'subject_hit' || token === 'subject_match') return 'subject_direct';
  if (token === 'canonical_direct' || token === 'canonical_ref_hit') return 'canonical_ref_direct';
  if (
    token === 'stable_alias' ||
    token === 'stable_alias_ref' ||
    token === 'stable_alias_match' ||
    token === 'alias_exact' ||
    token === 'alias_fuzzy'
  ) {
    return 'stable_alias_ref';
  }
  if (token === 'external_fallback') return 'fallback_external';
  return fallback;
}

function inferOffersResolveFailureReasonCode({ responseBody, statusCode, error } = {}) {
  const explicit = normalizeOffersResolveReasonCode(
    responseBody?.reason_code ||
      responseBody?.reasonCode ||
      responseBody?.metadata?.reason_code ||
      responseBody?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(
    responseBody?.reason ||
      responseBody?.error ||
      responseBody?.code ||
      responseBody?.message ||
      '',
  )
    .trim()
    .toLowerCase();
  if (reason) {
    const mapped = normalizeOffersResolveReasonCode(reason, '');
    if (mapped) return mapped;
  }

  const sourceReasons = Array.isArray(responseBody?.metadata?.sources)
    ? responseBody.metadata.sources
        .map((s) => String(s?.reason || '').trim().toLowerCase())
        .filter(Boolean)
    : [];
  for (const sourceReason of sourceReasons) {
    const mapped = normalizeOffersResolveReasonCode(sourceReason, '');
    if (mapped) return mapped;
  }

  const status = Number(statusCode || 0);
  if (status === 408 || status === 429 || status >= 500) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (
    errText.includes('timeout') ||
    errText.includes('econnaborted') ||
    errText.includes('etimedout')
  ) {
    return 'upstream_timeout';
  }
  if (errText.includes('database') || errText.includes('postgres') || errText.includes('db_')) {
    return 'db_timeout';
  }

  return 'no_candidates';
}

function normalizeOffersResolveCanonicalProductRef(input, { allowOpaqueProductId = false } = {}) {
  const ref = offersResolveIsRecord(input) ? input : null;
  if (!ref) return null;
  const productId = offersResolvePickFirstTrimmed(ref.product_id, ref.productId);
  const merchantId = offersResolvePickFirstTrimmed(ref.merchant_id, ref.merchantId);
  if (!productId || !merchantId) return null;
  if (!allowOpaqueProductId && offersResolveIsUuidLike(productId)) return null;
  return {
    product_id: productId,
    merchant_id: merchantId,
  };
}

function extractOffersResolveSubjectProductGroupId(input) {
  const subject = offersResolveIsRecord(input) ? input : null;
  if (!subject) return '';
  const type = offersResolvePickFirstTrimmed(subject.type).toLowerCase();
  const id = offersResolvePickFirstTrimmed(subject.id);
  if (type === 'product_group' && id) return id;
  return offersResolvePickFirstTrimmed(subject.product_group_id, subject.productGroupId, id);
}

function buildOffersResolveExternalSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return 'https://www.google.com/';
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function buildOffersResolvePdpTargetGroup(productGroupId, canonicalProductRef = null) {
  const pgid = offersResolvePickFirstTrimmed(productGroupId);
  if (!pgid) return null;
  return {
    schema: 'pdp_target.v1',
    type: 'internal',
    path: 'group',
    subject: {
      type: 'product_group',
      id: pgid,
      product_group_id: pgid,
    },
    ...(canonicalProductRef ? { canonical_product_ref: canonicalProductRef } : {}),
    get_pdp_v2_payload: {
      subject: {
        type: 'product_group',
        id: pgid,
      },
    },
  };
}

function buildOffersResolvePdpTargetRef(canonicalProductRef, { path = 'ref' } = {}) {
  const ref = normalizeOffersResolveCanonicalProductRef(canonicalProductRef, {
    allowOpaqueProductId: false,
  });
  if (!ref) return null;
  const normalizedPath = String(path || '').trim().toLowerCase() === 'resolve' ? 'resolve' : 'ref';
  return {
    schema: 'pdp_target.v1',
    type: 'internal',
    path: normalizedPath,
    product_ref: ref,
    canonical_product_ref: ref,
    get_pdp_v2_payload: {
      product_ref: ref,
    },
  };
}

function buildOffersResolvePdpTargetExternal(query, reasonCode = null) {
  const normalizedReason = reasonCode
    ? normalizeOffersResolveReasonCode(reasonCode, 'fallback_external')
    : null;
  return {
    schema: 'pdp_target.v1',
    type: 'external',
    path: 'external',
    external: {
      provider: 'google',
      target: '_blank',
      url: buildOffersResolveExternalSearchUrl(query),
      query: String(query || '').trim() || null,
    },
    ...(normalizedReason ? { reason_code: normalizedReason } : {}),
  };
}

function normalizeOffersResolvePdpTargetV1(rawTarget, { fallbackQuery = '' } = {}) {
  const target = offersResolveIsRecord(rawTarget) ? rawTarget : null;
  if (!target) return null;

  const rawPath = offersResolvePickFirstTrimmed(target.path, target.mode).toLowerCase();
  const rawSubject = offersResolveIsRecord(target.subject) ? target.subject : null;
  const subjectProductGroupId =
    extractOffersResolveSubjectProductGroupId(rawSubject) ||
    offersResolvePickFirstTrimmed(target.product_group_id, target.productGroupId);
  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(target.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(target.product_ref, {
      allowOpaqueProductId: false,
    });

  if (rawPath === 'group' && subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if ((rawPath === 'ref' || rawPath === 'resolve') && canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: rawPath });
  }
  if (rawPath === 'external') {
    const query = offersResolvePickFirstTrimmed(
      target?.external?.query,
      target?.external?.search_query,
      fallbackQuery,
    );
    return buildOffersResolvePdpTargetExternal(query, target.reason_code);
  }

  if (subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if (canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: 'ref' });
  }
  return null;
}

function extractOffersResolvePdpTargetFromResponse(responseBody, { fallbackQuery = '' } = {}) {
  const body = offersResolveIsRecord(responseBody) ? responseBody : null;
  if (!body) return null;

  const explicitTargets = [
    body?.pdp_target?.v1,
    body?.pdpTarget?.v1,
    body?.mapping?.pdp_target?.v1,
    body?.mapping?.pdpTarget?.v1,
  ];
  for (const candidateTarget of explicitTargets) {
    const normalized = normalizeOffersResolvePdpTargetV1(candidateTarget, { fallbackQuery });
    if (normalized) return normalized;
  }

  const subjectProductGroupId = offersResolvePickFirstTrimmed(
    extractOffersResolveSubjectProductGroupId(body.subject),
    extractOffersResolveSubjectProductGroupId(body.mapping?.subject),
    body.product_group_id,
    body.productGroupId,
    body.mapping?.product_group_id,
    body.mapping?.productGroupId,
  );
  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(body.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.mapping?.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(body.mapping?.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(
      {
        product_id: offersResolvePickFirstTrimmed(
          body.canonical_product?.product_id,
          body.canonical_product?.productId,
          body.canonical_product?.id,
          body.mapping?.canonical_product?.product_id,
          body.mapping?.canonical_product?.productId,
          body.mapping?.canonical_product?.id,
          body.mapping?.canonicalProduct?.product_id,
          body.mapping?.canonicalProduct?.productId,
          body.mapping?.canonicalProduct?.id,
        ),
        merchant_id: offersResolvePickFirstTrimmed(
          body.canonical_product?.merchant_id,
          body.canonical_product?.merchantId,
          body.canonical_product?.merchant?.merchant_id,
          body.mapping?.canonical_product?.merchant_id,
          body.mapping?.canonical_product?.merchantId,
          body.mapping?.canonical_product?.merchant?.merchant_id,
          body.mapping?.canonicalProduct?.merchant_id,
          body.mapping?.canonicalProduct?.merchantId,
          body.mapping?.canonicalProduct?.merchant?.merchant_id,
        ),
      },
      {
        allowOpaqueProductId: false,
      },
    );

  if (subjectProductGroupId) {
    return buildOffersResolvePdpTargetGroup(subjectProductGroupId, canonicalProductRef || null);
  }
  if (canonicalProductRef) {
    return buildOffersResolvePdpTargetRef(canonicalProductRef, { path: 'ref' });
  }

  return null;
}

function normalizeOffersResolveInput(rawPayload) {
  const payload = offersResolveIsRecord(rawPayload) ? rawPayload : {};
  const offersPayload =
    offersResolveIsRecord(payload.offers) && Object.keys(payload.offers).length > 0
      ? payload.offers
      : payload;
  const product = offersResolveIsRecord(offersPayload.product) ? offersPayload.product : {};
  const subject =
    (offersResolveIsRecord(offersPayload.subject) ? offersPayload.subject : null) ||
    (offersResolveIsRecord(product.subject) ? product.subject : null);

  const subjectProductGroupId = offersResolvePickFirstTrimmed(
    extractOffersResolveSubjectProductGroupId(subject),
    offersPayload.product_group_id,
    offersPayload.productGroupId,
    product.product_group_id,
    product.productGroupId,
  );

  const canonicalProductRef =
    normalizeOffersResolveCanonicalProductRef(offersPayload.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(offersPayload.product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(product.canonical_product_ref, {
      allowOpaqueProductId: false,
    }) ||
    normalizeOffersResolveCanonicalProductRef(product.product_ref, {
      allowOpaqueProductId: false,
    });

  const rawProductId = offersResolvePickFirstTrimmed(
    product.product_id,
    product.productId,
    offersPayload.product_id,
    offersPayload.productId,
  );
  const rawSkuId = offersResolvePickFirstTrimmed(
    product.sku_id,
    product.skuId,
    offersPayload.sku_id,
    offersPayload.skuId,
  );
  const rawMerchantId = offersResolvePickFirstTrimmed(
    product.merchant_id,
    product.merchantId,
    offersPayload.merchant_id,
    offersPayload.merchantId,
  );
  const brand = offersResolvePickFirstTrimmed(product.brand, offersPayload.brand);
  const name = offersResolvePickFirstTrimmed(product.name, product.title, offersPayload.name, offersPayload.title);
  const displayName = offersResolvePickFirstTrimmed(
    product.display_name,
    product.displayName,
    offersPayload.display_name,
    offersPayload.displayName,
    name,
  );

  let queryText = offersResolvePickFirstTrimmed(
    offersPayload.query,
    product.query,
    offersPayload.search_query,
    product.search_query,
  );
  if (!queryText) {
    if (brand && displayName) queryText = `${brand} ${displayName}`.trim();
    else {
      queryText = offersResolvePickFirstTrimmed(
        displayName,
        name,
        brand,
        rawProductId,
        rawSkuId,
      );
    }
  }

  const limitRaw = offersPayload.limit ?? payload.limit;
  const limit = Math.min(Math.max(1, Number(limitRaw || 10) || 10), 50);
  const market = offersResolvePickFirstTrimmed(offersPayload.market, payload.market) || null;
  const tool = offersResolvePickFirstTrimmed(offersPayload.tool, payload.tool) || null;

  return {
    offers_payload: offersPayload,
    product,
    subject_product_group_id: subjectProductGroupId || null,
    canonical_product_ref: canonicalProductRef || null,
    raw_product_id: rawProductId || null,
    raw_sku_id: rawSkuId || null,
    raw_merchant_id: rawMerchantId || null,
    legacy_opaque_id:
      (rawProductId && offersResolveIsUuidLike(rawProductId)) ||
      (rawSkuId && offersResolveIsUuidLike(rawSkuId)),
    market,
    tool,
    limit,
    query_text: queryText || '',
    brand: brand || null,
    name: name || null,
    display_name: displayName || null,
    has_any_identifier: Boolean(
      subjectProductGroupId ||
        canonicalProductRef ||
        rawProductId ||
        rawSkuId ||
        queryText,
    ),
  };
}

function resolveOffersResolveStableAliasRef(normalizedInput) {
  if (!resolveStableAliasByQuery) return null;
  const input = normalizedInput || {};
  const composedBrandTitle = offersResolvePickFirstTrimmed(
    input.brand && input.display_name ? `${input.brand} ${input.display_name}` : '',
    input.brand && input.name ? `${input.brand} ${input.name}` : '',
  );
  const candidateQueries = [
    input.query_text,
    input.display_name,
    input.name,
    composedBrandTitle,
    input.raw_product_id,
    input.raw_sku_id,
  ];
  const seen = new Set();

  for (const rawCandidate of candidateQueries) {
    const query = String(rawCandidate || '').trim();
    if (!query) continue;
    const dedupeKey = query.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const normalizedQuery = normalizeResolverText(query);
    const queryTokens = tokenizeResolverQuery(normalizedQuery);
    if (!normalizedQuery || !Array.isArray(queryTokens) || queryTokens.length === 0) continue;

    const matched = resolveStableAliasByQuery({
      query,
      normalizedQuery,
      queryTokens,
    });
    if (
      matched &&
      matched.product_ref &&
      matched.product_ref.product_id &&
      matched.product_ref.merchant_id
    ) {
      return {
        product_ref: {
          product_id: String(matched.product_ref.product_id).trim(),
          merchant_id: String(matched.product_ref.merchant_id).trim(),
        },
        match_id: String(matched.id || '').trim() || null,
        match_reason: String(matched.reason || '').trim() || null,
        matched_alias: String(matched.matched_alias || query).trim() || query,
      };
    }
  }
  return null;
}

function buildOffersResolveCacheSearchPayload(normalizedInput) {
  const input = normalizedInput || {};
  const product = {};

  const canonicalRef = normalizeOffersResolveCanonicalProductRef(input.canonical_product_ref, {
    allowOpaqueProductId: false,
  });
  if (canonicalRef) product.canonical_product_ref = canonicalRef;
  if (input.subject_product_group_id) product.product_group_id = String(input.subject_product_group_id).trim();
  if (input.raw_merchant_id) product.merchant_id = String(input.raw_merchant_id).trim();

  const rawProductId = offersResolvePickFirstTrimmed(input.raw_product_id);
  const rawSkuId = offersResolvePickFirstTrimmed(input.raw_sku_id);
  if (rawProductId && !offersResolveIsUuidLike(rawProductId)) product.product_id = rawProductId;
  if (rawSkuId) product.sku_id = rawSkuId;
  if (input.brand) product.brand = input.brand;
  if (input.name) product.name = input.name;
  if (input.display_name) product.display_name = input.display_name;

  return {
    product,
    ...(input.market ? { market: input.market } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.query_text ? { query: input.query_text } : {}),
  };
}

function getOffersResolveCircuitState(sourceKey) {
  const key = sourceKey === 'cache_search' ? 'cache_search' : 'subject_resolve';
  return OFFERS_RESOLVE_CIRCUITS[key];
}

function markOffersResolveCircuitSuccess(sourceKey) {
  const state = getOffersResolveCircuitState(sourceKey);
  state.failure_count = 0;
  state.last_reason = null;
  state.open_until_ms = 0;
}

function shouldTripOffersResolveCircuit({ reason, status } = {}) {
  if (reason === 'upstream_timeout' || reason === 'upstream_error') return true;
  const code = Number(status || 0);
  return code === 408 || code === 429 || code >= 500;
}

function markOffersResolveCircuitFailure(sourceKey, reason, status) {
  const state = getOffersResolveCircuitState(sourceKey);
  if (!shouldTripOffersResolveCircuit({ reason, status })) return;
  state.failure_count += 1;
  state.last_reason = reason || null;
  if (state.failure_count >= OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD) {
    state.failure_count = 0;
    state.open_until_ms = Date.now() + OFFERS_RESOLVE_CIRCUIT_OPEN_MS;
  }
}

async function callOffersResolveSourceWithRetry({
  sourceKey,
  url,
  body,
  checkoutToken,
  timeoutMs,
  maxRetries,
  retryBackoffMs,
}) {
  const source = sourceKey === 'cache_search' ? 'cache_search' : 'subject_resolve';
  const state = getOffersResolveCircuitState(source);
  if (state.open_until_ms > Date.now()) {
    return {
      ok: false,
      source_trace: {
        source,
        ok: false,
        attempts: 0,
        latency_ms: 0,
        reason: 'circuit_open',
      },
      reason: 'circuit_open',
      status: 503,
      response_body: null,
    };
  }

  const startedAt = Date.now();
  const safeTimeoutMs = Math.max(100, Number(timeoutMs) || 1000);
  const safeRetries = Math.max(0, Math.min(3, Number(maxRetries) || 0));
  const safeBackoffMs = Math.max(25, Number(retryBackoffMs) || 100);
  const headers = {
    'Content-Type': 'application/json',
    ...(checkoutToken
      ? { 'X-Checkout-Token': checkoutToken }
      : {
          ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
          ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
        }),
  };

  let attempts = 0;
  let lastStatus = null;
  let lastReason = 'upstream_timeout';
  let lastBody = null;
  let lastError = null;

  while (attempts <= safeRetries) {
    attempts += 1;
    try {
      const resp = await axios.post(url, body, {
        headers,
        timeout: safeTimeoutMs,
        validateStatus: () => true,
      });
      lastStatus = Number(resp?.status || 0) || null;
      lastBody = offersResolveIsRecord(resp?.data) ? resp.data : null;
      if (lastStatus >= 200 && lastStatus < 300) {
        markOffersResolveCircuitSuccess(source);
        return {
          ok: true,
          response_body: lastBody,
          status: lastStatus,
          attempts,
          source_trace: {
            source,
            ok: true,
            attempts,
            latency_ms: Math.max(0, Date.now() - startedAt),
            status: lastStatus,
          },
        };
      }

      lastReason = inferOffersResolveFailureReasonCode({
        responseBody: lastBody,
        statusCode: lastStatus,
      });
      const retryable = lastStatus === 408 || lastStatus === 429 || lastStatus >= 500;
      if (!retryable || attempts > safeRetries) break;
      await sleepMs(safeBackoffMs * attempts);
    } catch (err) {
      lastError = err;
      lastReason = inferOffersResolveFailureReasonCode({ error: err });
      const errText = String(err?.code || err?.message || err || '').toLowerCase();
      const retryable =
        errText.includes('timeout') ||
        errText.includes('econnaborted') ||
        errText.includes('etimedout');
      if (!retryable || attempts > safeRetries) break;
      await sleepMs(safeBackoffMs * attempts);
    }
  }

  markOffersResolveCircuitFailure(source, lastReason, lastStatus);
  return {
    ok: false,
    response_body: lastBody,
    status: lastStatus,
    attempts,
    reason: lastReason,
    error: lastError,
    source_trace: {
      source,
      ok: false,
      attempts,
      latency_ms: Math.max(0, Date.now() - startedAt),
      ...(lastStatus ? { status: lastStatus } : {}),
      reason: lastReason,
    },
  };
}

function hasStrongOffersResolveLookupInput(normalizedInput) {
  const input = offersResolveIsRecord(normalizedInput) ? normalizedInput : {};
  if (offersResolvePickFirstTrimmed(input.raw_merchant_id)) return true;

  const rawProductId = offersResolvePickFirstTrimmed(input.raw_product_id);
  if (rawProductId && !offersResolveIsUuidLike(rawProductId)) return true;

  const rawSkuId = offersResolvePickFirstTrimmed(input.raw_sku_id);
  if (rawSkuId && !offersResolveIsUuidLike(rawSkuId)) return true;

  return false;
}

function shouldSkipOffersResolveCacheSearch(subjectResult, normalizedInput) {
  if (!subjectResult || subjectResult.ok) return false;

  const rawReason = String(subjectResult.reason || '').trim().toLowerCase();
  if (rawReason === 'circuit_open') return true;

  const normalizedReason = normalizeOffersResolveReasonCode(rawReason, '');
  if (normalizedReason === 'upstream_timeout') {
    return OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT;
  }
  if (normalizedReason === 'no_candidates') {
    if (!OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES) return false;
    return !hasStrongOffersResolveLookupInput(normalizedInput);
  }
  return false;
}

function buildOffersResolveResponse({
  upstreamBody,
  reasonCode,
  pdpTargetV1,
  sourceTrace,
  queryText,
  startedAtMs,
  failReasonCode = null,
}) {
  const base = offersResolveIsRecord(upstreamBody) ? { ...upstreamBody } : {};
  const nestedData = offersResolveIsRecord(base.data) ? base.data : {};
  const offers = Array.isArray(base.offers)
    ? base.offers
    : Array.isArray(nestedData.offers)
      ? nestedData.offers
      : [];
  const mappingBase = offersResolveIsRecord(base.mapping) ? { ...base.mapping } : {};
  const metadataBase = offersResolveIsRecord(base.metadata) ? { ...base.metadata } : {};
  const normalizedReasonCode = normalizeOffersResolveReasonCode(
    reasonCode,
    failReasonCode ? normalizeOffersResolveReasonCode(failReasonCode, 'no_candidates') : 'no_candidates',
  );
  const normalizedFailReason = failReasonCode
    ? normalizeOffersResolveReasonCode(failReasonCode, 'no_candidates')
    : null;
  const totalLatencyMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
  const pdpPath = offersResolvePickFirstTrimmed(pdpTargetV1?.path) || 'external';

  const response = {
    ...base,
    status: base.status || 'success',
    offers,
    offers_count:
      Number.isFinite(Number(base.offers_count)) && Number(base.offers_count) >= 0
        ? Number(base.offers_count)
        : offers.length,
    reason_code: normalizedReasonCode,
    reason: base.reason || normalizedReasonCode,
    pdp_target: {
      ...(offersResolveIsRecord(base.pdp_target) ? base.pdp_target : {}),
      v1: pdpTargetV1,
    },
    mapping: {
      ...mappingBase,
      pdp_target: {
        ...(offersResolveIsRecord(mappingBase.pdp_target) ? mappingBase.pdp_target : {}),
        v1: pdpTargetV1,
      },
      source_trace: Array.isArray(sourceTrace) ? sourceTrace : [],
    },
    metadata: {
      ...metadataBase,
      source: 'offers.resolve',
      pdp_open_path: pdpPath,
      time_to_pdp_ms: totalLatencyMs,
      sources: Array.isArray(sourceTrace) ? sourceTrace : [],
      ...(queryText ? { query: queryText } : {}),
      ...(normalizedFailReason
        ? {
            fail_reason: normalizedFailReason,
            resolve_fail_reason: normalizedFailReason,
            resolve_reason_code: normalizedFailReason,
          }
        : {}),
    },
  };

  if (response.status === 'success' && offers.length === 0 && !response.reason_code) {
    response.reason_code = 'no_candidates';
    response.reason = response.reason || 'no_candidates';
  }

  return response;
}

async function handleOffersResolveOperation({
  payload,
  metadata,
  checkoutToken,
}) {
  const startedAt = Date.now();
  const sourceTrace = [];
  const normalizedInput = normalizeOffersResolveInput(payload);

  if (!normalizedInput.has_any_identifier) {
    return {
      statusCode: 400,
      response: {
        error: 'MISSING_PARAMETERS',
        message:
          'offers.resolve requires product.sku_id, product.product_id, subject.product_group_id, canonical_product_ref, or query',
      },
    };
  }

  if (normalizedInput.subject_product_group_id) {
    const pdpTarget = buildOffersResolvePdpTargetGroup(
      normalizedInput.subject_product_group_id,
      normalizedInput.canonical_product_ref,
    );
    sourceTrace.push({
      source: 'stable_input',
      ok: true,
      attempts: 0,
      latency_ms: 0,
      reason: 'subject_direct',
    });
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
        },
        reasonCode: 'subject_direct',
        pdpTargetV1: pdpTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
      }),
    };
  }

  if (normalizedInput.canonical_product_ref) {
    const pdpTarget = buildOffersResolvePdpTargetRef(normalizedInput.canonical_product_ref, {
      path: 'ref',
    });
    sourceTrace.push({
      source: 'stable_input',
      ok: true,
      attempts: 0,
      latency_ms: 0,
      reason: 'canonical_ref_direct',
    });
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
        },
        reasonCode: 'canonical_ref_direct',
        pdpTargetV1: pdpTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
      }),
    };
  }

  const directRawProductRef =
    normalizedInput.raw_merchant_id && (normalizedInput.raw_product_id || normalizedInput.raw_sku_id)
      ? normalizeOffersResolveCanonicalProductRef(
          {
            merchant_id: normalizedInput.raw_merchant_id,
            product_id: normalizedInput.raw_product_id || normalizedInput.raw_sku_id,
          },
          { allowOpaqueProductId: false },
        )
      : null;
  if (directRawProductRef) {
    const pdpTarget = buildOffersResolvePdpTargetRef(directRawProductRef, { path: 'ref' });
    sourceTrace.push({
      source: 'stable_input',
      ok: true,
      attempts: 0,
      latency_ms: 0,
      reason: 'raw_ref_direct',
    });
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
          mapping: {
            canonical_product_ref: directRawProductRef,
          },
        },
        reasonCode: 'canonical_ref_direct',
        pdpTargetV1: pdpTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
      }),
    };
  }

  const stableAliasRef = resolveOffersResolveStableAliasRef(normalizedInput);
  if (stableAliasRef?.product_ref) {
    const pdpTarget = buildOffersResolvePdpTargetRef(stableAliasRef.product_ref, {
      path: 'ref',
    });
    sourceTrace.push({
      source: 'stable_alias_ref',
      ok: true,
      attempts: 0,
      latency_ms: 0,
      reason: stableAliasRef.match_reason || 'stable_alias_ref',
      ...(stableAliasRef.match_id ? { match_id: stableAliasRef.match_id } : {}),
      ...(stableAliasRef.matched_alias ? { matched_alias: stableAliasRef.matched_alias } : {}),
    });
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
          mapping: {
            canonical_product_ref: stableAliasRef.product_ref,
          },
          metadata: {
            source: 'offers.resolve',
            resolve_source: 'stable_alias_ref',
            stable_alias_match_id: stableAliasRef.match_id || null,
            stable_alias_match_query: stableAliasRef.matched_alias || null,
          },
        },
        reasonCode: 'stable_alias_ref',
        pdpTargetV1: pdpTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
      }),
    };
  }

  const subjectResolvePayload = {
    product: {
      ...(normalizedInput.raw_product_id ? { product_id: normalizedInput.raw_product_id } : {}),
      ...(normalizedInput.raw_sku_id ? { sku_id: normalizedInput.raw_sku_id } : {}),
      ...(normalizedInput.raw_merchant_id ? { merchant_id: normalizedInput.raw_merchant_id } : {}),
      ...(normalizedInput.brand ? { brand: normalizedInput.brand } : {}),
      ...(normalizedInput.name ? { name: normalizedInput.name } : {}),
      ...(normalizedInput.display_name ? { display_name: normalizedInput.display_name } : {}),
      ...(normalizedInput.query_text ? { query: normalizedInput.query_text } : {}),
    },
    ...(normalizedInput.query_text ? { query: normalizedInput.query_text } : {}),
    ...(normalizedInput.market ? { market: normalizedInput.market } : {}),
    ...(normalizedInput.tool ? { tool: normalizedInput.tool } : {}),
    source: 'offers.resolve',
    metadata: offersResolveIsRecord(metadata) ? metadata : {},
  };

  const subjectResult = await callOffersResolveSourceWithRetry({
    sourceKey: 'subject_resolve',
    url: `${PIVOTA_API_BASE}/v1/subject/resolve`,
    body: subjectResolvePayload,
    checkoutToken,
    timeoutMs: OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
    maxRetries: OFFERS_RESOLVE_SUBJECT_RETRY_MAX,
    retryBackoffMs: OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS,
  });
  sourceTrace.push(subjectResult.source_trace);

  if (subjectResult.ok) {
    const subjectTarget = extractOffersResolvePdpTargetFromResponse(subjectResult.response_body, {
      fallbackQuery: normalizedInput.query_text,
    });
    if (subjectTarget && subjectTarget.path !== 'external') {
      const reasonCode = subjectTarget.path === 'group' ? 'subject_direct' : 'subject_direct';
      return {
        statusCode: 200,
        response: buildOffersResolveResponse({
          upstreamBody: {
            ...(offersResolveIsRecord(subjectResult.response_body)
              ? subjectResult.response_body
              : { status: 'success' }),
            offers: [],
            offers_count: 0,
            input: {
              product_id: normalizedInput.raw_product_id,
              sku_id: normalizedInput.raw_sku_id,
            },
          },
          reasonCode,
          pdpTargetV1: subjectTarget,
          sourceTrace,
          queryText: normalizedInput.query_text,
          startedAtMs: startedAt,
        }),
      };
    }
  }

  if (shouldSkipOffersResolveCacheSearch(subjectResult, normalizedInput)) {
    const failReasonCode = normalizeOffersResolveReasonCode(
      subjectResult.reason,
      'upstream_timeout',
    );
    const fallbackTarget = buildOffersResolvePdpTargetExternal(
      normalizedInput.query_text,
      failReasonCode,
    );
    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody: {
          status: 'success',
          offers: [],
          offers_count: 0,
          input: {
            product_id: normalizedInput.raw_product_id,
            sku_id: normalizedInput.raw_sku_id,
          },
        },
        reasonCode: failReasonCode,
        pdpTargetV1: fallbackTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
        failReasonCode,
      }),
    };
  }

  const cacheSearchPayload = {
    operation: 'offers.resolve',
    payload: buildOffersResolveCacheSearchPayload(normalizedInput),
    metadata: offersResolveIsRecord(metadata) ? metadata : {},
  };

  const cacheSearchResult = await callOffersResolveSourceWithRetry({
    sourceKey: 'cache_search',
    url: `${PIVOTA_API_BASE}/agent/shop/v1/invoke`,
    body: cacheSearchPayload,
    checkoutToken,
    timeoutMs: OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
    maxRetries: OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX,
    retryBackoffMs: OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS,
  });
  sourceTrace.push(cacheSearchResult.source_trace);

  if (cacheSearchResult.ok) {
    const upstreamBody = cacheSearchResult.response_body;
    const pdpTarget =
      extractOffersResolvePdpTargetFromResponse(upstreamBody, {
        fallbackQuery: normalizedInput.query_text,
      }) || buildOffersResolvePdpTargetExternal(normalizedInput.query_text);

    const offers = Array.isArray(upstreamBody?.offers)
      ? upstreamBody.offers
      : Array.isArray(upstreamBody?.data?.offers)
        ? upstreamBody.data.offers
        : [];
    const explicitReasonCode = normalizeOffersResolveReasonCode(
      upstreamBody?.reason_code ||
        upstreamBody?.reasonCode ||
        upstreamBody?.metadata?.reason_code ||
        upstreamBody?.metadata?.resolve_reason_code,
      '',
    );
    const inferredFailureCode =
      pdpTarget.path === 'external'
        ? inferOffersResolveFailureReasonCode({
            responseBody: upstreamBody,
            statusCode: cacheSearchResult.status,
          })
        : null;
    const pdpPath = offersResolvePickFirstTrimmed(pdpTarget?.path).toLowerCase();
    const internalPdp = pdpPath === 'group' || pdpPath === 'ref' || pdpPath === 'resolve';
    const resolvedReasonCode = internalPdp
      ? explicitReasonCode && explicitReasonCode !== 'no_candidates'
        ? explicitReasonCode
        : 'mapped_hit'
      : explicitReasonCode || inferredFailureCode || (offers.length ? 'mapped_hit' : 'no_candidates');

    return {
      statusCode: 200,
      response: buildOffersResolveResponse({
        upstreamBody,
        reasonCode: resolvedReasonCode,
        pdpTargetV1: pdpTarget,
        sourceTrace,
        queryText: normalizedInput.query_text,
        startedAtMs: startedAt,
        failReasonCode: pdpTarget.path === 'external' ? inferredFailureCode : null,
      }),
    };
  }

  const failReasonCode = inferOffersResolveFailureReasonCode({
    responseBody: cacheSearchResult.response_body,
    statusCode: cacheSearchResult.status,
    error: cacheSearchResult.error,
  });
  const fallbackTarget = buildOffersResolvePdpTargetExternal(
    normalizedInput.query_text,
    failReasonCode,
  );

  return {
    statusCode: 200,
    response: buildOffersResolveResponse({
      upstreamBody: {
        status: 'success',
        offers: [],
        offers_count: 0,
        input: {
          product_id: normalizedInput.raw_product_id,
          sku_id: normalizedInput.raw_sku_id,
        },
      },
      reasonCode: failReasonCode || 'fallback_external',
      pdpTargetV1: fallbackTarget,
      sourceTrace,
      queryText: normalizedInput.query_text,
      startedAtMs: startedAt,
      failReasonCode: failReasonCode || 'fallback_external',
    }),
  };
}

// ---------------- Ops export: missing catalog products (requires X-ADMIN-KEY) ----------------

app.get('/api/admin/missing-catalog-products', requireAdmin, async (req, res) => {
  const format = String(req.query.format || '').trim().toLowerCase() || 'json';
  const limit = req.query.limit;
  const offset = req.query.offset;
  const sort = req.query.sort;
  const since = req.query.since;

  const out = await listMissingCatalogProducts({
    limit,
    offset,
    sort,
    since,
  });

  if (!out.ok) {
    return res.status(500).json({
      error: 'MISSING_CATALOG_PRODUCTS_UNAVAILABLE',
      reason: out.reason || 'unknown',
      ...(out.error ? { message: out.error } : {}),
    });
  }

  if (format === 'csv') {
    const csv = missingCatalogProductsToCsv(out.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="missing_catalog_products_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.status(200).send(csv);
  }

  return res.json({ ok: true, rows: out.rows });
});

app.get('/api/admin/search-diagnostics', requireAdmin, async (req, res) => {
  const queryText = String(req.query.q || req.query.query || '').trim();
  if (!queryText) {
    return res.status(400).json({
      error: 'MISSING_QUERY',
      message: 'Provide q or query parameter',
    });
  }

  const lang = String(req.query.lang || 'en').trim().toLowerCase() || 'en';
  const source = String(req.query.source || 'shopping_agent').trim().toLowerCase() || 'shopping_agent';
  const requestedLimit = parseQueryNumber(req.query.limit);
  const limit = Math.min(Math.max(1, Number(requestedLimit || 10)), 50);
  const inStockOnlyRaw = parseQueryBoolean(req.query.in_stock_only ?? req.query.inStockOnly);
  const inStockOnly = inStockOnlyRaw !== false;
  const startedAt = Date.now();

  const resolverMeta = { source };
  const resolverFirstWouldApply = shouldUseResolverFirstSearch({
    operation: 'find_products_multi',
    metadata: resolverMeta,
    queryText,
  });
  const strongResolverQuery = isStrongResolverFirstQuery(queryText);

  const buildResolverView = (result) => ({
    resolved: Boolean(result?.resolved),
    reason: result?.reason || null,
    product_ref: result?.product_ref || null,
    confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : null,
    latency_ms: Number.isFinite(Number(result?.metadata?.latency_ms))
      ? Number(result.metadata.latency_ms)
      : null,
    sources: Array.isArray(result?.metadata?.sources) ? result.metadata.sources : [],
  });

  let resolverWithAlias = null;
  let resolverWithoutAlias = null;
  try {
    resolverWithAlias = await resolveProductRef({
      query: queryText,
      lang,
      hints: null,
      options: {
        search_all_merchants: true,
        timeout_ms: Math.max(PROXY_SEARCH_RESOLVER_TIMEOUT_MS, 1600),
        upstream_retries: 0,
        stable_alias_short_circuit: true,
      },
      pivotaApiBase: PIVOTA_API_BASE,
      pivotaApiKey: PIVOTA_API_KEY,
      checkoutToken: null,
    });
  } catch (err) {
    resolverWithAlias = { resolved: false, reason: 'resolver_exception', metadata: { sources: [], error: err?.message || String(err) } };
  }

  try {
    resolverWithoutAlias = await resolveProductRef({
      query: queryText,
      lang,
      hints: null,
      options: {
        search_all_merchants: true,
        timeout_ms: Math.max(PROXY_SEARCH_RESOLVER_TIMEOUT_MS, 1600),
        upstream_retries: 0,
        stable_alias_short_circuit: false,
      },
      pivotaApiBase: PIVOTA_API_BASE,
      pivotaApiKey: PIVOTA_API_KEY,
      checkoutToken: null,
    });
  } catch (err) {
    resolverWithoutAlias = { resolved: false, reason: 'resolver_exception', metadata: { sources: [], error: err?.message || String(err) } };
  }

  let crossMerchantCache = {
    ok: false,
    reason: 'db_not_configured',
    total: 0,
    products_count: 0,
    retrieval_sources: [],
    sample_products: [],
  };
  if (process.env.DATABASE_URL) {
    try {
      const fromCache = await searchCrossMerchantFromCache(queryText, 1, limit, { inStockOnly });
      crossMerchantCache = {
        ok: true,
        reason: null,
        total: Number(fromCache.total || 0),
        products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
        retrieval_sources: fromCache.retrieval_sources || [],
        sample_products: (fromCache.products || []).slice(0, 3).map((item) => ({
          product_id: item?.product_id || item?.id || null,
          merchant_id: item?.merchant_id || item?.merchantId || null,
          title: item?.title || item?.name || null,
          status: item?.status || null,
        })),
      };
    } catch (err) {
      crossMerchantCache = {
        ok: false,
        reason: 'cache_query_failed',
        error: err?.message || String(err),
        total: 0,
        products_count: 0,
        retrieval_sources: [],
        sample_products: [],
      };
    }
  }

  const aliasDependency =
    Boolean(resolverWithAlias?.resolved) &&
    !Boolean(resolverWithoutAlias?.resolved);

  return res.json({
    ok: true,
    query: queryText,
    language: lang,
    source,
    timing_ms: Math.max(0, Date.now() - startedAt),
    config: {
      resolver_first_enabled: PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      resolver_first_strong_only: PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      resolver_first_would_apply: resolverFirstWouldApply,
      resolver_query_is_strong: strongResolverQuery,
      resolver_timeout_ms: PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
      db_configured: Boolean(process.env.DATABASE_URL),
      catalog_auto_sync_enabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
    },
    catalog_sync: {
      enabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      interval_minutes: getCreatorCatalogAutoSyncIntervalConfig().intervalMinutes,
      interval_minutes_max: getCreatorCatalogAutoSyncIntervalConfig().maxIntervalMinutes,
      cache_ttl_seconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
      request_timeout_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
      request_timeout_max_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS,
      retry_attempts: CREATOR_CATALOG_AUTO_SYNC_RETRIES,
      retry_backoff_ms: CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
      non_retryable_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
      invalid_merchant_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS,
      target_source: catalogSyncState.target_source,
      target_count: catalogSyncState.target_count,
      target_eligible_count: catalogSyncState.target_eligible_count,
      target_suppressed_count: catalogSyncState.target_suppressed_count,
      target_sample: catalogSyncState.target_sample,
      target_suppressed_sample: catalogSyncState.target_suppressed_sample,
      last_run_at: catalogSyncState.last_run_at,
      last_success_at: catalogSyncState.last_success_at,
      last_error: catalogSyncState.last_error,
      per_merchant: summarizeCatalogSyncMerchantState(),
    },
    resolver: {
      alias_dependency: aliasDependency,
      with_stable_alias: buildResolverView(resolverWithAlias),
      without_stable_alias: buildResolverView(resolverWithoutAlias),
    },
    cross_merchant_cache: crossMerchantCache,
  });
});

app.get('/api/admin/catalog-cache-diagnostics', requireAdmin, async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      ok: false,
      error: 'DB_NOT_CONFIGURED',
      message: 'DATABASE_URL is not configured on gateway',
    });
  }

  const queryText = String(req.query.q || req.query.query || '').trim();
  const merchantId = String(req.query.merchant_id || req.query.merchantId || '').trim();
  const requestedLimit = parseQueryNumber(req.query.limit_merchants ?? req.query.limitMerchants);
  const limitMerchants = Math.min(Math.max(1, Number(requestedLimit || 20)), 200);
  const startedAt = Date.now();

  const creatorMerchantIds = getCreatorCatalogMerchantIds();
  let syncTargetMerchants = { merchantIds: [], source: 'not_resolved' };
  const matchFields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'description',''))",
    "lower(coalesce(product_data->>'product_type',''))",
    "lower(coalesce(product_data->>'sku',''))",
    "lower(coalesce(product_data->>'vendor',''))",
    "lower(coalesce(product_data->>'brand',''))",
  ];

  const parseCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  try {
    syncTargetMerchants = await resolveCatalogSyncMerchantIds();

    const idRes = await query(
      `
        SELECT
          current_database() AS database_name,
          current_schema() AS schema_name,
          current_user AS user_name,
          inet_server_addr()::text AS server_addr,
          inet_server_port()::text AS server_port
      `,
      [],
    );
    const idRow = idRes.rows?.[0] || {};
    const dbIdentity = {
      database_name: idRow.database_name || null,
      schema_name: idRow.schema_name || null,
      user_name: idRow.user_name || null,
      server_addr: idRow.server_addr || null,
      server_port: idRow.server_port || null,
    };
    const dbFingerprint = createHash('sha256')
      .update(
        [
          dbIdentity.database_name || '',
          dbIdentity.schema_name || '',
          dbIdentity.server_addr || '',
          dbIdentity.server_port || '',
          dbIdentity.user_name || '',
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 16);

    const globalTotalsRes = await query(
      `
        SELECT
          COUNT(*)::bigint AS total_rows,
          COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
          COUNT(*) FILTER (
            WHERE (expires_at IS NULL OR expires_at > now())
              AND ${buildSellableStatusPredicate("product_data->>'status'")}
              AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
          )::bigint AS sellable_rows,
          MAX(cached_at) AS latest_cached_at,
          MAX(expires_at) AS latest_expires_at
        FROM products_cache
      `,
      [],
    );
    const globalTotalsRow = globalTotalsRes.rows?.[0] || {};

    const byMerchantRes = await query(
      `
        SELECT
          merchant_id,
          COUNT(*)::bigint AS total_rows,
          COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
          COUNT(*) FILTER (
            WHERE (expires_at IS NULL OR expires_at > now())
              AND ${buildSellableStatusPredicate("product_data->>'status'")}
              AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
          )::bigint AS sellable_rows,
          MAX(cached_at) AS latest_cached_at,
          MAX(expires_at) AS latest_expires_at
        FROM products_cache
        GROUP BY merchant_id
        ORDER BY sellable_rows DESC, total_rows DESC, merchant_id ASC
        LIMIT $1
      `,
      [limitMerchants],
    );

    const creatorMerchantStats = creatorMerchantIds.length
      ? await query(
          `
            SELECT
              merchant_id,
              COUNT(*)::bigint AS total_rows,
              COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
              COUNT(*) FILTER (
                WHERE (expires_at IS NULL OR expires_at > now())
                  AND ${buildSellableStatusPredicate("product_data->>'status'")}
                  AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
              )::bigint AS sellable_rows,
              MAX(cached_at) AS latest_cached_at
            FROM products_cache
            WHERE merchant_id = ANY($1)
            GROUP BY merchant_id
            ORDER BY merchant_id ASC
          `,
          [creatorMerchantIds],
        )
      : { rows: [] };

    const onboardingByCreator = creatorMerchantIds.length
      ? await query(
          `
            SELECT merchant_id, status, psp_connected
            FROM merchant_onboarding
            WHERE merchant_id = ANY($1)
            ORDER BY merchant_id ASC
          `,
          [creatorMerchantIds],
        )
      : { rows: [] };

    const scopedWhereParts = [];
    const scopedParams = [];
    let scopedIdx = 1;
    if (merchantId) {
      scopedWhereParts.push(`merchant_id = $${scopedIdx}`);
      scopedParams.push(merchantId);
      scopedIdx += 1;
    }
    const scopedWhere = scopedWhereParts.length ? `WHERE ${scopedWhereParts.join(' AND ')}` : '';

    let queryProbe = null;
    if (queryText) {
      const qValue = `%${String(queryText).toLowerCase()}%`;
      const fieldOrs = matchFields.map((field) => `${field} LIKE $${scopedIdx}`).join(' OR ');

      const fieldLikeSql = `
        SELECT COUNT(*)::bigint AS field_like_rows
        FROM products_cache
        ${scopedWhere}
        ${scopedWhere ? 'AND' : 'WHERE'} (${fieldOrs})
      `;
      const jsonLikeSql = `
        SELECT COUNT(*)::bigint AS json_like_rows
        FROM products_cache
        ${scopedWhere}
        ${scopedWhere ? 'AND' : 'WHERE'} lower(CAST(product_data AS TEXT)) LIKE $${scopedIdx}
      `;
      const sampleSql = `
        SELECT
          merchant_id,
          product_data->>'title' AS title,
          product_data->>'status' AS status,
          COALESCE(product_data->>'product_id', product_data->>'id') AS product_id,
          cached_at,
          expires_at
        FROM products_cache
        ${scopedWhere}
        ${scopedWhere ? 'AND' : 'WHERE'} lower(CAST(product_data AS TEXT)) LIKE $${scopedIdx}
        ORDER BY cached_at DESC NULLS LAST, id DESC
        LIMIT 5
      `;

      const queryParams = [...scopedParams, qValue];
      const [fieldLikeRes, jsonLikeRes, sampleRes] = await Promise.all([
        query(fieldLikeSql, queryParams),
        query(jsonLikeSql, queryParams),
        query(sampleSql, queryParams),
      ]);

      queryProbe = {
        query: queryText,
        merchant_scope: merchantId || null,
        field_like_rows: parseCount(fieldLikeRes.rows?.[0]?.field_like_rows),
        json_like_rows: parseCount(jsonLikeRes.rows?.[0]?.json_like_rows),
        sample_rows: (sampleRes.rows || []).map((row) => ({
          merchant_id: row.merchant_id || null,
          product_id: row.product_id || null,
          title: row.title || null,
          status: row.status || null,
          cached_at: row.cached_at || null,
          expires_at: row.expires_at || null,
        })),
      };
    }

    return res.json({
      ok: true,
      timing_ms: Math.max(0, Date.now() - startedAt),
      db: {
        ...dbIdentity,
        fingerprint: dbFingerprint,
      },
      gateway: {
        api_base: PIVOTA_API_BASE,
        catalog_auto_sync_enabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      },
      catalog_sync: {
        enabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
        interval_minutes: getCreatorCatalogAutoSyncIntervalConfig().intervalMinutes,
        interval_minutes_max: getCreatorCatalogAutoSyncIntervalConfig().maxIntervalMinutes,
        cache_ttl_seconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
        request_timeout_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
        request_timeout_max_ms: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS,
        retry_attempts: CREATOR_CATALOG_AUTO_SYNC_RETRIES,
        retry_backoff_ms: CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
        non_retryable_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
        invalid_merchant_cooldown_seconds: CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS,
        target_source: catalogSyncState.target_source,
        target_count: catalogSyncState.target_count,
        target_eligible_count: catalogSyncState.target_eligible_count,
        target_suppressed_count: catalogSyncState.target_suppressed_count,
        target_sample: catalogSyncState.target_sample,
        target_suppressed_sample: catalogSyncState.target_suppressed_sample,
        last_run_at: catalogSyncState.last_run_at,
        last_success_at: catalogSyncState.last_success_at,
        last_error: catalogSyncState.last_error,
        per_merchant: summarizeCatalogSyncMerchantState(),
      },
      totals: {
        total_rows: parseCount(globalTotalsRow.total_rows),
        not_expired_rows: parseCount(globalTotalsRow.not_expired_rows),
        sellable_rows: parseCount(globalTotalsRow.sellable_rows),
        latest_cached_at: globalTotalsRow.latest_cached_at || null,
        latest_expires_at: globalTotalsRow.latest_expires_at || null,
      },
      creator_merchants: {
        configured: creatorMerchantIds,
        cache_rows: (creatorMerchantStats.rows || []).map((row) => ({
          merchant_id: row.merchant_id || null,
          total_rows: parseCount(row.total_rows),
          not_expired_rows: parseCount(row.not_expired_rows),
          sellable_rows: parseCount(row.sellable_rows),
          latest_cached_at: row.latest_cached_at || null,
        })),
        onboarding: (onboardingByCreator.rows || []).map((row) => ({
          merchant_id: row.merchant_id || null,
          status: row.status || null,
          psp_connected: row.psp_connected === true,
        })),
      },
      sync_targets: {
        source: syncTargetMerchants.source || null,
        merchants: Array.isArray(syncTargetMerchants.merchantIds)
          ? syncTargetMerchants.merchantIds
          : [],
      },
      merchants_top: (byMerchantRes.rows || []).map((row) => ({
        merchant_id: row.merchant_id || null,
        total_rows: parseCount(row.total_rows),
        not_expired_rows: parseCount(row.not_expired_rows),
        sellable_rows: parseCount(row.sellable_rows),
        latest_cached_at: row.latest_cached_at || null,
        latest_expires_at: row.latest_expires_at || null,
      })),
      query_probe: queryProbe,
    });
  } catch (err) {
    const code = String(err?.code || '').trim() || null;
    if (code === '42P01') {
      return res.status(500).json({
        ok: false,
        error: 'PRODUCTS_CACHE_TABLE_MISSING',
        message: err?.message || 'products_cache table does not exist',
      });
    }
    return res.status(500).json({
      ok: false,
      error: 'CATALOG_CACHE_DIAGNOSTIC_FAILED',
      code,
      message: err?.message || String(err),
    });
  }
});

// ---------------- Main invoke endpoint ----------------

app.post('/agent/shop/v1/invoke', async (req, res) => {
  const gatewayRequestId = randomUUID();
  res.setHeader('X-Gateway-Request-Id', gatewayRequestId);

  try {
    const parsed = InvokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ gateway_request_id: gatewayRequestId, error: parsed.error.format() }, 'Invalid request body');
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        details: parsed.error.format(),
      });
    }

    const { operation, payload } = parsed.data;
    const metadata = normalizeMetadata(req.body.metadata, payload);
    const creatorId = extractCreatorId({ ...payload, metadata });
    const now = new Date();
    const invokeStartedAtMs = Date.now();
    const findProductsMultiCtx =
      operation === 'find_products_multi'
        ? await buildFindProductsMultiContext({
            payload,
            metadata: {
              ...(metadata || {}),
              expansion_mode: FIND_PRODUCTS_MULTI_EXPANSION_MODE,
            },
          })
        : null;
    const effectivePayload = findProductsMultiCtx?.adjustedPayload || payload;
    const effectiveIntent = findProductsMultiCtx?.intent || null;
    const findProductsExpansionMeta = findProductsMultiCtx?.expansion_meta || null;
    const rawUserQuery =
      findProductsMultiCtx?.rawUserQuery ||
      effectivePayload?.search?.query ||
      effectivePayload?.query ||
      payload?.search?.query ||
      payload?.query ||
      '';
    const policyMetadata =
      operation === 'find_products_multi'
        ? {
            ...(metadata || {}),
            ...(Number.isFinite(Number(findProductsExpansionMeta?.ambiguity_score_pre))
              ? {
                  ambiguity_score_pre: Number(findProductsExpansionMeta.ambiguity_score_pre),
                }
              : {}),
            ...(findProductsExpansionMeta?.query_class
              ? { query_class: String(findProductsExpansionMeta.query_class) }
              : {}),
            ...(findProductsExpansionMeta?.rewrite_gate &&
            typeof findProductsExpansionMeta.rewrite_gate === 'object'
              ? { rewrite_gate: findProductsExpansionMeta.rewrite_gate }
              : {}),
            ...(findProductsExpansionMeta?.association_plan &&
            typeof findProductsExpansionMeta.association_plan === 'object'
              ? { association_plan: findProductsExpansionMeta.association_plan }
              : {}),
          }
        : metadata;
    const traceQueryClass =
      findProductsExpansionMeta?.query_class || effectiveIntent?.query_class || null;
    const traceRewriteGate =
      findProductsExpansionMeta?.rewrite_gate &&
      typeof findProductsExpansionMeta.rewrite_gate === 'object'
        ? findProductsExpansionMeta.rewrite_gate
        : null;
    const traceAssociationPlan =
      findProductsExpansionMeta?.association_plan &&
      typeof findProductsExpansionMeta.association_plan === 'object'
        ? findProductsExpansionMeta.association_plan
        : null;
    const traceAmbiguityScorePre = Number.isFinite(
      Number(findProductsExpansionMeta?.ambiguity_score_pre),
    )
      ? Number(findProductsExpansionMeta.ambiguity_score_pre)
      : null;

  // Redundant allowlist check for semantics clarity.
  if (!OperationEnum.options.includes(operation)) {
    return res.status(400).json({
      error: 'UNSUPPORTED_OPERATION',
      operation,
    });
  }

  // Log which mode we're using
  logger.info({ API_MODE, operation }, `API Mode: ${API_MODE}, Operation: ${operation}`);

	  const checkoutToken =
	    String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

	  const guardrails = applyGatewayGuardrails({
	    req,
	    operation,
	    payload,
	    effectivePayload,
	    metadata,
	  });
	  if (guardrails?.blocked) {
	    if (typeof guardrails.blocked.retryAfterSec === 'number') {
	      res.setHeader('Retry-After', String(Math.max(1, guardrails.blocked.retryAfterSec)));
	    }
	    return res.status(guardrails.blocked.status).json(guardrails.blocked.body);
	  }
	  
	  // HYBRID mode: Use real API for product search, mock for payments
	  if (USE_HYBRID) {
    const hybridMockOperations = ['submit_payment', 'request_after_sales'];
    if (hybridMockOperations.includes(operation)) {
      logger.info({ operation }, 'Hybrid mode: Using mock for this operation');
      // Fall through to mock handler
    } else {
      logger.info({ operation }, 'Hybrid mode: Using real API for this operation');
      // Fall through to real API handler
    }
  }
  
  // Use mock API if configured or in hybrid mode for certain operations
  const shouldUseMock = USE_MOCK || (USE_HYBRID && ['submit_payment', 'request_after_sales'].includes(operation));

  // Discovery / chitchat routing: when the user hasn't expressed a shopping goal yet,
  // do NOT query the catalog. Return a guided, creator-styled prompt instead.
  if (operation === 'find_products_multi' && effectiveIntent?.scenario?.name === 'discovery') {
    const base = {
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: 0,
      reply: null,
      metadata: {
        query_source: 'intent_discovery_short_circuit',
        fetched_at: new Date().toISOString(),
        ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
        ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
      },
    };

    const withPolicy = applyFindProductsMultiPolicy({
      response: base,
      intent: effectiveIntent,
      requestPayload: effectivePayload,
      metadata: policyMetadata,
      rawUserQuery,
    });

    const promotions = await getActivePromotions(now, creatorId);
    const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
    return res.json(enriched);
  }
  
  if (shouldUseMock) {
    logger.info({ operation, mock: true }, 'Using internal mock data with rich product catalog');
    
    try {
      let mockResponse;
      
      switch (operation) {
        case 'find_products': {
          const search = effectivePayload.search || effectivePayload || {};
          const products = searchProducts(
            search.merchant_id || DEFAULT_MERCHANT_ID,
            search.query,
            search.price_max,
            search.price_min,
            search.category
          );
          
          mockResponse = {
            status: 'success',
            success: true,
            products: products,
            results: products, // Alternative field name
            data: { products: products }, // Alternative structure
            total: products.length,
            count: products.length, // Alternative count field
            page: 1,
            page_size: products.length
          };
          break;
        }

        case 'find_similar_products': {
          const sim = payload.similar || {};
          const productId =
            sim.product_id ||
            payload.product?.product_id ||
            payload.product_id;
          const limit = sim.limit || 8;
          const merchantId =
            sim.merchant_id || payload.search?.merchant_id || DEFAULT_MERCHANT_ID;
          const excludeIds = sim.exclude_ids || [productId].filter(Boolean);

          const all = searchProducts(merchantId, sim.query, undefined, undefined, undefined);
          const picked = pickSimilarProducts(all, productId, limit, excludeIds);

          mockResponse = {
            status: 'success',
            products: picked,
            total: picked.length,
            page: 1,
            page_size: picked.length,
          };
          break;
        }

        case 'find_products_multi': {
          const search = effectivePayload.search || effectivePayload || {};
          const merchantId = String(search.merchant_id || search.merchantId || '').trim();
          const merchantIdsRaw = search.merchant_ids || search.merchantIds;
          const merchantIds = Array.isArray(merchantIdsRaw)
            ? merchantIdsRaw.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
          const searchAllMerchants =
            search.search_all_merchants === true || search.searchAllMerchants === true;
          const resolvedMerchantIds = merchantId
            ? [merchantId]
            : merchantIds.length
              ? merchantIds
              : searchAllMerchants
                ? Object.keys(mockProducts)
                : Object.keys(mockProducts);

          const products = resolvedMerchantIds.flatMap((mid) =>
            searchProducts(mid, search.query, search.price_max, search.price_min, search.category),
          );

          mockResponse = {
            status: 'success',
            success: true,
            products,
            results: products,
            data: { products },
            total: products.length,
            count: products.length,
            page: 1,
            page_size: products.length,
            metadata: {
              query_source: 'mock_multi',
              merchants_searched: resolvedMerchantIds.length
            }
          };
          break;
        }

	        case 'resolve_product_candidates': {
	          const productRef = payload.product_ref || payload.productRef || payload.product || {};
	          const productId = String(
	            productRef.product_id || productRef.productId || payload.product_id || payload.productId || '',
	          ).trim();
          const requestedMerchantId = String(
            productRef.merchant_id || productRef.merchantId || payload.merchant_id || payload.merchantId || '',
          ).trim();
	          const options = payload.options || {};
	          const limit = Math.min(Math.max(1, Number(options.limit || payload.limit || 10) || 10), 50);
	          const includeOffers = options.include_offers !== false;
	          const debug = options.debug === true || String(options.debug || '').trim().toLowerCase() === 'true';

	          if (!productId) {
	            return res.status(400).json({
	              error: 'MISSING_PARAMETERS',
	              message: 'product_ref.product_id is required',
            });
          }

	          const currency = 'USD';
	          const productGroupId =
	            (productId === 'BOTTLE_001'
	              ? buildProductGroupId({ platform: 'mock', platform_product_id: productId })
	              : buildProductGroupId({
	                  merchant_id: requestedMerchantId || DEFAULT_MERCHANT_ID,
	                  product_id: productId,
	                })) ||
	            (productId === 'BOTTLE_001'
	              ? `pg:mock:${productId}`
	              : `pg:${requestedMerchantId || DEFAULT_MERCHANT_ID}:${productId}`);

	          const toMoney = (amount, cur) => ({ amount: Number(amount) || 0, currency: cur || currency });

	          const buildBottleOffers = () => {
	            const offers = [
              {
                tier: 'cheap_slow',
                risk_tier: 'standard',
                merchant_id: 'merch_demo_cheap_slow',
                merchant_name: 'Budget Seller',
                fulfillment_type: 'merchant',
                inventory: { in_stock: true },
                price: toMoney(19.99, currency),
                shipping: { method_label: 'Standard', eta_days_range: [7, 10], cost: toMoney(1.99, currency) },
                returns: { return_window_days: 30, free_returns: true },
              },
              {
                tier: 'fast_premium',
                risk_tier: 'preferred',
                merchant_id: 'merch_demo_fast_premium',
                merchant_name: 'FastShip Plus',
                fulfillment_type: 'merchant',
                inventory: { in_stock: true },
                price: toMoney(25.99, currency),
                shipping: { method_label: 'Express', eta_days_range: [1, 2], cost: toMoney(8.99, currency) },
                returns: { return_window_days: 30, free_returns: true },
              },
              {
                tier: 'bad_returns',
                risk_tier: 'high_risk',
                merchant_id: 'merch_demo_bad_returns',
                merchant_name: 'Strict Returns Co.',
                fulfillment_type: 'merchant',
                inventory: { in_stock: true },
                price: toMoney(23.49, currency),
                shipping: { method_label: 'Standard', eta_days_range: [3, 5], cost: toMoney(4.49, currency) },
                returns: { return_window_days: 7, free_returns: false },
              },
	            ]
	              .slice(0, limit)
	              .map((o) => ({
	                offer_id:
	                  buildOfferId({
	                    merchant_id: o.merchant_id,
	                    product_group_id: productGroupId,
	                    fulfillment_type: o.fulfillment_type,
	                    tier: o.tier,
	                  }) ||
	                  `of:v1:${o.merchant_id}:${productGroupId}:${o.fulfillment_type || 'merchant'}:${o.tier || 'default'}`,
	                product_group_id: productGroupId,
	                ...o,
	              }));

            const bestPriceOfferId =
              offers.find((o) => o.tier === 'cheap_slow')?.offer_id || offers[0]?.offer_id || null;
            const defaultOfferId =
              offers.find((o) => o.tier === 'fast_premium')?.offer_id || bestPriceOfferId;

            return {
              offers,
              bestPriceOfferId,
              defaultOfferId,
            };
          };

          let offers = [];
          let bestPriceOfferId = null;
          let defaultOfferId = null;

          if (productId === 'BOTTLE_001') {
            const bundle = buildBottleOffers();
            offers = bundle.offers;
            bestPriceOfferId = bundle.bestPriceOfferId;
            defaultOfferId = bundle.defaultOfferId;
          } else {
            const mid = requestedMerchantId || DEFAULT_MERCHANT_ID;
            const product = getProductById(mid, productId);
            if (!product) {
              return res.status(404).json({ error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
	            }
	            const single = {
	              offer_id:
	                buildOfferId({
	                  merchant_id: mid,
	                  product_group_id: productGroupId,
	                  fulfillment_type: 'merchant',
	                  tier: 'single',
	                }) || `of:v1:${mid}:${productGroupId}:merchant:single`,
	              product_group_id: productGroupId,
	              tier: 'single',
	              risk_tier: 'standard',
	              merchant_id: mid,
              merchant_name: product.merchant_name || product.store_name || null,
              fulfillment_type: 'merchant',
              inventory: { in_stock: Boolean(product.in_stock) },
              price: toMoney(product.price, product.currency || currency),
              shipping: product.shipping || undefined,
              returns: product.returns || undefined,
            };
            offers = [single];
            bestPriceOfferId = single.offer_id;
            defaultOfferId = single.offer_id;
          }

	          mockResponse = {
	            status: 'success',
	            success: true,
	            product_group_id: productGroupId,
	            offers_count: offers.length,
	            ...(includeOffers ? { offers } : {}),
	            default_offer_id: defaultOfferId,
	            best_price_offer_id: bestPriceOfferId,
	            ...(debug ? { cache: { hit: false, age_ms: 0, ttl_ms: RESOLVE_PRODUCT_CANDIDATES_TTL_MS } } : {}),
	          };
	          break;
	        }
        
        case 'get_product_detail': {
          const product = getProductById(
            payload.product?.merchant_id || 'merch_208139f7600dbf42',
            payload.product?.product_id
          );
          
          if (product) {
            const merchantId =
              product.merchant_id || payload.product?.merchant_id || DEFAULT_MERCHANT_ID;
            const productId = product.product_id || payload.product?.product_id;

	            const platform = String(product.platform || '').trim();
	            const platformProductId = String(product.platform_product_id || '').trim();
	            const productGroupId =
	              (platform && platformProductId
	                ? buildProductGroupId({ platform, platform_product_id: platformProductId })
	                : productId === 'BOTTLE_001'
	                  ? buildProductGroupId({ platform: 'mock', platform_product_id: productId })
	                  : buildProductGroupId({ merchant_id: merchantId, product_id: productId })) ||
	              (platform && platformProductId
	                ? `pg:${platform}:${platformProductId}`
	                : productId === 'BOTTLE_001'
	                  ? `pg:mock:${productId}`
	                  : `pg:${merchantId}:${productId}`);

            function toMoney(amount, currency) {
              return { amount: Number(amount) || 0, currency: currency || 'USD' };
            }

            function buildBottleOffers() {
              const currency = product.currency || 'USD';
              const offers = [
                {
                  tier: 'cheap_slow',
                  merchant_id: 'merch_demo_cheap_slow',
                  merchant_name: 'Budget Seller',
                  fulfillment_type: 'merchant',
                  inventory: { in_stock: true },
                  price: toMoney(19.99, currency),
                  shipping: {
                    method_label: 'Standard',
                    eta_days_range: [7, 10],
                    cost: toMoney(1.99, currency),
                  },
                  returns: { return_window_days: 30, free_returns: true },
                },
                {
                  tier: 'fast_premium',
                  merchant_id: 'merch_demo_fast_premium',
                  merchant_name: 'FastShip Plus',
                  fulfillment_type: 'merchant',
                  inventory: { in_stock: true },
                  price: toMoney(25.99, currency),
                  shipping: {
                    method_label: 'Express',
                    eta_days_range: [1, 2],
                    cost: toMoney(8.99, currency),
                  },
                  returns: { return_window_days: 30, free_returns: true },
                },
                {
                  tier: 'bad_returns',
                  merchant_id: 'merch_demo_bad_returns',
                  merchant_name: 'Strict Returns Co.',
                  fulfillment_type: 'merchant',
                  inventory: { in_stock: true },
                  price: toMoney(23.49, currency),
                  shipping: {
                    method_label: 'Standard',
                    eta_days_range: [3, 5],
                    cost: toMoney(4.49, currency),
                  },
                  returns: { return_window_days: 7, free_returns: false },
                },
	              ].map((o) => ({
	                offer_id:
	                  buildOfferId({
	                    merchant_id: o.merchant_id,
	                    product_group_id: productGroupId,
	                    fulfillment_type: o.fulfillment_type,
	                    tier: o.tier,
	                  }) ||
	                  `of:v1:${o.merchant_id}:${productGroupId}:${o.fulfillment_type || 'merchant'}:${o.tier || 'default'}`,
	                product_group_id: productGroupId,
	                ...o,
	              }));

              const bestPriceOfferId = offers.find((o) => o.tier === 'cheap_slow')?.offer_id || offers[0].offer_id;
              const defaultOfferId = offers.find((o) => o.tier === 'fast_premium')?.offer_id || bestPriceOfferId;

              return { offers, defaultOfferId, bestPriceOfferId };
            }

            const offerBundle =
              productId === 'BOTTLE_001'
                ? buildBottleOffers()
	                : (() => {
	                    const currency = product.currency || 'USD';
	                    const single = {
	                      offer_id:
	                        buildOfferId({
	                          merchant_id: merchantId,
	                          product_group_id: productGroupId,
	                          fulfillment_type: 'merchant',
	                          tier: 'single',
	                        }) || `of:v1:${merchantId}:${productGroupId}:merchant:single`,
	                      product_group_id: productGroupId,
	                      tier: 'single',
	                      merchant_id: merchantId,
                      merchant_name: product.merchant_name || product.store_name || null,
                      fulfillment_type: 'merchant',
                      inventory: { in_stock: Boolean(product.in_stock) },
                      price: toMoney(product.price, currency),
                      shipping: product.shipping || undefined,
                      returns: product.returns || undefined,
                    };
                    return { offers: [single], defaultOfferId: single.offer_id, bestPriceOfferId: single.offer_id };
                  })();

            const pdpOptions = getPdpOptions(payload);
            const includePdp = shouldIncludePdp(payload);
            let relatedProducts = [];
            if (pdpOptions.includeRecommendations) {
              const bypassCache =
                payload?.options?.no_cache === true ||
                payload?.options?.cache_bypass === true ||
                payload?.options?.bypass_cache === true;
              try {
                const rec = await recommendPdpProducts({
                  pdp_product: product,
                  k: payload.recommendations?.limit || 6,
                  locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
                  currency: product.currency || 'USD',
                  options: {
                    debug: pdpOptions.debug,
                    no_cache: bypassCache,
                    cache_bypass: bypassCache,
                    bypass_cache: bypassCache,
                  },
                });
                relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
              } catch {
                // non-blocking
                relatedProducts = [];
              }
            }

            mockResponse = {
              status: 'success',
              product: product,
              product_group_id: productGroupId,
              offers: offerBundle.offers,
              offers_count: offerBundle.offers.length,
              default_offer_id: offerBundle.defaultOfferId,
              best_price_offer_id: offerBundle.bestPriceOfferId,
              ...(includePdp
                ? {
                    pdp_payload: buildPdpPayload({
                      product,
                      relatedProducts,
                      entryPoint: pdpOptions.entryPoint,
                      experiment: pdpOptions.experiment,
                      templateHint: pdpOptions.templateHint,
                      includeEmptyReviews: pdpOptions.includeEmptyReviews,
                      debug: pdpOptions.debug,
                    }),
                  }
                : {}),
            };
          } else {
            return res.status(404).json({
              error: 'PRODUCT_NOT_FOUND',
              message: 'Product not found'
            });
          }
          break;
        }

	        case 'get_pdp': {
	          const product = getProductById(
	            payload.product?.merchant_id || 'merch_208139f7600dbf42',
	            payload.product?.product_id
	          );

          if (!product) {
            return res.status(404).json({
              error: 'PRODUCT_NOT_FOUND',
              message: 'Product not found',
            });
          }

          const pdpOptions = getPdpOptions(payload);
          let relatedProducts = [];
          if (pdpOptions.includeRecommendations) {
            const bypassCache =
              payload?.options?.no_cache === true ||
              payload?.options?.cache_bypass === true ||
              payload?.options?.bypass_cache === true;
            try {
              const rec = await recommendPdpProducts({
                pdp_product: product,
                k: payload.recommendations?.limit || 6,
                locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
                currency: product.currency || 'USD',
                options: {
                  debug: pdpOptions.debug,
                  no_cache: bypassCache,
                  cache_bypass: bypassCache,
                  bypass_cache: bypassCache,
                },
              });
              relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
            } catch {
              // non-blocking
              relatedProducts = [];
            }
          }

	          mockResponse = {
	            status: 'success',
	            product,
	            pdp_payload: buildPdpPayload({
	              product,
	              relatedProducts,
	              entryPoint: pdpOptions.entryPoint,
	              experiment: pdpOptions.experiment,
	              templateHint: pdpOptions.templateHint,
	              includeEmptyReviews: pdpOptions.includeEmptyReviews,
	              debug: pdpOptions.debug,
	            }),
	          };
	          break;
	        }

	        case 'get_pdp_v2': {
	          const product = getProductById(
	            payload.product?.merchant_id || DEFAULT_MERCHANT_ID,
	            payload.product?.product_id,
	          );

	          if (!product) {
	            return res.status(404).json({
	              error: 'PRODUCT_NOT_FOUND',
	              message: 'Product not found',
	            });
	          }

	          const includeList = Array.isArray(payload.include)
	            ? payload.include.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
	            : [];
	          const includeAll = includeList.includes('all');
	          const wantsSimilar = includeAll || includeList.includes('similar') || includeList.includes('recommendations');
	          const wantsOffers = includeAll || includeList.includes('offers');
	          const wantsReviews = includeAll || includeList.includes('reviews_preview');

	          const pdpOptions = getPdpOptions(payload);
	          let relatedProducts = [];
	          if (wantsSimilar) {
	            const bypassCache =
	              payload?.options?.no_cache === true ||
	              payload?.options?.cache_bypass === true ||
	              payload?.options?.bypass_cache === true;
	            try {
	              const rec = await recommendPdpProducts({
	                pdp_product: product,
	                k: payload.recommendations?.limit || 6,
	                locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
	                currency: product.currency || 'USD',
	                options: {
	                  debug: pdpOptions.debug,
	                  no_cache: bypassCache,
	                  cache_bypass: bypassCache,
	                  bypass_cache: bypassCache,
	                },
	              });
	              relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
	            } catch {
	              // non-blocking
	              relatedProducts = [];
	            }
	          }

	          const pdpPayload = buildPdpPayload({
	            product,
	            relatedProducts,
	            entryPoint: pdpOptions.entryPoint,
	            experiment: pdpOptions.experiment,
	            templateHint: pdpOptions.templateHint,
	            includeEmptyReviews: wantsReviews || pdpOptions.includeEmptyReviews,
	            debug: pdpOptions.debug,
	          });

	          const reviewsModule = Array.isArray(pdpPayload.modules)
	            ? pdpPayload.modules.find((m) => m?.type === 'reviews_preview')
	            : null;
	          const recModule = Array.isArray(pdpPayload.modules)
	            ? pdpPayload.modules.find((m) => m?.type === 'recommendations')
	            : null;

	          const modules = [
	            {
	              type: 'canonical',
	              required: true,
	              data: { pdp_payload: pdpPayload },
	            },
	          ];

	          if (wantsOffers) {
	            modules.push({
	              type: 'offers',
	              required: false,
	              data: {
	                offers_count: 1,
	                offers: [
	                  {
	                    offer_id: `of:mock:${product.merchant_id || DEFAULT_MERCHANT_ID}:${product.id || product.product_id}`,
	                    merchant_id: product.merchant_id || DEFAULT_MERCHANT_ID,
	                    merchant_name: product.merchant_name || product.store_name || undefined,
	                    price: normalizeOfferMoney(product.price, product.currency || 'USD'),
	                  },
	                ],
	              },
	            });
	          }

	          if (wantsReviews) {
	            modules.push({
	              type: 'reviews_preview',
	              required: false,
	              data: reviewsModule?.data || null,
	              ...(reviewsModule?.data ? {} : { reason: 'unavailable' }),
	            });
	          }

	          if (wantsSimilar) {
	            modules.push({
	              type: 'similar',
	              required: false,
	              data: recModule?.data || null,
	              ...(recModule?.data ? {} : { reason: 'unavailable' }),
	            });
	          }

	          const missing = [];
	          if (wantsReviews && !reviewsModule?.data) missing.push({ type: 'reviews_preview', reason: 'unavailable' });
	          if (wantsSimilar && !recModule?.data) missing.push({ type: 'similar', reason: 'unavailable' });

	          mockResponse = {
	            status: 'success',
	            pdp_version: '2.0',
	            request_id: `mock_${Date.now()}`,
	            build_id: SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null,
	            generated_at: new Date().toISOString(),
	            subject: { type: 'product', id: String(product.id || product.product_id || '') },
	            capabilities: { client: metadata?.source || 'mock' },
	            modules,
	            warnings: [],
	            missing,
              metadata: {
                detail_source: 'mock',
                module_degrade: {
                  applied: missing.length > 0,
                  modules: missing.map((item) => ({
                    type: item?.type || 'unknown',
                    reason: item?.reason || 'unavailable',
                  })),
                },
              },
	          };
	          break;
	        }
	        
	        case 'create_order': {
	          // Mock order creation
	          const order = payload.order || {};
          const offerIdRaw =
            order.offer_id || order.offerId || payload.offer_id || payload.offerId || null;
          const offerId = String(offerIdRaw || '').trim() || null;
          const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
          const items = Array.isArray(order.items) ? order.items : [];
          const merchantId =
            merchantFromOffer ||
            items[0]?.merchant_id ||
            order.merchant_id ||
            payload.merchant_id ||
            null;

          mockResponse = {
            status: 'success',
            order_id: `ORD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase(),
            total: items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0) || 0,
            currency: 'USD',
            status: 'pending',
            ...(offerId ? { resolved_offer_id: offerId } : {}),
            ...(merchantId ? { resolved_merchant_id: merchantId } : {}),
          };
          const orderLines = buildOrderLineSnapshots(order, {
            orderId: mockResponse.order_id,
            resolvedOfferId: offerId,
            resolvedMerchantId: merchantId,
          });
          if (orderLines.length) {
            mockResponse.order_lines = orderLines;
          }
          break;
        }

        case 'preview_quote': {
          const quote = payload.quote || {};
          const offerIdRaw =
            quote.offer_id || quote.offerId || payload.offer_id || payload.offerId || null;
          const offerId = String(offerIdRaw || '').trim() || null;
          const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
          const resolvedMerchantId =
            merchantFromOffer || quote.merchant_id || payload.merchant_id || null;

          const items = quote.items || [];
          const subtotal = items.reduce(
            (sum, item) => sum + (Number(item.unit_price || item.price || 0) * Number(item.quantity || 0)),
            0
          );
          mockResponse = {
            quote_id: `q_${Date.now().toString(36)}`,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            engine: 'mock',
            currency: 'USD',
            pricing: {
              subtotal,
              discount_total: 0,
              shipping_fee: 0,
              tax: 0,
              total: subtotal,
            },
            promotion_lines: [],
            line_items: items.map((it) => ({
              variant_id: it.variant_id || it.sku_id || it.sku || it.product_id,
              quantity: it.quantity,
              unit_price_original: it.unit_price || it.price || 0,
              unit_price_effective: it.unit_price || it.price || 0,
              line_discount_total: 0,
              compare_at_savings: 0,
            })),
            ...(offerId ? { resolved_offer_id: offerId } : {}),
            ...(resolvedMerchantId ? { resolved_merchant_id: resolvedMerchantId } : {}),
          };
          break;
        }
        
        case 'submit_payment': {
          // Mock payment submission
          mockResponse = {
            status: 'success',
            payment_id: `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase(),
            status: 'processing',
            message: 'Payment is being processed'
          };
          break;
        }
        
        case 'get_order_status': {
          // Mock order status
          mockResponse = {
            status: 'success',
            order: {
              order_id: payload.order?.order_id,
              status: 'processing',
              created_at: new Date().toISOString(),
              total: 50.00,
              currency: 'USD'
            }
          };
          break;
        }
        
        default:
          return res.status(400).json({
            error: 'UNSUPPORTED_OPERATION',
            message: `Operation ${operation} not implemented in mock mode`
          });
      }
      
      let maybePolicy = mockResponse;
      if (operation === 'find_products_multi' && effectiveIntent) {
        maybePolicy = applyFindProductsMultiPolicy({
          response: mockResponse,
          intent: effectiveIntent,
          requestPayload: effectivePayload,
          metadata: policyMetadata,
          rawUserQuery,
        });
      }

      const promotions = await getActivePromotions(now, creatorId);
      const enriched = applyDealsToResponse(maybePolicy, promotions, now, creatorId);
      return res.json(enriched);
    } catch (err) {
      logger.error({ err: err.message }, 'Mock handler error');
      return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
    }
  }

	  if (operation === 'get_pdp_v2') {
	    const pdpV2StartedAt = Date.now();
	    const pdpV2PhaseTimings = {};
	    const pdpV2ModuleTimings = {};
	    const markPdpV2Phase = (name, startedAt) => {
	      pdpV2PhaseTimings[name] = Date.now() - startedAt;
	    };
	    const markPdpV2Module = (name, startedAt) => {
	      pdpV2ModuleTimings[name] = Date.now() - startedAt;
	    };
	    try {
	      const parseRequestStartedAt = Date.now();
	      const productRef = payload.product_ref || payload.productRef || payload.product || {};
	      let productId = String(
	        productRef.product_id || productRef.productId || payload.product_id || payload.productId || '',
	      ).trim();
	      let requestedMerchantId = String(
	        productRef.merchant_id || productRef.merchantId || payload.merchant_id || payload.merchantId || '',
	      ).trim();
	      const offerId = String(
	        productRef.offer_id || productRef.offerId || payload.offer_id || payload.offerId || '',
	      ).trim();
	      const variantId = String(
	        productRef.variant_id ||
	          productRef.variantId ||
	          productRef.sku_id ||
	          productRef.skuId ||
	          payload.variant_id ||
	          payload.variantId ||
	          payload.sku_id ||
	          payload.skuId ||
	          '',
	      ).trim();
	      const parsedOffer = offerId ? parseOfferId(offerId) : null;
	      if (!requestedMerchantId && parsedOffer?.merchant_id) {
	        requestedMerchantId = String(parsedOffer.merchant_id || '').trim();
	      }
	      if (!requestedMerchantId && offerId) {
	        const inferred = extractMerchantIdFromOfferId(offerId);
	        if (inferred) requestedMerchantId = inferred;
	      }
	      const platform = String(productRef.platform || payload.platform || '').trim() || null;
	      const options = payload.options || payload.product?.options || {};
	      const debug =
        options.debug === true ||
        String(options.debug || '').trim().toLowerCase() === 'true' ||
        payload.debug === true;
      const bypassCache =
        options.no_cache === true ||
        options.cache_bypass === true ||
        options.bypass_cache === true ||
        String(options.no_cache || '').trim().toLowerCase() === 'true' ||
        String(options.cache_bypass || options.bypass_cache || '')
          .trim()
          .toLowerCase() === 'true';

      const includeRaw = payload.include;
      const includeList = Array.isArray(includeRaw)
        ? includeRaw.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
        : typeof includeRaw === 'string'
          ? includeRaw
              .split(',')
              .map((v) => String(v || '').trim().toLowerCase())
              .filter(Boolean)
          : [];
	      const includeAll = includeList.includes('all');
	      const wantsOffers = includeAll || includeList.includes('offers');
	      const wantsReviewsPreview = includeAll || includeList.includes('reviews_preview');
	      const wantsSimilar =
	        includeAll ||
	        includeList.includes('similar') ||
	        includeList.includes('recommendations');
	      markPdpV2Phase('parse_request', parseRequestStartedAt);

	      // Resolve the canonical product group first so every client sees the same details.
	      let productGroupId = null;
	      let groupMembers = [];
	      let canonicalProductRef = null;

	      const subject = payload.subject && typeof payload.subject === 'object' ? payload.subject : null;
	      const subjectType = subject ? String(subject.type || '').trim().toLowerCase() : '';
	      const subjectId = subject ? String(subject.id || '').trim() : '';

	      const offerProductGroupId = String(parsedOffer?.product_group_id || '').trim() || null;
	      const hasExplicitProductGroup = subjectType === 'product_group' && subjectId;

	      if (!productId && !variantId && !offerProductGroupId && !hasExplicitProductGroup) {
	        return res.status(400).json({
	          error: 'MISSING_PARAMETERS',
	          message:
	            'product_ref.product_id (or product_ref.variant_id + merchant_id, or product_ref.offer_id, or subject=product_group) is required for get_pdp_v2',
	        });
	      }

	      const entryProductId = productId;

	      const shouldResolveVariantToProduct =
	        Boolean(variantId) &&
	        Boolean(requestedMerchantId) &&
	        (!productId || productId === variantId);
	      const resolveVariantStartedAt = Date.now();
	      if (shouldResolveVariantToProduct) {
	        try {
	          const rawVariant = await fetchVariantDetailFromUpstream({
	            merchantId: requestedMerchantId,
	            variantId,
	            checkoutToken,
	          }).catch(() => null);
	          const normalizedVariant = normalizeAgentProductDetailResponse(rawVariant);
	          const variantProduct =
	            normalizedVariant && typeof normalizedVariant === 'object' ? normalizedVariant.product : null;
	          const resolvedProductId = variantProduct
	            ? String(variantProduct.id || variantProduct.product_id || variantProduct.productId || '').trim()
	            : '';
	          if (resolvedProductId) productId = resolvedProductId;
	        } catch {
	          // Ignore and fall back to product_id/offer_id flow.
	        }
	      }
	      markPdpV2Phase('resolve_variant_to_product', resolveVariantStartedAt);

		      if (!productId && !offerProductGroupId && !hasExplicitProductGroup) {
		        // If the caller only provided a merchant-scoped variant id (no product_id) and we
		        // couldn't resolve it to a canonical product id, treat it as not-found instead of
		        // a missing-parameter error. This prevents clients from hanging on slow fallback
		        // scans when the variant truly doesn't exist for the merchant.
		        if (variantId && requestedMerchantId && !entryProductId) {
		          return res.status(404).json({
		            error: 'PRODUCT_NOT_FOUND',
		            message: 'Variant not found',
		          });
		        }
		        return res.status(400).json({
		          error: 'MISSING_PARAMETERS',
		          message:
		            'product_ref.product_id is required unless you provide product_ref.offer_id or subject=product_group',
		        });
		      }
	      const resolveSubjectGroupStartedAt = Date.now();
	      if (subjectType === 'product_group' && subjectId) {
	        try {
	          const fetchedGroup = await fetchProductGroupMembersFromUpstream({
	            productGroupId: subjectId,
            checkoutToken,
          }).catch(() => null);
          const membersRaw = Array.isArray(fetchedGroup?.members)
            ? fetchedGroup.members
            : Array.isArray(fetchedGroup?.items)
              ? fetchedGroup.items
              : [];
          const members = membersRaw
            .map((m) => ({
              merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
              merchant_name: m?.merchant_name || m?.merchantName || undefined,
              product_id: String(m?.product_id || m?.productId || '').trim(),
              platform: m?.platform ? String(m.platform).trim() : undefined,
              is_primary: Boolean(m?.is_primary || m?.isPrimary),
            }))
            .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));
          if (members.length) {
            productGroupId = subjectId;
            groupMembers = members;
            const canonicalMember =
              members.find((m) => m.is_primary) || members[0] || null;
            canonicalProductRef = canonicalMember
              ? {
                  merchant_id: canonicalMember.merchant_id,
                  product_id: canonicalMember.product_id,
                  ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
                }
              : null;
          }
        } catch {
          // Ignore and fall back to resolve-by-product-id.
	        }
	      }
	      markPdpV2Phase('resolve_subject_group', resolveSubjectGroupStartedAt);

	      const resolveOfferGroupStartedAt = Date.now();
	      if (!canonicalProductRef && offerProductGroupId) {
	        try {
	          const fetchedGroup = await fetchProductGroupMembersFromUpstream({
	            productGroupId: offerProductGroupId,
	            checkoutToken,
	          }).catch(() => null);
	          const membersRaw = Array.isArray(fetchedGroup?.members)
	            ? fetchedGroup.members
	            : Array.isArray(fetchedGroup?.items)
	              ? fetchedGroup.items
	              : [];
	          const members = membersRaw
	            .map((m) => ({
	              merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
	              merchant_name: m?.merchant_name || m?.merchantName || undefined,
	              product_id: String(m?.product_id || m?.productId || '').trim(),
	              platform: m?.platform ? String(m.platform).trim() : undefined,
	              is_primary: Boolean(m?.is_primary || m?.isPrimary),
	            }))
	            .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));
	          if (members.length) {
	            productGroupId = offerProductGroupId;
	            groupMembers = members;
	            const canonicalMember =
	              members.find((m) => m.is_primary) || members[0] || null;
	            canonicalProductRef = canonicalMember
	              ? {
	                  merchant_id: canonicalMember.merchant_id,
	                  product_id: canonicalMember.product_id,
	                  ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
	                }
	              : null;
	          }
	        } catch {
	          // Ignore and fall back to resolve-by-product-id.
	        }
	      }
	      markPdpV2Phase('resolve_offer_group', resolveOfferGroupStartedAt);

		      if (!productId && canonicalProductRef?.product_id) {
		        productId = String(canonicalProductRef.product_id || '').trim();
		      }

	      // Fast-fail for merchant-scoped PDP requests where the entry product doesn't exist.
	      // We keep this as a soft precheck: do not fail the whole PDP when upstream jitters.
	      let precheckedMerchantProduct = null;
	      let precheckEntryProductMissing = false;
	      const shouldPrecheckMerchantScoped =
	        Boolean(requestedMerchantId) &&
	        Boolean(productId) &&
	        !offerProductGroupId &&
	        !hasExplicitProductGroup;
	      const precheckEntryProductStartedAt = Date.now();
	      if (shouldPrecheckMerchantScoped) {
	        precheckedMerchantProduct = await fetchProductDetailForOffers({
		          merchantId: requestedMerchantId,
		          productId,
		          checkoutToken,
		        });
	        precheckEntryProductMissing = !precheckedMerchantProduct;
	        if (precheckEntryProductMissing) {
	          logger.info(
	            {
	              requested_merchant_id: requestedMerchantId,
	              product_id: productId,
	              has_product_group_hint: hasExplicitProductGroup || Boolean(offerProductGroupId),
	            },
	            'get_pdp_v2 entry precheck miss; continuing with canonical/group resolution',
	          );
	        }
	      }
	      markPdpV2Phase('precheck_entry_product', precheckEntryProductStartedAt);

	      const resolveGroupCachedStartedAt = Date.now();
	      if (!canonicalProductRef) {
	        const resolvedGroup = await resolveProductGroupCached({
		          productId,
	          merchantId: requestedMerchantId || null,
          platform,
          checkoutToken,
          bypassCache,
          debug: false,
        }).catch(() => null);
        const pgid = resolvedGroup?.product_group_id || null;
        productGroupId = typeof pgid === 'string' && pgid.trim() ? pgid.trim() : productGroupId;
        groupMembers = Array.isArray(resolvedGroup?.members) ? resolvedGroup.members : groupMembers;
	        if (resolvedGroup?.canonical_product_ref) {
	          canonicalProductRef = resolvedGroup.canonical_product_ref;
	        }
	      }
	      markPdpV2Phase('resolve_group_cached', resolveGroupCachedStartedAt);

	      if (!canonicalProductRef) {
	        canonicalProductRef = {
	          merchant_id: requestedMerchantId || DEFAULT_MERCHANT_ID,
	          product_id: productId,
          ...(platform ? { platform } : {}),
        };
		      }

	      // Fetch canonical detail (cached via products_cache + memory cache).
	      const fetchCanonicalProductStartedAt = Date.now();
	      const canonicalProduct =
	        precheckedMerchantProduct &&
	        canonicalProductRef.merchant_id === requestedMerchantId &&
		        canonicalProductRef.product_id === productId
		          ? precheckedMerchantProduct
		          : await fetchProductDetailForOffers({
		              merchantId: canonicalProductRef.merchant_id,
	              productId: canonicalProductRef.product_id,
	              checkoutToken,
	            });
	      markPdpV2Phase('fetch_canonical_product', fetchCanonicalProductStartedAt);

	      if (!canonicalProduct) {
	        return res.status(404).json({
	          error: 'PRODUCT_NOT_FOUND',
	          message: 'Product not found',
	        });
	      }

	      const entryProductRef = {
	        product_id: entryProductId || productId || canonicalProductRef.product_id,
	        ...(requestedMerchantId ? { merchant_id: requestedMerchantId } : {}),
	        ...(variantId ? { variant_id: variantId } : {}),
	        ...(offerId ? { offer_id: offerId } : {}),
	        ...(platform ? { platform } : {}),
	      };

	      const pdpOptions = getPdpOptions(payload);
	      let canonicalProductForPdp = canonicalProduct;
	      const reviewSummaryPromise = wantsReviewsPreview
	        ? (async () => {
	            const moduleStartedAt = Date.now();
	            try {
	            const reviewPlatform = String(
	              canonicalProduct.platform || canonicalProductRef.platform || '',
	            ).trim();
	            const reviewPlatformProductId = String(
	              canonicalProduct.platform_product_id ||
	                canonicalProduct.platformProductId ||
	                canonicalProduct.shopify_id ||
	                canonicalProduct.product_id ||
	                canonicalProduct.id ||
	                canonicalProductRef.product_id ||
	                '',
	            ).trim();
	            if (!reviewPlatform || !reviewPlatformProductId) return null;
	            return fetchReviewSummaryCached({
	              merchantId: canonicalProductRef.merchant_id,
	              platform: reviewPlatform,
	              platformProductId: reviewPlatformProductId,
	              checkoutToken,
	              bypassCache,
	            }).catch(() => null);
	            } finally {
	              markPdpV2Module('reviews_preview', moduleStartedAt);
	            }
	          })()
	        : Promise.resolve(null);

	      // Similar products (non-blocking; can be requested by include=similar).
	      // Run in parallel with reviews fetch to avoid additive latency on first paint.
	      const relatedProductsPromise = wantsSimilar
	        ? (async () => {
	            const moduleStartedAt = Date.now();
	            try {
	            const limit = payload?.similar?.limit || payload?.recommendations?.limit || 6;
	            return fetchSimilarProductsDeduped({
              pdp_product: canonicalProduct,
              k: limit,
              locale:
                payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
              currency: canonicalProduct.currency || 'USD',
	              options: {
	                debug,
	                // Respect caller cache controls (same semantics as resolve op).
	                no_cache: bypassCache,
                cache_bypass: bypassCache,
	                bypass_cache: bypassCache,
	              },
	            });
	            } finally {
	              markPdpV2Module('similar', moduleStartedAt);
	            }
	          })()
	        : Promise.resolve([]);

	      const fetchOptionalModulesStartedAt = Date.now();
	      const [reviewSummaryResult, relatedProductsResult] = await Promise.allSettled([
	        reviewSummaryPromise,
	        relatedProductsPromise,
	      ]);
	      markPdpV2Phase('fetch_optional_modules_parallel', fetchOptionalModulesStartedAt);

	      if (
	        reviewSummaryResult.status === 'fulfilled' &&
	        reviewSummaryResult.value &&
	        typeof reviewSummaryResult.value === 'object'
	      ) {
	        canonicalProductForPdp = {
	          ...canonicalProductForPdp,
	          review_summary: reviewSummaryResult.value,
	        };
	      }

	      let relatedProducts = [];
	      if (relatedProductsResult.status === 'fulfilled') {
	        relatedProducts = Array.isArray(relatedProductsResult.value)
	          ? relatedProductsResult.value
	          : [];
	      } else if (wantsSimilar) {
	        logger.warn(
	          {
	            err:
	              relatedProductsResult?.reason?.message ||
	              String(relatedProductsResult?.reason || 'unknown'),
	            product_id: canonicalProductRef.product_id,
	          },
	          'PDP recommendations failed; returning without similar module',
	        );
	      }

      const pdpPayload = buildPdpPayload({
        product: canonicalProductForPdp,
        relatedProducts,
        entryPoint: pdpOptions.entryPoint,
        experiment: pdpOptions.experiment,
        templateHint: pdpOptions.templateHint,
        includeEmptyReviews: wantsReviewsPreview || pdpOptions.includeEmptyReviews,
        debug: pdpOptions.debug,
      });

      const reviewsModule = Array.isArray(pdpPayload.modules)
        ? pdpPayload.modules.find((m) => m?.type === 'reviews_preview')
        : null;
      const recModule = Array.isArray(pdpPayload.modules)
        ? pdpPayload.modules.find((m) => m?.type === 'recommendations')
        : null;

      const canonicalPayload = {
        ...pdpPayload,
        modules: Array.isArray(pdpPayload.modules)
          ? pdpPayload.modules.filter(
              (m) => m?.type !== 'reviews_preview' && m?.type !== 'recommendations',
            )
          : [],
      };

      const modules = [
        {
          type: 'canonical',
          required: true,
          data: {
            product_group_id: productGroupId,
            canonical_product_ref: canonicalProductRef,
            entry_product_ref: entryProductRef,
            pdp_payload: canonicalPayload,
            ...(precheckEntryProductMissing ? { entry_precheck_missing: true } : {}),
          },
        },
      ];

      const missing = [];

	      if (wantsOffers) {
	        const offersModuleStartedAt = Date.now();
	        let offersData = null;
	        try {
          const fallbackProductGroupId =
            productGroupId ||
            (canonicalProduct.platform && canonicalProduct.platform_product_id
              ? buildProductGroupId({
                  platform: String(canonicalProduct.platform || '').trim(),
                  platform_product_id: String(canonicalProduct.platform_product_id || '').trim(),
                })
              : null) ||
            `pg:pid:${String(canonicalProductRef.product_id || productId).trim()}`;

          offersData =
            groupMembers.length > 0
              ? await buildOffersFromGroupMembers({
                  productGroupId,
                  members: groupMembers,
                  checkoutToken,
                  limit: payload?.offers?.limit || 10,
                  preferredMerchantId: requestedMerchantId || null,
                })
              : {
                  status: 'success',
                  product_group_id: fallbackProductGroupId,
	                  canonical_product_ref: canonicalProductRef,
	                  offers_count: 1,
	                  offers: [
	                    {
	                      offer_id: (() => {
	                        const mid = String(canonicalProductRef.merchant_id || '').trim();
	                        return (
	                          buildOfferId({
	                            merchant_id: mid,
	                            product_group_id: fallbackProductGroupId,
	                            fulfillment_type: canonicalProduct.fulfillment_type || 'merchant',
	                            tier: 'default',
	                          }) ||
	                          `of:v1:${mid}:${fallbackProductGroupId}:${canonicalProduct.fulfillment_type || 'merchant'}:default`
	                        );
	                      })(),
	                      product_group_id: fallbackProductGroupId,
	                      product_id: canonicalProductRef.product_id,
	                      merchant_id: canonicalProductRef.merchant_id,
	                      merchant_name:
	                        canonicalProduct.merchant_name || canonicalProduct.store_name || undefined,
                      price: normalizeOfferMoney(canonicalProduct.price, canonicalProduct.currency || 'USD'),
                      shipping: canonicalProduct.shipping || undefined,
                      returns: canonicalProduct.returns || undefined,
                      inventory: {
                        in_stock: typeof canonicalProduct.in_stock === 'boolean' ? canonicalProduct.in_stock : undefined,
                      },
	                      fulfillment_type: canonicalProduct.fulfillment_type || undefined,
	                      risk_tier: 'standard',
	                    },
	                  ],
	                  default_offer_id: null,
	                  best_price_offer_id: null,
	                };
        } catch {
          offersData = null;
        }

        if (offersData) {
          const offers = Array.isArray(offersData.offers) ? offersData.offers : [];
          const fallbackOfferId = offers[0]?.offer_id || null;
          if (fallbackOfferId) {
            if (!offersData.default_offer_id) offersData.default_offer_id = fallbackOfferId;
            if (!offersData.best_price_offer_id) offersData.best_price_offer_id = fallbackOfferId;
          }
          modules.push({
            type: 'offers',
            required: false,
            data: offersData,
          });
	        } else {
	          modules.push({
            type: 'offers',
            required: false,
            data: null,
            reason: 'unavailable',
          });
	          missing.push({ type: 'offers', reason: 'unavailable' });
	        }
	        markPdpV2Module('offers', offersModuleStartedAt);
	      }

      if (wantsReviewsPreview) {
        const data = reviewsModule?.data || null;
        modules.push({
          type: 'reviews_preview',
          required: false,
          data,
          ...(data ? {} : { reason: 'unavailable' }),
        });
        if (!data) missing.push({ type: 'reviews_preview', reason: 'unavailable' });
      }

      if (wantsSimilar) {
        const data = recModule?.data || null;
        modules.push({
          type: 'similar',
          required: false,
          data,
          ...(data ? {} : { reason: 'unavailable' }),
        });
        if (!data) missing.push({ type: 'similar', reason: 'unavailable' });
      }

	      const buildId = SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null;
	      const capabilities = {
        client:
          payload?.capabilities?.client ||
          payload?.capabilities?.client_name ||
          metadata?.source ||
          null,
        client_version:
          payload?.capabilities?.client_version ||
          payload?.capabilities?.clientVersion ||
          null,
      };

	      const responsePayload = {
	        status: 'success',
	        pdp_version: '2.0',
	        request_id: gatewayRequestId,
        build_id: buildId,
        generated_at: new Date().toISOString(),
        subject: productGroupId
          ? { type: 'product_group', id: productGroupId, canonical_product_ref: canonicalProductRef }
          : { type: 'product', id: canonicalProductRef.product_id, canonical_product_ref: canonicalProductRef },
	        capabilities,
	        modules,
	        warnings: debug ? [] : [],
	        missing,
          metadata: {
            detail_source: getProductDetailSource(canonicalProduct) || null,
            module_degrade: {
              applied: missing.length > 0,
              modules: missing.map((item) => ({
                type: item?.type || 'unknown',
                reason: item?.reason || 'unavailable',
              })),
            },
          },
	      };
	      logger.info(
	        {
	          gateway_request_id: gatewayRequestId,
	          operation: 'get_pdp_v2',
	          requested_product_id: entryProductId || null,
	          resolved_product_id: canonicalProductRef?.product_id || null,
	          requested_merchant_id: requestedMerchantId || null,
	          resolved_merchant_id: canonicalProductRef?.merchant_id || null,
	          include: includeList,
	          modules_returned: modules.map((module) => module.type),
	          missing_modules: missing.map((module) => module.type),
	          timing_ms: {
	            total: Date.now() - pdpV2StartedAt,
	            phases: pdpV2PhaseTimings,
	            modules: pdpV2ModuleTimings,
	          },
	        },
	        'get_pdp_v2 completed',
	      );
	      return res.json(responsePayload);
	    } catch (err) {
	      const { code, message, data } = extractUpstreamErrorCode(err);
	      const statusCode = err?.response?.status || err?.status || 502;
	      logger.error(
	        {
	          gateway_request_id: gatewayRequestId,
	          operation: 'get_pdp_v2',
	          status_code: statusCode,
	          err: err?.message || String(err),
	          timing_ms: {
	            total: Date.now() - pdpV2StartedAt,
	            phases: pdpV2PhaseTimings,
	            modules: pdpV2ModuleTimings,
	          },
	        },
	        'get_pdp_v2 failed',
	      );
	      return res.status(statusCode).json({
	        error: code || 'GET_PDP_V2_FAILED',
        message: message || 'Failed to build pdp payload',
        details: data || null,
      });
    }
  }

  if (operation === 'get_pdp') {
    try {
      const productId = payload.product?.product_id || payload.product_id;
      const merchantId =
        payload.product?.merchant_id ||
        payload.merchant_id ||
        payload.search?.merchant_id ||
        DEFAULT_MERCHANT_ID;

      if (!productId || !merchantId) {
        return res.status(400).json({
          error: 'MISSING_PARAMETERS',
          message: 'merchant_id and product_id are required for get_pdp',
        });
      }

      const pdpOptions = getPdpOptions(payload);
      const product = await fetchProductDetailFromUpstream({
        merchantId,
        productId,
        skuId: payload.product?.sku_id,
        checkoutToken,
      });

      if (!product) {
        return res.status(404).json({
          error: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
        });
      }

      let relatedProducts = [];
      if (pdpOptions.includeRecommendations) {
        const bypassCache =
          payload?.options?.no_cache === true ||
          payload?.options?.cache_bypass === true ||
          payload?.options?.bypass_cache === true;
        try {
          const rec = await recommendPdpProducts({
            pdp_product: product,
            k: payload.recommendations?.limit || 6,
            locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
            currency: product.currency || 'USD',
            options: {
              debug: pdpOptions.debug,
              no_cache: bypassCache,
              cache_bypass: bypassCache,
              bypass_cache: bypassCache,
            },
          });
          relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
        } catch (err) {
          logger.warn(
            { err: err?.message || String(err), merchantId, productId },
            'PDP recommendations failed; returning without recommendations module',
          );
          relatedProducts = [];
        }
      }

      const pdpPayload = buildPdpPayload({
        product,
        relatedProducts,
        entryPoint: pdpOptions.entryPoint,
        experiment: pdpOptions.experiment,
        templateHint: pdpOptions.templateHint,
        includeEmptyReviews: pdpOptions.includeEmptyReviews,
        debug: pdpOptions.debug,
      });

      return res.json({
        status: 'success',
        product,
        pdp_payload: pdpPayload,
      });
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 502;
      logger.error({ err: err?.message || String(err) }, 'get_pdp failed');
      return res.status(statusCode).json({
        error: code || 'GET_PDP_FAILED',
        message: message || 'Failed to build pdp payload',
        details: data || null,
      });
    }
  }

  if (operation === 'resolve_product_group') {
    try {
      const productRef = payload.product_ref || payload.productRef || payload.product || {};
      const productId = String(
        productRef.product_id || productRef.productId || payload.product_id || payload.productId || '',
      ).trim();
      const merchantId = String(
        productRef.merchant_id || productRef.merchantId || payload.merchant_id || payload.merchantId || '',
      ).trim();
      const platform = String(productRef.platform || payload.platform || '').trim() || null;
      const options = payload.options || {};
      const debug = options.debug === true || String(options.debug || '').trim().toLowerCase() === 'true';
      const bypassCache =
        options.no_cache === true ||
        options.cache_bypass === true ||
        options.bypass_cache === true ||
        String(options.no_cache || '').trim().toLowerCase() === 'true' ||
        String(options.cache_bypass || options.bypass_cache || '')
          .trim()
          .toLowerCase() === 'true';

      if (!productId) {
        return res.status(400).json({
          error: 'MISSING_PARAMETERS',
          message: 'product_ref.product_id is required',
        });
      }

      const cacheKey = JSON.stringify({
        productId,
        merchantId: merchantId || null,
        platform,
        hasCheckoutToken: Boolean(checkoutToken),
      });
      const cacheEnabled = RESOLVE_PRODUCT_GROUP_CACHE_ENABLED && !bypassCache;
      if (!cacheEnabled) RESOLVE_PRODUCT_GROUP_CACHE_METRICS.bypasses += 1;
      const cachedEntry = cacheEnabled ? getResolveProductGroupCacheEntry(cacheKey) : null;
      if (cachedEntry?.value) {
        const ageMs =
          typeof cachedEntry.storedAtMs === 'number'
            ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
            : 0;
        const response = debug
          ? {
              ...cachedEntry.value,
              cache: {
                hit: true,
                age_ms: ageMs,
                ttl_ms: RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
              },
            }
          : cachedEntry.value;
        return res.json(response);
      }

      const resolvedGroup = merchantId
        ? await resolveProductGroupFromUpstream({
            merchantId,
            productId,
            platform,
            checkoutToken,
          })
        : await resolveProductGroupByProductIdFromUpstream({
            productId,
            platform,
            checkoutToken,
          });

      const productGroupIdRaw =
        resolvedGroup?.product_group_id || resolvedGroup?.productGroupId || null;
      const productGroupId =
        typeof productGroupIdRaw === 'string' && productGroupIdRaw.trim()
          ? productGroupIdRaw.trim()
          : null;
      const membersRaw = Array.isArray(resolvedGroup?.members) ? resolvedGroup.members : [];
      const members = membersRaw
        .map((m) => ({
          merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
          merchant_name: m?.merchant_name || m?.merchantName || undefined,
          product_id: String(m?.product_id || m?.productId || '').trim(),
          platform: m?.platform ? String(m.platform).trim() : undefined,
          is_primary: Boolean(m?.is_primary || m?.isPrimary),
        }))
        .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));

      const canonicalMember =
        members.find((m) => m.is_primary) || members[0] || null;

      const result = {
        status: 'success',
        ...(productGroupId ? { product_group_id: productGroupId } : {}),
        canonical_product_ref: canonicalMember
          ? {
              merchant_id: canonicalMember.merchant_id,
              product_id: canonicalMember.product_id,
              ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
            }
          : null,
        members,
      };

      if (cacheEnabled) setResolveProductGroupCache(cacheKey, result);
      const response = debug
        ? {
            ...result,
            cache: { hit: false, age_ms: 0, ttl_ms: RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS },
          }
        : result;

      return res.json(response);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 502;
      logger.error({ err: err?.message || String(err) }, 'resolve_product_group failed');
      return res.status(statusCode).json({
        error: code || 'RESOLVE_PRODUCT_GROUP_FAILED',
        message: message || 'Failed to resolve product group',
        details: data || null,
      });
    }
  }

		  if (operation === 'resolve_product_candidates') {
		    try {
	      const productRef = payload.product_ref || payload.productRef || payload.product || {};
	      const context = payload.context || {};
	      const options = payload.options || {};

      const productId = String(
        productRef.product_id || productRef.productId || payload.product_id || payload.productId || '',
      ).trim();
      const requestedMerchantId = String(
        productRef.merchant_id || productRef.merchantId || payload.merchant_id || payload.merchantId || '',
      ).trim();

	      const country = String(context.country || context.country_code || '').trim().toUpperCase() || null;
	      const postalCode = String(context.postal_code || context.postalCode || '').trim() || null;
	      const limit = Math.min(Math.max(1, Number(options.limit || payload.limit || 10) || 10), 50);
	      const includeOffers = options.include_offers !== false;
	      const debug = options.debug === true || String(options.debug || '').trim().toLowerCase() === 'true';
	      const bypassCache =
	        options.no_cache === true ||
	        options.cache_bypass === true ||
	        options.bypass_cache === true ||
	        String(options.no_cache || '').trim().toLowerCase() === 'true' ||
	        String(options.cache_bypass || options.bypass_cache || '')
	          .trim()
	          .toLowerCase() === 'true';

	      if (!productId) {
	        return res.status(400).json({
	          error: 'MISSING_PARAMETERS',
	          message: 'product_ref.product_id is required',
        });
      }

      const cacheKey = JSON.stringify({
        productId,
        merchantId: requestedMerchantId || null,
        country,
        postalCode,
        limit,
	        includeOffers,
	        hasCheckoutToken: Boolean(checkoutToken),
	      });
	      const cacheEnabled = RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED && !bypassCache;
	      if (!cacheEnabled) RESOLVE_PRODUCT_CANDIDATES_CACHE_METRICS.bypasses += 1;
	      const cachedEntry = cacheEnabled ? getResolveProductCandidatesCacheEntry(cacheKey) : null;
	      if (cachedEntry?.value) {
	        const ageMs =
	          typeof cachedEntry.storedAtMs === 'number' ? Math.max(0, Date.now() - cachedEntry.storedAtMs) : 0;
	        const response = debug
	          ? { ...cachedEntry.value, cache: { hit: true, age_ms: ageMs, ttl_ms: RESOLVE_PRODUCT_CANDIDATES_TTL_MS } }
	          : cachedEntry.value;
	        if (debug && process.env.NODE_ENV !== 'production') {
	          logger.info(
	            { operation, product_id: productId, cache_hit: true, cache_age_ms: ageMs, offers_count: response.offers_count },
	            'resolve_product_candidates debug',
	          );
	        }
	        return res.json(response);
	      }

		      const toMoney = (amount, currency) => ({
		        amount: Number(amount) || 0,
		        currency: String(currency || 'USD').toUpperCase() || 'USD',
		      });

			      // When callers omit merchant_id (common for shareable PDP links), the upstream
			      // Agent Search endpoint may return no results for internal UUID product ids.
			      // Try resolving via backend product groups first to recover seller offers.
			      let productGroupId = null;
			      let groupMembers = [];
			      if (!requestedMerchantId) {
			        try {
			          const groupCacheKey = JSON.stringify({
			            productId,
			            merchantId: null,
			            platform: null,
			            hasCheckoutToken: Boolean(checkoutToken),
			          });
			          const groupCacheEnabled = RESOLVE_PRODUCT_GROUP_CACHE_ENABLED && !bypassCache;
			          if (!groupCacheEnabled) RESOLVE_PRODUCT_GROUP_CACHE_METRICS.bypasses += 1;
			          const cachedGroup = groupCacheEnabled
			            ? getResolveProductGroupCacheEntry(groupCacheKey)
			            : null;
			          const resolvedByPid = cachedGroup?.value
			            ? cachedGroup.value
			            : await resolveProductGroupByProductIdFromUpstream({
			                productId,
			                checkoutToken,
			              });

			          const pgid =
			            resolvedByPid?.product_group_id || resolvedByPid?.productGroupId || null;
			          if (typeof pgid === 'string' && pgid.trim()) productGroupId = pgid.trim();
			          const members = Array.isArray(resolvedByPid?.members)
			            ? resolvedByPid.members
			            : [];
			          const normalizedMembers = members
			            .map((m) => ({
			              merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
			              merchant_name: m?.merchant_name || m?.merchantName || undefined,
			              product_id: String(m?.product_id || m?.productId || '').trim(),
			              platform: m?.platform ? String(m.platform).trim() : undefined,
			              is_primary: Boolean(m?.is_primary || m?.isPrimary),
			            }))
			            .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));

			          groupMembers = normalizedMembers.slice(0, limit);

			          if (!cachedGroup?.value && groupCacheEnabled) {
			            const canonicalMember =
			              normalizedMembers.find((m) => m.is_primary) ||
			              normalizedMembers[0] ||
			              null;
			            setResolveProductGroupCache(groupCacheKey, {
			              status: 'success',
			              ...(productGroupId ? { product_group_id: productGroupId } : {}),
			              canonical_product_ref: canonicalMember
			                ? {
			                    merchant_id: canonicalMember.merchant_id,
			                    product_id: canonicalMember.product_id,
			                    ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
			                  }
			                : null,
			              members: normalizedMembers,
			            });
			          }
			        } catch {
			          productGroupId = null;
			          groupMembers = [];
			        }
			      }

		      // Fetch candidates via Agent Search (GET). This is intentionally lightweight:
		      // - no product detail fetches
		      // - no long descriptions/media
	      // - small limit
		      let deduped = [];
		      let anchor = null;
		      const shouldSkipSearch = !requestedMerchantId && groupMembers.length > 0;
		      if (!shouldSkipSearch) {
      const searchUrl = `${PIVOTA_API_BASE}/agent/v1/products/search`;
      const configuredMerchantTarget = await resolveCatalogSyncMerchantIds();
      const configuredMerchantIds = configuredMerchantTarget.merchantIds;

      const queryParams = {
        ...(requestedMerchantId ? { merchant_id: requestedMerchantId } : {}),
        ...(!requestedMerchantId && configuredMerchantIds.length > 0
          ? { merchant_ids: configuredMerchantIds }
          : {}),
        ...(!requestedMerchantId && configuredMerchantIds.length === 0 ? { search_all_merchants: true } : {}),
        query: productId,
        in_stock_only: false,
        limit,
        offset: 0,
      };

      const queryString = buildQueryString(queryParams);
      const axiosConfig = {
        method: 'GET',
        url: `${searchUrl}${queryString}`,
        headers: {
          ...(checkoutToken
            ? { 'X-Checkout-Token': checkoutToken }
            : {
                ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
                ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
              }),
        },
        timeout: getUpstreamTimeoutMs('find_products_multi'),
      };

		      const resp = await callUpstreamWithOptionalRetry('find_products_multi', axiosConfig);
		      const normalizedList = normalizeAgentProductsListResponse(resp.data, {
		        limit: queryParams.limit,
		        offset: queryParams.offset,
		      });

		      const products = Array.isArray(normalizedList?.products) ? normalizedList.products : [];
		      const matches = products.filter((p) => String(p?.product_id || '').trim() === productId);
		      deduped = Array.from(
		        new Map(
		          matches
		            .map((p) => [String(p?.merchant_id || '').trim(), p])
		            .filter(([mid]) => Boolean(mid)),
		        ).values(),
		      ).slice(0, limit);

		      anchor =
		        (requestedMerchantId
		          ? deduped.find((p) => String(p?.merchant_id || '').trim() === requestedMerchantId) ||
		            (deduped.length === 0 ? { merchant_id: requestedMerchantId } : null)
		          : null) ||
		        deduped[0] ||
		        null;
		      }

	      // Ensure we have a real anchor product for:
	      // - reliable offers (at least 1 offer should exist when merchant_id is provided)
	      // - passing platform to group resolution (some backends require it)
	      //
	      // NOTE: Agent Search doesn't always return results for internal UUID product ids.
		      if (
		        requestedMerchantId &&
		        (!anchor ||
		          String(anchor?.merchant_id || '').trim() !== requestedMerchantId ||
		          !anchor?.platform)
		      ) {
		        try {
		          const anchorDetail = await fetchProductDetailForOffers({
		            merchantId: requestedMerchantId,
		            productId,
		            checkoutToken,
		          });
		          if (anchorDetail) {
		            anchor = {
		              ...anchorDetail,
		              merchant_id: requestedMerchantId,
		              product_id: productId,
		            };
	            const hasRequestedMerchant = deduped.some(
	              (p) => String(p?.merchant_id || '').trim() === requestedMerchantId,
	            );
	            if (!hasRequestedMerchant) {
	              deduped = [anchor, ...deduped].slice(0, limit);
	            }
	          }
	        } catch {
	          // Best-effort: do not block PDP on anchor enrichment failures.
	        }
		      }

			      // Prefer backend-curated product groups (multi-seller).
			      if (!productGroupId && groupMembers.length === 0) {
			        try {
			          const anchorMerchantId = String(anchor?.merchant_id || '').trim();
			          if (anchorMerchantId) {
			            const platform = anchor?.platform ? String(anchor.platform).trim() : null;
			            const groupCacheKey = JSON.stringify({
			              productId,
			              merchantId: anchorMerchantId,
			              platform,
			              hasCheckoutToken: Boolean(checkoutToken),
			            });
			            const groupCacheEnabled = RESOLVE_PRODUCT_GROUP_CACHE_ENABLED && !bypassCache;
			            if (!groupCacheEnabled) RESOLVE_PRODUCT_GROUP_CACHE_METRICS.bypasses += 1;
			            const cachedGroup = groupCacheEnabled
			              ? getResolveProductGroupCacheEntry(groupCacheKey)
			              : null;
			            const resolvedGroup = cachedGroup?.value
			              ? cachedGroup.value
			              : await resolveProductGroupFromUpstream({
			                  merchantId: anchorMerchantId,
			                  productId,
			                  platform,
			                  checkoutToken,
			                });
			            const pgid =
			              resolvedGroup?.product_group_id || resolvedGroup?.productGroupId || null;
			            if (typeof pgid === 'string' && pgid.trim()) productGroupId = pgid.trim();
			            const members = Array.isArray(resolvedGroup?.members) ? resolvedGroup.members : [];
			            const normalizedMembers = members
			              .map((m) => ({
			                merchant_id: String(m?.merchant_id || m?.merchantId || '').trim(),
			                merchant_name: m?.merchant_name || m?.merchantName || undefined,
			                product_id: String(m?.product_id || m?.productId || '').trim(),
			                platform: m?.platform ? String(m.platform).trim() : undefined,
			                is_primary: Boolean(m?.is_primary || m?.isPrimary),
			              }))
			              .filter((m) => Boolean(m.merchant_id) && Boolean(m.product_id));

			            groupMembers = normalizedMembers.slice(0, limit);

			            if (!cachedGroup?.value && groupCacheEnabled) {
			              const canonicalMember =
			                normalizedMembers.find((m) => m.is_primary) ||
			                normalizedMembers[0] ||
			                null;
			              setResolveProductGroupCache(groupCacheKey, {
			                status: 'success',
			                ...(productGroupId ? { product_group_id: productGroupId } : {}),
			                canonical_product_ref: canonicalMember
			                  ? {
			                      merchant_id: canonicalMember.merchant_id,
			                      product_id: canonicalMember.product_id,
			                      ...(canonicalMember.platform
			                        ? { platform: canonicalMember.platform }
			                        : {}),
			                    }
			                  : null,
			                members: normalizedMembers,
			              });
			            }
			          }
			        } catch (e) {
			          // Best-effort: group resolution should not block PDP.
			          groupMembers = [];
			          productGroupId = null;
		        }
		      }

	      // Fallback grouping id: prefer platform refs if present; fallback to product_id.
	      if (!productGroupId) {
	        const platform = anchor ? String(anchor.platform || '').trim() : '';
	        const platformProductId = anchor ? String(anchor.platform_product_id || '').trim() : '';
	        productGroupId =
	          (platform && platformProductId
	            ? buildProductGroupId({ platform, platform_product_id: platformProductId })
	            : buildProductGroupId({ merchant_id: 'pid', product_id: productId })) || `pg:pid:${productId}`;
	      }

		      let offerProducts = deduped;
		      if (groupMembers.length > 0) {
		        const fetched = [];
		        const chunkSize = 4;
		        for (let i = 0; i < groupMembers.length; i += chunkSize) {
		          const chunk = groupMembers.slice(i, i + chunkSize);
		          // eslint-disable-next-line no-await-in-loop
		          const results = await Promise.all(
		            chunk.map(async (m) =>
		              fetchProductDetailForOffers({
		                merchantId: m.merchant_id,
		                productId: m.product_id,
		                checkoutToken,
		              }).catch(() => null),
		            ),
		          );
		          fetched.push(...results);
		        }
		        const filtered = fetched.filter(Boolean);
		        if (filtered.length > 0) offerProducts = filtered;
		      }

	      const merchantNameById = new Map(
	        groupMembers
	          .map((m) => [String(m.merchant_id || '').trim(), m.merchant_name])
	          .filter(([mid]) => Boolean(mid)),
	      );

		      const offers = offerProducts.map((p) => {
		        const mid = String(p.merchant_id || '').trim();
		        const offerProductId = String(p.product_id || '').trim() || undefined;
		        const currency = p.currency || 'USD';
		        const shipCost = p.shipping?.cost || p.shipping_cost || null;
		        const shipCostAmount =
		          shipCost == null ? undefined : Number(typeof shipCost === 'object' ? shipCost.amount : shipCost);
        const shipCostCurrency =
          shipCost && typeof shipCost === 'object'
            ? String(shipCost.currency || currency)
            : currency;
        const etaRaw = p.shipping?.eta_days_range || p.shipping?.etaDaysRange || null;
	        const etaRange =
	          Array.isArray(etaRaw) && etaRaw.length >= 2
	            ? [Number(etaRaw[0]) || 0, Number(etaRaw[1]) || 0]
	            : undefined;

		        return {
		          offer_id:
		            buildOfferId({
		              merchant_id: mid,
		              product_group_id: productGroupId,
		              fulfillment_type: p.fulfillment_type || 'merchant',
		              tier: 'default',
		            }) || `of:v1:${mid}:${productGroupId}:${p.fulfillment_type || 'merchant'}:default`,
		          product_group_id: productGroupId,
		          product_id: offerProductId,
		          merchant_id: mid,
		          merchant_name:
		            p.merchant_name ||
		            p.store_name ||
	            merchantNameById.get(mid) ||
	            undefined,
	          price: toMoney(p.price, currency),
          shipping:
            p.shipping || etaRange || shipCostAmount != null
              ? {
                  method_label: p.shipping?.method_label || p.shipping?.methodLabel || undefined,
                  eta_days_range: etaRange,
                  ...(shipCostAmount != null && Number.isFinite(shipCostAmount)
                    ? { cost: toMoney(shipCostAmount, shipCostCurrency) }
                    : {}),
                }
              : undefined,
          returns: p.returns || undefined,
          inventory: {
            in_stock: typeof p.in_stock === 'boolean' ? p.in_stock : undefined,
          },
          fulfillment_type: p.fulfillment_type || undefined,
          risk_tier: 'standard',
        };
      });

	      const totalCost = (offer) =>
	        Number(offer?.price?.amount || 0) + Number(offer?.shipping?.cost?.amount || 0);
	      const sortedByTotal = [...offers].sort((a, b) => totalCost(a) - totalCost(b));
	      const bestPriceOfferId = sortedByTotal[0]?.offer_id || null;
		      const anchorByProductIdMerchantId =
		        !requestedMerchantId && groupMembers.length > 0
		          ? String(
		              groupMembers.find((m) => String(m.product_id || '').trim() === productId)
		                ?.merchant_id || '',
		            ).trim() || null
		          : null;
		      const preferredMerchantId =
		        (requestedMerchantId ? String(requestedMerchantId).trim() : null) ||
		        anchorByProductIdMerchantId ||
		        (anchor ? String(anchor.merchant_id || '').trim() : null) ||
		        null;
		      const preferredOfferId = preferredMerchantId
		        ? offers.find((o) => o.merchant_id === preferredMerchantId)?.offer_id || null
		        : null;
		      const defaultOfferId = preferredOfferId || bestPriceOfferId;
		      const canonicalMember =
		        groupMembers.find((m) => m.is_primary) || groupMembers[0] || null;
		      const canonicalProductRef = canonicalMember
		        ? {
		            merchant_id: canonicalMember.merchant_id,
		            product_id: canonicalMember.product_id,
		            ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
		          }
		        : null;

		      const result = {
		        status: 'success',
		        product_group_id: productGroupId,
		        canonical_product_ref: canonicalProductRef,
		        offers_count: offers.length,
		        ...(includeOffers ? { offers } : {}),
		        default_offer_id: defaultOfferId,
		        best_price_offer_id: bestPriceOfferId,
		      };

	      if (cacheEnabled) setResolveProductCandidatesCache(cacheKey, result);
	      const response = debug
	        ? { ...result, cache: { hit: false, age_ms: 0, ttl_ms: RESOLVE_PRODUCT_CANDIDATES_TTL_MS } }
	        : result;
	      if (debug && process.env.NODE_ENV !== 'production') {
	        logger.info(
	          { operation, product_id: productId, cache_hit: false, offers_count: offers.length },
	          'resolve_product_candidates debug',
	        );
	      }
	      return res.json(response);
	    } catch (err) {
	      const { code, message, data } = extractUpstreamErrorCode(err);
	      const statusCode = err?.response?.status || err?.status || 502;
      logger.error({ err: err?.message || String(err) }, 'resolve_product_candidates failed');
      return res.status(statusCode).json({
        error: code || 'RESOLVE_PRODUCT_CANDIDATES_FAILED',
        message: message || 'Failed to resolve product candidates',
        details: data || null,
      });
    }
  }

  if (operation === 'offers.resolve') {
    try {
      const handled = await handleOffersResolveOperation({
        payload,
        metadata,
        checkoutToken,
      });
      if (
        handled &&
        typeof handled === 'object' &&
        handled.response &&
        typeof handled.response === 'object'
      ) {
        return res.status(Number(handled.statusCode || 200) || 200).json(handled.response);
      }
      return res.status(500).json({
        error: 'OFFERS_RESOLVE_HANDLER_FAILED',
        message: 'offers.resolve returned an invalid response envelope',
      });
    } catch (err) {
      const failReason = inferOffersResolveFailureReasonCode({ error: err });
      logger.warn(
        { err: err?.message || String(err), fail_reason: failReason },
        'offers.resolve failed; returning explicit external fallback',
      );
      const pdpTarget = buildOffersResolvePdpTargetExternal('', failReason);
      return res.status(200).json(
        buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
          },
          reasonCode: failReason,
          pdpTargetV1: pdpTarget,
          sourceTrace: [
            {
              source: 'offers_resolve_handler',
              ok: false,
              attempts: 1,
              latency_ms: 0,
              reason: failReason,
            },
          ],
          queryText: '',
          startedAtMs: Date.now(),
          failReasonCode: failReason,
        }),
      );
    }
  }

  // Use real API routing
  const route = ROUTE_MAP[operation];
  if (!route) {
    return res.status(400).json({
      error: 'UNSUPPORTED_OPERATION',
      operation,
    });
  }

  try {
    let creatorCacheRouteDebug = null;
    let crossMerchantCacheRouteDebug = null;
    let crossMerchantCacheProtectedResponse = null;
    let resolvedOfferId = null;
    let resolvedMerchantId = null;
    let productDetailMerchantId = null;
    let productDetailProductId = null;
    let productDetailCacheKey = null;
    let productDetailDebug = false;
    let productDetailBypassCache = false;
    let productDetailCacheMeta = null;
    // Creator UI cold-start (empty query) should not be constrained by the
    // upstream live merchant recall limits. Prefer reading sellable products
    // from products_cache (same source as creator categories / merchant portal).
	    if (operation === 'find_products_multi') {
	      const source = metadata?.source;
	      const search = effectivePayload.search || effectivePayload || {};
	      const queryText = String(search.query || '').trim();
	      const isCreatorUiColdStart = isCreatorUiSource(source) && queryText.length === 0;
      const inStockOnly = search.in_stock_only !== false;

      const isCreatorUi = isCreatorUiSource(source);
      if (isCreatorUiColdStart && process.env.DATABASE_URL) {
        try {
          const page = search.page || 1;
          const limit = search.limit || 20;
          const fromCache = await loadCreatorSellableFromCache(creatorId, page, limit, { inStockOnly });
          const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;
          creatorCacheRouteDebug = {
            attempted: true,
            mode: 'featured',
            creator_id: creatorId,
            page,
            limit,
            in_stock_only: inStockOnly,
            products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
            total: Number(fromCache.total || 0),
            cache_hit: cacheHit,
          };

          const upstreamData = {
            products: fromCache.products,
            total: fromCache.total,
            page: fromCache.page,
            page_size: fromCache.page_size,
            reply: null,
            metadata: {
              query_source: 'cache_creator_featured',
              fetched_at: new Date().toISOString(),
              merchants_searched: fromCache.merchantIds.length,
              ...(ROUTE_DEBUG_ENABLED
                ? {
                    route_debug: {
                      creator_cache: {
                        attempted: true,
                        mode: 'featured',
                        creator_id: creatorId,
                        page,
                        limit,
                        in_stock_only: inStockOnly,
                        cache_hit: cacheHit,
                      },
                    },
                  }
                : {}),
              ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
              ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
            },
          };

          // Creator Featured cold-start: do NOT apply aggressive intent-based
          // filtering. We want a broad, sellable Featured pool here, even when
          // there is no concrete query yet.
          const withPolicy = upstreamData;

          const promotions = await getActivePromotions(now, creatorId);
          const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
          if (cacheHit) {
            return res.json(enriched);
          }
          logger.info(
            { creatorId, source, page, limit, inStockOnly },
            'Creator UI cache cold-start returned empty; falling back to upstream',
          );
        } catch (err) {
          logger.warn(
            { err: err.message, creatorId, source },
            'Creator UI cache cold-start failed; falling back to upstream'
          );
        }
      }

      // For creator UI queries, also prefer searching sellable cache so query results
      // stay consistent with the featured pool and the merchant portal.
      if (isCreatorUi && queryText.length > 0 && process.env.DATABASE_URL) {
        try {
          const page = search.page || 1;
          const limit = search.limit || 20;
          const intentTarget = String(effectiveIntent?.target_object?.type || '').toLowerCase();
          const fromCache = await searchCreatorSellableFromCache(creatorId, queryText, page, limit, {
            intent: effectiveIntent,
            inStockOnly,
          });

          creatorCacheRouteDebug = {
            attempted: true,
            mode: 'search',
            creator_id: creatorId,
            query: queryText,
            page,
            limit,
            products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
            total: Number(fromCache.total || 0),
            retrieval_sources: fromCache.retrieval_sources || null,
            vector_enabled: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true',
            intent_language: effectiveIntent?.language || null,
            intent_target: effectiveIntent?.target_object?.type || null,
            db_stats: await probeCreatorCacheDbStats(
              Array.isArray(fromCache.merchantIds) ? fromCache.merchantIds : [],
              intentTarget,
            ),
          };

          if (fromCache.products && fromCache.products.length > 0) {
            const upstreamData = {
              products: fromCache.products,
              total: fromCache.total,
              page: fromCache.page,
              page_size: fromCache.page_size,
              reply: null,
              metadata: {
                query_source: 'cache_creator_search',
                fetched_at: new Date().toISOString(),
                merchants_searched: fromCache.merchantIds.length,
                ...(fromCache.retrieval_sources ? { retrieval_sources: fromCache.retrieval_sources } : {}),
                ...(ROUTE_DEBUG_ENABLED
                  ? { route_debug: { creator_cache: creatorCacheRouteDebug } }
                  : {}),
                ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
                ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
              },
            };

            const withPolicy = effectiveIntent
              ? applyFindProductsMultiPolicy({
                  response: upstreamData,
                  intent: effectiveIntent,
                  requestPayload: effectivePayload,
                  metadata: policyMetadata,
                  rawUserQuery,
                })
              : upstreamData;

            const promotions = await getActivePromotions(now, creatorId);
            const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
            return res.json(enriched);
          }
        } catch (err) {
          creatorCacheRouteDebug = {
            attempted: true,
            mode: 'search',
            creator_id: creatorId,
            query: queryText,
            error: String(err && err.message ? err.message : err),
            vector_enabled: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true',
            intent_language: effectiveIntent?.language || null,
            intent_target: effectiveIntent?.target_object?.type || null,
          };
          logger.warn(
            { err: err.message, creatorId, source, queryText },
            'Creator UI cache search failed; falling back to upstream'
          );
        }
      }

      const merchantId = String(search.merchant_id || search.merchantId || '').trim();
      const merchantIdsRaw = search.merchant_ids || search.merchantIds;
      const merchantIds =
        Array.isArray(merchantIdsRaw)
          ? merchantIdsRaw.map((v) => String(v || '').trim()).filter(Boolean)
          : typeof merchantIdsRaw === 'string'
            ? merchantIdsRaw
                .split(',')
                .map((v) => String(v || '').trim())
                .filter(Boolean)
            : [];
      const hasMerchantScope = Boolean(merchantId) || merchantIds.length > 0;

      // Shopping Agent cold-start should not be blocked on upstream cross-merchant scans.
      // When callers do not specify merchant scope and have no query text, serve a fast
      // browse feed directly from products_cache.
      const isCrossMerchantBrowseColdStart =
        !isCreatorUi && queryText.length === 0 && !hasMerchantScope;
      if (isCrossMerchantBrowseColdStart && process.env.DATABASE_URL) {
        try {
          const page = search.page || 1;
          const limit = search.limit || search.page_size || 20;
          const fromCache = await loadCrossMerchantBrowseFromCache(page, limit, { inStockOnly });
          const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;
          crossMerchantCacheRouteDebug = {
            attempted: true,
            mode: 'browse',
            page,
            limit,
            in_stock_only: inStockOnly,
            cache_hit: cacheHit,
            products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
            total: Number(fromCache.total || 0),
          };
          const merchantsReturned = uniqueStrings(
            (fromCache.products || []).map((p) => p?.merchant_id || p?.merchantId),
          );

          const upstreamData = {
            products: fromCache.products,
            total: fromCache.total,
            page: fromCache.page,
            page_size: fromCache.page_size,
            reply: null,
            metadata: {
              query_source: 'cache_cross_merchant_browse',
              fetched_at: new Date().toISOString(),
              merchants_searched: merchantsReturned.length,
              ...(ROUTE_DEBUG_ENABLED
                ? {
                    route_debug: {
                      cross_merchant_cache: crossMerchantCacheRouteDebug,
                    },
                  }
                : {}),
            },
          };

          const withPolicy = upstreamData;

          const promotions = await getActivePromotions(now, creatorId);
          const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
          if (cacheHit) {
            return res.json(enriched);
          }
          logger.info(
            { source, page, limit, inStockOnly },
            'Cross-merchant cache browse returned empty; falling back to upstream',
          );
        } catch (err) {
          crossMerchantCacheRouteDebug = {
            attempted: true,
            mode: 'browse',
            page: search.page || 1,
            limit: search.limit || search.page_size || 20,
            in_stock_only: inStockOnly,
            cache_hit: false,
            error: String(err && err.message ? err.message : err),
          };
          logger.warn(
            { err: err.message, source },
            'Cross-merchant cache browse failed; falling back to upstream',
          );
        }
	      }

      // Shopping Agent query search (no explicit merchant scope): prefer cache-first
      // lexical recall so we avoid upstream timeout cascades for common brand queries.
      const cacheQueryText = String(rawUserQuery || queryText || '').trim();
      const cacheSearchQueryText = String(
        findProductsExpansionMeta?.expanded_query || cacheQueryText,
      ).trim();
      const isCrossMerchantQuerySearch =
        !isCreatorUi && cacheSearchQueryText.length > 0 && !hasMerchantScope;
      if (isCrossMerchantQuerySearch && process.env.DATABASE_URL) {
        try {
          const cacheStageStartedAt = Date.now();
          const page = search.page || 1;
          const limit = search.limit || search.page_size || 20;
          const fromCache = await withStageBudget(
            searchCrossMerchantFromCache(cacheSearchQueryText, page, limit, {
              inStockOnly,
            }),
            FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS,
            'cache_stage',
          );
          const internalProducts = Array.isArray(fromCache.products) ? fromCache.products : [];
          const lookupAnchorTokens = extractSearchAnchorTokens(cacheQueryText);
          const isLookupQuery = isLookupStyleSearchQuery(cacheQueryText, lookupAnchorTokens);
          const normalizedLookupQuery = normalizeSearchTextForMatch(cacheQueryText);
          const lookupQueryTokens = Array.from(
            new Set(tokenizeSearchTextForMatch(normalizedLookupQuery)),
          );
          const lookupRelevantInternalProducts = isLookupQuery
            ? internalProducts.filter((product) =>
                isSupplementCandidateRelevant(product, cacheQueryText, {
                  normalizedQuery: normalizedLookupQuery,
                  anchorTokens: lookupAnchorTokens,
                  queryTokens: lookupQueryTokens,
                }),
              )
            : internalProducts;
          const internalProductsForRecall =
            isLookupQuery && lookupRelevantInternalProducts.length > 0
              ? lookupRelevantInternalProducts
              : internalProducts;
          const leashAnchoredQuery = hasPetLeashSearchSignal(cacheQueryText);
          const leashAnchoredInternalProducts = leashAnchoredQuery
            ? internalProductsForRecall.filter((product) =>
                hasStrictPetHarnessCatalogSignal(buildFallbackCandidateText(product)),
              )
            : internalProductsForRecall;
          const internalProductsAfterAnchor = leashAnchoredInternalProducts;
          const safeResultLimit = Math.max(1, Number(limit || 20));
          const needsPrimaryFillSupplement = internalProductsAfterAnchor.length < safeResultLimit;
          const needsBeautyDiversitySupplement =
            isCatalogGuardSource(source) &&
            Number(page) === 1 &&
            isBeautyGeneralDiversitySupplementCandidate(
              effectiveIntent,
              internalProductsAfterAnchor,
              safeResultLimit,
            );
          const cacheHit = internalProductsAfterAnchor.length > 0;
          let supplementedProducts = internalProductsAfterAnchor;
          let supplementMeta = {
            attempted: false,
            applied: false,
            added_count: 0,
            reason: 'not_needed',
          };
          if (
            isCatalogGuardSource(source) &&
            Number(page) === 1 &&
            (needsPrimaryFillSupplement || needsBeautyDiversitySupplement)
          ) {
            const neededCount = needsPrimaryFillSupplement
              ? Math.max(0, safeResultLimit - internalProductsAfterAnchor.length)
              : Math.max(1, Math.ceil(safeResultLimit / 2));
            if (neededCount > 0) {
              const confidenceOverall = Number(effectiveIntent?.confidence?.overall || 0) || 0;
              const ambiguityScorePre = Number(findProductsExpansionMeta?.ambiguity_score_pre || 0) || 0;
              const externalFillMinInternal = Math.min(3, safeResultLimit);
              const canApplyExternalFillGate =
                !SEARCH_EXTERNAL_FILL_GATED ||
                (internalProductsAfterAnchor.length >= externalFillMinInternal &&
                  (confidenceOverall >= 0.7 || isLookupQuery) &&
                  ambiguityScorePre <= 0.45);
              if (!canApplyExternalFillGate) {
                supplementMeta = {
                  attempted: false,
                  applied: false,
                  added_count: 0,
                  reason: 'external_fill_gate_blocked',
                  gate: {
                    enabled: SEARCH_EXTERNAL_FILL_GATED,
                    min_internal_required: externalFillMinInternal,
                    internal_count: internalProductsAfterAnchor.length,
                    overall_confidence: confidenceOverall,
                    ambiguity_score_pre: ambiguityScorePre,
                    lookup_query_bypass: Boolean(isLookupQuery),
                  },
                };
              } else {
                supplementMeta = {
                  attempted: true,
                  applied: false,
                  added_count: 0,
                  reason: 'supplement_pending',
                  diversity_targeted: needsBeautyDiversitySupplement,
                };
                try {
                  const supplement = await fetchExternalSeedSupplementFromBackend({
                    queryParams: {
                      query: cacheSearchQueryText,
                      ...(search.category ? { category: search.category } : {}),
                      ...(search.price_min != null || search.min_price != null
                        ? { min_price: search.price_min ?? search.min_price }
                        : {}),
                      ...(search.price_max != null || search.max_price != null
                        ? { max_price: search.price_max ?? search.max_price }
                        : {}),
                      in_stock_only: inStockOnly,
                    },
                    checkoutToken,
                    neededCount,
                  });
                  const seen = new Set(
                    internalProductsAfterAnchor
                      .map((product) => buildSearchProductKey(product))
                      .filter(Boolean),
                  );
                  const supplementCandidates = Array.isArray(supplement?.products) ? supplement.products : [];
                  const toAppend = [];
                  for (const product of supplementCandidates) {
                    if (!isExternalSeedProduct(product)) continue;
                    if (
                      !isSupplementCandidateRelevant(product, cacheQueryText, {
                        normalizedQuery: normalizedLookupQuery,
                        anchorTokens: lookupAnchorTokens,
                        queryTokens: lookupQueryTokens,
                      })
                    ) {
                      continue;
                    }
                    const key = buildSearchProductKey(product);
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    toAppend.push(product);
                    if (toAppend.length >= neededCount) break;
                  }
                  supplementedProducts =
                    needsBeautyDiversitySupplement && internalProductsAfterAnchor.length >= safeResultLimit
                      ? blendBeautyDiversitySupplement(
                          internalProductsAfterAnchor,
                          toAppend,
                          safeResultLimit,
                        )
                      : internalProductsAfterAnchor.concat(toAppend);
                  supplementMeta = {
                    ...(supplement?.metadata && typeof supplement.metadata === 'object' ? supplement.metadata : {}),
                    attempted: true,
                    applied: toAppend.length > 0,
                    added_count: toAppend.length,
                    reason: toAppend.length > 0
                      ? needsBeautyDiversitySupplement
                        ? 'supplemented_external_seed_diversity'
                        : 'supplemented_external_seed'
                      : needsBeautyDiversitySupplement
                        ? 'no_external_candidates_for_diversity'
                        : 'no_external_candidates',
                    diversity_targeted: needsBeautyDiversitySupplement,
                  };
                } catch (supplementErr) {
                  supplementMeta = {
                    attempted: true,
                    applied: false,
                    added_count: 0,
                    reason: 'supplement_error',
                    error: String(supplementErr && supplementErr.message ? supplementErr.message : supplementErr),
                    diversity_targeted: needsBeautyDiversitySupplement,
                  };
                  logger.warn(
                    { err: supplementErr?.message || String(supplementErr), query: cacheQueryText },
                    'Cross-merchant cache search supplement failed; returning internal cache results',
                  );
                }
              }
            }
          }
          const effectiveProducts = supplementedProducts;
          const cacheRelevant = cacheQueryText
            ? isProxySearchFallbackRelevant({ products: effectiveProducts }, cacheQueryText)
            : true;
          const relaxCacheRelevanceGate =
            hasPetSearchSignal(cacheQueryText) ||
            (hasBeautyMakeupSearchSignal(cacheQueryText) &&
              effectiveProducts.some((product) =>
                hasBeautyCatalogProductSignal(buildFallbackCandidateText(product)),
              ));
          const effectiveCacheHit =
            effectiveProducts.length > 0 &&
            (!isShoppingSource(source) || cacheRelevant || relaxCacheRelevanceGate);
          const externalCount = effectiveProducts.filter((p) => isExternalSeedProduct(p)).length;
          crossMerchantCacheRouteDebug = {
            attempted: true,
            mode: 'search',
            query: cacheQueryText,
            cache_query: cacheSearchQueryText,
            upstream_query: queryText,
            latency_ms: Math.max(0, Date.now() - cacheStageStartedAt),
            page,
            limit,
            in_stock_only: inStockOnly,
            cache_hit: effectiveCacheHit,
            products_count: effectiveProducts.length,
            internal_products_count: internalProducts.length,
            internal_products_relevant_count: internalProductsAfterAnchor.length,
            leash_anchor_applied: leashAnchoredQuery,
            external_products_count: externalCount,
            cache_relevant: cacheRelevant,
            cache_relevance_gate_relaxed: relaxCacheRelevanceGate,
            total: Number(fromCache.total || 0),
            retrieval_sources: fromCache.retrieval_sources || null,
            supplement: supplementMeta,
          };
          const merchantsReturned = uniqueStrings(
            effectiveProducts.map((p) => p?.merchant_id || p?.merchantId),
          );

          const upstreamData = {
            products: effectiveProducts,
            total: Math.max(Number(fromCache.total || 0), effectiveProducts.length),
            page: fromCache.page,
            page_size: effectiveProducts.length,
            reply: null,
            metadata: {
              query_source: supplementMeta.applied
                ? 'cache_cross_merchant_search_supplemented'
                : 'cache_cross_merchant_search',
              fetched_at: new Date().toISOString(),
              merchants_searched: merchantsReturned.length,
              source_breakdown: {
                internal_count: effectiveProducts.length - externalCount,
                external_seed_count: externalCount,
                stale_cache_used: false,
                strategy_applied: isCatalogGuardSource(source)
                  ? 'supplement_internal_first'
                  : 'cache_only',
              },
              ...(fromCache.retrieval_sources ? { retrieval_sources: fromCache.retrieval_sources } : {}),
              ...(ROUTE_DEBUG_ENABLED
                ? {
                    route_debug: {
                      cross_merchant_cache: crossMerchantCacheRouteDebug,
                    },
                  }
                : {}),
            },
          };

          const shouldSkipLookupPolicyForCacheHit =
            isLookupQuery &&
            String(upstreamData?.metadata?.query_source || '').startsWith(
              'cache_cross_merchant_search',
            );
          const withPolicy =
            effectiveIntent && !shouldSkipLookupPolicyForCacheHit
              ? applyFindProductsMultiPolicy({
                  response: upstreamData,
                  intent: effectiveIntent,
                  requestPayload: effectivePayload,
                  metadata: policyMetadata,
                  rawUserQuery,
                })
              : upstreamData;
          const withPolicyProducts = Array.isArray(withPolicy?.products)
            ? withPolicy.products
            : [];

          const promotions = await getActivePromotions(now, creatorId);
          const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
          if (internalProductsAfterAnchor.length > 0 && (cacheRelevant || relaxCacheRelevanceGate)) {
            crossMerchantCacheProtectedResponse =
              withPolicyProducts.length > 0
                ? enriched
                : applyDealsToResponse(upstreamData, promotions, now, creatorId);
          }
          if (effectiveCacheHit) {
            const cacheClarification =
              enriched &&
              typeof enriched === 'object' &&
              !Array.isArray(enriched) &&
              enriched.clarification &&
              typeof enriched.clarification === 'object' &&
              enriched.clarification.question
                ? enriched.clarification
                : null;
            const diagnosed = withSearchDiagnostics(enriched, {
              route_health: buildSearchRouteHealth({
                primaryPathUsed: 'cache_stage',
                primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
                fallbackTriggered: false,
                fallbackReason: null,
                ambiguityScorePre: traceAmbiguityScorePre,
                clarifyTriggered: Boolean(cacheClarification),
              }),
              search_trace: buildSearchTrace({
                traceId: gatewayRequestId,
                rawQuery: cacheQueryText,
                expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
                expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
                queryClass: traceQueryClass,
                rewriteGate: traceRewriteGate,
                associationPlan: traceAssociationPlan,
                intent: effectiveIntent,
                cacheStage: {
                  hit: true,
                  candidate_count: Number(effectiveProducts.length || 0),
                  relevant_count: Number(internalProductsAfterAnchor.length || 0),
                  retrieval_sources: fromCache.retrieval_sources || [],
                },
                upstreamStage: {
                  called: false,
                  timeout: false,
                  status: null,
                  latency_ms: 0,
                },
                resolverStage: {
                  called: false,
                  hit: false,
                  miss: false,
                  latency_ms: null,
                },
                finalDecision: cacheClarification ? 'clarify' : 'cache_returned',
              }),
            });
            return res.json(diagnosed);
          }
          const queryClassForEarlyDecision = String(
            traceQueryClass || effectiveIntent?.query_class || '',
          ).toLowerCase();
          const isStrongLookupForEarlyDecision =
            queryClassForEarlyDecision === 'lookup' || isKnownLookupAliasQuery(cacheQueryText);
          const hasEarlyDecisionClass = [
            'mission',
            'scenario',
            'gift',
            'exploratory',
            'non_shopping',
          ].includes(queryClassForEarlyDecision);
          const queryClassMissing = queryClassForEarlyDecision.length === 0;
          const hasAmbiguitySignal = Boolean(effectiveIntent?.ambiguity?.needs_clarification);
          const earlyDecisionCause =
            internalProductsAfterAnchor.length === 0
              ? 'cache_miss_ambiguity_sensitive'
              : 'cache_irrelevant_ambiguity_sensitive';
          const canUseEarlyAmbiguityDecision =
            effectiveIntent &&
            !isStrongLookupForEarlyDecision &&
            (hasEarlyDecisionClass || (queryClassMissing && hasAmbiguitySignal));
          if (canUseEarlyAmbiguityDecision) {
            const earlyDecisionResponse = {
              products: [],
              total: 0,
              page: fromCache.page,
              page_size: 0,
              reply: null,
              metadata: {
                query_source: 'cache_cross_merchant_search_early_decision',
                fetched_at: new Date().toISOString(),
                merchants_searched: merchantsReturned.length,
                source_breakdown: {
                  internal_count: 0,
                  external_seed_count: 0,
                  stale_cache_used: false,
                  strategy_applied: 'ambiguity_gate_before_upstream',
                },
                ...(ROUTE_DEBUG_ENABLED
                  ? {
                      route_debug: {
                        cross_merchant_cache: {
                          ...(crossMerchantCacheRouteDebug && typeof crossMerchantCacheRouteDebug === 'object'
                            ? crossMerchantCacheRouteDebug
                            : {}),
                          early_decision: {
                            applied: true,
                            reason: earlyDecisionCause,
                            query_class: queryClassForEarlyDecision,
                          },
                        },
                      },
                    }
                  : {}),
              },
            };
            const earlyWithPolicy = applyFindProductsMultiPolicy({
              response: earlyDecisionResponse,
              intent: effectiveIntent,
              requestPayload: effectivePayload,
              metadata: policyMetadata,
              rawUserQuery,
            });
            const earlyDecisionProducts = Array.isArray(earlyWithPolicy?.products)
              ? earlyWithPolicy.products
              : [];
            const earlyDecisionClarification =
              earlyWithPolicy &&
              typeof earlyWithPolicy === 'object' &&
              !Array.isArray(earlyWithPolicy) &&
              earlyWithPolicy.clarification &&
              typeof earlyWithPolicy.clarification === 'object' &&
              earlyWithPolicy.clarification.question
                ? earlyWithPolicy.clarification
                : null;
            const earlyDecisionStrictEmpty =
              Boolean(earlyWithPolicy?.metadata?.strict_empty) ||
              (earlyDecisionProducts.length === 0 && !earlyDecisionClarification);
            const earlyDecisionResponsePayload =
              earlyDecisionStrictEmpty &&
              earlyWithPolicy &&
              typeof earlyWithPolicy === 'object' &&
              !Array.isArray(earlyWithPolicy) &&
              !earlyWithPolicy?.metadata?.strict_empty
                ? {
                    ...earlyWithPolicy,
                    metadata: {
                      ...(earlyWithPolicy.metadata && typeof earlyWithPolicy.metadata === 'object'
                        ? earlyWithPolicy.metadata
                        : {}),
                      strict_empty: true,
                    },
                  }
                : earlyWithPolicy;
            if (earlyDecisionClarification || earlyDecisionStrictEmpty) {
              const earlyDiagnosed = withSearchDiagnostics(earlyDecisionResponsePayload, {
                route_health: buildSearchRouteHealth({
                  primaryPathUsed: 'cache_stage',
                  primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
                  fallbackTriggered: false,
                  fallbackReason: null,
                  ambiguityScorePre: traceAmbiguityScorePre,
                  clarifyTriggered: Boolean(earlyDecisionClarification),
                }),
                search_trace: buildSearchTrace({
                  traceId: gatewayRequestId,
                  rawQuery: cacheQueryText,
                  expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
                  expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
                  queryClass: traceQueryClass,
                  rewriteGate: traceRewriteGate,
                  associationPlan: traceAssociationPlan,
                  intent: effectiveIntent,
                  cacheStage: {
                    hit: false,
                    candidate_count: 0,
                    relevant_count: 0,
                    retrieval_sources: fromCache.retrieval_sources || [],
                  },
                  upstreamStage: {
                    called: false,
                    timeout: false,
                    status: null,
                    latency_ms: 0,
                  },
                  resolverStage: {
                    called: false,
                    hit: false,
                    miss: false,
                    latency_ms: null,
                  },
                  finalDecision: earlyDecisionClarification ? 'clarify' : 'strict_empty',
                }),
              });
              return res.json(earlyDiagnosed);
            }
          }
          if (
            PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED &&
            isLookupQuery &&
            cacheQueryText.length > 0
          ) {
            try {
              const resolverFallback = await queryResolveSearchFallback({
                queryParams: {
                  query: cacheQueryText,
                  ...(search.category ? { category: search.category } : {}),
                  ...(search.price_min != null || search.min_price != null
                    ? { min_price: search.price_min ?? search.min_price }
                    : {}),
                  ...(search.price_max != null || search.max_price != null
                    ? { max_price: search.price_max ?? search.max_price }
                    : {}),
                  in_stock_only: inStockOnly,
                  limit,
                  offset: 0,
                  search_all_merchants: true,
                  allow_external_seed: true,
                  allow_stale_cache: false,
                  external_seed_strategy: 'supplement_internal_first',
                  fast_mode: true,
                },
                checkoutToken,
                reason: 'resolver_after_cache_miss',
                timeoutMs: getProxySearchResolverTimeoutMs(source),
              });
              if (
                resolverFallback &&
                resolverFallback.status >= 200 &&
                resolverFallback.status < 300 &&
                resolverFallback.usableCount > 0
              ) {
                const resolverEnriched = applyDealsToResponse(
                  resolverFallback.data,
                  promotions,
                  now,
                  creatorId,
                );
                const resolverClarification =
                  resolverEnriched &&
                  typeof resolverEnriched === 'object' &&
                  !Array.isArray(resolverEnriched) &&
                  resolverEnriched.clarification &&
                  typeof resolverEnriched.clarification === 'object' &&
                  resolverEnriched.clarification.question
                    ? resolverEnriched.clarification
                    : null;
                const resolverDiagnosed = withSearchDiagnostics(resolverEnriched, {
                  route_health: buildSearchRouteHealth({
                    primaryPathUsed: 'resolver_stage',
                    primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
                    fallbackTriggered: true,
                    fallbackReason: 'resolver_after_cache_miss',
                    ambiguityScorePre: traceAmbiguityScorePre,
                    clarifyTriggered: Boolean(resolverClarification),
                  }),
                  search_trace: buildSearchTrace({
                    traceId: gatewayRequestId,
                    rawQuery: cacheQueryText,
                    expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
                    expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
                    queryClass: traceQueryClass,
                    rewriteGate: traceRewriteGate,
                    associationPlan: traceAssociationPlan,
                    intent: effectiveIntent,
                    cacheStage: {
                      hit: false,
                      candidate_count: Number(effectiveProducts.length || 0),
                      relevant_count: Number(internalProductsAfterAnchor.length || 0),
                      retrieval_sources: fromCache.retrieval_sources || [],
                    },
                    upstreamStage: {
                      called: false,
                      timeout: false,
                      status: null,
                      latency_ms: 0,
                    },
                    resolverStage: {
                      called: true,
                      hit: true,
                      miss: false,
                      latency_ms: null,
                    },
                    finalDecision: resolverClarification ? 'clarify' : 'resolver_returned',
                  }),
                });
                return res.json(resolverDiagnosed);
              }
            } catch (resolverFallbackErr) {
              logger.warn(
                {
                  err: resolverFallbackErr?.message || String(resolverFallbackErr),
                  query: cacheQueryText,
                },
                'Cross-merchant cache search resolver fallback failed after cache miss',
              );
            }
          }
          if (
            isCatalogGuardSource(source) &&
            cacheQueryText.length > 0 &&
            !effectiveCacheHit &&
            !isLookupQuery
          ) {
            const cacheStrictReason =
              effectiveProducts.length > 0
                ? 'cache_irrelevant_strict_empty'
                : 'cache_miss_strict_empty';
            const strictEmptyBase = {
              status: 'success',
              success: true,
              products: [],
              total: 0,
              page: fromCache.page,
              page_size: 0,
              reply: null,
              metadata: {
                query_source: 'cache_cross_merchant_search',
                fetched_at: new Date().toISOString(),
                merchants_searched: merchantsReturned.length,
                source_breakdown: {
                  internal_count: 0,
                  external_seed_count: 0,
                  stale_cache_used: false,
                  strategy_applied: isCatalogGuardSource(source)
                    ? 'supplement_internal_first'
                    : 'cache_only',
                },
                proxy_search_fallback: {
                  applied: false,
                  reason: cacheStrictReason,
                },
                ...(fromCache.retrieval_sources ? { retrieval_sources: fromCache.retrieval_sources } : {}),
                ...(ROUTE_DEBUG_ENABLED
                  ? {
                      route_debug: {
                        cross_merchant_cache: crossMerchantCacheRouteDebug,
                      },
                    }
                  : {}),
              },
            };
            const strictEmptyWithPolicy = effectiveIntent
              ? applyFindProductsMultiPolicy({
                  response: strictEmptyBase,
                  intent: effectiveIntent,
                  requestPayload: effectivePayload,
                  metadata: policyMetadata,
                  rawUserQuery: cacheQueryText,
                })
              : strictEmptyBase;
            const strictEmptyEnriched = applyDealsToResponse(
              strictEmptyWithPolicy,
              promotions,
              now,
              creatorId,
            );
            const strictEmptyClarification =
              strictEmptyEnriched &&
              typeof strictEmptyEnriched === 'object' &&
              !Array.isArray(strictEmptyEnriched) &&
              strictEmptyEnriched.clarification &&
              typeof strictEmptyEnriched.clarification === 'object' &&
              strictEmptyEnriched.clarification.question
                ? strictEmptyEnriched.clarification
                : null;
            const strictEmptyDiagnosed = withSearchDiagnostics(strictEmptyEnriched, {
              route_health: buildSearchRouteHealth({
                primaryPathUsed: 'cache_stage',
                primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
                fallbackTriggered: false,
                fallbackReason: cacheStrictReason,
                ambiguityScorePre: traceAmbiguityScorePre,
                ambiguityScorePost: 1,
                clarifyTriggered: Boolean(strictEmptyClarification),
              }),
              search_trace: buildSearchTrace({
                traceId: gatewayRequestId,
                rawQuery: cacheQueryText,
                expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
                expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
                queryClass: traceQueryClass,
                rewriteGate: traceRewriteGate,
                associationPlan: traceAssociationPlan,
                intent: effectiveIntent,
                cacheStage: {
                  hit: false,
                  candidate_count: Number(effectiveProducts.length || 0),
                  relevant_count: Number(internalProductsAfterAnchor.length || 0),
                  retrieval_sources: fromCache.retrieval_sources || [],
                },
                upstreamStage: {
                  called: false,
                  timeout: false,
                  status: null,
                  latency_ms: 0,
                },
                resolverStage: {
                  called: false,
                  hit: false,
                  miss: false,
                  latency_ms: null,
                },
                finalDecision: strictEmptyClarification ? 'clarify' : 'strict_empty',
              }),
              ...(strictEmptyClarification
                ? {}
                : {
                    strict_empty: true,
                    strict_empty_reason: cacheStrictReason,
                  }),
            });
            return res.json(strictEmptyDiagnosed);
          }
          logger.info(
            { source, page, limit, inStockOnly, query: cacheQueryText },
            'Cross-merchant cache search returned empty; falling back to upstream',
          );
        } catch (err) {
          crossMerchantCacheRouteDebug = {
            attempted: true,
            mode: 'search',
            query: cacheQueryText,
            cache_query: cacheSearchQueryText,
            upstream_query: queryText,
            page: search.page || 1,
            limit: search.limit || search.page_size || 20,
            in_stock_only: inStockOnly,
            cache_hit: false,
            timeout_budget_ms: FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS,
            stage_timeout: String(err?.code || '').toUpperCase() === 'STAGE_TIMEOUT',
            error: String(err && err.message ? err.message : err),
          };
          logger.warn(
            { err: err.message, source, query: cacheQueryText },
            'Cross-merchant cache search failed; falling back to upstream',
          );
        }
      }
	    }

	    if (operation === 'find_products' && process.env.DATABASE_URL) {
	      const source = metadata?.source;
	      const search = effectivePayload.search || effectivePayload || {};
	      const queryText = String(search.query || '').trim();
	      const merchantId = String(search.merchant_id || search.merchantId || '').trim();
	      const inStockOnly = search.in_stock_only !== false;
	      const isBrowse = queryText.length === 0;

	      if (isBrowse && merchantId) {
	        try {
	          const page = Math.max(1, Number(search.page || 1) || 1);
	          const limit = Math.min(Math.max(1, Number(search.page_size || search.limit || 20) || 20), 100);
	          const fromCache = await loadMerchantBrowseFromCache(merchantId, page, limit, { inStockOnly });
	          const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;

	          const upstreamData = {
	            products: fromCache.products,
	            total: fromCache.total,
	            page: fromCache.page,
	            page_size: fromCache.page_size,
	            reply: null,
	            metadata: {
	              query_source: 'cache_merchant_browse',
	              fetched_at: new Date().toISOString(),
	              ...(merchantId ? { merchant_id: merchantId } : {}),
	              ...(source ? { source } : {}),
	              ...(ROUTE_DEBUG_ENABLED
	                ? {
	                    route_debug: {
	                      merchant_cache: {
	                        attempted: true,
	                        mode: 'browse',
	                        merchant_id: merchantId,
	                        page,
	                        limit,
	                        in_stock_only: inStockOnly,
	                        cache_hit: cacheHit,
	                      },
	                    },
	                  }
	                : {}),
	            },
	          };

	          const promotions = await getActivePromotions(now, creatorId);
	          const enriched = applyDealsToResponse(upstreamData, promotions, now, creatorId);
	          if (cacheHit) {
	            return res.json(enriched);
	          }
	          logger.info(
	            { source, merchantId, page, limit, inStockOnly },
	            'Merchant cache browse returned empty; falling back to upstream',
	          );
	        } catch (err) {
	          logger.warn(
	            { err: err.message, source, merchantId },
	            'Merchant cache browse failed; falling back to upstream',
	          );
	        }
	      }
	    }
	
	    // Build URL with path parameters
	    let url = `${PIVOTA_API_BASE}${route.path}`;
	    let requestBody = {};
	    let queryParams = {};

    // Handle different parameter types
    switch (operation) {
      case 'find_products': {
        // Single-merchant product search (Agent Search endpoint).
        const search = effectivePayload.search || effectivePayload || {};
        const page = Math.max(1, Number(search.page || 1) || 1);
        const limit = Math.min(Math.max(1, Number(search.page_size || search.limit || 20) || 20), 100);
        const offset = (page - 1) * limit;

        const merchantId = String(search.merchant_id || search.merchantId || '').trim();
        const searchAllMerchants =
          !merchantId ||
          search.search_all_merchants === true ||
          search.searchAllMerchants === true;
        const priceMin = search.price_min ?? search.min_price;
        const priceMax = search.price_max ?? search.max_price;

        queryParams = {
          ...(merchantId ? { merchant_id: merchantId } : {}),
          ...(search.query != null ? { query: String(search.query || '') } : {}),
          ...(search.category ? { category: search.category } : {}),
          ...(priceMin != null ? { min_price: priceMin } : {}),
          ...(priceMax != null ? { max_price: priceMax } : {}),
          ...(searchAllMerchants ? { search_all_merchants: true } : {}),
          in_stock_only: search.in_stock_only !== false,
          limit,
          offset,
        };
        queryParams = applyShoppingCatalogQueryGuards(queryParams, metadata?.source);
        break;
      }

      case 'products.recommendations': {
        const search = effectivePayload.search || effectivePayload || {};
        queryParams = {
          ...(search.merchant_id && { merchant_id: search.merchant_id }),
          ...(search.platform_product_id && { platform_product_id: search.platform_product_id }),
          ...(search.platform && { platform: search.platform }),
          ...(search.limit && { limit: Math.min(Number(search.limit || 0) || 0, 50) }),
        };
        break;
      }

      case 'find_products_multi': {
        // Cross-merchant search via Agent Search endpoint.
        const search = effectivePayload.search || effectivePayload || {};
        const page = Math.max(1, Number(search.page || 1) || 1);
        const limit = Math.min(Math.max(1, Number(search.limit || search.page_size || 20) || 20), 100);
        const offset = (page - 1) * limit;

        const merchantId = String(search.merchant_id || search.merchantId || '').trim();
        const merchantIdsRaw = search.merchant_ids || search.merchantIds;
        const merchantIds =
          Array.isArray(merchantIdsRaw)
            ? merchantIdsRaw.map((v) => String(v || '').trim()).filter(Boolean)
            : [];

        const searchAllMerchantsExplicit =
          search.search_all_merchants === true || search.searchAllMerchants === true;
        const creatorMerchantIds = uniqueStrings(getCreatorConfig(creatorId)?.merchantIds || []);

        const priceMin = search.price_min ?? search.min_price;
        const priceMax = search.price_max ?? search.max_price;

        const shouldScopeToCreatorCatalog =
          isCreatorUiSource(metadata?.source) &&
          !merchantId &&
          merchantIds.length === 0 &&
          !searchAllMerchantsExplicit &&
          creatorMerchantIds.length > 0;

        queryParams = {
          ...(merchantId ? { merchant_id: merchantId } : {}),
          ...(!merchantId && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
          ...(!merchantId && merchantIds.length === 0 && shouldScopeToCreatorCatalog
            ? { merchant_ids: creatorMerchantIds }
            : {}),
          ...(!merchantId && merchantIds.length === 0 && !shouldScopeToCreatorCatalog
            ? { search_all_merchants: true }
            : {}),
          ...(search.query != null ? { query: String(search.query || '') } : {}),
          ...(search.category ? { category: search.category } : {}),
          ...(priceMin != null ? { min_price: priceMin } : {}),
          ...(priceMax != null ? { max_price: priceMax } : {}),
          in_stock_only: search.in_stock_only !== false,
          limit,
          offset,
        };
        queryParams = applyShoppingCatalogQueryGuards(queryParams, metadata?.source);
        break;
      }
      
      case 'find_similar_products': {
        // Creator UI: prefer cache-based similarity so "Find more" stays consistent
        // with the creator pool even when upstream has stale/partial cache.
        const source = metadata?.source;
        const isCreatorUi = isCreatorUiSource(source);
        if (isCreatorUi && process.env.DATABASE_URL) {
          try {
            const sim = payload.similar || {};
            const productId = sim.product_id || payload.product_id;
            const lim = sim.limit || payload.limit || 9;
            const cached = await findSimilarCreatorFromCache(creatorId, productId, lim);
            if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
              const promotions = await getActivePromotions(now, creatorId);
              const enriched = applyDealsToResponse(cached, promotions, now, creatorId);
              return res.json(enriched);
            }
          } catch (err) {
            logger.warn(
              { err: err.message, creatorId, source },
              'Creator UI cache similarity failed; falling back to upstream'
            );
          }
        }

        // P0: Avoid invoking upstream /agent/shop/v1/invoke for similarity.
        // In REAL mode this can trigger TOOL_LOOP_DETECTED depending on upstream routing.
        // Instead, use our lightweight RecommendationEngine (DB-backed + cached).
        try {
          const sim = payload.similar || {};
          const productId = String(sim.product_id || payload.product_id || '').trim();
          const merchantId = String(sim.merchant_id || payload.merchant_id || '').trim();
          const limit = Math.max(1, Math.min(Number(sim.limit || payload.limit || 6) || 6, 30));
          const bypassCache =
            payload?.options?.no_cache === true ||
            payload?.options?.cache_bypass === true ||
            payload?.options?.bypass_cache === true ||
            sim?.options?.no_cache === true ||
            sim?.options?.cache_bypass === true ||
            sim?.options?.bypass_cache === true;
          const debugEnabled =
            payload?.options?.debug === true ||
            sim?.options?.debug === true;

          if (productId) {
            const baseProduct =
              (merchantId
                ? await fetchProductDetailForOffers({
                    merchantId,
                    productId,
                    checkoutToken,
                  }).catch(() => null)
                : null) || { merchant_id: merchantId || null, product_id: productId };

            const rec = await recommendPdpProducts({
              pdp_product: baseProduct,
              k: limit,
              locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
              currency: baseProduct.currency || baseProduct.price?.currency || 'USD',
              options: {
                debug: debugEnabled,
                no_cache: bypassCache,
                cache_bypass: bypassCache,
                bypass_cache: bypassCache,
              },
            });

            const products = Array.isArray(rec?.items) ? rec.items : [];

            // Keep response structure stable for existing clients.
            const baseResponse = {
              status: 'success',
              strategy: 'related_products',
              products,
              total: products.length,
              page: 1,
              page_size: products.length,
            };

            return debugEnabled
              ? res.json({
                  ...baseResponse,
                  debug: rec?.debug || null,
                  cache: rec?.cache || null,
                })
              : res.json(baseResponse);
          }
        } catch (err) {
          logger.warn(
            { err: err?.message || String(err), product_id: payload?.similar?.product_id || payload?.product_id },
            'find_similar_products: local recommendations failed; falling back to upstream',
          );
        }

        // Delegate to backend shopping gateway which owns the similarity logic.
        // Accept both the legacy nested shape (payload.similar) and the
        // flat shape (payload.product_id, payload.merchant_id, etc.).
        const sim = payload.similar || {};
        const normalizedPayload = {
          product_id: sim.product_id || payload.product_id,
          merchant_id: sim.merchant_id || payload.merchant_id,
          limit: sim.limit || payload.limit,
          strategy: sim.strategy || payload.strategy,
          user: sim.user || payload.user,
          creator_id:
            payload.creator_id ||
            sim.creator_id ||
            metadata.creator_id ||
            undefined,
          metadata,
        };
        requestBody = {
          operation,
          payload: normalizedPayload,
          metadata,
        };
        break;
      }
      
      case 'get_product_detail': {
        const merchantId = String(payload.product?.merchant_id || payload.product?.merchantId || '').trim();
        const productId = String(payload.product?.product_id || payload.product?.productId || '').trim();
        const options = payload.options || payload.product?.options || {};
        productDetailMerchantId = merchantId;
        productDetailProductId = productId;
        productDetailDebug =
          options.debug === true ||
          String(options.debug || '').trim().toLowerCase() === 'true' ||
          payload.debug === true;
        productDetailBypassCache =
          options.no_cache === true ||
          options.cache_bypass === true ||
          options.bypass_cache === true ||
          String(options.no_cache || '').trim().toLowerCase() === 'true' ||
          String(options.cache_bypass || options.bypass_cache || '')
            .trim()
            .toLowerCase() === 'true';
        if (!merchantId || !productId) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required'
          });
        }
        productDetailCacheKey = JSON.stringify({
          merchantId,
          productId,
          hasCheckoutToken: Boolean(checkoutToken),
        });
        url = url
          .replace('{merchant_id}', encodeURIComponent(merchantId))
          .replace('{product_id}', encodeURIComponent(productId));
        break;
      }

	      case 'preview_quote': {
	        const quote = payload.quote || {};
	        const offerIdRaw =
	          quote.offer_id || quote.offerId || payload.offer_id || payload.offerId || null;
	        const offerId = String(offerIdRaw || '').trim() || null;
	        const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
	        const effectiveMerchantId = merchantFromOffer || quote.merchant_id;

	        if (!effectiveMerchantId || !Array.isArray(quote.items) || quote.items.length === 0) {
	          return res.status(400).json({
	            error: 'MISSING_PARAMETERS',
	            message: 'quote.merchant_id (or quote.offer_id) and quote.items[] are required',
	          });
	        }

	        if (offerId) {
	          resolvedOfferId = offerId;
	          resolvedMerchantId = String(effectiveMerchantId || '').trim() || null;
	        }

	        const normalizedQuote = { ...quote, merchant_id: effectiveMerchantId };
	        delete normalizedQuote.offer_id;
	        delete normalizedQuote.offerId;

	        if (offerId) {
	          try {
	            const rewritten = await rewriteCheckoutItemsForOfferSelection({
	              offerId,
	              merchantId: effectiveMerchantId,
	              items: normalizedQuote.items,
	              checkoutToken,
	            });
	            if (Array.isArray(rewritten?.items) && rewritten.items.length > 0) {
	              normalizedQuote.items = rewritten.items;
	            }
	          } catch (err) {
	            const code = err?.code || 'CHECKOUT_ITEM_REWRITE_FAILED';
	            return res.status(400).json({
	              error: code,
	              message: err?.message || 'Failed to map selected offer to merchant catalog items',
	            });
	          }
	        }

	        requestBody = normalizedQuote;
	        break;
	      }
      
	      case 'create_order': {
	        // Map to real API requirements
	        const order = payload.order || {};
	        const offerIdRaw =
	          order.offer_id || order.offerId || payload.offer_id || payload.offerId || null;
	        const offerId = String(offerIdRaw || '').trim() || null;

	        const items = Array.isArray(order.items) ? order.items : [];
	        
	        // Calculate totals if not provided
	        const subtotal = items.reduce((sum, item) => sum + (item.unit_price || item.price || 0) * item.quantity, 0);
        
        // Extract merchant_id from first item (assuming single merchant order)
        const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
        const merchant_id = merchantFromOffer || items[0]?.merchant_id;
        if (!merchant_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id is required in items (or provide order.offer_id)'
          });
        }

	        if (offerId) {
	          resolvedOfferId = offerId;
	          resolvedMerchantId = String(merchant_id || '').trim() || null;
	        }

	        let rewrittenItems = items;
	        if (offerId && Array.isArray(items) && items.length > 0) {
	          try {
	            const rewritten = await rewriteCheckoutItemsForOfferSelection({
	              offerId,
	              merchantId: merchant_id,
	              items,
	              checkoutToken,
	            });
	            if (Array.isArray(rewritten?.items) && rewritten.items.length > 0) {
	              rewrittenItems = rewritten.items;
	            }
	          } catch (err) {
	            const code = err?.code || 'CHECKOUT_ITEM_REWRITE_FAILED';
	            return res.status(400).json({
	              error: code,
	              message: err?.message || 'Failed to map selected offer to merchant catalog items',
	            });
	          }
	        }

	        // Optional hint for PSP selection / checkout mode
	        const preferredPsp =
	          order.preferred_psp || payload.preferred_psp || undefined;
	        
        // Build request body with all required fields
	        requestBody = {
	          merchant_id,
	          customer_email: order.customer_email || 'agent@pivota.cc', // Default for agent orders
	          ...(order.currency ? { currency: order.currency } : {}),
	          ...(order.quote_id ? { quote_id: order.quote_id } : {}),
	          ...(order.selected_delivery_option
	            ? { selected_delivery_option: order.selected_delivery_option }
	            : {}),
	          items: rewrittenItems.map(item => ({
	            merchant_id,
	            product_id: item.product_id,
	            // Optional variant / SKU information for multi-variant products.
	            ...(item.variant_id ? { variant_id: item.variant_id } : {}),
	            ...(item.sku ? { sku: item.sku } : {}),
            ...(item.selected_options ? { selected_options: item.selected_options } : {}),
            product_title: item.product_title || item.title || 'Product',
            quantity: item.quantity,
            unit_price: item.unit_price || item.price,
            subtotal: (item.unit_price || item.price) * item.quantity
          })),
	          ...(order.discount_codes ? { discount_codes: order.discount_codes } : {}),
	          shipping_address: {
	            name: order.shipping_address?.recipient_name || order.shipping_address?.name,
	            address_line1: order.shipping_address?.address_line1,
	            address_line2: order.shipping_address?.address_line2 || '',
	            city: order.shipping_address?.city,
	            ...(order.shipping_address?.state
	              ? { state: order.shipping_address.state }
	              : order.shipping_address?.province
	                ? { state: order.shipping_address.province }
	                : order.shipping_address?.state_code
	                  ? { state: order.shipping_address.state_code }
	                  : order.shipping_address?.province_code
	                    ? { state: order.shipping_address.province_code }
	                    : {}),
	            country: order.shipping_address?.country,
	            postal_code: order.shipping_address?.postal_code,
	            phone: order.shipping_address?.phone || ''
	          },
          customer_notes: order.notes || '',
          // Pass through arbitrary order-level metadata (e.g. creator_id / creator_slug / creator_name)
          metadata: order.metadata || {},
          ...(preferredPsp && { preferred_psp: preferredPsp }),
          ...(payload.acp_state && { acp_state: payload.acp_state })
        };
        break;
      }

      case 'confirm_payment': {
        const order = payload.order || {};
        const orderId =
          order.order_id ||
          order.orderId ||
          payload.order_id ||
          payload.orderId ||
          payload.payment?.order_id ||
          payload.payment?.orderId ||
          payload.status?.order_id ||
          payload.status?.orderId;
        if (!orderId) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'order_id is required',
          });
        }
        url = url.replace('{order_id}', encodeURIComponent(orderId));
        requestBody = {};
        break;
      }
      
      case 'submit_payment': {
        // Map payment fields - Pivota uses 'total_amount' not 'amount'
        const payment = payload.payment || {};
        // 支持两种调用格式：
        // 1) payment_method_hint: "stripe_checkout"
        // 2) payment_method: "stripe_checkout"
        const methodHint =
          payment.payment_method_hint ||
          (typeof payment.payment_method === 'string'
            ? payment.payment_method
            : undefined);

        let idempotencyKey =
          payment.idempotency_key ||
          payment.idempotencyKey ||
          payload.idempotency_key ||
          payload.idempotencyKey ||
          undefined;
        if (!idempotencyKey && payment.order_id) {
          const basis = JSON.stringify({
            order_id: payment.order_id,
            method: methodHint || '',
            expected_amount: payment.expected_amount || null,
            currency: payment.currency || null,
          });
          idempotencyKey = `pivota_gateway:${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
        }

        requestBody = {
          order_id: payment.order_id,
          total_amount: payment.expected_amount, // Changed from 'amount' to 'total_amount'
          currency: payment.currency,
          // payment_method expects an object, not a string
          payment_method: methodHint
            ? {
                type: methodHint,
            // Add default fields for different payment types
                ...(methodHint === 'card' && {
                  card: {
                    // Placeholder for card details if needed
                  },
                }),
              }
            : undefined,
          redirect_url: payment.return_url,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          ...(payload.ap2_state && { ap2_state: payload.ap2_state })
        };
        break;
      }
      
      case 'get_order_status': {
        // Extract order_id from path
        if (!payload.status?.order_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'order_id is required'
          });
        }
        url = url.replace('{order_id}', payload.status.order_id);
        break;
      }
      
      case 'request_after_sales': {
        // Extract order_id and prepare optional body
        if (!payload.status?.order_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'order_id is required'
          });
        }
        const orderId = payload.status.order_id;
        const requestedActionRaw =
          payload.status.requested_action || payload.status.requestedAction || payload.status.action;
        const requestedAction =
          typeof requestedActionRaw === 'string' ? requestedActionRaw.trim().toLowerCase() : '';

        url = url.replace('{order_id}', orderId);

        // Support cancel via request_after_sales for external agentic tools.
        // - requested_action=cancel -> POST /agent/v1/orders/{order_id}/cancel
        // - default (or refund)     -> POST /agent/v1/orders/{order_id}/refund
        if (requestedAction === 'cancel') {
          url = `${PIVOTA_API_BASE}/agent/v1/orders/${encodeURIComponent(orderId)}/cancel`;
          break;
        }

        if (requestedAction && requestedAction !== 'refund') {
          return res.status(400).json({
            error: 'UNSUPPORTED_ACTION',
            message: `Unsupported requested_action: ${requestedAction}`
          });
        }

        if (payload.status.reason) requestBody = { reason: payload.status.reason };
        break;
      }

      case 'track_product_click': {
        // Directly forward structured click payload to backend
        // Expected payload shape:
        // {
        //   product: {
        //     merchant_id, platform, product_id,
        //     position, ranking_score, cq, mr, query
        //   }
        // }
        const p = payload.product || {};
        requestBody = {
          merchant_id: p.merchant_id,
          platform: p.platform,
          platform_product_id: p.product_id,
          position: p.position,
          ranking_score: p.ranking_score,
          quality_content_score: p.cq,
          quality_model_readiness: p.mr,
          query: p.query,
          ...(p.event_type || p.eventType || p.action
            ? { event_type: String(p.event_type || p.eventType || p.action).trim() }
            : {}),
        };
        if (!requestBody.merchant_id || !requestBody.platform_product_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required for track_product_click'
          });
        }
        break;
      }

      case 'offers.resolve': {
        // Forward to Python shopping gateway via POST /agent/shop/v1/invoke
        // Expected payload shape:
        // { offers: { product: { sku_id?, product_id? }, limit?, market?, tool? } }
        const offersPayload = payload.offers || payload || {};
        const offersProduct =
          offersPayload && typeof offersPayload.product === 'object' && !Array.isArray(offersPayload.product)
            ? { ...offersPayload.product }
            : {};
        const productId = String(
          offersProduct.product_id || offersProduct.productId || offersPayload.product_id || offersPayload.productId || '',
        ).trim();
        const skuId = String(
          offersProduct.sku_id || offersProduct.skuId || offersPayload.sku_id || offersPayload.skuId || '',
        ).trim();
        const normalizedOffersPayload = {
          ...offersPayload,
          product: {
            ...offersProduct,
            ...(productId ? { product_id: productId } : {}),
            ...(skuId ? { sku_id: skuId } : {}),
          },
          ...(productId ? { product_id: productId } : {}),
          ...(skuId ? { sku_id: skuId } : {}),
        };
        requestBody = {
          operation: 'offers.resolve',
          payload: normalizedOffersPayload,
          metadata,
        };
        break;
      }
    }

    logger.info({ operation, method: route.method, url, hasQuery: Object.keys(queryParams).length > 0 }, 'Forwarding invoke request');

    // Make the upstream request
    const queryString = buildQueryString(queryParams);
    const primarySearchQueryText = String(extractSearchQueryText(queryParams) || rawUserQuery || '').trim();
    const primarySearchAnchorTokens = extractSearchAnchorTokens(primarySearchQueryText);
    const isLookupPolicyQuery = isLookupStyleSearchQuery(primarySearchQueryText, primarySearchAnchorTokens);
    const queryClassForBudget = String(traceQueryClass || '').toLowerCase();
    const shouldUseShortSearchBudget =
      isLookupPolicyQuery ||
      ['lookup', 'category', 'attribute'].includes(queryClassForBudget);
    const upstreamBudgetMsForSearch = shouldUseShortSearchBudget
      ? FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS
      : FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS;

    const axiosConfig = {
      method: route.method,
      url: `${url}${queryString}`,
      headers: {
        ...(route.method !== 'GET' && { 'Content-Type': 'application/json' }),
        ...(checkoutToken
          ? { 'X-Checkout-Token': checkoutToken }
          : {
              // Pivota backend Agent API expects `X-API-Key` (some deployments used
              // `Authorization: Bearer ...` historically). Send both for compatibility.
              ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
              ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
            }),
      },
      // Use a longer timeout for quote/order/payment operations (Shopify pricing can be slow).
      timeout:
        operation === 'find_products_multi'
          ? getProxySearchPrimaryTimeoutMs(
              metadata?.source,
              Math.min(getUpstreamTimeoutMs(operation), upstreamBudgetMsForSearch),
            )
          : getUpstreamTimeoutMs(operation),
      ...(route.method !== 'GET' && Object.keys(requestBody).length > 0 && { data: requestBody })
    };

    let response;
    const searchQueryText = String(extractSearchQueryText(queryParams) || rawUserQuery || '').trim();
    const resolverQueryText = String(rawUserQuery || searchQueryText || '').trim();
    const resolverQueryParams = resolverQueryText ? { ...queryParams, query: resolverQueryText } : queryParams;
    const auroraFallbackOverrides = getAuroraFallbackOverrides(metadata?.source, operation);
    const resolverTimeoutMs = getProxySearchResolverTimeoutMs(metadata?.source);
    const secondaryFallbackTimeoutMs = getProxySearchFallbackTimeoutMs(metadata?.source);
    const shouldAttemptResolverFirst = shouldUseResolverFirstSearch({
      operation,
      metadata,
      queryText: resolverQueryText,
    });
    let resolverFirstResult = null;
    if (shouldAttemptResolverFirst) {
      try {
        resolverFirstResult = await queryResolveSearchFallback({
          queryParams: resolverQueryParams,
          checkoutToken,
          reason: 'resolver_first',
          timeoutMs: resolverTimeoutMs,
        });
        if (
          resolverFirstResult &&
          resolverFirstResult.status >= 200 &&
          resolverFirstResult.status < 300 &&
          resolverFirstResult.usableCount > 0
        ) {
          response = { status: resolverFirstResult.status, data: resolverFirstResult.data };
        }
      } catch (resolverErr) {
        logger.warn(
          { err: resolverErr?.message || String(resolverErr), operation },
          `${operation} resolver-first failed; falling back to upstream`,
        );
      }
    }
    if (
      !response &&
      operation === 'find_products_multi' &&
      shouldReducePrimaryTimeoutAfterResolverMiss(resolverFirstResult, resolverQueryText)
    ) {
      axiosConfig.timeout = Math.min(
        Number(axiosConfig.timeout || getUpstreamTimeoutMs(operation)),
        PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
      );
    }
    try {
      if (
        operation === 'get_product_detail' &&
        productDetailCacheKey &&
        PRODUCT_DETAIL_CACHE_ENABLED &&
        !productDetailBypassCache
      ) {
        const cachedEntry = getProductDetailCacheEntry(productDetailCacheKey);
        if (cachedEntry?.value) {
          const ageMs =
            typeof cachedEntry.storedAtMs === 'number'
              ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
              : 0;
          response = { status: 200, data: safeCloneJson(cachedEntry.value) };
          productDetailCacheMeta = {
            hit: true,
            source: 'memory',
            age_ms: ageMs,
            ttl_ms: PRODUCT_DETAIL_CACHE_TTL_MS,
          };
        } else if (process.env.DATABASE_URL) {
          const fromDb = await fetchProductDetailFromProductsCache({
            merchantId: productDetailMerchantId,
            productId: productDetailProductId,
            includeExpired: true,
            staleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
          });
          if (fromDb?.product) {
            PRODUCT_DETAIL_CACHE_METRICS.db_hits += 1;
            response = {
              status: 200,
              data: {
                status: 'success',
                success: true,
                product: fromDb.product,
                metadata: {
                  query_source: 'products_cache',
                  cached_at: fromDb.cached_at || null,
                },
              },
            };
            productDetailCacheMeta = {
              hit: true,
              source: 'products_cache',
              age_ms: 0,
              ttl_ms: PRODUCT_DETAIL_CACHE_TTL_MS,
            };
          }
        }
      } else if (operation === 'get_product_detail' && productDetailCacheKey && productDetailBypassCache) {
        PRODUCT_DETAIL_CACHE_METRICS.bypasses += 1;
      }

      if (!response) {
        response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
        if (operation === 'get_product_detail') {
          productDetailCacheMeta = { hit: false, source: 'upstream' };
        }
      }
    } catch (err) {
      // Compatibility: some upstream deployments expect body to be embedded
      // under `order_request` (FastAPI body param naming). Retry once with the
      // embedded shape when we detect that specific 422 schema error.
      if (
        operation === 'create_order' &&
        requestBody &&
        Object.keys(requestBody).length > 0 &&
        isPydanticMissingBodyField(err, 'order_request')
      ) {
        try {
          axiosConfig.data = { order_request: requestBody };
          response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
        } catch (wrappedErr) {
          err = wrappedErr;
        }
      }

      // Quote-first hardening: auto re-quote once on QUOTE_EXPIRED / QUOTE_MISMATCH.
      if (!response && operation === 'create_order' && axiosConfig.data) {
        const createOrderBody = axiosConfig.data;
        const normalizedOrderRequest =
          createOrderBody && createOrderBody.order_request
            ? createOrderBody.order_request
            : createOrderBody;
        const quoteId =
          normalizedOrderRequest && typeof normalizedOrderRequest === 'object'
            ? normalizedOrderRequest.quote_id
            : null;

        const { code } = extractUpstreamErrorCode(err);
        if (quoteId && isRetryableQuoteError(code)) {
          try {
            const quoteBody = {
              merchant_id: normalizedOrderRequest.merchant_id,
              items: Array.isArray(normalizedOrderRequest.items)
                ? normalizedOrderRequest.items.map((it) => ({
                    product_id: it.product_id,
                    variant_id: it.variant_id || undefined,
                    quantity: it.quantity,
                  }))
                : [],
              discount_codes: normalizedOrderRequest.discount_codes || [],
              customer_email: normalizedOrderRequest.customer_email || undefined,
              shipping_address: normalizedOrderRequest.shipping_address || undefined,
              ...(normalizedOrderRequest.selected_delivery_option
                ? {
                    selected_delivery_option:
                      normalizedOrderRequest.selected_delivery_option,
                  }
                : {}),
            };

            const quoteUrl = `${PIVOTA_API_BASE}/agent/v1/quotes/preview`;
            const quoteResp = await callUpstreamWithOptionalRetry('preview_quote', {
              method: 'POST',
              url: quoteUrl,
              headers: {
                'Content-Type': 'application/json',
                ...(checkoutToken
                  ? { 'X-Checkout-Token': checkoutToken }
                  : {
                      ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
                      ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
                    }),
              },
              timeout: getUpstreamTimeoutMs('preview_quote'),
              data: quoteBody,
            });

            const newQuoteId = quoteResp && quoteResp.data ? quoteResp.data.quote_id : null;
            if (newQuoteId) {
              normalizedOrderRequest.quote_id = newQuoteId;
              axiosConfig.data =
                createOrderBody && createOrderBody.order_request
                  ? { order_request: normalizedOrderRequest }
                  : normalizedOrderRequest;
              response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
            }
          } catch (_) {
            // Fall through and surface the original upstream error.
          }
        }
      }

      if (!response && operation === 'submit_payment' && axiosConfig.data) {
        const { code } = extractUpstreamErrorCode(err);
        if (code === 'TEMPORARY_UNAVAILABLE') {
          logger.warn(
            { operation, code },
            'Upstream reported temporary unavailability; retrying submit_payment once'
          );
          await new Promise((resolve) => setTimeout(resolve, 900));
          response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
        }
      }

      if (!response && (operation === 'find_products' || operation === 'find_products_multi')) {
        const queryText = resolverQueryText || searchQueryText;
        const upstreamStatus = err?.response?.status || null;
        const { code: upstreamCode, message: upstreamMessage } = extractUpstreamErrorCode(err);
        const skipSecondaryFallback = shouldSkipSecondaryFallbackAfterResolverMiss(
          resolverFirstResult,
          queryText,
          {
            disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
          },
        );
        const allowResolverFallback = shouldAllowResolverFallback(operation);
        const allowSecondaryFallback = shouldAllowSecondaryFallback(operation, {
          forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
        });
        const allowInvokeFallback = shouldAllowInvokeFallback(operation, {
          forceInvokeFallback: auroraFallbackOverrides.forceInvokeFallback,
        });
        const bypassSkipSecondaryFallback = shouldBypassSecondaryFallbackSkipOnPrimaryException({ err });
        const allowResolverFallbackOnException =
          allowResolverFallback && (!skipSecondaryFallback || bypassSkipSecondaryFallback);
        const allowSecondaryFallbackOnException =
          allowSecondaryFallback &&
          allowInvokeFallback &&
          (!skipSecondaryFallback || bypassSkipSecondaryFallback);
        if (queryText) {
          const fallbackReason =
            upstreamStatus
              ? `upstream_status_${upstreamStatus}`
              : err?.code === 'ECONNABORTED'
                ? 'upstream_timeout'
                : 'upstream_exception';

          if (allowResolverFallbackOnException) {
            try {
              const resolverFallback = await queryResolveSearchFallback({
                queryParams: resolverQueryParams,
                checkoutToken,
                reason: 'resolver_after_exception',
                timeoutMs: resolverTimeoutMs,
              });
              if (
                resolverFallback &&
                resolverFallback.status >= 200 &&
                resolverFallback.status < 300 &&
                resolverFallback.usableCount > 0
              ) {
                response = {
                  status: resolverFallback.status,
                  data: withProxySearchFallbackMetadata(resolverFallback.data, {
                    applied: true,
                    reason: 'resolver_after_exception',
                    route: 'invoke_exception_resolver',
                    upstream_status: upstreamStatus,
                    upstream_error_code: upstreamCode || err?.code || null,
                    upstream_error_message: upstreamMessage || err?.message || null,
                  }),
                };
              }
            } catch (resolverErr) {
              logger.warn(
                { err: resolverErr?.message || String(resolverErr) },
                `${operation} resolver fallback failed after upstream exception`,
              );
            }
          }

          if (!response && allowSecondaryFallbackOnException) {
            try {
              const fallback = await queryFindProductsMultiFallback({
                queryParams: resolverQueryParams,
                checkoutToken,
                reason: fallbackReason,
                requestSource: metadata?.source,
                timeoutMs: secondaryFallbackTimeoutMs,
              });
              if (
                fallback &&
                fallback.status >= 200 &&
                fallback.status < 300 &&
                fallback.usableCount > 0 &&
                isProxySearchFallbackRelevant(fallback.data, queryText)
              ) {
                response = {
                  status: fallback.status,
                  data: withProxySearchFallbackMetadata(fallback.data, {
                    applied: true,
                    reason: fallbackReason,
                    route: 'invoke_exception_fallback_invoke',
                    upstream_status: upstreamStatus,
                    upstream_error_code: upstreamCode || err?.code || null,
                    upstream_error_message: upstreamMessage || err?.message || null,
                  }),
                };
              }
            } catch (fallbackErr) {
              logger.warn(
                { err: fallbackErr?.message || String(fallbackErr) },
                `${operation} invoke fallback failed after upstream exception`,
              );
            }
          }
        }
        if (!response) {
          if (
            operation === 'find_products_multi' &&
            crossMerchantCacheProtectedResponse &&
            Array.isArray(crossMerchantCacheProtectedResponse.products) &&
            crossMerchantCacheProtectedResponse.products.length > 0
          ) {
            response = {
              status: 200,
              data: withProxySearchFallbackMetadata(
                normalizeAgentProductsListResponse(crossMerchantCacheProtectedResponse, {
                  limit: queryParams?.limit,
                  offset: queryParams?.offset,
                }),
                {
                  applied: false,
                  reason: 'primary_exception_cache_guard',
                  route: 'invoke_exception_cache_guard',
                  upstream_status: upstreamStatus,
                  upstream_error_code: upstreamCode || err?.code || null,
                  upstream_error_message: upstreamMessage || err?.message || null,
                },
              ),
            };
          }
        }
        if (!response) {
          logger.warn(
            {
              operation,
              upstream_status: upstreamStatus,
              upstream_code: err?.code || null,
              soft_code: upstreamCode || null,
              soft_message: upstreamMessage || null,
            },
            `${operation} upstream failed; returning soft fallback empty payload`,
          );
          response = {
            status: 200,
            data: buildProxySearchSoftFallbackResponse({
              queryParams,
              reason: 'error_soft_fallback',
              upstreamStatus,
              upstreamCode: upstreamCode || err?.code || null,
              upstreamMessage: upstreamMessage || err?.message || null,
              route: 'invoke_exception',
            }),
          };
        }
      }

      if (!response) throw err;
    }
    let upstreamData = response.data;
    if (
      operation === 'find_products_multi' &&
      ROUTE_DEBUG_ENABLED &&
      (creatorCacheRouteDebug || crossMerchantCacheRouteDebug)
    ) {
      upstreamData = {
        ...upstreamData,
        metadata: {
          ...(upstreamData.metadata || {}),
          route_debug: {
            ...((upstreamData.metadata && upstreamData.metadata.route_debug) || {}),
            ...(creatorCacheRouteDebug ? { creator_cache: creatorCacheRouteDebug } : {}),
            ...(crossMerchantCacheRouteDebug ? { cross_merchant_cache: crossMerchantCacheRouteDebug } : {}),
          },
        },
      };
    }

    if (operation === 'find_products' || operation === 'find_products_multi') {
      upstreamData = normalizeAgentProductsListResponse(upstreamData, {
        limit: queryParams?.limit,
        offset: queryParams?.offset,
      });
    }

    if (operation === 'find_products' || operation === 'find_products_multi') {
      const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
      const primaryUsableCount = countUsableSearchProducts(upstreamData?.products);
      const primaryUnusable = Boolean(queryText) && shouldFallbackProxySearch(upstreamData, response.status);
      const primaryRelevant = queryText ? isProxySearchFallbackRelevant(upstreamData, queryText) : true;
      const primaryIrrelevant = Boolean(queryText) && primaryUsableCount > 0 && !primaryRelevant;
      const shouldFallback = primaryUnusable || primaryIrrelevant;
      const requestedLimit = Math.min(
        Math.max(1, Number(queryParams?.limit || queryParams?.page_size || 20) || 20),
        100,
      );
      const skipSecondaryFallback = shouldSkipSecondaryFallbackAfterResolverMiss(
        resolverFirstResult,
        queryText,
        {
          disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
        },
      );
      const allowResolverFallback = shouldAllowResolverFallback(operation);
      const allowSecondaryFallback = shouldAllowSecondaryFallback(operation, {
        forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
      });
      const allowInvokeFallback = shouldAllowInvokeFallback(operation, {
        forceInvokeFallback: auroraFallbackOverrides.forceInvokeFallback,
      });
      const fallbackAdoptUsableThreshold = getFallbackAdoptUsableThreshold({
        source: metadata?.source,
        primaryUsableCount,
        primaryIrrelevant,
      });
      let secondarySupplementMeta = null;

      if (
        operation === 'find_products_multi' &&
        queryText &&
        response.status >= 200 &&
        response.status < 300 &&
        !shouldFallback &&
        primaryUsableCount < requestedLimit &&
        FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE !== 'off'
      ) {
        try {
          const secondStageCtx = await buildFindProductsMultiContext({
            payload,
            metadata: {
              ...(metadata || {}),
              expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
            },
          });
          const expandedSecondaryQuery = String(
            secondStageCtx?.adjustedPayload?.search?.query || queryText,
          ).trim();
          if (expandedSecondaryQuery && expandedSecondaryQuery !== queryText) {
            const secondaryQueryParams = {
              ...queryParams,
              query: expandedSecondaryQuery,
              offset: 0,
              limit: Math.min(Math.max(requestedLimit * 2, 20), 80),
            };
            const secondaryResp = await axios({
              method: 'GET',
              url: `${url}${buildQueryString(secondaryQueryParams)}`,
              headers: axiosConfig.headers,
              timeout: Math.min(2400, Number(axiosConfig.timeout || 2400)),
              validateStatus: () => true,
            });
            const secondaryNormalized = normalizeAgentProductsListResponse(secondaryResp.data, {
              limit: secondaryQueryParams.limit,
              offset: 0,
            });
            const secondaryProducts = Array.isArray(secondaryNormalized?.products)
              ? secondaryNormalized.products
              : [];
            if (secondaryResp.status >= 200 && secondaryResp.status < 300 && secondaryProducts.length > 0) {
              const primaryProducts = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
              const seen = new Set(primaryProducts.map((product) => buildSearchProductKey(product)).filter(Boolean));
              const toAppend = [];
              for (const product of secondaryProducts) {
                if (!isSupplementCandidateRelevant(product, queryText)) continue;
                const key = buildSearchProductKey(product);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                toAppend.push(product);
                if (primaryProducts.length + toAppend.length >= requestedLimit) break;
              }
              if (toAppend.length > 0) {
                const mergedProducts = primaryProducts.concat(toAppend);
                upstreamData = normalizeAgentProductsListResponse(
                  {
                    ...(upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : {}),
                    products: mergedProducts,
                    total: Math.max(
                      Number(upstreamData?.total || 0) || 0,
                      mergedProducts.length,
                    ),
                  },
                  {
                    limit: queryParams?.limit,
                    offset: queryParams?.offset,
                  },
                );
              }
              secondarySupplementMeta = {
                attempted: true,
                applied: toAppend.length > 0,
                added_count: toAppend.length,
                expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
                expanded_query: expandedSecondaryQuery,
                reason: toAppend.length > 0 ? 'second_stage_supplemented' : 'second_stage_no_relevant_candidates',
              };
            } else {
              secondarySupplementMeta = {
                attempted: true,
                applied: false,
                added_count: 0,
                expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
                expanded_query: expandedSecondaryQuery,
                reason: 'second_stage_unavailable',
              };
            }
          }
        } catch (secondaryErr) {
          secondarySupplementMeta = {
            attempted: true,
            applied: false,
            added_count: 0,
            expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
            reason: 'second_stage_error',
            error: String(secondaryErr?.message || secondaryErr),
          };
          logger.warn(
            { err: secondaryErr?.message || String(secondaryErr), query: queryText },
            `${operation} second-stage conservative->aggressive supplement failed`,
          );
        }
      }

      if (shouldFallback) {
        let replacedByFallback = false;

        if (allowResolverFallback && !skipSecondaryFallback) {
          try {
            const resolverFallback = await queryResolveSearchFallback({
              queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
              checkoutToken,
              reason: 'resolver_after_primary',
              timeoutMs: resolverTimeoutMs,
            });
            if (
              resolverFallback &&
              resolverFallback.status >= 200 &&
              resolverFallback.status < 300 &&
              resolverFallback.usableCount > 0
            ) {
              upstreamData = resolverFallback.data;
              replacedByFallback = true;
            }
          } catch (resolverErr) {
            logger.warn(
              { err: resolverErr?.message || String(resolverErr) },
              `${operation} resolver fallback failed after primary response`,
            );
          }
        }

        if (!replacedByFallback && allowSecondaryFallback && allowInvokeFallback && !skipSecondaryFallback) {
          try {
            const fallback = await queryFindProductsMultiFallback({
              queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
              checkoutToken,
              reason: primaryUnusable
                ? primaryUsableCount > 0
                  ? 'insufficient_primary'
                  : 'empty_or_unusable_primary'
                : 'primary_irrelevant',
              requestSource: metadata?.source,
              timeoutMs: secondaryFallbackTimeoutMs,
            });
            if (
              fallback &&
              fallback.status >= 200 &&
              fallback.status < 300 &&
              fallback.usableCount >= fallbackAdoptUsableThreshold &&
              isProxySearchFallbackRelevant(fallback.data, queryText)
            ) {
              upstreamData = fallback.data;
              replacedByFallback = true;
            }
          } catch (fallbackErr) {
            logger.warn(
              { err: fallbackErr?.message || String(fallbackErr) },
              `${operation} invoke fallback failed after primary response`,
            );
          }
        }

        if (!replacedByFallback) {
          if (primaryIrrelevant) {
            upstreamData = buildProxySearchSoftFallbackResponse({
              queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
              reason: skipSecondaryFallback ? 'primary_irrelevant_skip_secondary' : 'primary_irrelevant_no_fallback',
              upstreamStatus: response.status,
              route: 'invoke_primary_irrelevant',
            });
          } else {
            upstreamData = withProxySearchFallbackMetadata(upstreamData, {
              applied: false,
              reason: skipSecondaryFallback ? 'resolver_miss_skip_secondary' : 'fallback_not_better',
            });
          }
        }
      }

      if (
        operation === 'find_products_multi' &&
        secondarySupplementMeta &&
        upstreamData &&
        typeof upstreamData === 'object' &&
        !Array.isArray(upstreamData)
      ) {
        upstreamData = {
          ...upstreamData,
          metadata: {
            ...(upstreamData.metadata && typeof upstreamData.metadata === 'object' ? upstreamData.metadata : {}),
            search_stage_b: secondarySupplementMeta,
          },
        };
      }
    }

    if (operation === 'offers.resolve') {
      upstreamData = prioritizeOffersResolveResponse(upstreamData);
    }

    if (operation === 'get_product_detail') {
      upstreamData = normalizeAgentProductDetailResponse(upstreamData);
      if (
        productDetailCacheKey &&
        PRODUCT_DETAIL_CACHE_ENABLED &&
        !productDetailBypassCache &&
        upstreamData &&
        typeof upstreamData === 'object' &&
        !Array.isArray(upstreamData)
      ) {
        const shouldCache =
          response?.status === 200 &&
          (upstreamData.product || upstreamData?.data?.product);
        if (shouldCache && (!productDetailCacheMeta || productDetailCacheMeta.source !== 'memory')) {
          setProductDetailCache(productDetailCacheKey, upstreamData);
        }
      }
      if (productDetailDebug && productDetailCacheMeta) {
        upstreamData = {
          ...upstreamData,
          cache: productDetailCacheMeta,
        };
      }
    }

    if (
      (operation === 'preview_quote' || operation === 'create_order') &&
      resolvedOfferId &&
      upstreamData &&
      typeof upstreamData === 'object' &&
      !Array.isArray(upstreamData)
    ) {
      upstreamData = {
        ...upstreamData,
        resolved_offer_id: resolvedOfferId,
        ...(resolvedMerchantId ? { resolved_merchant_id: resolvedMerchantId } : {}),
      };
    }

    if (
      operation === 'create_order' &&
      upstreamData &&
      typeof upstreamData === 'object' &&
      !Array.isArray(upstreamData)
    ) {
      const normalizedOrderRequest =
        requestBody && requestBody.order_request
          ? requestBody.order_request
          : requestBody;
      if (normalizedOrderRequest && !upstreamData.order_lines) {
        const orderLines = buildOrderLineSnapshots(normalizedOrderRequest, {
          orderId: upstreamData.order_id || upstreamData.orderId || null,
          resolvedOfferId,
          resolvedMerchantId,
        });
        if (orderLines.length) {
          upstreamData = {
            ...upstreamData,
            order_lines: orderLines,
          };
        }
      }
    }

    const promotions = await getActivePromotions(now, creatorId);

    // Normalize submit_payment responses so frontends always see a unified
    // payment object with PSP + payment_action, regardless of PSP type.
    if (operation === 'submit_payment') {
      const p = upstreamData || {};
      const psp =
        p.psp ||
        p.psp_used ||
        (p.payment && (p.payment.psp || p.payment.psp_used)) ||
        null;

      let paymentAction =
        p.payment_action ||
        (p.payment && p.payment.payment_action) ||
        null;

      // Derive payment_action when backend only returns flat fields
      if (!paymentAction) {
        if (psp === 'adyen' && p.client_secret) {
          paymentAction = {
            type: 'adyen_session',
            client_secret: p.client_secret,
            url: null,
            raw: null,
          };
        } else if (psp === 'stripe' && p.client_secret) {
          paymentAction = {
            type: 'stripe_client_secret',
            client_secret: p.client_secret,
            url: null,
            raw: null,
          };
        } else if (p.next_action && p.next_action.redirect_url) {
          paymentAction = {
            type: 'redirect_url',
            client_secret: p.client_secret || null,
            url: p.next_action.redirect_url,
            raw: null,
          };
        }
      }

      const wrapped = {
        ...p,
        psp: psp || null,
        payment_action: paymentAction || null,
        payment: {
          psp: psp || null,
          client_secret: p.client_secret || null,
          payment_intent_id: p.payment_intent_id || null,
          payment_action: paymentAction || null,
        },
      };

      return res.status(response.status).json(wrapped);
    }

    if (operation === 'get_product_detail' && shouldIncludePdp(payload)) {
      const product =
        upstreamData?.product ||
        upstreamData?.data?.product ||
        null;
      if (product) {
        const pdpOptions = getPdpOptions(payload);
        let relatedProducts = [];
        if (pdpOptions.includeRecommendations) {
          const bypassCache =
            payload?.options?.no_cache === true ||
            payload?.options?.cache_bypass === true ||
            payload?.options?.bypass_cache === true;
          try {
            const rec = await recommendPdpProducts({
              pdp_product: product,
              k: payload.recommendations?.limit || 6,
              locale: payload?.context?.locale || payload?.context?.language || payload?.locale || 'en-US',
              currency: product.currency || 'USD',
              options: {
                debug: pdpOptions.debug,
                no_cache: bypassCache,
                cache_bypass: bypassCache,
                bypass_cache: bypassCache,
              },
            });
            relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
          } catch (err) {
            logger.warn(
              { err: err?.message || String(err), merchant_id: product.merchant_id, product_id: product.product_id },
              'PDP recommendations failed (get_product_detail include=pdp); continuing without recommendations module',
            );
            relatedProducts = [];
          }
        }
        upstreamData = {
          ...upstreamData,
          pdp_payload: buildPdpPayload({
            product,
            relatedProducts,
            entryPoint: pdpOptions.entryPoint,
            experiment: pdpOptions.experiment,
            templateHint: pdpOptions.templateHint,
            includeEmptyReviews: pdpOptions.includeEmptyReviews,
            debug: pdpOptions.debug,
          }),
        };
      }
    }

    let maybePolicy = upstreamData;
    if (operation === 'find_products_multi' && effectiveIntent) {
      const upstreamMetadata =
        upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData)
          ? (upstreamData.metadata && typeof upstreamData.metadata === 'object' && !Array.isArray(upstreamData.metadata)
              ? upstreamData.metadata
              : {})
          : {};
      const policyQueryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
      const isLookupPolicyQuery = isLookupStyleSearchQuery(
        policyQueryText,
        extractSearchAnchorTokens(policyQueryText),
      );
      const querySource = String(upstreamMetadata.query_source || '').trim();
      const isResolverLookupSource =
        querySource === 'agent_products_resolver_ref_fallback' ||
        querySource === 'agent_products_resolver_fallback';
      const isCacheLookupSource =
        querySource === 'cache_cross_merchant_search' ||
        querySource === 'cache_cross_merchant_search_supplemented';
      const isErrorSoftFallbackSource = querySource === 'agent_products_error_fallback';
      const isAliasLookupQuery = isKnownLookupAliasQuery(policyQueryText);
      const skipPolicyForLookupSoftFallback =
        isErrorSoftFallbackSource ||
        (isResolverLookupSource && isLookupPolicyQuery) ||
        (isCacheLookupSource && isLookupPolicyQuery) ||
        (querySource === 'agent_products_search' && isAliasLookupQuery);

      maybePolicy = skipPolicyForLookupSoftFallback
        ? upstreamData
        : applyFindProductsMultiPolicy({
            response: upstreamData,
            intent: effectiveIntent,
            requestPayload: effectivePayload,
            metadata: policyMetadata,
            rawUserQuery,
          });

      const effTarget = effectiveIntent?.target_object?.type || 'unknown';
      const productsAfterPolicy = Array.isArray(maybePolicy.products) ? maybePolicy.products : [];
      const upstreamTotal = Array.isArray(upstreamData.products) ? upstreamData.products.length : upstreamData.total || 0;

      // Pet-specific recall fallback:
      // If multi-merchant recall (cache_multi_intent) returns only non-pet / blocked items
      // and policy filters everything out, try the creator's own sellable cache with a
      // simplified pet query so we at least surface some dog apparel.
      if (
        effTarget === 'pet' &&
        productsAfterPolicy.length === 0 &&
        creatorId &&
        process.env.DATABASE_URL &&
        upstreamTotal > 0
      ) {
        try {
          const fallbackQuery = buildPetFallbackQuery(effectiveIntent, rawUserQuery);
          const search = effectivePayload.search || effectivePayload || {};
          const page = search.page || 1;
          const limit = search.limit || search.page_size || 20;
          const inStockOnly = search.in_stock_only !== false;
          const fromCache = await searchCreatorSellableFromCache(creatorId, fallbackQuery, page, limit, {
            intent: effectiveIntent,
            inStockOnly,
          });

          if (fromCache.products && fromCache.products.length > 0) {
            const fallbackData = {
              products: fromCache.products,
              total: fromCache.total,
              page: fromCache.page,
              page_size: fromCache.page_size,
              reply: null,
              metadata: {
                query_source: 'cache_creator_pet_fallback',
                fetched_at: new Date().toISOString(),
                merchants_searched: fromCache.merchantIds.length,
                ...(fromCache.retrieval_sources ? { retrieval_sources: fromCache.retrieval_sources } : {}),
                ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
                ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
              },
            };

            maybePolicy = applyFindProductsMultiPolicy({
              response: fallbackData,
              intent: effectiveIntent,
              requestPayload: {
                ...effectivePayload,
                search: {
                  ...(effectivePayload.search || {}),
                  query: fallbackQuery,
                },
              },
              metadata: policyMetadata,
              rawUserQuery: fallbackQuery,
            });
          }
        } catch (err) {
          logger.warn(
            { err: err.message, creatorId, source: metadata?.source },
            'Pet apparel fallback from creator cache failed',
          );
        }
      }
    }

    if (operation === 'find_products_multi') {
      try {
        const search = effectivePayload.search || effectivePayload || {};
        const limit = Math.min(Math.max(1, Number(search.limit || search.page_size || 20) || 20), 100);
        const reranked = await maybeRerankFindProductsMultiResponse({
          response: maybePolicy,
          userQuery: rawUserQuery,
          limit,
        });
        if (reranked?.applied) {
          maybePolicy = reranked.response;
          if (ROUTE_DEBUG_ENABLED) {
            maybePolicy = {
              ...maybePolicy,
              metadata: {
                ...(maybePolicy.metadata && typeof maybePolicy.metadata === 'object' ? maybePolicy.metadata : {}),
                route_debug: {
                  ...((maybePolicy.metadata && maybePolicy.metadata.route_debug) || {}),
                  llm_rerank: {
                    applied: true,
                    provider: reranked.provider || null,
                    items_count: reranked.items_count || null,
                    duration_ms: reranked.duration_ms || null,
                  },
                },
              },
            };
          }
        }
      } catch (err) {
        logger.warn({ err: err?.message || String(err) }, 'find_products_multi llm rerank failed; keeping ordering');
      }
    }

    let enriched = applyDealsToResponse(maybePolicy, promotions, now, creatorId);

    if (operation === 'find_products' || operation === 'find_products_multi') {
      const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
      const existingMeta =
        enriched && typeof enriched === 'object' && !Array.isArray(enriched) && enriched.metadata
          ? enriched.metadata
          : {};
      const fallbackMeta =
        existingMeta &&
        typeof existingMeta === 'object' &&
        !Array.isArray(existingMeta) &&
        existingMeta.proxy_search_fallback &&
        typeof existingMeta.proxy_search_fallback === 'object' &&
        !Array.isArray(existingMeta.proxy_search_fallback)
          ? existingMeta.proxy_search_fallback
          : null;
      const products = Array.isArray(enriched?.products) ? enriched.products : [];
      const clarificationPayload =
        enriched &&
        typeof enriched === 'object' &&
        !Array.isArray(enriched) &&
        enriched.clarification &&
        typeof enriched.clarification === 'object'
          ? enriched.clarification
          : null;
      const hasClarification = Boolean(clarificationPayload?.question);
      const searchDecision =
        existingMeta &&
        typeof existingMeta === 'object' &&
        !Array.isArray(existingMeta) &&
        existingMeta.search_decision &&
        typeof existingMeta.search_decision === 'object'
          ? existingMeta.search_decision
          : null;
      const isStrictEmpty =
        SEARCH_STRICT_EMPTY_ENABLED &&
        queryText.length > 0 &&
        products.length === 0 &&
        !hasClarification;
      const querySource = String(existingMeta?.query_source || '').trim() || 'agent_products_search';
      const primaryPathUsed =
        querySource.startsWith('cache_')
          ? 'cache_stage'
          : querySource.includes('resolver')
          ? 'resolver_stage'
          : 'upstream_stage';
      const fallbackTriggered =
        Boolean(fallbackMeta?.applied) ||
        querySource === 'agent_products_error_fallback' ||
        (isStrictEmpty && Boolean(fallbackMeta?.reason));
      const fallbackReason =
        (fallbackMeta && typeof fallbackMeta.reason === 'string' && fallbackMeta.reason.trim()) ||
        (querySource === 'agent_products_error_fallback' ? 'error_soft_fallback' : null);
      const cacheStage = crossMerchantCacheRouteDebug
        ? {
            hit: Boolean(crossMerchantCacheRouteDebug.cache_hit),
            candidate_count: Number(crossMerchantCacheRouteDebug.products_count || 0),
            relevant_count: Number(
              crossMerchantCacheRouteDebug.internal_products_relevant_count ??
                crossMerchantCacheRouteDebug.products_count ??
                0,
            ),
            retrieval_sources: crossMerchantCacheRouteDebug.retrieval_sources || [],
          }
        : {
            hit: false,
            candidate_count: 0,
            relevant_count: 0,
            retrieval_sources: [],
          };
      const resolverStage = {
        called: Boolean(shouldAttemptResolverFirst),
        hit: Boolean(resolverFirstResult && Number(resolverFirstResult.usableCount || 0) > 0),
        miss: Boolean(shouldAttemptResolverFirst && (!resolverFirstResult || Number(resolverFirstResult.usableCount || 0) <= 0)),
        latency_ms: Number(resolverFirstResult?.resolve_latency_ms || resolverFirstResult?.data?.metadata?.resolve_latency_ms || 0) || null,
      };
      const upstreamStage = {
        called: !(querySource.startsWith('cache_') && products.length > 0),
        timeout:
          String(existingMeta?.upstream_error_code || '').toUpperCase() === 'ECONNABORTED' ||
          String(existingMeta?.proxy_search_fallback?.upstream_error_code || '').toUpperCase() === 'ECONNABORTED',
        status: Number(existingMeta?.upstream_status || response?.status || 0) || Number(response?.status || 0) || null,
        latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
      };
      const finalDecision = isStrictEmpty
        ? 'strict_empty'
        : hasClarification
          ? 'clarify'
          : searchDecision?.final_decision
            ? String(searchDecision.final_decision)
            : querySource.startsWith('cache_')
              ? 'cache_returned'
              : querySource.includes('resolver')
                ? 'resolver_returned'
                : 'upstream_returned';
      const expansionMode =
        operation === 'find_products_multi'
          ? findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE
          : 'off';
      const expandedQuery =
        operation === 'find_products_multi'
          ? findProductsExpansionMeta?.expanded_query || queryText
          : queryText;
      const policyRouteDebug =
        existingMeta?.route_debug && typeof existingMeta.route_debug === 'object'
          ? existingMeta.route_debug.policy
          : null;
      const relevanceDebug =
        operation === 'find_products_multi' && SEARCH_RELEVANCE_DEBUG_ENABLED
          ? buildSearchRelevanceDebug({
              intent: effectiveIntent,
              products,
              diversityPenaltyApplied: Boolean(policyRouteDebug?.diversity?.penalty_applied),
            })
          : null;
      const routeDegradeFlags =
        searchDecision?.degrade_flags && typeof searchDecision.degrade_flags === 'object'
          ? searchDecision.degrade_flags
          : { vector_skipped: false, behavior_skipped: false, nlu_degraded: false };

      enriched = withSearchDiagnostics(enriched, {
        route_health: buildSearchRouteHealth({
          primaryPathUsed,
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered,
          fallbackReason,
          ambiguityScorePre:
            Number.isFinite(Number(searchDecision?.ambiguity_score_pre))
              ? Number(searchDecision.ambiguity_score_pre)
              : traceAmbiguityScorePre,
          ambiguityScorePost: searchDecision?.ambiguity_score_post,
          clarifyTriggered: hasClarification || Boolean(searchDecision?.clarify_triggered),
          degradeFlags: routeDegradeFlags,
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: queryText,
          expandedQuery,
          expansionMode,
          queryClass: searchDecision?.query_class || traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          intent: effectiveIntent,
          cacheStage,
          upstreamStage,
          resolverStage,
          finalDecision,
        }),
        ...(relevanceDebug ? { relevance_debug: relevanceDebug } : {}),
        ...(isStrictEmpty
          ? {
              strict_empty: true,
              strict_empty_reason: fallbackReason || 'no_candidates',
            }
          : {}),
      });
    }

    return res.status(response.status).json(enriched);

	  } catch (err) {
	    if (operation === 'find_products' || operation === 'find_products_multi') {
      if (
        operation === 'find_products_multi' &&
        crossMerchantCacheProtectedResponse &&
        Array.isArray(crossMerchantCacheProtectedResponse.products) &&
        crossMerchantCacheProtectedResponse.products.length > 0
      ) {
        const cacheGuardBody = normalizeAgentProductsListResponse(crossMerchantCacheProtectedResponse, {
          limit: queryParams?.limit,
          offset: queryParams?.offset,
        });
        const cacheGuardDiagnosed = withSearchDiagnostics(
          withProxySearchFallbackMetadata(cacheGuardBody, {
            applied: false,
            reason: 'invoke_outer_cache_guard',
            route: 'invoke_outer_catch_cache_guard',
          }),
          {
            route_health: buildSearchRouteHealth({
              primaryPathUsed: 'invoke_outer_cache_guard',
              primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
              fallbackTriggered: true,
              fallbackReason: 'invoke_outer_cache_guard',
              ambiguityScorePre: traceAmbiguityScorePre,
              clarifyTriggered: false,
            }),
            search_trace: buildSearchTrace({
              traceId: gatewayRequestId,
              rawQuery: String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim(),
              expandedQuery:
                findProductsExpansionMeta?.expanded_query ||
                String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim(),
              expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
              queryClass: traceQueryClass,
              rewriteGate: traceRewriteGate,
              associationPlan: traceAssociationPlan,
              intent: effectiveIntent,
              cacheStage: {
                hit: true,
                candidate_count: Number(crossMerchantCacheProtectedResponse.products.length || 0),
                relevant_count: Number(crossMerchantCacheProtectedResponse.products.length || 0),
                retrieval_sources: [],
              },
              upstreamStage: {
                called: true,
                timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
                status: Number(err?.response?.status || err?.status || 0) || null,
                latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
              },
              resolverStage: {
                called: false,
                hit: false,
                miss: false,
                latency_ms: null,
              },
              finalDecision: 'cache_returned',
            }),
          },
        );
        return res.status(200).json(cacheGuardDiagnosed);
      }
	      const { code, message } = extractUpstreamErrorCode(err);
	      const upstreamStatus =
	        err?.response?.status || err?.status || (err?.code === 'ECONNABORTED' ? 504 : 502);
	      logger.warn(
	        {
	          gateway_request_id: gatewayRequestId,
	          operation,
	          upstream_status: upstreamStatus,
	          upstream_code: code || err?.code || null,
	          upstream_message: message || err?.message || null,
	        },
	        'search operation failed in invoke outer catch; returning soft fallback',
	      );
	      const reason = err?.code === 'ECONNABORTED' ? 'invoke_outer_timeout' : 'invoke_outer_exception';
	      const strictEmpty = withStrictEmptyFallback({
	        body: null,
	        queryParams,
	        reason,
	        upstreamStatus,
	        upstreamCode: code || err?.code || null,
	        upstreamMessage: message || err?.message || null,
	        route: 'invoke_outer_catch',
	      });
	      const diagnosed = withSearchDiagnostics(strictEmpty, {
	        route_health: buildSearchRouteHealth({
	          primaryPathUsed: 'invoke_outer_catch',
	          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
	          fallbackTriggered: true,
	          fallbackReason: reason,
	          ambiguityScorePre: traceAmbiguityScorePre,
	          clarifyTriggered: false,
	        }),
	        search_trace: buildSearchTrace({
	          traceId: gatewayRequestId,
	          rawQuery: String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim(),
	          expandedQuery:
	            findProductsExpansionMeta?.expanded_query ||
	            String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim(),
	          expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
	          queryClass: traceQueryClass,
	          rewriteGate: traceRewriteGate,
	          associationPlan: traceAssociationPlan,
	          intent: effectiveIntent,
	          cacheStage: {
	            hit: false,
	            candidate_count: 0,
	            relevant_count: 0,
	            retrieval_sources: [],
	          },
	          upstreamStage: {
	            called: true,
	            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
	            status: Number(upstreamStatus || 0) || null,
	            latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
	          },
	          resolverStage: {
	            called: false,
	            hit: false,
	            miss: false,
	            latency_ms: null,
	          },
	          finalDecision: 'strict_empty',
	        }),
	        strict_empty: true,
	        strict_empty_reason: reason,
	      });
	      return res.status(200).json(diagnosed);
	    }
	    if (err.response) {
	      const upstreamStatus = err.response.status || 502;
	      const upstreamRequestId =
	        err.response.headers?.['x-request-id'] ||
	        err.response.headers?.['x-requestid'] ||
	        err.response.headers?.['x-railway-request-id'] ||
	        null;

	      if (upstreamRequestId) {
	        res.setHeader('X-Upstream-Request-Id', upstreamRequestId);
	      }

	      // Do not log full upstream response bodies: they may contain PII.
	      logger.warn(
	        {
	          gateway_request_id: gatewayRequestId,
	          operation,
	          upstream_status: upstreamStatus,
	          upstream_url: err.config?.url || url,
	          upstream_request_id: upstreamRequestId,
	        },
	        'Upstream error',
	      );

	      const data = err.response.data;
	      if (typeof data === 'string') {
	        return res.status(upstreamStatus).json({
	          error: 'UPSTREAM_ERROR',
	          upstream_status: upstreamStatus,
	          upstream_request_id: upstreamRequestId,
	          detail: data,
	        });
	      }

	      return res.status(upstreamStatus).json(data || { error: 'UPSTREAM_ERROR' });
	    }

    if (err.code === 'ECONNABORTED') {
      logger.error(
        {
          operation,
          url: err.config?.url || url,
          timeout_ms: err.config?.timeout,
        },
        'Upstream timeout',
      );
      return res.status(504).json({
        error: 'UPSTREAM_TIMEOUT',
        operation,
        upstream_url: err.config?.url || url,
        timeout_ms: err.config?.timeout || null,
      });
	    }

		    const transportCode = err && err.code ? String(err.code) : null;
		    const transportMessage = err && err.message ? String(err.message) : null;
		    logger.error(
		      { err: transportMessage, code: transportCode, upstream_url: err.config?.url || url },
		      'Unexpected upstream error'
		    );
		    return res.status(502).json({
		      error: 'UPSTREAM_UNAVAILABLE',
		      upstream_url: err.config?.url || url,
		      transport_code: transportCode,
		      transport_message: transportMessage,
		    });
		  }
  } catch (err) {
    if (res.headersSent) {
      logger.error(
        { gateway_request_id: gatewayRequestId, err: err.message, stack: err.stack },
        'Unhandled invoke error after headers sent',
      );
      return;
    }
    logger.error({ gateway_request_id: gatewayRequestId, err: err.message, stack: err.stack }, 'Unhandled invoke error');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      gateway_request_id: gatewayRequestId,
    });
  }
});

// Global error handler - prevent crashes and avoid double sends
app.use((err, req, res, next) => {
  if (err.message === 'Invalid JSON') {
    if (res.headersSent) return next(err);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (res.headersSent) {
    return next(err);
  }

  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    service: 'pivota-agent-gateway'
  });
});

// Unified recommendation endpoint (creator/shopping chatbox)
app.post('/recommend', async (req, res) => {
  return recommendHandler(req, res);
});

async function runPdpCorePrewarmPass() {
  if (!PDP_CORE_PREWARM_TARGETS.length) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const invokeUrl =
    PDP_CORE_PREWARM_GATEWAY_URL ||
    `http://127.0.0.1:${PORT}/agent/shop/v1/invoke`;

  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const target of PDP_CORE_PREWARM_TARGETS) {
    const merchantId = String(target?.merchant_id || '').trim();
    const productId = String(target?.product_id || '').trim();
    if (!merchantId || !productId) continue;

    const reqBody = {
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: merchantId,
          product_id: productId,
        },
        include: ['offers'],
        options: {
          debug: false,
        },
      },
      metadata: {
        source: 'pdp_core_prewarm',
      },
    };

    const reqStartedAt = Date.now();
    try {
      const resp = await axios.post(invokeUrl, reqBody, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: PDP_CORE_PREWARM_TIMEOUT_MS,
      });
      succeeded += 1;
      logger.info(
        {
          product_id: productId,
          merchant_id: merchantId,
          status: resp.status,
          latency_ms: Math.max(0, Date.now() - reqStartedAt),
          request_id: resp?.data?.request_id || null,
        },
        'PDP core prewarm request complete',
      );
    } catch (err) {
      failed += 1;
      const status = err?.response?.status || null;
      logger.warn(
        {
          product_id: productId,
          merchant_id: merchantId,
          status,
          latency_ms: Math.max(0, Date.now() - reqStartedAt),
          err: err?.message || String(err),
        },
        'PDP core prewarm request failed',
      );
    }
  }

  const attempted = succeeded + failed;
  logger.info(
    {
      attempted,
      succeeded,
      failed,
      duration_ms: Math.max(0, Date.now() - startedAt),
      timeout_ms: PDP_CORE_PREWARM_TIMEOUT_MS,
      interval_ms: PDP_CORE_PREWARM_INTERVAL_MS,
    },
    'PDP core prewarm pass summary',
  );

  return { attempted, succeeded, failed };
}

module.exports = app;
module.exports._debug = {
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
  searchCrossMerchantFromCache,
  resolveCatalogSyncMerchantIds,
  runCreatorCatalogAutoSync,
  isCatalogSyncRetryableError,
  catalogSyncState,
};

if (require.main === module) {
  (async () => {
    const hasDb = Boolean(process.env.DATABASE_URL);
    const autoMigrateDisabled = String(process.env.DB_AUTO_MIGRATE || '').toLowerCase() === 'false';
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    const shouldAutoMigrate = hasDb && !autoMigrateDisabled && env !== 'test';

    if (shouldAutoMigrate) {
      logger.info('Running DB migrations (auto)');
      await runMigrations();
      logger.info('DB migrations complete');
    }

    const server = app.listen(PORT, () => {
      logger.info(
        { port: PORT, use_mock: USE_MOCK, mode: API_MODE },
        `Pivota Agent gateway listening on http://localhost:${PORT}, proxying to ${PIVOTA_API_BASE}`,
      );

      const autoSyncIntervalConfig = getCreatorCatalogAutoSyncIntervalConfig();
      const intervalMin = autoSyncIntervalConfig.intervalMinutes;
      const initialDelayMs = Math.max(
        Number(process.env.CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS || 15000) || 15000,
        0,
      );
      if (CREATOR_CATALOG_AUTO_SYNC_ENABLED) {
        if (autoSyncIntervalConfig.clamped) {
          logger.warn(
            {
              configured_interval_minutes: autoSyncIntervalConfig.configuredMinutes,
              effective_interval_minutes: autoSyncIntervalConfig.intervalMinutes,
              max_allowed_interval_minutes: autoSyncIntervalConfig.maxIntervalMinutes,
              cache_ttl_seconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
            },
            'CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES exceeds ttl guardrail; clamping to safe interval',
          );
        }
        setTimeout(() => {
          runCreatorCatalogAutoSync();
          setInterval(runCreatorCatalogAutoSync, intervalMin * 60 * 1000);
        }, initialDelayMs);
      }

      if (PDP_CORE_PREWARM_ENABLED) {
        if (!PDP_CORE_PREWARM_TARGETS.length) {
          logger.warn(
            { env: 'PDP_CORE_PREWARM_TARGETS', enabled: true },
            'PDP core prewarm is enabled but no targets were configured',
          );
        } else {
          setTimeout(() => {
            runPdpCorePrewarmPass().catch((err) => {
              logger.warn({ err: err?.message || String(err) }, 'PDP core prewarm pass failed');
            });
            setInterval(() => {
              runPdpCorePrewarmPass().catch((err) => {
                logger.warn({ err: err?.message || String(err) }, 'PDP core prewarm pass failed');
              });
            }, PDP_CORE_PREWARM_INTERVAL_MS);
          }, PDP_CORE_PREWARM_INITIAL_DELAY_MS);
        }
      }
    });

    server.on('error', (err) => {
      logger.error({ err: err?.message || String(err), port: PORT }, 'Gateway failed to bind');
    });
  })().catch((err) => {
    logger.error({ err: err?.message || String(err) }, 'Startup failed');
    process.exit(1);
  });
}

function deriveTaskBaseFromGatewayUrl(gatewayUrl) {
  // Expect URLs like: http://host/agent/shop/v1/invoke
  return gatewayUrl.replace(/\/invoke\/?$/, '');
}

async function pollCreatorTaskUntilComplete(taskId, baseUrl) {
  const statusUrl = `${baseUrl}/creator/tasks/${taskId}`;
  for (let attempt = 0; attempt < MAX_TASK_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
    const res = await axios.get(statusUrl, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const body = res.data || {};
    const status = body.status;
    if (status === 'succeeded' && body.result) {
      return body.result;
    }
    if (['failed', 'cancelled', 'timeout', 'expired'].includes(status)) {
      const errMsg = body.error || `Creator task ended with status=${status}`;
      throw new Error(errMsg);
    }
  }
  throw new Error('Creator task did not complete within polling budget');
}

async function callPivotaToolViaGateway(args) {
  const res = await axios.post(UI_GATEWAY_URL, args, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  const data = res.data;

  // Handle async/pending responses from the Python gateway when enabled.
  if (data && data.status === 'pending' && data.task_id) {
    const base = deriveTaskBaseFromGatewayUrl(UI_GATEWAY_URL);
    logger.info({ taskId: data.task_id, base }, 'Received pending tool result, polling creator task status');
    return pollCreatorTaskUntilComplete(data.task_id, base);
  }

  return data;
}

async function runAgentWithTools(messages) {
  // messages already contain system message
  const openai = getOpenAIClient();
  const startTs = Date.now();
  let steps = 0;
  let totalToolCalls = 0;
  const recentToolCalls = [];

  function withinRuntimeBudget() {
    if (!MAX_TOTAL_RUNTIME_MS || MAX_TOTAL_RUNTIME_MS <= 0) return true;
    return Date.now() - startTs < MAX_TOTAL_RUNTIME_MS;
  }

  function clampContext() {
    if (!MAX_CONTEXT_MESSAGES || MAX_CONTEXT_MESSAGES <= 0) return;
    if (!Array.isArray(messages)) return;
    if (messages.length <= MAX_CONTEXT_MESSAGES) return;

    // Keep system message(s) and the most recent messages.
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const keepNonSystem = nonSystem.slice(-Math.max(MAX_CONTEXT_MESSAGES - systemMessages.length, 0));
    messages.length = 0;
    messages.push(...systemMessages, ...keepNonSystem);
  }

  function budgetExceededMessage(reason) {
    return {
      role: 'assistant',
      content:
        reason === 'runtime'
          ? 'I used up my safety time budget trying to complete this request. Please try again with a shorter or more specific question.'
          : 'I hit an internal safety limit while trying to complete this request. Please rephrase or narrow down what you need.',
    };
  }

  while (true) {
    if (!withinRuntimeBudget()) {
      logger.warn({ steps, totalToolCalls }, 'Agent runtime budget exceeded');
      return budgetExceededMessage('runtime');
    }
    if (MAX_AGENT_STEPS_PER_TURN > 0 && steps >= MAX_AGENT_STEPS_PER_TURN) {
      logger.warn({ steps, totalToolCalls }, 'Agent step budget exceeded');
      return budgetExceededMessage('steps');
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages,
      tools: [
        {
          type: 'function',
          function: toolSchema,
        },
      ],
      tool_choice: 'auto',
    });

    const msg = completion.choices[0].message;
    steps += 1;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      if (MAX_TOOL_CALLS_PER_TURN > 0 && totalToolCalls + msg.tool_calls.length > MAX_TOOL_CALLS_PER_TURN) {
        logger.warn(
          { totalToolCalls, requestedCalls: msg.tool_calls.length },
          'Tool call budget exceeded in this turn'
        );
        return budgetExceededMessage('tools');
      }

      for (const toolCall of msg.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const { name, arguments: argStr } = toolCall.function;
        if (name !== 'pivota_shopping_tool') continue;

        let args;
        try {
          args = JSON.parse(argStr || '{}');
        } catch (e) {
          logger.error({ err: e, argStr }, 'Failed to parse tool args');
          throw e;
        }

        logger.info({ tool: name, args }, 'Calling Pivota tool via gateway');

         // Loop detection: same tool + args repeated too many times.
         const toolKey = JSON.stringify({ name, args });
         recentToolCalls.push(toolKey);
         if (recentToolCalls.length > 16) {
           recentToolCalls.shift();
         }
         const duplicates = recentToolCalls.filter((k) => k === toolKey).length;
         if (MAX_TOOL_LOOP_DUPLICATES > 0 && duplicates >= MAX_TOOL_LOOP_DUPLICATES) {
           logger.warn(
             { name, duplicates },
             'Detected potential tool loop (same tool+args repeated)'
           );
           return {
             role: 'assistant',
             content:
               'I seem to be calling the same shopping operation repeatedly without making progress. ' +
               'Please adjust your request or try a different query.',
           };
         }

        const toolResult = await callPivotaToolViaGateway(args);

        messages.push(msg);
        let content = JSON.stringify(toolResult);
        if (MAX_TOOL_CONTENT_CHARS > 0 && content.length > MAX_TOOL_CONTENT_CHARS) {
          content = content.slice(0, MAX_TOOL_CONTENT_CHARS) + '… [truncated]';
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content,
        });
        totalToolCalls += 1;
        clampContext();
      }
      continue;
    }

    // Detect repeated identical clarification messages.
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && lastAssistant.content && lastAssistant.content === msg.content) {
      logger.warn('Detected repeated identical assistant clarification message');
      return {
        role: 'assistant',
        content:
          'I just repeated myself trying to clarify your request and am not making progress. ' +
          'Please rephrase or provide different details so I can help.',
      };
    }

    return msg;
  }
}

app.post('/ui/chat', async (req, res) => {
  try {
    const clientMessages = req.body.messages;

    if (!Array.isArray(clientMessages)) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Body must have a messages array',
      });
    }

    const defaultPromptPath = path.join(__dirname, '..', 'prompts', 'shopping_agent_system_prompt_v1_5.txt');
    const promptPath = process.env.PIVOTA_UI_CHAT_SYSTEM_PROMPT_PATH || defaultPromptPath;

    let systemPrompt;
    try {
      systemPrompt = fs.readFileSync(promptPath, 'utf8');
    } catch (err) {
      logger.warn({ err, promptPath }, 'Failed to load system prompt file; using fallback prompt');
      systemPrompt = `
You are the Pivota Shopping Agent.

Core rules:
- Use the \`pivota_shopping_tool\` for any shopping, ordering, payment, order-status, or after-sales task. Do not fabricate product/pricing/order/payment/tracking details.
- Maintain the user’s primary goal across turns; treat follow-ups as refinements unless the user explicitly changes goals.
- If the user message looks like meta instructions or a copied template, do not switch tasks silently: restate the current goal in 1 sentence and ask whether to switch goals or continue refining.
- If the user replies with a tier label (e.g. "A/B/C", "beginner/complete/advanced") or a short constraint, treat it as selecting/refining within the current goal.
- Ask at most 1–2 clarifying questions when needed, then proceed.
- Respond in the same language as the user’s most recent message; if mixed and unclear, ask which language to use.
- Use exactly one language per response; do not mix languages within a single answer.
`.trim();
    }

    const today = new Date().toISOString().slice(0, 10);
    systemPrompt = String(systemPrompt || '').replace(/now=\\d{4}-\\d{2}-\\d{2}/g, `now=${today}`).trim();

    const messages = [
      { role: 'system', content: systemPrompt },
      ...clientMessages,
    ];

    const assistantMsg = await runAgentWithTools(messages);

    res.json({
      assistantMessage: assistantMsg,
    });
  } catch (err) {
    logger.error({ err }, 'Error in /ui/chat');
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to run agent',
    });
  }
});
