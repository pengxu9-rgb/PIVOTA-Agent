#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const TARGETS = Object.freeze([
  'ext_1e27467ab07ddb83ad74c213',
  'ext_4e95b920b4c6a5295d55aa46',
  'ext_d17dfc05f98d0400d5129f1c',
  'ext_c0e5209513c083e2c649c1a1',
  'ext_d3d708f481903ba2a6f9b732',
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const target = normalizeNonEmptyString(filePath);
  if (!target) {
    process.stdout.write(body);
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, body, 'utf8');
  process.stdout.write(body);
}

function gatewayUrl() {
  return (
    normalizeNonEmptyString(argValue('gateway-url')) ||
    normalizeNonEmptyString(process.env.PIVOTA_GATEWAY_URL) ||
    'https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke'
  );
}

function headers() {
  const apiKey = normalizeNonEmptyString(
    process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY,
  );
  const out = { 'Content-Type': 'application/json' };
  if (apiKey) {
    out['X-Agent-API-Key'] = apiKey;
    out['X-API-Key'] = apiKey;
    out.Authorization = `Bearer ${apiKey}`;
  }
  return out;
}

function summarizeResponse(data) {
  const products =
    (Array.isArray(data?.products) && data.products) ||
    (Array.isArray(data?.items) && data.items) ||
    (Array.isArray(data?.response?.products) && data.response.products) ||
    (Array.isArray(data?.response?.items) && data.response.items) ||
    (Array.isArray(data?.similar?.products) && data.similar.products) ||
    (Array.isArray(data?.similar?.items) && data.similar.items) ||
    [];
  return {
    keys: data && typeof data === 'object' ? Object.keys(data).sort() : [],
    product_count: products.length,
    metadata: data?.metadata || data?.response?.metadata || data?.similar?.metadata || null,
    products: products.map((item) => ({
      product_id: item.product_id || item.id || item.product?.product_id || item.product?.id || null,
      merchant_id: item.merchant_id || item.merchantId || item.product?.merchant_id || null,
      title: item.title || item.name || item.product?.title || item.product?.name || null,
      brand: item.brand || item.vendor || item.product?.brand || item.product?.vendor || null,
      category: item.category || item.product_type || item.product?.category || item.product?.product_type || null,
      reason: item.reason || item.metadata?.reason || null,
      x_confidence: item.x_confidence || item.confidence || item.metadata?.x_confidence || null,
      card_highlight: item.card_highlight || item.shopping_card?.highlight || item.description || null,
      evidence_profile: item.evidence_profile || item.product_intel?.evidence_profile || null,
    })),
    raw_preview: JSON.stringify(data).slice(0, 4000),
  };
}

async function invokeSimilar(productId) {
  const url = gatewayUrl();
  const payload = {
    operation: 'find_similar_products',
    payload: {
      similar: {
        merchant_id: 'external_seed',
        product_id: productId,
        limit: 6,
      },
      options: {
        debug: true,
        no_cache: true,
        cache_bypass: true,
        similar_cache_bypass: true,
      },
    },
  };
  try {
    const res = await axios.post(url, payload, {
      headers: headers(),
      timeout: Number(argValue('timeout-ms') || 45000),
      validateStatus: () => true,
    });
    return {
      product_id: productId,
      url,
      http_status: res.status,
      ok: res.status >= 200 && res.status < 300,
      summary: summarizeResponse(res.data),
    };
  } catch (error) {
    return {
      product_id: productId,
      url,
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        response_status: error?.response?.status || null,
        response_preview: error?.response?.data ? JSON.stringify(error.response.data).slice(0, 1000) : null,
      },
    };
  }
}

async function main() {
  const results = [];
  for (const productId of TARGETS) {
    results.push(await invokeSimilar(productId));
  }
  writeJson(argValue('out'), {
    generated_at: new Date().toISOString(),
    gateway_url: gatewayUrl(),
    results,
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
