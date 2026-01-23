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
} = require('./offers/offerIds');
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
const { embedText } = require('./services/embeddings');
const {
  semanticSearchCreatorProductsFromCache,
} = require('./services/productsCacheVectorSearch');
const {
  scoreByTagFacetOverlap,
  scorePairOverlap,
} = require('./services/productTagSignals');
const { mountLookReplicatorRoutes } = require('./lookReplicator');
const { mountOutcomeTelemetryRoutes, mountLookReplicatorEventRoutes } = require('./telemetry');
const { mountLayer1CompatibilityRoutes } = require('./layer1/routes/layer1Compatibility');
const { mountLayer1BundleRoutes } = require('./layer1/routes/layer1BundleValidate');
const { mountExternalOfferRoutes } = require('./layer3/routes/externalOffers');
const { mountRecommendationRoutes } = require('./recommendations/routes');

const PORT = process.env.PORT || 3000;
const SERVICE_STARTED_AT = new Date().toISOString();
const SERVICE_GIT_SHA = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '').trim();
const SERVICE_GIT_BRANCH = String(process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || '').trim();
const SERVICE_NAME = String(process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || 'pivota-agent-gateway').trim();
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';
const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
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

function parseTimeoutMs(envValue, fallbackMs) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

// Upstream request timeouts.
// NOTE: Shopify pricing flows can involve multiple sequential upstream calls; the gateway
// timeout must not be lower than the backend's own HTTP client timeouts.
const UPSTREAM_TIMEOUT_SEARCH_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_SEARCH_MS, 15000);
const UPSTREAM_TIMEOUT_SLOW_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_SLOW_MS, 60000);
const UPSTREAM_TIMEOUT_ADMIN_MS = parseTimeoutMs(process.env.UPSTREAM_TIMEOUT_ADMIN_MS, 15000);

