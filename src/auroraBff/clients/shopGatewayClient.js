'use strict';

// Thin, request-independent client for the backend shop gateway's
// `find_products_multi` operation — the SAME catalog lane the agent tool and the
// aurora shared-truth path use, so brand detection (GATEWAY_DYNAMIC_BRAND_DETECT)
// and the retired-merchant recall gate apply automatically. Extracted so a chat
// SKILL can call it without a live `req` (unlike the route-level helper in
// routes.js which is coupled to the request).

const axios = require('axios');

const PIVOTA_BACKEND_BASE_URL = String(process.env.PIVOTA_BACKEND_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const PIVOTA_BACKEND_AGENT_API_KEY = String(process.env.PIVOTA_BACKEND_AGENT_API_KEY || '').trim();
const FIND_PRODUCTS_TIMEOUT_MS = Number(process.env.SHOP_GATEWAY_FIND_PRODUCTS_TIMEOUT_MS || 8000) || 8000;

function buildHeaders() {
  if (!PIVOTA_BACKEND_AGENT_API_KEY) return { 'Content-Type': 'application/json' };
  return {
    'Content-Type': 'application/json',
    'X-API-Key': PIVOTA_BACKEND_AGENT_API_KEY,
    Authorization: `Bearer ${PIVOTA_BACKEND_AGENT_API_KEY}`,
  };
}

function extractProducts(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.products)) return body.products;
  if (body.data && Array.isArray(body.data.products)) return body.data.products;
  return [];
}

/**
 * Call the backend `find_products_multi` operation.
 * Returns { ok, products, metadata, reason }. Never throws — a transport/backend
 * failure resolves to { ok:false, products:[], reason } so the caller can render an
 * honest no-result rather than a crash.
 *
 * @param {object} opts
 * @param {string} opts.query           user query / brand keyword (backend does brand detection)
 * @param {number} [opts.limit=8]
 * @param {boolean} [opts.inStockOnly=false]
 * @param {string} [opts.catalogSurface='beauty']
 * @param {object} [opts.deps]          { axios } injectable for tests
 */
async function findProductsMulti({
  query,
  limit = 8,
  inStockOnly = false,
  catalogSurface = 'beauty',
  deps = {},
} = {}) {
  const http = deps.axios || axios;
  const q = String(query || '').trim();
  if (!q) return { ok: false, products: [], metadata: {}, reason: 'empty_query' };
  if (!PIVOTA_BACKEND_BASE_URL) return { ok: false, products: [], metadata: {}, reason: 'no_backend_base_url' };

  const url = `${PIVOTA_BACKEND_BASE_URL}/agent/shop/v1/invoke`;
  const payload = {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: q,
        limit: Math.max(1, Math.min(Number(limit) || 8, 24)),
        in_stock_only: Boolean(inStockOnly),
        catalog_surface: catalogSurface,
      },
    },
    metadata: {
      source: 'shopping-agent-ui',
      catalog_surface: catalogSurface,
      requested_projection: 'normalized_only',
      invoked_by: 'chat.shop_find_products',
    },
  };

  try {
    const resp = await http.post(url, payload, {
      headers: buildHeaders(),
      timeout: FIND_PRODUCTS_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const body = resp && typeof resp.data === 'object' && resp.data ? resp.data : {};
    if (resp && resp.status === 200) {
      return {
        ok: true,
        products: extractProducts(body),
        metadata: (body && typeof body.metadata === 'object' && body.metadata) || {},
        reason: null,
      };
    }
    return {
      ok: false,
      products: [],
      metadata: (body && typeof body.metadata === 'object' && body.metadata) || {},
      reason: `http_${resp ? resp.status : 'no_response'}`,
    };
  } catch (err) {
    return {
      ok: false,
      products: [],
      metadata: {},
      reason: String((err && err.message) || 'request_failed').slice(0, 200),
    };
  }
}

module.exports = { findProductsMulti };
