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
const { randomUUID } = require('crypto');
const { InvokeRequestSchema, OperationEnum } = require('./schema');
const logger = require('./logger');
const { searchProducts, getProductById } = require('./mockProducts');
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

const PORT = process.env.PORT || 3000;
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';
const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
const UI_GATEWAY_URL = (process.env.PIVOTA_GATEWAY_URL || 'http://localhost:3000/agent/shop/v1/invoke').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

// API Mode: MOCK (default), HYBRID, or REAL
// MOCK: Use internal mock data
// HYBRID: Real product search, mock payment
// REAL: All real API calls (requires API key)
// If API_MODE is not explicitly provided but an API key is configured,
// default to REAL so tests and production behave sensibly.
const API_MODE = process.env.API_MODE || (PIVOTA_API_KEY ? 'REAL' : 'MOCK');
const USE_MOCK = API_MODE === 'MOCK';
const USE_HYBRID = API_MODE === 'HYBRID';
const REAL_API_ENABLED = API_MODE === 'REAL' && PIVOTA_API_KEY;

// Load tool schema once for chat endpoint.
const toolSchemaPath = path.join(__dirname, '..', 'docs', 'tool-schema.json');
const toolSchema = JSON.parse(fs.readFileSync(toolSchemaPath, 'utf-8'));

// Routing map for real Pivota API endpoints
const ROUTE_MAP = {
  find_products: {
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query'
  },
  find_similar_products: {
    // Delegate to Python shopping gateway for multi-merchant similarity.
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body'
  },
  // Cross-merchant product search via backend shopping gateway
  find_products_multi: {
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body'
  },
  get_product_detail: {
    // Route via the shopping gateway so that product detail uses the same
    // cache + live fallback logic as find_products_multi.
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body'
  },
  create_order: {
    method: 'POST',
    path: '/agent/v1/orders/create',
    paramType: 'body'
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
  try {
    return await axios(axiosConfig);
  } catch (err) {
    const retryableOps = ['find_products', 'find_products_multi', 'find_similar_products'];
    if (err.code === 'ECONNABORTED' && retryableOps.includes(operation)) {
      logger.warn(
        { url: axiosConfig.url, operation },
        'Upstream timeout, retrying once'
      );
      // One quick retry with the same config; if this also times out,
      // the error will be handled by the outer catch as usual.
      return await axios(axiosConfig);
    }
    throw err;
  }
}

const app = express();

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

function normalizeMetadata(rawMetadata = {}, payload = {}) {
  const creatorId =
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

  const source = rawMetadata.source || payload.source || 'creator-agent-ui';

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

// CORS configuration - allow UI to call Gateway
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
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
  res.json({ 
    ok: true,
    api_mode: API_MODE,
    modes: {
      mock: USE_MOCK,
      hybrid: USE_HYBRID,
      real_api_enabled: REAL_API_ENABLED
    },
    backend: {
      api_base: PIVOTA_API_BASE,
      api_key_configured: !!PIVOTA_API_KEY
    },
    products_available: true,
    features: {
      product_search: true,
      order_creation: true,
      payment: USE_MOCK || USE_HYBRID ? 'mock' : 'real',
      tracking: true
    },
    message: `Running in ${API_MODE} mode. ${USE_MOCK ? 'Using internal mock products.' : USE_HYBRID ? 'Real products, mock payment.' : 'Full real API integration.'}`
  });
});

// ---------------- Creator-scoped category APIs ----------------