const SLOW_UPSTREAM_OPS = new Set([
  'preview_quote',
  'create_order',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

function getUpstreamTimeoutMs(operation) {
  return SLOW_UPSTREAM_OPS.has(operation) ? UPSTREAM_TIMEOUT_SLOW_MS : UPSTREAM_TIMEOUT_SEARCH_MS;
}

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
    AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

const catalogSyncState = {
  last_run_at: null,
  last_success_at: null,
  last_error: null,
  per_merchant: {},
};

async function runCreatorCatalogAutoSync() {
  const enabled = process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED === 'true';
  if (!enabled) return;
  if (!PIVOTA_API_BASE) return;

  const adminKey = process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY || ADMIN_API_KEY;
  if (!adminKey) {
    logger.warn('CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no admin key is configured');
    return;
  }

  const merchantIds = getCreatorCatalogMerchantIds();
  if (!merchantIds.length) {
    logger.warn('CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no creator merchantIds are configured');
    return;
  }

  const limit = Math.min(
    Number(process.env.CREATOR_CATALOG_AUTO_SYNC_LIMIT || 200) || 200,
    5000,
  );

  catalogSyncState.last_run_at = new Date().toISOString();
  catalogSyncState.last_error = null;

  for (const merchantId of merchantIds) {
    const url = `${PIVOTA_API_BASE}/agent/internal/shopify/products/sync/${encodeURIComponent(
      merchantId,
    )}?limit=${encodeURIComponent(String(limit))}`;
    try {
      const res = await axios.post(url, null, {
        headers: { 'X-ADMIN-KEY': adminKey },
        timeout: 30000,
      });
      catalogSyncState.per_merchant[merchantId] = {
        ok: true,
        last_run_at: new Date().toISOString(),
        summary: res.data && res.data.summary ? res.data.summary : res.data,
      };
      catalogSyncState.last_success_at = new Date().toISOString();
      logger.info({ merchantId, limit }, 'Creator catalog auto sync succeeded');
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const message =
        (data && data.detail && typeof data.detail === 'object' && data.detail.message) ||
        (data && typeof data.detail === 'string' ? data.detail : null) ||
        err.message;
      catalogSyncState.per_merchant[merchantId] = {
        ok: false,
        last_run_at: new Date().toISOString(),
        status: status || null,
        error: message,
      };
      catalogSyncState.last_error = message;
      logger.warn({ merchantId, status, message }, 'Creator catalog auto sync failed');
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
  const timeoutRetryableOps = ['find_products', 'find_products_multi', 'find_similar_products'];
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
        logger.warn({ url: axiosConfig.url, operation }, 'Upstream timeout, retrying once');
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
    timeout: getUpstreamTimeoutMs('get_product_detail'),
    data,
  };
  const resp = await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig);
  return resp?.data?.product || null;
}

async function fetchSimilarProductsFromUpstream(args) {
  const { merchantId, productId, limit, checkoutToken } = args;
  const url = `${PIVOTA_API_BASE}/agent/shop/v1/invoke`;
  const data = {
    operation: 'find_similar_products',
    payload: {
      similar: {
        merchant_id: merchantId,
        product_id: productId,
        limit: limit || 6,
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
    timeout: getUpstreamTimeoutMs('find_similar_products'),
    data,
  };
  const resp = await callUpstreamWithOptionalRetry('find_similar_products', axiosConfig);
  return Array.isArray(resp?.data?.products) ? resp.data.products : [];
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

function isStatusActive(status) {
  const normalized = String(status || 'active').toLowerCase();
  return normalized === 'active';
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
  const s = String(q || '').toLowerCase();
  const raw = s.split(/[^a-z0-9]+/g).filter(Boolean);
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
  ]);

  const kept = [];
  for (const t of raw) {
    if (stop.has(t)) continue;
    if (t.length < 3 && t !== 'xs' && t !== 'xl') continue;
    kept.push(t);
  }

  // Keep unique, preserve order.
  const seen = new Set();
  const uniq = [];
  for (const t of kept) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }

  // Clamp to avoid pathological SQL, but ensure we don't drop "important" tokens
  // that often appear at the end (e.g. appended canonical keywords).
  // Strategy:
  // - If <= 8 tokens: return as-is.
  // - Else: take a balanced slice (first 4 + last 4), preserving order.
  if (uniq.length <= 8) return uniq;
  const first = uniq.slice(0, 4);
  const last = uniq.slice(-4);
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
    AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

  const baseProducts = (rowsRes.rows || [])
    .map((r) => r.product_data)
    .filter(Boolean)
    .filter((p) => isProductSellable(p, { inStockOnly }));

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
    AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

  const vectorEnabled =
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true' &&
    process.env.DATABASE_URL &&
    safePage === 1;

  const intentLang = String(options?.intent?.language || '').toLowerCase();
  const shouldTryVector =
    vectorEnabled &&
    // Try vector recall when lexical is weak or query is likely non-English.
    (lexicalProducts.length < safeLimit ||
      (intentLang && intentLang !== 'en' && intentLang !== 'other'));

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
          AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

function buildPetFallbackQuery(intent, rawUserQuery) {
  const lang = intent?.language || 'en';
  switch (lang) {
    case 'zh':
      return '狗 狗狗 宠物 外套 衣服';
    case 'es':
      return 'perro ropa abrigo chaqueta';
    case 'fr':
      return 'chien vêtement manteau veste';
    case 'ja':
      return '犬 犬服 服';
    default:
      return 'dog jacket dog clothes';
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
  if (!creatorId && source === 'creator-agent-ui') {
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

// CORS configuration - allow UI to call Gateway
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const defaults = [
    'https://look-replicator.pivota.cc',
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

  const isAllowedOrigin = origin && origin !== 'null' && allowedOrigins.has(origin);
  if (isAllowedOrigin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  } else if (origin) {
    // Backwards-compat for non-credentialed requests.
    res.header('Access-Control-Allow-Origin', '*');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // Allow both legacy and newer header names used by clients (Creator UI / SDKs).
  // Also echo requested headers to avoid preflight failures when browsers add new ones.
  const baseAllowedHeaders = ['content-type', 'authorization', 'x-api-key', 'x-agent-api-key', 'x-checkout-token'];
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

app.get('/healthz', (req, res) => {
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
      enabled: process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED === 'true',
      interval_minutes: Number(process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES || 60) || 60,
      last_run_at: catalogSyncState.last_run_at,
      last_success_at: catalogSyncState.last_success_at,
      last_error: catalogSyncState.last_error,
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
        products_available: true,
        warning: 'healthz_cache_stats_failed',
      });
    });
});

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

// ---------------- Layer 3: External offers (external-first) ----------------

mountExternalOfferRoutes(app);

// ---------------- Recommendations: role → feed ----------------

mountRecommendationRoutes(app);

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
    const findProductsMultiCtx =
      operation === 'find_products_multi'
        ? await buildFindProductsMultiContext({ payload, metadata })
        : null;
    const effectivePayload = findProductsMultiCtx?.adjustedPayload || payload;
    const effectiveIntent = findProductsMultiCtx?.intent || null;
    const rawUserQuery = findProductsMultiCtx?.rawUserQuery || payload?.search?.query || '';

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
      metadata,
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
          const search = effectivePayload.search || {};
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
          const search = effectivePayload.search || {};
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
            const relatedProducts = pdpOptions.includeRecommendations
              ? pickSimilarProducts(
                  searchProducts(
                    payload.product?.merchant_id || DEFAULT_MERCHANT_ID,
                    payload.search?.query,
                    undefined,
                    undefined,
                    undefined,
                  ),
                  payload.product?.product_id,
                  payload.recommendations?.limit || 6,
                  [payload.product?.product_id].filter(Boolean),
                )
              : [];

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
          const relatedProducts = pdpOptions.includeRecommendations
            ? pickSimilarProducts(
                searchProducts(
                  payload.product?.merchant_id || DEFAULT_MERCHANT_ID,
                  payload.search?.query,
                  undefined,
                  undefined,
                  undefined,
                ),
                payload.product?.product_id,
                payload.recommendations?.limit || 6,
                [payload.product?.product_id].filter(Boolean),
              )
            : [];

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
          metadata,
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

      const relatedProducts = pdpOptions.includeRecommendations
        ? await fetchSimilarProductsFromUpstream({
            merchantId,
            productId,
            limit: payload.recommendations?.limit || 6,
            checkoutToken,
          })
        : [];

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

	      // Fetch candidates via Agent Search (GET). This is intentionally lightweight:
	      // - no product detail fetches
	      // - no long descriptions/media
      // - small limit
      const searchUrl = `${PIVOTA_API_BASE}/agent/v1/products/search`;
      const configuredMerchantIds = getCreatorCatalogMerchantIds();

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
      const deduped = Array.from(
        new Map(
          matches
            .map((p) => [String(p?.merchant_id || '').trim(), p])
            .filter(([mid]) => Boolean(mid)),
        ).values(),
	      ).slice(0, limit);

	      // Canonical-ish grouping id: prefer platform refs if present; fallback to product_id.
	      const first = deduped[0] || null;
	      const platform = first ? String(first.platform || '').trim() : '';
	      const platformProductId = first ? String(first.platform_product_id || '').trim() : '';
	      const productGroupId =
	        (platform && platformProductId
	          ? buildProductGroupId({ platform, platform_product_id: platformProductId })
	          : buildProductGroupId({ merchant_id: 'pid', product_id: productId })) || `pg:pid:${productId}`;

	      const offers = deduped.map((p) => {
	        const mid = String(p.merchant_id || '').trim();
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
	          merchant_id: mid,
	          merchant_name: p.merchant_name || p.store_name || undefined,
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
      const defaultOfferId = bestPriceOfferId;

	      const result = {
	        status: 'success',
	        product_group_id: productGroupId,
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
    let resolvedOfferId = null;
    let resolvedMerchantId = null;
    // Creator UI cold-start (empty query) should not be constrained by the
    // upstream live merchant recall limits. Prefer reading sellable products
    // from products_cache (same source as creator categories / merchant portal).
    if (operation === 'find_products_multi') {
      const source = metadata?.source;
      const search = effectivePayload.search || {};
      const queryText = String(search.query || '').trim();
      const isCreatorUiColdStart = source === 'creator-agent-ui' && queryText.length === 0;
      const inStockOnly = search.in_stock_only !== false;

      const isCreatorUi = source === 'creator-agent-ui';
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
                  metadata,
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
                      cross_merchant_cache: {
                        attempted: true,
                        mode: 'browse',
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
          logger.warn(
            { err: err.message, source },
            'Cross-merchant cache browse failed; falling back to upstream',
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
        const priceMin = search.price_min ?? search.min_price;
        const priceMax = search.price_max ?? search.max_price;

        queryParams = {
          ...(merchantId ? { merchant_id: merchantId } : {}),
          ...(search.query != null ? { query: String(search.query || '') } : {}),
          ...(search.category ? { category: search.category } : {}),
          ...(priceMin != null ? { min_price: priceMin } : {}),
          ...(priceMax != null ? { max_price: priceMax } : {}),
          in_stock_only: search.in_stock_only !== false,
          limit,
          offset,
        };
        break;
      }

      case 'products.recommendations': {
        const search = effectivePayload.search || {};
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
        const search = effectivePayload.search || {};
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
          metadata?.source === 'creator-agent-ui' &&
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
        break;
      }
      
      case 'find_similar_products': {
        // Creator UI: prefer cache-based similarity so "Find more" stays consistent
        // with the creator pool even when upstream has stale/partial cache.
        const source = metadata?.source;
        const isCreatorUi = source === 'creator-agent-ui';
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
        if (!merchantId || !productId) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required'
          });
        }
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
          items: items.map(item => ({
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
        };
        if (!requestBody.merchant_id || !requestBody.platform_product_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required for track_product_click'
          });
        }
        break;
      }
    }

    logger.info({ operation, method: route.method, url, hasQuery: Object.keys(queryParams).length > 0 }, 'Forwarding invoke request');

    // Make the upstream request
    const queryString = buildQueryString(queryParams);
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
      timeout: getUpstreamTimeoutMs(operation),
      ...(route.method !== 'GET' && Object.keys(requestBody).length > 0 && { data: requestBody })
    };

    let response;
    try {
      response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
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

      if (!response) throw err;
    }
    let upstreamData = response.data;
    if (operation === 'find_products_multi' && ROUTE_DEBUG_ENABLED && creatorCacheRouteDebug) {
      upstreamData = {
        ...upstreamData,
        metadata: {
          ...(upstreamData.metadata || {}),
          route_debug: {
            ...((upstreamData.metadata && upstreamData.metadata.route_debug) || {}),
            creator_cache: creatorCacheRouteDebug,
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

    if (operation === 'get_product_detail') {
      upstreamData = normalizeAgentProductDetailResponse(upstreamData);
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
        const relatedProducts = pdpOptions.includeRecommendations
          ? await fetchSimilarProductsFromUpstream({
              merchantId: product.merchant_id || payload.product?.merchant_id || DEFAULT_MERCHANT_ID,
              productId: product.product_id || payload.product?.product_id,
              limit: payload.recommendations?.limit || 6,
              checkoutToken,
            })
          : [];
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
      maybePolicy = applyFindProductsMultiPolicy({
        response: upstreamData,
        intent: effectiveIntent,
        requestPayload: effectivePayload,
        metadata,
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
          const search = effectivePayload.search || {};
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
              metadata,
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

    const enriched = applyDealsToResponse(maybePolicy, promotions, now, creatorId);
    return res.status(response.status).json(enriched);

	  } catch (err) {
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

module.exports = app;
module.exports._debug = {
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
};

if (require.main === module) {
  (async () => {
    const hasDb = Boolean(process.env.DATABASE_URL);
    const autoMigrateDisabled = String(process.env.DB_AUTO_MIGRATE || '').toLowerCase() === 'false';
    const shouldAutoMigrate = hasDb && !autoMigrateDisabled && process.env.NODE_ENV === 'production';

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

      const intervalMin = Number(process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES || 60) || 60;
      const initialDelayMs = Math.max(
        Number(process.env.CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS || 15000) || 15000,
        0,
      );
      if (process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED === 'true') {
        setTimeout(() => {
          runCreatorCatalogAutoSync();
          setInterval(runCreatorCatalogAutoSync, intervalMin * 60 * 1000);
        }, initialDelayMs);
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
