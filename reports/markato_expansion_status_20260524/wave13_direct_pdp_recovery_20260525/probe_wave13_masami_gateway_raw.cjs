#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const TARGET_IDS = [
  'ext_96a7ecc1003f0f94e5b6805c',
  'ext_a1bb997d38b6823e83f23948',
  'ext_53cf4f0ee46873d280f632db',
  'ext_fe9ef8f2a6343901489fe63e',
];

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function text(value) {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function headers() {
  const apiKey = text(
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

function unwrapPdp(data) {
  const root = asObject(data);
  const candidates = [
    root,
    root.response,
    root.result,
    root.data,
    asObject(root.response).pdp,
    asObject(root.response).data,
    asObject(root.result).pdp,
    asObject(root.result).data,
  ].map(asObject);
  return candidates.find((item) => asArray(item.modules).length > 0) || {};
}

function moduleData(pdp, type) {
  return asObject(asArray(pdp.modules).find((item) => text(item?.type) === type)?.data);
}

async function main() {
  const gatewayUrl = argValue('gateway-url', 'https://pivota-agent-production.up.railway.app/api/gateway');
  const out = argValue('out');
  const rows = [];
  for (const productId of TARGET_IDS) {
    const body = {
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: productId,
        },
        include: [
          'canonical',
          'product_intel',
          'reviews_preview',
          'variant_selector',
          'offers',
          'product_details',
          'product_facts',
          'active_ingredients',
          'ingredients_inci',
          'how_to_use',
          'product_overview',
          'supplemental_details',
          'media_gallery',
          'price_promo',
          'similar',
        ],
        options: {
          debug: true,
          no_cache: true,
          cache_bypass: true,
          similar_cache_bypass: true,
        },
      },
      metadata: {
        scope: { catalog: 'global', region: 'US', language: 'en-US' },
        entry: 'wave13_masami_gateway_raw_probe',
      },
    };
    const response = await axios.post(gatewayUrl, body, {
      headers: headers(),
      timeout: 45000,
      validateStatus: () => true,
    });
    const data = asObject(response.data);
    const pdp = unwrapPdp(data);
    const galleryItems = asArray(moduleData(pdp, 'media_gallery').items);
    rows.push({
      product_id: productId,
      http_status: response.status,
      root_keys: Object.keys(data).sort(),
      root_status: text(data.status),
      root_error: data.error || null,
      response_keys: Object.keys(asObject(data.response)).sort(),
      result_keys: Object.keys(asObject(data.result)).sort(),
      unwrapped_module_types: asArray(pdp.modules).map((item) => text(item.type)).filter(Boolean),
      unwrapped_missing_modules: asArray(pdp.missing).map((item) => text(item.type || item.module || item.id)).filter(Boolean),
      unwrapped_status: text(pdp.status),
      product_image_url: text(asObject(pdp.product).image_url),
      media_gallery_urls: galleryItems
        .map((item) => text(item.url || item.image_url || item.src))
        .filter(Boolean),
      product_intel_status: text(
        asObject(moduleData(pdp, 'product_intel').product_intel_core).quality_state ||
          moduleData(pdp, 'product_intel').quality_state,
      ),
      raw_preview: JSON.stringify(data).slice(0, 1200),
    });
  }
  const report = {
    generated_at: new Date().toISOString(),
    gateway_url: gatewayUrl,
    rows,
  };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