app.get('/creator/:creatorId/categories', async (req, res) => {
  const creatorId = req.params.creatorId;
  const includeCounts =
    req.query.includeCounts === undefined ? true : req.query.includeCounts !== 'false';
  const dealsOnly = req.query.dealsOnly === 'true';
  const locale = req.query.locale ? String(req.query.locale) : undefined;
  const viewId = req.query.view ? String(req.query.view) : undefined;

  try {
    const tree = await buildCreatorCategoryTree(creatorId, {
      includeCounts,
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
        if (p.allowedCreatorIds?.length && !p.allowedCreatorIds.includes(creatorId)) return false;
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
});

app.get('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
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
});

app.post('/api/merchant/promotions', requireAdmin, async (req, res) => {
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
});

app.patch('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
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
});

app.delete('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
  const ok = await softDeletePromotion(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  return res.json({ ok: true });
});

// ---------------- Main invoke endpoint ----------------

app.post('/agent/shop/v1/invoke', async (req, res) => {
  const parsed = InvokeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ error: parsed.error.format() }, 'Invalid request body');
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      details: parsed.error.format(),
    });
  }

  const { operation, payload } = parsed.data;
  const metadata = normalizeMetadata(req.body.metadata, payload);
  const creatorId = extractCreatorId({ ...payload, metadata });
  const now = new Date();

  // Redundant allowlist check for semantics clarity.
  if (!OperationEnum.options.includes(operation)) {
    return res.status(400).json({
      error: 'UNSUPPORTED_OPERATION',
      operation,
    });
  }

  // Log which mode we're using
  logger.info({ API_MODE, operation }, `API Mode: ${API_MODE}, Operation: ${operation}`);
  
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
  
  if (shouldUseMock) {
    logger.info({ operation, mock: true }, 'Using internal mock data with rich product catalog');
    
    try {
      let mockResponse;
      
      switch (operation) {
        case 'find_products': {
          const search = payload.search || {};
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
          const search = payload.search || {};
          const products = searchProducts(
            search.merchant_id || 'merch_208139f7600dbf42',
            search.query,
            search.price_max,
            search.price_min,
            search.category
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
              merchants_searched: 1
            }
          };
          break;
        }
        
        case 'get_product_detail': {
          const product = getProductById(
            payload.product?.merchant_id || 'merch_208139f7600dbf42',
            payload.product?.product_id
          );
          
          if (product) {
            mockResponse = {
              status: 'success',
              product: product
            };
          } else {
            return res.status(404).json({
              error: 'PRODUCT_NOT_FOUND',
              message: 'Product not found'
            });
          }
          break;
        }
        
        case 'create_order': {
          // Mock order creation
          mockResponse = {
            status: 'success',
            order_id: `ORD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase(),
            total: payload.order?.items?.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0) || 0,
            currency: 'USD',
            status: 'pending'
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
      
      const promotions = await getActivePromotions(now, creatorId);
      const enriched = applyDealsToResponse(mockResponse, promotions, now, creatorId);
      return res.json(enriched);
    } catch (err) {
      logger.error({ err: err.message }, 'Mock handler error');
      return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
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
    // Build URL with path parameters
    let url = `${PIVOTA_API_BASE}${route.path}`;
    let requestBody = {};
    let queryParams = {};

    // Handle different parameter types
    switch (operation) {
      case 'find_products': {
        // Convert body params to query params
        const search = payload.search || {};
        queryParams = {
          ...(search.merchant_id && { merchant_id: search.merchant_id }),
          ...(search.query && { query: search.query }),
          ...(search.price_min && { min_price: search.price_min }),
          ...(search.price_max && { max_price: search.price_max }),
          ...(search.category && { category: search.category }),
          ...(search.page && search.page_size && { offset: (search.page - 1) * search.page_size }),
          ...(search.page_size && { limit: Math.min(search.page_size, 100) }),
          in_stock_only: search.in_stock_only !== false
        };
        break;
      }

      case 'find_products_multi': {
        // Pass through to backend shopping gateway which understands this operation
        requestBody = {
          operation,
          payload,
          metadata,
        };
        break;
      }
      
      case 'find_similar_products': {
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
        // Delegate to backend shopping gateway get_product_detail operation
        if (!payload.product?.merchant_id || !payload.product?.product_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required'
          });
        }
        requestBody = {
          operation,
          payload,
          metadata,
        };
        break;
      }
      
      case 'create_order': {
        // Map to real API requirements
        const order = payload.order || {};
        const items = order.items || [];
        
        // Calculate totals if not provided
        const subtotal = items.reduce((sum, item) => sum + (item.unit_price || item.price || 0) * item.quantity, 0);
        
        // Extract merchant_id from first item (assuming single merchant order)
        const merchant_id = items[0]?.merchant_id;
        if (!merchant_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id is required in items'
          });
        }

        // Optional hint for PSP selection / checkout mode
        const preferredPsp =
          order.preferred_psp || payload.preferred_psp || undefined;
        
        // Build request body with all required fields
        requestBody = {
          merchant_id,
          customer_email: order.customer_email || 'agent@pivota.cc', // Default for agent orders
          items: items.map(item => ({
            merchant_id: item.merchant_id,
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
          shipping_address: {
            name: order.shipping_address?.recipient_name || order.shipping_address?.name,
            address_line1: order.shipping_address?.address_line1,
            address_line2: order.shipping_address?.address_line2 || '',
            city: order.shipping_address?.city,
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
        url = url.replace('{order_id}', payload.status.order_id);
        if (payload.status.reason) {
          requestBody = { reason: payload.status.reason };
        }
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
    const axiosConfig = {
      method: route.method,
      url,
      headers: {
        ...(route.method !== 'GET' && { 'Content-Type': 'application/json' }),
        ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
      },
      // Slightly relaxed timeout to reduce flakiness on heavy searches.
      timeout: 15000,
      ...(Object.keys(queryParams).length > 0 && { params: queryParams }),
      ...(route.method !== 'GET' && Object.keys(requestBody).length > 0 && { data: requestBody })
    };

    const response = await callUpstreamWithOptionalRetry(operation, axiosConfig);
    const upstreamData = response.data;
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

    const enriched = applyDealsToResponse(upstreamData, promotions, now, creatorId);
    return res.status(response.status).json(enriched);

  } catch (err) {
    if (err.response) {
      logger.warn({ status: err.response.status, data: err.response.data }, 'Upstream error');
      return res
        .status(err.response.status || 502)
        .json(err.response.data || { error: 'UPSTREAM_ERROR' });
    }

    if (err.code === 'ECONNABORTED') {
      logger.error({ url: err.config?.url }, 'Upstream timeout');
      return res.status(504).json({ error: 'UPSTREAM_TIMEOUT' });
    }

    logger.error({ err: err.message }, 'Unexpected upstream error');
    return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
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

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Pivota Agent gateway listening on port ${PORT}, proxying to ${PIVOTA_API_BASE}`);
  });
}

async function callPivotaToolViaGateway(args) {
  const res = await axios.post(UI_GATEWAY_URL, args, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res.data;
}

async function runAgentWithTools(messages) {
  // messages already contain system message
  const openai = getOpenAIClient();
  while (true) {
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

    if (msg.tool_calls && msg.tool_calls.length > 0) {
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

        const toolResult = await callPivotaToolViaGateway(args);

        messages.push(msg);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
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

    const systemPrompt = 'You are the Pivota Shopping Agent. Use the `pivota_shopping_tool` for any shopping, ordering, payment, order-status, or after-sales task.';

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
