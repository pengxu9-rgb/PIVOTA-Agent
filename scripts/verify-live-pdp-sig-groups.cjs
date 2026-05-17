#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');

const DEFAULT_INVOKE_URL = 'https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function firstString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hostFromUrl(value) {
  const text = asString(value);
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_err) {
    return '';
  }
}

function authHeaders() {
  const apiKey = firstString(
    process.env.PIVOTA_BACKEND_AGENT_API_KEY,
    process.env.SHOP_GATEWAY_AGENT_API_KEY,
    process.env.PIVOTA_AGENT_API_KEY,
    process.env.AGENT_API_KEY,
    process.env.PIVOTA_API_KEY,
  );
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Agent-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function moduleByType(root, type) {
  const modules = asArray(root?.modules);
  return modules.find((module) => asString(module?.type) === type) || null;
}

function imageUrlsFrom(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) imageUrlsFrom(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const looksLikeImageUrl =
      typeof child === 'string' &&
      /^https?:\/\//i.test(child) &&
      (/\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(child) ||
        /(?:^|[./-])(image|images|img|media)(?:[./-]|$)/i.test(child) ||
        /media\.ulta\.com\/i\/ulta\//i.test(child));
    if (
      looksLikeImageUrl &&
      (normalizedKey.includes('image') ||
        normalizedKey.includes('photo') ||
        normalizedKey === 'src' ||
        normalizedKey === 'url')
    ) {
      out.push(child);
    } else if (child && typeof child === 'object') {
      imageUrlsFrom(child, out);
    }
  }
  return out;
}

function sellerLabel(item) {
  if (!isObject(item)) return '';
  return firstString(
    item.seller_name,
    item.sellerName,
    item.seller_label,
    item.sellerLabel,
    item.merchant_name,
    item.merchantName,
    item.merchant?.name,
    item.source?.merchant_name,
    item.host,
    item.domain,
    hostFromUrl(item.url || item.destination_url || item.external_url || item.canonical_url || item.buy_url),
    item.merchant_id,
  );
}

function priceFieldSnapshot(item) {
  if (!isObject(item)) return {};
  const keys = [
    'price',
    'current_price',
    'currentPrice',
    'effective_price',
    'effectivePrice',
    'merchant_effective_price',
    'estimated_best_price',
    'list_price',
    'sale_price',
    'compare_at_price',
  ];
  const out = {};
  for (const key of keys) {
    if (item[key] != null) out[key] = item[key];
  }
  return out;
}

function offerPrice(item) {
  if (!isObject(item)) return null;
  const raw =
    item.price?.amount ??
    item.price?.current?.amount ??
    item.current_price ??
    item.currentPrice ??
    item.effective_price ??
    item.effectivePrice ??
    item.merchant_effective_price ??
    item.estimated_best_price ??
    item.list_price ??
    null;
  if (raw == null || raw === '') return null;
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]+/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function summarize(target, httpStatus, json) {
  const root = isObject(json) ? json : {};
  const pdpModule =
    moduleByType(root, 'canonical') || moduleByType(root, 'pdp') || moduleByType(root, 'product') || {};
  const offersModule = moduleByType(root, 'offers') || {};
  const pdpData = isObject(pdpModule.data) ? pdpModule.data : {};
  const offersData = isObject(offersModule.data) ? offersModule.data : {};
  const offers = asArray(offersData.offers);
  const groupMembers = asArray(pdpData.group_members || offersData.group_members);
  const subject = isObject(root.subject) ? root.subject : {};
  const identity = isObject(root.metadata?.identity_resolution) ? root.metadata.identity_resolution : {};
  const images = Array.from(new Set(imageUrlsFrom(pdpData).slice(0, 30)));
  const sellers = Array.from(new Set([...offers, ...groupMembers].map(sellerLabel).filter(Boolean))).sort();
  const prices = offers.map(offerPrice).filter((value) => value != null);
  return {
    id: target.id,
    canonical_sig_id: target.canonical_sig_id,
    expected_product_group_id: target.target_product_group_id,
    public_pdp_url: `https://agent.pivota.cc/products/${target.canonical_sig_id}`,
    http_status: httpStatus,
    ok: httpStatus >= 200 && httpStatus < 300 && !root.error,
    error: root.error || null,
    title: firstString(
      pdpData.title,
      pdpData.product?.title,
      pdpData.pdp_payload?.title,
      pdpData.pdp_payload?.product?.title,
    ) || null,
    subject_type: subject.type || null,
    subject_id: subject.id || null,
    resolved_product_id: identity.resolved_product_id || null,
    resolved_merchant_id: identity.resolved_merchant_id || null,
    canonicalization_applied: identity.canonicalization_applied === true,
    product_group_matched:
      asString(subject.id) === asString(target.target_product_group_id) ||
      asString(subject.id) === asString(target.canonical_sig_id) ||
      asString(pdpData.product_group_id) === asString(target.target_product_group_id) ||
      asString(pdpData.product_group_id) === asString(target.canonical_sig_id) ||
      asString(offersData.product_group_id) === asString(target.target_product_group_id) ||
      asString(offersData.product_group_id) === asString(target.canonical_sig_id),
    group_members_count: groupMembers.length,
    offers_count: offers.length || Number(offersData.offers_count || 0) || 0,
    seller_count: sellers.length,
    sellers,
    min_price: prices.length ? Math.min(...prices) : null,
    module_types: asArray(root.modules).map((module) => asString(module?.type)).filter(Boolean),
    pdp_data_keys: Object.keys(pdpData).slice(0, 30),
    offers_data_keys: Object.keys(offersData).slice(0, 30),
    sample_offers: offers.slice(0, 5).map((offer) => ({
      seller: sellerLabel(offer),
      offer_id: offer?.offer_id || null,
      price_fields: priceFieldSnapshot(offer),
      url_host: hostFromUrl(offer?.buy_url || offer?.url || offer?.destination_url || offer?.external_url),
    })),
    image_count: images.length,
    sample_images: images.slice(0, 3),
  };
}

async function invoke(target, invokeUrl) {
  const response = await fetch(invokeUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          product_id: target.canonical_sig_id,
        },
        include: ['offers', 'product_details', 'product_overview', 'product_facts'],
        options: {
          debug: true,
          no_cache: true,
          cache_bypass: true,
        },
      },
    }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_err) {
    json = { error: `non_json_status_${response.status}`, message: text.slice(0, 500) };
  }
  return summarize(target, response.status, json);
}

