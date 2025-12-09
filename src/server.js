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
const { InvokeRequestSchema, OperationEnum } = require('./schema');
const logger = require('./logger');
const { searchProducts, getProductById } = require('./mockProducts');
const { getActivePromotions } = require('./promotions');

const PORT = process.env.PORT || 3000;
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';
const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
const UI_GATEWAY_URL = (process.env.PIVOTA_GATEWAY_URL || 'http://localhost:3000/agent/shop/v1/invoke').replace(/\/$/, '');

// API Mode: MOCK (default), HYBRID, or REAL
// MOCK: Use internal mock data
// HYBRID: Real product search, mock payment
// REAL: All real API calls (requires API key)
const API_MODE = process.env.API_MODE || 'MOCK';
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
    // We will internally call find_products; kept here for completeness (unused for direct routing)
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query'
  },
  // Cross-merchant product search via backend shopping gateway
  find_products_multi: {
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body'
  },
  get_product_detail: {
    method: 'GET',
    path: '/agent/v1/products/merchants/{merchant_id}/product/{product_id}',
    paramType: 'path'
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

const app = express();

// ---------------- Promotion / deals enrichment helpers ----------------

function isPromoActive(promo, nowTs) {
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  return nowTs >= start && nowTs <= end;
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

function findApplicablePromotionsForProduct(product, now, promotions) {
  const nowTs = now.getTime();
  return promotions.filter(
    (promo) => isPromoActive(promo, nowTs) && matchesScope(promo, product)
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
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  return base;
}

function enrichProductsWithDeals(products, promotions, now = new Date()) {
  if (!Array.isArray(products) || !products.length) return products;
  return products.map((product) => {
    const applicablePromos = findApplicablePromotionsForProduct(product, now, promotions);
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
function applyDealsToResponse(upstreamData, promotions, now = new Date()) {
  if (!upstreamData || !promotions || !promotions.length) {
    return upstreamData;
  }

  const clone = JSON.parse(JSON.stringify(upstreamData));

  // Flat products
  if (Array.isArray(clone.products)) {
    clone.products = enrichProductsWithDeals(clone.products, promotions, now);
  }

  // groups: [{ products: [...] }]
  if (Array.isArray(clone.groups)) {
    clone.groups = clone.groups.map((g) => {
      if (Array.isArray(g.products)) {
        return { ...g, products: enrichProductsWithDeals(g.products, promotions, now) };
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
        ? enrichProductsWithDeals(arr, promotions, now)
        : arr;
    }
    clone.results = newResults;
  }

  // data.products (nested)
  if (clone.data && Array.isArray(clone.data.products)) {
    clone.data.products = enrichProductsWithDeals(clone.data.products, promotions, now);
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
    candidates = candidates.filter((p) => {
      const price = Number(p.price || p.unit_price || 0);
      return price >= min && price <= max;
    });

    candidates.sort((a, b) => {
      const pa = Math.abs(Number(a.price || a.unit_price || 0) - basePrice);
      const pb = Math.abs(Number(b.price || b.unit_price || 0) - basePrice);
      return pa - pb;
    });
  }

  return candidates.slice(0, limit);
}

// Body parser with error handling
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf);
    } catch(e) {
      res.status(400).json({ error: 'Invalid JSON' });
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

// Global error handler - prevent crashes
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    service: 'pivota-agent-gateway'
  });
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
      
      const promotions = getActivePromotions(new Date());
      const enriched = applyDealsToResponse(mockResponse, promotions);
      return res.json(enriched);
    } catch (err) {
      logger.error({ err: err.message }, 'Mock handler error');
      return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
    }
  }

  // Use real API routing
  // Custom handling for find_similar_products (leverages find_products upstream)
  if (operation === 'find_similar_products') {
    const sim = payload.similar || {};
    const productId =
      sim.product_id ||
      payload.product?.product_id ||
      payload.product_id;
    if (!productId) {
      return res.status(400).json({
        error: 'MISSING_PARAMETERS',
        message: 'product_id is required for find_similar_products',
      });
    }

    const limit = sim.limit || 8;
    const excludeIds = sim.exclude_ids || [productId].filter(Boolean);
    const merchantId =
      sim.merchant_id || payload.product?.merchant_id || payload.search?.merchant_id;
    if (!merchantId) {
      return res.status(400).json({
        error: 'MISSING_PARAMETERS',
        message: 'merchant_id is required for find_similar_products; pass similar.merchant_id',
      });
    }

    const search = {
      merchant_id: merchantId,
      query: sim.query || '',
      page: 1,
      page_size: Math.min(limit * 3, 100),
      in_stock_only: sim.in_stock_only !== false,
    };

    try {
      // Reuse find_products upstream to fetch a candidate pool
      const queryParams = {
        ...(search.merchant_id && { merchant_id: search.merchant_id }),
        ...(search.query && { query: search.query }),
        ...(search.price_min && { min_price: search.price_min }),
        ...(search.price_max && { max_price: search.price_max }),
        ...(search.page && search.page_size && { offset: (search.page - 1) * search.page_size }),
        ...(search.page_size && { limit: Math.min(search.page_size, 100) }),
        in_stock_only: search.in_stock_only !== false
      };

      const axiosConfig = {
        method: 'GET',
        url: `${PIVOTA_API_BASE}/agent/v1/products/search`,
        headers: {
          ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
        },
        timeout: 10000,
        params: queryParams,
      };

      const response = await axios(axiosConfig);
      const upstreamData = response.data || {};
      const candidates = upstreamData.products || [];

      const picked = pickSimilarProducts(candidates, productId, limit, excludeIds);
      const promotions = getActivePromotions(new Date());
      const enriched = enrichProductsWithDeals(picked, promotions);

      return res.status(200).json({
        status: 'success',
        products: enriched,
        total: enriched.length,
        page: 1,
        page_size: enriched.length,
      });
    } catch (err) {
      if (err.response) {
        logger.warn({ status: err.response.status, data: err.response.data }, 'Upstream error in find_similar_products');
        return res
          .status(err.response.status || 502)
          .json(err.response.data || { error: 'UPSTREAM_ERROR' });
      }
      if (err.code === 'ECONNABORTED') {
        logger.error({ url: err.config?.url }, 'Upstream timeout in find_similar_products');
        return res.status(504).json({ error: 'UPSTREAM_TIMEOUT' });
      }
      logger.error({ err: err.message }, 'Unexpected error in find_similar_products');
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
    }
  }

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
        };
        break;
      }
      
      case 'get_product_detail': {
        // Extract path parameters
        if (!payload.product?.merchant_id || !payload.product?.product_id) {
          return res.status(400).json({
            error: 'MISSING_PARAMETERS',
            message: 'merchant_id and product_id are required'
          });
        }
        url = url.replace('{merchant_id}', payload.product.merchant_id);
        url = url.replace('{product_id}', payload.product.product_id);
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
      timeout: 10000,
      ...(Object.keys(queryParams).length > 0 && { params: queryParams }),
      ...(route.method !== 'GET' && Object.keys(requestBody).length > 0 && { data: requestBody })
    };

    const response = await axios(axiosConfig);
    const upstreamData = response.data;
    const promotions = getActivePromotions(new Date());

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

    const enriched = applyDealsToResponse(upstreamData, promotions);
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

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Pivota Agent gateway listening on port ${PORT}, proxying to ${PIVOTA_API_BASE}`);
  });
}

async function callPivotaToolViaGateway(args) {
  const res = await axios.post(UI_GATEWAY_URL, args, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
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