async function run() {
  const input = readArg('input');
  if (!input) throw new Error('--input manifest path is required');
  const out = readArg('out');
  const invokeUrl = readArg('url', process.env.PIVOTA_INVOKE_URL || DEFAULT_INVOKE_URL);
  const limit = Math.max(1, Number(readArg('limit', '5')) || 5);
  const manifest = JSON.parse(await fs.readFile(input, 'utf8'));
  const plans = asArray(manifest.plans).filter((plan) => {
    return asString(plan.action) === 'merge_ready' && asString(plan.canonical_sig_id);
  });
  const targets = plans.slice(0, limit).map((plan) => ({
    id: plan.id,
    canonical_sig_id: plan.canonical_sig_id,
    target_product_group_id: plan.target_product_group_id,
  }));
  const results = [];
  for (const target of targets) {
    results.push(await invoke(target, invokeUrl));
  }
  const summary = {
    generated_at: new Date().toISOString(),
    invoke_url: invokeUrl,
    checked: results.length,
    ok_count: results.filter((item) => item.ok).length,
    product_group_matched_count: results.filter((item) => item.product_group_matched).length,
    multi_seller_count: results.filter((item) => item.seller_count >= 2).length,
    multi_offer_count: results.filter((item) => item.offers_count >= 2).length,
    with_images_count: results.filter((item) => item.image_count > 0).length,
  };
  const payload = { status: 'success', summary, results };
  if (out) await fs.writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  run().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}
